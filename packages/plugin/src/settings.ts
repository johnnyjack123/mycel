import { App, Notice, PluginSettingTab, Setting } from 'obsidian'
import { generatePassword } from './account/password'
import type { ServerProbe } from './account/probe'
import { PasswordReveal } from './account/reveal'
import type ObsidianConnectPlugin from './main'
import type { OpenCode } from './share/Contacts'
import type { SharedSettings } from './sync/AccountSettings'

/**
 * What stays on this device. Everything that must match across an account's
 * devices lives in the account settings document instead.
 */
export interface ObsidianConnectSettings {
  serverUrl: string
  /** The account this device is signed in to; empty when signed out. */
  username: string
  token: string
  /** The vault on the server this Obsidian vault syncs with; empty means its own name. */
  vaultName: string
  syncEnabled: boolean
  maxLoadedDocuments: number
  writeDebounceMs: number
  syncTimeoutMs: number
  /** Log every detail to the plugin's log file, not just what matters. */
  verboseLog: boolean
  /**
   * Attachments up to this many MB are downloaded as they come; larger ones
   * when a note needs them. Negative: everything. A phone starts at 10.
   */
  attachmentDownloadLimitMb: number
}

export const DEFAULT_SETTINGS: ObsidianConnectSettings = {
  serverUrl: 'ws://localhost:1234',
  username: '',
  token: '',
  vaultName: '',
  syncEnabled: true,
  maxLoadedDocuments: 500,
  writeDebounceMs: 700,
  syncTimeoutMs: 5_000,
  verboseLog: false,
  attachmentDownloadLimitMb: -1
}

/** Where a phone starts: its storage and data plan are not a desktop's. */
export const MOBILE_DOWNLOAD_LIMIT_MB = 10

/** Signed out, the account box leads to one of these forms, each a screen of its own. */
type Screen = 'overview' | 'sign-in' | 'create' | 'recover'

export class ObsidianConnectSettingTab extends PluginSettingTab {
  private screen: Screen = 'overview'
  private username = ''
  private password = ''
  private repeat = ''
  private recoveryCode = ''
  private reveal = new PasswordReveal()
  private invite = ''
  private contactCode = ''
  private removing: string | null = null
  private busy = false

  /** What the configured server answered; undefined while asking. */
  private probe: ServerProbe | undefined = undefined
  private probing = 0
  private probeTimer: number | null = null
  private serverStatus: Setting | null = null
  /** Signing in and creating an account: usable only once the server answered properly. */
  private gated: Array<{ setDisabled(disabled: boolean): unknown }> = []

  constructor(
    app: App,
    private readonly plugin: ObsidianConnectPlugin
  ) {
    super(app, plugin)
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()
    this.gated = []
    this.serverStatus = null
    // The fields are built anew; whether passwords show carries over.
    this.reveal = new PasswordReveal(this.reveal.revealed)
    const signedIn = Boolean(this.plugin.settings.username)
    if (signedIn) this.screen = 'overview'
    containerEl.createEl('p', { cls: 'setting-item-description', text: `Obsidian Connect ${this.plugin.manifest.version}` })

    if (this.screen === 'overview') {
      this.account(containerEl)
      this.contactsSection(containerEl)
      this.device(containerEl)
      this.shared(containerEl)
    } else {
      this.accountForm(containerEl)
    }
    if (!signedIn) {
      if (this.probe === undefined && this.probing === 0) void this.checkServer()
      else this.showProbe()
    }
  }

  /** Asked again every time the settings open: the server may have come up meanwhile. */
  hide(): void {
    if (this.probeTimer !== null) window.clearTimeout(this.probeTimer)
    this.probeTimer = null
    this.probing = 0
    this.probe = undefined
    this.removing = null
    this.forgetPasswords()
  }

  private async checkServer(): Promise<void> {
    const run = ++this.probing
    this.probe = undefined
    this.showProbe()
    const probe = await this.plugin.probeServer()
    if (run !== this.probing) return
    this.probing = 0
    const inviteFieldChanges = this.screen === 'create' && this.inviteNeeded(probe) !== this.inviteNeeded()
    this.probe = probe
    // Rebuilding would take the focus from whatever is being typed; only the
    // invite field appearing or going away needs it.
    if (inviteFieldChanges) this.display()
    else this.showProbe()
  }

