import { App, Modal, Setting } from 'obsidian'
import { Notice } from '../notices.js'
import type { IncomingFolder, IncomingShare } from '@obsidian-connect/shared'
import { busy } from '../busy.js'
import type { Folders } from './Folders.js'
import type { Sharing } from './Sharing.js'
import { log } from '../log.js'

/** Notes and folders other people shared with this account that no vault has taken in yet. */
export class IncomingModal extends Modal {
  private shares: IncomingShare[] = []
  private folderShares: IncomingFolder[] = []

  constructor(
    app: App,
    private readonly sharing: Sharing,
    private readonly vaultName: string,
    private readonly folders: Folders | null = null
  ) {
    super(app)
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText('Notes shared with you')
    this.contentEl.createEl('p', { text: 'Loading…' })
    try {
      this.shares = await this.sharing.incoming()
      this.folderShares = (await this.folders?.incoming()) ?? []
    } catch (error) {
      log.error('listing incoming shares failed', error)
      this.contentEl.empty()
      this.contentEl.createEl('p', { text: 'Could not reach the server.' })
      return
    }
    this.render()
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()
    if (this.shares.length === 0 && this.folderShares.length === 0) {
      contentEl.createEl('p', { text: 'Nothing waiting.' })
      return
    }
    for (const folder of this.folderShares) {
      new Setting(contentEl)
        .setName(`A folder from ${this.sharing.nameOf(folder.owner)}`)
        .setDesc(`${folder.role === 'read' ? 'To read' : 'To edit'} · ${new Date(folder.addedAt).toLocaleString()} · everything added to it later comes along`)
        .addButton((button) =>
          button
            .setButtonText(`Add to "${this.vaultName}"`)
            .setCta()
            .onClick(() => void busy(button, () => this.acceptFolder(folder)))
        )
    }
    for (const share of this.shares) {
      new Setting(contentEl)
        .setName(`From ${this.sharing.nameOf(share.owner)}`)
        .setDesc(`${share.role === 'read' ? 'To read' : 'To edit'} · ${new Date(share.addedAt).toLocaleString()}`)
        .addButton((button) =>
          button
            .setButtonText(`Add to "${this.vaultName}"`)
            .setCta()
            .onClick(() => void busy(button, () => this.accept(share)))
        )
    }
  }

  private async accept(share: IncomingShare): Promise<void> {
    try {
      await this.sharing.accept(share)
      this.shares = this.shares.filter((candidate) => candidate.docId !== share.docId)
      this.render()
    } catch (error) {
      new Notice(`Adding the note failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async acceptFolder(folder: IncomingFolder): Promise<void> {
    try {
      await this.folders?.accept(folder)
      this.folderShares = this.folderShares.filter((candidate) => candidate.folderId !== folder.folderId)
      this.render()
    } catch (error) {
      new Notice(`Adding the folder failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
