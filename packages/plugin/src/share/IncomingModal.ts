import { App, Modal, Notice, Setting } from 'obsidian'
import type { IncomingShare } from '@obsidian-connect/shared'
import type { Sharing } from './Sharing.js'

/** Notes other people shared with this account that no vault has taken in yet. */
export class IncomingModal extends Modal {
  private shares: IncomingShare[] = []

  constructor(
    app: App,
    private readonly sharing: Sharing,
    private readonly vaultName: string
  ) {
    super(app)
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText('Notes shared with you')
    this.contentEl.createEl('p', { text: 'Loading…' })
    try {
      this.shares = await this.sharing.incoming()
    } catch (error) {
      console.error('[obsidian-connect] listing incoming shares failed', error)
      this.contentEl.empty()
      this.contentEl.createEl('p', { text: 'Could not reach the server.' })
      return
    }
    this.render()
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()
    if (this.shares.length === 0) {
      contentEl.createEl('p', { text: 'Nothing waiting.' })
      return
    }
    for (const share of this.shares) {
      new Setting(contentEl)
        .setName(`From ${share.owner}`)
        .setDesc(`${share.role === 'read' ? 'To read' : 'To edit'} · ${new Date(share.addedAt).toLocaleString()}`)
        .addButton((button) =>
          button
            .setButtonText(`Add to "${this.vaultName}"`)
            .setCta()
            .onClick(() => void this.accept(share))
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

  onClose(): void {
    this.contentEl.empty()
  }
}