  private scheduleCheck(): void {
    if (this.probeTimer !== null) window.clearTimeout(this.probeTimer)
    this.probe = undefined
    this.probing += 1
    this.showProbe()
    this.probeTimer = window.setTimeout(() => {
      this.probeTimer = null
      void this.checkServer()
    }, 700)
  }

  /**
   * Shown only once the server said it wants one. Until it answered the form
   * cannot be sent anyway, and a field that disappears again is noise.
   */
  private inviteNeeded(probe = this.probe): boolean {
    return probe?.state === 'ok' && probe.registration === 'invite'
  }

  private showProbe(): void {
    const probe = this.probe
    for (const control of this.gated) control.setDisabled(this.busy || probe?.state !== 'ok')
    if (!this.serverStatus) return
    if (!probe) {
      this.serverStatus.setDesc('Checking the server…')
    } else if (probe.state === 'ok') {
      this.serverStatus.setDesc(
        `Reachable. ${probe.registration === 'open' ? 'Anyone can create an account here.' : 'New accounts need an invite code.'}`
      )
    } else if (probe.state === 'unreachable') {
      this.serverStatus.setDesc(`Not reachable: ${probe.reason}`)
    } else {
      this.serverStatus.setDesc(probe.reason)
    }
  }

  private async run(task: () => Promise<void>): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await task()
    } catch (error) {
      new Notice(`Obsidian Connect: ${error instanceof Error ? error.message : String(error)}`, 8_000)
    } finally {
      this.busy = false
      this.display()
    }
  }

  private go(screen: Screen): void {
    this.screen = screen
    this.forgetPasswords()
    this.display()
  }

  private serverStatusRow(containerEl: HTMLElement, name: string): void {
    this.serverStatus = new Setting(containerEl)
      .setName(name)
      .addButton((button) => button.setButtonText('Check again').onClick(() => void this.checkServer()))
  }

  private account(containerEl: HTMLElement): void {
    const settings = this.plugin.settings
    new Setting(containerEl).setName('Account').setHeading()

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('WebSocket endpoint of your Obsidian Connect server, e.g. wss://notes.example.com')
      .addText((text) =>
        text
          .setPlaceholder('ws://localhost:1234')
          .setValue(settings.serverUrl)
          .setDisabled(Boolean(settings.username))
          .onChange(async (value) => {
            settings.serverUrl = value.trim()
            await this.plugin.saveSettings()
            this.scheduleCheck()
          })
      )

    const vaultName = new Setting(containerEl)
      .setName('Vault on the server')
      .setDesc(
        `Devices that name the same vault sync with each other. Empty means "${this.app.vault.getName()}". Changing it switches this vault to another one.`
      )
      .addText((text) =>
        text
          .setPlaceholder(this.app.vault.getName())
          .setValue(settings.vaultName)
          .onChange(async (value) => {
            settings.vaultName = value.trim()
            await this.plugin.saveSettings()
          })
      )
    if (settings.username) {
      vaultName.addButton((button) =>
        button.setButtonText('Switch').onClick(() => void this.run(() => this.plugin.restartSync()))
      )
    }

    if (settings.username) {
      new Setting(containerEl)
        .setName(`Signed in as ${settings.username}`)
        .setDesc(this.plugin.statusLine())
        .addButton((button) =>
          button.setButtonText('Change password').onClick(() => this.plugin.openPasswordChange())
        )
        .addButton((button) =>
          button
            .setButtonText('Sign out')
            .setWarning()
            .onClick(() => void this.run(() => this.plugin.signOut()))
        )
      this.recoveryRow(containerEl)
      this.totpRow(containerEl)
      const ids = this.plugin.ids()
      if (ids) {
        // The server knows no names; these are what it knows, and what the
        // admin's `obsidian-connect user list` shows.
        new Setting(containerEl)
          .setName('Account ID')
          .setDesc(ids.account)
          .addButton((button) =>
            button.setButtonText('Copy').onClick(() => void navigator.clipboard.writeText(ids.account))
          )
        if (ids.vault) new Setting(containerEl).setName('Vault ID').setDesc(ids.vault)
      }
      return
    }

    this.serverStatusRow(containerEl, 'Server')
    new Setting(containerEl)
      .setName('Your account')
      .setDesc('Sign in with the name and password of an existing account, or create a new one on this server.')
      .addButton((button) => button.setButtonText('Sign in…').setCta().onClick(() => this.go('sign-in')))
      .addButton((button) => button.setButtonText('Create account…').onClick(() => this.go('create')))
  }

  private recoveryRow(containerEl: HTMLElement): void {
    const recovery = this.plugin.recoveryState()
    if (!recovery) return
    const row = new Setting(containerEl).setName('Recovery code')
    if (recovery.state === 'unsupported') {
      row.setDesc('This server does not keep recovery codes yet. It needs an update.')
      return
    }
    if (recovery.state === 'none') {
      row
        .setDesc(
          'None. Without one, a forgotten password means losing access to this account: your notes stay on your devices, but they no longer sync.'
        )
        .addButton((button) =>
          button
            .setButtonText('Make one…')
            .setCta()
            .onClick(() => this.plugin.openMakeRecoveryCode())
        )
      return
    }
    row
      .setDesc(
        `Made on ${new Date(recovery.createdAt).toLocaleDateString()}. It opens this account on its own if you forget your password or name - keep it apart from both.`
      )
      .addButton((button) => button.setButtonText('Make a new one…').onClick(() => this.plugin.openMakeRecoveryCode()))
      .addButton((button) =>
        button
          .setButtonText('Delete…')
          .setWarning()
          .onClick(() => this.plugin.openDeleteRecoveryCode())
      )
  }

  private totpRow(containerEl: HTMLElement): void {
    const state = this.plugin.totpState()
    if (!state) return
    const row = new Setting(containerEl).setName('Two-factor sign-in')
    if (state === 'unsupported') {
      row.setDesc('This server does not offer two-factor sign-in yet. It needs an update.')
      return
    }
    if (state === 'off') {
      row
        .setDesc(
          'Off. When on, signing in on a device also asks for a code from an authenticator app on your phone. It guards the sign-in only: your notes are encrypted with your password either way.'
        )
        .addButton((button) => button.setButtonText('Turn on…').onClick(() => this.plugin.openTotpSetup()))
      return
    }
    row
      .setDesc('On. Signing in on a device asks for a code from your authenticator app. Lost your phone? Your recovery code gets you in without one.')
      .addButton((button) =>
        button
          .setButtonText('Turn off…')
          .setWarning()
          .onClick(() => this.plugin.openTotpOff())
      )
  }

  /** The screen for signing in, creating an account, or recovering one. */
  private accountForm(containerEl: HTMLElement): void {
    const headings: Record<Exclude<Screen, 'overview'>, string> = {
      'sign-in': 'Sign in',
      create: 'Create an account',
      recover: 'Recover your account'
    }
    new Setting(containerEl)
      .setName(headings[this.screen === 'overview' ? 'sign-in' : this.screen])
      .setHeading()
      .addExtraButton((button) =>
        button
          .setIcon('arrow-left')
          .setTooltip('Back')
          .onClick(() => this.go(this.screen === 'recover' ? 'sign-in' : 'overview'))
      )
    this.serverStatusRow(containerEl, this.plugin.settings.serverUrl || 'Server')
    if (this.screen === 'create') this.createForm(containerEl)
    else if (this.screen === 'recover') this.recoverForm(containerEl)
    else this.signInForm(containerEl)
  }

  private recoverForm(containerEl: HTMLElement): void {
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Your recovery code opens your account on its own. Choose the name and password to sign in with from now on - your old name, or a new one. Your other devices sign in again with them.'
    })
    new Setting(containerEl).setName('Recovery code').addText((text) => {
      text
        .setPlaceholder('XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX')
        .setValue(this.recoveryCode)
        .onChange((value) => {
          this.recoveryCode = value.trim()
        })
      text.inputEl.addClass('connect-code')
      this.gated.push(text)
    })
    this.nameField(containerEl)
    this.passwordField(containerEl, 'New password', 'Never leaves this device.', this.password, (value) => {
      this.password = value
    })
    this.passwordField(containerEl, 'New password again', '', this.repeat, (value) => {
      this.repeat = value
    })
    new Setting(containerEl)
      .setDesc('Or let this device make one: 20 random characters. Keep it in a password manager.')
      .addButton((button) => {
        button.setButtonText('Generate').onClick(() => {
          const generated = generatePassword()
          this.password = generated
          this.repeat = generated
          this.reveal.set(true)
          this.display()
        })
        this.gated.push(button)
      })
    new Setting(containerEl).addButton((button) => {
      button
        .setButtonText('Recover')
        .setCta()
        .onClick(
          () =>
            void this.run(async () => {
              await this.plugin.recoverAccount(this.recoveryCode, this.username, this.password, this.repeat)
              this.forgetPasswords()
              this.screen = 'overview'
            })
        )
      this.gated.push(button)
    })
  }

  private passwordField(containerEl: HTMLElement, name: string, desc: string, value: string, set: (value: string) => void): void {
    const setting = new Setting(containerEl).setName(name)
    setting.addText((text) => {
      text.setValue(value).onChange(set)
      this.gated.push(text)
      this.reveal.attach(setting, text.inputEl)
    })
    if (desc) setting.setDesc(desc)
  }

  private nameField(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Name').addText((text) => {
      text.setValue(this.username).onChange((value) => {
        this.username = value.trim()
      })
      this.gated.push(text)
    })
  }

  private forgetPasswords(): void {
    this.password = ''
    this.repeat = ''
    this.recoveryCode = ''
    this.reveal.set(false)
  }

  private signInForm(containerEl: HTMLElement): void {
    this.nameField(containerEl)
    this.passwordField(containerEl, 'Password', 'Never leaves this device.', this.password, (value) => {
      this.password = value
    })
    new Setting(containerEl)
      .addButton((button) => {
        button
          .setButtonText('Sign in')
          .setCta()
          .onClick(
            () =>
              void this.run(async () => {
                await this.plugin.signIn(this.username, this.password)
                this.forgetPasswords()
                this.screen = 'overview'
              })
          )
        this.gated.push(button)
      })
      .addButton((button) => button.setButtonText('No account yet? Create one').onClick(() => this.go('create')))
    new Setting(containerEl)
      .setDesc('Forgot your password or name? Your recovery code gets you back in.')
      .addButton((button) => button.setButtonText('Use a recovery code…').onClick(() => this.go('recover')))
  }

  private createForm(containerEl: HTMLElement): void {
    this.nameField(containerEl)
    this.passwordField(
      containerEl,
      'Password',
      'Never leaves this device. The recovery code you get next is the only other way into your account.',
      this.password,
      (value) => {
        this.password = value
      }
    )
    this.passwordField(containerEl, 'Password again', '', this.repeat, (value) => {
      this.repeat = value
    })
    new Setting(containerEl)
      .setDesc('Or let this device make one: 20 random characters. Keep it in a password manager.')
      .addButton((button) => {
        button.setButtonText('Generate').onClick(() => {
          const generated = generatePassword()
          this.password = generated
          this.repeat = generated
          // Shown, so it can go into a password manager; the eye hides it again.
          this.reveal.set(true)
          this.display()
        })
        this.gated.push(button)
      })

    if (this.inviteNeeded()) {
      new Setting(containerEl)
        .setName('Invite code')
        .setDesc('This server creates accounts only with a code from its admin (obsidian-connect invite).')
        .addText((text) => {
          text.setValue(this.invite).onChange((value) => {
            this.invite = value.trim()
          })
          this.gated.push(text)
        })
    }

    new Setting(containerEl)
      .addButton((button) => {
        button
          .setButtonText('Create account')
          .setCta()
          .onClick(
            () =>
              void this.run(async () => {
                await this.plugin.createAccount(this.username, this.password, this.repeat, this.invite)
                this.forgetPasswords()
                this.screen = 'overview'
              })
          )
        this.gated.push(button)
      })
      .addButton((button) => button.setButtonText('I already have an account').onClick(() => this.go('sign-in')))
  }

  private contactsSection(containerEl: HTMLElement): void {
    if (!this.plugin.settings.username) return
    new Setting(containerEl).setName('Contacts').setHeading()
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'You share notes with contacts only. The server never learns their names: those travel encrypted between your devices and theirs.'
    })

    new Setting(containerEl)
      .setName('Invite someone')
      .setDesc(
        'Creates a code for one person. Whoever enters it becomes your contact, without you having to confirm. A code works once, for seven days - send it any way but through this server.'
      )
      .addButton((button) =>
        button
          .setButtonText('Create a code')
          .setCta()
          .onClick(
            () =>
              void this.run(async () => {
                const code = await this.plugin.createContactCode()
                await navigator.clipboard.writeText(code).catch(() => undefined)
                new Notice('Code created and copied.')
              })
          )
      )
    const codes = containerEl.createDiv({ cls: 'connect-open-codes' })
    void this.plugin.contactCodes().then((open) => this.renderCodes(codes, open))

    new Setting(containerEl)
      .setName('Add a contact')
      .setDesc('Enter the code someone gave you.')
      .addText((text) =>
        text
          .setPlaceholder('XXXXX-XXXXX-…')
          .setValue(this.contactCode)
          .onChange((value) => {
            this.contactCode = value
          })
      )
      .addButton((button) =>
        button.setButtonText('Add').onClick(
          () =>
            void this.run(async () => {
              await this.plugin.redeemContactCode(this.contactCode)
              this.contactCode = ''
              new Notice('Added. Their name appears once one of their devices answers.')
            })
        )
      )

    for (const contact of this.plugin.contactList()) {
      const confirming = this.removing === contact.accountId
      const own = contact.localName && contact.name && contact.localName !== contact.name ? ` · calls themselves ${contact.name}` : ''
      new Setting(containerEl)
        .setName(contact.localName || contact.name || 'Waiting for their device to answer…')
        .setDesc(`${contact.accountId}${own}`)
        .addText((text) =>
          text
            .setPlaceholder('Your name for them')
            .setValue(contact.localName ?? '')
            .onChange((value) => this.plugin.renameContact(contact.accountId, value))
        )
        .addButton((button) =>
          button
            .setButtonText(confirming ? 'Really remove?' : 'Remove')
            .setWarning()
            .onClick(() => {
              if (!confirming) {
                this.removing = contact.accountId
                this.display()
                return
              }
              this.removing = null
              // Ends every share between the two first; each keeps what they have.
              void this.run(() => this.plugin.removeContact(contact.accountId))
            })
        )
    }
  }

  /** Every code handed out and not redeemed yet, on whichever device it was made. */
  private renderCodes(containerEl: HTMLElement, codes: OpenCode[]): void {
    containerEl.empty()
    for (const open of codes) {
      const setting = new Setting(containerEl)
        .setName(open.code)
        .setDesc(`Not redeemed yet · valid until ${new Date(open.expiresAt).toLocaleString()}`)
        .addExtraButton((button) =>
          button
            .setIcon('copy')
            .setTooltip('Copy')
            .onClick(() => {
              void navigator.clipboard.writeText(open.code)
              new Notice('Copied.')
            })
        )
        .addExtraButton((button) =>
          button
            .setIcon('trash')
            .setTooltip('Delete: nobody can redeem it any more')
            .onClick(() => void this.run(() => this.plugin.revokeContactCode(open.codeId)))
        )
      setting.nameEl.addClass('connect-code')
    }
  }

  private device(containerEl: HTMLElement): void {
    const settings = this.plugin.settings
    new Setting(containerEl).setName('This device').setHeading()

    new Setting(containerEl)
      .setName('Sync this vault')
      .setDesc('Notes, and every other file of the vault - images, PDFs. Turning this off stops all syncing on this device.')
      .addToggle((toggle) =>
        toggle.setValue(settings.syncEnabled).onChange(async (value) => {
          settings.syncEnabled = value
          await this.plugin.saveSettings()
          await this.plugin.restartSync()
        })
      )

    new Setting(containerEl)
      .setName('Documents kept in memory')
      .setDesc('Notes beyond this stop receiving live updates until opened again. Lower it on mobile.')
      .addText((text) =>
        text.setValue(String(settings.maxLoadedDocuments)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10)
          if (!Number.isFinite(parsed) || parsed < 1) return
          settings.maxLoadedDocuments = parsed
          await this.plugin.saveSettings()
        })
      )

    new Setting(containerEl)
      .setName('Download attachments up to')
      .setDesc(
        'MB. Larger images, PDFs and other files stay on the server until a note that embeds or links them is opened. Empty downloads everything; 0 downloads only what a note needs.'
      )
      .addText((text) =>
        text
          .setPlaceholder('everything')
          .setValue(settings.attachmentDownloadLimitMb < 0 ? '' : String(settings.attachmentDownloadLimitMb))
          .onChange(async (value) => {
            const trimmed = value.trim()
            const parsed = Number.parseFloat(trimmed)
            if (trimmed !== '' && (!Number.isFinite(parsed) || parsed < 0)) return
            settings.attachmentDownloadLimitMb = trimmed === '' ? -1 : parsed
            await this.plugin.saveSettings()
          })
      )
      .addButton((button) =>
        button.setButtonText('Download everything now').onClick(async () => {
          button.setDisabled(true)
          try {
            const fetched = await this.plugin.downloadAllAttachments()
            new Notice(fetched > 0 ? `Obsidian Connect: ${fetched} attachment(s) downloaded.` : 'Obsidian Connect: every attachment is already here.')
          } finally {
            button.setDisabled(false)
          }
        })
      )

    new Setting(containerEl)
      .setName('Log')
      .setDesc(
        'Always on: what the plugin does is written to a log in its folder, a week of it - never the text of a note. "Copy log" puts the last two days on the clipboard, errors and warnings first.'
      )
      .addButton((button) => button.setButtonText('Copy log').onClick(() => void this.plugin.copyLog()))
    // A row of its own: next to "Log", the switch read as turning the log on and off.
    new Setting(containerEl)
      .setName('Detailed logging')
      .setDesc(
        'Adds every change sent and received, and who comes and goes in a shared note, to the log above. Makes it much longer; turn it on to follow a problem, and off again after.'
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.verboseLog).onChange(async (value) => {
          settings.verboseLog = value
          await this.plugin.saveSettings()
        })
      )
  }

  private shared(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('All your devices').setHeading()
    const current = this.plugin.sharedSettings()
    if (!current) {
      containerEl.createEl('p', {
        cls: 'setting-item-description',
        text: 'These settings belong to your account and apply on every device. Sign in to change them.'
      })
      return
    }
    const update = (patch: Partial<SharedSettings>): void => this.plugin.updateSharedSettings(patch)

    new Setting(containerEl)
      .setName('Exclude')
      .setDesc('One glob per line, matched against the vault-relative path. Example: Private/**')
      .addTextArea((area) =>
        area
          .setPlaceholder('Templates/**\nArchive/**')
          .setValue(current.excludeGlobs.join('\n'))
          .onChange((value) =>
            update({
              excludeGlobs: value
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0)
            })
          )
      )

    new Setting(containerEl)
      .setName('Conflict markers')
      .setDesc(
        'Wrap regions both sides changed incompatibly in <<<<<<< markers. Off keeps both versions one after the other, without markers.'
      )
      .addToggle((toggle) => toggle.setValue(current.conflictMarkers).onChange((value) => update({ conflictMarkers: value })))

    new Setting(containerEl)
      .setName('Folder for shared notes')
      .setDesc('Where a note someone shares with you is created. Move it anywhere afterwards; it stays shared.')
      .addText((text) =>
        text
          .setPlaceholder('Shared')
          .setValue(current.sharedFolder)
          .onChange((value) => update({ sharedFolder: value.trim().replace(/^\/+|\/+$/g, '') }))
      )

    new Setting(containerEl)
      .setName('Keep history for')
      .setDesc(
        'Days of individually restorable versions of notes and files, and how long deleted ones can be restored. After that, versions are folded together and deleted notes and files are removed from the server. 0 keeps everything. Also applies to notes you share.'
      )
      .addText((text) =>
        text.setValue(String(current.historyRetentionDays)).onChange((value) => {
          const parsed = Number.parseInt(value, 10)
          if (Number.isFinite(parsed) && parsed >= 0) update({ historyRetentionDays: parsed })
        })
      )

    new Setting(containerEl)
      .setName('Deleted notes and files')
      .setDesc('Restore what was deleted on any of your devices, within the time above. Also in a folder\'s menu, and as a command.')
      .addButton((button) => button.setButtonText('Open the trash').onClick(() => this.plugin.openTrash()))

    const usage = new Setting(containerEl)
      .setName('Attachments on the server')
      .setDesc('Asking the server…')
    void this.plugin.attachmentUsage().then((answer) => {
      if (!answer) {
        usage.setDesc('Not known while the server cannot be reached.')
        return
      }
      const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`
      usage.setDesc(
        `${mb(answer.bytes)}, encrypted, including earlier versions and deleted files${answer.quotaBytes === null ? '' : `, of ${mb(answer.quotaBytes)} this server allows your account`}.`
      )
    })

    new Setting(containerEl)
      .setName('Keep backups for')
      .setDesc('Days. Backups are written before every merge, into the plugin folder.')
      .addText((text) =>
        text.setValue(String(current.backupRetentionDays)).onChange((value) => {
          const parsed = Number.parseInt(value, 10)
          if (Number.isFinite(parsed) && parsed >= 0) update({ backupRetentionDays: parsed })
        })
      )
  }
}
