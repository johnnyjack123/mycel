import { App, Modal, Notice, Setting, TextComponent } from 'obsidian'
import { PasswordReveal } from './reveal'

/**
 * Shows a recovery code, once: it is not kept anywhere it could be shown
 * again. "Done" waits for the person to say they wrote it down; closing the
 * dialog otherwise is allowed - a new code can be made at any time.
 */
export class RecoveryCodeModal extends Modal {
  constructor(
    app: App,
    private readonly code: string,
    private readonly intro: string,
    /** Once the dialog is gone, however it was closed. */
    private readonly onDone: (() => void) | null = null
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText('Your recovery code')
    this.contentEl.createEl('p', { text: this.intro })
    this.contentEl.createEl('p', {
      text: 'The code alone opens your account - your name and password are not needed with it. Keep it apart from your password: on paper, or in a password manager under its own entry. It is shown only now.'
    })
    const shown = this.contentEl.createDiv({ cls: 'connect-recovery-code connect-code', text: this.code })
    shown.setAttr('aria-label', 'Recovery code')
    let noted = false
    let done: { setDisabled(disabled: boolean): unknown } | null = null
    new Setting(this.contentEl).addButton((button) =>
      button.setButtonText('Copy').onClick(() => {
        void navigator.clipboard.writeText(this.code).then(
          () => new Notice('Recovery code copied.'),
          () => new Notice('Copying failed; select the code and copy it by hand.')
        )
      })
    )
    new Setting(this.contentEl).setName('I have written it down').addToggle((toggle) =>
      toggle.setValue(false).onChange((value) => {
        noted = value
        done?.setDisabled(!noted)
      })
    )
    new Setting(this.contentEl).addButton((button) => {
      done = button
      button
        .setButtonText('Done')
        .setCta()
        .setDisabled(true)
        .onClick(() => {
          if (noted) this.close()
        })
    })
  }

  onClose(): void {
    this.contentEl.empty()
    this.onDone?.()
  }
}

/** Asks for the current password before something that replaces what the server keeps for the account. */
export class PasswordPromptModal extends Modal {
  private password = ''
  private busy = false

  constructor(
    app: App,
    private readonly title: string,
    private readonly description: string,
    private readonly action: string,
    private readonly run: (password: string) => Promise<void>,
    private readonly warning = false
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText(this.title)
    this.contentEl.createEl('p', { text: this.description })
    const reveal = new PasswordReveal()
    const setting = new Setting(this.contentEl).setName('Current password')
    const text = new TextComponent(setting.controlEl)
    text.onChange((value) => {
      this.password = value
    })
    reveal.attach(setting, text.inputEl)
    text.inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void this.submit()
    })
    new Setting(this.contentEl).addButton((button) => {
      button.setButtonText(this.action).onClick(() => void this.submit())
      if (this.warning) button.setWarning()
      else button.setCta()
    })
    window.setTimeout(() => text.inputEl.focus(), 0)
  }

  private async submit(): Promise<void> {
    if (this.busy || !this.password) return
    this.busy = true
    try {
      await this.run(this.password)
      this.close()
    } catch (error) {
      new Notice(`Obsidian Connect: ${error instanceof Error ? error.message : String(error)}`, 8_000)
    } finally {
      this.busy = false
    }
  }

  onClose(): void {
    this.password = ''
    this.contentEl.empty()
  }
}
