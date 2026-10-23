import * as Y from 'yjs'
import { DECLINED_FIELD, FOLDERS_FIELD, INDEX_FIELD, type IndexEntry, type ShareRole, type VaultFolder } from '@obsidian-connect/shared'

// The index is the only thing that knows which file a document belongs to.
// Keying rooms by path instead would turn every rename into a new, empty
// document and orphan the old one along with its history.

/**
 * Derived from the vault and the path instead of random, so two devices that
 * adopt the same note before either has seen the other's index arrive at the
 * same id. A random id per device produced two documents for one file, and
 * both sides then synced happily past each other.
 *
 * `generation` counts earlier documents that were created under the same
 * path; generation 0 keeps the ids notes already have.
 */
export async function stableDocId(vaultId: string, path: string, generation = 0): Promise<string> {
  try {
    const seed = generation === 0 ? `${vaultId}::${path}` : `${vaultId}::${path}::${generation}`
    const data = new TextEncoder().encode(seed)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
    return Array.from(digest.slice(0, 16))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    // No WebCrypto: a random id still works, it just reopens the race above.
    return crypto.randomUUID()
  }
}

/** The entry without its tombstone, keeping everything else - notably `shared`. */
function live(entry: IndexEntry): IndexEntry {
  const { deletedAt: _deletedAt, forkedTo: _forkedTo, purgedAt: _purgedAt, ...rest } = entry
  return rest
}

/** How a path and a generation become a document id. */
export type DeriveDocId = (path: string, generation: number) => Promise<string>

/**
 * Where a new note at some path takes its id from instead of the vault key: a
 * shared folder, so everyone in it derives the same id for the same new note.
 */
export interface IdScheme {
  derive(generation: number): Promise<string | null>
  /** Ids the folder knows, deleted ones included: never handed out again. */
  taken(docId: string): boolean
}

export interface AdoptOptions {
  shared?: boolean
  owner?: string
  role?: ShareRole
  folder?: string
  folderPath?: string
}

export class VaultIndex {
  readonly doc = new Y.Doc()
  private readonly files: Y.Map<IndexEntry>
  private readonly folderMap: Y.Map<VaultFolder>
  private readonly declinedMap: Y.Map<{ at: number }>
  private readonly byPath = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  private readonly folderListeners = new Set<() => void>()
  private readonly derive: DeriveDocId
  private scheme: (path: string) => IdScheme | null = () => null

  /**
   * `derive` defaults to hashing the vault id and path; with an account it is
   * an HMAC under the vault key, so nobody else can predict a note's id.
   */
  constructor(vaultId: string, derive?: DeriveDocId) {
    this.derive = derive ?? ((path, generation) => stableDocId(vaultId, path, generation))
    this.files = this.doc.getMap<IndexEntry>(INDEX_FIELD)
    this.folderMap = this.doc.getMap<VaultFolder>(FOLDERS_FIELD)
    this.declinedMap = this.doc.getMap<{ at: number }>(DECLINED_FIELD)
    this.files.observeDeep(() => {
      this.rebuild()
      for (const listener of this.listeners) listener()
    })
    this.folderMap.observe(() => {
      for (const listener of this.folderListeners) listener()
    })
    this.rebuild()
  }

