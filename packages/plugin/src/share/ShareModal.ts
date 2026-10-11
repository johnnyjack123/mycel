import { App, Modal, Notice, Setting, type TFile } from 'obsidian'
import type { ShareRole } from '@obsidian-connect/shared'
import { formatSize } from '../history/media.js'
import type { Contact } from '../sync/AccountSettings.js'
import type { Sharing } from './Sharing.js'
import { log } from '../log.js'

/** Share this note: with whom, what they may do, whether they see the past, and whether its files go along. */
export class ShareModal extends Modal {
  private person = ''
  private role: ShareRole = 'write'
  private withHistory = false
  private withAttachments = true
  /** Shared already: the files' choice was made then, and applies to everyone in it. */
  private attachmentsChosen: boolean | null = null
  private busy = false

  constructor(
    app: App,
    private readonly sharing: Sharing,
    private readonly file: TFile,
    private readonly docId: string,
    /** Only contacts: their keys are pinned, and the server shares with nobody else. */
    private readonly contacts: Contact[],
    /** The files the note embeds or links, as they stand; null while attachments do not sync. */
    private readonly files: { count: number; bytes: number } | null
  ) {
    super(app)
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText(`Share "${this.file.basename}"`)
    this.render()
    if (!this.files) return
    this.attachmentsChosen = await this.sharing.attachmentsShared(this.docId).catch(() => null)
    if (this.attachmentsChosen !== null) this.withAttachments = this.attachmentsChosen
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

    new Setting(contentEl).setName('Person').addDropdown((dropdown) => {
      for (const contact of people) dropdown.addOption(contact.accountId, contact.localName || contact.name)
      dropdown.setValue(this.person).onChange((value) => {
        this.person = value
      })
    })

    new Setting(contentEl)
      .setName('Access')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('write', 'Can edit')
          .addOption('read', 'Can read')
          .setValue(this.role)
          .onChange((value) => {
            this.role = value as ShareRole
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

    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Whatever they receive stays with them: taking access away later stops new changes from reaching them, but the copy they have is theirs.'
    })

    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText('Share')
        .setCta()
        .onClick(() => void this.submit())
    )
  }

  private async submit(): Promise<void> {
    if (this.busy || !this.person) return
    this.busy = true
    try {
      await this.sharing.share(this.docId, this.person, this.role, this.withHistory, this.files ? this.withAttachments : undefined)
      new Notice(`${this.file.basename} is shared with ${this.sharing.nameOf(this.person)}.`)
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
