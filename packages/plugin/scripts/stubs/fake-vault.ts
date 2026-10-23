// An in-memory vault, file manager and Markdown view that behave like
// Obsidian where it matters to sync: vault events after every change, a
// debounced save from the editor, and an open editor reloading its file -
// wholesale - when something else writes it. Those last two together are what
// made text double, so they are modelled, not skipped.
import * as Y from 'yjs'
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history } from '@codemirror/commands'
import { TAbstractFile, TFile, TFolder } from 'obsidian'
import type { NoteRef } from '../../src/editor/binding.js'
import type { LocalStore, OpenLocalStore } from '../../src/sync/DocHandle.js'
import { memoryHistory } from '../../src/sync/History.js'

type Listener = (...args: unknown[]) => void

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

/** The plugin-folder side: `DataAdapter` as StateStore and BackupStore use it. */
export class FakeAdapter {
  readonly files = new Map<string, string>()
  readonly binaries = new Map<string, Uint8Array>()
  private readonly dirs = new Set<string>()

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.binaries.has(path) || this.dirs.has(path)
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.binaries.set(path, new Uint8Array(data.slice(0)))
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path)
  }

  async read(path: string): Promise<string> {
    const text = this.files.get(path)
    if (text === undefined) throw new Error(`ENOENT: ${path}`)
    return text
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data)
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path)
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const direct = (candidate: string): boolean =>
      candidate.startsWith(`${path}/`) && !candidate.slice(path.length + 1).includes('/')
    return {
      files: [...this.files.keys(), ...this.binaries.keys()].filter(direct),
      folders: Array.from(this.dirs).filter(direct)
    }
  }

  async rmdir(path: string): Promise<void> {
    for (const key of Array.from(this.files.keys())) if (key.startsWith(`${path}/`)) this.files.delete(key)
    for (const key of Array.from(this.binaries.keys())) if (key.startsWith(`${path}/`)) this.binaries.delete(key)
    for (const key of Array.from(this.dirs)) if (key === path || key.startsWith(`${path}/`)) this.dirs.delete(key)
  }

  backups(): string[] {
    return Array.from(this.files.keys()).filter((key) => key.includes('/backups/'))
  }
}

export class FakeVault {
  readonly adapter = new FakeAdapter()
  readonly configDir = '.obsidian'
  private readonly entries = new Map<string, TAbstractFile>()
  private readonly contents = new Map<string, string>()
  /** Files that are not text: images, PDFs. */
  private readonly binaries = new Map<string, Uint8Array>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private clock = 1_000

  constructor(initial: Record<string, string | Uint8Array> = {}) {
    for (const [path, content] of Object.entries(initial)) {
      if (typeof content === 'string') this.put(path, content)
      else this.putBinary(path, content)
    }
  }

  on(name: string, listener: Listener): { name: string; listener: Listener } {
    const set = this.listeners.get(name) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(name, set)
    return { name, listener }
  }

  offref(ref: { name: string; listener: Listener }): void {
    this.listeners.get(ref.name)?.delete(ref.listener)
  }

  private emit(name: string, ...args: unknown[]): void {
    for (const listener of Array.from(this.listeners.get(name) ?? [])) listener(...args)
  }

  private ensureParents(path: string): void {
    const parent = parentOf(path)
    if (!parent || this.entries.has(parent)) return
    this.ensureParents(parent)
    const folder = new TFolder()
    folder.path = parent
    folder.name = parent.split('/').pop() ?? parent
    this.entries.set(parent, folder)
  }

  private newFile(path: string): TFile {
    this.ensureParents(path)
    const file = new TFile()
    file.path = path
    file.name = path.split('/').pop() ?? path
    file.extension = file.name.includes('.') ? (file.name.split('.').pop() ?? '') : ''
    file.basename = file.extension ? file.name.slice(0, -(file.extension.length + 1)) : file.name
    this.entries.set(path, file)
    return file
  }

  /** Puts a file in place without any event: the vault as it was before Obsidian started. */
  private put(path: string, text: string): TFile {
    const file = this.newFile(path)
    this.setText(file, text)
    return file
  }

