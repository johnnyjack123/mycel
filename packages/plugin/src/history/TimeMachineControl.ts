import { TFile, type App, type DataAdapter, type EventRef } from 'obsidian'
import type { ConnectApi } from '../account/api.js'
import { Notice } from '../notices.js'
import { LockSeal, lockNonce, takeVaultLock, VaultLockedError, type HeldLock } from '../sync/VaultLock.js'
import { TimeMachineBar } from './Bar.js'
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
import { LockedModal, RestoreFailedModal, StartModal } from './TimeMachineModals.js'
import type { PastEditorHost, PastShown } from './pastEditor.js'
import { log } from '../log.js'

// Opens and closes the Time Machine's past in the files (`docs/TIMEMACHINE.md`,
// "The second round"), in this order and never another: read the past, back up
// if the last backup is older than the last change, lock the vault on every
// device, stop the sync here, open the journal - and only then write. Back to
// now: every file back from its copy, the journal gone, the lock let go, the
// sync started. Whatever stops half way leaves a journal, and the next start of
// the plugin puts the files back before the sync may start.

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

export interface ControlHost {
  app: App
  vault: PastVault
  adapter: DataAdapter
  /** The plugin folder. */
  root: string
  api: ConnectApi
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
  openOverview(): Promise<void>
  closeOverview(): void
  /** After *Back to now*, with the sync running: the rollback to a moment, in its window. */
  applyAt(folder: string, at: number): void
  /** After *Back to now*: one note to its text then, a backup first. What the notice says. */
  restoreNote(docId: string, path: string, text: string, at: number): Promise<string>
  /** After *Back to now*: one file to its content then. */
  restoreFile(item: PastItem, content: { data: Uint8Array; hash: string; size: number }, at: number): Promise<string>
}

