import { App, Modal, Setting } from 'obsidian'
import type { JoinChoice, JoinPlan, JoinResult, JoinSide, JoinStage } from '../sync/Joining'

/** What the window says about where things are. */
export interface JoinModalInfo {
  /** The vault's name on the server. */
  vaultName: string
  /** Where the copy of the vault goes. */
  backupFolder: string
  retentionDays(): number
  /** "Try again" after a copy that failed. */
  again(): void
}

/** Paths listed per group; a vault of thousands lists the first ones. */
const LISTED_MAX = 300

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function notesAndFiles(notes: number, files: number): string {
  return `${count(notes, 'note', 'notes')} and ${count(files, 'file', 'files')}`
}

/**
 * A device meeting a vault on the server for the first time (`Joining`): the comparison while it
 * runs, what it found with what each choice does, the copy and the choice being carried out, and
 * what came of it - one window over everything, from the first step to the last. Closed while
 * comparing, it comes back with what was found; closed while a choice is carried out, it comes
 * back to say it is done. Closed while asking, it decides nothing: the sync waits.
 */
export class JoinModal extends Modal {
  private plan: JoinPlan | null = null
  private result: JoinResult | null = null
  private stage: { stage: JoinStage; done: number; total: number } | null = null
  private resolve: ((choice: JoinChoice) => void) | null = null
  private shown = false
  /** Closed by the person while nothing was asked: not opened again for progress alone. */
  private dismissed = false
  private progressEl: HTMLElement | null = null

  constructor(
    app: App,
    private readonly info: JoinModalInfo,
    /** Closed with nothing more to come. */
    private readonly gone: () => void
  ) {
    super(app)
  }

  progress(stage: JoinStage, done: number, total: number): void {
    const before = this.stage?.stage
    this.stage = { stage, done, total }
    if (this.resolve || this.result) return
    if (!this.shown) {
      if (!this.dismissed) this.open()
      return
    }
    if (before === stage && this.progressEl) this.progressEl.setText(this.progressText())
    else this.render()
  }

  ask(plan: JoinPlan): Promise<JoinChoice> {
    this.plan = plan
    this.result = null
    this.dismissed = false
    return new Promise((resolve) => {
      this.resolve = resolve
      if (this.shown) this.render()
      else this.open()
    })
  }

  finished(result: JoinResult): void {
    this.result = result
    this.dismissed = false
    if (this.shown) this.render()
    else this.open()
  }

  onOpen(): void {
    this.shown = true
    this.modalEl.addClass('mycel-join')
    this.render()
  }

  onClose(): void {
    this.shown = false
    this.contentEl.empty()
    this.progressEl = null
    if (this.resolve) {
      const resolve = this.resolve
      this.resolve = null
      resolve('later')
      this.gone()
    } else if (this.result) {
      this.gone()
    } else {
      this.dismissed = true
    }
  }

  private pick(choice: JoinChoice): void {
    const resolve = this.resolve
    if (!resolve) return
    this.resolve = null
    resolve(choice)
    if (choice === 'later') {
      this.result = null
      this.close()
      this.gone()
      return
    }
    this.stage = null
    this.renderWorking()
  }

  private render(): void {
    if (!this.shown) return
    this.contentEl.empty()
    this.progressEl = null
    if (this.result) this.renderResult(this.result)
    else if (this.resolve && this.plan) this.renderPlan(this.plan)
    else this.renderWorking()
  }

  private progressText(): string {
    const stage = this.stage
    if (!stage) return 'Starting…'
    if (stage.total === 0) return 'Nothing to do.'
    return `${stage.done} of ${stage.total}`
  }

