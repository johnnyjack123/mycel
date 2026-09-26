import { App, Modal, Notice, Setting, type TFile } from 'obsidian'
import type { ShareRole } from '@obsidian-connect/shared'
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
    private readonly docId: string
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

    new Setting(contentEl)
      .setName('Account ID')
      .setDesc('The server knows no names. The other person finds their account ID in their Obsidian Connect settings.')
      .addText((text) =>
        text.setValue(this.person).onChange((value) => {
          this.person = value.trim().toLowerCase()
        })
      )

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
      new Notice(`${this.file.basename} is shared with ${this.person}.`)
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
