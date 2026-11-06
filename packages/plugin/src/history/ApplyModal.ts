import { App, Modal, Setting } from 'obsidian'
import { Notice, noticeWithAction } from '../notices.js'
import { busy } from '../busy.js'
import {
  IndexOutOfReach,
  Rollback,
  type BackupResult,
  type BackupServers,
  type RollbackOutcome,
  type RollbackPlan
} from '../sync/Rollback.js'
import { VaultLockedError } from '../sync/VaultLock.js'
import { log } from '../log.js'

// Taking a moment the Time Machine shows over, for the vault or one folder:
// what changes, the backups and the copy first, then the rollback. The work
// is `Rollback`'s; this only asks and shows. The moment comes from the Time
// Machine, whose lock of the vault this window holds on to until the rollback
// is done or called off (the third round) - `held`.

type Step =
  | { kind: 'planning'; done: number; of: number }
  | { kind: 'review'; plan: RollbackPlan }
  | { kind: 'working'; plan: RollbackPlan; message: string }
  | { kind: 'backup-failed'; plan: RollbackPlan; backups: BackupResult[] }
  | { kind: 'done'; outcome: RollbackOutcome }

const LIST_MAX = 200

function when(ms: number): string {
  return new Date(ms).toLocaleString()
}

export class ApplyModal extends Modal {
  private step: Step = { kind: 'planning', done: 0, of: 0 }
  private withoutOutOfReach = false
  private closed = false

  constructor(
    app: App,
    private readonly rollback: Rollback,
    private readonly backups: BackupServers | null,
    /** '' for the whole vault. */
    private readonly folder: string,
    private readonly moment: number,
    /** Called once the rollback went through, with or without problems. */
    private readonly applied: (outcome: RollbackOutcome, rollback: Rollback) => void = () => undefined,
    /**
     * The vault's lock, held since the Time Machine: let go of once the rollback is
     * done, or the window closed without one. What was written after it was taken
     * is kept.
     */
    private readonly held: { release(): Promise<void>; lockedAt: number } | null = null
  ) {
    super(app)
  }

  private released = false

  private release(): void {
    if (this.released || !this.held) return
    this.released = true
    void this.held.release()
  }

  onOpen(): void {
    void this.plan()
  }

  private go(step: Step): void {
    this.step = step
    if (!this.closed) this.render()
    // Closed while it worked, and now it stopped - done, failed or waiting for an answer nobody sees.
    else if (step.kind !== 'working') this.release()
  }

  private get where(): string {
    return this.folder ? `the folder ${this.folder}` : 'the vault'
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()
    this.titleEl.setText(`${this.folder || 'The vault'} back to ${when(this.moment)}`)
    switch (this.step.kind) {
      case 'planning':
        contentEl.createEl('p', {
          text: this.step.of > 0 ? `Reading the history… ${this.step.done} of ${this.step.of} notes` : 'Reading the history…'
        })
        return
      case 'review':
        this.renderReview(this.step.plan)
        return
      case 'working':
        contentEl.createEl('p', { text: this.step.message })
        contentEl.createEl('p', { cls: 'setting-item-description', text: 'This may take a while. Closing this window does not stop it.' })
        return
      case 'backup-failed':
        this.renderBackupFailed(this.step.plan, this.step.backups)
        return
      case 'done':
        this.renderDone(this.step.outcome)
        return
    }
  }

  private async plan(): Promise<void> {
    this.withoutOutOfReach = false
    this.go({ kind: 'planning', done: 0, of: 0 })
    try {
      const plan = await this.rollback.plan(
        this.moment,
        this.folder,
        (done, of) => {
          if (this.step.kind === 'planning') this.go({ kind: 'planning', done, of })
        },
        this.held?.lockedAt
      )
      this.go({ kind: 'review', plan })
    } catch (error) {
      this.close()
      if (error instanceof IndexOutOfReach) {
        new Notice(
          (this.backups?.servers().length ?? 0) > 0
            ? `The history on the server reaches back to ${when(error.reach)} only, and no backup server has a backup from before ${when(this.moment)}.`
            : `The history on the server reaches back to ${when(error.reach)} only. A backup server would reach further - see the Backups tab.`,
          12_000
        )
      } else {
        log.error('planning a rollback failed', error)
        new Notice(`Reading the history failed: ${error instanceof Error ? error.message : String(error)}`, 10_000)
      }
    }
  }

