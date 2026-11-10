import { App, ButtonComponent, PluginSettingTab, Setting } from 'obsidian'
import { Notice } from './notices.js'
import { generatePassword } from './account/password'
import { describeProbe, type ServerProbe } from './account/probe'
import { PasswordReveal } from './account/reveal'
import { busy, type BusyButton } from './busy'
import {
  scheduleDays,
  scheduleHours,
  type BackupAt,
  type BackupDestinationStatus,
  type BackupRunStatus,
  type BackupTaskSetting,
  type BackupVaultStatus
} from '@mycel/shared'
import { describeGuard, describeKeep, describeRepository } from './backup/BackupModals'
import { NO_LONGER_HAS_VAULT, defaultSchedule, deviceZone, type Backups } from './backup/Backups'
import type { TickChoice } from './history/TimeMachine'
import type MycelPlugin from './main'
import type { OpenCode } from './share/Contacts'
import type { SharedSettings } from './sync/AccountSettings'

function when(ms: number): string {
  const date = new Date(ms)
  return date.toDateString() === new Date().toDateString() ? `today ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : date.toLocaleString()
}

const DAY_MS = 24 * 60 * 60 * 1000

/** A moment soon, as a person says it: today, tomorrow, a weekday, a date - with the time, never the seconds. */
function soon(ms: number): string {
  const date = new Date(ms)
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const midnight = (day: Date): number => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
  const days = Math.round((midnight(date) - midnight(new Date())) / DAY_MS)
  if (days === 0) return `today, ${time}`
  if (days === 1) return `tomorrow, ${time}`
  if (days > 1 && days < 7) return `${date.toLocaleDateString('en-GB', { weekday: 'long' })}, ${time}`
  return `${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}, ${time}`
}

/** One line about a backup server: reachable, what its last backup did. When the next comes is the schedule's to say. */
function describeBackupServer(error: string | null, status: BackupVaultStatus | null): string {
  if (error) return `Not reachable: ${error}`
  if (!status) return 'Asking the backup server…'
  if (status.running) return 'Backing up now…'
  if (status.waitingUntil) return `A backup is due and waits until nobody writes in the vault - at the latest until ${when(status.waitingUntil)}.`
  const last = status.runs[0]
  if (!last) return 'No backup yet.'
  if (!last.ok) return `The last backup, ${when(last.startedAt)}, failed: ${last.error ?? 'see below'}.`
  if (last.destinations.length > 0 && last.destinations.every((destination) => destination.unchanged)) {
    return `Last backup ${when(last.finishedAt)}: ${last.notes} notes, ${last.files} files - nothing changed since the one before, which holds them.`
  }
  const checked = last.destinations.every((destination) => destination.checked || destination.unchanged) ? ', read back and checked' : ''
  return `Last backup ${when(last.finishedAt)}: ${last.notes} notes, ${last.files} files${checked}.`
}

function describeRepositoryState(task: BackupTaskSetting, outcome: BackupDestinationStatus | undefined, status: BackupVaultStatus | null): string {
  if (status && !status.ready) {
    return status.problems.length > 0 ? 'The backup server cannot carry this out - see why below.' : 'The backup server has not read this yet.'
  }
  const keep = describeKeep(task.keep)
  if (!outcome) return `Encrypted with its own password. Filled by the next backup. ${keep}`
  if (!outcome.ok) return `Failed: ${outcome.error ?? 'unknown'}`
  if (outcome.unchanged) return `Encrypted with its own password. Nothing changed since its last snapshot, which holds the vault as it is. ${keep}`
  return `Encrypted with its own password. Last backup ${outcome.checked === 'deep' ? 'read back in full' : 'checked'}. ${keep}`
}

/** The week from Monday, as the day buttons show it; 0 is Sunday, as `Date` counts. */
const WEEK_FROM_MONDAY = [1, 2, 3, 4, 5, 6, 0]
const DAY_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Which entry of the schedule's dropdown a task is. */
function scheduleChoice(task: BackupTaskSetting): string {
  if (task.at) return 'days'
  if (task.everyHours <= 0) return 'manual'
  return task.everyHours === 1 || task.everyHours === 6 ? `every-${task.everyHours}` : 'custom'
}

/** The schedule in a few words: when the next backup comes, and by whose clock. */
function describeSchedule(task: BackupTaskSetting, status: BackupVaultStatus | null): string {
  if (!task.at && task.everyHours <= 0) return 'Only when started here - and before a rollback.'
  const next = status?.nextRunAt ? `Next backup: ${soon(status.nextRunAt)}` : ''
  if (!task.at) return next ? `${next}.` : ''
  const zone = deviceZone()
  if (task.at.zone !== zone) return `${next ? `${next} - ` : ''}by the clock of ${task.at.zone}, where it was set; a change here takes this device's (${zone}).`
  return next ? `${next} (${zone}).` : `By the clock here (${zone}).`
}

