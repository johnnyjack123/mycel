import { Component, ItemView, MarkdownRenderer, Notice, getLinkpath, setIcon, type ViewStateResult, type WorkspaceLeaf } from 'obsidian'
import { docRoom, lineDiff, splitLines, type AttachmentEntry, type BackupListedEntry, type BackupSnapshotRef, type IndexEntry } from '@obsidian-connect/shared'
import { bytes, contentHash, utf8 } from '@obsidian-connect/shared/crypto'
import { busy } from '../busy.js'
import type { AccountSettings, RollbackRecord } from '../sync/AccountSettings.js'
import type { AttachmentStore } from '../sync/AttachmentStore.js'
import type { DocStore } from '../sync/DocStore.js'
import type { BackupSource, Rollback } from '../sync/Rollback.js'
import type { RoomCrypto } from '../sync/VaultSocket.js'
import { ApplyModal } from './ApplyModal.js'
import { NoteHistory } from './NoteHistory.js'
import { VaultTimeline, inFolder, livePath, type Tick, type TimelineDeps, type VaultPast } from './Timeline.js'
import { formatSize, imageType, imageUrl } from './media.js'
import { log } from '../log.js'

// The Time Machine (`docs/TIMEMACHINE.md`): a slider over the past of the
// vault, a folder or a note, a tick for every state in between. Moving it
// shows that state here and changes nothing; the vault changes only through
// *Apply* (the rollback, with its backups first), *Restore this version* or
// *Restore just this note*. Changing the real files while sliding would send
// every state in between to every device and every person the notes are
// shared with.

export const TIME_MACHINE_VIEW = 'obsidian-connect-time-machine'

/** What the Time Machine shows the past of. */
export type TimeMachineScope = { kind: 'vault' } | { kind: 'folder'; path: string } | { kind: 'note'; path: string }

/** The backup servers, as far as the Time Machine reads them. */
export interface TimeMachineBackups extends BackupSource {
  backupTimes(routeId: string): Promise<number[]>
}

/** What the view needs of the running plugin. */
export interface TimeMachineContext {
  api: TimelineDeps['api']
  vaultId: string
  indexCrypto: RoomCrypto
  noteCrypto(docId: string): RoomCrypto
  store: DocStore
  attachments: AttachmentStore | null
  settings: AccountSettings
  backups: TimeMachineBackups | null
  rollback(): Rollback
  /** The name of whoever owns the shared folder `path` lies in, when that is someone else. */
  folderOwner(path: string): string | null
}

export interface TimeMachineHost {
  /** Null while the plugin is signed out or not connected yet. */
  context(): TimeMachineContext | null
  /** Whether backups older than the history are ticks too: a switch in the view, kept on this device. */
  includeBackups(): boolean
  setIncludeBackups(on: boolean): Promise<void>
}

/** One place on the slider. */
interface Position {
  /** The moment shown; infinite for now. */
  at: number
  /** Null for now. */
  tick: Tick | null
  /** A backup run's, further back than the history reaches. */
  backup?: { routeId: string; label: string }
}

/** A note or file of the vault or folder at a position, against now. */
interface Item {
  kind: 'note' | 'file'
  /** Its id now; '' for one a backup knows that the vault does not. */
  id: string
  pathThen: string | null
  pathNow: string | null
  /** There then, gone now: *Apply* brings it back. */
  back: boolean
  /** Not there then: *Apply* moves it to the trash. */
  goes: boolean
  moved: boolean
  changed: boolean
  /** Someone else's: *Apply* leaves it as it is. */
  foreign: boolean
  hashThen?: string
  sizeThen?: number
}

type Mode = 'rendered' | 'source' | 'changes'

const PREVIEW_MAX_BYTES = 20 * 1024 * 1024
const TEXT_MAX = 200_000
const TREE_MAX = 3_000
const MARKS_MAX = 400
// While the slider is dragged, the state shown follows once it rests this long.
const SETTLE_MS = 120
const ROLLBACKS_SHOWN = 5

function when(ms: number): string {
  return new Date(ms).toLocaleString()
}

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString()
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function sameScope(a: TimeMachineScope, b: TimeMachineScope): boolean {
  return a.kind === b.kind && (a.kind === 'vault' || (a as { path: string }).path === (b as { path: string }).path)
}

function scopeFrom(state: unknown): TimeMachineScope | null {
  const value = state as { kind?: unknown; path?: unknown } | null
  if (value?.kind === 'vault') return { kind: 'vault' }
  if ((value?.kind === 'folder' || value?.kind === 'note') && typeof value.path === 'string') return { kind: value.kind, path: value.path }
  return null
}

