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

type Listener = (...args: unknown[]) => void

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

/** The plugin-folder side: `DataAdapter` as StateStore and BackupStore use it. */
export class FakeAdapter {
  readonly files = new Map<string, string>()
  private readonly dirs = new Set<string>()

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path)
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
      files: Array.from(this.files.keys()).filter(direct),
      folders: Array.from(this.dirs).filter(direct)
    }
  }

  async rmdir(path: string): Promise<void> {
    for (const key of Array.from(this.files.keys())) if (key.startsWith(`${path}/`)) this.files.delete(key)
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
  private readonly listeners = new Map<string, Set<Listener>>()
  private clock = 1_000

  constructor(initial: Record<string, string> = {}) {
    for (const [path, text] of Object.entries(initial)) this.put(path, text)
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

  /** Puts a file in place without any event: the vault as it was before Obsidian started. */
  private put(path: string, text: string): TFile {
    this.ensureParents(path)
    const file = new TFile()
    file.path = path
    file.name = path.split('/').pop() ?? path
    file.extension = file.name.includes('.') ? (file.name.split('.').pop() ?? '') : ''
    file.basename = file.extension ? file.name.slice(0, -(file.extension.length + 1)) : file.name
    this.entries.set(path, file)
    this.setText(file, text)
    return file
  }

  private setText(file: TFile, text: string): void {
    this.contents.set(file.path, text)
    this.clock += 1
    file.stat = { ctime: file.stat.ctime || this.clock, mtime: this.clock, size: text.length }
  }

  getMarkdownFiles(): TFile[] {
    return Array.from(this.entries.values()).filter(
      (entry): entry is TFile => entry instanceof TFile && entry.extension === 'md'
    )
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
    const text = this.contents.get(oldPath) ?? ''
    this.entries.delete(oldPath)
    this.contents.delete(oldPath)
    file.path = newPath
    file.name = newPath.split('/').pop() ?? newPath
    file.basename = file.extension ? file.name.slice(0, -(file.extension.length + 1)) : file.name
    this.entries.set(newPath, file)
    this.contents.set(newPath, text)
    this.emit('rename', file, oldPath)
  }

  async trash(file: TFile): Promise<void> {
    if (this.entries.get(file.path) !== file) return
    this.entries.delete(file.path)
    this.contents.delete(file.path)
    this.emit('delete', file)
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
}

export class FakeFileManager {
  constructor(private readonly vault: FakeVault) {}

  async renameFile(file: TFile, newPath: string): Promise<void> {
    await this.vault.rename(file, newPath)
  }

  async trashFile(file: TFile): Promise<void> {
    await this.vault.trash(file)
  }
}

/** A device's IndexedDB, kept across restarts of that device and nobody else's. */
export class MemoryLocalStores {
  private readonly saved = new Map<string, Uint8Array>()

  readonly open: OpenLocalStore = (name: string, doc: Y.Doc): LocalStore => {
    const stored = this.saved.get(name)
    if (stored) Y.applyUpdate(doc, stored, 'local-store')
    const save = (): void => {
      this.saved.set(name, Y.encodeStateAsUpdate(doc))
    }
    doc.on('update', save)
    return {
      whenSynced: Promise.resolve(),
      destroy: () => {
        save()
        doc.off('update', save)
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
