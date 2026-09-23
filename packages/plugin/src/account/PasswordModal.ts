import { App, Modal, Notice, Setting } from 'obsidian'

/** Asks for the current and a new password. The change itself happens on this device. */
export class PasswordModal extends Modal {
  private current = ''
  private next = ''
  private repeat = ''
  private busy = false

  constructor(
    app: App,
    private readonly change: (current: string, next: string) => Promise<void>
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText('Change password')
    const field = (name: string, set: (value: string) => void): void => {
      new Setting(this.contentEl).setName(name).addText((text) => {
        text.inputEl.type = 'password'
        text.onChange(set)
      })
    }
    field('Current password', (value) => {
      this.current = value
    })
    field('New password', (value) => {
      this.next = value
    })
    field('New password again', (value) => {
      this.repeat = value
    })
    this.contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Your other devices will ask you to sign in again. Your notes stay encrypted as they are.'
    })
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText('Change')
        .setCta()
        .onClick(() => void this.submit())
    )
  }

  private async submit(): Promise<void> {
    if (this.busy) return
    if (this.next.length < 8) {
      new Notice('Use at least 8 characters.')
      return
    }
    if (this.next !== this.repeat) {
      new Notice('The new passwords differ.')
      return
    }
    this.busy = true
    try {
      await this.change(this.current, this.next)
      new Notice('Password changed.')
      this.close()
    } catch (error) {
      new Notice(`Changing the password failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.busy = false
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