  private list(title: string, paths: string[]): void {
    if (paths.length === 0) return
    const details = this.contentEl.createEl('details', { cls: 'mycel-rollback-list' })
    details.createEl('summary', { text: `${title}: ${paths.length}` })
    const ul = details.createEl('ul')
    for (const path of paths.slice(0, LIST_MAX)) ul.createEl('li', { text: path })
    if (paths.length > LIST_MAX) ul.createEl('li', { text: `… and ${paths.length - LIST_MAX} more` })
  }

  private renderReview(plan: RollbackPlan): void {
    const { contentEl } = this
    const notes = plan.notes
    const files = plan.files
    if (notes.length === 0 && files.length === 0 && plan.outOfReach.length === 0) {
      contentEl.createEl('p', {
        text:
          plan.foreignKept > 0
            ? `Nothing in ${this.where} that is yours differs from ${when(plan.to)}. The ${plan.foreignKept} notes or files in it others share with you are not rolled back from here: that would change them for their owner and everyone else too. Their owner can roll them back.`
            : `Nothing in ${this.where} differs from ${when(plan.to)}.`
      })
      new Setting(contentEl).addButton((button) => button.setButtonText('Close').onClick(() => this.close()))
      return
    }
    contentEl.createEl('p', { text: `Everything in ${this.where} goes back to how it was then, as changes every device follows. This changes:` })
    if (plan.backup) {
      const source = `the backup of ${when(plan.backup.ref.notes.time)} on ${plan.backup.label}`
      contentEl.createEl('p', {
        cls: plan.byPath ? 'mod-warning' : 'setting-item-description',
        text: plan.byPath
          ? `The history on the server does not reach back that far, so everything comes from ${source} - matched by name: a note renamed since goes to the trash under its new name and comes back under its old one.`
          : `What the history on the server no longer reaches comes from ${source}.`
      })
    }
    const path = (entry: { pathNow: string | null; pathThen: string | null }): string => entry.pathThen ?? entry.pathNow ?? ''
    const moved = (entry: { pathNow: string | null; pathThen: string | null }): string => `${entry.pathNow} → ${entry.pathThen}`
    this.list('Notes that get their text back', notes.filter((note) => note.text && !note.revive && !note.create).map(path))
    this.list('Notes that came later, to the trash', notes.filter((note) => note.trash).map(path))
    this.list('Notes that come back from the trash', notes.filter((note) => note.revive).map(path))
    this.list('Notes that come back from the backup', notes.filter((note) => note.create).map(path))
    this.list('Notes that move back', notes.filter((note) => note.move).map(moved))
    this.list('Files that get their content back', files.filter((file) => file.content).map(path))
    this.list('Files that came later, to the trash', files.filter((file) => file.trash).map(path))
    this.list('Files that come back from the trash', files.filter((file) => file.revive).map(path))
    this.list('Files that come back from the backup', files.filter((file) => file.create).map(path))
    this.list('Files that move back', files.filter((file) => file.move).map(moved))

    const shared = notes.filter((note) => note.shared)
    if (shared.length > 0) {
      contentEl.createEl('p', {
        cls: 'mod-warning',
        text: `${shared.length} of these notes are shared with other people. Rolling them back changes them for them too.`
      })
      this.list('Shared notes', shared.map(path))
    }
    if (plan.foreignKept > 0) {
      contentEl.createEl('p', {
        cls: 'setting-item-description',
        text: `${plan.foreignKept} notes or files others share with you stay as they are: only their owner rolls them back, for everyone.`
      })
    }
    if (plan.outOfReach.length > 0) {
      contentEl.createEl('p', {
        cls: 'mod-warning',
        text: `The history no longer reaches back that far for ${plan.outOfReach.length} notes or files. They can only stay as they are now.`
      })
      this.list('Out of reach', plan.outOfReach.map((entry) => `${entry.path} - ${entry.reason}`))
      new Setting(contentEl)
        .setName('Roll back without them')
        .setDesc('They stay as they are; everything else goes back.')
        .addToggle((toggle) =>
          toggle.setValue(this.withoutOutOfReach).onChange((value) => {
            this.withoutOutOfReach = value
          })
        )
    }

    const servers = this.backups?.servers() ?? []
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        servers.length > 0
          ? `Before anything changes, ${servers.map((server) => server.label).join(', ')} make${servers.length === 1 ? 's' : ''} a fresh backup, each checked, and a copy of everything that changes goes into the plugin's folder. If a backup fails, nothing changes unless you say so.`
          : "No backup server is connected: before anything changes, only a copy of everything that changes goes into the plugin's folder."
    })
    new Setting(contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText('Roll back')
          .setWarning()
          .onClick(
            () =>
              void busy(button, async () => {
                if (plan.outOfReach.length > 0 && !this.withoutOutOfReach) {
                  new Notice('Some notes or files are out of reach - turn on "Roll back without them" to go on.')
                  return
                }
                await this.backUpAndApply(plan)
              })
          )
      )
  }

  private async backUpAndApply(plan: RollbackPlan): Promise<void> {
    this.go({ kind: 'working', plan, message: 'Backing up first…' })
    const backups = await this.rollback.backUpFirst(this.backups, (message) => this.go({ kind: 'working', plan, message }))
    if (backups.some((backup) => !backup.ok)) {
      this.go({ kind: 'backup-failed', plan, backups })
      return
    }
    await this.apply(plan, backups, false)
  }

  private renderBackupFailed(plan: RollbackPlan, backups: BackupResult[]): void {
    const { contentEl } = this
    contentEl.createEl('p', { cls: 'mod-warning', text: 'Not every backup went through, so nothing was changed:' })
    const ul = contentEl.createEl('ul')
    for (const backup of backups) ul.createEl('li', { text: `${backup.label}: ${backup.ok ? 'backed up' : (backup.error ?? 'failed')}` })
    contentEl.createEl('p', {
      text: "You can roll back anyway: the copy in the plugin's folder is still taken, and the history keeps what the rollback changes. Or find out first what is wrong with the backup server."
    })
    new Setting(contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText('Roll back without that backup')
          .setWarning()
          .onClick(() => void busy(button, () => this.apply(plan, backups, true)))
      )
  }

  private async apply(plan: RollbackPlan, backups: BackupResult[], withoutBackup: boolean): Promise<void> {
    try {
      const outcome = await this.rollback.apply(plan, { backups, withoutBackup, withoutOutOfReach: this.withoutOutOfReach }, (message) =>
        this.go({ kind: 'working', plan, message })
      )
      // Kept in the notification center with its *Undo…*, which opens the Time Machine before it.
      noticeWithAction(
        outcome.problems.length === 0
          ? `${this.where.replace(/^the /, 'The ')} is back to ${when(plan.to)}.`
          : `${this.where.replace(/^the /, 'The ')} is rolled back to ${when(plan.to)}, with ${outcome.problems.length} problem(s) - see the window or the log.`,
        10_000,
        { label: 'Undo…', kind: 'rollback-undo', data: outcome.record.id, again: true }
      )
      this.go({ kind: 'done', outcome })
      this.release()
      this.applied(outcome, this.rollback)
    } catch (error) {
      log.error('the rollback failed', error)
      new Notice(
        error instanceof VaultLockedError
          ? 'The vault is locked by another device of yours - its Time Machine or a rollback. Nothing was changed; try again once it is done.'
          : `The rollback failed: ${error instanceof Error ? error.message : String(error)}`,
        10_000
      )
      this.go({ kind: 'review', plan })
    }
  }

  private renderDone(outcome: RollbackOutcome): void {
    const { contentEl } = this
    contentEl.createEl('p', { text: `Done: ${this.where} is back to ${when(outcome.record.to)}.` })
    if (outcome.problems.length > 0) {
      contentEl.createEl('p', { cls: 'mod-warning', text: 'Not everything went as planned:' })
      const ul = contentEl.createEl('ul')
      for (const problem of outcome.problems.slice(0, LIST_MAX)) ul.createEl('li', { text: problem })
    }
    if (outcome.merged.length > 0) {
      contentEl.createEl('p', {
        text: `Written in after the vault was locked - on a device that lifted the lock, or by someone you share with: what was written there is kept, merged into the text then.`
      })
      const ul = contentEl.createEl('ul')
      for (const path of outcome.merged.slice(0, LIST_MAX)) ul.createEl('li', { text: path })
    }
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: `What changed, as it was before, was copied into ${outcome.copy}; the copy goes once the backup server is found to hold the same. To undo the rollback: Rollbacks in Connect (the bell), Undo… - it opens the Time Machine at the moment before it, and Restore this version there takes it back.`
    })
    new Setting(contentEl).addButton((button) => button.setButtonText('Close').setCta().onClick(() => this.close()))
  }

  onClose(): void {
    this.closed = true
    this.contentEl.empty()
    // Still working: the rollback lets go once it is done.
    if (this.step.kind !== 'working') this.release()
  }
}
