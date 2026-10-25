import { App, Modal, Notice, Setting, type ButtonComponent } from 'obsidian'
import type { FolderStateResponse, ShareRole } from '@obsidian-connect/shared'
import { busy } from '../busy.js'
import type { Contact } from '../sync/AccountSettings.js'
import type { Folders, MoveInQuestion, OutsideQuestion } from './Folders.js'
import type { LinkedNote } from './LinkedNotes.js'
import type { Sharing } from './Sharing.js'
import { log } from '../log.js'

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '')
}

function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? 'nobody else'
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function notes(count: number): string {
  return `${count} note${count === 1 ? '' : 's'}`
}

/**
 * Share a folder: with whom, what they may do, whether they see the past -
 * and, before anything is shared, that everything put into it later goes
 * along, and that a note deleted in it is deleted for everyone in it.
 */
export class ShareFolderModal extends Modal {
  private person = ''
  private role: ShareRole = 'write'
  private withHistory = false
  private linkedFiles: boolean
  private withLinked = false
  private state: FolderStateResponse | null = null
  private roleChosen = false

  constructor(
    app: App,
    private readonly folders: Folders,
    private readonly sharing: Sharing,
    private readonly path: string,
    private readonly contacts: Contact[],
    /** The notes outside the folder its notes link to, following their links. */
    private readonly linked: LinkedNote[] = []
  ) {
    super(app)
    this.linkedFiles = folders.linkedFilesAt(path) ?? true
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText(`Share the folder "${baseName(this.path)}"`)
    this.render()
    const shared = this.folders.folderAt(this.path)
    if (!shared) return
    this.state = await this.folders.members(shared.folderId).catch(() => null)
    const current = this.state?.members.find((member) => member.account === this.person)
    if (current && !this.roleChosen) this.role = current.role
    this.render()
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()
    const people = this.contacts.filter((contact) => contact.name || contact.localName)
    if (people.length === 0) {
      contentEl.createEl('p', { text: 'Folders are shared with contacts. Add one under Settings → Obsidian Connect → Contacts first.' })
      return
    }
    const preview = this.folders.preview(this.path)
    if (preview.nested) {
      contentEl.createEl('p', {
        text: 'This folder lies inside a shared folder, or holds one. Share the outer folder with that person instead.'
      })
      return
    }
    this.person ||= people[0]?.accountId ?? ''
    const current = this.state?.members.find((member) => member.account === this.person)

    const person = new Setting(contentEl).setName('Person').addDropdown((dropdown) => {
      for (const contact of people) dropdown.addOption(contact.accountId, contact.localName || contact.name)
      dropdown.setValue(this.person).onChange((value) => {
        this.person = value
        const theirs = this.state?.members.find((member) => member.account === value)
        if (theirs) {
          this.role = theirs.role
          this.roleChosen = false
        }
        this.render()
      })
    })
    if (current) {
      person.setDesc(
        `${this.sharing.nameOf(this.person)} already has this folder and can ${current.role === 'read' ? 'only read' : 'edit'} it. Sharing again gives them the access chosen below; what they have stays with them.`
      )
    }

    new Setting(contentEl).setName('Access').addDropdown((dropdown) =>
      dropdown
        .addOption('write', 'Can edit, add and delete')
        .addOption('read', 'Can read')
        .setValue(this.role)
        .onChange((value) => {
          this.role = value as ShareRole
          this.roleChosen = true
        })
    )

    new Setting(contentEl)
      .setName('Include the history')
      .setDesc(
        "On: they can see and restore every earlier version of the notes in it. Off: they start from the notes as they are now. A note moved into the folder later is shared from then on, either way."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.withHistory).onChange((value) => {
          this.withHistory = value
        })
      )