function describeCopy(task: BackupTaskSetting, trusted: BackupRunStatus['trusted']): string {
  const guard = describeGuard(task.guard)
  if (!trusted) return `Decrypted, the newest version. Filled by the next backup. ${guard}`
  if (trusted.error) return `Not brought up to date: ${trusted.error}`
  return `Decrypted, the newest version. Up to date with the last backup. ${guard}`
}

/**
 * What stays on this device. Everything that must match across an account's
 * devices lives in the account settings document instead.
 */
export interface MycelSettings {
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
  /** Route id -> when this device last saw a good backup there, for warning when there has been none for long. */
  backupLastGood: Record<string, number>
  /** Whether the Time Machine shows backups older than the history as ticks too. */
  timeMachineBackups: boolean
  /** How fine the Time Machine's ticks are (`docs/TIMEMACHINE.md`, V1). */
  timeMachineTicks: TickChoice
  /** Whether a note showing its past marks the changes against now. */
  timeMachineMarks: boolean
  /** The setup wizard was opened on this device: it never opens by itself again. */
  setupShown: boolean
}

export const DEFAULT_SETTINGS: MycelSettings = {
  serverUrl: 'ws://localhost:1234',
  username: '',
  token: '',
  vaultName: '',
  syncEnabled: true,
  maxLoadedDocuments: 500,
  writeDebounceMs: 700,
  syncTimeoutMs: 5_000,
  verboseLog: false,
  attachmentDownloadLimitMb: -1,
  backupLastGood: {},
  timeMachineBackups: false,
  timeMachineTicks: 'auto',
  timeMachineMarks: true,
  setupShown: false
}

/** Where a phone starts: its storage and data plan are not a desktop's. */
export const MOBILE_DOWNLOAD_LIMIT_MB = 10

/** Signed out, the account box leads to one of these forms, each a screen of its own. */
type Screen = 'overview' | 'sign-in' | 'create' | 'recover'

type Tab = 'account' | 'contacts' | 'backups' | 'device' | 'all'

/** `signedIn`: only there once signed in - the others mean nothing without an account. */
const TABS: ReadonlyArray<{ id: Tab; label: string; signedIn: boolean }> = [
  { id: 'account', label: 'Account', signedIn: false },
  { id: 'contacts', label: 'Contacts', signedIn: true },
  { id: 'backups', label: 'Backups', signedIn: true },
  { id: 'device', label: 'This device', signedIn: false },
  { id: 'all', label: 'All devices', signedIn: true }
]

