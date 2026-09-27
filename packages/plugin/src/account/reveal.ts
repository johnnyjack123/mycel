import type { ExtraButtonComponent, Setting } from 'obsidian'

/**
 * Shows or hides every password field of one form together, with an eye
 * button next to each. A generated password is shown at first so it can go
 * into a password manager, and can be hidden again like any other.
 */
export class PasswordReveal {
  private readonly inputs: HTMLInputElement[] = []
  private readonly buttons: ExtraButtonComponent[] = []

  constructor(private shown = false) {}

  get revealed(): boolean {
    return this.shown
  }

  /** Makes `input` a password field of this form, with its button on `setting`. */
  attach(setting: Setting, input: HTMLInputElement): void {
    this.inputs.push(input)
    input.type = this.shown ? 'text' : 'password'
    setting.addExtraButton((button) => {
      this.buttons.push(button)
      this.label(button)
      button.onClick(() => this.set(!this.shown))
    })
  }

  set(shown: boolean): void {
    this.shown = shown
    for (const input of this.inputs) input.type = shown ? 'text' : 'password'
    for (const button of this.buttons) this.label(button)
  }

  private label(button: ExtraButtonComponent): void {
    button.setIcon(this.shown ? 'eye-off' : 'eye').setTooltip(this.shown ? 'Hide password' : 'Show password')
  }
}
