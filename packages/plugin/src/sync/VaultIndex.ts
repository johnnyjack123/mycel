import * as Y from 'yjs'
import { INDEX_FIELD, type IndexEntry } from '@crdt-sync/shared'

// The index is the only thing that knows which file a document belongs to.
// Keying rooms by path instead would turn every rename into a new, empty
// document and orphan the old one along with its history.

export class VaultIndex {
  readonly doc = new Y.Doc()
  private readonly files: Y.Map<IndexEntry>
  private readonly byPath = new Map<string, string>()
  private readonly listeners = new Set<() => void>()

  constructor() {
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
  ensure(path: string): string {
    const existing = this.docIdForPath(path)
    if (existing) return existing
    const docId = crypto.randomUUID()
    this.doc.transact(() => {
      this.files.set(docId, { path, updatedAt: Date.now() })
    }, 'local')
    return docId
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
      this.files.set(docId, { ...entry, path, updatedAt: Date.now(), deletedAt: undefined })
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

  revive(docId: string, path: string): void {
    const entry = this.files.get(docId)
    if (!entry) {
      this.adopt(docId, path)
      return
    }
    this.doc.transact(() => {
      this.files.set(docId, { path, updatedAt: Date.now() })
    }, 'local')
  }

  destroy(): void {
    this.listeners.clear()
    this.doc.destroy()
  }
}