  private putBinary(path: string, data: Uint8Array): TFile {
    const file = this.newFile(path)
    this.setBytes(file, data)
    return file
  }

  private setText(file: TFile, text: string): void {
    this.contents.set(file.path, text)
    this.clock += 1
    file.stat = { ctime: file.stat.ctime || this.clock, mtime: this.clock, size: text.length }
  }

  private setBytes(file: TFile, data: Uint8Array): void {
    this.binaries.set(file.path, new Uint8Array(data))
    this.clock += 1
    file.stat = { ctime: file.stat.ctime || this.clock, mtime: this.clock, size: data.length }
  }

  getMarkdownFiles(): TFile[] {
    return Array.from(this.entries.values()).filter(
      (entry): entry is TFile => entry instanceof TFile && entry.extension === 'md'
    )
  }

  getFiles(): TFile[] {
    return Array.from(this.entries.values()).filter((entry): entry is TFile => entry instanceof TFile)
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    if (this.entries.get(file.path) !== file) throw new Error(`ENOENT: ${file.path}`)
    const data = this.binaries.get(file.path) ?? new TextEncoder().encode(this.contents.get(file.path) ?? '')
    return data.slice().buffer
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    if (this.entries.has(path)) throw new Error('File already exists.')
    const parent = parentOf(path)
    if (parent && !(this.entries.get(parent) instanceof TFolder)) throw new Error(`Folder does not exist: ${parent}`)
    const file = this.putBinary(path, new Uint8Array(data))
    this.emit('create', file)
    return file
  }

  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    if (this.entries.get(file.path) !== file) throw new Error(`ENOENT: ${file.path}`)
    this.contents.delete(file.path)
    this.setBytes(file, new Uint8Array(data))
    this.emit('modify', file)
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.entries.get(path) ?? null
  }

  async read(file: TFile): Promise<string> {
    const text = this.contents.get(file.path)
    if (text === undefined || this.entries.get(file.path) !== file) throw new Error(`ENOENT: ${file.path}`)
    return text
  }

  async modify(file: TFile, text: string): Promise<void> {
    if (this.entries.get(file.path) !== file) throw new Error(`ENOENT: ${file.path}`)
    this.setText(file, text)
    this.emit('modify', file)
  }

  async create(path: string, text: string): Promise<TFile> {
    if (this.entries.has(path)) throw new Error('File already exists.')
    // Obsidian refuses to create a file in a folder that does not exist.
    const parent = parentOf(path)
    if (parent && !(this.entries.get(parent) instanceof TFolder)) throw new Error(`Folder does not exist: ${parent}`)
    const file = this.put(path, text)
    this.emit('create', file)
    return file
  }

  async createFolder(path: string): Promise<TFolder> {
    if (this.entries.has(path)) throw new Error('Folder already exists.')
    const parent = parentOf(path)
    if (parent && !(this.entries.get(parent) instanceof TFolder)) throw new Error(`Folder does not exist: ${parent}`)
    const folder = new TFolder()
    folder.path = path
    folder.name = path.split('/').pop() ?? path
    this.entries.set(path, folder)
    this.emit('create', folder)
    return folder
  }

  async rename(file: TFile, newPath: string): Promise<void> {
    if (this.entries.has(newPath)) throw new Error('Destination file already exists!')
    const parent = parentOf(newPath)
    if (parent && !(this.entries.get(parent) instanceof TFolder)) throw new Error(`Folder does not exist: ${parent}`)
    const oldPath = file.path
    const text = this.contents.get(oldPath)
    const data = this.binaries.get(oldPath)
    this.entries.delete(oldPath)
    this.contents.delete(oldPath)
    this.binaries.delete(oldPath)
    file.path = newPath
    file.name = newPath.split('/').pop() ?? newPath
    file.extension = file.name.includes('.') ? (file.name.split('.').pop() ?? '') : ''
    file.basename = file.extension ? file.name.slice(0, -(file.extension.length + 1)) : file.name
    this.entries.set(newPath, file)
    if (data) this.binaries.set(newPath, data)
    else this.contents.set(newPath, text ?? '')
    this.emit('rename', file, oldPath)
  }

  async trash(file: TFile): Promise<void> {
    if (this.entries.get(file.path) !== file) return
    this.entries.delete(file.path)
    this.contents.delete(file.path)
    this.binaries.delete(file.path)
    this.emit('delete', file)
  }

  /**
   * A folder renamed or moved, everything in it along. Obsidian reports it as
   * an event for the folder and one for each file, in an order nobody
   * promised - `folderFirst` picks one, `folderEvent: false` leaves the
   * folder's out.
   */
  async renameFolder(path: string, newPath: string, options: { folderFirst?: boolean; folderEvent?: boolean } = {}): Promise<void> {
    const folder = this.entries.get(path)
    if (!(folder instanceof TFolder)) throw new Error(`no folder at ${path}`)
    if (this.entries.has(newPath)) throw new Error('Destination file already exists!')
    this.ensureParents(`${newPath}/x`)
    this.entries.delete(newPath)
    const moved: Array<{ entry: TAbstractFile; oldPath: string }> = []
    for (const [entryPath, entry] of Array.from(this.entries)) {
      if (entryPath !== path && !entryPath.startsWith(`${path}/`)) continue
      const target = `${newPath}${entryPath.slice(path.length)}`
      this.entries.delete(entryPath)
      const text = this.contents.get(entryPath)
      const data = this.binaries.get(entryPath)
      this.contents.delete(entryPath)
      this.binaries.delete(entryPath)
      entry.path = target
      entry.name = target.split('/').pop() ?? target
      this.entries.set(target, entry)
      if (data) this.binaries.set(target, data)
      else if (text !== undefined) this.contents.set(target, text)
      moved.push({ entry, oldPath: entryPath })
    }
    const files = moved.filter(({ entry }) => entry instanceof TFile)
    const folderEvent = options.folderEvent === false ? [] : moved.filter(({ entry }) => entry === folder)
    for (const { entry, oldPath } of options.folderFirst ? [...folderEvent, ...files] : [...files, ...folderEvent]) {
      this.emit('rename', entry, oldPath)
    }
  }

  /** A folder deleted with everything in it; `filesReported: false`: Obsidian names only the folder. */
  async trashFolder(path: string, options: { filesReported?: boolean } = {}): Promise<void> {
    const folder = this.entries.get(path)
    if (!(folder instanceof TFolder)) throw new Error(`no folder at ${path}`)
    const gone: TAbstractFile[] = []
    for (const [entryPath, entry] of Array.from(this.entries)) {
      if (entryPath !== path && !entryPath.startsWith(`${path}/`)) continue
      this.entries.delete(entryPath)
      this.contents.delete(entryPath)
      this.binaries.delete(entryPath)
      gone.push(entry)
    }
    if (options.filesReported !== false) for (const entry of gone) if (entry instanceof TFile) this.emit('delete', entry)
    this.emit('delete', folder)
  }

  /** Whether a folder is there. */
  hasFolder(path: string): boolean {
    return this.entries.get(path) instanceof TFolder
  }

  // --- test side -------------------------------------------------------------

  text(path: string): string | undefined {
    return this.contents.get(path)
  }

  file(path: string): TFile {
    const entry = this.entries.get(path)
    if (!(entry instanceof TFile)) throw new Error(`no file at ${path}`)
    return entry
  }

  paths(): string[] {
    return this.getMarkdownFiles()
      .map((file) => file.path)
      .sort()
  }

  /** The user saving a change, as Obsidian reports it. */
  async userWrite(path: string, text: string): Promise<void> {
    await this.modify(this.file(path), text)
  }

  async userCreate(path: string, text: string): Promise<TFile> {
    this.ensureParents(path)
    return this.create(path, text)
  }

  /** A change made while Obsidian was closed: new stat, no event. */
  offlineWrite(path: string, text: string): void {
    const entry = this.entries.get(path)
    if (entry instanceof TFile) this.setText(entry, text)
    else this.put(path, text)
  }

  bytes(path: string): Uint8Array | undefined {
    return this.binaries.get(path)
  }

  /** Every file that is not a note, sorted. */
  attachmentPaths(): string[] {
    return this.getFiles()
      .filter((file) => file.extension !== 'md')
      .map((file) => file.path)
      .sort()
  }

  async userCreateBinary(path: string, data: Uint8Array): Promise<TFile> {
    this.ensureParents(path)
    return this.createBinary(path, data.slice().buffer)
  }

  async userWriteBinary(path: string, data: Uint8Array): Promise<void> {
    await this.modifyBinary(this.file(path), data.slice().buffer)
  }

  offlineWriteBinary(path: string, data: Uint8Array): void {
    const entry = this.entries.get(path)
    if (entry instanceof TFile) this.setBytes(entry, data)
    else this.putBinary(path, data)
  }

  /** A new mtime and nothing else - no event, the content unchanged. */
  touch(path: string): void {
    const entry = this.entries.get(path)
    const data = this.binaries.get(path)
    if (entry instanceof TFile && data) this.setBytes(entry, data)
  }

  offlineDelete(path: string): void {
    this.entries.delete(path)
    this.contents.delete(path)
    this.binaries.delete(path)
  }
}