const SYNC_BACK_MS = 60_000

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

  // --- the editor -------------------------------------------------------------------

  async pastOf(path: string): Promise<PastShown | null> {
    const session = this.session
    if (!session || !session.showsPast(path)) return null
    const now = await session.nowTextOf(path)
    return { now: now === undefined ? null : now, marks: this.host.settings().marks }
  }

  // --- opening ----------------------------------------------------------------------

  async open(scope: TimeMachineScope): Promise<void> {
    if (this.session) {
      if (this.shows(scope)) {
        if (scope.kind !== 'note') await this.host.openOverview()
        return
      }
      new Notice(`The Time Machine shows ${scopeName(this.session.scope)}. Go back to now first.`)
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
        fileLimit: this.host.fileLimit()
      })
      await this.backUpIfNeeded(session, modal)
      modal.step('Locking the vault on your other devices…')
      const sealed = await prepared.seal.seal({ what: scopeName(scope), device: this.host.device(), nonce: lockNonce() })
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

  /**
   * A fresh backup when the last one is older than the last change (V3): the
   * past is shown from the files, and a backup is what the user wants there
   * first. Without a backup server only the copy in the plugin folder.
   */
  private async backUpIfNeeded(session: TimeMachineSession, modal: StartModal): Promise<void> {
    const backups = this.host.backups()
    if (!backups) return
    const lastChange = session.latest?.last ?? session.positions.at(-2)?.tick?.last ?? 0
    for (const server of backups.servers()) {
      const times = await backups.backupTimes(server.routeId).catch(() => [] as number[])
      if (times.length > 0 && Math.max(...times) >= lastChange) continue
      modal.step(`Backing up on ${server.label}…`)
      const outcome = await backups.backUpFresh(server.routeId)
      if (outcome.ok) continue
      const go = await modal.goOn(
        `The backup on ${server.label} did not go through (${outcome.error ?? 'no reason given'}). Show the past anyway? Your files come back from the copy in the plugin folder either way.`,
        'Show it anyway'
      )
      if (!go) throw new Cancelled()
    }
  }

  private lockLost(why: string): void {
    new Notice(
      `The lock of the vault ended - ${why}. Your other devices sync again; this one shows the past until you go back to now.`,
      12_000
    )
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

  /** A note or file opened: its content comes next, a large file now. */
  opened(file: TFile | null): void {
    const session = this.session
    if (!session || !file) return
    session.prioritize(file.path)
    void session.fetchOnOpen(file.path)
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
        `${scopeName(session.scope)} shows the past and is locked: what is changed in it now is put back when you go back to now, and what was written over the past is kept in the plugin folder.`,
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

  /** Every file back as it was, the sync on again. False while some file could not be put back. */
  async backToNow(): Promise<boolean> {
    const session = this.session
    if (!session || this.ending) return !session
    this.ending = true
    this.busy = 'Putting every file back…'
    this.refresh()
    try {
      const report = await session.restore()
      if (report.failed.length > 0) {
        this.busy = null
        this.refresh()
        new RestoreFailedModal(this.host.app, report.failed, async () => {
          this.ending = false
          return this.backToNow()
        }).open()
        return false
      }
      await this.files?.finish()
      await this.release(report)
      return true
    } finally {
      this.ending = false
    }
  }

  private async release(report: RestoreReport): Promise<void> {
    await this.lock?.release()
    this.lock = null
    this.unwatchSession?.()
    this.unwatchSession = null
    this.hideUi()
    this.host.closeOverview()
    this.session = null
    this.files = null
    this.busy = null
    this.holding = false
    this.emit()
    await this.host.startSync()
    log.info('the Time Machine is closed: every file is back, the sync runs again')
    new Notice(
      report.aside.length > 0
        ? `Back to now. ${report.aside.length} file(s) were written over while they showed the past; what was written lies in ${report.asideDir}.`
        : 'Back to now: every file is as it was, and the sync runs again.',
      report.aside.length > 0 ? 15_000 : 6_000
    )
  }

  /** *Apply…*: back to now, then the rollback to the moment shown - its list, its backups, its gate. */
  private async apply(): Promise<void> {
    const session = this.session
    const position = session?.position
    if (!session || !position?.tick) return
    if (session.scope.kind === 'note') {
      await this.restoreVersion(session, position)
      return
    }
    await this.applyMoment(session.folder, position.at)
  }

  /** An earlier rollback undone: the rollback to just before it began, in the same place. */
  async undo(folder: string, startedAt: number): Promise<void> {
    await this.applyMoment(folder, startedAt - 1)
  }

  private async applyMoment(folder: string, at: number): Promise<void> {
    if (!(await this.backToNow())) return
    if (!(await this.host.whenSyncing(SYNC_BACK_MS))) {
      new Notice('The sync did not start again in time. Open the Time Machine again to apply once it runs.')
      return
    }
    this.host.applyAt(folder, at)
  }

  private async restoreVersion(session: TimeMachineSession, position: Position): Promise<void> {
    const path = (session.scope as { path: string }).path
    const docId = session.noteId
    const text = await session.noteTextAt(path)
    if (!docId || text === null) {
      new Notice('Its text at that moment cannot be told.')
      return
    }
    if (!(await this.backToNow())) return
    if (!(await this.host.whenSyncing(SYNC_BACK_MS))) {
      new Notice('The sync did not start again in time. Nothing was restored.')
      return
    }
    try {
      new Notice(await this.host.restoreNote(docId, path, text, position.at), 8_000)
    } catch (error) {
      log.error('restoring a version failed', error)
      new Notice(`Restoring failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** *Restore just this note* (or file), from the overview. */
  async restoreItem(item: PastItem): Promise<void> {
    const session = this.session
    const position = session?.position
    const path = item.pathThen
    if (!session || !position?.tick || !path) return
    const text = item.kind === 'note' ? await session.noteTextAt(path) : null
    const content = item.kind === 'file' ? await session.fileDataAt(path) : null
    if ((item.kind === 'note' && text === null) || (item.kind === 'file' && !content)) {
      new Notice(`${path} at that moment cannot be read.`)
      return
    }
    if (!(await this.backToNow())) return
    if (!(await this.host.whenSyncing(SYNC_BACK_MS))) {
      new Notice('The sync did not start again in time. Nothing was restored.')
      return
    }
    try {
      const message =
        item.kind === 'note' ? await this.host.restoreNote(item.id, path, text as string, position.at) : await this.host.restoreFile(item, content as NonNullable<typeof content>, position.at)
      new Notice(message, 8_000)
    } catch (error) {
      log.error('restoring one note or file failed', error)
      new Notice(`Restoring failed: ${error instanceof Error ? error.message : String(error)}`)
    }
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
    if (!this.session) return
    const session = this.session
    this.hideUi()
    try {
      const report = await session.restore()
      if (report.failed.length === 0) await this.files?.finish()
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
    // Below the tabs, never in their row: on Windows the window's own buttons lie
    // at the right end of it, over everything, and they hid *Back to now*. The
    // editors of the top row move down by the bar's height, so it covers nothing.
    const place = (): void => {
      const box = (editors ?? doc.body).getBoundingClientRect()
      let top = box.top
      const groups = editors ? Array.from(editors.querySelectorAll<HTMLElement>('.workspace-tabs')) : []
      for (const group of groups) {
        const topRow = Math.abs(group.getBoundingClientRect().top - box.top) < 2
        group.toggleClass('connect-tm-below-bar', topRow)
        const header = topRow ? group.querySelector<HTMLElement>(':scope > .workspace-tab-header-container') : null
        const headerBox = header?.getBoundingClientRect()
        if (headerBox && headerBox.height > 0) top = Math.max(top, headerBox.bottom)
      }
      const height = bar.el.offsetHeight
      // The status bar floats over the editors' lower right corner, where *now* is.
      const status = doc.querySelector<HTMLElement>('.status-bar')?.getBoundingClientRect()
      const bottom = status && status.height > 0 ? Math.min(box.bottom, status.top) : box.bottom
      root.style.setProperty('--connect-tm-top', `${top}px`)
      root.style.setProperty('--connect-tm-right', `${Math.max(0, doc.documentElement.clientWidth - box.right)}px`)
      root.style.setProperty('--connect-tm-left', `${box.left}px`)
      root.style.setProperty('--connect-tm-strip-top', `${top + height + 8}px`)
      root.style.setProperty('--connect-tm-strip-height', `${Math.max(0, bottom - top - height - 16)}px`)
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
    doc.querySelectorAll('.connect-tm-below-bar').forEach((group) => group.removeClass('connect-tm-below-bar'))
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
    return `${session.describe(position)} - ${TimeMachineSession.changedText(position.tick, session.scope.kind === 'note')}`
  }

  private refresh(): void {
    const session = this.session
    const ui = this.ui
    if (!session || !ui) return
    ui.strip.set(session.positions, session.place)
    const position = session.position
    const atTick = Boolean(position?.tick)
    // Someone else's shared folder: its past can be looked at, only its owner applies it.
    const owner = session.folderOwner
    ui.bar.set({
      title: `Time Machine: ${scopeName(session.scope)}`,
      moment: position ? this.label(position) : '',
      detail: atTick
        ? owner
          ? `read-only - ${owner}'s folder: only ${owner} takes it back, for everyone`
          : 'read-only, the sync stopped here, the vault locked on your other devices'
        : 'move along the timeline on the right',
      progress: session.progress ? `showing it: ${session.progress.done} of ${session.progress.of}` : null,
      apply: !atTick || owner ? null : session.scope.kind === 'note' ? 'Restore this version' : 'Apply…',
      marks: this.host.settings().marks,
      ticks: this.host.settings().ticks,
      backups: this.host.backups() ? this.host.settings().backups : null,
      busy: this.busy
    })
    this.emit()
  }
}
