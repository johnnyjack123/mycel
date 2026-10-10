import * as Y from 'yjs'
import { ATTACHMENTS_FIELD, VERSIONS_FIELD, type AttachmentEntry, type AttachmentVersion } from '@obsidian-connect/shared'

// The files of a vault that are not notes, in the same index document as the
// notes - so they travel, persist and recover with it - but in maps of their
// own. Identity is the file id, as a note's is its document id: a rename
// keeps it, and a delete is a tombstone.

/** How a path and a generation become a file id. */
export type DeriveFileId = (path: string, generation: number) => Promise<string>

/** The entry without its tombstone. */
function live(entry: AttachmentEntry): AttachmentEntry {
  const { deletedAt: _deletedAt, purgedAt: _purgedAt, ...rest } = entry
  return rest
}

export class AttachmentIndex {
  private readonly files: Y.Map<AttachmentEntry>
  private readonly versionMap: Y.Map<AttachmentVersion>
  private readonly byPath = new Map<string, string>()
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly doc: Y.Doc,
    private readonly derive: DeriveFileId
  ) {
    this.files = doc.getMap<AttachmentEntry>(ATTACHMENTS_FIELD)
    this.versionMap = doc.getMap<AttachmentVersion>(VERSIONS_FIELD)
    this.files.observe(() => {
      this.rebuild()
      for (const listener of this.listeners) listener()
    })
    this.rebuild()
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private rebuild(): void {
    this.byPath.clear()
    // Sorted, so when two ids claim one path every device takes the same one.
    const ids = Array.from(this.files.keys()).sort()
    for (const fileId of ids) {
      const entry = this.files.get(fileId)
      if (entry && !entry.deletedAt && !this.byPath.has(entry.path)) this.byPath.set(entry.path, fileId)
    }
  }

  idForPath(path: string): string | undefined {
    return this.byPath.get(path)
  }

  entry(fileId: string): AttachmentEntry | undefined {
    return this.files.get(fileId)
  }

  live(): Array<{ fileId: string; entry: AttachmentEntry }> {
    const result: Array<{ fileId: string; entry: AttachmentEntry }> = []
    this.files.forEach((entry, fileId) => {
      if (!entry.deletedAt) result.push({ fileId, entry })
    })
    return result
  }

  deleted(): Array<{ fileId: string; entry: AttachmentEntry }> {
    const result: Array<{ fileId: string; entry: AttachmentEntry }> = []
    this.files.forEach((entry, fileId) => {
      if (entry.deletedAt) result.push({ fileId, entry })
    })
    return result
  }

  /** Live ids sharing a path with another one, sorted; the first of each keeps it. */
  duplicatePaths(): Array<{ path: string; fileIds: string[] }> {
    const byPath = new Map<string, string[]>()
    for (const { fileId, entry } of this.live()) {
      const ids = byPath.get(entry.path)
      if (ids) ids.push(fileId)
      else byPath.set(entry.path, [fileId])
    }
    return Array.from(byPath, ([path, fileIds]) => ({ path, fileIds: fileIds.sort() })).filter(({ fileIds }) => fileIds.length > 1)
  }

  /**
   * The id a new file at this path gets: the first generation the index does
   * not know, for the reason notes do it (`VaultIndex.ensure`) - the id a
   * path derives usually belongs to an earlier file that moved or went.
   */
  async nextId(path: string): Promise<string> {
    let fileId = await this.derive(path, 0)
    for (let generation = 1; this.files.has(fileId); generation += 1) fileId = await this.derive(path, generation)
    return fileId
  }

  /**
   * Registers a new file whose content the server holds. A path the index
   * already has keeps its entry - the caller decides what that means - and
   * its id is returned.
   */
  async add(path: string, hash: string, size: number): Promise<string> {
    const existing = this.idForPath(path)
    if (existing) return existing
    const fileId = await this.nextId(path)
    const raced = this.idForPath(path)
    if (raced) return raced
    this.doc.transact(() => this.files.set(fileId, { path, hash, size, updatedAt: Date.now() }), 'local')
    return fileId
  }

  private recordVersion(fileId: string, entry: AttachmentEntry, now: number): void {
    this.versionMap.set(`${fileId}:${entry.hash}`, { fileId, hash: entry.hash, size: entry.size, since: entry.updatedAt, at: now })
  }

  /** New content for a file, which replaced what this device knew it as. */
  setContent(fileId: string, hash: string, size: number): void {
    const entry = this.files.get(fileId)
    if (!entry || entry.deletedAt || entry.hash === hash) return
    const now = Date.now()
    this.doc.transact(() => {
      this.recordVersion(fileId, entry, now)
      this.files.set(fileId, { ...entry, hash, size, prev: entry.hash, updatedAt: now })
    }, 'local')
  }

  /** Whether this content was the file's once and was replaced by someone who knew it. */
  replaced(fileId: string, hash: string): boolean {
    return this.files.get(fileId)?.prev === hash || this.versionMap.has(`${fileId}:${hash}`)
  }

  rename(fileId: string, path: string): void {
    const entry = this.files.get(fileId)
    if (!entry || entry.path === path) return
    this.doc.transact(() => this.files.set(fileId, { ...entry, path, updatedAt: Date.now() }), 'local')
  }

  markDeleted(fileId: string): void {
    const entry = this.files.get(fileId)
    if (!entry || entry.deletedAt) return
    this.doc.transact(() => this.files.set(fileId, { ...entry, deletedAt: Date.now(), updatedAt: Date.now() }), 'local')
  }

  /** Brings a tombstone back with the content this device has. */
  revive(fileId: string, path: string, hash: string, size: number): void {
    const entry = this.files.get(fileId)
    if (!entry) return
    const now = Date.now()
    this.doc.transact(() => {
      if (entry.hash !== hash) this.recordVersion(fileId, entry, now)
      this.files.set(fileId, { ...live(entry), path, hash, size, prev: entry.hash, updatedAt: now })
    }, 'local')
  }

  /** The server let go of a deleted file's content; no device offers it for restoring any more. */
  markPurged(fileId: string): void {
    const entry = this.files.get(fileId)
    if (!entry?.deletedAt || entry.purgedAt) return
    this.doc.transact(() => this.files.set(fileId, { ...entry, purgedAt: Date.now(), updatedAt: Date.now() }), 'local')
  }

  /** A version's content is gone; its record stays, as the file's lineage. */
  markVersionPurged(fileId: string, hash: string): void {
    const key = `${fileId}:${hash}`
    const version = this.versionMap.get(key)
    if (!version || version.purgedAt) return
    this.doc.transact(() => this.versionMap.set(key, { ...version, purgedAt: Date.now() }), 'local')
  }

  /** A version past the retention, record and all. */
  dropVersion(fileId: string, hash: string): void {
    const key = `${fileId}:${hash}`
    if (!this.versionMap.has(key)) return
    this.doc.transact(() => this.versionMap.delete(key), 'local')
  }

  versions(fileId?: string): AttachmentVersion[] {
    const found: AttachmentVersion[] = []
    this.versionMap.forEach((version) => {
      if (!fileId || version.fileId === fileId) found.push(version)
    })
    return found.sort((a, b) => b.at - a.at)
  }

  destroy(): void {
    this.listeners.clear()
  }
}
