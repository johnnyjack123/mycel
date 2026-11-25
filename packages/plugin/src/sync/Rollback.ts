import type { DataAdapter } from 'obsidian'
import {
  ATTACHMENTS_FIELD,
  CONTENT_FIELD,
  FOLDERS_FIELD,
  INDEX_FIELD,
  docRoom,
  indexRoom,
  type AttachmentEntry,
  type BackupListedEntry,
  type BackupSnapshotRef,
  type ChangedResponse,
  type IndexEntry,
  type LogResponse,
  type VaultFolder
} from '@mycel/shared'
import { bytes, contentHash, fromUtf8, randomBytes, toHex, utf8 } from '@mycel/shared/crypto'
import { ApiError } from '../account/api.js'
import { RoomHistory } from '../history/RoomHistory.js'
import type { AccountSettings, RollbackRecord } from './AccountSettings.js'
import type { AttachmentStore } from './AttachmentStore.js'
import type { DocStore } from './DocStore.js'
import type { RoomCrypto } from './VaultSocket.js'
import { besides } from './renames.js'
import { log } from '../log.js'
import { emptyFolder, makePluginFolder } from '../pluginFolder.js'

// Rolling the vault, or one folder of it, back to a moment (`docs/PHASE6.md`,
// "Rolling back"). Three steps:
//
// 1. The plan: the vault index replayed to that moment says which notes and
//    files there were and where; each note's history says its text then, the
//    index the content each file had. Compared with now, that is a list of
//    notes and files to trash, move back, bring back and change. Where the
//    history no longer reaches, the newest backup at or before that moment on
//    a backup server fills in - by path alone when the index itself is out of
//    reach -, without the person restoring anything by hand.
// 2. Before anything changes: a fresh, checked backup on every backup server
//    of the vault, and a copy of everything about to change or go in the
//    plugin's folder, `rollbacks/<time>/`. A record in the account's settings.
// 3. The plan applied as changes a person could have made - trashing,
//    renaming, restoring from the trash, editing -, so every device follows,
//    and the rollback itself is history that can be rolled back.
//
// Notes and files other people share into the vault are left alone; this
// account's own notes shared with others are rolled back too, for them as
// well, and the plan names them.

/** One note the rollback changes. */
export interface NoteChange {
  /** '' for a note that comes back from a backup as a new one. */
  docId: string
  /** Where it is now; null when it is in the trash. */
  pathNow: string | null
  /** Where it was then; null when it did not exist then, or was in the trash. */
  pathThen: string | null
  /** Its text then, and on the server now. */
  textThen?: string
  textNow?: string
  /** Its text when the vault was locked for the rollback: what was written after that is kept. */
  textBase?: string
  /** Did not exist then: goes to the trash. */
  trash?: true
  /** In the trash now, there then: comes back. */
  revive?: true
  /** Not known to the vault now under any name: comes back from a backup as a new note. */
  create?: true
  move?: true
  text?: true
  /** Its text then comes from the backup, not the history. */
  fromBackup?: true
  /** Shared with other people, now or then. */
  shared: boolean
}

/** One file the rollback changes. */
export interface FileChange {
  /** '' for a file that comes back from a backup as a new one. */
  fileId: string
  pathNow: string | null
  pathThen: string | null
  hashThen?: string
  sizeThen?: number
  trash?: true
  revive?: true
  create?: true
  move?: true
  content?: true
  /** Its content then is read from the backup: the sync server no longer has it. */
  fromBackup?: true
}

/** A note or file whose state then neither the history nor a backup knows. */
export interface OutOfReach {
  kind: 'note' | 'file'
  id: string
  path: string
  reason: string
}

/** The backup a plan takes from, where the history did not reach. */
export interface PlannedBackup {
  routeId: string
  /** The backup server's name. */
  label: string
  ref: BackupSnapshotRef
}

export interface RollbackPlan {
  to: number
  /** '' for the whole vault. */
  folder: string
  notes: NoteChange[]
  files: FileChange[]
  outOfReach: OutOfReach[]
  /** Notes and files others share into the vault, left as they are. */
  foreignKept: number
  backup: PlannedBackup | null
  /**
   * The history did not reach back to the moment at all: everything comes
   * from the backup, matched by path - a note renamed since goes to the trash
   * under its new name and comes back under its old one.
   */
  byPath: boolean
}

/** Neither the vault index's history nor a backup reaches back that far; `reach` is as far as the history goes. */
export class IndexOutOfReach extends Error {
  constructor(readonly reach: number) {
    super(`the history reaches back to ${new Date(reach).toLocaleString()}, not further`)
  }
}

/** The vault's backup servers, as far as a rollback needs them to back up first. */
export interface BackupServers {
  servers(): Array<{ routeId: string; label: string }>
  backUpFresh(routeId: string, options?: { keepAll?: boolean }): Promise<{ ok: boolean; error?: string }>
}

/** And as far as it reads from their backups. */
export interface BackupSource extends BackupServers {
  backupAt(routeId: string, at: number): Promise<BackupSnapshotRef | null>
  backupListing(routeId: string, ref: BackupSnapshotRef): Promise<BackupListedEntry[]>
  backupRead(routeId: string, ref: BackupSnapshotRef, paths: string[], take: (path: string, data: Uint8Array) => Promise<void>): Promise<number>
}

