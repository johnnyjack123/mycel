import { App, Modal, Notice, Setting, TextComponent } from 'obsidian'
import qrcode from 'qrcode-generator'
import { newTotpSecret, totpKeyText, totpMatches, totpUri, type Bytes } from '@obsidian-connect/shared/crypto'
import { PasswordReveal } from './reveal'

const ISSUER = 'Obsidian Connect'
const SVG = 'http://www.w3.org/2000/svg'

/** A QR code as an SVG of its own, dark on light whatever the theme: scanners need the contrast. */
function renderQr(container: HTMLElement, text: string): void {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const size = qr.getModuleCount()
  const margin = 4
  const total = size + 2 * margin
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', `0 0 ${total} ${total}`)
  svg.setAttribute('shape-rendering', 'crispEdges')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', 'QR code for your authenticator app')
  const background = document.createElementNS(SVG, 'rect')
  background.setAttribute('width', String(total))
  background.setAttribute('height', String(total))
  background.setAttribute('fill', '#ffffff')
  svg.appendChild(background)
  let d = ''
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (qr.isDark(row, column)) d += `M${column + margin} ${row + margin}h1v1h-1z`
    }
  }
  const modules = document.createElementNS(SVG, 'path')
  modules.setAttribute('d', d)
  modules.setAttribute('fill', '#000000')
  svg.appendChild(modules)
  container.createDiv({ cls: 'connect-qr' }).appendChild(svg)
}

/** A text field for a six-digit code, as phones offer to fill one in. */
function codeField(setting: Setting, onChange: (value: string) => void, onEnter: () => void): TextComponent {
  const text = new TextComponent(setting.controlEl)
  text.setPlaceholder('123456').onChange((value) => onChange(value.replace(/\s/g, '')))
  text.inputEl.inputMode = 'numeric'
  text.inputEl.autocomplete = 'one-time-code'
  text.inputEl.maxLength = 7
  text.inputEl.addClass('connect-code')
  text.inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') onEnter()
  })
  return text
}

/**
 * Asks for the code from the authenticator app while signing in. Resolves
 * with the code, or null when the dialog is closed without one.
 */
export function askTotpCode(app: App, again: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    new TotpCodeModal(app, again, resolve).open()
  })
}

class TotpCodeModal extends Modal {
  private code = ''
  private settled = false

  constructor(
    app: App,
    private readonly again: boolean,
    private readonly resolve: (code: string | null) => void
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText('Two-factor sign-in')
    this.contentEl.createEl('p', {
      text: this.again
        ? 'That code was not right, or was used already. Enter the one your authenticator app shows now.'
        : 'Your password is right. Now enter the six-digit code your authenticator app shows for Obsidian Connect.'
    })
    const field = codeField(
      new Setting(this.contentEl).setName('Code'),
      (value) => {
        this.code = value
      },
      () => this.submit()
    )
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText('Sign in')
        .setCta()
        .onClick(() => this.submit())
    )
    this.contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Lost your phone? "Use a recovery code…" on the sign-in screen gets you in without one.'
    })
    window.setTimeout(() => field.inputEl.focus(), 0)
  }

  private submit(): void {
    if (!/^\d{6}$/.test(this.code)) {
      new Notice('The code has six digits.')
      return
    }
    this.settled = true
    this.resolve(this.code)
    this.close()
  }

  onClose(): void {
    if (!this.settled) this.resolve(null)
    this.contentEl.empty()
  }
}

/** What turning two-factor sign-in on needs from the plugin. */
export interface TotpSetup {
  /** Checked on this device: the master key it derives must be the one in use. */
  checkPassword(password: string): Promise<boolean>
  hasRecoveryCode(): boolean
  makeRecoveryCode(password: string): Promise<string>
  /** What the app lists the account as. */
  label(): string
  enable(password: string, secret: Bytes, code: string): Promise<void>
}

type SetupStep = 'password' | 'recovery' | 'new-code' | 'app'