/**
 * Obsidian's link index, as far as attachments need it: the embeds and links
 * in a note, and which file a link resolves to - the whole path, the end of
 * it, or the name.
 */
export class FakeMetadataCache {
  constructor(private readonly vault: FakeVault) {}

  getFileCache(file: TFile): { embeds: Array<{ link: string }>; links: Array<{ link: string }> } | null {
    const text = this.vault.text(file.path)
    if (text === undefined) return null
    const embeds: Array<{ link: string }> = []
    const links: Array<{ link: string }> = []
    for (const match of text.matchAll(/(!?)\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
      const target = { link: match[2] as string }
      if (match[1]) embeds.push(target)
      else links.push(target)
    }
    return { embeds, links }
  }

  getFirstLinkpathDest(link: string, _source: string): TFile | null {
    const files = this.vault.getFiles()
    return (
      files.find((file) => file.path === link || file.path === `${link}.md`) ??
      files.find(
        (file) => file.path.endsWith(`/${link}`) || file.path.endsWith(`/${link}.md`) || file.name === link || file.basename === link
      ) ??
      null
    )
  }
}

export class FakeFileManager {
  constructor(private readonly vault: FakeVault) {}

  /** Like Obsidian with "Automatically update internal links" on. */
  async renameFile(file: TFile, newPath: string): Promise<void> {
    const oldBase = file.basename
    await this.vault.rename(file, newPath)
    if (file.basename === oldBase) return
    for (const note of this.vault.getMarkdownFiles()) {
      if (note === file) continue
      const text = this.vault.text(note.path) ?? ''
      const updated = text.split(`[[${oldBase}]]`).join(`[[${file.basename}]]`)
      if (updated !== text) await this.vault.modify(note, updated)
    }
  }

