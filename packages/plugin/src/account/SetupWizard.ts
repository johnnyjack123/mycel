import { App, ButtonComponent, Modal, Setting, TextComponent } from 'obsidian'
import { Notice } from '../notices.js'
import { busy, type BusyButton } from '../busy'
import { DEFAULT_SETTINGS, type MycelSettings } from '../settings'
import { generatePassword, judgePassword } from './password'
import { describeProbe, type ServerProbe } from './probe'
import { showRecoveryCode } from './RecoveryModals'
import { PasswordReveal } from './reveal'

// A first start on a device: what Mycel is, then the server, the vault and the
// account, one at a time - through the same calls the settings tab makes, so
// the plugin ends up exactly where the tab would have left it. The vault's name
// comes before the account: signing in starts the sync at once, and a sync
// started under another name uploads the whole vault into a vault of that name.

/** What the wizard needs of the plugin. */
export interface SetupHost {
  readonly settings: MycelSettings
  saveSettings(): Promise<void>
  probeServer(): Promise<ServerProbe>
  useNewServer(): void
  signIn(username: string, password: string, signedIn?: () => void): Promise<void>
  createAccount(username: string, password: string, repeat: string, invite: string, showCode?: (code: string) => void): Promise<void>
}

type Step = 'welcome' | 'server' | 'vault' | 'account' | 'recovery' | 'done'
type Mode = 'sign-in' | 'create'

/**
 * How the first comparison with the vault on the server stands while the guide is open: it
 * starts with signing in, so it runs during the last steps, and the question it ends in waits
 * for the guide to close (`Joining`).
 */
export type JoinWatch =
  | { state: 'comparing'; done: number; total: number }
  /** A choice carried on after a restart: copying or taking the server's version. */
  | { state: 'working'; done: number; total: number }
  | { state: 'compared' }
  | { state: 'skipped'; reason: 'before' | 'empty' }

/** The dots at the top. The recovery code belongs to the account's step: only a new account has one to show. */
const DOTS: Step[] = ['welcome', 'server', 'vault', 'account', 'done']
/** A device signed in already only hears what Mycel is and where things are: connecting anew means signing out first. */
const CONNECTED_DOTS: Step[] = ['welcome', 'done']

const STRENGTH_DELAY_MS = 400

/**
 * The address as the sync needs it, a WebSocket URL. One copied from a
 * browser's address bar is the same server under http(s); a bare host name is
 * not guessed at - whether the server has TLS is for the person to know.
 */
export function serverAddress(typed: string): { address: string } | { problem: string } {
  const trimmed = typed.trim().replace(/\/+$/, '')
  if (!trimmed) return { problem: 'Enter the address of your server.' }
  const match = /^(wss?|https?):\/\/(\S+)$/i.exec(trimmed)
  const scheme = match?.[1]?.toLowerCase()
  if (!match || !scheme) return { problem: 'The address starts with wss:// - or ws:// for a server without TLS, such as one on your own network.' }
  const socket = scheme === 'https' ? 'wss' : scheme === 'http' ? 'ws' : scheme
  return { address: `${socket}://${match[2] ?? ''}` }
}