  private renderWorking(): void {
    const { contentEl } = this
    contentEl.empty()
    const stage = this.stage?.stage ?? null
    if (stage === null) {
      // Chosen a moment ago: the copy or the choice takes over from here.
      this.titleEl.setText('Connecting this vault')
      contentEl.createEl('p', { text: 'One moment…' })
      return
    }
    if (stage === 'compare') {
      this.titleEl.setText('Comparing this vault with the server')
      contentEl.createEl('p', {
        text: `This device has not synced with "${this.info.vaultName}" on the server before. Mycel compares the two first - every note and file both have is read on both sides. Nothing is changed meanwhile.`
      })
    } else if (stage === 'backup') {
      this.titleEl.setText('Copying this vault')
      contentEl.createEl('p', { text: `A copy of every file of this vault, before anything is changed, into ${this.info.backupFolder}.` })
    } else {
      this.titleEl.setText("Taking the server's version")
      contentEl.createEl('p', { text: 'Notes and files that differ take the server\'s version; what only this vault has goes to the trash.' })
    }
    this.progressEl = contentEl.createEl('p', { cls: 'mycel-join-progress', text: this.progressText() })
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        stage === 'compare'
          ? 'You can close this window; it comes back with what was found.'
          : 'You can close this window; it comes back to say when it is done.'
    })
  }

  private renderPlan(plan: JoinPlan): void {
    const { contentEl } = this
    const { notes, files } = plan
    const name = this.info.vaultName
    const differ = notes.different.length + notes.unknown.length + files.different.length
    const onlyHere = notes.onlyHere.length + files.onlyHere.length
    switch (plan.kind) {
      case 'upload':
        this.titleEl.setText('Upload this vault?')
        contentEl.createEl('p', {
          text: `"${name}" on the server is empty. This vault goes up as it is: ${notesAndFiles(notes.onlyHere.length, files.onlyHere.length)}.`
        })
        break
      case 'download':
        this.titleEl.setText('Download the vault?')
        contentEl.createEl('p', {
          text: `This vault is empty. Everything comes from "${name}" on the server: ${notesAndFiles(notes.onlyThere.length, files.onlyThere.length)}.`
        })
        break
      case 'same':
        this.titleEl.setText('This vault matches the server')
        contentEl.createEl('p', {
          text: `Every note and file this vault has, "${name}" on the server has alike.${
            notes.onlyThere.length + files.onlyThere.length > 0
              ? ` What only the server has comes down: ${notesAndFiles(notes.onlyThere.length, files.onlyThere.length)}.`
              : ''
          }`
        })
        break
      case 'related':
        this.titleEl.setText('This vault and the server differ')
        contentEl.createEl('p', {
          text: `This vault and "${name}" on the server have most names in common, but not everything alike - another state of the same vault, most likely. Nothing has been changed yet.`
        })
        break
      case 'unrelated':
        this.titleEl.setText('This vault and the server have almost nothing in common')
        contentEl.createEl('p', {
          text: `Hardly a note or file has the same name in this vault and in "${name}" on the server. Nothing has been changed yet.`
        })
        contentEl.createEl('p', {
          text: 'Another vault? Choose "Not now" and give it a name of its own: Settings → Mycel → Account, "Vault on the server". A vault Obsidian has just made, with nothing but its welcome note, is best replaced by the server\'s.'
        })
        break
      case 'empty':
        break
    }

    if (plan.kind === 'same' || plan.kind === 'related' || plan.kind === 'unrelated') this.table(contentEl, plan)
    this.lists(contentEl, plan)

    if (plan.backup.files > 0) {
      const days = this.info.retentionDays()
      contentEl.createEl('p', {
        cls: 'mycel-join-backup',
        text: `Whatever you choose, a copy of every file of this vault goes first into ${this.info.backupFolder} - ${count(plan.backup.files, 'file', 'files')}, ${size(plan.backup.bytes)} - and is kept ${
          days > 0 ? `for ${count(days, 'day', 'days')}` : 'until you delete it'
        } (Settings → Mycel → All devices, "Keep backups for").`
      })
    }

    const choices = contentEl.createDiv({ cls: 'mycel-join-choices' })
    if (plan.kind === 'related' || plan.kind === 'unrelated') {
      new Setting(choices)
        .setName('Merge both')
        .setDesc(
          `Nothing is lost. What only this vault has goes up, what only the server has comes down. ${
            differ > 0
              ? `The ${count(differ, 'note or file', 'notes and files')} that differ keep both versions: a note gets the lines of both - lines deleted on one side come back - and is listed under "Notes with two versions…" to sort out; a file is kept twice.`
              : ''
          }`
        )
        .addButton((button) =>
          button
            .setButtonText('Merge')
            .setCta()
            .onClick(() => this.pick('merge'))
        )
      new Setting(choices)
        .setName("Take the server's version")
        .setDesc(
          `This vault becomes what the server has: ${count(differ, 'note or file that differs takes', 'notes and files that differ take')} the server's version${
            onlyHere > 0 ? `, and ${count(onlyHere, 'note or file', 'notes and files')} only this vault has ${onlyHere === 1 ? 'goes' : 'go'} to the trash` : ''
          }. Nothing of this vault reaches the server or your other devices. For an older copy of the vault, or a new one.`
        )
        .addButton((button) =>
          button
            .setButtonText("Take the server's")
            .setWarning()
            .onClick(() => this.pick('server'))
        )
    } else {
      const label = plan.kind === 'upload' ? 'Upload' : plan.kind === 'download' ? 'Download' : 'Connect'
      new Setting(choices).addButton((button) =>
        button
          .setButtonText(label)
          .setCta()
          .onClick(() => this.pick('merge'))
      )
    }
    new Setting(choices)
      .setName('Not now')
      .setDesc('Nothing syncs on this device until you choose. The command "Mycel: Compare this vault with the server…" brings this back.')
      .addButton((button) => button.setButtonText('Not now').onClick(() => this.pick('later')))
  }

  private table(containerEl: HTMLElement, plan: JoinPlan): void {
    const table = containerEl.createEl('table', { cls: 'mycel-join-table' })
    const head = table.createEl('tr')
    for (const label of ['', 'The same', 'Differ', 'Only here', 'Only on the server']) head.createEl('th', { text: label })
    const row = (label: string, side: JoinSide): void => {
      const tr = table.createEl('tr')
      tr.createEl('th', { text: label })
      tr.createEl('td', { text: String(side.same.length) })
      tr.createEl('td', { text: side.unknown.length > 0 ? `${side.different.length + side.unknown.length} (${side.unknown.length} not compared)` : String(side.different.length) })
      tr.createEl('td', { text: String(side.onlyHere.length) })
      tr.createEl('td', { text: String(side.onlyThere.length) })
    }
    row('Notes', plan.notes)
    row('Files', plan.files)
  }

  private lists(containerEl: HTMLElement, plan: JoinPlan): void {
    const { notes, files } = plan
    const group = (label: string, paths: string[]): void => {
      if (paths.length === 0) return
      const details = containerEl.createEl('details', { cls: 'mycel-join-list' })
      details.createEl('summary', { text: `${label} (${paths.length})` })
      const list = details.createEl('ul')
      for (const path of paths.slice(0, LISTED_MAX)) list.createEl('li', { text: path })
      if (paths.length > LISTED_MAX) list.createEl('li', { text: `and ${paths.length - LISTED_MAX} more` })
    }
    if (plan.kind === 'upload' || plan.kind === 'download') return
    group('Differ', [...notes.different, ...files.different])
    group('Not compared: the server did not answer in time', notes.unknown)
    group('Only in this vault', [...notes.onlyHere, ...files.onlyHere])
    group('Only on the server', [...notes.onlyThere, ...files.onlyThere])
  }

  private renderResult(result: JoinResult): void {
    const { contentEl } = this
    if (!result.ok) {
      this.titleEl.setText('Nothing was changed')
      contentEl.createEl('p', { text: `${result.problem}. Nothing of this vault was changed, and nothing syncs on this device yet.` })
      new Setting(contentEl)
        .addButton((button) =>
          button
            .setButtonText('Try again')
            .setCta()
            .onClick(() => {
              this.close()
              this.info.again()
            })
        )
        .addButton((button) => button.setButtonText('Close').onClick(() => this.close()))
      return
    }
    this.titleEl.setText(result.resumed ? 'Connected - finished after a restart' : 'Connected')
    if (result.choice === 'server') {
      contentEl.createEl('p', {
        text: `This vault took the server's state: ${count(result.taken, 'note or file', 'notes and files')} took the server's version, ${result.trashed} only this vault had went to the trash. What only the server has comes down now.`
      })
    } else {
      contentEl.createEl('p', { text: 'The sync runs now. A large vault takes a while; keep Obsidian open.' })
    }
    if (result.notTaken.length > 0) {
      contentEl.createEl('p', {
        text: "For these the server's version could not be had in time; they are merged instead, keeping both sides:"
      })
      const list = contentEl.createEl('ul', { cls: 'mycel-join-list' })
      for (const path of result.notTaken) list.createEl('li', { text: path })
    }
    if (result.backup) contentEl.createEl('p', { cls: 'mycel-join-backup', text: `The copy of this vault from before: ${result.backup}.` })
    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText('Close')
        .setCta()
        .onClick(() => this.close())
    )
  }
}
