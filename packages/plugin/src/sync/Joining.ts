import { TFile, type App } from 'obsidian'
import { contentHash } from '@mycel/shared/crypto'
import type { AttachmentEntry } from '@mycel/shared'
import type { AttachmentIndex } from './AttachmentIndex.js'
import type { AttachmentStore } from './AttachmentStore.js'
import type { BackupStore } from './BackupStore.js'
import type { DocStore } from './DocStore.js'
import type { JoinRecord, StateStore } from './StateStore.js'
import type { VaultIndex } from './VaultIndex.js'
import { log } from '../log.js'

// A device meeting a vault on the server for the first time - a new device, another
// server, another vault name - agreed on nothing with it: no base for a note, no hash for
// a file. Merging can then only keep both sides (invariant 3): safe, and often a mess - an
// older copy of the vault brings back every line and every note deleted since. So before
// anything of the vault is touched, the two are compared path by path, and the person
// chooses (invariant 34): merge both, or take the server's state - after a copy of every
// file of this vault in the plugin's folder, whatever is chosen.

/** What the comparison makes of the two; the window words its options by it. */
export type JoinKind =
  /** Neither has anything: nothing to ask. */
  | 'empty'
  /** The vault on the server is empty: this one goes up. */
  | 'upload'
  /** This vault is empty: everything comes down. */
  | 'download'
  /** Everything this vault has, the server has alike. */
  | 'same'
  /** The same vault in another state, most likely. */
  | 'related'
  /** Hardly a path in common: another vault, or one Obsidian has just made. */
  | 'unrelated'

export type JoinChoice = 'merge' | 'server' | 'later'
export type JoinStage = 'compare' | 'backup' | 'apply'

/** Paths of notes or of files, by how the two sides hold them. */
export interface JoinSide {
  same: string[]
  different: string[]
  /** On both, but the server's copy could not be had in time: not compared. */
  unknown: string[]
  onlyHere: string[]
  onlyThere: string[]
}

export interface JoinPlan {
  kind: JoinKind
  notes: JoinSide
  files: JoinSide
  /** What the copy made first holds: every file of this vault. */
  backup: { files: number; bytes: number }
}

export type JoinResult =
  | {
      ok: true
      choice: 'merge' | 'server'
      /** The folder the copy of the vault went to; null for a vault that had nothing. */
      backup: string | null
      /** Notes and files that took the server's version. */
      taken: number
      /** Notes and files only this vault had, moved to the trash. */
      trashed: number
      /** Notes and files the server's version could not be had for: merged, as ever. */
      notTaken: string[]
      /** Carried on after the device stopped while carrying it out. */
      resumed: boolean
    }
  | { ok: false; problem: string }

/** The person, as far as joining goes: the plugin's window, or a test. */
export interface JoinHost {
  /** Called often while comparing, copying, carrying out. */
  progress(stage: JoinStage, done: number, total: number): void
  ask(plan: JoinPlan): Promise<JoinChoice>
  finished(result: JoinResult): void
}

export interface JoiningParts {
  app: App
  vaultId: string
  index: VaultIndex
  attachmentIndex: AttachmentIndex
  store: DocStore
  attachments: AttachmentStore
  state: StateStore
  backups: BackupStore
  host: JoinHost
  /** The delete event of a file this moves to the trash is no delete made here. */
  leaving(path: string): void
}

const CONCURRENCY = 8
/** Fewer paths in common than this share of the smaller side: another vault, most likely. */
const UNRELATED_SHARE = 0.1
/** How many paths a result names that could not be taken; the log has them all. */
const NAMED_MAX = 50

function side(): JoinSide {
  return { same: [], different: [], unknown: [], onlyHere: [], onlyThere: [] }
}

