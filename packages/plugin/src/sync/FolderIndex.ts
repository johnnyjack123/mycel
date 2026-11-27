import * as Y from 'yjs'
import { FOLDER_FILES_FIELD, FOLDER_META_FIELD, FOLDER_NOTES_FIELD, type FolderFile, type FolderNote, type FolderWrite } from '@mycel/shared'

// A shared folder's own document: which notes and files are in it and where,
// relative to the folder - the same for everyone in it, wherever each of them
// keeps the folder. Like the vault index, identity is the id and a delete is a
// tombstone; a note its owner moved out is marked `leftAt`, so the others fork
// it instead of deleting it. A file's entry names its content as well, and the
// version it replaced (`prev`, invariant 24).

/** Origin of changes this device makes to a folder document. */
export const FOLDER_ORIGIN = 'folder'

/** The entry without its tombstone. */
function live(entry: FolderNote): FolderNote {
  const { deletedAt: _deletedAt, leftAt: _leftAt, ...rest } = entry
  return rest
}

/**
 * An entry as anyone in the folder may have written it: only an object with a path is one. A `null` a writer set
 * made every pass of every device - the owner's too - throw on `entry.path` (audit 2, L2).
 */
function entryOf<T extends { path: string }>(value: unknown): T | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as { path?: unknown }).path === 'string' ? (value as T) : undefined
}

/** The write that set an entry as this document has it. */
function writeOf<T>(map: Y.Map<T>, key: string): FolderWrite | undefined {
  const item = map._map.get(key)
  return item ? { client: item.id.client, clock: item.id.clock } : undefined
}

export class FolderIndex {
  readonly doc = new Y.Doc()
  private readonly notes: Y.Map<FolderNote>
  private readonly files: Y.Map<FolderFile>
  private readonly meta: Y.Map<unknown>
  private readonly byPath = new Map<string, string>()
  private readonly listeners = new Set<(local: boolean) => void>()

  constructor(readonly folderId: string) {
    this.notes = this.doc.getMap<FolderNote>(FOLDER_NOTES_FIELD)
    this.files = this.doc.getMap<FolderFile>(FOLDER_FILES_FIELD)
    this.meta = this.doc.getMap<unknown>(FOLDER_META_FIELD)
    const changed = (_event: unknown, transaction: Y.Transaction): void => {
      this.rebuild()
      for (const listener of this.listeners) listener(transaction.origin === FOLDER_ORIGIN)
    }
    this.notes.observe(changed)
    this.files.observe(changed)
    this.meta.observe(changed)
    this.rebuild()
  }

  // --- files ---------------------------------------------------------------------

  file(fileId: string): FolderFile | undefined {
    return entryOf<FolderFile>(this.files.get(fileId))
  }

  hasFile(fileId: string): boolean {
    return this.files.has(fileId)
  }

  /** Every file entry, deleted and left included. */
  allFiles(): Array<{ fileId: string; entry: FolderFile }> {
    const found: Array<{ fileId: string; entry: FolderFile }> = []
    this.files.forEach((value, fileId) => {
      const entry = entryOf<FolderFile>(value)
      if (entry) found.push({ fileId, entry })
    })
    return found
  }

  /** The live file at a path relative to the folder; of two, the first sorted. */
  fileIdForPath(path: string): string | undefined {
    return Array.from(this.files.entries())
      .filter(([, entry]) => entry.path === path && !entry.deletedAt && !entry.leftAt)
      .map(([fileId]) => fileId)
      .sort()[0]
  }

  /** A file's new version, or the file coming into the folder - or back, live. */
  setFile(fileId: string, entry: FolderFile): void {
    const { deletedAt: _deletedAt, leftAt: _leftAt, ...live } = entry
    this.doc.transact(() => this.files.set(fileId, live), FOLDER_ORIGIN)
  }

  renameFile(fileId: string, path: string, by: string): void {
    const current = entryOf<FolderFile>(this.files.get(fileId))
    if (!current || current.deletedAt || current.leftAt || current.path === path) return
    this.doc.transact(() => this.files.set(fileId, { ...current, path, updatedAt: Date.now(), by }), FOLDER_ORIGIN)
  }

  markFileDeleted(fileId: string, by: string): void {
    const current = entryOf<FolderFile>(this.files.get(fileId))
    if (!current || current.deletedAt || current.leftAt) return
    this.doc.transact(() => this.files.set(fileId, { ...current, deletedAt: Date.now(), updatedAt: Date.now(), by }), FOLDER_ORIGIN)
  }

  markFileLeft(fileId: string, by: string): void {
    const current = entryOf<FolderFile>(this.files.get(fileId))
    if (!current || current.leftAt) return
    this.doc.transact(() => this.files.set(fileId, { ...current, leftAt: Date.now(), updatedAt: Date.now(), by }), FOLDER_ORIGIN)
  }

  reviveFile(fileId: string, path: string, by: string): void {
    const current = entryOf<FolderFile>(this.files.get(fileId))
    if (!current) return
    this.setFile(fileId, { ...current, path, updatedAt: Date.now(), by })
  }

