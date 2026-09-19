import { App, PluginSettingTab, Setting } from 'obsidian'
import type ObsidianConnectPlugin from './main'

export type AdapterMode = 'main-editor' | 'collab-view'

export interface ObsidianConnectSettings {
  serverUrl: string
  token: string
  displayName: string
  adapterMode: AdapterMode
  vaultId: string
  syncEnabled: boolean
  excludeGlobs: string[]
  conflictMarkers: boolean
  backupRetentionDays: number
  maxLoadedDocuments: number
  writeDebounceMs: number
  syncTimeoutMs: number
}

export const DEFAULT_SETTINGS: ObsidianConnectSettings = {
  serverUrl: 'ws://localhost:1234',
  token: '',
  displayName: '',
  adapterMode: 'main-editor',
  vaultId: '',
  syncEnabled: true,
  excludeGlobs: [],
  conflictMarkers: true,
  backupRetentionDays: 14,
  maxLoadedDocuments: 500,
  writeDebounceMs: 700,
  syncTimeoutMs: 5_000
}

/** The REST endpoint that belongs to a `ws://` or `wss://` server URL. */
export function serverHttpUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, '')
  if (trimmed.startsWith('wss://')) return `https://${trimmed.slice('wss://'.length)}`
  if (trimmed.startsWith('ws://')) return `http://${trimmed.slice('ws://'.length)}`
  return trimmed
}

export class ObsidianConnectSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ObsidianConnectPlugin) {
    super(app, plugin)
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    new Setting(containerEl).setName('Connection').setHeading()

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('WebSocket endpoint of the Obsidian Connect server.')
      .addText((text) =>
        text
          .setPlaceholder('ws://localhost:1234')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim()
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Access token')
      .setDesc('JWT issued by the server. Leave empty while the server runs in development mode.')
      .addText((text) =>
        text
          .setPlaceholder('optional')
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim()
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Display name')
      .setDesc('Name shown to other collaborators.')
      .addText((text) =>
        text.setValue(this.plugin.settings.displayName).onChange(async (value) => {
          this.plugin.settings.displayName = value.trim()
          await this.plugin.saveSettings()
        })
      )

    new Setting(containerEl)
      .setName('Vault ID')
      .setDesc(
        'Shared by all devices that sync the same vault. Generated automatically; copy it to a second device to pair them.'
      )
      .addText((text) =>
        text.setValue(this.plugin.settings.vaultId).onChange(async (value) => {
          this.plugin.settings.vaultId = value.trim()
          await this.plugin.saveSettings()
        })
      )

    new Setting(containerEl).setName('Synchronization').setHeading()

    new Setting(containerEl)
      .setName('Sync this vault')
      .setDesc('Keep every markdown note backed by a CRDT. Turning this off stops all syncing.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncEnabled).onChange(async (value) => {
          this.plugin.settings.syncEnabled = value
          await this.plugin.saveSettings()
          await this.plugin.restartSync()
        })
      )

    new Setting(containerEl)
      .setName('Exclude')
      .setDesc('One glob per line, matched against the vault-relative path. Example: Private/**')
      .addTextArea((area) =>
        area
          .setPlaceholder('Templates/**\nArchive/**')
          .setValue(this.plugin.settings.excludeGlobs.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.excludeGlobs = value
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Conflict markers')
      .setDesc(
        'Wrap regions both sides changed incompatibly in <<<<<<< markers. Off keeps both versions one after the other, without markers.'
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.conflictMarkers).onChange(async (value) => {
          this.plugin.settings.conflictMarkers = value
          await this.plugin.saveSettings()
        })
      )

    new Setting(containerEl)
      .setName('Documents kept in memory')
      .setDesc(
        'Notes beyond this stop receiving live updates until opened again. Lower it on mobile.'
      )
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.maxLoadedDocuments))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10)
            if (!Number.isFinite(parsed) || parsed < 1) return
            this.plugin.settings.maxLoadedDocuments = parsed
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl).setName('Safety').setHeading()

    new Setting(containerEl)
      .setName('Keep backups for')
      .setDesc('Days. Backups are written before every merge, into the plugin folder.')
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.backupRetentionDays))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10)
            if (!Number.isFinite(parsed) || parsed < 0) return
            this.plugin.settings.backupRetentionDays = parsed
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Editor integration')
      .setDesc('How live edits from other people appear in an open note.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('main-editor', 'Main editor (experimental)')
          .addOption('collab-view', 'Dedicated collaboration view')
          .setValue(this.plugin.settings.adapterMode)
          .onChange(async (value) => {
            this.plugin.settings.adapterMode = value as AdapterMode
            await this.plugin.saveSettings()
          })
      )
  }
}