async function pool<T>(items: T[], stopped: () => boolean, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (!stopped() && next < items.length) {
      const item = items[next] as T
      next += 1
      await task(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class Joining {
  private postponed = false
  private stopped = false

  constructor(private readonly parts: JoiningParts) {}

  /** The person chose "Not now", or the copy failed: nothing is touched until asked again. */
  get waiting(): boolean {
    return this.postponed
  }

  /** Asked again - the command, the notice's button. */
  again(): void {
    this.postponed = false
  }

  stop(): void {
    this.stopped = true
  }

  /**
   * Whether the store may start. A device that met this vault before goes on; one new to it
   * compares, asks and carries out the choice first. False: nothing of the vault was touched.
   */
  async decide(): Promise<boolean> {
    const { state, vaultId } = this.parts
    const record = state.joinOf(vaultId)
    if (record?.done) return true
    if (record) return this.carryOn(record)
    // Synced before there was a record: every note and file it agreed on is its base.
    if (this.knownBefore()) {
      await state.setJoin(vaultId, { at: Date.now(), choice: 'before', done: true })
      log.info('this device synced the vault before: no comparison')
      return true
    }
    if (this.postponed) return false
    const plan = await this.compare()
    if (this.stopped) return false
    log.info(`compared with the server: ${plan.kind}; notes ${this.counts(plan.notes)}; files ${this.counts(plan.files)}`)
    if (plan.kind === 'empty') {
      await state.setJoin(vaultId, { at: Date.now(), choice: 'merge', done: true })
      return true
    }
    const choice = await this.parts.host.ask(plan)
    if (this.stopped) return false
    if (choice === 'later') {
      log.info('joining the vault: not now')
      this.postponed = true
      return false
    }
    let backup: string | null = null
    if (plan.backup.files > 0) {
      try {
        backup = await this.copyVault()
      } catch (error) {
        log.error('copying the vault before joining failed; nothing was changed', error)
        this.postponed = true
        this.parts.host.finished({ ok: false, problem: `The copy of this vault could not be made: ${message(error)}` })
        return false
      }
      if (this.stopped) return false
      log.info(`the vault copied to ${backup} before joining`)
    }
    const started: JoinRecord = { at: Date.now(), choice, done: false, ...(backup ? { backup } : {}) }
    await state.setJoin(vaultId, started)
    return this.apply(started, plan, false)
  }

  /** The device stopped while carrying out a choice: the rest of it, without asking again. */
  private async carryOn(record: JoinRecord): Promise<boolean> {
    log.info(`carrying on joining the vault (${record.choice}) where the device stopped`)
    const plan = await this.compare()
    if (this.stopped) return false
    return this.apply(record, plan, true)
  }

  private async apply(record: JoinRecord, plan: JoinPlan, resumed: boolean): Promise<boolean> {
    const { state, vaultId, host } = this.parts
    let taken = 0
    let trashed = 0
    const notTaken: string[] = []
    if (record.choice === 'server') {
      const outcome = await this.takeServers(plan)
      if (this.stopped) return false
      ;({ taken, trashed } = outcome)
      notTaken.push(...outcome.notTaken)
    }
    await state.setJoin(vaultId, { ...record, done: true })
    if (notTaken.length > 0) log.warn(`joining: the server's version could not be had for ${notTaken.length}, merged instead: ${notTaken.join(', ')}`)
    log.info(`joined the vault: ${record.choice}, ${taken} taken from the server, ${trashed} to the trash`)
    host.finished({
      ok: true,
      choice: record.choice === 'server' ? 'server' : 'merge',
      backup: record.backup ?? null,
      taken,
      trashed,
      notTaken: notTaken.slice(0, NAMED_MAX),
      resumed
    })
    return true
  }

  /**
   * This vault becomes the server's: what differs takes the server's version, written over
   * the file - a note or file the server has is never deleted here, whose delete event would
   * be a delete made here, for everyone -, and what only this vault has goes to the trash.
   */
  private async takeServers(plan: JoinPlan): Promise<{ taken: number; trashed: number; notTaken: string[] }> {
    const { app, store, attachments, host, leaving } = this.parts
    const notes = [...plan.notes.different, ...plan.notes.unknown]
    const files = plan.files.different
    const only = [...plan.notes.onlyHere, ...plan.files.onlyHere]
    const total = notes.length + files.length + only.length
    let done = 0
    let taken = 0
    const notTaken: string[] = []
    const tick = (): void => {
      done += 1
      host.progress('apply', done, total)
    }
    host.progress('apply', 0, total)
    await pool(notes, () => this.stopped, async (path) => {
      const ok = await store.takeServerText(path).catch((error: unknown) => {
        log.warn(`${path}: taking the server's version failed`, error)
        return false
      })
      if (ok) taken += 1
      else notTaken.push(path)
      tick()
    })
    for (const path of files) {
      if (this.stopped) break
      if (await attachments.takeServerVersion(path)) taken += 1
      else notTaken.push(path)
      tick()
    }
    let trashed = 0
    for (const path of only) {
      if (this.stopped) break
      const file = app.vault.getAbstractFileByPath(path)
      if (file instanceof TFile) {
        try {
          leaving(path)
          await app.fileManager.trashFile(file)
          trashed += 1
          log.info(`${path}: only this vault had it, moved to the trash`)
        } catch (error) {
          log.warn(`${path}: moving it to the trash failed; it stays and goes up`, error)
          notTaken.push(path)
        }
      }
      tick()
    }
    return { taken, trashed, notTaken: notTaken.sort() }
  }

  /** Whether this device agreed on any note or file of this vault before - a start before 0.9.19. */
  private knownBefore(): boolean {
    const { index, attachmentIndex, state } = this.parts
    return (
      [...index.live(), ...index.deleted()].some(({ docId }) => state.get(docId) !== undefined) ||
      [...attachmentIndex.live(), ...attachmentIndex.deleted()].some(({ fileId }) => state.attachment(fileId) !== undefined)
    )
  }

  /** Both sides, path by path. Reads only: nothing of the vault or the server changes. */
  private async compare(): Promise<JoinPlan> {
    const { app, store, attachments, index, attachmentIndex, host } = this.parts
    const notesHere = app.vault.getMarkdownFiles().filter((file) => !store.isExcluded(file.path))
    const filesHere = app.vault.getFiles().filter((file) => file.extension !== 'md' && !attachments.isExcluded(file.path))
    // What the start would pull, and nothing else: an entry no file will be made for is not "there".
    const notesThere = new Map<string, string>()
    for (const { docId, entry } of index.live()) {
      if (entry.path.endsWith('.md') && !store.isExcluded(entry.path)) notesThere.set(entry.path, docId)
    }
    const filesThere = new Map<string, AttachmentEntry>()
    for (const { entry } of attachmentIndex.live()) if (!attachments.isExcluded(entry.path)) filesThere.set(entry.path, entry)

    const notes = side()
    const files = side()
    const notesBoth: Array<{ file: TFile; docId: string }> = []
    for (const file of notesHere) {
      const docId = notesThere.get(file.path)
      if (docId) notesBoth.push({ file, docId })
      else notes.onlyHere.push(file.path)
    }
    const notePaths = new Set(notesHere.map((file) => file.path))
    for (const path of notesThere.keys()) if (!notePaths.has(path)) notes.onlyThere.push(path)
    const filesBoth: Array<{ file: TFile; entry: AttachmentEntry }> = []
    for (const file of filesHere) {
      const entry = filesThere.get(file.path)
      if (entry) filesBoth.push({ file, entry })
      else files.onlyHere.push(file.path)
    }
    const filePaths = new Set(filesHere.map((file) => file.path))
    for (const path of filesThere.keys()) if (!filePaths.has(path)) files.onlyThere.push(path)

    const total = notesBoth.length + filesBoth.length
    let done = 0
    const tick = (): void => {
      done += 1
      host.progress('compare', done, total)
    }
    host.progress('compare', 0, total)
    await pool(notesBoth, () => this.stopped, async ({ file, docId }) => {
      try {
        const there = await store.serverText(docId)
        if (there === null) notes.unknown.push(file.path)
        else (there === (await app.vault.read(file)) ? notes.same : notes.different).push(file.path)
      } catch (error) {
        log.warn(`${file.path}: comparing it with the server failed`, error)
        notes.unknown.push(file.path)
      }
      tick()
    })
    // One at a time: a file is read whole to hash it.
    for (const { file, entry } of filesBoth) {
      if (this.stopped) break
      try {
        const same = file.stat.size === entry.size && (await contentHash(new Uint8Array(await app.vault.readBinary(file)))) === entry.hash
        ;(same ? files.same : files.different).push(file.path)
      } catch (error) {
        log.warn(`${file.path}: comparing it with the server failed`, error)
        files.different.push(file.path)
      }
      tick()
    }
    for (const list of [notes, files]) for (const paths of Object.values(list)) paths.sort()

    const here = notesHere.length + filesHere.length
    const there = notesThere.size + filesThere.size
    const common = notesBoth.length + filesBoth.length
    const apart = notes.different.length + notes.unknown.length + notes.onlyHere.length + files.different.length + files.onlyHere.length
    const kind: JoinKind =
      here === 0 && there === 0
        ? 'empty'
        : there === 0
          ? 'upload'
          : here === 0
            ? 'download'
            : apart === 0
              ? 'same'
              : common < UNRELATED_SHARE * Math.min(here, there)
                ? 'unrelated'
                : 'related'
    const everything = app.vault.getFiles()
    return {
      kind,
      notes,
      files,
      backup: { files: everything.length, bytes: everything.reduce((sum, file) => sum + file.stat.size, 0) }
    }
  }

  /** Every file of the vault, excluded ones too: the copy is of the vault, not of what syncs. */
  private copyVault(): Promise<string> {
    const { app, backups, host } = this.parts
    const paths = app.vault.getFiles().map((file) => file.path)
    return backups.copyVault(
      paths,
      async (path) => {
        const file = app.vault.getAbstractFileByPath(path)
        return file instanceof TFile ? app.vault.readBinary(file) : null
      },
      (done, total) => host.progress('backup', done, total)
    )
  }

  private counts(side: JoinSide): string {
    return `${side.same.length} same, ${side.different.length} different, ${side.unknown.length} unknown, ${side.onlyHere.length} only here, ${side.onlyThere.length} only there`
  }
}
