import { App, Modal, Setting, setIcon } from 'obsidian'
import type { JoinChoice, JoinPlan, JoinResult, JoinSide, JoinStage } from '../sync/Joining'
import { ConfirmModal } from './TimeMachineModals.js'

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
  /** What was chosen here, for the words while it is carried out. */
  private chosen: JoinChoice | null = null
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
    this.chosen = choice
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
    } else if (this.chosen === 'here') {
      this.titleEl.setText('Overwriting the server with this vault')
      contentEl.createEl('p', {
        text: "Notes and files that differ go up in this vault's version, the server's backed up first; what only the server has is deleted there."
      })
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
    if (plan.kind === 'related' || plan.kind === 'unrelated') this.summary(contentEl, plan)
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
          differ > 0
            ? 'Nothing is lost: what only one side has goes to the other, and what differs keeps both versions, as listed above.'
            : 'Nothing is lost: what only one side has goes to the other.'
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
      this.overwriteChoice(choices, plan)
    } else {
      const label = plan.kind === 'upload' ? 'Upload' : plan.kind === 'download' ? 'Download' : 'Connect'
      new Setting(choices).addButton((button) =>
        button
          .setButtonText(label)
          .setCta()
          .onClick(() => this.pick('merge'))
      )
      // The same state, but the server has more: what it has besides may be what went wrong.
      if (plan.kind === 'same' && plan.notes.onlyThere.length + plan.files.onlyThere.length > 0) this.overwriteChoice(choices, plan)
    }
    new Setting(choices)
      .setName('Not now')
      .setDesc('Nothing syncs on this device until you choose. The command "Mycel: Compare this vault with the server…" brings this back.')
      .addButton((button) => button.setButtonText('Not now').onClick(() => this.pick('later')))
  }

  /**
   * The other direction of taking the server's version (the user, 2026-11-13; built 0.9.33): for
   * when the server's state went wrong. Asked again before: it changes the vault for every device.
   */
  private overwriteChoice(containerEl: HTMLElement, plan: JoinPlan): void {
    const { notes, files } = plan
    const differ = notes.different.length + notes.unknown.length + files.different.length
    const gone = notes.onlyThere.length + files.onlyThere.length
    const what = [
      differ > 0 ? `${count(differ, 'note or file that differs takes', 'notes and files that differ take')} this vault's version` : '',
      gone > 0 ? `${count(gone, 'note or file', 'notes and files')} only the server has ${gone === 1 ? 'is' : 'are'} deleted there` : ''
    ]
      .filter(Boolean)
      .join(', and ')
    new Setting(containerEl)
      .setName('Overwrite the server with this vault')
      .setDesc(
        `The server becomes what this vault has${what ? `: ${what}` : ''}. Your other devices follow; what was changed on them since stays. What the server had stays restorable from the trash and the Time Machine. Notes others shared with you and shared folders are merged as ever. For when the server's state went wrong.`
      )
      .addButton((button) =>
        button
          .setButtonText('Overwrite the server')
          .setWarning()
          .onClick(() => void this.confirmOverwrite(what))
      )
  }

  private async confirmOverwrite(what: string): Promise<void> {
    const sure = await new ConfirmModal(
      this.app,
      'Overwrite the server with this vault?',
      `${what ? `${what.charAt(0).toUpperCase()}${what.slice(1)}. ` : ''}This changes the vault for all your devices, not only this one. A copy of this vault is made first, and what the server had stays restorable from the trash and the Time Machine.`,
      'Overwrite the server'
    ).ask()
    if (sure) this.pick('here')
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

  /**
   * What "Merge both" does, before it is chosen: how much merges by itself and how much
   * is worth a look (the user, 2026-11-17) - told apart by `JoinPlan.merges`, which is what
   * the merge will do.
   */
  private summary(containerEl: HTMLElement, plan: JoinPlan): void {
    const { notes, files, merges } = plan
    const box = containerEl.createDiv({ cls: 'mycel-join-summary' })
    box.createDiv({ cls: 'mycel-join-summary-title', text: 'If you merge both' })
    const line = (icon: string, cls: string, text: string): void => {
      const row = box.createDiv({ cls: `mycel-join-summary-row ${cls}` })
      setIcon(row.createSpan({ cls: 'mycel-join-summary-icon' }), icon)
      row.createSpan({ text })
    }
    const alike = notes.same.length + files.same.length
    const up = notes.onlyHere.length + files.onlyHere.length
    const down = notes.onlyThere.length + files.onlyThere.length
    if (alike + up + down > 0) {
      const parts = [
        alike > 0 ? `${alike} alike on both sides` : '',
        up > 0 ? `${up} only in this vault, which go${up === 1 ? 'es' : ''} up` : '',
        down > 0 ? `${down} only on the server, which come${down === 1 ? 's' : ''} down` : ''
      ].filter(Boolean)
      line('check', 'is-fine', `Nothing to decide for ${count(alike + up + down, 'note or file', 'notes and files')}: ${parts.join(', ')}.`)
    }
    const longer = merges.server.length + merges.here.length
    if (longer > 0) {
      line(
        'check',
        'is-fine',
        `${count(longer, 'note differs', 'notes differ')} only by text one side added: one version holds all of the other, and the note becomes that longer version - most likely right. A passage deleted on one side since comes back.`
      )
    }
    if (merges.both.length > 0) {
      line(
        'alert-triangle',
        'is-look',
        `${count(merges.both.length, 'note has', 'notes have')} text of its own on both sides. Every passage of both is kept, one after the other - worth a look.`
      )
    }
    if (files.different.length > 0) {
      line(
        'alert-triangle',
        'is-look',
        `${count(files.different.length, 'file differs', 'files differ')} - a canvas, a picture, a PDF are not merged: each is kept twice, under its name and as "name (conflict date time)".`
      )
    }
    if (notes.unknown.length > 0) {
      line('help-circle', 'is-look', `${count(notes.unknown.length, 'note', 'notes')} could not be compared - the server did not answer in time. Merged like the others.`)
    }
    if (notes.different.length + notes.unknown.length > 0) {
      box.createDiv({
        cls: 'mycel-join-summary-note',
        text: 'Every note that is merged gets a mark in the file explorer. "Compare versions" in its menu shows both versions and lets you choose per passage; "Done" there takes the mark away.'
      })
    }
  }

  private lists(containerEl: HTMLElement, plan: JoinPlan): void {
    const { notes, files, merges } = plan
    const group = (label: string, paths: string[]): void => {
      if (paths.length === 0) return
      const details = containerEl.createEl('details', { cls: 'mycel-join-list' })
      details.createEl('summary', { text: `${label} (${paths.length})` })
      const list = details.createEl('ul')
      for (const path of paths.slice(0, LISTED_MAX)) list.createEl('li', { text: path })
      if (paths.length > LISTED_MAX) list.createEl('li', { text: `and ${paths.length - LISTED_MAX} more` })
    }
    if (plan.kind === 'upload' || plan.kind === 'download') return
    group('Notes that keep text of both sides', merges.both)
    group("Notes that become the server's longer version", merges.server)
    group("Notes that stay as this vault's longer version", merges.here)
    group('Files kept twice', files.different)
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
    } else if (result.choice === 'here') {
      contentEl.createEl('p', {
        text: `The server takes this vault's state: ${count(result.taken, 'note or file goes', 'notes and files go')} up in this vault's version, and ${count(result.trashed, 'note or file', 'notes and files')} only the server had ${result.trashed === 1 ? 'was' : 'were'} deleted there - restorable from the trash. Your other devices follow as they sync.`
      })
    } else {
      contentEl.createEl('p', { text: 'The sync runs now. A large vault takes a while; keep Obsidian open.' })
      if (result.merging > 0) {
        contentEl.createEl('p', {
          text: `${count(result.merging, 'note that differed is', 'notes that differed are')} merged as the sync reaches ${result.merging === 1 ? 'it' : 'them'}, and marked in the file explorer until you looked: "Compare versions" in a note's menu, then "Done". "Notes with two versions…" in the command palette lists them all.`
        })
      }
    }
    if (result.notTaken.length > 0) {
      contentEl.createEl('p', {
        text:
          result.choice === 'here'
            ? 'These are merged as ever instead, keeping both sides - shared with you, in a shared folder, or the server did not answer in time:'
            : "For these the server's version could not be had in time; they are merged instead, keeping both sides:"
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
