import { TFile } from 'obsidian'
import {
  docRoom,
  type AttachmentEntry,
  type BackupListedEntry,
  type BackupSnapshotRef,
  type IndexEntry,
  type LogResponse,
  type TimesResponse
} from '@obsidian-connect/shared'
import { bytes, contentHash, fromUtf8 } from '@obsidian-connect/shared/crypto'
import type { BackupSource } from '../sync/Rollback.js'
import type { RoomCrypto } from '../sync/VaultSocket.js'
import { NoteHistory } from './NoteHistory.js'
import type { PastFiles, PastVault, RestoreReport } from './PastFiles.js'
import { TICK_GAP_MS, VaultTimeline, inFolder, livePath, type Tick } from './Timeline.js'
import { log } from '../log.js'

// The Time Machine's second round (`docs/TIMEMACHINE.md`, "Decided"): the past of
// the vault, a folder or a note shown in the vault's own files, while the sync
// is stopped on this device and the vault locked on every device. This is what
// a moment of the past is, and how the files come to show it; `PastFiles`
// writes them and puts them back; `TimeMachineControl` stops and starts the
// sync, takes the lock and draws the strip.
//
// A moment is shown in two steps: the structure at once - what was deleted since
// comes back, what came later goes, what moved goes back -, then the contents,
// the note in front first, the others in the background. Pictures and other
// files larger than a few megabytes only when opened.

export type TimeMachineScope = { kind: 'vault' } | { kind: 'folder'; path: string } | { kind: 'note'; path: string }

/** How fine the ticks are (`docs/TIMEMACHINE.md`, V1): a pause of this long on two changes makes two. */
export type TickChoice = 'auto' | 'change' | 'minute' | 'five' | 'hour' | 'day'

const MINUTE_MS = 60_000
// A note's own versions, as before: typing ended by a pause of a minute.
const NOTE_GAP_MS = MINUTE_MS
// Files above this are fetched when opened, not in the background.
const BACKGROUND_FILE_MAX = 2 * 1024 * 1024
const AT_ONCE = 4

export function gapOf(choice: TickChoice, scope: TimeMachineScope): number {
  switch (choice) {
    case 'change':
      return 0
    case 'minute':
      return MINUTE_MS
    case 'five':
      return 5 * MINUTE_MS
    case 'hour':
      return 60 * MINUTE_MS
    case 'day':
      return 24 * 60 * MINUTE_MS
    default:
      return scope.kind === 'note' ? NOTE_GAP_MS : TICK_GAP_MS
  }
}

export function sameScope(a: TimeMachineScope, b: TimeMachineScope): boolean {
  return a.kind === b.kind && (a.kind === 'vault' || (a as { path: string }).path === (b as { path: string }).path)
}

export function scopeName(scope: TimeMachineScope): string {
  if (scope.kind === 'vault') return 'the vault'
  const name = scope.path.slice(scope.path.lastIndexOf('/') + 1)
  return scope.kind === 'folder' ? `the folder ${name}` : `the note ${name.replace(/\.md$/, '')}`
}

/** The backup servers, as far as the Time Machine reads them. */
export interface TimeMachineBackups extends BackupSource {
  backupTimes(routeId: string): Promise<number[]>
}

/** How the past is read while the sync is stopped: from the server, and from the backups. */
export interface PastSource {
  api: { log(room: string): Promise<LogResponse>; frameTimes(vaultId: string, since?: number): Promise<TimesResponse> }
  vaultId: string
  indexCrypto: RoomCrypto
  noteCrypto(docId: string): RoomCrypto
  /** A file's content, by its hash, from the vault's store on the server. */
  download(hash: string): Promise<Uint8Array>
  backups: TimeMachineBackups | null
}

/** Now, as the sync knew it when it stopped: the past is compared with it. */
export interface NowSnapshot {
  notes: Array<{ docId: string; entry: IndexEntry }>
  files: Array<{ fileId: string; entry: AttachmentEntry }>
  isExcluded(path: string): boolean
  /** Whoever owns the shared folder a path lies in, when that is someone else. */
  folderOwner(path: string): string | null
  /** A note shared to read only: it cannot be restored. */
  readOnly(docId: string): boolean
}