    new Setting(contentEl)
      .setName('Files outside the folder that its notes embed or link')
      .setDesc(
        "On: they go along too, and so do those linked later; they land in each share folder's Attachments. Files inside the folder always go along. Applies to everyone the folder is shared with."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.linkedFiles).onChange((value) => {
          this.linkedFiles = value
        })
      )
    this.renderLinked(contentEl)

    const warning = contentEl.createDiv({ cls: 'connect-folder-warning' })
    warning.createEl('p', {
      text: `Everything in this folder is shared with them - ${notes(preview.notes)} now, and its files - and everything added to it later, by you or by anyone who may edit it, goes along by itself.`
    })
    warning.createEl('p', {
      text: 'A note deleted in the folder is deleted for everyone in it. It stays in the folder\'s deleted notes for as long as the history is kept, and can be brought back from there.'
    })
    if (preview.others.length > 0) {
      contentEl.createEl('p', { text: `${notes(preview.others.length)} in it belong to someone else and stay out:` })
      const others = contentEl.createEl('ul', { cls: 'connect-linked-notes' })
      for (const path of preview.others) others.createEl('li', { text: path })
    }
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Whatever they receive stays with them: taking access away later stops new changes from reaching them, but the copy they have is theirs.'
    })

    const status = contentEl.createEl('p', { cls: 'setting-item-description connect-follow-status' })
    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText(current ? 'Share again' : 'Share the folder')
        .setCta()
        .onClick(() => void busy(button, () => this.submit(status)))
    )
  }

  /** Only when its notes link to notes outside it; those that cannot go along are listed with the reason. */
  private renderLinked(contentEl: HTMLElement): void {
    if (this.linked.length === 0) return
    const shareable = this.linked.filter((note) => note.docId).length
    const setting = new Setting(contentEl).setName('Also share the notes outside the folder that its notes link to')
    if (shareable === 0) {
      setting.setDesc(`Its notes link to ${notes(this.linked.length)} outside it, none of which can be shared:`)
    } else {
      setting
        .setDesc(
          `The ${notes(shareable)} outside the folder its notes link to go along - now, once, with the same access and history; notes linked later do not. They land in the share folder at the path of their link.`
        )
        .addToggle((toggle) =>
          toggle.setValue(this.withLinked).onChange((value) => {
            this.withLinked = value
          })
        )
    }
    const list = contentEl.createEl('ul', { cls: 'connect-linked-notes' })
    for (const note of this.linked) {
      const item = list.createEl('li', { text: note.path })
      if (note.reason) item.createSpan({ cls: 'connect-linked-reason', text: ` - ${note.reason}` })
    }
  }

  private async submit(status: HTMLElement): Promise<void> {
    if (!this.person) return
    const name = this.sharing.nameOf(this.person)
    const had = this.state?.members.find((member) => member.account === this.person)
    try {
      status.setText('Sharing…')
      await this.folders.share(
        this.path,
        this.person,
        this.role,
        this.withHistory,
        (done, total) => {
          status.setText(`Preparing the notes: ${done} of ${total}…`)
        },
        this.linkedFiles
      )
      let alongside = ''
      if (this.withLinked) {
        status.setText('Sharing the notes it links to…')
        const outcome = await this.sharing.shareLinked(this.linked, this.person, this.role, this.withHistory, this.linkedFiles)
        alongside = ` ${notes(outcome.shared)} it links to went along${outcome.failed > 0 ? `; ${notes(outcome.failed)} could not be shared, see the log` : ''}.`
      }
      new Notice(
        had
          ? `${name} can ${this.role === 'read' ? 'only read' : 'edit'} the folder ${baseName(this.path)} now.${alongside}`
          : `The folder ${baseName(this.path)} is shared with ${name}. Everything added to it later goes along.${alongside}`
      )
      this.close()
    } catch (error) {
      log.error('sharing a folder failed', error)
      status.setText('')
      new Notice(`Sharing the folder failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

/** Who has a shared folder: its owner changes access or ends the share; a member keeps a copy of their own. */
export class FolderAccessModal extends Modal {
  private state: FolderStateResponse | null = null

  constructor(
    app: App,
    private readonly folders: Folders,
    private readonly sharing: Sharing,
    private readonly folderId: string,
    private readonly path: string
  ) {
    super(app)
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText(`Access to the folder "${baseName(this.path)}"`)
    await this.reload()
  }

  private async reload(): Promise<void> {
    this.contentEl.empty()
    this.contentEl.createEl('p', { text: 'Loading…' })
    try {
      this.state = await this.folders.members(this.folderId)
    } catch (error) {
      log.error('listing access to a folder failed', error)
      this.contentEl.empty()
      this.contentEl.createEl('p', { text: 'Could not reach the server.' })
      return
    }
    this.render()
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()
    const state = this.state
    if (!state) return
    const folder = this.folders.folderAt(this.path)?.folder
    if (folder?.owner) {
      contentEl.createEl('p', {
        text: `${this.sharing.nameOf(folder.owner)} shares this folder with you; you can ${folder.role === 'read' ? 'only read' : 'edit, add and delete'} in it.`
      })
      const others = state.members.filter((member) => member.account !== this.sharing.accountId)
      if (others.length > 0) contentEl.createEl('p', { text: `It is shared with ${list(others.map((member) => this.sharing.nameOf(member.account)))} as well.` })
      contentEl.createEl('p', {
        cls: 'setting-item-description',
        text: 'Making your own copy ends the share for you and keeps every note as one of your own, with the history you could read. To keep nothing, delete the folder.'
      })
      new Setting(contentEl).addButton((button) =>
        button
          .setButtonText('Make my own copy')
          .setWarning()
          .onClick(() => void busy(button, () => this.detach()))
      )
      return
    }
    if (state.members.length === 0) {
      contentEl.createEl('p', { text: 'Only you have access to this folder.' })
    }
    for (const member of state.members) {
      new Setting(contentEl)
        .setName(this.sharing.nameOf(member.account))
        .addDropdown((dropdown) =>
          dropdown
            .addOption('write', 'Can edit, add and delete')
            .addOption('read', 'Can read')
            .setValue(member.role)
            .onChange((value) => void this.setRole(member.account, value as ShareRole))
        )
        .addButton((button) =>
          button
            .setButtonText('Remove')
            .setWarning()
            .onClick(() => void busy(button, () => this.revoke(member.account)))
        )
    }
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Removing someone stops new changes from reaching them. The copy they already have stays with them.'
    })
    if (state.members.length > 0) {
      new Setting(contentEl)
        .setName('Stop sharing the folder')
        .setDesc('Ends the share for everyone; each of them keeps the folder as their own. Your notes stay yours.')
        .addButton((button) =>
          button
            .setButtonText('Stop sharing')
            .setWarning()
            .onClick(() => void busy(button, () => this.end()))
        )
    }
  }

  private async setRole(account: string, role: ShareRole): Promise<void> {
    try {
      await this.folders.setRole(this.folderId, account, role)
      new Notice(`${this.sharing.nameOf(account)} can now ${role === 'read' ? 'only read' : 'edit'} the folder ${baseName(this.path)}.`)
    } catch (error) {
      new Notice(`Changing access failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    await this.reload()
  }

  private async revoke(account: string): Promise<void> {
    try {
      await this.folders.revoke(this.folderId, account)
      new Notice(`${this.sharing.nameOf(account)} no longer has access to the folder ${baseName(this.path)}.`)
    } catch (error) {
      new Notice(`Removing access failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    await this.reload()
  }

  private async end(): Promise<void> {
    try {
      await this.folders.end(this.folderId)
      new Notice(`The folder ${baseName(this.path)} is no longer shared. Everyone who had it keeps their copy.`)
      this.close()
    } catch (error) {
      new Notice(`Stopping the share failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async detach(): Promise<void> {
    try {
      await this.folders.detach(this.folderId)
      new Notice(`The folder ${baseName(this.path)} is now yours. The share ended for you; the others keep theirs.`)
      this.close()
    } catch (error) {
      new Notice(`Making a copy failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

/**
 * Over everything, on every device of the account until answered on one: a
 * note moved into a shared folder becomes visible to the others only once
 * someone said so. Answered elsewhere, or moved again, it closes by itself.
 */
export class MoveInModal extends Modal {
  private answer: 'share' | 'back' | null = null
  private settle: (answer: 'share' | 'back' | null) => void = () => undefined
  readonly answered: Promise<'share' | 'back' | null>

  constructor(
    app: App,
    private readonly question: MoveInQuestion
  ) {
    super(app)
    this.answered = new Promise((resolve) => {
      this.settle = resolve
    })
    void question.moot.then(() => this.close())
  }

  onOpen(): void {
    const { question } = this
    const note = baseName(question.path)
    const folder = baseName(question.folderPath)
    this.titleEl.setText(question.copy ? `Copy "${note}" into the shared folder?` : `Share "${note}"?`)
    const { contentEl } = this
    const everyone = question.people.length > 0 ? `everyone the folder is shared with - ${list(question.people)} -` : 'everyone the folder is shared with'
    contentEl.createEl('p', {
      text: question.copy
        ? `"${note}" was moved into "${folder}", a folder someone shares with you. Copied in, it becomes a note of the folder, owned by the folder's owner, and ${everyone} can read it and everything written in it from then on. Your own note ends here. Its earlier versions do not go along: the folder gets the text as it is now, and its history stays with you.`
        : `"${note}" was moved into "${folder}", which you share. Shared, ${everyone} sees it and everything written in it from now on. Its earlier versions stay yours: nobody sees what it said before.`
    })
    if (question.files.length > 0) {
      contentEl.createEl('p', {
        text: `It embeds or links ${question.files.length === 1 ? 'a file' : `${question.files.length} files`} outside the folder, which go${question.files.length === 1 ? 'es' : ''} along with it - everyone in the folder gets ${question.files.length === 1 ? 'it' : 'them'}:`
      })
      const files = contentEl.createEl('ul', { cls: 'connect-linked-notes' })
      for (const file of question.files) files.createEl('li', { text: file })
    }
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Until you decide it stays here, unshared. Moved back, nobody ever sees it.'
    })
    const buttons: ButtonComponent[] = []
    new Setting(contentEl)
      .addButton((button) => {
        buttons.push(button)
        button.setButtonText('Move it back').onClick(() => this.choose('back'))
      })
      .addButton((button) => {
        buttons.push(button)
        button
          .setButtonText(question.copy ? 'Copy it in' : 'Share it')
          .setCta()
          .onClick(() => this.choose('share'))
      })
  }

  private choose(answer: 'share' | 'back'): void {
    this.answer = answer
    this.close()
  }

  onClose(): void {
    this.contentEl.empty()
    this.settle(this.answer)
  }
}

/** After a crash: a note of the owner's lies outside its shared folder while still shared there. */
export class OutsideModal extends Modal {
  private answer: 'end' | 'back' | null = null
  private settle: (answer: 'end' | 'back' | null) => void = () => undefined
  readonly answered: Promise<'end' | 'back' | null>

  constructor(
    app: App,
    private readonly question: OutsideQuestion
  ) {
    super(app)
    this.answered = new Promise((resolve) => {
      this.settle = resolve
    })
    void question.moot.then(() => this.close())
  }

  onOpen(): void {
    const note = baseName(this.question.path)
    const folder = baseName(this.question.folderPath)
    this.titleEl.setText(`"${note}" lies outside its shared folder`)
    this.contentEl.createEl('p', {
      text: `"${note}" was moved out of "${folder}", but is still shared there with ${list(this.question.people)}. Moving it out ends its share: they keep their copy, and what you write from then on stays yours.`
    })
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Move it back').onClick(() => this.choose('back')))
      .addButton((button) =>
        button
          .setButtonText('End its share')
          .setWarning()
          .onClick(() => this.choose('end'))
      )
  }

  private choose(answer: 'end' | 'back'): void {
    this.answer = answer
    this.close()
  }

  onClose(): void {
    this.contentEl.empty()
    this.settle(this.answer)
  }
}
