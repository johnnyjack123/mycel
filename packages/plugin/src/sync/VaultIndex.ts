import * as Y from 'yjs'
import { INDEX_FIELD, type IndexEntry } from '@obsidian-connect/shared'

// The index is the only thing that knows which file a document belongs to.
// Keying rooms by path instead would turn every rename into a new, empty
// document and orphan the old one along with its history.

/**
 * Derived from the vault and the path instead of random, so two devices that
 * adopt the same note before either has seen the other's index arrive at the
 * same id. A random id per device produced two documents for one file, and
 * both sides then synced happily past each other.
 */
export async function stableDocId(vaultId: string, path: string): Promise<string> {
  try {
    const data = new TextEncoder().encode(`${vaultId}::${path}`)
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
  const { deletedAt: _deletedAt, ...rest } = entry
  return rest
}

export class VaultIndex {
  readonly doc = new Y.Doc()
  private readonly files: Y.Map<IndexEntry>
  private readonly byPath = new Map<string, string>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly vaultId: string) {
    this.files = this.doc.getMap<IndexEntry>(INDEX_FIELD)
    this.files.observeDeep(() => {
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

  /** Returns the existing id for a path, or registers a new one. */
  async ensure(path: string): Promise<string> {
    const existing = this.docIdForPath(path)
    if (existing) return existing
    const docId = await stableDocId(this.vaultId, path)
    const known = this.files.get(docId)
    // A tombstone at the same id means the note is being re-created.
    if (known?.deletedAt) this.revive(docId, path)
    else if (!known) {
      this.doc.transact(() => {
        this.files.set(docId, { path, updatedAt: Date.now() })
      }, 'local')
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

  adopt(docId: string, path: string): void {
    this.doc.transact(() => {
      this.files.set(docId, { path, updatedAt: Date.now() })
    }, 'local')
  }

  rename(docId: string, path: string): void {
    const entry = this.files.get(docId)
    if (!entry || entry.path === path) return
    this.doc.transact(() => {
      this.files.set(docId, live({ ...entry, path, updatedAt: Date.now() }))
    }, 'local')
  }

  isShared(docId: string): boolean {
    return this.files.get(docId)?.shared === true
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
    this.doc.destroy()
  }
}
