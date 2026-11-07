import { App, Modal, Setting, TextComponent } from 'obsidian'
import { Notice } from '../notices.js'
import { busy, type BusyButton } from '../busy'
import { PasswordReveal } from './reveal'

/**
 * A new recovery code, its Copy button and "I have written it down" - in a
 * window of its own, and as a step of the setup wizard. `noted`: told whenever
 * the switch moves; whoever shows it lets the person on only once it is on.
 */
export function showRecoveryCode(containerEl: HTMLElement, code: string, noted: (value: boolean) => void, initially = false): void {
  containerEl.createEl('p', {
    text: 'The code alone opens your account - your name and password are not needed with it. Keep it apart from your password: on paper, or in a password manager under its own entry. It is shown only now.'
  })
  const shown = containerEl.createDiv({ cls: 'mycel-recovery-code mycel-code', text: code })
  shown.setAttr('aria-label', 'Recovery code')
  new Setting(containerEl).addButton((button) =>
    button.setButtonText('Copy').onClick(() => {
      void navigator.clipboard.writeText(code).then(
        () => new Notice('Recovery code copied.'),
        () => new Notice('Copying failed; select the code and copy it by hand.')
      )
    })
  )
  new Setting(containerEl).setName('I have written it down').addToggle((toggle) => toggle.setValue(initially).onChange(noted))
}

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
    let noted = false
    let done: { setDisabled(disabled: boolean): unknown } | null = null
    showRecoveryCode(this.contentEl, this.code, (value) => {
      noted = value
      done?.setDisabled(!noted)
    })
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
    let action: BusyButton | null = null
    text.inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void this.submit(action)
    })
    new Setting(this.contentEl).addButton((button) => {
      action = button
      button.setButtonText(this.action).onClick(() => void this.submit(button))
      if (this.warning) button.setWarning()
      else button.setCta()
    })
    window.setTimeout(() => text.inputEl.focus(), 0)
  }

  private async submit(button: BusyButton | null): Promise<void> {
    if (this.busy || !this.password) return
    this.busy = true
    try {
      await busy(button, () => this.run(this.password))
      this.close()
    } catch (error) {
      new Notice(`Mycel: ${error instanceof Error ? error.message : String(error)}`, 8_000)
    } finally {
      this.busy = false
    }
  }

  onClose(): void {
    this.password = ''
    this.contentEl.empty()
  }
}
