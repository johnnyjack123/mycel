import { App, Modal, Setting, type TFile } from 'obsidian'
import { Notice } from '../notices.js'
import type { ShareRole } from '@obsidian-connect/shared'
import { busy } from '../busy.js'
import { formatSize } from '../history/media.js'
import type { Contact } from '../sync/AccountSettings.js'
import type { LinkedNote } from './LinkedNotes.js'
import type { Sharing } from './Sharing.js'
import { log } from '../log.js'

/**
 * Share this note: with whom, what they may do, whether they see the past,
 * whether its files go along, and whether the notes it links to do.
 */
export class ShareModal extends Modal {
  private person = ''
  private role: ShareRole = 'write'
  private withHistory = false
  private withAttachments = true
  private withLinked = false
  /** Shared already: the files' choice was made then, and applies to everyone in it. */
  private attachmentsChosen: boolean | null = null
  /** Who has the note already, and their access; null until the server answered. */
  private members: Map<string, ShareRole> | null = null
  /** The access was picked by hand, not taken from what the person has. */
  private roleChosen = false
  private busy = false

  constructor(
    app: App,
    private readonly sharing: Sharing,
    private readonly file: TFile,
    private readonly docId: string,
    /** Only contacts: their keys are pinned, and the server shares with nobody else. */
    private readonly contacts: Contact[],
    /** The files the note embeds or links, as they stand; null while attachments do not sync. */
    private readonly files: { count: number; bytes: number } | null,
    /** The notes it links to, following their links in turn. */
    private readonly linked: LinkedNote[] = []
  ) {
    super(app)
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText(`Share "${this.file.basename}"`)
    this.render()
    const [chosen, members] = await Promise.all([
      this.files ? this.sharing.attachmentsShared(this.docId).catch(() => null) : null,
      this.sharing
        .members(this.docId)
        .then(({ members }) => new Map(members.map((member) => [member.account, member.role])))
        .catch(() => null)
    ])
    this.attachmentsChosen = chosen
    if (chosen !== null) this.withAttachments = chosen
    this.members = members
    const current = members?.get(this.person)
    if (current && !this.roleChosen) this.role = current
    this.render()
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()
    // Only contacts whose device answered: before that their name is unknown.
    const people = this.contacts.filter((contact) => contact.name || contact.localName)
    if (people.length === 0) {
      contentEl.createEl('p', {
        text: 'Notes are shared with contacts. Add one under Settings → Obsidian Connect → Contacts first.'
      })
      return
    }
    this.person ||= people[0]?.accountId ?? ''

    // Sharing again with someone who has the note is how their access changes on
    // the server, so the dialog says so and starts from what they have.
    const current = this.members?.get(this.person)
    const person = new Setting(contentEl).setName('Person').addDropdown((dropdown) => {
      for (const contact of people) dropdown.addOption(contact.accountId, contact.localName || contact.name)
      dropdown.setValue(this.person).onChange((value) => {
        this.person = value
        const theirs = this.members?.get(value)
        if (theirs) {
          this.role = theirs
          this.roleChosen = false
        }
        this.render()
      })
    })
    if (current) {
      person.setDesc(
        `${this.sharing.nameOf(this.person)} already has this note and can ${current === 'read' ? 'only read' : 'edit'} it. Sharing again gives them the access chosen below; what they have stays with them.`
      )
    }

    new Setting(contentEl)
      .setName('Access')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('write', 'Can edit')
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
        'On: they can see and restore every earlier version. Off: they start from the note as it is now. Either way they see every change from now on.'
      )
      .addToggle((toggle) =>
        toggle.setValue(this.withHistory).onChange((value) => {
          this.withHistory = value
        })
      )

    if (this.files) {
      const files = this.files
      const what =
        files.count === 0
          ? 'The note embeds or links no files yet;'
          : `${files.count} file(s) (${formatSize(files.bytes)}) the note embeds or links go along, and so do those added later;`
      new Setting(contentEl)
        .setName('Share its attachments')
        .setDesc(
          `${what} whatever the other side adds to the note comes to you. They land in your share folder's Attachments. Applies to everyone the note is shared with.`
        )
        .addToggle((toggle) =>
          toggle.setValue(this.withAttachments).onChange((value) => {
            this.withAttachments = value
          })
        )
    }

    this.renderLinked(contentEl)

    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Whatever they receive stays with them: taking access away later stops new changes from reaching them, but the copy they have is theirs.'
    })

    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText(current ? 'Share again' : 'Share')
        .setCta()
        .onClick(() => void busy(button, () => this.submit()))
    )
  }

  /** Only when it links to notes; those that cannot go along are listed with the reason. */
  private renderLinked(contentEl: HTMLElement): void {
    if (this.linked.length === 0) return
    const shareable = this.linked.filter((note) => note.docId).length
    const setting = new Setting(contentEl).setName('Also share the notes it links to')
    if (shareable === 0) {
      setting.setDesc(`It links to ${notes(this.linked.length)}, none of which can be shared:`)
    } else {
      setting
        .setDesc(
          `The ${notes(shareable)} it links to, following their links, ${shareable === 1 ? 'goes' : 'go'} along - now, once, with the same access, history and attachments; notes linked later do not. They land in the share folder at the path of their link, so the links keep working. A note they already have stays as it is.`
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

  private async submit(): Promise<void> {
    if (this.busy || !this.person) return
    this.busy = true
    try {
      const withAttachments = this.files ? this.withAttachments : undefined
      const had = this.members?.get(this.person)
      await this.sharing.share(this.docId, this.person, this.role, this.withHistory, withAttachments)
      const name = this.sharing.nameOf(this.person)
      const access = `${name} can ${this.role === 'read' ? 'only read' : 'edit'} ${this.file.basename}${had && had !== this.role ? ' now' : ''}.`
      if (this.withLinked) {
        const outcome = await this.sharing.shareLinked(this.linked, this.person, this.role, this.withHistory, withAttachments)
        const parts = [had ? access : `${this.file.basename} is shared with ${name}.`, `${notes(outcome.shared)} it links to went along.`]
        if (outcome.had > 0) parts.push(`${notes(outcome.had)} they had already stayed as they were.`)
        if (outcome.failed > 0) parts.push(`${notes(outcome.failed)} could not be shared; see the log.`)
        new Notice(parts.join(' '), outcome.failed > 0 ? 12_000 : 6_000)
      } else {
        new Notice(had ? access : `${this.file.basename} is shared with ${name}.`)
      }
      this.close()
    } catch (error) {
      log.error('sharing failed', error)
      new Notice(`Sharing failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.busy = false
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

function notes(count: number): string {
  return `${count} note${count === 1 ? '' : 's'}`
}