  /** The write that set a file's entry as this document has it. */
  fileWrite(fileId: string): FolderWrite | undefined {
    return writeOf(this.files, fileId)
  }

  /** The write that set a note's entry as this document has it. */
  noteWrite(docId: string): FolderWrite | undefined {
    return writeOf(this.notes, docId)
  }

  /** Whether the frame that carried a write has reached this document. */
  holds(write: FolderWrite): boolean {
    return Y.getState(this.doc.store, write.client) > write.clock
  }

  /** `local`: the change was made on this device. */
  onChange(listener: (local: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private rebuild(): void {
    this.byPath.clear()
    // Sorted, so when two notes claim one path every device takes the same one.
    for (const docId of Array.from(this.notes.keys()).sort()) {
      const entry = entryOf<FolderNote>(this.notes.get(docId))
      if (entry && !entry.deletedAt && !entry.leftAt && !this.byPath.has(entry.path)) this.byPath.set(entry.path, docId)
    }
  }

  note(docId: string): FolderNote | undefined {
    return entryOf<FolderNote>(this.notes.get(docId))
  }

  has(docId: string): boolean {
    return this.notes.has(docId)
  }

  docIdForPath(path: string): string | undefined {
    return this.byPath.get(path)
  }

  /** Every note in the folder now. */
  live(): Array<{ docId: string; entry: FolderNote }> {
    const found: Array<{ docId: string; entry: FolderNote }> = []
    this.notes.forEach((value, docId) => {
      const entry = entryOf<FolderNote>(value)
      if (entry && !entry.deletedAt && !entry.leftAt) found.push({ docId, entry })
    })
    return found
  }

  /** Every entry, deleted and left included. */
  all(): Array<{ docId: string; entry: FolderNote }> {
    const found: Array<{ docId: string; entry: FolderNote }> = []
    this.notes.forEach((value, docId) => {
      const entry = entryOf<FolderNote>(value)
      if (entry) found.push({ docId, entry })
    })
    return found
  }

  /** Live notes sharing a path; the first of each, sorted, keeps it. */
  duplicatePaths(): Array<{ path: string; docIds: string[] }> {
    const byPath = new Map<string, string[]>()
    for (const { docId, entry } of this.live()) byPath.set(entry.path, [...(byPath.get(entry.path) ?? []), docId])
    return Array.from(byPath, ([path, docIds]) => ({ path, docIds: docIds.sort() })).filter(({ docIds }) => docIds.length > 1)
  }

  private set(docId: string, entry: FolderNote): void {
    this.doc.transact(() => this.notes.set(docId, entry), FOLDER_ORIGIN)
  }

  /** A note comes into the folder - new, or moved in - or back, live. */
  add(docId: string, path: string, by: string): void {
    const current = entryOf<FolderNote>(this.notes.get(docId))
    if (current && !current.deletedAt && !current.leftAt && current.path === path) return
    this.set(docId, { path, updatedAt: Date.now(), by })
  }

  rename(docId: string, path: string, by: string): void {
    const current = entryOf<FolderNote>(this.notes.get(docId))
    if (!current || current.deletedAt || current.leftAt || current.path === path) return
    this.set(docId, { ...live(current), path, updatedAt: Date.now(), by })
  }

  /** Deleted for everyone in the folder. */
  markDeleted(docId: string, by: string): void {
    const current = entryOf<FolderNote>(this.notes.get(docId))
    if (!current || current.deletedAt || current.leftAt) return
    this.set(docId, { ...current, deletedAt: Date.now(), updatedAt: Date.now(), by })
  }

  /** Its owner took it out of the folder: everyone else keeps it as their own. */
  markLeft(docId: string, by: string): void {
    const current = entryOf<FolderNote>(this.notes.get(docId))
    if (!current || current.leftAt) return
    this.set(docId, { ...current, leftAt: Date.now(), updatedAt: Date.now(), by })
  }

  revive(docId: string, path: string, by: string): void {
    const current = entryOf<FolderNote>(this.notes.get(docId))
    this.set(docId, { ...(current ? live(current) : {}), path, updatedAt: Date.now(), by })
  }

  /** The owner's name for the folder, shown to everyone in it; never a path. */
  get name(): string {
    const name = this.meta.get('name')
    return typeof name === 'string' ? name : ''
  }

  setName(name: string): void {
    if (this.name === name) return
    this.doc.transact(() => this.meta.set('name', name), FOLDER_ORIGIN)
  }

  /** Whether the files the folder's notes link outside it travel along, as a shared note's do. */
  get linkedFiles(): boolean {
    return this.meta.get('linkedFiles') === true
  }

  setLinkedFiles(on: boolean): void {
    if (this.linkedFiles === on) return
    this.doc.transact(() => this.meta.set('linkedFiles', on), FOLDER_ORIGIN)
  }

  /** Nothing was ever written into it - here or on the server. */
  get pristine(): boolean {
    return this.doc.store.clients.size === 0
  }

  destroy(): void {
    this.listeners.clear()
    this.doc.destroy()
  }
}