export class MycelSettingTab extends PluginSettingTab {
  private screen: Screen = 'overview'
  /** Kept while the plugin runs: the tab opens where it was left. */
  private tab: Tab = 'account'
  private username = ''
  private password = ''
  private repeat = ''
  private recoveryCode = ''
  private reveal = new PasswordReveal()
  private invite = ''
  private contactCode = ''
  private removing: string | null = null
  /** A backup server waiting for "Really disconnect?". */
  private disconnecting: string | null = null
  /** Backup servers asked for their state since the tab opened: asked once, not on every redraw. */
  private readonly backupsAsked = new Set<string>()
  /** Backup servers whose repository password is shown, until the tab closes. */
  private readonly passwordsShown = new Set<string>()
  private busy = false
  /** Between Obsidian opening the tab and closing it: only then is there anything to bring up to date. */
  private shown = false
  private refreshWaits = false

  /** What the configured server answered; undefined while asking. */
  private probe: ServerProbe | undefined = undefined
  private probing = 0
  private probeTimer: number | null = null
  private serverStatus: Setting | null = null
  private useServerButton: ButtonComponent | null = null
  /** Signing in and creating an account: usable only once the server answered properly. */
  private gated: Array<{ setDisabled(disabled: boolean): unknown }> = []

  constructor(
    app: App,
    private readonly plugin: MycelPlugin
  ) {
    super(app, plugin)
  }

  display(): void {
    const { containerEl } = this
    // Opened just now: what the account says may have changed on another
    // device while this one was not listening.
    if (!this.shown && this.plugin.settings.username) void this.plugin.refreshAccount()
    this.shown = true
    containerEl.empty()
    this.gated = []
    this.serverStatus = null
    this.useServerButton = null
    // The fields are built anew; whether passwords show carries over.
    this.reveal = new PasswordReveal(this.reveal.revealed)
    const signedIn = Boolean(this.plugin.settings.username)
    if (signedIn) this.screen = 'overview'
    containerEl.createEl('p', { cls: 'setting-item-description', text: `Mycel ${this.plugin.manifest.version}` })

    const tabs = TABS.filter((tab) => signedIn || !tab.signedIn)
    // Signing in, creating an account and recovering are the account's.
    if (this.screen !== 'overview' || !tabs.some((tab) => tab.id === this.tab)) this.tab = 'account'
    const bar = containerEl.createDiv({ cls: 'mycel-tabs', attr: { role: 'tablist' } })
    for (const tab of tabs) {
      const active = tab.id === this.tab
      const button = bar.createEl('button', { cls: 'mycel-tab', text: tab.label, attr: { role: 'tab', 'aria-selected': String(active) } })
      if (active) button.addClass('is-active')
      button.addEventListener('click', () => this.show(tab.id))
    }

    if (this.screen !== 'overview') this.accountForm(containerEl)
    else if (this.tab === 'account') this.account(containerEl)
    else if (this.tab === 'contacts') this.contactsSection(containerEl)
    else if (this.tab === 'backups') this.backupSection(containerEl)
    else if (this.tab === 'device') this.device(containerEl)
    else this.shared(containerEl)
    if (!signedIn) {
      if (this.probe === undefined && this.probing === 0) void this.checkServer()
      else this.showProbe()
    }
    this.watchBackups()
  }

  /**
   * Every backup server asked once while the settings are open, whatever the
   * tab - its answer, and every run it finishes meanwhile, draws the tab
   * again. A decrypted copy the guard holds is then asked about over
   * everything: with backups at night, nobody saw the run that held it.
   */
  private watchBackups(): void {
    const backups = this.plugin.settings.username ? this.plugin.backupsOf() : null
    if (!backups) return
    for (const server of backups.servers()) {
      if (!this.backupsAsked.has(server.routeId)) {
        this.backupsAsked.add(server.routeId)
        void backups.ask(server.routeId)
        continue
      }
      if (this.plugin.openCopyWaits(server.routeId)) return
    }
  }

  /** Switches to a tab. A form half filled in on the account tab is left, as leaving the settings would. */
  private show(tab: Tab): void {
    if (tab === this.tab && this.screen === 'overview') return
    this.tab = tab
    // Leaving a form forgets the passwords typed into it.
    if (this.screen !== 'overview') this.go('overview')
    else this.display()
  }

