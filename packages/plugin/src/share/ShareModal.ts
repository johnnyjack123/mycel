import { App, Modal, Notice, Setting, type TFile } from 'obsidian'
import type { ShareRole } from '@obsidian-connect/shared'
import type { Contact } from '../sync/AccountSettings.js'
import type { Sharing } from './Sharing.js'

/** Share this note: with whom, what they may do, and whether they see the past. */
export class ShareModal extends Modal {
  private person = ''
  private role: ShareRole = 'write'
  private withHistory = false
  private busy = false

  constructor(
    app: App,
    private readonly sharing: Sharing,
    private readonly file: TFile,
    private readonly docId: string,
    /** Only contacts: their keys are pinned, and the server shares with nobody else. */
    private readonly contacts: Contact[]
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText(`Share "${this.file.basename}"`)
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
      await this.sharing.share(this.docId, this.person, this.role, this.withHistory)
      new Notice(`${this.file.basename} is shared with ${this.sharing.nameOf(this.person)}.`)
      this.close()
    } catch (error) {
      console.error('[obsidian-connect] sharing failed', error)
      new Notice(`Sharing failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.busy = false
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
