import { App, Modal, Setting, TextComponent } from 'obsidian'
import { Notice } from '../notices.js'
import { generatePassword, judgePassword } from './password'
import { busy, type BusyButton } from '../busy'
import { PasswordReveal } from './reveal'

/** What the window says: changing the password, or replacing every key with it. */
export interface PasswordModalTexts {
  title: string
  /** Paragraphs above the fields. */
  intro: string[]
  note: string
  button: string
  done: string
  failed: string
}

const CHANGE_TEXTS: PasswordModalTexts = {
  title: 'Change password',
  intro: [],
  note: 'Your other devices will ask you to sign in again. Your notes stay encrypted as they are.',
  button: 'Change',
  done: 'Password changed.',
  failed: 'Changing the password failed'
}

/** Asks for the current and a new password. The change itself happens on this device. */
export class PasswordModal extends Modal {
  private current = ''
  private next = ''
  private repeat = ''
  private busy = false

  constructor(
    app: App,
    private readonly change: (current: string, next: string) => Promise<void>,
    private readonly texts: PasswordModalTexts = CHANGE_TEXTS
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText(this.texts.title)
    for (const paragraph of this.texts.intro) this.contentEl.createEl('p', { text: paragraph })
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
    this.contentEl.createEl('p', { cls: 'setting-item-description', text: this.texts.note })
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText(this.texts.button)
        .setCta()
        .onClick(() => void this.submit(button))
    )
  }

  private async submit(button: BusyButton): Promise<void> {
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
      await busy(button, () => this.change(this.current, this.next))
      new Notice(this.texts.done)
      this.close()
    } catch (error) {
      new Notice(`${this.texts.failed}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.busy = false
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