export interface SessionOptions {
  vault: PastVault
  choice: TickChoice
  includeBackups: boolean
  /** Files larger than this stay as they are now: the device's download limit. */
  fileLimit: number
}

/** One place on the strip. */
export interface Position {
  /** The moment shown; infinite for now. */
  at: number
  /** Null for now. */
  tick: Tick | null
  /** A backup run's, further back than the history reaches. */
  backup?: { routeId: string; label: string }
}

/** A note or file of the past against now, for the overview. */
export interface PastItem {
  kind: 'note' | 'file'
  /** Its id now; '' for one only a backup knows. */
  id: string
  pathThen: string | null
  pathNow: string | null
  /** There then, gone now. */
  back: boolean
  /** Not there then. */
  goes: boolean
  moved: boolean
  /** Its content then is another: true or false once compared, null while not yet. */
  changed: boolean | null
  /** Someone else's: *Apply* leaves it as it is. */
  foreign: boolean
  /** A note shared to read only: it cannot be restored. */
  readOnly?: boolean
  /** Its content then could not be read - before the history, or too large for this device. */
  unreadable?: string
}

/** What a path holds at a moment. */
type Target = { kind: 'note'; id: string } | { kind: 'file'; id: string; hash: string; size: number }

interface Present {
  kind: 'note' | 'file'
  id: string
  hash?: string
  size?: number
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

export class TimeMachineSession {
  positions: Position[] = []
  place = 0
  /** The change that made now what it is, when it is the newest tick. */
  latest: Tick | null = null
  /** Where the history begins: 0 while it holds everything. */
  reach = 0
  backupProblem: string | null = null
  withoutTimes = false
  /** How far filling in the contents of the moment shown got. */
  progress: { done: number; of: number } | null = null
  items: PastItem[] = []
  private files: PastFiles | null = null
  private timeline: VaultTimeline | null = null
  private readonly histories = new Map<string, Promise<NoteHistory>>()
  private readonly backupRefs = new Map<string, Promise<BackupSnapshotRef | null>>()
  private readonly listings = new Map<string, Promise<BackupListedEntry[]>>()
  private readonly nowByPath = new Map<string, Present>()
  private readonly nowById = new Map<string, string>()
  private readonly nowTexts = new Map<string, Promise<string | null>>()
  /** What each path shows for the moment on screen. */
  private shown = new Map<string, Target>()
  /** Paths whose content still has to be filled in, the next first. */
  private queue: string[] = []
  private run = 0
  private work: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<() => void>()

  private constructor(
    readonly scope: TimeMachineScope,
    private readonly source: PastSource,
    private readonly now: NowSnapshot,
    private options: SessionOptions
  ) {
    for (const { docId, entry } of now.notes) {
      const path = livePath(entry)
      if (path) {
        this.nowByPath.set(path, { kind: 'note', id: docId })
        this.nowById.set(docId, path)
      }
    }
    for (const { fileId, entry } of now.files) {
      const path = livePath(entry)
      if (path) {
        this.nowByPath.set(path, { kind: 'file', id: fileId, hash: entry.hash, size: entry.size })
        this.nowById.set(fileId, path)
      }
    }
  }

