import { App, PluginSettingTab, Setting } from 'obsidian'
import type CrdtSyncPlugin from './main'

export type AdapterMode = 'main-editor' | 'collab-view'

export interface CrdtSyncSettings {
  serverUrl: string
  token: string
  displayName: string
  adapterMode: AdapterMode
  vaultId: string
}

export const DEFAULT_SETTINGS: CrdtSyncSettings = {
  serverUrl: 'ws://localhost:1234',
  token: '',
  displayName: '',
  adapterMode: 'main-editor',
  vaultId: ''
}

export class CrdtSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: CrdtSyncPlugin) {
    super(app, plugin)
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('WebSocket endpoint of the CRDT Sync server.')
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
      .setName('Editor integration')
      .setDesc('How remote edits are applied to an open note.')
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

    new Setting(containerEl)
      .setName('Vault ID')
      .setDesc(
        'Identifier shared by all devices (and, for testing, other vaults) that should sync the same notes. Generated automatically; set the same value in a second vault to join the same rooms. Rooms are keyed by vault ID + note path.'
      )
      .addText((text) =>
        text.setValue(this.plugin.settings.vaultId).onChange(async (value) => {
          this.plugin.settings.vaultId = value.trim()
          await this.plugin.saveSettings()
        })
      )
  }
}