  async trashFile(file: TFile): Promise<void> {
    await this.vault.trash(file)
  }
}

/** A device's IndexedDB, kept across restarts of that device and nobody else's. */
export class MemoryLocalStores {
  private readonly saved = new Map<string, Uint8Array>()
  private readonly meta = new Map<string, Map<string, string>>()
  /** The device's own history of changes, which outlives restarts like IndexedDB. */
  readonly history = memoryHistory()
  /** How often each database was opened. */
  readonly opened = new Map<string, number>()

  /** Whether a database of this name holds anything. */
  has(name: string): boolean {
    return this.saved.has(name)
  }

  readonly open: OpenLocalStore = (name: string, doc: Y.Doc): LocalStore => {
    this.opened.set(name, (this.opened.get(name) ?? 0) + 1)
    const stored = this.saved.get(name)
    if (stored) Y.applyUpdate(doc, stored, 'local-store')
    const save = (): void => {
      this.saved.set(name, Y.encodeStateAsUpdate(doc))
    }
    doc.on('update', save)
    let values = this.meta.get(name)
    if (!values) {
      values = new Map()
      this.meta.set(name, values)
    }
    const kept = values
    return {
      whenSynced: Promise.resolve(),
      destroy: () => {
        save()
        doc.off('update', save)
      },
      clear: async () => {
        doc.off('update', save)
        this.saved.delete(name)
        this.meta.delete(name)
      },
      get: async (key) => kept.get(key) ?? null,
      set: async (key, value) => {
        kept.set(key, value)
      }
    }
  }
}

// Which note an editor shows. Obsidian's `editorInfoField` plays this part.
export const showNote = StateEffect.define<NoteRef | null>()
export const noteField = StateField.define<NoteRef | null>({
  create: () => null,
  update: (value, transaction) => {
    for (const effect of transaction.effects) if (effect.is(showNote)) return effect.value
    return value
  }
})
export const noteOf = (state: EditorState): NoteRef | null => state.field(noteField, false) ?? null

/**
 * A Markdown leaf. Saves its buffer periodically while it is being edited,
 * like Obsidian's `requestSave`, taking the text first and writing it a moment
 * later - so the file on disk lags whatever was typed during the write. It
 * replaces its whole buffer when another writer changes the file, like
 * Obsidian reloading a file that changed on disk.
 */
export class FakeMarkdownView {
  readonly view: EditorView
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private saving = false
  private readonly ref: { name: string; listener: Listener }

