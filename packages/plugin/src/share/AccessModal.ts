import { App, Modal, Notice, Setting, type TFile } from 'obsidian'
import type { ShareMembersResponse, ShareRole } from '@obsidian-connect/shared'
import type { Sharing } from './Sharing.js'
import { log } from '../log.js'

/** Who has access to a note of yours: change what they may do, or take access away. */
export class AccessModal extends Modal {
  private members: ShareMembersResponse | null = null

  constructor(
    app: App,
    private readonly sharing: Sharing,
    private readonly file: TFile,
    private readonly docId: string
  ) {
    super(app)
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText(`Access to "${this.file.basename}"`)
    await this.reload()
  }

  private async reload(): Promise<void> {
    this.contentEl.empty()
    this.contentEl.createEl('p', { text: 'Loading…' })
    try {
      this.members = await this.sharing.members(this.docId)
    } catch (error) {
      log.error('listing access failed', error)
      this.contentEl.empty()
      this.contentEl.createEl('p', { text: 'Could not reach the server, or this note was never synced.' })
      return
    }
    this.render()
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()
    const members = this.members
    if (!members || members.members.length === 0) {
      contentEl.createEl('p', { text: 'Only you have access to this note.' })
      return
    }
    for (const member of members.members) {
      new Setting(contentEl)
        .setName(this.sharing.nameOf(member.account))
        .addDropdown((dropdown) =>
          dropdown
            .addOption('write', 'Can edit')
            .addOption('read', 'Can read')
            .setValue(member.role)
            .onChange((value) => void this.setRole(member.account, value as ShareRole))
        )
        .addButton((button) =>
          button
            .setButtonText('Remove')
            .setWarning()
            .onClick(() => void this.revoke(member.account))
        )
    }
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Removing someone stops new changes from reaching them. The copy they already have stays with them.'
    })
  }

  private async setRole(username: string, role: ShareRole): Promise<void> {
    try {
      await this.sharing.setRole(this.docId, username, role)
      new Notice(`${this.sharing.nameOf(username)} can now ${role === 'read' ? 'only read' : 'edit'} ${this.file.basename}.`)
    } catch (error) {
      new Notice(`Changing access failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    await this.reload()
  }

  private async revoke(username: string): Promise<void> {
    try {
      await this.sharing.revoke(this.docId, username)
      new Notice(`${this.sharing.nameOf(username)} no longer has access to ${this.file.basename}.`)
    } catch (error) {
      new Notice(`Removing access failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    await this.reload()
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