  /** Reads the past of the scope - ticks, where the history begins, the backups before it. Writes nothing. */
  static async load(scope: TimeMachineScope, source: PastSource, now: NowSnapshot, options: SessionOptions): Promise<TimeMachineSession> {
    const session = new TimeMachineSession(scope, source, now, options)
    await session.readPositions()
    return session
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  get position(): Position | null {
    return this.positions[this.place] ?? null
  }

  get folder(): string {
    return this.scope.kind === 'folder' ? this.scope.path : ''
  }

  /** The note a note's Time Machine shows, by its id now. */
  get noteId(): string | null {
    return this.scope.kind === 'note' ? (this.nowByPath.get(this.scope.path)?.id ?? null) : null
  }

  inScope(path: string): boolean {
    if (this.now.isExcluded(path)) return false
    if (this.scope.kind === 'note') return path === this.scope.path
    return inFolder(path, this.folder)
  }

  /** Whoever owns the shared folder shown, when that is someone else: they apply its past, not this account. */
  get folderOwner(): string | null {
    return this.folder ? this.now.folderOwner(`${this.folder}/x`) : null
  }

  // --- the moments -----------------------------------------------------------------

  /** Other ticks, or backups on or off: the moments read again; the moment shown stays if it still is one. */
  async reread(options: Pick<SessionOptions, 'choice' | 'includeBackups'>): Promise<void> {
    const at = this.position?.at
    this.options = { ...this.options, ...options }
    this.latest = null
    this.backupProblem = null
    await this.readPositions()
    const same = this.positions.findIndex((position) => position.at === at)
    if (same >= 0) {
      this.place = same
      this.emit()
    } else {
      await this.moveTo(this.positions.length - 1)
    }
  }

  private async readPositions(): Promise<void> {
    const gap = gapOf(this.options.choice, this.scope)
    let ticks: Tick[]
    if (this.scope.kind === 'note') {
      const docId = this.noteId
      if (!docId) throw new Error(`${this.scope.path} is not synced.`)
      const history = await this.historyOf(docId)
      ticks = history.ticks(gap)
      // A tick shows the note after its changes, so the newest is now - unless this device changed it since.
      if (ticks.length > 0 && history.latestText() === (await this.currentText(this.scope.path))) this.latest = ticks.pop() ?? null
      this.reach = history.reach
    } else {
      const timeline =
        this.timeline ?? (await VaultTimeline.load({ api: this.source.api, vaultId: this.source.vaultId, indexCrypto: this.source.indexCrypto }))
      this.timeline = timeline
      this.withoutTimes = timeline.withoutTimes
      ticks = timeline.ticks(this.folder, gap)
      const last = ticks.at(-1)
      if (last && !this.structureDiffers(this.historyTargets(last.at))) this.latest = ticks.pop() ?? null
      this.reach = timeline.reach
    }
    const positions: Position[] = ticks.map((tick) => ({ at: tick.at, tick }))
    if (this.options.includeBackups && this.source.backups && this.reach > 0) positions.unshift(...(await this.backupPositions(this.source.backups, this.reach)))
    positions.push({ at: Number.POSITIVE_INFINITY, tick: null })
    this.positions = positions
    this.place = positions.length - 1
  }

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

  // --- reading the past ------------------------------------------------------------

  private historyOf(docId: string): Promise<NoteHistory> {
    let history = this.histories.get(docId)
    if (!history) {
      const loading = new NoteHistory(this.source.api, docRoom(docId), this.source.noteCrypto(docId))
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
      ref = (this.source.backups as TimeMachineBackups).backupAt(backup.routeId, position.at)
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
      listed = this.backupRef(position).then((ref) => (ref ? (this.source.backups as TimeMachineBackups).backupListing(backup.routeId, ref) : []))
      listed.catch(() => this.listings.delete(key))
      this.listings.set(key, listed)
    }
    return listed
  }

  private async backupBytes(position: Position, path: string): Promise<Uint8Array | null> {
    const backup = position.backup as NonNullable<Position['backup']>
    const ref = await this.backupRef(position)
    if (!ref) return null
    let found: Uint8Array | null = null
    await (this.source.backups as TimeMachineBackups).backupRead(backup.routeId, ref, [path], async (_path, data) => {
      found = data
    })
    return found
  }

  /** A note's text at a position; null where neither its history nor the backup reaches. */
  private async pastText(position: Position, docId: string, path: string): Promise<{ text: string; mtime?: number } | { missing: string }> {
    if (position.backup) {
      const data = await this.backupBytes(position, path)
      return data ? { text: fromUtf8(data), mtime: position.at } : { missing: 'not in that backup' }
    }
    if (!docId) return { missing: 'not in the history' }
    const history = await this.historyOf(docId)
    if (!history.reaches(position.at)) {
      return { missing: history.unreadable > 0 ? 'part of its history is from before you had access' : 'before its history begins' }
    }
    return { text: history.textAtTime(position.at), mtime: history.changedAt(position.at) ?? undefined }
  }

  // --- what a moment is ------------------------------------------------------------

  /** The paths of the scope at a moment of the history, and what each held. */
  private historyTargets(at: number): Map<string, Target> {
    const targets = new Map<string, Target>()
    if (this.scope.kind === 'note') {
      const docId = this.noteId
      if (docId) targets.set(this.scope.path, { kind: 'note', id: docId })
      return targets
    }
    const past = (this.timeline as VaultTimeline).stateAt(at)
    for (const [docId, entry] of past.notes) {
      const path = livePath(entry)
      if (path && this.inScope(path)) targets.set(path, { kind: 'note', id: docId })
    }
    for (const [fileId, entry] of past.files) {
      const path = livePath(entry)
      if (path && this.inScope(path)) targets.set(path, { kind: 'file', id: fileId, hash: entry.hash, size: entry.size })
    }
    return targets
  }

  private async targetsAt(position: Position): Promise<Map<string, Target>> {
    if (!position.backup) return this.historyTargets(position.at)
    const targets = new Map<string, Target>()
    for (const entry of await this.listing(position)) {
      if (!this.inScope(entry.path)) continue
      // A backup knows paths, not ids: the note or file at that path now is taken for the same.
      const present = this.nowByPath.get(entry.path)
      if (entry.path.endsWith('.md')) targets.set(entry.path, { kind: 'note', id: present?.kind === 'note' ? present.id : '' })
      else targets.set(entry.path, { kind: 'file', id: present?.kind === 'file' ? present.id : '', hash: entry.hash, size: entry.size })
    }
    return targets
  }

  /** Whether a moment's paths differ from now - added, gone, moved, a file's content. Notes' texts are not read. */
  private structureDiffers(targets: Map<string, Target>): boolean {
    for (const [path, present] of this.nowByPath) {
      if (!this.inScope(path)) continue
      const then = targets.get(path)
      if (!then || then.id !== present.id || (then.kind === 'file' && then.hash !== present.hash)) return true
    }
    for (const path of targets.keys()) if (!this.nowByPath.has(path)) return true
    return false
  }

  private itemsFor(targets: Map<string, Target>, position: Position): PastItem[] {
    const items: PastItem[] = []
    const seen = new Set<string>()
    const foreignNote = (id: string): boolean => {
      const entry = this.now.notes.find((note) => note.docId === id)?.entry
      return Boolean(entry?.owner || entry?.forkedTo)
    }
    for (const [path, then] of targets) {
      const pathNow = then.id ? (this.nowById.get(then.id) ?? null) : this.nowByPath.has(path) ? path : null
      seen.add(`${then.kind}:${then.id || path}`)
      const present = pathNow ? this.nowByPath.get(pathNow) : undefined
      let changed: boolean | null = false
      if (pathNow) {
        if (then.kind === 'file') changed = present?.hash !== then.hash
        else if (position.backup || !then.id || (this.timeline?.editedAfter(then.id, position.at) ?? true)) changed = null
      }
      items.push({
        kind: then.kind,
        id: then.id,
        pathThen: path,
        pathNow,
        back: pathNow === null,
        goes: false,
        moved: pathNow !== null && pathNow !== path,
        changed,
        foreign: then.kind === 'note' ? foreignNote(then.id) : Boolean(this.now.folderOwner(path)),
        readOnly: then.kind === 'note' && then.id !== '' && this.now.readOnly(then.id)
      })
    }
    for (const [path, present] of this.nowByPath) {
      if (!this.inScope(path) || seen.has(`${present.kind}:${present.id}`)) continue
      if (position.backup && targets.has(path)) continue
      items.push({
        kind: present.kind,
        id: present.id,
        pathThen: null,
        pathNow: path,
        back: false,
        goes: true,
        moved: false,
        changed: false,
        foreign: present.kind === 'note' ? foreignNote(present.id) : Boolean(this.now.folderOwner(path))
      })
    }
    return items
  }

  // --- the files ---------------------------------------------------------------------

  /** Starts writing: the journal is open, the sync stopped. */
  attach(files: PastFiles): void {
    this.files = files
  }

  private fileAt(path: string): TFile | null {
    const file = this.options.vault.getAbstractFileByPath(path)
    return file instanceof TFile ? file : null
  }

  /** What a path holds now - before the Time Machine touched it. */
  private async currentBytes(path: string): Promise<Uint8Array | null> {
    const kept = await this.files?.originalBytes(path)
    if (kept !== undefined) return kept
    const file = this.fileAt(path)
    return file ? new Uint8Array(await this.options.vault.readBinary(file)) : null
  }

  private async currentText(path: string): Promise<string | null> {
    const data = await this.currentBytes(path)
    return data === null ? null : fromUtf8(data)
  }

  /** What a path holds this very moment, written by the Time Machine or not. */
  private async fileBytes(path: string): Promise<Uint8Array | null> {
    const file = this.fileAt(path)
    return file ? new Uint8Array(await this.options.vault.readBinary(file)) : null
  }

  /**
   * For the editor's marks: what the note a path shows of the past says now.
   * Undefined when the path shows no past; null for a note not there now.
   */
  async nowTextOf(path: string): Promise<string | null | undefined> {
    const target = this.shown.get(path)
    if (!target || target.kind !== 'note' || this.position?.tick === null) return undefined
    const pathNow = target.id ? this.nowById.get(target.id) : this.nowByPath.has(path) ? path : undefined
    if (!pathNow) return null
    // Now does not change while the past is shown; every editor asks on every step.
    let text = this.nowTexts.get(pathNow)
    if (!text) {
      text = this.currentText(pathNow)
      this.nowTexts.set(pathNow, text)
    }
    return text
  }

  /** Whether a path shows the past - for read-only editors. */
  showsPast(path: string): boolean {
    return this.position?.tick !== null && (this.shown.has(path) || (this.files?.touched(path) ?? false))
  }

  /** The note or file in front: its content comes next. */
  prioritize(path: string): void {
    const at = this.queue.indexOf(path)
    if (at > 0) {
      this.queue.splice(at, 1)
      this.queue.unshift(path)
    }
  }

  /** Moves to a place on the strip. Files change in order; a move while one is under way takes its place. */
  moveTo(place: number): Promise<void> {
    const next = Math.max(0, Math.min(place, this.positions.length - 1))
    const run = (this.run += 1)
    this.place = next
    this.queue = []
    this.progress = null
    this.emit()
    const step = this.work.then(() => this.show(run))
    this.work = step.catch((error: unknown) => log.error('the Time Machine could not show that moment', error))
    return step
  }

  private async show(run: number): Promise<void> {
    if (run !== this.run || !this.files) return
    const position = this.position
    if (!position) return
    if (!position.tick) {
      this.items = []
      this.shown = new Map()
      for (const path of this.files.paths()) {
        if (run !== this.run) return
        await this.files.showOriginal(path)
      }
      this.emit()
      return
    }
    const targets = await this.targetsAt(position)
    if (run !== this.run) return
    this.items = this.itemsFor(targets, position)
    this.shown = targets
    this.emit()
    await this.writeStructure(targets, position, run)
    if (run !== this.run) return
    await this.fillContents(targets, position, run)
  }

  private async writeStructure(targets: Map<string, Target>, position: Position, run: number): Promise<void> {
    const files = this.files as PastFiles
    const paths = new Set<string>([...targets.keys(), ...files.paths()])
    for (const path of this.nowByPath.keys()) if (this.inScope(path)) paths.add(path)
    const away: string[] = []
    const arrive: string[] = []
    const queue: string[] = []
    for (const path of paths) {
      const then = targets.get(path)
      const present = this.nowByPath.get(path)
      if (!then) {
        if (present || files.touched(path)) away.push(path)
        continue
      }
      const same = present !== undefined && present.kind === then.kind && (then.id === '' || present.id === then.id)
      // Large files only when opened (`fetchOnOpen`).
      const later = then.kind === 'file' && then.size > BACKGROUND_FILE_MAX
      if (!same) {
        arrive.push(path)
        if (!later) queue.push(path)
      } else if (then.kind === 'file') {
        if (present.hash === then.hash) await files.showOriginal(path)
        else if (!later) queue.push(path)
      } else if (position.backup || this.timeline?.editedAfter(then.id, position.at) !== false || files.touched(path)) {
        queue.push(path)
      }
    }
    for (const path of away) {
      if (run !== this.run) return
      await files.show(path, null)
    }
    for (const path of arrive) {
      if (run !== this.run) return
      const then = targets.get(path) as Target
      // Moved: what it holds now stands in until its content then is read; a note only back from the trash waits empty.
      const from = then.id ? this.nowById.get(then.id) : undefined
      if (then.kind === 'note') {
        await files.show(path, from ? ((await this.currentText(from)) ?? '') : '')
      } else if (from && this.nowByPath.get(from)?.hash === then.hash) {
        const data = await this.currentBytes(from)
        if (data) await files.show(path, data)
        const queued = queue.indexOf(path)
        if (queued >= 0) queue.splice(queued, 1)
      } else if (then.size > BACKGROUND_FILE_MAX) {
        // In the explorer at once, its content when it is opened.
        await files.show(path, new Uint8Array(0))
        this.mark(path, { unreadable: 'its content comes when you open it' })
      }
    }
    // Folders of now the past has no file in, emptied: gone too, the deepest first - never the folder shown itself.
    const wanted = new Set<string>()
    for (const path of targets.keys()) for (let folder = parentOf(path); folder; folder = parentOf(folder)) wanted.add(folder)
    const emptied = new Set<string>()
    for (const path of away) for (let folder = parentOf(path); folder && !wanted.has(folder); folder = parentOf(folder)) emptied.add(folder)
    for (const folder of Array.from(emptied).sort((a, b) => b.length - a.length)) {
      if (run !== this.run) return
      const within = this.scope.kind === 'vault' || (folder !== this.folder && inFolder(folder, this.folder))
      if (within) await files.removeFolderIfEmpty(folder)
    }
    this.queue = queue
  }

  private async fillContents(targets: Map<string, Target>, position: Position, run: number): Promise<void> {
    const total = this.queue.length
    let done = 0
    this.progress = total > 0 ? { done, of: total } : null
    this.emit()
    while (this.queue.length > 0) {
      if (run !== this.run) return
      const batch = this.queue.splice(0, AT_ONCE)
      // Read at once, written one after another: the files change in order.
      const contents = await Promise.all(batch.map((path) => this.contentFor(path, targets.get(path) as Target, position).catch((error: unknown) => ({ error }))))
      for (let i = 0; i < batch.length; i += 1) {
        if (run !== this.run) return
        const path = batch[i] as string
        const content = contents[i]
        if (!content || 'error' in content) {
          if (content && 'error' in content) log.warn(`reading ${path} as it was failed`, content.error)
          this.mark(path, { unreadable: 'could not be read' })
          continue
        }
        if ('skip' in content) {
          this.mark(path, { unreadable: content.skip })
          continue
        }
        if (content.data !== undefined) await (this.files as PastFiles).show(path, content.data, content.mtime)
        if (content.changed !== undefined) this.mark(path, { changed: content.changed })
      }
      done += batch.length
      this.progress = { done, of: total }
      this.emit()
    }
    this.progress = null
    this.emit()
  }

  private mark(path: string, change: Partial<PastItem>): void {
    const item = this.items.find((candidate) => candidate.pathThen === path)
    if (item) Object.assign(item, change)
  }

  /**
   * What a path should hold at a position: `data` to write (undefined: it holds
   * that already), and whether it differs from now.
   */
  private async contentFor(
    path: string,
    target: Target,
    position: Position
  ): Promise<{ data?: string | Uint8Array; mtime?: number; changed?: boolean } | { skip: string } | null> {
    const pathNow = target.id ? this.nowById.get(target.id) : this.nowByPath.has(path) ? path : undefined
    if (target.kind === 'note') {
      const then = await this.pastText(position, target.id, path)
      if ('missing' in then) return { skip: then.missing }
      const current = await this.fileBytes(path)
      const now = pathNow ? await this.currentText(pathNow) : null
      return {
        data: current !== null && fromUtf8(current) === then.text ? undefined : then.text,
        mtime: then.mtime,
        changed: now === null ? undefined : now !== then.text
      }
    }
    if (target.size > this.options.fileLimit) return { skip: 'too large for this device' }
    const current = await this.fileBytes(path)
    if (current && (await contentHash(bytes(current))) === target.hash) return {}
    const data = position.backup ? await this.backupBytes(position, path) : await this.source.download(target.hash)
    if (!data) return { skip: 'not on the server any more' }
    return { data, mtime: position.backup ? position.at : (this.timeline?.changedAt(target.id, position.at) ?? undefined) }
  }

  /** A note's text at the moment shown, to restore it; null where it cannot be told. */
  async noteTextAt(path: string): Promise<string | null> {
    const position = this.position
    const target = this.shown.get(path)
    if (!position?.tick || target?.kind !== 'note') return null
    const then = await this.pastText(position, target.id, path)
    return 'missing' in then ? null : then.text
  }

  /** A file's content at the moment shown, to restore it. */
  async fileDataAt(path: string): Promise<{ data: Uint8Array; hash: string; size: number } | null> {
    const position = this.position
    const target = this.shown.get(path)
    if (!position?.tick || target?.kind !== 'file') return null
    const data = position.backup ? await this.backupBytes(position, path) : await this.source.download(target.hash)
    return data ? { data, hash: target.hash, size: target.size } : null
  }

  /** Background filling leaves large files out; opening one fetches it. */
  async fetchOnOpen(path: string): Promise<void> {
    const position = this.position
    const target = this.shown.get(path)
    if (!position?.tick || !target || target.kind !== 'file' || target.size <= BACKGROUND_FILE_MAX) return
    const run = this.run
    const step = this.work.then(async () => {
      if (run !== this.run) return
      const content = await this.contentFor(path, target, position)
      if (run !== this.run || !content || 'skip' in content || content.data === undefined) return
      await (this.files as PastFiles).show(path, content.data, content.mtime)
    })
    this.work = step.catch((error: unknown) => log.warn(`fetching ${path} as it was failed`, error))
    await this.work
  }

  /** Lets go: every file back as it was. The journal stays until the plugin says the sync may start. */
  async restore(): Promise<RestoreReport> {
    this.run += 1
    this.queue = []
    await this.work
    for (const history of this.histories.values()) void history.then((loaded) => loaded.destroy(), () => undefined)
    this.histories.clear()
    const files = this.files
    if (!files) return { failed: [], aside: [], asideDir: null }
    return files.restore()
  }

  describe(position: Position | null = this.position): string {
    if (!position) return ''
    if (!position.tick) return 'Now'
    const when = new Date(position.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
    if (position.backup) return `${when}, the backup on ${position.backup.label}`
    return when
  }

  /** For a label: how much changed at a tick. */
  static changedText(tick: Tick, note: boolean): string {
    if (tick.changed === 0) return 'as far back as the history reaches'
    if (note) return 'a version'
    return `${tick.changed} note${tick.changed === 1 ? '' : 's'} or file${tick.changed === 1 ? '' : 's'} changed`
  }
}
