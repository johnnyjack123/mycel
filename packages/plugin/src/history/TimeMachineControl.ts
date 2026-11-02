import { TFile, type App, type DataAdapter, type EventRef, type WorkspaceLeaf } from 'obsidian'
import type { ConnectApi } from '../account/api.js'
import { Notice } from '../notices.js'
import type { RollbackRecord } from '../sync/AccountSettings.js'
import { LockSeal, lockNonce, takeVaultLock, VaultLockedError, type HeldLock } from '../sync/VaultLock.js'
import { TimeMachineBar } from './Bar.js'
import type { EditLocks } from './EditLocks.js'
import type { ExplorerPolicy } from './ExplorerGuard.js'
import { PastFiles, type PastVault, type RestoreReport } from './PastFiles.js'
import { TimeMachineStrip } from './Strip.js'
import {
  TimeMachineSession,
  sameScope,
  scopeName,
  type NowSnapshot,
  type PastItem,
  type PastSource,
  type Position,
  type TickChoice,
  type TimeMachineScope
} from './TimeMachine.js'
import { ConfirmModal, LockedModal, RestoreFailedModal, StartModal } from './TimeMachineModals.js'
import type { PastEditorHost, PastShown } from './pastEditor.js'
import { log } from '../log.js'

// Opens and closes the Time Machine's past in the files (`docs/TIMEMACHINE.md`,
// "The second round"), in this order and never another: read the past, back up,
// lock the vault on every device, stop the sync here, open the journal - and only
// then write. *Abort*: every file back from its copy, the journal gone, the lock
// let go, the sync started. Whatever stops half way leaves a journal, and the next
// start of the plugin puts the files back before the sync may start.
//
// *Restore this version* (the third round) leaves the past without letting go of
// the lock: the backup while the past is still shown, every file back, the sync
// started with this device writing under the lock - and only once the restore
// reached the server do the other devices write again. In between, a note typed
// into here, or written on another device, was overwritten by the restore.

export interface Prepared {
  now: NowSnapshot
  source: PastSource
  seal: LockSeal
  vaultId: string
}

export interface BackupRuns {
  servers(): Array<{ routeId: string; label: string }>
  backUpFresh(routeId: string, options?: { keepAll?: boolean }): Promise<{ ok: boolean; error?: string }>
  backupTimes(routeId: string): Promise<number[]>
}

/** A lock this device holds and hands on: the rollback's window lets go of it when it is done. */
export interface HandedLock {
  release(): Promise<void>
}

export interface ControlHost {
  app: App
  vault: PastVault
  adapter: DataAdapter
  /** The plugin folder. */
  root: string
  api: ConnectApi
  /** What may not be edited on this device; the control keeps its own part of it. */
  locks: EditLocks
  settings(): { ticks: TickChoice; backups: boolean; marks: boolean }
  saveSettings(patch: Partial<{ ticks: TickChoice; backups: boolean; marks: boolean }>): Promise<void>
  /** Files larger than this stay as they are now: the device's download limit. */
  fileLimit(): number
  /** What the running sync knows - now, and how to read the past; null while it does not run. */
  prepare(): Prepared | null
  backups(): BackupRuns | null
  /** This device, as a lock names it: a phone or a computer. */
  device(): string
  stopSync(): Promise<void>
  startSync(): Promise<void>
  /** Waits until the sync runs again, at most this long. */
  whenSyncing(timeoutMs: number): Promise<boolean>
  /** This device's connection writes under that lock from now on, a new one too; null: under none. */
  writeUnderLock(id: string | null): void
  /** Resolves once what this device wrote reached the server - these notes and the index, or everything - or after `timeoutMs`. */
  whenSent(docIds: string[] | 'all', timeoutMs: number): Promise<boolean>
  /** The rollbacks made of a folder ('' for the vault), newest first. */
  rollbacks(folder: string): RollbackRecord[]
  openOverview(): Promise<void>
  closeOverview(): void
  /** With the sync running and the vault still locked: the rollback to a moment, in its window, which lets go of the lock. */
  applyAt(folder: string, at: number, lock: HandedLock): void
  /** One note to its text then. What the notice says. */
  restoreNote(docId: string, path: string, text: string, at: number, backedUp: boolean): Promise<string>
  /** One file to its content then. */
  restoreFile(item: PastItem, content: { data: Uint8Array; hash: string; size: number }, at: number, backedUp: boolean): Promise<string>
}