export interface BackupResult {
  label: string
  ok: boolean
  error?: string
}

/** What the person agreed to, beyond the plan itself. */
export interface RollbackConsent {
  /** How the fresh backups went - every one must have, unless `withoutBackup`. */
  backups: BackupResult[]
  withoutBackup?: boolean
  /** Roll back without what neither the history nor a backup reaches; it stays as it is. */
  withoutOutOfReach?: boolean
}

/** Not applied: a backup failed, or part of the plan is out of reach, and the person did not agree to go on anyway. */
export class RollbackRefused extends Error {}

export interface RollbackOutcome {
  record: RollbackRecord
  /** Where the copy of what changed lies, in the plugin's folder. */
  copy: string
  /** What the copy holds, by path, with each content's hash - to find it again in a backup. */
  copied: Array<{ path: string; hash: string }>
  /** What could not be done as planned, and why. */
  problems: string[]
  /** Notes written in after the lock was taken: what was written is kept, merged into the text then. */
  merged: string[]
}

export interface RollbackDeps {
  api: { log(room: string): Promise<LogResponse>; changedRooms(vaultId: string, since: number): Promise<ChangedResponse> }
  /**
   * How far the server's clock, by which it lists the notes that changed, may
   * be from the authors' clocks the rollback goes by; an hour unless set.
   */
  clockMarginMs?: number
  vaultId: string
  indexCrypto: RoomCrypto
  docCrypto: (docId: string) => RoomCrypto
  store: DocStore
  attachments: AttachmentStore | null
  settings: AccountSettings
  /** Where content comes from that the history no longer has; null without a backup server. */
  backups?: BackupSource | null
  /** Where the copy goes: the plugin's folder. */
  adapter: DataAdapter
  root: string
  isExcluded: (path: string) => boolean
  now?: () => number
  /**
   * Locks the vault on the account's other devices while the rollback runs
   * (`docs/TIMEMACHINE.md`, V2): they keep what they write and send it once it
   * is done, and the folder rolled back ('' for the vault) is read-only there.
   * Throws while someone else holds the lock.
   */
  lock?: (folder: string) => Promise<{ release(): Promise<void> }>
  /**
   * The notes and files it is about to move to the trash, by id: in a shared
   * folder that is a delete for everyone, and its notice offers to undo the
   * rollback rather than the delete alone (0.8.16).
   */
  trashing?: (ids: string[]) => void
}

/** What the history planning knew of a note or file it could not reach, for a backup to fill in. */
interface Unreached {
  kind: 'note' | 'file'
  id: string
  pathNow: string | null
  pathThen: string | null
  shared: boolean
  /** A note's text on the server now, when its log could be read. */
  textNow?: string
}

// Notes read at once while planning; each is one request.
const CONCURRENCY = 6
// The server lists changed notes by its own clock, a rollback goes by the
// authors'; a note is read unless the server saw no change for this much longer.
const CLOCK_MARGIN_MS = 60 * 60 * 1000
const COPY_DIR = 'rollbacks'