  /**
   * Shows what changed - on another device, or here outside the tab - if the
   * tab is open. Not while something typed here would be lost: rebuilding
   * takes the focus from the field, so it waits until the focus leaves it.
   * Not during a click being worked on either; that one rebuilds when done.
   */
  refresh(): void {
    if (!this.shown || this.busy) return
    const focused = document.activeElement
    if (focused instanceof HTMLElement && this.containerEl.contains(focused) && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA')) {
      if (this.refreshWaits) return
      this.refreshWaits = true
      focused.addEventListener(
        'blur',
        () => {
          this.refreshWaits = false
          // After the field's own change was taken in.
          window.setTimeout(() => this.refresh(), 0)
        },
        { once: true }
      )
      return
    }
    this.display()
  }

  /**
   * The setup wizard closed or signed in. It may have changed the server's
   * address underneath the tab, so what the tab knew of the server is stale.
   */
  afterSetup(): void {
    if (!this.shown) return
    if (this.probeTimer !== null) window.clearTimeout(this.probeTimer)
    this.probeTimer = null
    this.probing = 0
    this.probe = undefined
    this.refresh()
  }

  /** Asked again every time the settings open: the server may have come up meanwhile. */
  hide(): void {
    this.shown = false
    if (this.probeTimer !== null) window.clearTimeout(this.probeTimer)
    this.probeTimer = null
    this.probing = 0
    this.probe = undefined
    this.removing = null
    this.disconnecting = null
    this.backupsAsked.clear()
    this.passwordsShown.clear()
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
    const changed = probe?.state === 'ok' && probe.changed
    for (const control of this.gated) control.setDisabled(this.busy || probe?.state !== 'ok' || changed)
    if (this.useServerButton) this.useServerButton.buttonEl.style.display = changed ? '' : 'none'
    this.serverStatus?.setDesc(describeProbe(probe))
  }