/**
 * Turning two-factor sign-in on: the password, then whether the recovery
 * code is at hand - with a lost phone it is the way back in - then the app.
 */
export class TotpSetupModal extends Modal {
  private step: SetupStep = 'password'
  private password = ''
  private code = ''
  private recoveryCode = ''
  private noted = false
  private busy = false
  private secret: Bytes | null = null

  constructor(
    app: App,
    private readonly setup: TotpSetup,
    private readonly intro: string | null = null
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText('Turn on two-factor sign-in')
    this.render()
  }

  private go(step: SetupStep): void {
    this.step = step
    this.render()
  }

  private render(): void {
    this.contentEl.empty()
    if (this.step === 'password') this.passwordStep()
    else if (this.step === 'recovery') this.recoveryStep()
    else if (this.step === 'new-code') this.newCodeStep()
    else this.appStep()
  }

  private async busyWith(task: () => Promise<void>): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await task()
    } catch (error) {
      new Notice(`Obsidian Connect: ${error instanceof Error ? error.message : String(error)}`, 8_000)
    } finally {
      this.busy = false
    }
  }

  private passwordStep(): void {
    if (this.intro) this.contentEl.createEl('p', { text: this.intro })
    this.contentEl.createEl('p', {
      text: 'Signing in on a device will also ask for a code from an authenticator app on your phone, so a password someone else learned is not enough to reach your account on the server. It guards the sign-in only: your notes stay encrypted with your password, as before.'
    })
    this.contentEl.createEl('p', {
      text: 'Your other devices are signed out when it is turned on, and sign in again with a code.'
    })
    const reveal = new PasswordReveal()
    const setting = new Setting(this.contentEl).setName('Current password')
    const text = new TextComponent(setting.controlEl)
    text.setValue(this.password).onChange((value) => {
      this.password = value
    })
    reveal.attach(setting, text.inputEl)
    const next = (): void =>
      void this.busyWith(async () => {
        if (!this.password) return
        if (!(await this.setup.checkPassword(this.password))) throw new Error('The password is not right.')
        this.go('recovery')
      })
    text.inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') next()
    })
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText('Continue')
        .setCta()
        .onClick(next)
    )
    window.setTimeout(() => text.inputEl.focus(), 0)
  }

  private recoveryStep(): void {
    const makeCode = (): void =>
      void this.busyWith(async () => {
        this.recoveryCode = await this.setup.makeRecoveryCode(this.password)
        this.noted = false
        this.go('new-code')
      })
    if (!this.setup.hasRecoveryCode()) {
      this.contentEl.createEl('p', {
        text: 'Your account has no recovery code. If you lose your phone, the recovery code is the way back in without a code - make one first.'
      })
      new Setting(this.contentEl).addButton((button) =>
        button
          .setButtonText('Make a recovery code')
          .setCta()
          .onClick(makeCode)
      )
      return
    }
    this.contentEl.createEl('p', {
      text: 'Do you still have your recovery code? If you lose your phone, it gets you back in without a code.'
    })
    new Setting(this.contentEl)
      .addButton((button) =>
        button
          .setButtonText('Yes, I have it')
          .setCta()
          .onClick(() => this.go('app'))
      )
      .addButton((button) => button.setButtonText('No, make a new one').onClick(makeCode))
  }

  private newCodeStep(): void {
    this.contentEl.createEl('p', {
      text: 'Your new recovery code - the one before it no longer works. It opens your account on its own; keep it apart from your password and your phone.'
    })
    this.contentEl.createDiv({ cls: 'connect-recovery-code connect-code', text: this.recoveryCode })
    let next: { setDisabled(disabled: boolean): unknown } | null = null
    new Setting(this.contentEl).addButton((button) =>
      button.setButtonText('Copy').onClick(() => {
        void navigator.clipboard.writeText(this.recoveryCode).then(
          () => new Notice('Recovery code copied.'),
          () => new Notice('Copying failed; select the code and copy it by hand.')
        )
      })
    )
    new Setting(this.contentEl).setName('I have written it down').addToggle((toggle) =>
      toggle.setValue(this.noted).onChange((value) => {
        this.noted = value
        next?.setDisabled(!value)
      })
    )
    new Setting(this.contentEl).addButton((button) => {
      next = button
      button
        .setButtonText('Continue')
        .setCta()
        .setDisabled(!this.noted)
        .onClick(() => {
          if (this.noted) this.go('app')
        })
    })
  }

  private appStep(): void {
    const secret = (this.secret ??= newTotpSecret())
    const uri = totpUri(secret, this.setup.label(), ISSUER)
    this.contentEl.createEl('p', {
      text: 'Add Obsidian Connect to your authenticator app (Aegis, 2FAS, Google Authenticator, …): scan the code with your phone.'
    })
    renderQr(this.contentEl, uri)
    const onPhone = this.contentEl.createEl('p', { cls: 'setting-item-description' })
    onPhone.appendText('On the phone itself? ')
    onPhone.createEl('a', { text: 'Open it in the authenticator app', href: uri })
    onPhone.appendText('. Or type the key into the app:')
    const key = totpKeyText(secret)
    new Setting(this.contentEl)
      .setName((key.match(/.{1,4}/g) ?? []).join(' '))
      .addButton((button) =>
        button.setButtonText('Copy').onClick(() => {
          void navigator.clipboard.writeText(key).then(
            () => new Notice('Key copied.'),
            () => new Notice('Copying failed; type the key by hand.')
          )
        })
      )
      .nameEl.addClass('connect-code')
    const turnOn = (): void =>
      void this.busyWith(async () => {
        if (!/^\d{6}$/.test(this.code)) throw new Error('The code has six digits.')
        // A phone with the wrong time makes codes that never fit; say so
        // before the server is asked.
        if (!(await totpMatches(secret, this.code, Date.now()))) {
          throw new Error('That code does not fit. Is the time on your phone set automatically?')
        }
        await this.setup.enable(this.password, secret, this.code)
        new Notice('Obsidian Connect: two-factor sign-in is on. Your other devices sign in again, with a code.', 10_000)
        this.close()
      })
    const field = codeField(
      new Setting(this.contentEl).setName('Code from the app'),
      (value) => {
        this.code = value
      },
      turnOn
    )
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText('Turn on')
        .setCta()
        .onClick(turnOn)
    )
    window.setTimeout(() => field.inputEl.focus(), 0)
  }

  onClose(): void {
    this.password = ''
    this.secret = null
    this.contentEl.empty()
  }
}

/** Turning two-factor sign-in off: the password and a current code. */
export class TotpOffModal extends Modal {
  private password = ''
  private code = ''
  private busy = false

  constructor(
    app: App,
    private readonly run: (password: string, code: string) => Promise<void>
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText('Turn off two-factor sign-in')
    this.contentEl.createEl('p', {
      text: 'Signing in will ask for your name and password only. Devices signed in now stay signed in.'
    })
    const reveal = new PasswordReveal()
    const setting = new Setting(this.contentEl).setName('Current password')
    const text = new TextComponent(setting.controlEl)
    text.onChange((value) => {
      this.password = value
    })
    reveal.attach(setting, text.inputEl)
    codeField(
      new Setting(this.contentEl).setName('Code from the app'),
      (value) => {
        this.code = value
      },
      () => void this.submit()
    )
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText('Turn off')
        .setWarning()
        .onClick(() => void this.submit())
    )
    window.setTimeout(() => text.inputEl.focus(), 0)
  }

  private async submit(): Promise<void> {
    if (this.busy || !this.password || !this.code) return
    this.busy = true
    try {
      await this.run(this.password, this.code)
      new Notice('Obsidian Connect: two-factor sign-in is off.')
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