function sentence(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Names and addresses typed on a phone: no capital first letter, no autocorrect - a vault's name is compared exactly. */
function plain(input: HTMLInputElement): void {
  input.autocapitalize = 'off'
  input.spellcheck = false
  input.setAttr('autocorrect', 'off')
}

export class SetupWizard extends Modal {
  private step: Step = 'welcome'
  private readonly connected: boolean
  private address: string
  private probe: ServerProbe | null = null
  /** Bumped by every check and every edit of the address: an answer for an address since changed is dropped. */
  private probing = 0
  private statusEl: HTMLElement | null = null
  private vaultName: string
  private mode: Mode | null = null
  private username = ''
  private password = ''
  private repeat = ''
  private invite = ''
  private reveal = new PasswordReveal()
  private recoveryCode: string | null = null
  private noted = false
  /** Signed in from here: the steps before are done, and Back no longer leads to them. */
  private signedIn = false
  private working = false
  private shown = false
  private problemEl: HTMLElement | null = null
  private backButton: ButtonComponent | null = null
  private strengthTimer: number | null = null
  private joinWatch: JoinWatch | null = null
  private joinEl: HTMLElement | null = null
  private joinBar: HTMLProgressElement | null = null
  private joinCount: HTMLElement | null = null
  private closedNow: () => void = () => undefined
  /** Resolves once the guide is closed: what the first sync asks waits for it. */
  readonly closed = new Promise<void>((resolve) => {
    this.closedNow = resolve
  })

  constructor(
    app: App,
    private readonly host: SetupHost,
    /** Closed, or signed in: an open settings tab draws itself again. */
    private readonly changed: () => void
  ) {
    super(app)
    const settings = host.settings
    this.connected = Boolean(settings.username)
    // The default points at the machine itself, which on a phone is never the server.
    this.address = settings.serverUrl === DEFAULT_SETTINGS.serverUrl ? '' : settings.serverUrl
    this.vaultName = settings.vaultName || app.vault.getName()
  }

  onOpen(): void {
    this.shown = true
    this.modalEl.addClass('mycel-setup')
    this.render()
  }

  onClose(): void {
    this.shown = false
    this.stopJudging()
    this.forgetPasswords()
    this.contentEl.empty()
    // Closing is allowed, as in the code's own window; a new code can be made while signed in.
    if (this.recoveryCode && !this.noted) {
      new Notice(
        'Mycel: you did not confirm writing the recovery code down. If you did not keep it, make a new one: Settings → Mycel → Account, "Recovery code".',
        12_000
      )
    }
    this.recoveryCode = null
    this.changed()
    this.closedNow()
  }

  private go(step: Step): void {
    this.step = step
    this.render()
  }

  private render(): void {
    if (!this.shown) return
    const { contentEl } = this
    this.stopJudging()
    contentEl.empty()
    this.problemEl = null
    this.statusEl = null
    this.backButton = null
    this.joinEl = null
    this.joinBar = null
    this.joinCount = null
    // The fields are built anew; whether passwords show carries over.
    this.reveal = new PasswordReveal(this.reveal.revealed)
    this.progress(contentEl)
    if (this.step === 'welcome') this.welcomeStep(contentEl)
    else if (this.step === 'server') this.serverStep(contentEl)
    else if (this.step === 'vault') this.vaultStep(contentEl)
    else if (this.step === 'account') this.accountStep(contentEl)
    else if (this.step === 'recovery') this.recoveryStep(contentEl)
    else this.doneStep(contentEl)
  }

  private progress(containerEl: HTMLElement): void {
    const steps = this.connected ? CONNECTED_DOTS : DOTS
    const current = steps.indexOf(this.step === 'recovery' ? 'account' : this.step)
    const row = containerEl.createDiv({ cls: 'mycel-setup-progress' })
    const dots = row.createDiv({ cls: 'mycel-setup-dots', attr: { 'aria-hidden': 'true' } })
    steps.forEach((_step, index) => {
      const dot = dots.createSpan({ cls: 'mycel-setup-dot' })
      if (index < current) dot.addClass('is-done')
      if (index === current) dot.addClass('is-current')
    })
    row.createSpan({ cls: 'mycel-setup-count', text: `Step ${current + 1} of ${steps.length}` })
  }

  /**
   * Back at the left, the way on at the right, and above them the line that
   * says what went wrong - next to the button, where a phone's notice at the
   * top of the screen is easily missed.
   */
  private nav(
    containerEl: HTMLElement,
    back: (() => void) | null,
    next: { text: string; run: (button: ButtonComponent) => void; disabled?: boolean } | null,
    later: string | null = null
  ): ButtonComponent | null {
    this.problemEl = containerEl.createDiv({ cls: 'mycel-setup-problem', attr: { role: 'alert' } })
    const row = containerEl.createDiv({ cls: 'mycel-setup-nav' })
    this.backButton = back ? new ButtonComponent(row).setButtonText('Back').onClick(back) : null
    const end = row.createDiv({ cls: 'mycel-setup-nav-end' })
    if (later) new ButtonComponent(end).setButtonText(later).onClick(() => this.close())
    if (!next) return null
    const button = new ButtonComponent(end).setButtonText(next.text).setCta()
    button.onClick(() => next.run(button))
    if (next.disabled) button.setDisabled(true)
    return button
  }

  private say(text: string): void {
    this.problemEl?.setText(text)
  }

  /**
   * One action at a time, its button spinning; what went wrong is said in the
   * step. Back waits too: a server's answer arriving after it moved the wizard
   * on from wherever it had gone.
   */
  private async act(button: BusyButton | null, task: () => Promise<void>): Promise<void> {
    if (this.working) return
    this.working = true
    this.say('')
    const back = this.backButton
    back?.setDisabled(true)
    try {
      await busy(button, task)
    } catch (error) {
      this.say(sentence(error))
    } finally {
      this.working = false
      back?.setDisabled(false)
    }
  }

  /**
   * A text field on a row that takes the width a phone has; Enter goes on.
   * `secret`: a password field of the step, with its eye, and what a password
   * manager should offer for it.
   */
  private field(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    value: string,
    set: (value: string) => void,
    enter: () => void,
    secret: 'current-password' | 'new-password' | null = null
  ): TextComponent {
    const setting = new Setting(containerEl).setName(name)
    if (desc) setting.setDesc(desc)
    setting.settingEl.addClass('mycel-setup-field')
    const text = new TextComponent(setting.controlEl)
    text.setValue(value).onChange(set)
    text.inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') enter()
    })
    if (secret) {
      text.inputEl.autocomplete = secret
      this.reveal.attach(setting, text.inputEl)
    }
    return text
  }

  private focus(input: HTMLInputElement): void {
    window.setTimeout(() => {
      if (this.shown) input.focus()
    }, 0)
  }

  private forgetPasswords(): void {
    this.password = ''
    this.repeat = ''
    this.reveal.set(false)
  }

  private stopJudging(): void {
    if (this.strengthTimer !== null) window.clearTimeout(this.strengthTimer)
    this.strengthTimer = null
  }

  /** The first comparison moved on: the last step says so at once, or when it is reached. */
  joinUpdate(watch: JoinWatch): void {
    const before = this.joinWatch
    this.joinWatch = watch
    const counting = watch.state === 'comparing' || watch.state === 'working'
    if (counting && before?.state === watch.state && this.joinBar && this.joinCount) {
      this.joinBar.max = Math.max(watch.total, 1)
      this.joinBar.value = watch.done
      this.joinCount.setText(this.joinCountText(watch))
      return
    }
    this.drawJoin()
  }

  private joinCountText(watch: { state: 'comparing' | 'working'; done: number; total: number }): string {
    if (watch.state === 'working') return `${watch.done} of ${watch.total}.`
    return watch.total === 0 ? 'Nothing both have to read.' : `${watch.done} of ${watch.total} compared.`
  }

  private drawJoin(): void {
    const el = this.joinEl
    if (!el) return
    el.empty()
    this.joinBar = null
    this.joinCount = null
    const watch = this.joinWatch
    const counter = (done: number, total: number, text: string): void => {
      this.joinBar = el.createEl('progress', { cls: 'mycel-setup-join-bar' })
      this.joinBar.max = Math.max(total, 1)
      this.joinBar.value = done
      this.joinCount = el.createEl('p', { cls: 'setting-item-description', text })
    }
    if (!watch) {
      el.createEl('p', {
        text: 'Mycel is reaching the vault on the server. Unless this device synced it before, it then compares the two - every note and file both have is read on both sides - and shows what it found once you close this guide. Nothing is changed before you choose what happens.'
      })
    } else if (watch.state === 'comparing') {
      el.createEl('p', { text: 'Comparing this vault with the one on the server: every note and file both have is read on both sides. Nothing is changed meanwhile.' })
      counter(watch.done, watch.total, this.joinCountText(watch))
      el.createEl('p', { cls: 'setting-item-description', text: 'You can close this guide meanwhile: what was found shows when the comparison is done. For a large vault, keep Obsidian open.' })
    } else if (watch.state === 'working') {
      el.createEl('p', { text: 'Carrying on connecting this vault, where this device stopped before.' })
      counter(watch.done, watch.total, this.joinCountText(watch))
    } else if (watch.state === 'compared') {
      el.createEl('p', { cls: 'mycel-setup-join-done', text: 'Compared. Close this guide to see what was found and choose what happens - nothing is changed before that.' })
    } else {
      el.createEl('p', {
        text:
          watch.reason === 'before'
            ? 'This device synced this vault before, so there was nothing to compare: it syncs now.'
            : 'Neither this vault nor the one on the server has anything yet, so there was nothing to compare: it syncs now.'
      })
    }
  }

  // --- the steps -------------------------------------------------------------

  private welcomeStep(containerEl: HTMLElement): void {
    this.titleEl.setText('Welcome to Mycel')
    containerEl.createEl('p', {
      text: 'Mycel keeps this vault the same on all your devices: the notes, and every other file in it - images, PDFs, canvases.'
    })
    containerEl.createEl('p', {
      text: 'Everything is encrypted on your device before it leaves it. The server stores and passes on only ciphertext: it cannot read a note, and it learns neither your name nor your password.'
    })
    // What merges and what does not, said plainly: only notes are documents that can be merged.
    const notes = containerEl.createEl('p')
    notes.createEl('strong', { text: 'Notes (.md files) are always merged' })
    notes.appendText(
      ' - also when two devices changed the same note while offline. Nothing written on either is lost: where both changed the same passage, both versions stay in the note, and "Compare versions" in its menu lets you sort them out.'
    )
    const files = containerEl.createEl('p')
    files.createEl('strong', { text: 'Every other file is not merged' })
    files.appendText(
      ' - a canvas, an image, a PDF. Changed on two devices before either saw the other\'s change, it is kept twice: one version under its name, the other beside it as "name (conflict date time)". Nothing is overwritten; bringing the two together is up to you.'
    )
    containerEl.createEl('p', { text: 'You can also share a note or a folder with people you know, and write in it together, live.' })
    if (this.connected) {
      containerEl.createEl('p', { text: 'This device is connected already. The next page says where to find what.' })
      containerEl.createEl('p', { cls: 'setting-item-description', text: 'This guide stays in the command palette: "Mycel: Set up this device…".' })
    } else {
      containerEl.createEl('p', {
        text: "Mycel needs a server: one you run yourself, or one run by someone you trust. Setting up takes a few minutes: the server's address, the vault's name, your account."
      })
      containerEl.createEl('p', {
        cls: 'setting-item-description',
        text: 'Not now? This guide stays in the command palette ("Mycel: Set up this device…") and under Settings → Mycel → Account.'
      })
    }
    this.nav(containerEl, null, { text: 'Next', run: () => this.go(this.connected ? 'done' : 'server') }, this.connected ? 'Close' : 'Not now')
  }

  private serverStep(containerEl: HTMLElement): void {
    this.titleEl.setText('Your server')
    containerEl.createEl('p', {
      text: 'The address of your Mycel server, as whoever runs it gave it to you. It starts with wss:// - or ws:// for a server without TLS, such as one on your own network.'
    })
    let next: ButtonComponent | null = null
    const check = (): void => void this.act(next, () => this.checkServer())
    const text = this.field(
      containerEl,
      'Server address',
      '',
      this.address,
      (value) => {
        this.address = value
        // An answer still on its way is for the address before.
        this.probing += 1
        this.probe = null
        this.showStatus(null)
      },
      check
    )
    text.setPlaceholder('wss://notes.example.com')
    text.inputEl.inputMode = 'url'
    plain(text.inputEl)
    this.statusEl = containerEl.createEl('p', { cls: 'mycel-setup-status' })
    this.showStatus(this.probe)
    const probe = this.probe
    if (probe?.state === 'ok' && probe.changed) {
      // As in the settings: the person decides, nothing is assumed.
      new Setting(containerEl).setDesc('Only if you know why its id changed.').addButton((button) =>
        button
          .setButtonText('Use this server')
          .setWarning()
          .onClick(
            () =>
              void this.act(button, async () => {
                this.host.useNewServer()
                await this.checkServer()
              })
          )
      )
    }
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'No server yet? It runs with Docker on a computer that is always on - see "Run the server" in the Mycel documentation.'
    })
    next = this.nav(containerEl, () => this.go('welcome'), { text: 'Check and continue', run: check })
    this.focus(text.inputEl)
  }

  /** `probe`: null says nothing; undefined says the server is being asked. */
  private showStatus(probe: ServerProbe | null | undefined): void {
    const status = this.statusEl
    if (!status) return
    status.setText(probe === null ? '' : describeProbe(probe))
    status.toggleClass('is-problem', Boolean(probe && (probe.state !== 'ok' || probe.changed)))
  }

  /** Checks the address the way the settings do, and goes on only once the server answered properly. */
  private async checkServer(): Promise<void> {
    const typed = serverAddress(this.address)
    if ('problem' in typed) throw new Error(typed.problem)
    this.address = typed.address
    const run = ++this.probing
    this.probe = null
    this.showStatus(undefined)
    // Where the settings tab keeps it too: the check asks the address the plugin knows.
    this.host.settings.serverUrl = typed.address
    await this.host.saveSettings()
    const probe = await this.host.probeServer()
    if (run !== this.probing) return
    this.probe = probe
    if (probe.state === 'ok' && !probe.changed) this.go('vault')
    else this.render()
  }

  private vaultStep(containerEl: HTMLElement): void {
    this.titleEl.setText('This vault on the server')
    containerEl.createEl('p', {
      text: 'Your account can hold several vaults. This Obsidian vault syncs with the one of this name - made on the server the first time a device names it.'
    })
    const next = (): void => void this.act(null, () => this.keepVaultName())
    const text = this.field(
      containerEl,
      'Vault name',
      '',
      this.vaultName,
      (value) => {
        this.vaultName = value
      },
      next
    )
    text.setPlaceholder(this.app.vault.getName())
    plain(text.inputEl)
    containerEl.createEl('p', {
      text: 'On each of your other devices: install Mycel, sign in with the same name and password, and give the same vault name - exactly, capitals count. That is the whole pairing: no codes to exchange, no device to approve.'
    })
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'This vault syncs on another device already? Use the name it has there: on that device, Settings → Mycel → Account, "Vault on the server" - empty there means the name of its Obsidian vault.'
    })
    this.nav(containerEl, () => this.go('server'), { text: 'Next', run: next })
    this.focus(text.inputEl)
  }

  /** Kept as the settings tab keeps it: empty for this Obsidian vault's own name, so a renamed vault follows. */
  private async keepVaultName(): Promise<void> {
    const own = this.app.vault.getName()
    const name = this.vaultName.trim()
    this.vaultName = name || own
    this.host.settings.vaultName = name === own ? '' : name
    await this.host.saveSettings()
    this.go('account')
  }

  private accountStep(containerEl: HTMLElement): void {
    this.titleEl.setText('Your account')
    containerEl.createEl('p', {
      text: 'Your password never leaves this device. It unlocks the keys your notes are encrypted with; the server gets only a key made from it, to let you sign in. So nobody can reset it - not whoever runs the server, nobody.'
    })
    if (this.mode === 'create') {
      this.createForm(containerEl)
      return
    }
    if (this.mode === 'sign-in') {
      this.signInForm(containerEl)
      return
    }
    new Setting(containerEl)
      .setName('New to Mycel?')
      .setDesc('Create an account on this server - for this device and all your others.')
      .addButton((button) => button.setButtonText('Create an account').setCta().onClick(() => this.choose('create')))
    new Setting(containerEl)
      .setName('Using Mycel on another device already?')
      .setDesc('Sign in with the name and password you use there.')
      .addButton((button) => button.setButtonText('Sign in').onClick(() => this.choose('sign-in')))
    this.nav(containerEl, () => this.go('vault'), null)
  }

  /** Switching between the forms forgets the passwords typed, as the settings tab does. */
  private choose(mode: Mode | null): void {
    this.mode = mode
    this.forgetPasswords()
    this.render()
  }

  private nameField(containerEl: HTMLElement, desc: string, enter: () => void): TextComponent {
    const text = this.field(
      containerEl,
      'Name',
      desc,
      this.username,
      (value) => {
        this.username = value.trim()
      },
      enter
    )
    text.inputEl.autocomplete = 'username'
    plain(text.inputEl)
    return text
  }

  private signInForm(containerEl: HTMLElement): void {
    let next: ButtonComponent | null = null
    // Two-factor sign-in asks for its code in a window of its own, over this one.
    const submit = (): void => void this.act(next, () => this.host.signIn(this.username, this.password, () => this.connectedNow(null)))
    const name = this.nameField(containerEl, '', submit)
    this.field(
      containerEl,
      'Password',
      '',
      this.password,
      (value) => {
        this.password = value
      },
      submit,
      'current-password'
    )
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Two-factor sign-in on? The code from your authenticator app is asked for next.'
    })
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Forgot your password or name? Your recovery code gets you back in: Settings → Mycel → Account, "Sign in…", then "Use a recovery code…".'
    })
    new Setting(containerEl).addButton((button) => button.setButtonText('No account yet? Create one').onClick(() => this.choose('create')))
    next = this.nav(containerEl, () => this.choose(null), { text: 'Sign in', run: submit })
    this.focus(name.inputEl)
  }

  private createForm(containerEl: HTMLElement): void {
    let next: ButtonComponent | null = null
    const submit = (): void =>
      void this.act(next, () =>
        // An invite the server did not ask for is not sent: the server checks any it is given.
        this.host.createAccount(this.username, this.password, this.repeat, this.inviteNeeded() ? this.invite : '', (code) => this.connectedNow(code))
      )
    const name = this.nameField(
      containerEl,
      'Only you need to remember it: the server never sees it, and someone else may use the same one - name and password together find your account.',
      submit
    )
    const first = this.field(
      containerEl,
      'Password',
      'At least 12 characters, and hard to guess - this device checks. The recovery code you get next is the only other way into your account.',
      this.password,
      (value) => {
        this.password = value
      },
      submit,
      'new-password'
    )
    const strength = containerEl.createDiv({ cls: 'mycel-setup-strength', attr: { 'aria-live': 'polite' } })
    for (const input of [name.inputEl, first.inputEl]) input.addEventListener('input', () => this.judgeSoon(strength))
    const second = this.field(
      containerEl,
      'Password again',
      '',
      this.repeat,
      (value) => {
        this.repeat = value
      },
      submit,
      'new-password'
    )
    new Setting(containerEl)
      .setDesc('Or let this device make one: 20 random characters. Keep it in a password manager.')
      .addButton((button) =>
        button.setButtonText('Generate').onClick(() => {
          const generated = generatePassword()
          this.password = generated
          this.repeat = generated
          first.setValue(generated)
          second.setValue(generated)
          // Shown, so it can go into a password manager; the eye hides it again.
          this.reveal.set(true)
          this.judgeSoon(strength)
        })
      )
    if (this.inviteNeeded()) {
      const invite = this.field(
        containerEl,
        'Invite code',
        'This server creates accounts only with a code from whoever runs it (mycel invite).',
        this.invite,
        (value) => {
          this.invite = value.trim()
        },
        submit
      )
      plain(invite.inputEl)
    }
    new Setting(containerEl).addButton((button) => button.setButtonText('I already have an account').onClick(() => this.choose('sign-in')))
    next = this.nav(containerEl, () => this.choose(null), { text: 'Create account', run: submit })
    this.focus(name.inputEl)
  }

  /** Shown only once the server said it wants one, as in the settings. */
  private inviteNeeded(): boolean {
    return this.probe?.state === 'ok' && this.probe.registration === 'invite'
  }

  /**
   * The check creating the account makes anyway, said while typing: on a phone,
   * a password refused only after the click is typed twice more.
   */
  private judgeSoon(line: HTMLElement): void {
    this.stopJudging()
    line.setText('')
    line.removeClass('is-ok')
    if (!this.password) return
    this.strengthTimer = window.setTimeout(() => {
      this.strengthTimer = null
      const verdict = judgePassword(this.password, [this.username])
      line.setText(verdict.ok ? 'Strong enough.' : (verdict.reason ?? ''))
      line.toggleClass('is-ok', verdict.ok)
    }, STRENGTH_DELAY_MS)
  }

  /** The account is open: the sync starts behind this window, and the wizard goes on meanwhile. */
  private connectedNow(code: string | null): void {
    this.signedIn = true
    this.recoveryCode = code
    this.noted = false
    this.forgetPasswords()
    this.changed()
    this.go(code ? 'recovery' : 'done')
  }

  private recoveryStep(containerEl: HTMLElement): void {
    this.titleEl.setText('Your recovery code')
    containerEl.createEl('p', {
      text: 'Your account is ready. Nobody can reset your password, so this code is the only way back in if you forget it - or the name you signed up with.'
    })
    containerEl.createEl('p', {
      text: 'Why apart from your password: the code needs nothing else - not your name, not your password, not a code from an authenticator app once you turn on two-factor sign-in. Kept together, one find gives someone all of it, and one loss takes both from you. Kept apart, losing one still leaves you the other.'
    })
    let next: ButtonComponent | null = null
    showRecoveryCode(
      containerEl,
      this.recoveryCode ?? '',
      (value) => {
        this.noted = value
        next?.setDisabled(!value)
      },
      this.noted
    )
    next = this.nav(containerEl, null, { text: 'Next', run: () => this.go('done'), disabled: !this.noted })
  }

  private doneStep(containerEl: HTMLElement): void {
    const settings = this.host.settings
    this.titleEl.setText(this.connected ? 'This device is set up' : 'Mycel is set up')
    if (settings.username) {
      containerEl.createEl('p', {
        text: `Signed in as ${settings.username} at ${settings.serverUrl}. This vault syncs with "${settings.vaultName || this.app.vault.getName()}" there.`
      })
    }
    if (!settings.syncEnabled) {
      containerEl.createEl('p', { text: 'Syncing is turned off on this device: Settings → Mycel → This device, "Sync this vault".' })
    } else if (this.signedIn) {
      this.joinEl = containerEl.createDiv({ cls: 'mycel-setup-join' })
      this.drawJoin()
    }
    if (this.connected) {
      containerEl.createEl('p', {
        cls: 'setting-item-description',
        text: 'To connect this device to another server or account, sign out first: Settings → Mycel → Account.'
      })
    }
    new Setting(containerEl).setName('What next').setHeading()
    const list = containerEl.createEl('ul', { cls: 'mycel-setup-next' })
    const item = (label: string, text: string): void => {
      const entry = list.createEl('li')
      entry.createEl('strong', { text: label })
      entry.appendText(` - ${text}`)
    }
    item('Your other devices', 'install Mycel there, sign in with the same name and password, and give the same vault name.')
    item(
      'The cloud',
      "in the status bar shows whether the note in front is synced; click it for what Mycel does with that note. Every note's menu - its …, a right-click, the file explorer - has a section for Mycel too, which is where a phone has it."
    )
    item('Sharing', 'with contacts only. Exchange a friend code under Settings → Mycel → Contacts, then "Share this note…" in a note\'s menu - or share a whole folder.')
    item('Backups', 'optional: a backup server of your own keeps every version, for as long as you choose. Settings → Mycel → Backups.')
    item('Two-factor sign-in', 'optional: signing in on a device also asks for a code from an authenticator app. Settings → Mycel → Account.')
    item('Everything else', 'Settings → Mycel. This guide again: the command "Mycel: Set up this device…".')
    const back = this.connected ? () => this.go('welcome') : this.recoveryCode ? () => this.go('recovery') : null
    this.nav(containerEl, back, { text: 'Finish', run: () => this.close() })
  }
}
