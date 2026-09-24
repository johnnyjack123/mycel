import { App, Notice, PluginSettingTab, Setting } from 'obsidian'
import type { RegistrationMode } from '@obsidian-connect/shared'
import type ObsidianConnectPlugin from './main'
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
}

export const DEFAULT_SETTINGS: ObsidianConnectSettings = {
  serverUrl: 'ws://localhost:1234',
  username: '',
  token: '',
  vaultName: '',
  syncEnabled: true,
  maxLoadedDocuments: 500,
  writeDebounceMs: 700,
  syncTimeoutMs: 5_000
}

export class ObsidianConnectSettingTab extends PluginSettingTab {
  private mode: 'sign-in' | 'create' = 'sign-in'
  private username = ''
  private password = ''
  private repeat = ''
  private invite = ''
  /** What the server said about registering; undefined until asked, null if unreachable. */
  private registration: RegistrationMode | null | undefined = undefined
  private busy = false

  constructor(
    app: App,
    private readonly plugin: ObsidianConnectPlugin
  ) {
    super(app, plugin)
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()
    this.account(containerEl)
    this.device(containerEl)
    this.shared(containerEl)
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
            this.registration = undefined
            await this.plugin.saveSettings()
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
      return
    }

    if (this.mode === 'create') this.createForm(containerEl)
    else this.signInForm(containerEl)
  }

  private passwordField(containerEl: HTMLElement, name: string, desc: string, value: string, set: (value: string) => void): void {
    const setting = new Setting(containerEl).setName(name).addText((text) => {
      text.inputEl.type = 'password'
      text.setValue(value).onChange(set)
    })
    if (desc) setting.setDesc(desc)
  }

  private nameField(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Name').addText((text) =>
      text.setValue(this.username).onChange((value) => {
        this.username = value.trim()
      })
    )
  }

  private forgetPasswords(): void {
    this.password = ''
    this.repeat = ''
  }

  private signInForm(containerEl: HTMLElement): void {
    this.nameField(containerEl)
    this.passwordField(containerEl, 'Password', 'Never leaves this device.', this.password, (value) => {
      this.password = value
    })
    new Setting(containerEl)
      .addButton((button) =>
        button
          .setButtonText('Sign in')
          .setCta()
          .onClick(
            () =>
              void this.run(async () => {
                await this.plugin.signIn(this.username, this.password)
                this.forgetPasswords()
              })
          )
      )
      .addButton((button) =>
        button.setButtonText('Create a new account…').onClick(() => {
          this.mode = 'create'
          this.forgetPasswords()
          this.display()
        })
      )
  }

  private createForm(containerEl: HTMLElement): void {
    if (this.registration === undefined) {
      void this.plugin.registration().then((mode) => {
        this.registration = mode
        if (this.mode === 'create') this.display()
      })
    }

    this.nameField(containerEl)
    this.passwordField(
      containerEl,
      'Password',
      'Never leaves this device. Without it your notes cannot be decrypted - there is no reset.',
      this.password,
      (value) => {
        this.password = value
      }
    )
    this.passwordField(containerEl, 'Password again', '', this.repeat, (value) => {
      this.repeat = value
    })

    if (this.registration !== 'open') {
      new Setting(containerEl)
        .setName('Invite code')
        .setDesc(
          this.registration === 'invite'
            ? 'This server creates accounts only with a code from its admin (obsidian-connect user add <name>).'
            : 'Only if the server asks for one.'
        )
        .addText((text) =>
          text.setValue(this.invite).onChange((value) => {
            this.invite = value.trim()
          })
        )
    }

    new Setting(containerEl)
      .addButton((button) =>
        button
          .setButtonText('Create account')
          .setCta()
          .onClick(
            () =>
              void this.run(async () => {
                await this.plugin.createAccount(this.username, this.password, this.repeat, this.invite)
                this.forgetPasswords()
                this.mode = 'sign-in'
              })
          )
      )
      .addButton((button) =>
        button.setButtonText('I already have an account').onClick(() => {
          this.mode = 'sign-in'
          this.forgetPasswords()
          this.display()
        })
      )
  }

  private device(containerEl: HTMLElement): void {
    const settings = this.plugin.settings
    new Setting(containerEl).setName('This device').setHeading()

    new Setting(containerEl)
      .setName('Sync this vault')
      .setDesc('Keep every markdown note backed by a CRDT. Turning this off stops all syncing on this device.')
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
        'Days of individually restorable versions. Older ones are folded together, nothing is deleted. Also applies to notes you share.'
      )
      .addText((text) =>
        text.setValue(String(current.historyRetentionDays)).onChange((value) => {
          const parsed = Number.parseInt(value, 10)
          if (Number.isFinite(parsed) && parsed >= 0) update({ historyRetentionDays: parsed })
        })
      )

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
