import { App, Modal, Notice, Setting } from 'obsidian'
import { parseShareLink, type ShareLink } from '@obsidian-connect/shared'

/** Asks for a share link someone sent, for when clicking it is not an option. */
export class JoinModal extends Modal {
  private value = ''

  constructor(
    app: App,
    private readonly onJoin: (link: ShareLink) => void
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText('Open a shared note')
    this.contentEl.createEl('p', {
      text: 'Paste the link someone shared with you. The note is added to your vault and stays live between you.'
    })

    new Setting(this.contentEl).setName('Share link').addText((text) => {
      text.setPlaceholder('obsidian://connect-share?id=…').onChange((value) => {
        this.value = value
      })
      text.inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') this.submit()
      })
      text.inputEl.style.width = '100%'
    })

    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText('Open')
        .setCta()
        .onClick(() => this.submit())
    )
  }

  private submit(): void {
    const link = parseShareLink(this.value)
    if (!link) {
      new Notice('That is not a share link.')
      return
    }
    this.close()
    this.onJoin(link)
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