export class TimeMachineView extends ItemView {
  /** What it shows the past of - `scope` is the view's keyboard scope. */
  private target: TimeMachineScope = { kind: 'vault' }
  private ctx: TimeMachineContext | null = null
  private loading = false
  private problem: string | null = null
  private backupProblem: string | null = null
  /** Where the history begins: 0 while it holds everything. */
  private reach = 0
  private vault: VaultTimeline | null = null
  private note: { docId: string; history: NoteHistory } | null = null
  private positions: Position[] = []
  private place = 0
  private selected: { kind: Item['kind']; id: string; path: string } | null = null
  private onlyDiffering = true
  /** Folders of the tree the person opened or closed. */
  private readonly folderOpen = new Map<string, boolean>()
  private mode: Mode = 'rendered'
  /** Notes looked at while the view is open, each read once. */
  private readonly histories = new Map<string, Promise<NoteHistory>>()
  private readonly backupRefs = new Map<string, Promise<BackupSnapshotRef | null>>()
  private readonly listings = new Map<string, Promise<BackupListedEntry[]>>()
  private readonly backupTexts = new Map<string, Promise<string | null>>()
  /** What a note says now, by content hash - for comparing with a backup. */
  private readonly nowHashes = new Map<string, Promise<string | null>>()
  private previewComponent: Component | null = null
  private readonly urls: string[] = []
  private settleTimer: number | null = null
  /** Bumped by every rendering of the state, so one still loading gives way. */
  private run = 0
  private loads = 0
  private labelEl: HTMLElement | null = null
  private rangeEl: HTMLInputElement | null = null
  private bodyEl: HTMLElement | null = null

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: TimeMachineHost
  ) {
    super(leaf)
  }

  getViewType(): string {
    return TIME_MACHINE_VIEW
  }

  getDisplayText(): string {
    return `Time Machine: ${this.target.kind === 'vault' ? 'the vault' : nameOf(this.target.path)}`
  }

  getIcon(): string {
    return 'history'
  }

  getState(): Record<string, unknown> {
    return { ...this.target }
  }

  // Obsidian opens the view and then hands it its state - a new one, or the one it kept over a restart.
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const scope = scopeFrom(state) ?? this.target
    const known = sameScope(scope, this.target) && Boolean(this.vault || this.note || this.loading)
    this.target = scope
    if (!known) void this.load()
    await super.setState(state, result)
  }

  /** Whether this view shows the past of `scope`. */
  shows(scope: TimeMachineScope): boolean {
    return sameScope(scope, this.target)
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('connect-tm')
  }

  async onClose(): Promise<void> {
    this.loads += 1
    this.forget()
    this.contentEl.empty()
  }

  /**
   * The plugin (re)connected, or its files became ready: a view that waited for
   * it, holds the stopped sync's, or went without files reads the past again.
   */
  connected(): void {
    const next = this.host.context()
    if (!this.ctx || this.problem || next?.store !== this.ctx.store || (next.attachments && !this.ctx.attachments)) void this.load()
  }

  // --- reading the past ------------------------------------------------------------

  private forget(): void {
    this.dropPreview()
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer)
    this.settleTimer = null
    for (const history of this.histories.values()) void history.then((loaded) => loaded.destroy(), () => undefined)
    this.histories.clear()
    this.backupRefs.clear()
    this.listings.clear()
    this.backupTexts.clear()
    this.nowHashes.clear()
    this.vault = null
    this.note = null
    this.positions = []
  }

  private get folder(): string {
    return this.target.kind === 'folder' ? this.target.path : ''
  }

  async load(): Promise<void> {
    const load = (this.loads += 1)
    this.forget()
    this.ctx = this.host.context()
    this.problem = null
    this.backupProblem = null
    // An earlier load still under way is this one's now.
    this.loading = false
    if (!this.ctx) {
      this.problem = 'Obsidian Connect is not connected yet. The Time Machine reads the past from the server, so it opens once the vault syncs.'
      this.render()
      return
    }
    const ctx = this.ctx
    this.loading = true
    this.render()
    try {
      let ticks: Tick[]
      let reach: number
      if (this.target.kind === 'note') {
        const docId = ctx.store.docIdForPath(this.target.path)
        if (!docId) throw new Error(`${this.target.path} is not synced.`)
        const history = new NoteHistory(ctx.api, docRoom(docId), ctx.noteCrypto(docId))
        await history.load()
        if (load !== this.loads) return history.destroy()
        this.note = { docId, history }
        this.histories.set(docId, Promise.resolve(history))
        ticks = history.ticks()
        reach = history.reach
      } else {
        const vault = await VaultTimeline.load({ api: ctx.api, vaultId: ctx.vaultId, indexCrypto: ctx.indexCrypto })
        if (load !== this.loads) return
        this.vault = vault
        ticks = vault.ticks(this.folder)
        reach = vault.reach
      }
      this.reach = reach
      const positions: Position[] = ticks.map((tick) => ({ at: tick.at, tick }))
      if (this.host.includeBackups() && ctx.backups && reach > 0) {
        const older = await this.backupPositions(ctx.backups, reach)
        if (load !== this.loads) return
        positions.unshift(...older)
      }
      positions.push({ at: Number.POSITIVE_INFINITY, tick: null })
      this.positions = positions
      this.place = positions.length - 1
    } catch (error) {
      if (load !== this.loads) return
      log.error('the Time Machine could not read the past', error)
      this.problem = `The past could not be read: ${error instanceof Error ? error.message : String(error)}. It lives on the server, so the Time Machine needs a connection.`
    } finally {
      if (load === this.loads) {
        this.loading = false
        this.render()
      }
    }
  }

  /** The backups older than `before`, as ticks of their own. */
  private async backupPositions(backups: TimeMachineBackups, before: number): Promise<Position[]> {
    const found: Position[] = []
    for (const server of backups.servers()) {
      try {
        for (const at of await backups.backupTimes(server.routeId)) {
          if (at < before) found.push({ at, tick: { at, from: at, last: at, changed: 0 }, backup: { routeId: server.routeId, label: server.label } })
        }
      } catch (error) {
        log.warn(`asking ${server.label} when it backed up failed`, error)
        this.backupProblem = `${server.label} could not say when it backed up: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    return found.sort((a, b) => a.at - b.at)
  }

  private historyOf(docId: string): Promise<NoteHistory> {
    let history = this.histories.get(docId)
    if (!history) {
      const ctx = this.ctx as TimeMachineContext
      const loading = new NoteHistory(ctx.api, docRoom(docId), ctx.noteCrypto(docId))
      history = loading.load().then(() => loading)
      history.catch(() => this.histories.delete(docId))
      this.histories.set(docId, history)
    }
    return history
  }

  private backupRef(position: Position): Promise<BackupSnapshotRef | null> {
    const backup = position.backup as NonNullable<Position['backup']>
    const key = `${backup.routeId}:${position.at}`
    let ref = this.backupRefs.get(key)
    if (!ref) {
      ref = (this.ctx?.backups as TimeMachineBackups).backupAt(backup.routeId, position.at)
      ref.catch(() => this.backupRefs.delete(key))
      this.backupRefs.set(key, ref)
    }
    return ref
  }

  private listing(position: Position): Promise<BackupListedEntry[]> {
    const backup = position.backup as NonNullable<Position['backup']>
    const key = `${backup.routeId}:${position.at}`
    let listed = this.listings.get(key)
    if (!listed) {
      listed = this.backupRef(position).then((ref) => (ref ? (this.ctx?.backups as TimeMachineBackups).backupListing(backup.routeId, ref) : []))
      listed.catch(() => this.listings.delete(key))
      this.listings.set(key, listed)
    }
    return listed
  }

  /** One file of a backup, whole; null when the backup does not hold it. */
  private async backupBytes(position: Position, path: string): Promise<Uint8Array | null> {
    const backup = position.backup as NonNullable<Position['backup']>
    const ref = await this.backupRef(position)
    if (!ref) return null
    let found: Uint8Array | null = null
    await (this.ctx?.backups as TimeMachineBackups).backupRead(backup.routeId, ref, [path], async (_path, data) => {
      found = data
    })
    return found
  }

  private backupText(position: Position, path: string): Promise<string | null> {
    const key = `${position.backup?.routeId}:${position.at}:${path}`
    let text = this.backupTexts.get(key)
    if (!text) {
      text = this.backupBytes(position, path).then((data) => (data ? new TextDecoder().decode(data) : null))
      text.catch(() => this.backupTexts.delete(key))
      this.backupTexts.set(key, text)
    }
    return text
  }

  private nowHash(docId: string): Promise<string | null> {
    let hash = this.nowHashes.get(docId)
    if (!hash) {
      hash = (this.ctx as TimeMachineContext).store.currentText(docId).then((text) => (text === null ? null : contentHash(utf8(text))))
      this.nowHashes.set(docId, hash)
    }
    return hash
  }

  /** A note's text at a position; null when neither its history nor the backup reaches it. */
  private async textAt(position: Position, docId: string, path: string | null): Promise<{ text: string } | { missing: string }> {
    if (position.backup) {
      if (!path) return { missing: 'It is not in that backup.' }
      const text = await this.backupText(position, path)
      return text === null ? { missing: `The backup has nothing at ${path}.` } : { text }
    }
    const history = await this.historyOf(docId)
    if (!history.reaches(position.at)) {
      return {
        missing:
          history.unreadable > 0
            ? 'Part of its history is from before you had access, so its text then cannot be told.'
            : `Its history reaches back to ${when(history.reach)} only.${this.ctx?.backups ? ' Turn on "Backups too" to look further back.' : ''}`
      }
    }
    return { text: history.textAtTime(position.at) }
  }

  // --- what the vault or folder was ------------------------------------------------

  /** The notes and files of the vault or folder at a history position, against now. */
  private itemsAt(at: number, past: VaultPast): Item[] {
    const ctx = this.ctx as TimeMachineContext
    const vault = this.vault as VaultTimeline
    const items: Item[] = []
    const keep = (pathThen: string | null, pathNow: string | null): boolean =>
      (inFolder(pathThen, this.folder) || inFolder(pathNow, this.folder)) && !ctx.store.isExcluded((pathThen ?? pathNow) as string)
    const notesNow = new Map(ctx.store.allEntries().map(({ docId, entry }) => [docId, entry]))
    for (const docId of new Set([...past.notes.keys(), ...notesNow.keys()])) {
      const old = past.notes.get(docId)
      const now = notesNow.get(docId)
      const pathThen = livePath(old)
      const pathNow = livePath(now)
      if (!keep(pathThen, pathNow)) continue
      items.push({
        kind: 'note',
        id: docId,
        pathThen,
        pathNow,
        back: pathThen !== null && pathNow === null,
        goes: pathThen === null && pathNow !== null,
        moved: pathThen !== null && pathNow !== null && pathThen !== pathNow,
        changed: pathThen !== null && pathNow !== null && vault.editedAfter(docId, at),
        foreign: Boolean(now?.owner || old?.owner || now?.forkedTo)
      })
    }
    const filesNow = new Map((ctx.attachments?.allEntries() ?? []).map(({ fileId, entry }) => [fileId, entry]))
    const foreignFile = (entry: AttachmentEntry | undefined): boolean => Boolean(entry?.via || (entry?.folder && ctx.folderOwner(entry.path)))
    for (const fileId of new Set([...past.files.keys(), ...filesNow.keys()])) {
      const old = past.files.get(fileId)
      const now = filesNow.get(fileId)
      const pathThen = livePath(old)
      const pathNow = livePath(now)
      if (!keep(pathThen, pathNow)) continue
      const item: Item = {
        kind: 'file',
        id: fileId,
        pathThen,
        pathNow,
        back: pathThen !== null && pathNow === null,
        goes: pathThen === null && pathNow !== null,
        moved: pathThen !== null && pathNow !== null && pathThen !== pathNow,
        changed: pathThen !== null && pathNow !== null && old?.hash !== now?.hash,
        foreign: foreignFile(now) || foreignFile(old)
      }
      if (old && pathThen) Object.assign(item, { hashThen: old.hash, sizeThen: old.size })
      items.push(item)
    }
    return items
  }

  /** The notes and files of a backup, by path, against now. */
  private async itemsOfBackup(position: Position): Promise<Item[]> {
    const ctx = this.ctx as TimeMachineContext
    const listed = (await this.listing(position)).filter((entry) => inFolder(entry.path, this.folder) && !ctx.store.isExcluded(entry.path))
    const notesNow = new Map<string, { id: string; entry: IndexEntry }>()
    for (const { docId, entry } of ctx.store.allEntries()) if (!entry.deletedAt) notesNow.set(entry.path, { id: docId, entry })
    const filesNow = new Map<string, { id: string; entry: AttachmentEntry }>()
    for (const { fileId, entry } of ctx.attachments?.allEntries() ?? []) if (!entry.deletedAt) filesNow.set(entry.path, { id: fileId, entry })
    // Every note the backup holds that the vault has is compared by what it says now, a few read at once.
    const compared = listed.flatMap((entry) => (entry.path.endsWith('.md') && notesNow.has(entry.path) ? [(notesNow.get(entry.path) as { id: string }).id] : []))
    for (let i = 0; i < compared.length; i += 16) await Promise.all(compared.slice(i, i + 16).map((docId) => this.nowHash(docId)))
    const items: Item[] = []
    const inBackup = new Set<string>()
    for (const entry of listed) {
      inBackup.add(entry.path)
      const note = entry.path.endsWith('.md')
      const live = note ? notesNow.get(entry.path) : filesNow.get(entry.path)
      let changed = false
      if (live && note) changed = (await this.nowHash(live.id)) !== entry.hash
      else if (live) changed = (live.entry as AttachmentEntry).hash !== entry.hash
      items.push({
        kind: note ? 'note' : 'file',
        id: live?.id ?? '',
        pathThen: entry.path,
        pathNow: live ? entry.path : null,
        back: !live,
        goes: false,
        moved: false,
        changed,
        foreign: Boolean((live?.entry as IndexEntry | undefined)?.owner || (live?.entry as AttachmentEntry | undefined)?.via),
        hashThen: entry.hash,
        sizeThen: entry.size
      })
    }
    for (const [path, live] of [...notesNow, ...filesNow]) {
      if (inBackup.has(path) || !inFolder(path, this.folder) || ctx.store.isExcluded(path)) continue
      items.push({
        kind: path.endsWith('.md') ? 'note' : 'file',
        id: live.id,
        pathThen: null,
        pathNow: path,
        back: false,
        goes: true,
        moved: false,
        changed: false,
        foreign: Boolean((live.entry as IndexEntry).owner || (live.entry as AttachmentEntry).via)
      })
    }
    return items
  }

  // --- drawing -----------------------------------------------------------------------

  private get position(): Position | null {
    return this.positions[this.place] ?? null
  }

  private render(): void {
    const el = this.contentEl
    this.dropPreview()
    el.empty()
    this.labelEl = null
    this.rangeEl = null
    this.bodyEl = null
    const header = el.createDiv({ cls: 'connect-tm-header' })
    header.createEl('h3', { text: this.title() })
    const reload = header.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Read the past again' } })
    setIcon(reload, 'refresh-cw')
    reload.onclick = () => void this.load()

    if (this.loading) {
      el.createEl('p', { cls: 'connect-tm-quiet', text: 'Reading and decrypting the past…' })
      return
    }
    if (this.problem) {
      el.createEl('p', { text: this.problem })
      el.createEl('button', { text: 'Try again' }).onclick = () => void this.load()
      return
    }
    this.renderTimeline(el)
    this.bodyEl = el.createDiv({ cls: 'connect-tm-main' })
    this.renderState()
  }

  private title(): string {
    switch (this.target.kind) {
      case 'vault':
        return 'Time Machine: the vault'
      case 'folder':
        return `Time Machine: ${this.target.path}`
      case 'note':
        return `Time Machine: ${nameOf(this.target.path)}`
    }
  }

  private renderTimeline(el: HTMLElement): void {
    const strip = el.createDiv({ cls: 'connect-tm-timeline' })
    const row = strip.createDiv({ cls: 'connect-tm-slider' })
    const earlier = row.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Earlier' } })
    setIcon(earlier, 'chevron-left')
    const track = row.createDiv({ cls: 'connect-tm-track' })
    const range = track.createEl('input', { type: 'range' })
    range.min = '0'
    range.max = String(this.positions.length - 1)
    range.step = '1'
    range.value = String(this.place)
    range.disabled = this.positions.length < 2
    this.rangeEl = range
    const later = row.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Later' } })
    setIcon(later, 'chevron-right')
    const now = row.createEl('button', { text: 'Now' })
    earlier.onclick = () => this.moveTo(this.place - 1)
    later.onclick = () => this.moveTo(this.place + 1)
    now.onclick = () => this.moveTo(this.positions.length - 1)
    range.addEventListener('input', () => this.moveTo(Number(range.value), true))
    range.addEventListener('change', () => this.moveTo(Number(range.value)))

    if (this.positions.length <= MARKS_MAX) {
      const marks = track.createDiv({ cls: 'connect-tm-marks' })
      const last = Math.max(1, this.positions.length - 1)
      this.positions.forEach((position, i) => {
        const mark = marks.createSpan({ cls: 'connect-tm-mark-tick' })
        if (position.backup) mark.addClass('is-backup')
        if (!position.tick) mark.addClass('is-now')
        mark.style.left = `${(i / last) * 100}%`
      })
    }
    this.labelEl = strip.createDiv({ cls: 'connect-tm-label' })
    this.renderLabel()

    const notes = strip.createDiv({ cls: 'connect-tm-quiet' })
    const ticks = this.positions.length - 1
    notes.setText(
      ticks === 0
        ? 'Nothing changed here as far back as the history reaches.'
        : `${ticks} earlier state${ticks === 1 ? '' : 's'}. ${
            this.target.kind === 'note' ? 'A tick is a version: typing ended by a pause of a minute.' : 'A tick is every change, those less than five minutes apart together.'
          } Nothing changes in the vault while you look.`
    )
    const backups = this.ctx?.backups
    if (backups && backups.servers().length > 0) {
      const label = strip.createEl('label', { cls: 'connect-tm-switch' })
      const toggle = label.createEl('input', { type: 'checkbox' })
      toggle.checked = this.host.includeBackups()
      label.appendText(' Backups too, further back than the history')
      toggle.onchange = () =>
        void this.host.setIncludeBackups(toggle.checked).then(() => this.load())
      if (toggle.checked && this.reach === 0) {
        strip.createDiv({ cls: 'connect-tm-quiet', text: 'The history reaches back to the beginning here, so no backup is older.' })
      }
    }
    if (this.backupProblem) strip.createDiv({ cls: 'mod-warning', text: this.backupProblem })
    if (this.vault?.withoutTimes) {
      strip.createDiv({
        cls: 'mod-warning',
        text: 'The sync server is older than 0.8.11 and cannot say when notes were edited: only notes and files added, moved or deleted make ticks. Update the server for every edit.'
      })
    }
  }

  private renderLabel(): void {
    const label = this.labelEl
    const position = this.position
    if (!label || !position) return
    label.empty()
    const tick = position.tick
    if (!tick) {
      label.createSpan({ cls: 'connect-tm-when', text: 'Now' })
      return
    }
    if (position.backup) {
      label.createSpan({ cls: 'connect-tm-when', text: when(position.at) })
      label.createSpan({ cls: 'connect-tm-what', text: ` · the backup on ${position.backup.label}` })
      return
    }
    label.createSpan({ cls: 'connect-tm-when', text: when(tick.last) })
    if (tick.changed === 0) {
      label.createSpan({ cls: 'connect-tm-what', text: ' · as far back as the history reaches' })
    } else if (this.target.kind === 'note') {
      label.createSpan({ cls: 'connect-tm-what', text: tick.from < tick.last ? ` · typed from ${time(tick.from)}` : '' })
    } else {
      label.createSpan({
        cls: 'connect-tm-what',
        text: ` · ${tick.changed} note${tick.changed === 1 ? '' : 's'} or file${tick.changed === 1 ? '' : 's'} changed${tick.from < tick.last ? `, from ${time(tick.from)}` : ''}`
      })
    }
  }

  private moveTo(place: number, dragging = false): void {
    const next = Math.max(0, Math.min(place, this.positions.length - 1))
    if (next === this.place && !dragging) return
    this.place = next
    if (this.rangeEl && this.rangeEl.value !== String(next)) this.rangeEl.value = String(next)
    this.renderLabel()
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer)
    this.settleTimer = window.setTimeout(
      () => {
        this.settleTimer = null
        this.renderState()
      },
      dragging ? SETTLE_MS : 0
    )
  }

  /** The tree, the chosen note or file and what can be done, for the position shown. */
  private renderState(): void {
    const body = this.bodyEl
    const position = this.position
    if (!body || !position) return
    const run = (this.run += 1)
    // Choosing a note draws everything again; the tree stays where it was scrolled to.
    const scrolled = body.querySelector('.connect-tm-tree')?.scrollTop ?? 0
    this.dropPreview()
    body.empty()
    if (this.target.kind === 'note') {
      const preview = body.createDiv({ cls: 'connect-tm-preview is-alone' })
      void this.renderNote(preview, run, position, (this.note as { docId: string }).docId, this.target.path, null)
      this.renderNoteActions(body.createDiv({ cls: 'connect-tm-actions' }), position)
      return
    }
    const panes = body.createDiv({ cls: 'connect-tm-panes' })
    const tree = panes.createDiv({ cls: 'connect-tm-tree' })
    const preview = panes.createDiv({ cls: 'connect-tm-preview' })
    const actions = body.createDiv({ cls: 'connect-tm-actions' })
    void this.renderVaultState(run, position, tree, preview, actions, scrolled)
  }

  private async renderVaultState(
    run: number,
    position: Position,
    tree: HTMLElement,
    preview: HTMLElement,
    actions: HTMLElement,
    scrolled: number
  ): Promise<void> {
    let items: Item[]
    let past: VaultPast | null = null
    try {
      if (!position.tick) {
        items = this.itemsAt(Number.POSITIVE_INFINITY, (this.vault as VaultTimeline).stateAt(Number.POSITIVE_INFINITY))
      } else if (position.backup) {
        tree.createEl('p', { cls: 'connect-tm-quiet', text: `Reading the backup on ${position.backup.label}…` })
        items = await this.itemsOfBackup(position)
      } else {
        past = (this.vault as VaultTimeline).stateAt(position.at)
        items = this.itemsAt(position.at, past)
      }
    } catch (error) {
      if (run !== this.run) return
      tree.empty()
      tree.createEl('p', { cls: 'mod-warning', text: `This state could not be read: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    if (run !== this.run) return
    tree.empty()
    this.renderTree(tree, items, position)
    tree.scrollTop = scrolled
    const chosen = this.selected ? items.find((item) => this.isSelected(item)) : undefined
    if (chosen) {
      if (chosen.kind === 'note') void this.renderNote(preview, run, position, chosen.id, chosen.pathThen ?? chosen.pathNow, chosen, past)
      else void this.renderFile(preview, run, position, chosen)
    } else {
      preview.createEl('p', {
        cls: 'connect-tm-quiet',
        text: position.tick ? 'Choose a note or file on the left to see it as it was then.' : 'Choose a note or file on the left.'
      })
    }
    this.renderVaultActions(actions, position, chosen ?? null)
  }

  private isSelected(item: Item): boolean {
    const selected = this.selected
    if (!selected || selected.kind !== item.kind) return false
    return item.id ? selected.id === item.id : selected.path === item.pathThen
  }

  private differs(item: Item): boolean {
    return item.back || item.goes || item.moved || item.changed
  }

  private renderTree(el: HTMLElement, items: Item[], position: Position): void {
    const head = el.createDiv({ cls: 'connect-tm-tree-head' })
    // Now, nothing differs from now: the whole tree.
    const filtered = this.onlyDiffering && position.tick !== null
    if (position.tick) {
      const label = head.createEl('label', { cls: 'connect-tm-switch' })
      const toggle = label.createEl('input', { type: 'checkbox' })
      toggle.checked = this.onlyDiffering
      label.appendText(' Only what differs from now')
      toggle.onchange = () => {
        this.onlyDiffering = toggle.checked
        this.folderOpen.clear()
        this.renderState()
      }
    }
    const shown = (filtered ? items.filter((item) => this.differs(item)) : items).sort((a, b) =>
      (a.pathThen ?? a.pathNow ?? '').localeCompare(b.pathThen ?? b.pathNow ?? '')
    )
    const differing = items.filter((item) => this.differs(item)).length
    head.createDiv({
      cls: 'connect-tm-quiet',
      text: position.tick ? `${differing} differ${differing === 1 ? 's' : ''} from now.` : `${items.length} notes and files.`
    })
    if (shown.length === 0) {
      el.createEl('p', { cls: 'connect-tm-quiet', text: position.tick ? 'Everything here is as it is now.' : 'Nothing here.' })
      return
    }
    interface Folder {
      folders: Map<string, Folder>
      items: Item[]
    }
    const root: Folder = { folders: new Map(), items: [] }
    const prefix = this.folder ? `${this.folder}/` : ''
    for (const item of shown.slice(0, TREE_MAX)) {
      const path = (item.pathThen ?? item.pathNow ?? '').slice(prefix.length)
      const parts = path.split('/')
      parts.pop()
      let folder = root
      for (const part of parts) {
        let next = folder.folders.get(part)
        if (!next) {
          next = { folders: new Map(), items: [] }
          folder.folders.set(part, next)
        }
        folder = next
      }
      folder.items.push(item)
    }
    const draw = (folder: Folder, into: HTMLElement, at: string): void => {
      for (const [name, child] of Array.from(folder.folders).sort(([a], [b]) => a.localeCompare(b))) {
        const path = at ? `${at}/${name}` : name
        const details = into.createEl('details', { cls: 'connect-tm-folder' })
        // Open while only what differs is shown; otherwise as the person left it.
        details.open = this.folderOpen.get(path) ?? filtered
        details.addEventListener('toggle', () => this.folderOpen.set(path, details.open))
        const summary = details.createEl('summary')
        setIcon(summary.createSpan({ cls: 'connect-tm-icon' }), 'folder')
        summary.createSpan({ text: name })
        draw(child, details.createDiv({ cls: 'connect-tm-children' }), path)
      }
      for (const item of folder.items) this.renderItem(into, item)
    }
    draw(root, el.createDiv({ cls: 'connect-tm-list' }), '')
    if (shown.length > TREE_MAX) el.createEl('p', { cls: 'connect-tm-quiet', text: `… and ${shown.length - TREE_MAX} more.` })
  }

  private renderItem(into: HTMLElement, item: Item): void {
    const row = into.createDiv({ cls: 'connect-tm-item' })
    if (this.isSelected(item)) row.addClass('is-selected')
    if (item.goes) row.addClass('is-later')
    setIcon(row.createSpan({ cls: 'connect-tm-icon' }), item.kind === 'note' ? 'file-text' : 'file')
    row.createSpan({ cls: 'connect-tm-name', text: nameOf(item.pathThen ?? item.pathNow ?? '') })
    const mark = (cls: string, text: string, tip: string): void => {
      row.createSpan({ cls: `connect-tm-badge ${cls}`, text, attr: { 'aria-label': tip } })
    }
    if (item.back) mark('is-back', 'deleted since', 'Gone now; Apply brings it back')
    if (item.goes) mark('is-goes', 'added since', 'Not there then; Apply moves it to the trash')
    if (item.moved) mark('is-moved', 'moved', `Now at ${item.pathNow}; Apply moves it back`)
    if (item.changed) mark('is-changed', 'changed since', 'Apply gives it its content then')
    if (item.foreign) mark('is-foreign', 'shared with you', "Someone else's: Apply leaves it as it is")
    row.onclick = () => {
      this.selected = { kind: item.kind, id: item.id, path: item.pathThen ?? item.pathNow ?? '' }
      this.mode = 'rendered'
      this.renderState()
    }
  }

  private describe(item: Item, el: HTMLElement): void {
    const lines: string[] = []
    if (item.goes) lines.push('It did not exist then: Apply moves it to the trash.')
    if (item.back) lines.push('It is gone now: Apply brings it back.')
    if (item.moved) lines.push(`It is at ${item.pathNow} now: Apply moves it back.`)
    if (item.changed) lines.push('It changed since.')
    if (item.foreign) lines.push("It is someone else's, shared with you: Apply leaves it as it is now - its owner takes it back, for everyone.")
    for (const line of lines) el.createDiv({ cls: 'connect-tm-quiet', text: line })
  }

  /** A note as it was, rendered, as its text or as its changes against now. */
  private async renderNote(
    el: HTMLElement,
    run: number,
    position: Position,
    docId: string,
    path: string | null,
    item: Item | null,
    past: VaultPast | null = null
  ): Promise<void> {
    const ctx = this.ctx as TimeMachineContext
    const head = el.createDiv({ cls: 'connect-tm-preview-head' })
    head.createEl('h4', { text: nameOf(path ?? '') })
    if (path && path !== nameOf(path)) head.createDiv({ cls: 'connect-tm-quiet', text: path })
    if (item) this.describe(item, head)
    const box = el.createDiv({ cls: 'connect-tm-note' })
    if (item?.goes) return
    const modes = head.createDiv({ cls: 'connect-tm-modes' })
    const modeButton = (mode: Mode, label: string): void => {
      const button = modes.createEl('button', { text: label })
      if (this.mode === mode) button.addClass('is-active')
      button.onclick = () => {
        this.mode = mode
        this.renderState()
      }
    }
    modeButton('rendered', 'Rendered')
    modeButton('source', 'Text')
    modeButton('changes', 'Changes against now')

    box.createEl('p', { cls: 'connect-tm-quiet', text: 'Reading its history…' })
    let then: { text: string } | { missing: string }
    let now = ''
    try {
      then = position.tick ? await this.textAt(position, docId, path) : { text: (docId ? await ctx.store.currentText(docId) : null) ?? '' }
      if (this.mode === 'changes' && docId && item?.pathNow !== null) now = (await ctx.store.currentText(docId)) ?? ''
    } catch (error) {
      if (run !== this.run) return
      box.empty()
      box.createEl('p', { cls: 'mod-warning', text: `Its history could not be read: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    if (run !== this.run) return
    box.empty()
    if ('missing' in then) {
      box.createEl('p', { cls: 'connect-tm-quiet', text: then.missing })
      return
    }
    const text = then.text
    if (this.mode === 'source') {
      box.createEl('pre', { cls: 'connect-tm-source', text: text.slice(0, TEXT_MAX) })
    } else if (this.mode === 'changes') {
      this.renderChanges(box, now, text)
    } else {
      const rendered = box.createDiv({ cls: 'connect-tm-rendered markdown-rendered' })
      const component = new Component()
      component.load()
      this.previewComponent = component
      try {
        await MarkdownRenderer.render(this.app, text.slice(0, TEXT_MAX), rendered, path ?? '', component)
      } catch (error) {
        log.warn('rendering a note as it was failed', error)
        rendered.empty()
        rendered.createEl('pre', { cls: 'connect-tm-source', text: text.slice(0, TEXT_MAX) })
        return
      }
      if (this.previewComponent === component && run === this.run) await this.fillEmbeds(rendered, run, path ?? '', past)
    }
  }

  /** What applying changes in a note: lines only there now go, lines only there then come back. */
  private renderChanges(el: HTMLElement, now: string, then: string): void {
    if (now === then) {
      el.createEl('p', { cls: 'connect-tm-quiet', text: 'The same as now.' })
      return
    }
    const legend = el.createDiv({ cls: 'connect-tm-legend' })
    legend.createSpan({ cls: 'connect-tm-gone', text: '− there now, not then' })
    legend.createSpan({ cls: 'connect-tm-back', text: '+ there then, not now' })
    const lines = (text: string, sign: string): string =>
      splitLines(text)
        .map((line) => `${sign} ${line}`)
        .join('')
    let shown = 0
    for (const hunk of lineDiff(now, then)) {
      if (shown > TEXT_MAX) {
        el.createEl('p', { cls: 'connect-tm-quiet', text: '… and more.' })
        return
      }
      if (hunk.type === 'equal') {
        const same = splitLines(now.slice(hunk.aFrom, hunk.aTo))
        const text = same.length <= 4 ? same.join('') : `${same.slice(0, 2).join('')}⋯ ${same.length - 4} unchanged lines\n${same.slice(-2).join('')}`
        el.createEl('pre', { cls: 'connect-tm-same', text })
        shown += text.length
        continue
      }
      const gone = now.slice(hunk.aFrom, hunk.aTo)
      const back = then.slice(hunk.bFrom, hunk.bTo)
      if (gone) el.createEl('pre', { cls: 'connect-tm-gone', text: lines(gone, '−') })
      if (back) el.createEl('pre', { cls: 'connect-tm-back', text: lines(back, '+') })
      shown += gone.length + back.length
    }
  }

  /**
   * The pictures a note embedded, as they were: at a tick of the vault or a
   * folder, each in the content it had then; otherwise those the vault no
   * longer answers, from the server - a deleted one with a way to bring it back.
   */
  private async fillEmbeds(box: HTMLElement, run: number, sourcePath: string, past: VaultPast | null): Promise<void> {
    const attachments = this.ctx?.attachments
    if (!attachments) return
    const matches = (path: string, link: string): boolean => path === link || path.endsWith(`/${link}`) || nameOf(path) === link
    for (const span of Array.from(box.querySelectorAll<HTMLElement>('.internal-embed[src]'))) {
      const link = getLinkpath(span.getAttribute('src') ?? '')
      if (!link) continue
      const inVault = this.app.metadataCache.getFirstLinkpathDest(link, sourcePath)
      let target: { fileId: string; path: string; hash: string; size: number; deleted: boolean } | null = null
      if (past) {
        const then = Array.from(past.files).find(([, entry]) => !entry.deletedAt && matches(entry.path, link))
        if (then) {
          const now = attachments.entryOf(then[0])
          // The same content as now: Obsidian shows it already.
          if (inVault && now && !now.deletedAt && now.hash === then[1].hash) continue
          target = { fileId: then[0], path: then[1].path, hash: then[1].hash, size: then[1].size, deleted: Boolean(now?.deletedAt) }
        }
      }
      if (!target && !inVault) target = attachments.embedTarget(link)
      if (!target) continue
      const holder = createDiv({ cls: 'connect-embed-from-server' })
      span.replaceWith(holder)
      const type = imageType(target.path)
      if (type && target.size <= PREVIEW_MAX_BYTES) {
        try {
          const data = await attachments.contentOf(target.hash)
          if (run !== this.run) return
          const url = imageUrl(data, type)
          this.urls.push(url)
          holder.createEl('img', { attr: { src: url, alt: target.path } })
        } catch (error) {
          log.warn(`fetching ${target.path} for the Time Machine failed`, error)
        }
      }
      const note = holder.createDiv({ cls: 'connect-embed-note' })
      if (past) {
        note.createSpan({ text: `${target.path} as it was then (${formatSize(target.size)}).` })
        continue
      }
      note.createSpan({
        text: target.deleted
          ? `${target.path} is in the trash (${formatSize(target.size)}).`
          : `${target.path} is on the server, not on this device (${formatSize(target.size)}).`
      })
      if (target.deleted) {
        const fileId = target.fileId
        const button = note.createEl('button', { text: 'Restore' })
        const spinning = { buttonEl: button, setDisabled: (disabled: boolean) => (button.disabled = disabled) }
        button.onclick = () =>
          void busy(spinning, async () => {
            try {
              const file = await attachments.restoreDeleted(fileId)
              new Notice(file ? `Restored as ${file.path}.` : 'It comes back as soon as the server answers.')
              this.renderState()
            } catch (error) {
              new Notice(`Restoring failed: ${error instanceof Error ? error.message : String(error)}`)
            }
          })
      }
    }
  }

  /** A file as it was: a picture shown, anything else named. */
  private async renderFile(el: HTMLElement, run: number, position: Position, item: Item): Promise<void> {
    const head = el.createDiv({ cls: 'connect-tm-preview-head' })
    const path = item.pathThen ?? item.pathNow ?? ''
    head.createEl('h4', { text: nameOf(path) })
    if (path !== nameOf(path)) head.createDiv({ cls: 'connect-tm-quiet', text: path })
    this.describe(item, head)
    const box = el.createDiv({ cls: 'connect-tm-file' })
    const attachments = this.ctx?.attachments
    const hash = position.tick ? item.hashThen : attachments?.entryOf(item.id)?.hash
    const size = position.tick ? item.sizeThen : attachments?.entryOf(item.id)?.size
    if (!hash || size === undefined || !attachments) return
    const type = imageType(path)
    box.createDiv({ cls: 'connect-tm-quiet', text: formatSize(size) })
    if (!type) {
      box.createEl('p', { cls: 'connect-tm-quiet', text: 'No preview for this kind of file.' })
      return
    }
    if (size > PREVIEW_MAX_BYTES) {
      box.createEl('p', { cls: 'connect-tm-quiet', text: 'Too large for a preview.' })
      return
    }
    try {
      const data = position.backup ? await this.backupBytes(position, path) : await attachments.contentOf(hash)
      if (run !== this.run) return
      if (!data) {
        box.createEl('p', { cls: 'connect-tm-quiet', text: 'The backup does not hand it over.' })
        return
      }
      const url = imageUrl(bytes(data), type)
      this.urls.push(url)
      box.createEl('img', { cls: 'connect-version-preview', attr: { src: url, alt: path } })
    } catch (error) {
      if (run !== this.run) return
      log.warn(`fetching ${path} for the Time Machine failed`, error)
      box.createEl('p', { cls: 'connect-tm-quiet', text: 'The server no longer has this version.' })
    }
  }

  // --- what can be done ------------------------------------------------------------------

  private renderNoteActions(el: HTMLElement, position: Position): void {
    const ctx = this.ctx as TimeMachineContext
    const docId = (this.note as { docId: string }).docId
    if (!position.tick) {
      el.createDiv({ cls: 'connect-tm-quiet', text: 'This is the note now. Move the slider to the left to go back in time.' })
      return
    }
    if (ctx.store.isReadOnly(docId)) {
      el.createDiv({ cls: 'connect-tm-quiet', text: 'This note is shared with you to read only, so it cannot be restored here.' })
      return
    }
    const button = el.createEl('button', { cls: 'mod-cta', text: 'Restore this version' })
    const spinning = { buttonEl: button, setDisabled: (disabled: boolean) => (button.disabled = disabled) }
    button.onclick = () =>
      void busy(spinning, async () => {
        try {
          const then = await this.textAt(position, docId, this.target.kind === 'note' ? this.target.path : null)
          if ('missing' in then) throw new Error(then.missing)
          await ctx.store.restore(docId, then.text)
          new Notice(`${nameOf(this.target.kind === 'note' ? this.target.path : '')} is back to ${when(position.at)}. The restore is a version itself, so it can be undone.`, 8_000)
          await this.load()
        } catch (error) {
          log.error('restoring a version failed', error)
          new Notice(`Restoring failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
    el.createDiv({ cls: 'connect-tm-quiet', text: 'What the note says now goes into a backup first.' })
  }

  private renderVaultActions(el: HTMLElement, position: Position, chosen: Item | null): void {
    const ctx = this.ctx as TimeMachineContext
    const owner = this.folder ? ctx.folderOwner(`${this.folder}/x`) : null
    if (position.tick) {
      const buttons = el.createDiv({ cls: 'connect-tm-buttons' })
      if (owner) {
        el.createDiv({
          cls: 'connect-tm-quiet',
          text: `This folder is ${owner}'s. You see its past; only ${owner} takes it back, for everyone.`
        })
      } else {
        const apply = buttons.createEl('button', { cls: 'mod-warning', text: 'Apply…' })
        apply.onclick = () =>
          new ApplyModal(this.app, ctx.rollback(), ctx.backups, this.folder, position.at, () => void this.load()).open()
        el.createDiv({
          cls: 'connect-tm-quiet',
          text: `Apply takes ${this.folder ? 'the folder' : 'the vault'} back to this moment: you see the list of what changes first, and every backup server backs up before anything changes.`
        })
      }
      if (chosen && this.restorable(chosen)) {
        const restore = buttons.createEl('button', { text: chosen.kind === 'note' ? 'Restore just this note' : 'Restore just this file' })
        const spinning = { buttonEl: restore, setDisabled: (disabled: boolean) => (restore.disabled = disabled) }
        restore.onclick = () =>
          void busy(spinning, async () => {
            try {
              const message = chosen.kind === 'note' ? await this.restoreNote(position, chosen) : await this.restoreFile(position, chosen)
              new Notice(message, 8_000)
              await this.load()
            } catch (error) {
              log.error('restoring one note or file failed', error)
              new Notice(`Restoring failed: ${error instanceof Error ? error.message : String(error)}`)
            }
          })
      }
    } else {
      el.createDiv({ cls: 'connect-tm-quiet', text: 'This is now. Move the slider to the left to go back in time.' })
    }
    const records = ctx.settings
      .rollbacks()
      .filter((record) => !this.folder || record.folder === this.folder)
      .slice(0, ROLLBACKS_SHOWN)
    if (records.length > 0 && !owner) this.renderRollbacks(el, records)
  }

  private restorable(item: Item): boolean {
    const ctx = this.ctx as TimeMachineContext
    if (item.goes || item.pathThen === null || !(item.back || item.changed)) return false
    // Someone else's note only as an edit, where one may write; one gone is a share that ended or was left.
    if (item.kind === 'note') return !item.id || (!ctx.store.isReadOnly(item.id) && !(item.foreign && item.pathNow === null))
    return !item.foreign && Boolean(ctx.attachments && item.hashThen)
  }

  /** One note back to a position: its text then, out of the trash first if it is there. */
  private async restoreNote(position: Position, item: Item): Promise<string> {
    const store = (this.ctx as TimeMachineContext).store
    const then = await this.textAt(position, item.id, item.pathThen)
    if ('missing' in then) throw new Error(then.missing)
    const path = item.pathThen as string
    if (!item.id) {
      const at = await store.createNote(path, then.text)
      return `${at} is back, from the backup of ${when(position.at)}.`
    }
    if (item.pathNow === null) {
      const at = await store.reviveNote(item.id, path)
      await store.rollBackText(item.id, then.text)
      return `${at ?? path} is back from the trash, as it was at ${when(position.at)}.`
    }
    // What it says now goes into a backup first.
    await store.restore(item.id, then.text)
    return `${item.pathNow} is back to ${when(position.at)}. That is a change like any other and can be undone.`
  }

  /** One file back to a position: its content then, out of the trash first if it is there. */
  private async restoreFile(position: Position, item: Item): Promise<string> {
    const attachments = (this.ctx as TimeMachineContext).attachments as AttachmentStore
    const path = item.pathThen as string
    const hash = item.hashThen as string
    const size = item.sizeThen as number
    if (position.backup) {
      const data = await this.backupBytes(position, path)
      if (!data) throw new Error('the backup does not hand it over')
      if (!item.id) {
        const at = await attachments.createFile(path, bytes(data), hash)
        return `${at} is back, from the backup of ${when(position.at)}.`
      }
      await attachments.uploadContent(bytes(data), hash)
    } else if ((await attachments.missingContents([hash])).length > 0) {
      throw new Error('the server no longer has that version')
    }
    if (item.pathNow === null) {
      const at = await attachments.reviveFile(item.id, path, hash, size)
      return `${at ?? path} is back from the trash, as it was at ${when(position.at)}.`
    }
    // What it holds now stays a version of its own.
    await attachments.setFileContent(item.id, hash, size)
    return `${item.pathNow} is back to ${when(position.at)}. The version it replaced is kept.`
  }

  private renderRollbacks(el: HTMLElement, records: RollbackRecord[]): void {
    const ctx = this.ctx as TimeMachineContext
    const details = el.createEl('details', { cls: 'connect-tm-rollbacks' })
    details.createEl('summary', { text: `Earlier rollbacks: ${records.length}` })
    for (const record of records) {
      const row = details.createDiv({ cls: 'connect-tm-rollback' })
      const state = record.state === 'done' ? 'done' : record.state === 'failed' ? `with problems: ${record.error ?? ''}` : 'broke off, or still running'
      row.createDiv({ text: `${record.folder || 'The vault'} back to ${when(record.to)}` })
      row.createDiv({ cls: 'connect-tm-quiet', text: `On ${when(record.startedAt)}: ${record.notes} notes, ${record.files} files - ${state}` })
      const undo = row.createEl('button', { text: 'Undo…' })
      // To just before it began, in the same place.
      undo.onclick = () => new ApplyModal(this.app, ctx.rollback(), ctx.backups, record.folder, record.startedAt - 1, () => void this.load()).open()
    }
  }

  private dropPreview(): void {
    this.previewComponent?.unload()
    this.previewComponent = null
    for (const url of this.urls.splice(0)) URL.revokeObjectURL(url)
  }
}
