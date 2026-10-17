import type { DataAdapter } from 'obsidian'
import {
  ATTACHMENTS_FIELD,
  CONTENT_FIELD,
  INDEX_FIELD,
  docRoom,
  indexRoom,
  type AttachmentEntry,
  type IndexEntry,
  type LogResponse
} from '@obsidian-connect/shared'
import { randomBytes, toHex } from '@obsidian-connect/shared/crypto'
import { ApiError } from '../account/api.js'
import { RoomHistory } from '../history/RoomHistory.js'
import type { AccountSettings, RollbackRecord } from './AccountSettings.js'
import type { AttachmentStore } from './AttachmentStore.js'
import type { DocStore } from './DocStore.js'
import type { RoomCrypto } from './VaultSocket.js'
import { log } from '../log.js'

// Rolling the vault, or one folder of it, back to a moment - from the history
// the server keeps (`docs/PHASE6.md`, "Rolling back"). Three steps:
//
// 1. The plan: the vault index replayed to that moment says which notes and
//    files there were and where; each note's history says its text then, the
//    index the content each file had. Compared with now, that is a list of
//    notes and files to trash, move back, bring back and change.
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
  docId: string
  /** Where it is now; null when it is in the trash. */
  pathNow: string | null
  /** Where it was then; null when it did not exist then, or was in the trash. */
  pathThen: string | null
  /** Its text then, and on the server now. */
  textThen?: string
  textNow?: string
  /** Did not exist then: goes to the trash. */
  trash?: true
  /** In the trash now, there then: comes back. */
  revive?: true
  move?: true
  text?: true
  /** Shared with other people, now or then. */
  shared: boolean
}

/** One file the rollback changes. */
export interface FileChange {
  fileId: string
  pathNow: string | null
  pathThen: string | null
  hashThen?: string
  sizeThen?: number
  trash?: true
  revive?: true
  move?: true
  content?: true
}

/** A note or file whose state then the history no longer knows. */
export interface OutOfReach {
  kind: 'note' | 'file'
  id: string
  path: string
  reason: string
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
}

/** The history does not reach back that far for the vault index; `reach` is as far as it goes. */
export class IndexOutOfReach extends Error {
  constructor(readonly reach: number) {
    super(`the history reaches back to ${new Date(reach).toLocaleString()}, not further`)
  }
}

/** The vault's backup servers, as far as a rollback needs them. */
export interface BackupServers {
  servers(): Array<{ routeId: string; label: string }>
  backUpFresh(routeId: string): Promise<{ ok: boolean; error?: string }>
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
  /** Roll back without what the history no longer reaches; it stays as it is. */
  withoutOutOfReach?: boolean
}

/** Not applied: a backup failed, or part of the plan is out of reach, and the person did not agree to go on anyway. */
export class RollbackRefused extends Error {}

export interface RollbackOutcome {
  record: RollbackRecord
  /** Where the copy of what changed lies, in the plugin's folder. */
  copy: string
  /** What could not be done as planned, and why. */
  problems: string[]
}

export interface RollbackDeps {
  api: { log(room: string): Promise<LogResponse> }
  vaultId: string
  indexCrypto: RoomCrypto
  docCrypto: (docId: string) => RoomCrypto
  store: DocStore
  attachments: AttachmentStore | null
  settings: AccountSettings
  /** Where the copy goes: the plugin's folder. */
  adapter: DataAdapter
  root: string
  isExcluded: (path: string) => boolean
  now?: () => number
}

// Notes read at once while planning; each is one request.
const CONCURRENCY = 6
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