  constructor(
    private readonly vault: FakeVault,
    public file: TFile,
    private readonly extension: Extension,
    parent: HTMLElement,
    private readonly saveEveryMs = 120,
    private readonly writeLatencyMs = 25
  ) {
    this.view = new EditorView({
      state: this.createState(vault.text(file.path) ?? ''),
      parent,
      dispatchTransactions: (transactions, view) => {
        view.update(transactions)
        if (transactions.some((transaction) => transaction.docChanged)) this.requestSave()
      }
    })
    this.ref = vault.on('modify', (changed) => this.onModify(changed as TFile))
  }

  private createState(text: string): EditorState {
    const file = this.file
    return EditorState.create({ doc: text, extensions: [noteField.init(() => file), history(), this.extension] })
  }

  text(): string {
    return this.view.state.doc.toString()
  }

  type(text: string, at = this.view.state.doc.length): void {
    this.view.dispatch({
      changes: { from: at, insert: text },
      selection: { anchor: at + text.length },
      userEvent: 'input.type'
    })
  }

  /** Obsidian saving whatever the buffer held some time ago. */
  async saveStale(text: string): Promise<void> {
    this.saving = true
    try {
      await this.vault.modify(this.file, text)
    } finally {
      this.saving = false
    }
  }

  /** Opening another note in this leaf: Obsidian builds a fresh state for it. */
  showFile(file: TFile): void {
    this.flush()
    this.file = file
    this.view.setState(this.createState(this.vault.text(file.path) ?? ''))
  }

  /**
   * Opening another note the slow way: the view already reports the new file
   * while the buffer still holds the old one, until the read finishes and the
   * content arrives - in a fresh state, as Obsidian loads a file, or swapped
   * into the existing one.
   */
  async showFileSlowly(file: TFile, readMs: number, rebuild = true): Promise<void> {
    this.flush()
    this.file = file
    this.view.dispatch({ effects: showNote.of(file) })
    await new Promise((resolve) => setTimeout(resolve, readMs))
    const text = this.vault.text(file.path) ?? ''
    if (rebuild) this.view.setState(this.createState(text))
    else this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } })
  }

  private requestSave(): void {
    // Not a debounce: continuous typing still gets saved every so often.
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save()
    }, this.saveEveryMs)
  }

  private async save(): Promise<void> {
    const file = this.file
    if (this.vault.getAbstractFileByPath(file.path) !== file) return
    const text = this.text()
    if (this.vault.text(file.path) === text) return
    this.saving = true
    try {
      await new Promise((resolve) => setTimeout(resolve, this.writeLatencyMs))
      if (this.vault.getAbstractFileByPath(file.path) === file) await this.vault.modify(file, text)
    } finally {
      this.saving = false
    }
  }

  flush(): void {
    if (!this.saveTimer) return
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    void this.save()
  }

  private onModify(changed: TFile): void {
    if (changed !== this.file || this.saving) return
    const disk = this.vault.text(changed.path) ?? ''
    if (disk === this.text()) return
    // Wholesale, and without a user event - as Obsidian does it.
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: disk } })
  }

  close(): void {
    this.flush()
    this.vault.offref(this.ref)
    this.view.destroy()
  }
}
