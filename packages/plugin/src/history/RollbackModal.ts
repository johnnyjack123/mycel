import { App, Modal, Notice, Setting } from 'obsidian'
import { busy } from '../busy.js'
import type { AccountSettings, RollbackRecord } from '../sync/AccountSettings.js'
import {
  IndexOutOfReach,
  Rollback,
  type BackupResult,
  type BackupServers,
  type RollbackOutcome,
  type RollbackPlan
} from '../sync/Rollback.js'
import { log } from '../log.js'

// Rolling the vault or one folder back to a moment: choosing it, seeing what
// changes, the backups and the copy first, then the rollback - and undoing
// an earlier one. The work is `Rollback`'s; this only asks and shows.

type Step =
  | { kind: 'choose' }
  | { kind: 'planning'; done: number; of: number }
  | { kind: 'review'; plan: RollbackPlan }
  | { kind: 'working'; plan: RollbackPlan; message: string }
  | { kind: 'backup-failed'; plan: RollbackPlan; backups: BackupResult[] }
  | { kind: 'done'; outcome: RollbackOutcome }

const LIST_MAX = 200

function when(ms: number): string {
  return new Date(ms).toLocaleString()
}

/** A local date and time for `<input type="datetime-local">`. */
function inputValue(ms: number): string {
  const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000)
  return date.toISOString().slice(0, 16)
}

export class RollbackModal extends Modal {
  private step: Step = { kind: 'choose' }
  private moment = Date.now() - 60 * 60 * 1000
  private reach: number | null = null
  private withoutOutOfReach = false
  private closed = false

  constructor(
    app: App,
    private readonly rollback: Rollback,
    private readonly backups: BackupServers | null,
    private readonly settings: AccountSettings,
    /** '' for the whole vault. */
    private folder: string
  ) {
    super(app)
  }

  onOpen(): void {
    this.render()
    void this.rollback.reach().then(
      (reach) => {
        this.reach = reach
        if (this.step.kind === 'choose') this.render()
      },
      (error: unknown) => log.warn('asking how far the history reaches failed', error)
    )
  }

  private go(step: Step): void {
    this.step = step
    if (!this.closed) this.render()
  }

  private get where(): string {
    return this.folder ? `the folder ${this.folder}` : 'the vault'
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()
    this.titleEl.setText(this.folder ? `Roll back ${this.folder}` : 'Roll back the vault')
    switch (this.step.kind) {
      case 'choose':
        this.renderChoose()
        return
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

  private renderChoose(): void {
    const { contentEl } = this
    contentEl.createEl('p', {
      text: `Everything in ${this.where} goes back to how it was at the moment you choose: notes get their text then, what came later goes to the trash, what was deleted since comes back. As changes - every device follows, and the rollback itself can be undone. Notes others share with you stay as they are.`
    })
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        this.reach === null
          ? 'Asking how far the history reaches…'
          : this.reach === 0
            ? 'The history on the server reaches back to the beginning.'
            : `The history on the server reaches back to ${when(this.reach)}.${
                (this.backups?.servers().length ?? 0) > 0 ? ' Further back, the backups on your backup servers fill in.' : ''
              }`
    })
    const input = new Setting(contentEl).setName('Back to').addText((text) => {
      text.inputEl.type = 'datetime-local'
      text.setValue(inputValue(this.moment)).onChange((value) => {
        const parsed = new Date(value).getTime()
        if (Number.isFinite(parsed)) this.moment = parsed
      })
    })
    const quick = (label: string, ms: number): void => {
      input.addButton((button) =>
        button.setButtonText(label).onClick(() => {
          this.moment = ms
          this.render()
        })
      )
    }
    const now = Date.now()
    quick('An hour ago', now - 60 * 60 * 1000)
    quick('A day ago', now - 24 * 60 * 60 * 1000)
    quick('A week ago', now - 7 * 24 * 60 * 60 * 1000)
    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText('Show what changes')
        .setCta()
        .onClick(() => void this.plan())
    )

    const records = this.settings.rollbacks().slice(0, 5)
    if (records.length === 0) return
    new Setting(contentEl).setName('Earlier rollbacks').setHeading()
    for (const record of records) this.recordRow(record)
  }

  private recordRow(record: RollbackRecord): void {
    const state = record.state === 'done' ? 'done' : record.state === 'failed' ? `with problems: ${record.error ?? ''}` : 'broke off, or still running'
    new Setting(this.contentEl)
      .setName(`${record.folder || 'The vault'} back to ${when(record.to)}`)
      .setDesc(`On ${when(record.startedAt)}: ${record.notes} notes, ${record.files} files - ${state}`)
      .addButton((button) =>
        button.setButtonText('Undo…').onClick(() => {
          // To just before it began, in the same place.
          this.folder = record.folder
          this.moment = record.startedAt - 1
          void this.plan()
        })
      )
  }

  private async plan(): Promise<void> {
    if (this.moment >= Date.now()) {
      new Notice('Choose a moment in the past.')
      return
    }
    this.withoutOutOfReach = false
    this.go({ kind: 'planning', done: 0, of: 0 })
    try {
      const plan = await this.rollback.plan(this.moment, this.folder, (done, of) => {
        if (this.step.kind === 'planning') this.go({ kind: 'planning', done, of })
      })
      this.go({ kind: 'review', plan })
    } catch (error) {
      this.go({ kind: 'choose' })
      if (error instanceof IndexOutOfReach) {
        new Notice(
          (this.backups?.servers().length ?? 0) > 0
            ? `The history on the server reaches back to ${when(error.reach)} only, and no backup server has a backup from before the moment you chose.`
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
    const details = this.contentEl.createEl('details', { cls: 'connect-rollback-list' })
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
      contentEl.createEl('p', { text: `Nothing in ${this.where} differs from ${when(plan.to)}.` })
      new Setting(contentEl).addButton((button) => button.setButtonText('Back').onClick(() => this.go({ kind: 'choose' })))
      return
    }
    contentEl.createEl('p', { text: `Back to ${when(plan.to)}, ${this.where}:` })
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
      contentEl.createEl('p', { cls: 'setting-item-description', text: `${plan.foreignKept} notes or files others share with you stay as they are.` })
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
      .addButton((button) => button.setButtonText('Back').onClick(() => this.go({ kind: 'choose' })))
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
      new Notice(
        outcome.problems.length === 0
          ? `Obsidian Connect: ${this.where} is back to ${when(plan.to)}.`
          : `Obsidian Connect: rolled back to ${when(plan.to)}, with ${outcome.problems.length} problem(s) - see the rollback window or the log.`,
        10_000
      )
      this.go({ kind: 'done', outcome })
    } catch (error) {
      log.error('the rollback failed', error)
      new Notice(`The rollback failed: ${error instanceof Error ? error.message : String(error)}`, 10_000)
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
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: `What changed, as it was before, lies in ${outcome.copy}. To undo the rollback, open this window again and choose "Undo…" next to it.`
    })
    new Setting(contentEl).addButton((button) => button.setButtonText('Close').setCta().onClick(() => this.close()))
  }

  onClose(): void {
    this.closed = true
    this.contentEl.empty()
  }
}