const SYNC_BACK_MS = 60_000
/** How long the lock waits for a restore to reach the server before letting go anyway: it goes out afterwards then. */
const SENT_MS = 30_000

/** Opening was called off on the way; nothing to report. */
class Cancelled extends Error {}

export class TimeMachineControl implements PastEditorHost {
  private session: TimeMachineSession | null = null
  private files: PastFiles | null = null
  private lock: HeldLock | null = null
  private ui: { root: HTMLElement; strip: TimeMachineStrip; bar: TimeMachineBar; resize: ResizeObserver | null; layout: EventRef } | null = null
  private opening = false
  private ending = false
  /** The sync is stopped for the past and must not start: from just before it stops until it is started again. */
  private holding = false
  private busy: string | null = null
  private foreign = 0
  /** The last file opened in what the Time Machine shows, and its tab: where it goes back to when something else was opened. */
  private lastOpened: { file: TFile; leaf: WorkspaceLeaf } | null = null
  private readonly listeners = new Set<() => void>()
  private unwatchSession: (() => void) | null = null

  constructor(private readonly host: ControlHost) {}

  /** Whether the sync must not start: the past is, or may be, in the files. */
  get blocksSync(): boolean {
    return this.holding
  }

  get current(): TimeMachineSession | null {
    return this.session
  }

  shows(scope: TimeMachineScope): boolean {
    return this.session !== null && sameScope(this.session.scope, scope)
  }

