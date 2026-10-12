import { App, Modal, Notice, Setting, TextComponent } from 'obsidian'
import { generatePassword, judgePassword } from './password'
import { PasswordReveal } from './reveal'

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
    const reveal = new PasswordReveal()
    const field = (name: string, set: (value: string) => void): HTMLInputElement => {
      const setting = new Setting(this.contentEl).setName(name)
      const text = new TextComponent(setting.controlEl)
      text.onChange(set)
      reveal.attach(setting, text.inputEl)
      return text.inputEl
    }
    field('Current password', (value) => {
      this.current = value
    })
    const nextInput = field('New password', (value) => {
      this.next = value
    })
    const repeatInput = field('New password again', (value) => {
      this.repeat = value
    })
    new Setting(this.contentEl)
      .setDesc('Or let this device make one: 20 random characters. Keep it in a password manager.')
      .addButton((button) =>
        button.setButtonText('Generate').onClick(() => {
          const generated = generatePassword()
          this.next = generated
          this.repeat = generated
          for (const input of [nextInput, repeatInput]) input.value = generated
          reveal.set(true)
        })
      )
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
    const verdict = judgePassword(this.next)
    if (!verdict.ok) {
      new Notice(verdict.reason ?? 'Choose another password.')
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