export class Rollback {
  constructor(private readonly deps: RollbackDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** How far back the vault index's history reaches: 0 for all of it. */
  async reach(): Promise<number> {
    return (await RoomHistory.load(this.deps.api, indexRoom(this.deps.vaultId), this.deps.indexCrypto)).reach
  }

  /**
   * What rolling back to `to` changes - the whole vault, or `folder` and
   * whatever was in it then or is now. Reads every note's history it needs;
   * `progress` hears how far that got.
   */
  async plan(to: number, folder = '', progress: (done: number, of: number) => void = () => undefined): Promise<RollbackPlan> {
    const { store, attachments } = this.deps
    const index = await RoomHistory.load(this.deps.api, indexRoom(this.deps.vaultId), this.deps.indexCrypto)
    if (!index.reaches(to)) throw new IndexOutOfReach(index.reach)
    const then = index.stateAt(to)
    const notesThen = new Map(then.getMap<IndexEntry>(INDEX_FIELD).entries())
    const filesThen = new Map(then.getMap<AttachmentEntry>(ATTACHMENTS_FIELD).entries())
    then.destroy()

    const plan: RollbackPlan = { to, folder, notes: [], files: [], outOfReach: [], foreignKept: 0 }
    const excluded = (path: string | null): boolean => path !== null && this.deps.isExcluded(path)

    // Notes: trashed if they did not exist then; the others need their text then.
    const notesNow = new Map(store.allEntries().map(({ docId, entry }) => [docId, entry]))
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
      if (excluded(pathNow) || excluded(pathThen)) continue
      const change: NoteChange = { docId, pathNow, pathThen, shared: Boolean(now?.shared || old?.shared) }
      if (pathThen === null) plan.notes.push({ ...change, trash: true })
      else if (now?.purgedAt) plan.outOfReach.push({ kind: 'note', id: docId, path: pathThen, reason: 'it was deleted longer ago than the history keeps' })
      else toRead.push(change)
    }
    let read = 0
    progress(read, toRead.length)
    await pool(toRead, async (change) => {
      const path = (change.pathThen ?? change.pathNow) as string
      try {
        const history = await RoomHistory.load(this.deps.api, docRoom(change.docId), this.deps.docCrypto(change.docId))
        if (!history.reaches(to)) {
          plan.outOfReach.push({ kind: 'note', id: change.docId, path, reason: 'its history does not reach back that far' })
          return
        }
        const textAt = (ts: number): string => {
          const doc = history.stateAt(ts)
          try {
            return doc.getText(CONTENT_FIELD).toString()
          } finally {
            doc.destroy()
          }
        }
        const textThen = textAt(to)
        const textNow = textAt(Number.POSITIVE_INFINITY)
        if (change.pathNow === null) change.revive = true
        else {
          if (change.pathNow !== change.pathThen) change.move = true
          if (textNow !== textThen) change.text = true
        }
        if (change.revive && textNow !== textThen) change.text = true
        if (change.revive || change.move || change.text) plan.notes.push({ ...change, textThen, textNow })
      } catch (error) {
        const reason = error instanceof ApiError && error.status === 404 ? 'the server has no history of it' : `its history could not be read: ${error instanceof Error ? error.message : String(error)}`
        plan.outOfReach.push({ kind: 'note', id: change.docId, path, reason })
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
        // Files that came with a note someone else shares follow that note.
        if (now?.via || old?.via) {
          plan.foreignKept += 1
          continue
        }
        if (excluded(pathNow) || excluded(pathThen)) continue
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
          plan.outOfReach.push({ kind: 'file', id: change.fileId, path: (change.pathThen ?? change.pathNow) as string, reason: 'the server no longer has its content then' })
        } else {
          plan.files.push(change)
        }
      }
    }

    const byPath = (a: { pathNow: string | null; pathThen: string | null }, b: { pathNow: string | null; pathThen: string | null }): number =>
      (a.pathThen ?? a.pathNow ?? '').localeCompare(b.pathThen ?? b.pathNow ?? '')
    plan.notes.sort(byPath)
    plan.files.sort(byPath)
    plan.outOfReach.sort((a, b) => a.path.localeCompare(b.path))
    return plan
  }