  /** Whether this lock is the one this device holds for its own Time Machine. */
  ownsLock(sealed: string): boolean {
    return this.lock?.active === true && this.lock.info.sealed === sealed
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  // --- the editor and the explorer -----------------------------------------------------------

  async pastOf(path: string): Promise<PastShown | null> {
    const session = this.session
    if (!session || !session.showsPast(path)) return null
    const now = await session.nowTextOf(path)
    return { now: now === undefined ? null : now, marks: this.host.settings().marks }
  }

  lockedWhy(path: string): string | null {
    return this.host.locks.lockOf(path)?.why ?? null
  }

  /** What the explorer lets through while the Time Machine runs here; null while it does not. */
  explorerPolicy(): ExplorerPolicy | null {
    const session = this.session
    const own = this.host.locks.ownLock
    if (!session && !own) return null
    const leave = session ? `The Time Machine shows ${scopeName(session.scope)}. Restore this version or abort first.` : null
    return {
      refuseOpen: (path) => (session && leave && !session.inScope(path) ? leave : null),
      refuseChange: () => own?.why ?? leave,
      dimOutside: session && session.scope.kind !== 'vault' ? session.scope : null
    }
  }

  /**
   * A file opened while the Time Machine runs: outside what it shows - by a link,
   * the quick switcher, a search - the tab goes back to where it was (X4). A tab
   * of its own that was open before is left as it is; the one before comes to
   * the front again.
   */
  async opened(file: TFile | null): Promise<void> {
    const session = this.session
    const { workspace, vault } = this.host.app
    if (!session || !file) return
    const leaf = workspace.getMostRecentLeaf()
    if (session.inScope(file.path)) {
      this.lastOpened = leaf ? { file, leaf } : this.lastOpened
      session.prioritize(file.path)
      void session.fetchOnOpen(file.path)
      return
    }
    new Notice(`The Time Machine shows ${scopeName(session.scope)}. Restore this version or abort first to open ${file.basename}.`)
    if (!leaf) return
    const last = this.lastOpened
    let lastShown = false
    if (last) workspace.iterateAllLeaves((each) => (lastShown ||= each === last.leaf))
    if (last && lastShown && last.leaf !== leaf) {
      workspace.setActiveLeaf(last.leaf, { focus: true })
      return
    }
    if (last && vault.getAbstractFileByPath(last.file.path) instanceof TFile) await leaf.openFile(last.file)
    else await leaf.setViewState({ type: 'empty' })
  }

  // --- opening ----------------------------------------------------------------------

  async open(scope: TimeMachineScope): Promise<void> {
    if (this.session) {
      if (this.shows(scope)) {
        if (scope.kind !== 'note') await this.host.openOverview()
        return
      }
      new Notice(`The Time Machine shows ${scopeName(this.session.scope)}. Restore this version or abort first.`)
      return
    }
    if (this.lock && !this.opening) {
      new Notice('A restore from the Time Machine is still under way. Open it again once it is done.')
      return
    }
    if (this.opening || this.ending) return
    const prepared = this.host.prepare()
    if (!prepared) {
      new Notice('Obsidian Connect is not connected yet. The Time Machine reads the past from the server, so it opens once the vault syncs.')
      return
    }
    const modal = new StartModal(this.host.app, scopeName(scope), scope.kind === 'note')
    if (!(await modal.ask())) return
    this.opening = true
    let stopped = false
    try {
      modal.step('Reading the past from the server…')
      const settings = this.host.settings()
      const session = await TimeMachineSession.load(scope, prepared.source, prepared.now, {
        vault: this.host.vault,
        choice: settings.ticks,
        includeBackups: settings.backups,
        fileLimit: this.host.fileLimit(),
        marks: this.marksFor(scope)
      })
      if (!(await this.backUp((label) => modal.step(`Backing up on ${label}…`), (question) => modal.goOn(question, 'Show it anyway')))) throw new Cancelled()
      modal.step('Locking the vault on your other devices…')
      const sealed = await prepared.seal.seal({ what: scopeName(scope), device: this.host.device(), nonce: lockNonce(), scope })
      const lock = await takeVaultLock(this.host.api, prepared.vaultId, 'preview', sealed, (why) => this.lockLost(why))
      this.lock = lock
      modal.step('Stopping the sync on this device…')
      this.holding = true
      stopped = true
      await this.host.stopSync()
      const files = await PastFiles.begin(this.host.vault, this.host.adapter, this.host.root, { scope, lockId: lock.id, vaultId: prepared.vaultId })
      session.attach(files)
      this.session = session
      this.files = files
      this.foreign = 0
      const active = this.host.app.workspace.getActiveFile()
      const leaf = this.host.app.workspace.getMostRecentLeaf()
      this.lastOpened = active && leaf && session.inScope(active.path) ? { file: active, leaf } : null
      const note = scope.kind === 'note' ? this.host.app.vault.getAbstractFileByPath(scope.path) : null
      if (!this.lastOpened && leaf && note instanceof TFile) this.lastOpened = { file: note, leaf }
      this.host.locks.set(true, { scope, why: `The Time Machine shows the past of ${scopeName(scope)} here, read-only. Restore this version or abort first.`, own: true })
      this.unwatchSession = session.onChange(() => this.refresh())
      modal.close()
      this.showUi(session)
      if (scope.kind !== 'note') await this.host.openOverview()
      log.info(`the Time Machine shows ${scopeName(scope)}: the sync is stopped, the vault locked`)
      this.emit()
    } catch (error) {
      modal.close()
      await this.lock?.release()
      this.lock = null
      this.host.locks.set(true, null)
      // A journal of an earlier Time Machine may still wait: its files go back before the sync may start.
      if (stopped && (await this.recoverAtStart())) await this.host.startSync()
      else if (!stopped) this.holding = false
      if (error instanceof Cancelled) return
      if (error instanceof VaultLockedError) {
        const lock = error.lock
        if (lock) new LockedModal(this.host.app, lock, await prepared.seal.open(lock.sealed), () => this.unlock(prepared.vaultId)).open()
        else new Notice('The vault is locked by another device of yours. Try again in a moment.')
        return
      }
      log.error('opening the Time Machine failed', error)
      new Notice(`The Time Machine could not open: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.opening = false
    }
  }

  /** The moments before the earlier rollbacks of a folder or the vault, as marks on the strip. */
  private marksFor(scope: TimeMachineScope): Array<{ at: number; label: string }> {
    if (scope.kind === 'note') return []
    return this.host.rollbacks(scope.kind === 'folder' ? scope.path : '').map((record) => ({
      at: record.startedAt - 1,
      label: `before the rollback of ${new Date(record.startedAt).toLocaleString()}`
    }))
  }

  /**
   * A backup on every backup server - before the past is shown, and before a
   * restore. Nothing changed since the last one, the backup server says so at once
   * (0.8.15). Failed, `ask` decides whether to go on; false: stop.
   */
  private async backUp(step: (label: string) => void, ask: (question: string) => Promise<boolean>): Promise<boolean | 'failed'> {
    const backups = this.host.backups()
    if (!backups) return true
    let failed = false
    for (const server of backups.servers()) {
      step(server.label)
      const outcome = await backups.backUpFresh(server.routeId)
      if (outcome.ok) continue
      failed = true
      const go = await ask(
        `The backup on ${server.label} did not go through (${outcome.error ?? 'no reason given'}). Go on anyway? A copy of what changes is kept in the plugin folder either way.`
      )
      if (!go) return false
    }
    return failed ? 'failed' : true
  }

  private lockLost(why: string): void {
    new Notice(`The lock of the vault ended - ${why}. Your other devices sync again; this one shows the past until you abort or restore.`, 12_000)
  }

  /** Lifts the lock, from any device - for one that hangs. */
  async unlock(vaultId: string): Promise<boolean> {
    try {
      const { ended } = await this.host.api.breakVaultLock(vaultId)
      new Notice(ended ? 'The vault is unlocked on all your devices.' : 'The vault was not locked any more.')
      return true
    } catch (error) {
      new Notice(`Unlocking failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  // --- moving -----------------------------------------------------------------------

  private async moveTo(place: number): Promise<void> {
    const session = this.session
    if (!session || this.ending) return
    try {
      await session.moveTo(place)
    } catch (error) {
      log.error('showing a moment failed', error)
      new Notice(`That moment could not be shown: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.emit()
  }

  /** An earlier rollback, chosen in the overview: the moment before it, shown - *Restore this version* undoes it. */
  async showBeforeRollback(record: RollbackRecord): Promise<void> {
    const session = this.session
    if (!session || this.ending) return
    if (!(await session.moveToMark(record.startedAt - 1))) {
      new Notice('The moment before that rollback lies before the history the server keeps.')
      return
    }
    this.emit()
  }

  /** A vault event while the past is shown: the Time Machine's own, or someone else's. */
  vaultEvent(path: string): void {
    const session = this.session
    const files = this.files
    if (!session || !files || files.isOwn(path)) return
    files.noteEvent(path)
    if (!session.inScope(path)) return
    this.foreign += 1
    if (this.foreign === 1) {
      new Notice(
        `${scopeName(session.scope)} shows the past and is locked: what is changed in it now is put back when you abort, and what was written over the past is kept in the plugin folder.`,
        10_000
      )
    }
  }

  private async setTicks(choice: TickChoice): Promise<void> {
    await this.host.saveSettings({ ticks: choice })
    await this.reload()
  }

  private async setBackups(on: boolean): Promise<void> {
    await this.host.saveSettings({ backups: on })
    await this.reload()
  }

  /** The moments read again with other ticks; the moment shown stays if it still is one. */
  private async reload(): Promise<void> {
    const session = this.session
    if (!session) return
    this.busy = 'Reading the past again…'
    this.refresh()
    try {
      const settings = this.host.settings()
      await session.reread({ choice: settings.ticks, includeBackups: settings.backups })
    } catch (error) {
      new Notice(`The past could not be read again: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.busy = null
    this.refresh()
  }

  private async toggleMarks(on: boolean): Promise<void> {
    await this.host.saveSettings({ marks: on })
    this.refresh()
    this.emit()
  }

  // --- leaving ----------------------------------------------------------------------

  /** *Abort*: every file back as it was, the lock let go, the sync on again. False while some file could not be put back. */
  async backToNow(): Promise<boolean> {
    const session = this.session
    if (!session || this.ending) return !session
    this.ending = true
    this.busy = 'Putting every file back…'
    this.refresh()
    try {
      const report = await this.putBack(session, async () => {
        this.ending = false
        return this.backToNow()
      })
      if (!report) return false
      await this.letGo()
      await this.host.startSync()
      log.info('the Time Machine is closed: every file is back, the sync runs again')
      new Notice(
        report.aside.length > 0
          ? `Aborted. ${report.aside.length} file(s) were written over while they showed the past; what was written lies in ${report.asideDir}.`
          : 'Aborted: every file is as it was, and the sync runs again.',
        report.aside.length > 0 ? 15_000 : 6_000
      )
      return true
    } finally {
      this.ending = false
    }
  }

  /**
   * Every file back from its copy and the journal gone; the session closed, the
   * lock still held. Null while some file could not be put back: the window that
   * says so retries with `retry`.
   */
  private async putBack(session: TimeMachineSession, retry: () => Promise<boolean>): Promise<RestoreReport | null> {
    const report = await session.restore()
    if (report.failed.length > 0) {
      this.busy = null
      this.refresh()
      new RestoreFailedModal(this.host.app, report.failed, retry).open()
      return null
    }
    await this.files?.finish()
    this.unwatchSession?.()
    this.unwatchSession = null
    this.hideUi()
    this.host.closeOverview()
    this.session = null
    this.files = null
    this.busy = null
    this.holding = false
    this.emit()
    return report
  }

  /** The lock let go, and with it the editors here and the other devices. */
  private async letGo(): Promise<void> {
    this.host.writeUnderLock(null)
    await this.lock?.release()
    this.lock = null
    this.host.locks.set(true, null)
    this.emit()
  }

  /**
   * Out of the past with the vault still locked: every file back, the sync
   * started, this device writing under the lock. False when that did not go
   * through - the lock is let go then, unless files could not be put back.
   */
  private async leaveLocked(session: TimeMachineSession, why: string): Promise<boolean> {
    this.ending = true
    this.busy = 'Putting every file back…'
    this.refresh()
    try {
      const report = await this.putBack(session, async () => {
        this.ending = false
        return this.backToNow()
      })
      if (!report) return false
      this.host.locks.set(true, { scope: session.scope, why, own: true })
      // Named before the sync connects, so nothing of it is sent unnamed and refused.
      this.host.writeUnderLock(this.lock?.id ?? null)
      await this.host.startSync()
      if (await this.host.whenSyncing(SYNC_BACK_MS)) return true
      await this.letGo()
      new Notice('The sync did not start again in time. Nothing was restored; open the Time Machine again once it runs.')
      return false
    } finally {
      this.ending = false
    }
  }

  /** *Restore this version*: the note, or the folder or vault through the rollback's window. */
  private async apply(): Promise<void> {
    const session = this.session
    const position = session?.position
    if (!session || !position?.tick || this.ending) return
    if (session.scope.kind === 'note') {
      await this.restoreVersion(session, position)
      return
    }
    // The rollback's window backs up itself, and asks when that fails.
    if (!(await this.leaveLocked(session, `A rollback of ${scopeName(session.scope)} runs on this device.`))) return
    this.host.applyAt(session.folder, position.at, { release: () => this.afterRestore('all') })
  }

  /** Lets go of the lock once what was restored reached the server - or after a while, when it goes out afterwards. */
  private async afterRestore(docIds: string[] | 'all'): Promise<void> {
    if (!(await this.host.whenSent(docIds, SENT_MS))) log.warn('a restore had not reached the server when the lock was let go; it goes out now')
    await this.letGo()
  }

  /** The backup before a restore, while the past is still shown; null: stop. */
  private async backUpFirst(): Promise<boolean | null> {
    this.busy = 'Backing up first…'
    this.refresh()
    const outcome = await this.backUp(
      (label) => {
        this.busy = `Backing up on ${label}…`
        this.refresh()
      },
      (question) => new ConfirmModal(this.host.app, 'The backup did not go through', question, 'Restore anyway').ask()
    )
    this.busy = null
    this.refresh()
    if (outcome === false) return null
    return outcome === true && this.host.backups() !== null
  }

  private async restoreVersion(session: TimeMachineSession, position: Position): Promise<void> {
    const path = (session.scope as { path: string }).path
    const docId = session.noteId
    const text = await session.noteTextAt(path)
    if (!docId || text === null) {
      new Notice('Its text at that moment cannot be told.')
      return
    }
    await this.restoreLocked(session, [docId], (backedUp) => this.host.restoreNote(docId, path, text, position.at, backedUp))
  }

  /** *Restore just this note* (or file), from the overview. */
  async restoreItem(item: PastItem): Promise<void> {
    const session = this.session
    const position = session?.position
    const path = item.pathThen
    if (!session || !position?.tick || !path || this.ending) return
    const text = item.kind === 'note' ? await session.noteTextAt(path) : null
    const content = item.kind === 'file' ? await session.fileDataAt(path) : null
    if ((item.kind === 'note' && text === null) || (item.kind === 'file' && !content)) {
      new Notice(`${path} at that moment cannot be read.`)
      return
    }
    await this.restoreLocked(session, item.kind === 'note' && item.id ? [item.id] : [], (backedUp) =>
      item.kind === 'note'
        ? this.host.restoreNote(item.id, path, text as string, position.at, backedUp)
        : this.host.restoreFile(item, content as NonNullable<typeof content>, position.at, backedUp)
    )
  }

  /** A backup, out of the past with the lock kept, `restore`, and the lock let go once it reached the server. */
  private async restoreLocked(session: TimeMachineSession, docIds: string[], restore: (backedUp: boolean) => Promise<string>): Promise<void> {
    const backedUp = await this.backUpFirst()
    if (backedUp === null) return
    if (!(await this.leaveLocked(session, `${scopeName(session.scope)} is being restored on this device.`))) return
    let message: string | null = null
    try {
      message = await restore(backedUp)
    } catch (error) {
      log.error('restoring from the Time Machine failed', error)
      new Notice(`Restoring failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await this.afterRestore(docIds)
    }
    if (message) new Notice(message, 8_000)
  }

  /** At a start of the plugin, before the sync: a past a crash left in the files goes back first. */
  async recoverAtStart(): Promise<boolean> {
    const files = await PastFiles.resume(this.host.vault, this.host.adapter, this.host.root)
    if (!files) {
      this.holding = false
      return true
    }
    this.holding = true
    log.warn('the past of a Time Machine was still in the files: putting every file back before the sync starts')
    const report = await files.restore()
    if (report.failed.length > 0) {
      new RestoreFailedModal(this.host.app, report.failed, async () => {
        if (!(await this.recoverAtStart())) return false
        await this.host.startSync()
        return true
      }).open()
      return false
    }
    await files.finish()
    if (files.start.lockId && files.start.vaultId) {
      await this.host.api.releaseVaultLock(files.start.vaultId, files.start.lockId).catch(() => undefined)
    }
    this.holding = false
    new Notice(
      `Obsidian closed while the Time Machine showed the past. Every file is back as it was${report.aside.length > 0 ? ` (what was written over the past lies in ${report.asideDir})` : ''}; the sync starts now.`,
      12_000
    )
    return true
  }

  /** The plugin is unloading: back to now as far as it gets; the next start finishes it. */
  async unload(): Promise<void> {
    const session = this.session
    this.hideUi()
    try {
      if (session) {
        const report = await session.restore()
        if (report.failed.length === 0) await this.files?.finish()
      }
      this.host.writeUnderLock(null)
      await this.lock?.release()
    } catch (error) {
      log.error('putting the files back on unload failed; the next start does it', error)
    }
  }

  // --- drawing ----------------------------------------------------------------------

  private showUi(session: TimeMachineSession): void {
    const doc = this.host.app.workspace.containerEl.doc
    const root = doc.body.createDiv({ cls: 'connect-tm-ui' })
    const strip = new TimeMachineStrip(root, {
      select: (place) => void this.moveTo(place),
      label: (position) => this.label(position)
    })
    const bar = new TimeMachineBar(
      root,
      {
        apply: () => void this.apply(),
        backToNow: () => void this.backToNow(),
        toggleMarks: (on) => void this.toggleMarks(on),
        setTicks: (choice) => void this.setTicks(choice),
        setBackups: (on) => void this.setBackups(on),
        overview: () => void this.host.openOverview()
      },
      session.scope.kind !== 'note'
    )
    doc.body.addClass('connect-tm-active')
    const editors = doc.querySelector('.workspace-split.mod-root')
    // Below the tabs, never in their row: on Windows the window's own buttons lie at
    // the right end of it, over everything, and they hid the way out (0.8.14). The
    // timeline in a column of its own at the left: the right edge is the editors'
    // scrollbar's. The editors of the top row move down by the bar's height, those
    // of the left column right by the timeline's width - nothing is covered.
    const place = (): void => {
      const box = (editors ?? doc.body).getBoundingClientRect()
      let top = box.top
      const groups = editors ? Array.from(editors.querySelectorAll<HTMLElement>('.workspace-tabs')) : []
      for (const group of groups) {
        const groupBox = group.getBoundingClientRect()
        const topRow = Math.abs(groupBox.top - box.top) < 2
        group.toggleClass('connect-tm-below-bar', topRow)
        group.toggleClass('connect-tm-beside-strip', Math.abs(groupBox.left - box.left) < 2)
        const header = topRow ? group.querySelector<HTMLElement>(':scope > .workspace-tab-header-container') : null
        const headerBox = header?.getBoundingClientRect()
        if (headerBox && headerBox.height > 0) top = Math.max(top, headerBox.bottom)
      }
      const height = bar.el.offsetHeight
      // The status bar floats over the editors' lower right corner.
      const status = doc.querySelector<HTMLElement>('.status-bar')?.getBoundingClientRect()
      const bottom = status && status.height > 0 && status.left < box.left + 80 ? Math.min(box.bottom, status.top) : box.bottom
      root.style.setProperty('--connect-tm-top', `${top}px`)
      root.style.setProperty('--connect-tm-right', `${Math.max(0, doc.documentElement.clientWidth - box.right)}px`)
      root.style.setProperty('--connect-tm-left', `${box.left}px`)
      root.style.setProperty('--connect-tm-strip-top', `${top + height}px`)
      root.style.setProperty('--connect-tm-strip-height', `${Math.max(0, bottom - top - height)}px`)
      doc.body.style.setProperty('--connect-tm-bar-height', `${height}px`)
    }
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    if (editors) resize?.observe(editors)
    resize?.observe(bar.el)
    const layout = this.host.app.workspace.on('layout-change', place)
    place()
    this.ui = { root, strip, bar, resize, layout }
    this.refresh()
  }

  private hideUi(): void {
    if (!this.ui) return
    const doc = this.host.app.workspace.containerEl.doc
    this.ui.resize?.disconnect()
    this.host.app.workspace.offref(this.ui.layout)
    this.ui.strip.destroy()
    this.ui.bar.destroy()
    this.ui.root.remove()
    doc.body.removeClass('connect-tm-active')
    doc.body.style.removeProperty('--connect-tm-bar-height')
    doc.querySelectorAll('.connect-tm-below-bar, .connect-tm-beside-strip').forEach((group) => group.removeClass('connect-tm-below-bar', 'connect-tm-beside-strip'))
    this.ui = null
  }

  private label(position: Position): string {
    const session = this.session
    if (!session) return ''
    if (!position.tick) {
      const latest = session.latest
      return latest && latest.changed > 0 ? `Now - last changed ${new Date(latest.last).toLocaleString()}` : 'Now'
    }
    if (position.backup) return `${session.describe(position)}`
    if (position.mark) return `${session.describe(position)} - ${position.mark}`
    return `${session.describe(position)} - ${TimeMachineSession.changedText(position.tick, session.scope.kind === 'note')}`
  }

  private refresh(): void {
    const session = this.session
    const ui = this.ui
    if (!session || !ui) return
    ui.strip.set(session.positions, session.place)
    const position = session.position
    const atTick = Boolean(position?.tick)
    // Someone else's shared folder: its past can be looked at, only its owner restores it.
    const owner = session.folderOwner
    ui.bar.set({
      title: `Time Machine: ${scopeName(session.scope)}`,
      moment: position ? this.label(position) : '',
      detail: atTick
        ? owner
          ? `read-only - ${owner}'s folder: only ${owner} takes it back, for everyone`
          : 'read-only, the sync stopped here, the vault locked on your other devices'
        : 'move along the timeline on the left',
      progress: session.progress ? `showing it: ${session.progress.done} of ${session.progress.of}` : null,
      restore: atTick && !owner,
      marks: this.host.settings().marks,
      ticks: this.host.settings().ticks,
      backups: this.host.backups() ? this.host.settings().backups : null,
      busy: this.busy
    })
    this.emit()
  }
}