  /** `button`: the one clicked, greyed out and spinning until the task is done. */
  private async run(task: () => Promise<void>, button?: BusyButton): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await busy(button, task)
    } catch (error) {
      new Notice(`Mycel: ${error instanceof Error ? error.message : String(error)}`, 8_000)
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
      .addButton((button) => {
        // Shown only for a server whose id changed; the person decides, nothing is assumed.
        this.useServerButton = button
        button.buttonEl.style.display = 'none'
        button
          .setButtonText('Use this server')
          .setWarning()
          .onClick(
            () =>
              void busy(button, async () => {
                this.plugin.useNewServer()
                await this.checkServer()
              })
          )
      })
      .addButton((button) => button.setButtonText('Check again').onClick(() => void busy(button, () => this.checkServer())))
  }

  private account(containerEl: HTMLElement): void {
    const settings = this.plugin.settings
    if (!settings.username) {
      new Setting(containerEl)
        .setName('Set up step by step')
        .setDesc('A short guide: how Mycel works, then this device connected to your server - the address, your account, the vault.')
        .addButton((button) => button.setButtonText('Open the guide…').onClick(() => this.plugin.openSetup()))
    }
    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('WebSocket endpoint of your Mycel server, e.g. wss://notes.example.com')
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
        button.setButtonText('Switch').onClick(() => void this.run(() => this.plugin.restartSync(), button))
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
            .onClick(() => void this.run(() => this.plugin.signOut(), button))
        )
      this.recoveryRow(containerEl)
      this.totpRow(containerEl)
      new Setting(containerEl)
        .setName('Replace all keys')
        .setDesc(
          'If someone may have your password or one of your devices: a new password and new keys for everything, and your vaults written anew under them on the server. Your contacts confirm you again with a new friend code.'
        )
        .addButton((button) =>
          button
            .setButtonText('Replace all keys…')
            .setWarning()
            .onClick(() => this.plugin.openReplaceKeys())
        )
      const ids = this.plugin.ids()
      if (ids) {
        // The server knows no names; these are what it knows, and what the
        // admin's `mycel user list` shows.
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
    if (state === 'off') {
      row
        .setDesc(
          'Off. When on, signing in on a device also asks for a code from an authenticator app on your phone. It guards the sign-in only: your notes are encrypted with your password either way.'
        )
        .addButton((button) => button.setButtonText('Turn on…').onClick(() => this.plugin.openTotpSetup()))
      return
    }
    row
      .setDesc(
        'On. Signing in on a device asks for a code from your authenticator app. Lost your phone? On a device still signed in, your password turns it off; elsewhere, your recovery code gets you in without one.'
      )
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
      text.inputEl.addClass('mycel-code')
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
            }, button)
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
              }, button)
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
        .setDesc('This server creates accounts only with a code from its admin (mycel invite).')
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
                // A code typed for another server that wanted one would be checked, and refused, by one that does not.
                await this.plugin.createAccount(this.username, this.password, this.repeat, this.inviteNeeded() ? this.invite : '')
                this.forgetPasswords()
                this.screen = 'overview'
              }, button)
          )
        this.gated.push(button)
      })
      .addButton((button) => button.setButtonText('I already have an account').onClick(() => this.go('sign-in')))
  }

  private contactsSection(containerEl: HTMLElement): void {
    if (!this.plugin.settings.username) return
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
              }, button)
          )
      )
    const codes = containerEl.createDiv({ cls: 'mycel-open-codes' })
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
            }, button)
        )
      )

    for (const contact of this.plugin.contactList()) {
      const confirming = this.removing === contact.accountId
      const own = contact.localName && contact.name && contact.localName !== contact.name ? ` · calls themselves ${contact.name}` : ''
      const replaced = contact.replacedAt !== undefined ? ' · replaced their keys - exchange a new friend code with them; until then what you share waits' : ''
      new Setting(containerEl)
        .setName(contact.localName || contact.name || 'Waiting for their device to answer…')
        .setDesc(`${contact.accountId}${own}${replaced}`)
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
              void this.run(() => this.plugin.removeContact(contact.accountId), button)
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
            .onClick(() => void this.run(() => this.plugin.revokeContactCode(open.codeId), button))
        )
      setting.nameEl.addClass('mycel-code')
    }
  }

  private backupSection(containerEl: HTMLElement): void {
    if (!this.plugin.settings.username) return
    new Setting(containerEl)
      .setName('Time Machine')
      .setDesc(
        'The vault as it was at any moment its history reaches (Keep history for, under All devices), and further back from the backups if you like - looked at first, taken over only when you apply it, after a fresh backup. A folder or a note alone: in its menu. Applying can be undone.'
      )
      .addButton((button) => button.setButtonText('Open the Time Machine').setCta().onClick(() => void this.plugin.openTimeMachine({ kind: 'vault' })))
    const backups = this.plugin.backupsOf()
    if (!backups) {
      containerEl.createEl('p', { cls: 'setting-item-description', text: 'Backups are set up while this vault syncs.' })
      return
    }
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'A backup server of your own pulls this vault, decrypts it in its memory and keeps it in a restic repository - every backup, for as long as you choose. These settings apply on all your devices.'
    })
    const servers = backups.servers()
    for (const server of servers) this.backupServerRows(containerEl, backups, server.routeId)
    if (servers.length === 0) {
      new Setting(containerEl)
        .setName('Connect a backup server')
        .setDesc("With an invitation from its operator. It runs on a computer of yours or someone's you trust, with Docker - see the Mycel documentation.")
        .addButton((button) => button.setButtonText('Connect…').onClick(() => this.plugin.openBackupConnect()))
    } else {
      new Setting(containerEl)
        .setName('Another backup server')
        .setDesc('A vault has one backup server. Connecting another replaces this one; its backups stay where they are.')
        .addButton((button) => button.setButtonText('Replace…').onClick(() => this.plugin.openBackupConnect()))
    }
  }

  private backupServerRows(containerEl: HTMLElement, backups: Backups, routeId: string): void {
    const view = backups.view(routeId)
    if (!view) return
    const status = view.status
    const last = status?.runs[0]
    const confirming = this.disconnecting === routeId
    // Its key ended: a new one over the pairing, with the password.
    const needsKey = last?.accessEnded === true || /connect it again/.test(view.error ?? '')
    // It lost the vault: only a new invitation pairs it again.
    const lost = NO_LONGER_HAS_VAULT.test(view.error ?? '')
    const head = new Setting(containerEl).setName(view.setting.label).setDesc(describeBackupServer(view.error, status))
    if (needsKey && !lost) {
      head.addButton((button) =>
        button
          .setButtonText('Connect again…')
          .setCta()
          .onClick(() => this.plugin.openBackupConnect({ routeId, label: view.setting.label }))
      )
    }
    if (lost) {
      head.addButton((button) =>
        button
          .setButtonText('Remove')
          .setWarning()
          .onClick(() => void this.run(() => backups.forget(routeId), button))
      )
    }
    head
      .addButton((button) =>
        button
          .setButtonText('Back up now')
          .setDisabled(Boolean(view.error) || status?.running === true || !view.task)
          .onClick(
            () =>
              void this.run(async () => {
                await backups.runNow(routeId)
                new Notice(`Mycel: ${view.setting.label} is backing up the vault.`)
              }, button)
          )
      )
      .addButton((button) =>
        button
          .setButtonText(confirming ? 'Really disconnect?' : 'Disconnect')
          .setWarning()
          .onClick(() => {
            if (!confirming) {
              this.disconnecting = routeId
              this.display()
              return
            }
            this.disconnecting = null
            void this.run(() => backups.disconnect(routeId), button)
          })
      )
      .settingEl.addClass('mycel-backup-server')

    const task = view.task
    if (!task) {
      new Setting(containerEl)
        .setName('Back up this vault')
        .setDesc('Nothing is backed up yet: say where the repository lies, and whether a decrypted copy is kept too.')
        .addButton((button) =>
          button
            .setButtonText('Set up…')
            .setCta()
            .onClick(() => void this.run(() => this.plugin.openBackupTask(routeId), button))
        )
    } else {
      this.scheduleRow(containerEl, backups, routeId, task, status)
      const repository = new Setting(containerEl)
        .setName(`Repository: ${describeRepository(task, status?.folders.encrypted ?? null)}`)
        .setDesc(describeRepositoryState(task, last?.destinations[0], status))
      // Shown rather than copied: a clipboard history, or one synced across devices, would keep it.
      const shown = this.passwordsShown.has(routeId)
      repository.addExtraButton((button) =>
        button
          .setIcon(shown ? 'eye-off' : 'eye')
          .setTooltip(shown ? 'Hide the repository password' : 'Show the repository password')
          .onClick(() => {
            if (shown) this.passwordsShown.delete(routeId)
            else this.passwordsShown.add(routeId)
            this.display()
          })
      )
      repository.addExtraButton((button) =>
        button
          .setIcon('pencil')
          .setTooltip('Change how long backups are kept, the credentials, the decrypted copy')
          .onClick(() => void this.plugin.openBackupTask(routeId, task))
      )
      repository.addExtraButton((button) =>
        button
          .setIcon('trash')
          .setTooltip('Remove: no more backups. The repository and the decrypted copy stay where they are.')
          .onClick(() => void this.run(() => backups.removeTask(routeId), button))
      )
      if (shown) {
        const row = new Setting(containerEl)
          .setName('Repository password')
          .setDesc('Write it down, or keep it in a password manager: without it nobody can read the repository, not even you.')
        row.controlEl.createEl('code', { cls: 'mycel-code', text: task.password })
      }
      if (task.decrypted) {
        new Setting(containerEl)
          .setName(`Decrypted copy: on the backup server${status ? `, ${status.folders.decrypted}` : ''}`)
          .setDesc(describeCopy(task, last?.trusted))
      }
    }

    if (backups.following(routeId)) {
      new Setting(containerEl)
        .setName(last?.trusted?.held ? 'The decrypted copy follows the vault' : 'Confirmed')
        .setDesc('Backing up once more - as long as a backup takes. A notice says when it is done.')
        .settingEl.addClass('mycel-copy-waits')
    } else if (backups.heldCopy(routeId)) {
      const copy = Boolean(last?.trusted?.held)
      const row = new Setting(containerEl)
        .setName(copy ? 'The decrypted copy waits' : 'Every backup is kept')
        .setDesc(
          `${last?.trusted?.held ?? last?.retention?.held ?? ''}. If that was on purpose, ${copy ? 'let it follow' : 'confirm'}; if not, find out first - the server may have lost data.`
        )
        .addButton((button) =>
          button
            .setButtonText('Decide…')
            .setWarning()
            .onClick(() => this.plugin.openCopyWaits(routeId, true))
        )
      row.settingEl.addClass('mycel-copy-waits')
    }
    for (const problem of status?.problems ?? []) {
      new Setting(containerEl).setName(status?.ready ? 'Note' : 'Not carried out').setDesc(problem)
    }
  }

  /**
   * When the backup server backs up on its own: every so many hours, or at a
   * time of day on the days chosen - by this device's time zone. A day button
   * is saved a moment after the last click, so a few clicks in a row are one
   * change, not one each.
   */
  private scheduleRow(containerEl: HTMLElement, backups: Backups, routeId: string, task: BackupTaskSetting, status: BackupVaultStatus | null): void {
    const choice = scheduleChoice(task)
    const set = (schedule: { everyHours: number; at?: BackupAt }): void => void this.run(() => backups.setSchedule(routeId, schedule.everyHours, schedule.at))
    // A time of day; all seven days are every day, and need no list.
    const timed = (days: number[], minutes: number): { everyHours: number; at: BackupAt } => {
      const at: BackupAt = { minutes, zone: deviceZone() }
      if (days.length < 7) at.weekdays = [...days].sort((a, b) => a - b)
      return { everyHours: scheduleHours({ everyHours: 0, at }), at }
    }
    const row = new Setting(containerEl).setName('Backs up').setDesc(describeSchedule(task, status))
    row.addDropdown((dropdown) => {
      dropdown.addOption('days', 'On these days')
      dropdown.addOption('every-6', 'Every 6 hours')
      dropdown.addOption('every-1', 'Every hour')
      dropdown.addOption('manual', 'Only when started here')
      if (choice === 'custom') dropdown.addOption('custom', `Every ${task.everyHours} hours`)
      dropdown.setValue(choice).onChange((value) => {
        if (value === 'manual') set({ everyHours: 0 })
        else if (value === 'every-1') set({ everyHours: 1 })
        else if (value === 'every-6') set({ everyHours: 6 })
        else if (value === 'days') set(timed(scheduleDays({}), defaultSchedule().at.minutes))
      })
    })
    if (!task.at) return

    const minutes = task.at.minutes
    const chosen = new Set(scheduleDays(task.at))
    const days = new Setting(containerEl)
    days.settingEl.addClass('mycel-schedule')
    const buttons = days.infoEl.createDiv({ cls: 'mycel-days', attr: { role: 'group', 'aria-label': 'Days' } })
    let saving: number | null = null
    for (const day of WEEK_FROM_MONDAY) {
      const button = buttons.createEl('button', { cls: 'mycel-day', text: DAY_SHORT[day], attr: { type: 'button', title: DAY_NAMES[day] ?? '' } })
      const show = (): void => {
        button.toggleClass('is-active', chosen.has(day))
        button.setAttr('aria-pressed', String(chosen.has(day)))
      }
      show()
      button.addEventListener('click', () => {
        // One day stays: a schedule of no days is "only when started here", which the dropdown says.
        if (chosen.has(day) && chosen.size === 1) return
        if (chosen.has(day)) chosen.delete(day)
        else chosen.add(day)
        show()
        if (saving !== null) window.clearTimeout(saving)
        saving = window.setTimeout(() => {
          saving = null
          set(timed(Array.from(chosen), minutes))
        }, 800)
      })
    }

    days.controlEl.addClass('mycel-time')
    days.controlEl.createSpan({ cls: 'mycel-time-word', text: 'at' })
    days.addDropdown((hour) => {
      for (let value = 0; value < 24; value += 1) hour.addOption(String(value), String(value).padStart(2, '0'))
      hour.setValue(String(Math.floor(minutes / 60))).onChange((value) => set(timed(Array.from(chosen), Number(value) * 60 + (minutes % 60))))
      hour.selectEl.setAttr('aria-label', 'Hour')
    })
    days.controlEl.createSpan({ cls: 'mycel-time-word', text: ':' })
    days.addDropdown((minute) => {
      const options = new Set([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, minutes % 60])
      for (const value of Array.from(options).sort((a, b) => a - b)) minute.addOption(String(value), String(value).padStart(2, '0'))
      minute.setValue(String(minutes % 60)).onChange((value) => set(timed(Array.from(chosen), Math.floor(minutes / 60) * 60 + Number(value))))
      minute.selectEl.setAttr('aria-label', 'Minute')
    })
  }

  private device(containerEl: HTMLElement): void {
    const settings = this.plugin.settings
    containerEl.createEl('p', { cls: 'setting-item-description', text: 'These apply on this device only.' })

    // Another device's lock, liftable here too: a phone has no status bar, and its window may have been closed.
    const locked = this.plugin.vaultLockState()
    if (locked) {
      new Setting(containerEl)
        .setName('The vault is locked')
        .setDesc(`${locked} Lift it only if that device hangs or is gone.`)
        .addButton((button) =>
          button
            .setButtonText('Unlock…')
            .setWarning()
            .onClick(() => this.plugin.openLockModal())
        )
    }

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
      .setDesc(
        'Notes held open at once. Every note stays live whatever it says: one beyond it is watched, and opened for a moment when another device changes it. Lower it on mobile to save memory.'
      )
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
        button.setButtonText('Download everything now').onClick(
          () =>
            void busy(button, async () => {
              const fetched = await this.plugin.downloadAllAttachments()
              new Notice(fetched > 0 ? `Mycel: ${fetched} attachment(s) downloaded.` : 'Mycel: every attachment is already here.')
            })
        )
      )

    new Setting(containerEl)
      .setName('Log')
      .setDesc(
        'Always on: what the plugin does is written to a log in its folder, a week of it - never the text of a note. "Copy log" puts the last two days on the clipboard, errors and warnings first.'
      )
      .addButton((button) => button.setButtonText('Copy log').onClick(() => void busy(button, () => this.plugin.copyLog())))
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
    const current = this.plugin.sharedSettings()
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: current
        ? 'These belong to your account and apply on all your devices.'
        : 'These belong to your account and apply on all your devices. They show once this vault syncs.'
    })
    if (!current) return
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
      // Since 0.9.9 the quota covers the notes' history too.
      const notes = answer.roomBytes === undefined ? '' : `; notes and their history ${mb(answer.roomBytes)}`
      const used = answer.bytes + (answer.roomBytes ?? 0)
      usage.setDesc(
        `${mb(answer.bytes)}, encrypted, including earlier versions and deleted files${notes}${answer.quotaBytes === null ? '' : `. ${mb(used)} of ${mb(answer.quotaBytes)} this server allows your account`}.`
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