  /** A fresh, checked backup on every backup server of the vault, one after the other. */
  async backUpFirst(backups: BackupServers | null, progress: (message: string) => void = () => undefined): Promise<BackupResult[]> {
    const results: BackupResult[] = []
    for (const server of backups?.servers() ?? []) {
      progress(`Backing up on ${server.label}…`)
      const outcome = await (backups as BackupServers).backUpFresh(server.routeId)
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
    if (plan.outOfReach.length > 0 && !consent.withoutOutOfReach) return `${plan.outOfReach.length} note(s) or file(s) are out of the history's reach`
    return null
  }

  /**
   * Copies everything the plan is about to change or trash, as this device
   * has it now, into the plugin's folder, with the plan beside it.
   */
  async copy(plan: RollbackPlan, when: number): Promise<string> {
    const { adapter, store, attachments } = this.deps
    const dir = `${this.deps.root}/${COPY_DIR}/${stamp(new Date(when))}`
    const made = new Set<string>()
    const ensure = async (path: string): Promise<void> => {
      if (!path || made.has(path)) return
      await ensure(parentOf(path))
      made.add(path)
      if (!(await adapter.exists(path))) await adapter.mkdir(path)
    }
    const into = (path: string): string => `${dir}/${path}`
    for (const note of plan.notes) {
      if (!(note.trash || note.text) || note.pathNow === null) continue
      const text = (await store.currentText(note.docId)) ?? note.textNow
      if (text === undefined) continue
      await ensure(parentOf(into(note.pathNow)))
      await adapter.write(into(note.pathNow), text)
    }
    for (const file of plan.files) {
      if (!(file.trash || file.content) || file.pathNow === null || !attachments) continue
      const data = await attachments.currentBytes(file.fileId)
      if (!data) continue
      await ensure(parentOf(into(file.pathNow)))
      await adapter.writeBinary(into(file.pathNow), buffer(data))
    }
    await ensure(dir)
    const summary = {
      to: new Date(plan.to).toISOString(),
      folder: plan.folder,
      notes: plan.notes.map(({ docId, pathNow, pathThen, trash, revive, move, text }) => ({ docId, pathNow, pathThen, trash, revive, move, text })),
      files: plan.files.map(({ fileId, pathNow, pathThen, trash, revive, move, content }) => ({ fileId, pathNow, pathThen, trash, revive, move, content })),
      outOfReach: plan.outOfReach
    }
    await adapter.write(`${dir}/rollback.json`, `${JSON.stringify(summary, null, 2)}\n`)
    return dir
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
    const { store, attachments, settings } = this.deps
    const startedAt = this.now
    progress('Copying what changes into the plugin folder…')
    const copy = await this.copy(plan, startedAt)
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
    log.info(`rolling ${plan.folder || 'the vault'} back to ${new Date(plan.to).toISOString()}: ${plan.notes.length} notes, ${plan.files.length} files`)
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
    for (const note of plan.notes) if (note.trash) await attempt(note.pathNow ?? note.docId, () => store.trashNote(note.docId))
    if (attachments) for (const file of plan.files) if (file.trash) await attempt(file.pathNow ?? file.fileId, () => attachments.trashFile(file.fileId))

    progress('Moving notes and files back…')
    const moves: Move[] = [
      ...plan.notes.filter((note) => note.move).map((note) => ({ kind: 'note' as const, id: note.docId, at: note.pathNow as string, to: note.pathThen as string })),
      ...plan.files.filter((file) => file.move).map((file) => ({ kind: 'file' as const, id: file.fileId, at: file.pathNow as string, to: file.pathThen as string }))
    ]
    problems.push(...(await this.moveAll(moves)))

    progress('Bringing back what was deleted since…')
    for (const note of plan.notes) {
      if (!note.revive) continue
      await attempt(note.pathThen as string, async () => {
        const at = await store.reviveNote(note.docId, note.pathThen as string)
        if (at && at !== note.pathThen) problems.push(`${note.pathThen}: came back as ${at}, the place was taken`)
      })
    }
    if (attachments) {
      for (const file of plan.files) {
        if (!file.revive) continue
        await attempt(file.pathThen as string, async () => {
          const at = await attachments.reviveFile(file.fileId, file.pathThen as string, file.hashThen as string, file.sizeThen as number)
          if (at && at !== file.pathThen) problems.push(`${file.pathThen}: came back as ${at}, the place was taken`)
        })
      }
    }

    progress('Changing notes and files back…')
    let done = 0
    const changes = plan.notes.filter((note) => note.text).length + plan.files.filter((file) => file.content).length
    for (const note of plan.notes) {
      if (!note.text) continue
      await attempt(note.pathThen ?? note.docId, () => store.rollBackText(note.docId, note.textThen as string))
      done += 1
      progress(`Changing notes and files back… ${done} of ${changes}`)
    }
    if (attachments) {
      for (const file of plan.files) {
        if (!file.content) continue
        await attempt(file.pathThen ?? file.fileId, () => attachments.setFileContent(file.fileId, file.hashThen as string, file.sizeThen as number))
        done += 1
        progress(`Changing notes and files back… ${done} of ${changes}`)
      }
    }

    const finished: RollbackRecord = { ...record, state: problems.length === 0 ? 'done' : 'failed', finishedAt: this.now }
    if (problems.length > 0) finished.error = `${problems.length} problem(s), e.g. ${problems[0]}`
    settings.setRollback(finished)
    log.info(`rollback ${record.id}: ${finished.state}${problems.length > 0 ? `, ${problems.length} problem(s)` : ''}`)
    return { record: finished, copy, problems }
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

/** Copies of rollbacks older than `retentionDays` go, as merge backups do. */
export async function pruneRollbackCopies(adapter: DataAdapter, root: string, retentionDays: number, now = Date.now()): Promise<number> {
  if (retentionDays <= 0) return 0
  const base = `${root}/${COPY_DIR}`
  if (!(await adapter.exists(base))) return 0
  const cutoff = stamp(new Date(now - retentionDays * 24 * 60 * 60 * 1000))
  let removed = 0
  for (const dir of (await adapter.list(base)).folders) {
    const name = dir.split('/').pop() ?? ''
    if (!/^\d{4}-\d{2}-\d{2} \d{6}$/.test(name) || name >= cutoff) continue
    try {
      await adapter.rmdir(dir, true)
      removed += 1
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
function besides(path: string, label: string, n: number): string {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  const cut = dot > slash ? dot : path.length
  return `${path.slice(0, cut)} (${label}${n > 1 ? ` ${n}` : ''})${path.slice(cut)}`
}