function inFolder(path: string | null, folder: string): boolean {
  if (path === null) return false
  return folder === '' || path === folder || path.startsWith(`${folder}/`)
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

function two(value: number): string {
  return value.toString().padStart(2, '0')
}

function stamp(when: Date): string {
  return `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())} ${two(when.getHours())}${two(when.getMinutes())}${two(when.getSeconds())}`
}

function buffer(data: Uint8Array): ArrayBuffer {
  return data.slice().buffer
}

function isNote(path: string): boolean {
  return path.endsWith('.md')
}

async function pool<T>(items: T[], task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next] as T
      next += 1
      await task(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
}

const byPath = (a: { pathNow: string | null; pathThen: string | null }, b: { pathNow: string | null; pathThen: string | null }): number =>
  (a.pathThen ?? a.pathNow ?? '').localeCompare(b.pathThen ?? b.pathNow ?? '')

export class Rollback {
  constructor(private readonly deps: RollbackDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private excluded(path: string | null): boolean {
    return path !== null && this.deps.isExcluded(path)
  }

  /** How far back the vault index's history reaches: 0 for all of it. */
  async reach(): Promise<number> {
    return (await RoomHistory.load(this.deps.api, indexRoom(this.deps.vaultId), this.deps.indexCrypto)).reach
  }

  /**
   * What rolling back to `to` changes - the whole vault, or `folder` and
   * whatever was in it then or is now. Reads every note's history it needs,
   * and a backup where that does not reach; `progress` hears how far reading
   * the history got.
   */
  async plan(to: number, folder = '', progress: (done: number, of: number) => void = () => undefined, lockedAt?: number): Promise<RollbackPlan> {
    const index = await RoomHistory.load(this.deps.api, indexRoom(this.deps.vaultId), this.deps.indexCrypto)
    if (!index.reaches(to)) {
      const fromBackup = await this.planFromBackup(to, folder)
      if (fromBackup) return fromBackup
      throw new IndexOutOfReach(index.reach)
    }
    const { plan, unreached } = await this.planFromHistory(to, folder, index, progress, lockedAt)
    if (unreached.size > 0) await this.fillFromBackup(plan, unreached)
    plan.notes.sort(byPath)
    plan.files.sort(byPath)
    plan.outOfReach.sort((a, b) => a.path.localeCompare(b.path))
    return plan
  }

  private async planFromHistory(
    to: number,
    folder: string,
    index: RoomHistory,
    progress: (done: number, of: number) => void,
    lockedAt: number | undefined
  ): Promise<{ plan: RollbackPlan; unreached: Map<string, Unreached> }> {
    const { store, attachments } = this.deps
    const then = index.stateAt(to)
    const notesThen = new Map(then.getMap<IndexEntry>(INDEX_FIELD).entries())
    const filesThen = new Map(then.getMap<AttachmentEntry>(ATTACHMENTS_FIELD).entries())
    // Someone else's folders, then or now: their files are the folder's, as their notes are their owner's.
    const latest = index.latest()
    const foreignFolders = new Set<string>()
    for (const state of [then, latest]) {
      for (const [folderId, record] of state.getMap<VaultFolder>(FOLDERS_FIELD).entries()) if (record.owner) foreignFolders.add(folderId)
    }
    then.destroy()
    latest.destroy()

    const plan: RollbackPlan = { to, folder, notes: [], files: [], outOfReach: [], foreignKept: 0, backup: null, byPath: false }
    const unreached = new Map<string, Unreached>()
    const outOfReach = (item: Unreached, reason: string): void => {
      plan.outOfReach.push({ kind: item.kind, id: item.id, path: (item.pathThen ?? item.pathNow) as string, reason })
      unreached.set(item.id, item)
    }

    // Notes: trashed if they did not exist then; the others need their text then -
    // unless they stayed where they were and the server saw no change of theirs since.
    const notesNow = new Map(store.allEntries().map(({ docId, entry }) => [docId, entry]))
    const changed = await this.changedSince(to - (this.deps.clockMarginMs ?? CLOCK_MARGIN_MS))
    const toRead: NoteChange[] = []
    for (const docId of new Set([...notesThen.keys(), ...notesNow.keys()])) {
      const now = notesNow.get(docId)
      const old = notesThen.get(docId)
      const pathNow = now && !now.deletedAt ? now.path : null
      const pathThen = old && !old.deletedAt ? old.path : null
      if (pathNow === null && pathThen === null) continue
      if (!inFolder(pathNow, folder) && !inFolder(pathThen, folder)) continue
      if (now?.owner || old?.owner || now?.forkedTo) {
        plan.foreignKept += 1
        continue
      }
      if (this.excluded(pathNow) || this.excluded(pathThen)) continue
      const change: NoteChange = { docId, pathNow, pathThen, shared: Boolean(now?.shared || old?.shared) }
      if (pathThen === null) plan.notes.push({ ...change, trash: true })
      else if (now?.purgedAt) outOfReach({ kind: 'note', id: docId, pathNow, pathThen, shared: change.shared }, 'it was deleted longer ago than the history keeps')
      else if (pathNow === pathThen && !changed.has(docRoom(docId))) continue
      else toRead.push(change)
    }
    let read = 0
    progress(read, toRead.length)
    await pool(toRead, async (change) => {
      const item: Unreached = { kind: 'note', id: change.docId, pathNow: change.pathNow, pathThen: change.pathThen, shared: change.shared }
      try {
        const history = await RoomHistory.load(this.deps.api, docRoom(change.docId), this.deps.docCrypto(change.docId))
        const textAt = (ts: number): string => {
          const doc = history.stateAt(ts)
          try {
            return doc.getText(CONTENT_FIELD).toString()
          } finally {
            doc.destroy()
          }
        }
        const textNow = textAt(Number.POSITIVE_INFINITY)
        if (!history.reaches(to)) {
          outOfReach({ ...item, textNow }, 'its history does not reach back that far')
          return
        }
        const textThen = textAt(to)
        if (change.pathNow === null) change.revive = true
        else if (change.pathNow !== change.pathThen) change.move = true
        if (textNow !== textThen) change.text = true
        // By the authors' clocks, as everything here: what came after the lock is kept.
        if (change.text && lockedAt !== undefined) change.textBase = textAt(lockedAt)
        if (change.revive || change.move || change.text) plan.notes.push({ ...change, textThen, textNow })
      } catch (error) {
        const reason = error instanceof ApiError && error.status === 404 ? 'the server has no history of it' : `its history could not be read: ${error instanceof Error ? error.message : String(error)}`
        outOfReach(item, reason)
      } finally {
        read += 1
        progress(read, toRead.length)
      }
    })

    // Files: the index alone says what each was then; its content must still be on the server.
    if (attachments) {
      const filesNow = new Map(attachments.allEntries().map(({ fileId, entry }) => [fileId, entry]))
      const needContent: FileChange[] = []
      for (const fileId of new Set([...filesThen.keys(), ...filesNow.keys()])) {
        const now = filesNow.get(fileId)
        const old = filesThen.get(fileId)
        const pathNow = now && !now.deletedAt ? now.path : null
        const pathThen = old && !old.deletedAt ? old.path : null
        if (pathNow === null && pathThen === null) continue
        if (!inFolder(pathNow, folder) && !inFolder(pathThen, folder)) continue
        // Files that came with a note someone else shares follow that note; those
        // of someone else's folder are rolled back by its owner, for everyone.
        const foreign = (entry: AttachmentEntry | undefined): boolean => Boolean(entry?.via || (entry?.folder && foreignFolders.has(entry.folder.id)))
        if (foreign(now) || foreign(old)) {
          plan.foreignKept += 1
          continue
        }
        if (this.excluded(pathNow) || this.excluded(pathThen)) continue
        const change: FileChange = { fileId, pathNow, pathThen }
        if (!old || pathThen === null) {
          plan.files.push({ ...change, trash: true })
          continue
        }
        change.hashThen = old.hash
        change.sizeThen = old.size
        if (pathNow === null) change.revive = true
        else {
          if (pathNow !== pathThen) change.move = true
          if (now?.hash !== old.hash) change.content = true
        }
        if (!change.revive && !change.move && !change.content) continue
        if (change.revive || change.content) needContent.push(change)
        else plan.files.push(change)
      }
      const missing = new Set(await attachments.missingContents(needContent.map((change) => change.hashThen as string)))
      for (const change of needContent) {
        if (missing.has(change.hashThen as string)) {
          outOfReach({ kind: 'file', id: change.fileId, pathNow: change.pathNow, pathThen: change.pathThen, shared: false }, 'the server no longer has its content then')
        } else {
          plan.files.push(change)
        }
      }
    }
    return { plan, unreached }
  }

  /** The notes the server saw a change of since `since`. */
  private async changedSince(since: number): Promise<Set<string>> {
    const { api, vaultId } = this.deps
    return new Set((await api.changedRooms(vaultId, since)).rooms)
  }

  /** The newest backup at or before `to` over the vault's backup servers; null without one. */
  private async findBackup(to: number): Promise<PlannedBackup | null> {
    const source = this.deps.backups
    let best: PlannedBackup | null = null
    for (const server of source?.servers() ?? []) {
      try {
        const ref = await (source as BackupSource).backupAt(server.routeId, to)
        if (ref && (!best || ref.notes.time > best.ref.notes.time)) best = { routeId: server.routeId, label: server.label, ref }
      } catch (error) {
        log.warn(`asking ${server.label} for a backup to roll back from failed`, error)
      }
    }
    return best
  }

  /** Reads these paths of the backup, text by path. */
  private async readTexts(backup: PlannedBackup, paths: string[]): Promise<Map<string, string>> {
    const texts = new Map<string, string>()
    if (paths.length === 0) return texts
    await (this.deps.backups as BackupSource).backupRead(backup.routeId, backup.ref, paths, async (path, data) => {
      texts.set(path, fromUtf8(data))
    })
    return texts
  }

  /**
   * What the history did not reach, from the newest backup at or before the
   * moment - the state of then as near as a backup knows it. What the backup
   * does not hold either stays out of reach.
   */
  private async fillFromBackup(plan: RollbackPlan, unreached: Map<string, Unreached>): Promise<void> {
    const { store, attachments } = this.deps
    const backup = await this.findBackup(plan.to)
    if (!backup) return
    const listed = new Map((await (this.deps.backups as BackupSource).backupListing(backup.routeId, backup.ref)).map((entry) => [entry.path, entry]))
    const notes = Array.from(unreached.values()).filter((item) => item.kind === 'note' && item.pathThen && listed.has(item.pathThen))
    const texts = await this.readTexts(backup, notes.map((item) => item.pathThen as string))
    const filled = new Set<string>()
    for (const item of notes) {
      const textThen = texts.get(item.pathThen as string)
      if (textThen === undefined) continue
      const textNow = item.textNow ?? (await store.currentText(item.id)) ?? undefined
      const change: NoteChange = { docId: item.id, pathNow: item.pathNow, pathThen: item.pathThen, shared: item.shared, textThen, fromBackup: true }
      if (textNow !== undefined) change.textNow = textNow
      if (item.pathNow === null) change.revive = true
      else if (item.pathNow !== item.pathThen) change.move = true
      if (textNow !== textThen) change.text = true
      filled.add(item.id)
      if (change.revive || change.move || change.text) plan.notes.push(change)
    }
    if (attachments) {
      const files = Array.from(unreached.values()).filter((item) => item.kind === 'file' && item.pathThen && listed.has(item.pathThen))
      const missing = new Set(await attachments.missingContents(files.map((item) => (listed.get(item.pathThen as string) as BackupListedEntry).hash)))
      for (const item of files) {
        const entry = listed.get(item.pathThen as string) as BackupListedEntry
        const now = attachments.entryOf(item.id)
        const change: FileChange = { fileId: item.id, pathNow: item.pathNow, pathThen: item.pathThen, hashThen: entry.hash, sizeThen: entry.size }
        if (missing.has(entry.hash)) change.fromBackup = true
        if (item.pathNow === null) change.revive = true
        else {
          if (item.pathNow !== item.pathThen) change.move = true
          if (now?.hash !== entry.hash) change.content = true
        }
        filled.add(item.id)
        if (change.revive || change.move || change.content) plan.files.push(change)
      }
    }
    if (filled.size === 0) return
    plan.backup = backup
    plan.outOfReach = plan.outOfReach.filter((item) => !filled.has(item.id))
  }

  /**
   * The vault at `to` from a backup alone, by path: the history no longer
   * knows which note was which then. Null without a backup at or before it.
   */
  private async planFromBackup(to: number, folder: string): Promise<RollbackPlan | null> {
    const { store, attachments, settings } = this.deps
    const backup = await this.findBackup(to)
    if (!backup) return null
    const source = this.deps.backups as BackupSource
    const listed = (await source.backupListing(backup.routeId, backup.ref)).filter((entry) => inFolder(entry.path, folder) && !this.excluded(entry.path))
    const plan: RollbackPlan = { to, folder, notes: [], files: [], outOfReach: [], foreignKept: 0, backup, byPath: true }
    const inBackup = new Set(listed.map((entry) => entry.path))
    // A note in the share folder the vault has no own trace of was most likely someone else's: it stays away.
    const shareFolder = settings.get().sharedFolder
    const fromOthers = (path: string): boolean => shareFolder !== '' && inFolder(path, shareFolder)

    // Notes, matched by path.
    const own = new Map<string, { docId: string; entry: IndexEntry }>()
    const foreign = new Set<string>()
    const trashed = new Map<string, { docId: string; entry: IndexEntry }>()
    for (const { docId, entry } of store.allEntries()) {
      if (entry.deletedAt) {
        if (entry.owner || entry.forkedTo) continue
        const newest = trashed.get(entry.path)
        if (!entry.purgedAt && (!newest || (newest.entry.deletedAt ?? 0) < entry.deletedAt)) trashed.set(entry.path, { docId, entry })
      } else if (entry.owner) {
        foreign.add(entry.path)
      } else {
        own.set(entry.path, { docId, entry })
      }
    }
    const toRead: BackupListedEntry[] = []
    for (const entry of listed) {
      if (!isNote(entry.path)) continue
      if (foreign.has(entry.path)) {
        plan.foreignKept += 1
        continue
      }
      const live = own.get(entry.path)
      if (live) {
        const text = await store.currentText(live.docId)
        if (text === null || (await contentHash(utf8(text))) !== entry.hash) toRead.push(entry)
      } else if (trashed.has(entry.path) || !fromOthers(entry.path)) {
        toRead.push(entry)
      } else {
        plan.foreignKept += 1
      }
    }
    const texts = await this.readTexts(backup, toRead.map((entry) => entry.path))
    for (const entry of toRead) {
      const textThen = texts.get(entry.path)
      if (textThen === undefined) {
        plan.outOfReach.push({ kind: 'note', id: entry.path, path: entry.path, reason: 'the backup did not hand it over' })
        continue
      }
      const live = own.get(entry.path)
      const gone = trashed.get(entry.path)
      if (live) {
        const textNow = (await store.currentText(live.docId)) ?? undefined
        const change: NoteChange = { docId: live.docId, pathNow: entry.path, pathThen: entry.path, textThen, text: true, fromBackup: true, shared: Boolean(live.entry.shared) }
        if (textNow !== undefined) change.textNow = textNow
        plan.notes.push(change)
      } else if (gone) {
        plan.notes.push({ docId: gone.docId, pathNow: null, pathThen: entry.path, textThen, revive: true, text: true, fromBackup: true, shared: Boolean(gone.entry.shared) })
      } else {
        plan.notes.push({ docId: '', pathNow: null, pathThen: entry.path, textThen, create: true, fromBackup: true, shared: false })
      }
    }
    for (const [path, { docId, entry }] of own) {
      if (inFolder(path, folder) && !this.excluded(path) && !inBackup.has(path)) {
        plan.notes.push({ docId, pathNow: path, pathThen: null, trash: true, shared: Boolean(entry.shared) })
      }
    }

    // Files, matched by path; content the sync server still has is not read from the backup.
    if (attachments) {
      const ownFiles = new Map<string, { fileId: string; entry: AttachmentEntry }>()
      const theirs = new Set<string>()
      const trashedFiles = new Map<string, { fileId: string; entry: AttachmentEntry }>()
      for (const { fileId, entry } of attachments.allEntries()) {
        if (entry.deletedAt) {
          const newest = trashedFiles.get(entry.path)
          if (!entry.purgedAt && !entry.via && (!newest || (newest.entry.deletedAt ?? 0) < entry.deletedAt)) trashedFiles.set(entry.path, { fileId, entry })
        } else if (entry.via) {
          theirs.add(entry.path)
        } else {
          ownFiles.set(entry.path, { fileId, entry })
        }
      }
      const files = listed.filter((entry) => !isNote(entry.path))
      const missing = new Set(await attachments.missingContents(files.map((entry) => entry.hash)))
      for (const entry of files) {
        if (theirs.has(entry.path)) {
          plan.foreignKept += 1
          continue
        }
        const live = ownFiles.get(entry.path)
        const gone = trashedFiles.get(entry.path)
        const change: FileChange = { fileId: '', pathNow: null, pathThen: entry.path, hashThen: entry.hash, sizeThen: entry.size }
        if (live) {
          if (live.entry.hash === entry.hash) continue
          Object.assign(change, { fileId: live.fileId, pathNow: entry.path, content: true })
        } else if (gone) {
          Object.assign(change, { fileId: gone.fileId, revive: true })
        } else if (!fromOthers(entry.path)) {
          change.create = true
        } else {
          plan.foreignKept += 1
          continue
        }
        // A new file is written from the bytes, so they come from the backup whatever the server has.
        if (missing.has(entry.hash) || change.create) change.fromBackup = true
        plan.files.push(change)
      }
      for (const [path, { fileId }] of ownFiles) {
        if (inFolder(path, folder) && !this.excluded(path) && !inBackup.has(path)) plan.files.push({ fileId, pathNow: path, pathThen: null, trash: true })
      }
    }
    plan.notes.sort(byPath)
    plan.files.sort(byPath)
    return plan
  }

  /** A fresh, checked backup on every backup server of the vault, one after the other - forgetting no snapshot this time. */
  async backUpFirst(backups: BackupServers | null, progress: (message: string) => void = () => undefined): Promise<BackupResult[]> {
    const results: BackupResult[] = []
    for (const server of backups?.servers() ?? []) {
      progress(`Backing up on ${server.label}…`)
      // A rollback may read from an older backup next; this run's retention must not let it go.
      const outcome = await (backups as BackupServers).backUpFresh(server.routeId, { keepAll: true })
      results.push({ label: server.label, ...outcome })
    }
    return results
  }

  /** Why a plan must not be applied, or null. */
  static refusal(plan: RollbackPlan, consent: RollbackConsent): string | null {
    const failed = consent.backups.filter((backup) => !backup.ok)
    if (failed.length > 0 && !consent.withoutBackup) {
      return `the backup on ${failed.map((backup) => `${backup.label} (${backup.error ?? 'failed'})`).join(', ')} did not go through`
    }
    if (plan.outOfReach.length > 0 && !consent.withoutOutOfReach) return `${plan.outOfReach.length} note(s) or file(s) are out of reach`
    return null
  }

  /**
   * Copies everything the plan is about to change or trash, as this device
   * has it now, into the plugin's folder, with the plan beside it.
   */
  async copy(plan: RollbackPlan, when: number): Promise<{ dir: string; copied: Array<{ path: string; hash: string }> }> {
    const { adapter, store, attachments } = this.deps
    const dir = `${this.deps.root}/${COPY_DIR}/${stamp(new Date(when))}`
    const copied: Array<{ path: string; hash: string }> = []
    const made = new Set<string>()
    const ensure = (path: string): Promise<void> => makePluginFolder(adapter, this.deps.root, path, made)
    const into = (path: string): string => `${dir}/${path}`
    for (const note of plan.notes) {
      if (!(note.trash || note.text) || note.pathNow === null || !note.docId) continue
      const text = (await store.currentText(note.docId)) ?? note.textNow
      if (text === undefined) continue
      await ensure(parentOf(into(note.pathNow)))
      await adapter.write(into(note.pathNow), text)
      copied.push({ path: note.pathNow, hash: await contentHash(utf8(text)) })
    }
    for (const file of plan.files) {
      if (!(file.trash || file.content) || file.pathNow === null || !file.fileId || !attachments) continue
      const data = await attachments.currentBytes(file.fileId)
      if (!data) continue
      await ensure(parentOf(into(file.pathNow)))
      await adapter.writeBinary(into(file.pathNow), buffer(data))
      copied.push({ path: file.pathNow, hash: await contentHash(bytes(data)) })
    }
    await ensure(dir)
    const summary = {
      to: new Date(plan.to).toISOString(),
      folder: plan.folder,
      backup: plan.backup ? { label: plan.backup.label, time: new Date(plan.backup.ref.notes.time).toISOString(), byPath: plan.byPath } : null,
      notes: plan.notes.map(({ docId, pathNow, pathThen, trash, revive, create, move, text, fromBackup }) => ({ docId, pathNow, pathThen, trash, revive, create, move, text, fromBackup })),
      files: plan.files.map(({ fileId, pathNow, pathThen, trash, revive, create, move, content, fromBackup }) => ({
        fileId,
        pathNow,
        pathThen,
        trash,
        revive,
        create,
        move,
        content,
        fromBackup
      })),
      outOfReach: plan.outOfReach
    }
    await adapter.write(`${dir}/rollback.json`, `${JSON.stringify(summary, null, 2)}\n`)
    return { dir, copied }
  }

  /**
   * Whether every file of a rollback's copy lies in the backup made just before
   * it, with the same content (`docs/TIMEMACHINE.md`, V4): then the copy in the
   * plugin folder goes. Not there - no backup server, or something this device
   * had not sent yet - it stays, for *Keep backups for*.
   */
  async copyIsBackedUp(outcome: RollbackOutcome): Promise<boolean> {
    const source = this.deps.backups
    if (!source || outcome.copied.length === 0) return false
    for (const server of source.servers()) {
      try {
        const ref = await source.backupAt(server.routeId, this.now)
        if (!ref) continue
        const listed = new Map((await source.backupListing(server.routeId, ref)).map((entry) => [entry.path, entry.hash]))
        if (!outcome.copied.every((item) => listed.get(item.path) === item.hash)) continue
        // File by file: removed whole, a read-only folder failed after its files were gone, and the copy was said to be on this device alone (0.9.28).
        const emptied = await emptyFolder(this.deps.adapter, outcome.copy, true)
        if (emptied.failed > 0) {
          log.warn(`the rollback's copy matched the backup on ${server.label}, but ${emptied.failed} file(s) of it would not go`, emptied.error)
          return false
        }
        log.info(`the rollback's copy matched the backup on ${server.label}; removed it from the plugin folder`)
        return true
      } catch (error) {
        log.warn(`comparing the rollback's copy with the backup on ${server.label} failed`, error)
      }
    }
    return false
  }

  /**
   * Applies a plan: the copy and the record first, then trashing, moving,
   * bringing back and changing. What fails on its own - one note the server
   * did not send - is reported and the rest goes on; the record says whether
   * it all went.
   */
  async apply(plan: RollbackPlan, consent: RollbackConsent, progress: (message: string) => void = () => undefined): Promise<RollbackOutcome> {
    const refused = Rollback.refusal(plan, consent)
    if (refused) throw new RollbackRefused(refused)
    progress('Locking the vault on your other devices…')
    const lock = await this.deps.lock?.(plan.folder)
    try {
      return await this.applyLocked(plan, progress)
    } finally {
      await lock?.release()
    }
  }

  private async applyLocked(plan: RollbackPlan, progress: (message: string) => void): Promise<RollbackOutcome> {
    const { store, attachments, settings } = this.deps
    const startedAt = this.now
    progress('Copying what changes into the plugin folder…')
    const { dir: copy, copied } = await this.copy(plan, startedAt)
    const record: RollbackRecord = {
      id: toHex(randomBytes(8)),
      startedAt,
      to: plan.to,
      folder: plan.folder,
      state: 'running',
      notes: plan.notes.length,
      files: plan.files.length
    }
    settings.setRollback(record)
    log.info(
      `rolling ${plan.folder || 'the vault'} back to ${new Date(plan.to).toISOString()}: ${plan.notes.length} notes, ${plan.files.length} files${
        plan.backup ? `, ${plan.byPath ? 'all' : 'some'} from the backup of ${new Date(plan.backup.ref.notes.time).toISOString()}` : ''
      }`
    )
    const problems: string[] = []
    const attempt = async (what: string, task: () => Promise<unknown>): Promise<void> => {
      try {
        await task()
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        problems.push(`${what}: ${reason}`)
        log.error(`rollback: ${what} failed`, error)
      }
    }

    // What did not exist then goes first: it frees the paths the rest comes back to.
    progress('Moving what came later to the trash…')
    this.deps.trashing?.([...plan.notes.filter((note) => note.trash).map((note) => note.docId), ...plan.files.filter((file) => file.trash).map((file) => file.fileId)])
    for (const note of plan.notes) if (note.trash) await attempt(note.pathNow ?? note.docId, () => store.trashNote(note.docId))
    if (attachments) for (const file of plan.files) if (file.trash) await attempt(file.pathNow ?? file.fileId, () => attachments.trashFile(file.fileId))

    progress('Moving notes and files back…')
    const moves: Move[] = [
      ...plan.notes.filter((note) => note.move).map((note) => ({ kind: 'note' as const, id: note.docId, at: note.pathNow as string, to: note.pathThen as string })),
      ...plan.files.filter((file) => file.move).map((file) => ({ kind: 'file' as const, id: file.fileId, at: file.pathNow as string, to: file.pathThen as string }))
    ]
    problems.push(...(await this.moveAll(moves)))

    // Content only a backup still has: on the sync server first (invariant 23), a new file straight into the vault.
    const unready = new Set<string>()
    if (attachments && plan.backup && plan.files.some((file) => file.fromBackup)) {
      progress(`Reading files from the backup on ${plan.backup.label}…`)
      const wanted = new Map(plan.files.filter((file) => file.fromBackup).map((file) => [file.pathThen as string, file]))
      const arrived = new Set<string>()
      await attempt(`reading from the backup on ${plan.backup.label}`, () =>
        (this.deps.backups as BackupSource).backupRead(plan.backup!.routeId, plan.backup!.ref, Array.from(wanted.keys()), async (path, data) => {
          const file = wanted.get(path)
          if (!file) return
          arrived.add(path)
          await attempt(path, async () => {
            if (file.create) {
              const at = await attachments.createFile(path, bytes(data), file.hashThen as string)
              if (at !== path) problems.push(`${path}: came back as ${at}, the place was taken`)
            } else {
              await attachments.uploadContent(bytes(data), file.hashThen as string)
            }
          })
        })
      )
      for (const path of wanted.keys()) if (!arrived.has(path)) unready.add(path)
      for (const path of unready) problems.push(`${path}: the backup did not hand it over`)
    }

    progress('Bringing back what was deleted since…')
    for (const note of plan.notes) {
      if (note.revive) {
        await attempt(note.pathThen as string, async () => {
          const at = await store.reviveNote(note.docId, note.pathThen as string)
          if (at && at !== note.pathThen) problems.push(`${note.pathThen}: came back as ${at}, the place was taken`)
        })
      } else if (note.create) {
        await attempt(note.pathThen as string, async () => {
          const at = await store.createNote(note.pathThen as string, note.textThen as string)
          if (at !== note.pathThen) problems.push(`${note.pathThen}: came back as ${at}, the place was taken`)
        })
      }
    }
    if (attachments) {
      for (const file of plan.files) {
        if (!file.revive || unready.has(file.pathThen as string)) continue
        await attempt(file.pathThen as string, async () => {
          const at = await attachments.reviveFile(file.fileId, file.pathThen as string, file.hashThen as string, file.sizeThen as number)
          if (at && at !== file.pathThen) problems.push(`${file.pathThen}: came back as ${at}, the place was taken`)
        })
      }
    }

    progress('Changing notes and files back…')
    let done = 0
    const merged: string[] = []
    const changes = plan.notes.filter((note) => note.text && note.docId).length + plan.files.filter((file) => file.content).length
    for (const note of plan.notes) {
      if (!note.text || !note.docId) continue
      await attempt(note.pathThen ?? note.docId, async () => {
        if ((await store.rollBackText(note.docId, note.textThen as string, note.textBase)) === 'merged') merged.push(note.pathThen ?? note.docId)
      })
      done += 1
      progress(`Changing notes and files back… ${done} of ${changes}`)
    }
    if (attachments) {
      for (const file of plan.files) {
        if (!file.content || unready.has(file.pathThen as string)) continue
        await attempt(file.pathThen ?? file.fileId, () => attachments.setFileContent(file.fileId, file.hashThen as string, file.sizeThen as number))
        done += 1
        progress(`Changing notes and files back… ${done} of ${changes}`)
      }
    }

    const finished: RollbackRecord = { ...record, state: problems.length === 0 ? 'done' : 'failed', finishedAt: this.now }
    if (problems.length > 0) finished.error = `${problems.length} problem(s), e.g. ${problems[0]}`
    settings.setRollback(finished)
    log.info(
      `rollback ${record.id}: ${finished.state}${problems.length > 0 ? `, ${problems.length} problem(s)` : ''}${merged.length > 0 ? `, ${merged.length} note(s) written in since the lock merged` : ''}`
    )
    return { record: finished, copy, copied, problems, merged }
  }

  /**
   * Moves notes and files back to where they were. One whose place is held
   * by another that moves too waits for it; two that swapped places go via a
   * free name. One whose place is held by something that stays, stays.
   */
  private async moveAll(moves: Move[]): Promise<string[]> {
    const { store, attachments } = this.deps
    const problems: string[] = []
    const pending = moves.slice()
    const holder = (path: string): Move | undefined => pending.find((move) => move.at === path)
    // By a note, a file, or anything else in the vault - a file sync leaves alone.
    const taken = (path: string): boolean => Boolean(store.docIdForPath(path) || attachments?.fileAt(path) || store.pathTaken(path))
    const move = async (item: Move, path: string): Promise<void> => {
      if (item.kind === 'note') await store.moveNote(item.id, path)
      else await attachments?.moveFile(item.id, path)
      item.at = path
    }
    for (let round = 0; pending.length > 0 && round < moves.length * 3 + 3; round += 1) {
      let moved = false
      for (const item of pending.slice()) {
        if (taken(item.to)) continue
        try {
          await move(item, item.to)
        } catch (error) {
          problems.push(`${item.at}: could not move back to ${item.to}: ${error instanceof Error ? error.message : String(error)}`)
        }
        pending.splice(pending.indexOf(item), 1)
        moved = true
      }
      if (moved) continue
      // Every one left waits for a place: one held by another that moves goes aside first.
      const blocked = pending.find((item) => holder(item.to))
      if (!blocked) break
      const occupant = holder(blocked.to) as Move
      let aside = ''
      for (let n = 1; !aside || taken(aside); n += 1) aside = besides(occupant.at, 'rolling back', n)
      try {
        await move(occupant, aside)
      } catch (error) {
        problems.push(`${occupant.at}: could not move aside: ${error instanceof Error ? error.message : String(error)}`)
        pending.splice(pending.indexOf(occupant), 1)
      }
    }
    for (const item of pending) problems.push(`${item.at}: stays where it is, ${item.to} is taken`)
    return problems
  }
}

/** Copies of rollbacks older than `retentionDays` go, as merge backups do - file by file, a read-only folder left (`emptyFolder`). */
export async function pruneRollbackCopies(adapter: DataAdapter, root: string, retentionDays: number, now = Date.now()): Promise<number> {
  if (retentionDays <= 0) return 0
  const base = `${root}/${COPY_DIR}`
  if (!(await adapter.exists(base))) return 0
  const cutoff = stamp(new Date(now - retentionDays * 24 * 60 * 60 * 1000))
  let removed = 0
  let folders = true
  for (const dir of (await adapter.list(base)).folders) {
    const name = dir.split('/').pop() ?? ''
    if (!/^\d{4}-\d{2}-\d{2} \d{6}$/.test(name) || name >= cutoff) continue
    try {
      const emptied = await emptyFolder(adapter, dir, folders)
      if (emptied.refused) folders = false
      if (emptied.failed === 0) removed += 1
      else log.warn(`removing the rollback copy ${dir} failed for ${emptied.failed} file(s)`, emptied.error)
    } catch (error) {
      log.warn(`removing the rollback copy ${dir} failed`, error)
    }
  }
  return removed
}

interface Move {
  kind: 'note' | 'file'
  id: string
  /** Where it is now; changes as it moves. */
  at: string
  to: string
}

/** `stem (label)ext`, or `stem (label n)ext` from the second on. */
