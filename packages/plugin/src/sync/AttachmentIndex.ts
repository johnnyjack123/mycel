import * as Y from 'yjs'
import {
  ATTACHMENTS_FIELD,
  DECLINED_FIELD,
  FOLDER_BASES_FIELD,
  SHARED_BASES_FIELD,
  VERSIONS_FIELD,
  type AttachmentEntry,
  type AttachmentVersion
} from '@obsidian-connect/shared'

/** The content a file of a shared note had when this vault last agreed with the note's list, and where. */
export interface SharedBase {
  hash: string
  path: string
  /**
   * When this vault put its version into the list: the list's version it
   * replaced. Base and list travel apart; a list still showing this one has
   * not caught up yet, and is no news.
   */
  prev?: string
}

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
  private readonly declinedMap: Y.Map<{ at: number }>
  private readonly sharedMap: Y.Map<SharedBase>
  private readonly folderMap: Y.Map<SharedBase>
  private readonly byPath = new Map<string, string>()
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly doc: Y.Doc,
    private readonly derive: DeriveFileId
  ) {
    this.files = doc.getMap<AttachmentEntry>(ATTACHMENTS_FIELD)
    this.versionMap = doc.getMap<AttachmentVersion>(VERSIONS_FIELD)
    this.declinedMap = doc.getMap<{ at: number }>(DECLINED_FIELD)
    this.sharedMap = doc.getMap<SharedBase>(SHARED_BASES_FIELD)
    this.folderMap = doc.getMap<SharedBase>(FOLDER_BASES_FIELD)
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

  /**
   * Every content the index names anywhere: files live or deleted and what
   * each replaced, versions, and the bases of shared notes' and shared
   * folders' files. Content none of them names is no file's.
   */
  namedHashes(): Set<string> {
    const named = new Set<string>()
    this.files.forEach((entry) => {
      if (entry.purgedAt) return
      named.add(entry.hash)
      if (entry.prev) named.add(entry.prev)
    })
    this.versionMap.forEach((version) => {
      if (!version.purgedAt) named.add(version.hash)
    })
    for (const bases of [this.sharedMap, this.folderMap]) {
      bases.forEach((base) => {
        named.add(base.hash)
        if (base.prev) named.add(base.prev)
      })
    }
    return named
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
  async add(path: string, hash: string, size: number, via?: AttachmentEntry['via'], folder?: AttachmentEntry['folder']): Promise<string> {
    const existing = this.idForPath(path)
    if (existing) return existing
    const fileId = await this.nextId(path)
    const raced = this.idForPath(path)
    if (raced) return raced
    const entry: AttachmentEntry = { path, hash, size, updatedAt: Date.now() }
    if (via) entry.via = via
    if (folder) entry.folder = folder
    this.doc.transact(() => this.files.set(fileId, entry), 'local')
    return fileId
  }

  // --- files of shared folders -------------------------------------------------------

  /** The file of this vault that is a shared folder's file - live or deleted. */
  linked(folderId: string, file: string): { fileId: string; entry: AttachmentEntry } | undefined {
    let found: { fileId: string; entry: AttachmentEntry } | undefined
    this.files.forEach((entry, fileId) => {
      if (entry.folder?.id !== folderId || entry.folder.file !== file) return
      // A live one before a tombstone.
      if (!found || (found.entry.deletedAt && !entry.deletedAt)) found = { fileId, entry }
    })
    return found
  }

  /** Makes a file of this vault a shared folder's file, or - null - an ordinary one again. */
  setFolderLink(fileId: string, folder: AttachmentEntry['folder'] | null): void {
    const entry = this.files.get(fileId)
    if (!entry) return
    if (folder ? entry.folder?.id === folder.id && entry.folder.file === folder.file : !entry.folder) return
    const next: AttachmentEntry = { ...entry }
    if (folder) next.folder = folder
    else delete next.folder
    this.doc.transact(() => this.files.set(fileId, next), 'local')
  }

  /** What this vault last agreed with a shared folder's file: its content, and its path relative to the folder. */
  folderBase(folderId: string, file: string): SharedBase | undefined {
    return this.folderMap.get(`${folderId}:${file}`)
  }

  setFolderBase(folderId: string, file: string, base: SharedBase | null): void {
    const key = `${folderId}:${file}`
    const current = this.folderMap.get(key)
    if (base ? current?.hash === base.hash && current.path === base.path && current.prev === base.prev : !current) return
    this.doc.transact(() => {
      if (base) this.folderMap.set(key, base)
      else this.folderMap.delete(key)
    }, 'local')
  }

  /** The live file that came in through this note for this link. */
  delivered(docId: string, ref: string): { fileId: string; entry: AttachmentEntry } | undefined {
    return this.live().find(({ entry }) => entry.via?.docId === docId && entry.via.ref === ref)
  }

  /** Points a delivered file at another link of the same note: the link was renamed. */
  reroute(fileId: string, via: NonNullable<AttachmentEntry['via']>): void {
    const entry = this.files.get(fileId)
    if (!entry) return
    this.doc.transact(() => this.files.set(fileId, { ...entry, via, updatedAt: Date.now() }), 'local')
  }

  /**
   * A file of a shared note as this vault last agreed with the note's list:
   * the content, and the file that holds it. The vault's, not a device's -
   * every device of the account decides the same from it.
   */
  sharedBase(docId: string, ref: string): SharedBase | undefined {
    return this.sharedMap.get(`${docId}:${ref}`)
  }

  setSharedBase(docId: string, ref: string, base: SharedBase | null): void {
    const key = `${docId}:${ref}`
    const current = this.sharedMap.get(key)
    if (base ? current?.hash === base.hash && current.path === base.path && current.prev === base.prev : !current) return
    this.doc.transact(() => {
      if (base) this.sharedMap.set(key, base)
      else this.sharedMap.delete(key)
    }, 'local')
  }

  /** The links of shared notes whose file this vault keeps at `path`. */
  sharedAt(path: string): Array<{ docId: string; ref: string }> {
    const found: Array<{ docId: string; ref: string }> = []
    this.sharedMap.forEach((base, key) => {
      if (base.path !== path) return
      const cut = key.indexOf(':')
      found.push({ docId: key.slice(0, cut), ref: key.slice(cut + 1) })
    })
    return found
  }

  // A file of a shared note this account let go of: no device of it fetches
  // or follows that link of that note again, until the file is restored.
  isDeclined(docId: string, ref: string): boolean {
    return this.declinedMap.has(`${docId}:${ref}`)
  }

  decline(docId: string, ref: string): void {
    if (this.isDeclined(docId, ref)) return
    this.doc.transact(() => this.declinedMap.set(`${docId}:${ref}`, { at: Date.now() }), 'local')
  }

  undecline(docId: string, ref: string): void {
    if (!this.isDeclined(docId, ref)) return
    this.doc.transact(() => this.declinedMap.delete(`${docId}:${ref}`), 'local')
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

  /** True when the path changed. */
  rename(fileId: string, path: string): boolean {
    const entry = this.files.get(fileId)
    if (!entry || entry.path === path) return false
    this.doc.transact(() => this.files.set(fileId, { ...entry, path, updatedAt: Date.now() }), 'local')
    return true
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
