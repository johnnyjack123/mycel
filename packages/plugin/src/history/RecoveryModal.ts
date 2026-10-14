import { App, Modal, Setting } from 'obsidian'
import type { RecoveryChoice } from '../sync/Recovery'

/**
 * The server's copy of some notes is not the one this device last saw. Asks
 * which side is right; closing it decides nothing, and the question comes back
 * on the next connect.
 */
export class RecoveryModal extends Modal {
  private resolve: ((choice: RecoveryChoice | null) => void) | null = null
  private choice: RecoveryChoice | null = null

  constructor(
    app: App,
    private readonly notes: number
  ) {
    super(app)
  }

  choose(): Promise<RecoveryChoice | null> {
    return new Promise((resolve) => {
      this.resolve = resolve
      this.open()
    })
  }

  onOpen(): void {
    this.titleEl.setText('The server has other data than this device')
    const { contentEl } = this
    contentEl.createEl('p', {
      text: `For ${this.notes} note(s), the server's copy is not the one this device last saw. It lost data, or it was restored from a backup. Nothing is sent or overwritten until you choose.`
    })
    new Setting(contentEl)
      .setName('This device is right')
      .setDesc('Upload what this device has, with its history. Choose this if the server lost data.')
      .addButton((button) =>
        button
          .setButtonText('Upload')
          .setCta()
          .onClick(() => this.pick('device'))
      )
    new Setting(contentEl)
      .setName('The server is right')
      .setDesc(
        "Take the server's copy. This device's newer text goes into a backup first. Choose this if you restored the server on purpose."
      )
      .addButton((button) => button.setButtonText("Take the server's copy").onClick(() => this.pick('server')))
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Your other devices follow this choice without asking.'
    })
  }

  private pick(choice: RecoveryChoice): void {
    this.choice = choice
    this.close()
  }

  onClose(): void {
    this.contentEl.empty()
    this.resolve?.(this.choice)
    this.resolve = null
  }
}