  /** Paths inside a shared folder this account may write in take their ids from the folder. */
  setIdScheme(scheme: (path: string) => IdScheme | null): void {
    this.scheme = scheme
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private rebuild(): void {
    this.byPath.clear()
    this.files.forEach((entry, docId) => {
      if (entry.deletedAt) return
      this.byPath.set(entry.path, docId)
    })
  }

  docIdForPath(path: string): string | undefined {
    return this.byPath.get(path)
  }

  entry(docId: string): IndexEntry | undefined {
    return this.files.get(docId)
  }

  pathFor(docId: string): string | undefined {
    const entry = this.files.get(docId)
    return entry && !entry.deletedAt ? entry.path : undefined
  }

  /** Every note the index believes exists. */
  live(): Array<{ docId: string; entry: IndexEntry }> {
    const result: Array<{ docId: string; entry: IndexEntry }> = []
    this.files.forEach((entry, docId) => {
      if (!entry.deletedAt) result.push({ docId, entry })
    })
    return result
  }

  deleted(): Array<{ docId: string; entry: IndexEntry }> {
    const result: Array<{ docId: string; entry: IndexEntry }> = []
    this.files.forEach((entry, docId) => {
      if (entry.deletedAt) result.push({ docId, entry })
    })
    return result
  }

  /**
   * Returns the existing id for a path, or registers a new document for it.
   *
   * A new file never takes over an id the index already knows. Obsidian
   * names every new note "Untitled" before it is renamed, so the id derived
   * from a path usually belongs to a note that now lives elsewhere - or to one
   * that was deleted. Reusing it handed the new, empty note that other note's
   * text. The first unused generation is still derived, so devices adopting
   * the same file arrive at the same id.
   */
  async ensure(path: string, onCreated?: (docId: string) => void): Promise<string> {
    const existing = this.docIdForPath(path)
    if (existing) return existing
    const docId = await this.nextId(path)
    // Another caller may have registered this path while the id was hashed.
    const raced = this.docIdForPath(path)
    if (raced) return raced
    this.doc.transact(() => {
      this.files.set(docId, { path, updatedAt: Date.now() })
    }, 'local')
    onCreated?.(docId)
    return docId
  }

  /** The id `ensure` would give a new document at this path, without registering it. */
  async nextId(path: string): Promise<string> {
    const scheme = this.scheme(path)
    if (scheme) {
      // Without the folder's key - not handed over yet - the vault's own will do;
      // the note still joins the folder, under an id nobody else derives.
      let docId = await scheme.derive(0)
      for (let generation = 1; docId && (this.files.has(docId) || scheme.taken(docId)); generation += 1) {
        docId = await scheme.derive(generation)
      }
      if (docId) return docId
    }
    let docId = await this.derive(path, 0)
    for (let generation = 1; this.files.has(docId); generation += 1) {
      docId = await this.derive(path, generation)
    }
    return docId
  }

  /**
   * Ids that ended up pointing at the same file. Deterministic ids make this
   * rare, but a rename racing between two devices can still produce one.
   */
  duplicatePaths(): Array<{ path: string; docIds: string[] }> {
    const byPath = new Map<string, string[]>()
    this.files.forEach((entry, docId) => {
      if (entry.deletedAt) return
      const ids = byPath.get(entry.path)
      if (ids) ids.push(docId)
      else byPath.set(entry.path, [docId])
    })
    const duplicates: Array<{ path: string; docIds: string[] }> = []
    for (const [path, docIds] of byPath) {
      // Sorted, so every device picks the same winner without coordinating.
      if (docIds.length > 1) duplicates.push({ path, docIds: docIds.sort() })
    }
    return duplicates
  }

  adopt(docId: string, path: string, options: AdoptOptions = {}): void {
    const entry: IndexEntry = { path, updatedAt: Date.now() }
    if (options.shared) entry.shared = true
    if (options.owner) entry.owner = options.owner
    if (options.role) entry.role = options.role
    if (options.folder) entry.folder = options.folder
    if (options.folderPath !== undefined) entry.folderPath = options.folderPath
    this.doc.transact(() => {
      this.files.set(docId, entry)
    }, 'local')
  }

  /**
   * A note's place in a shared folder - or none, `folder` null - with the
   * sharing that follows from it: shared, and for someone else's folder whose
   * it is and what this account may do.
   */
  setFolderOf(docId: string, folder: { id: string; path: string; owner?: string; role?: ShareRole } | null): void {
    const entry = this.files.get(docId)
    if (!entry || entry.deletedAt) return
    const next: IndexEntry = { ...entry }
    if (folder) {
      next.folder = folder.id
      next.folderPath = folder.path
      next.shared = true
      if (folder.owner) next.owner = folder.owner
      if (folder.role) next.role = folder.role
    } else {
      delete next.folder
      delete next.folderPath
    }
    if (JSON.stringify(next) === JSON.stringify(entry)) return
    this.doc.transact(() => {
      this.files.set(docId, { ...next, updatedAt: Date.now() })
    }, 'local')
  }

  // --- shared folders -----------------------------------------------------------

  onFoldersChange(listener: () => void): () => void {
    this.folderListeners.add(listener)
    return () => this.folderListeners.delete(listener)
  }

  folder(folderId: string): VaultFolder | undefined {
    return this.folderMap.get(folderId)
  }

  /** Every shared folder of the vault whose share goes on: its own, and the ones shared into it. */
  liveFolders(): Array<{ folderId: string; folder: VaultFolder }> {
    const found: Array<{ folderId: string; folder: VaultFolder }> = []
    this.folderMap.forEach((folder, folderId) => {
      if (!folder.endedAt && !folder.leftAt) found.push({ folderId, folder })
    })
    return found
  }

  hasFolder(folderId: string): boolean {
    return this.folderMap.has(folderId)
  }

  // What this account let go of in a shared folder it only reads: no device of
  // it pulls that note again until it is restored. The same map the files of
  // shared notes are declined in, under keys of their own.
  isDeclined(key: string): boolean {
    return this.declinedMap.has(key)
  }

  decline(key: string): void {
    if (this.isDeclined(key)) return
    this.doc.transact(() => this.declinedMap.set(key, { at: Date.now() }), 'local')
  }

  undecline(key: string): void {
    if (!this.isDeclined(key)) return
    this.doc.transact(() => this.declinedMap.delete(key), 'local')
  }

  setFolder(folderId: string, folder: VaultFolder): void {
    const current = this.folderMap.get(folderId)
    if (current && JSON.stringify(current) === JSON.stringify(folder)) return
    this.doc.transact(() => this.folderMap.set(folderId, folder), 'local')
  }

  setRole(docId: string, role: ShareRole): void {
    const entry = this.files.get(docId)
    if (!entry || entry.deletedAt || !entry.owner || entry.role === role) return
    this.doc.transact(() => {
      this.files.set(docId, { ...entry, role, updatedAt: Date.now() })
    }, 'local')
  }

  /** True when the path changed. */
  rename(docId: string, path: string): boolean {
    const entry = this.files.get(docId)
    if (!entry || entry.path === path) return false
    this.doc.transact(() => {
      this.files.set(docId, live({ ...entry, path, updatedAt: Date.now() }))
    }, 'local')
    return true
  }

  isShared(docId: string): boolean {
    return this.files.get(docId)?.shared === true
  }

  setShared(docId: string, shared: boolean): void {
    const entry = this.files.get(docId)
    if (!entry || entry.deletedAt || (entry.shared === true) === shared) return
    const next: IndexEntry = { ...entry, updatedAt: Date.now() }
    if (shared) next.shared = true
    else delete next.shared
    this.doc.transact(() => {
      this.files.set(docId, next)
    }, 'local')
  }

  // Deletions are tombstones, not removals: a peer that has been offline needs
  // to learn the note is gone rather than re-create it from its own copy.
  markDeleted(docId: string): void {
    const entry = this.files.get(docId)
    if (!entry || entry.deletedAt) return
    this.doc.transact(() => {
      this.files.set(docId, { ...entry, deletedAt: Date.now(), updatedAt: Date.now() })
    }, 'local')
  }

  /** The server let go of a deleted note; no device offers it for restoring any more. */
  markPurged(docId: string): void {
    const entry = this.files.get(docId)
    if (!entry?.deletedAt || entry.purgedAt) return
    this.doc.transact(() => {
      this.files.set(docId, { ...entry, purgedAt: Date.now(), updatedAt: Date.now() })
    }, 'local')
  }

  /**
   * One note's file handed to a new document of this vault's own, in a single
   * change. The tombstone names the new document, so another device folds
   * what it still holds of the old one into it rather than dropping it.
   */
  replace(oldDocId: string, newDocId: string, path: string): void {
    const old = this.files.get(oldDocId)
    this.doc.transact(() => {
      if (old && !old.deletedAt) {
        this.files.set(oldDocId, { ...old, deletedAt: Date.now(), updatedAt: Date.now(), forkedTo: newDocId })
      }
      this.files.set(newDocId, { path, updatedAt: Date.now() })
    }, 'local')
  }

  revive(docId: string, path: string): void {
    const entry = this.files.get(docId)
    if (!entry) {
      this.adopt(docId, path)
      return
    }
    this.doc.transact(() => {
      this.files.set(docId, live({ ...entry, path, updatedAt: Date.now() }))
    }, 'local')
  }

  destroy(): void {
    this.listeners.clear()
    this.folderListeners.clear()
    this.doc.destroy()
  }
}
