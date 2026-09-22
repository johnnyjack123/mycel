import { Notice, Plugin, TFile, TFolder, editorInfoField, type TAbstractFile } from 'obsidian'
import {
  SHARE_ACTION,
  isDocId,
  shareLink,
  userColor,
  type CollabUser,
  type ShareLink
} from '@obsidian-connect/shared'
import { EditorSync } from './editor/EditorSync'
import { HistoryModal } from './history/HistoryModal'
import { BackupModal } from './history/BackupModal'
import { JoinModal } from './share/JoinModal'
import { BackupStore } from './sync/BackupStore'
import { DocStore, type DocStoreOptions } from './sync/DocStore'
import { StateStore } from './sync/StateStore'
import { VaultIndex } from './sync/VaultIndex'
import { VaultSocket, type SocketStatus } from './sync/VaultSocket'
import {
  ObsidianConnectSettingTab,
  DEFAULT_SETTINGS,
  serverHttpUrl,
  type ObsidianConnectSettings
} from './settings'

// Settings earlier versions stored that no longer mean anything.
const RETIRED_SETTINGS = ['adapterMode', 'liveCollaboration']

export default class ObsidianConnectPlugin extends Plugin {
  settings: ObsidianConnectSettings = { ...DEFAULT_SETTINGS }

  private socket: VaultSocket | null = null
  private index: VaultIndex | null = null
  private store: DocStore | null = null
  private state: StateStore | null = null
  private backups: BackupStore | null = null
  private statusBar!: HTMLElement
  private status: SocketStatus = 'disconnected'
  private readonly editors = new EditorSync(
    () => this.store,
    (state) => state.field(editorInfoField, false)?.file ?? null
  )
  private unwatchIndex: (() => void) | null = null
  private unwatchSocket: (() => void) | null = null
  private indexTimer: number | null = null
  private started = false
  private starting = false

  async onload(): Promise<void> {
    await this.loadSettings()

    this.statusBar = this.addStatusBarItem()
    this.addSettingTab(new ObsidianConnectSettingTab(this.app, this))
    // Obsidian adds this to every Markdown editor and keeps it there across
    // file switches and mode changes.
    this.registerEditorExtension(this.editors.extension)

    this.addRibbonIcon('refresh-cw', 'Obsidian Connect status', () => this.showStatus())
    this.addCommand({
      id: 'show-status',
      name: 'Show sync status',
      callback: () => this.showStatus()
    })
    this.addCommand({
      id: 'open-history',
      name: 'Open version history for this note',
      callback: () => void this.openHistory()
    })
    this.addCommand({
      id: 'open-backups',
      name: 'Browse backups',
      callback: () => this.openBackups()
    })
    this.addCommand({
      id: 'resync-note',
      name: 'Force resync of this note',
      callback: () => void this.resyncActive()
    })
    this.addCommand({
      id: 'restart-sync',
      name: 'Reconnect and rescan the vault',
      callback: () => void this.restartSync()
    })
    this.addCommand({
      id: 'share-note',
      name: 'Share this note live',
      callback: () => void this.shareActive(true)
    })
    this.addCommand({
      id: 'stop-sharing-note',
      name: 'Stop sharing this note',
      callback: () => void this.shareActive(false)
    })
    this.addCommand({
      id: 'open-shared-note',
      name: 'Open a shared note',
      callback: () => new JoinModal(this.app, (link) => void this.openShared(link)).open()
    })
    this.registerObsidianProtocolHandler(SHARE_ACTION, (params) => {
      const docId = params.id ?? ''
      if (isDocId(docId)) void this.openShared({ docId, title: params.title ?? '' })
      else new Notice('Obsidian Connect: that share link is incomplete.')
    })

    this.registerVaultEvents()

    // The vault is not fully indexed while Obsidian is still starting, and a
    // scan that races it would treat half the notes as missing.
    this.app.workspace.onLayoutReady(() => {
      void this.startSync()
    })
  }

  async onunload(): Promise<void> {
    await this.stopSync()
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
    this.store?.setOptions(this.storeOptions())
  }

  private async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<ObsidianConnectSettings> | null
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {})
    for (const key of RETIRED_SETTINGS) delete (this.settings as unknown as Record<string, unknown>)[key]
    if (!this.settings.vaultId) {
      this.settings.vaultId = crypto.randomUUID()
      await this.saveData(this.settings)
    }
  }

  private user(): CollabUser {
    const name = this.settings.displayName || 'Anonymous'
    return { id: name, name, ...userColor(name) }
  }

  private pluginDir(): string {
    return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`
  }

  private storeOptions(): DocStoreOptions {
    return {
      vaultId: this.settings.vaultId,
      user: this.user(),
      excludeGlobs: this.settings.excludeGlobs,
      conflictMarkers: this.settings.conflictMarkers,
      maxLoadedDocuments: this.settings.maxLoadedDocuments,
      syncTimeoutMs: this.settings.syncTimeoutMs,
      writeDebounceMs: this.settings.writeDebounceMs
    }
  }

  // --- lifecycle -----------------------------------------------------------

  private async startSync(): Promise<void> {
    if (!this.settings.syncEnabled || this.store) return

    const root = this.pluginDir()
    this.state = new StateStore(this.app.vault.adapter, root)
    this.backups = new BackupStore(this.app.vault.adapter, root)
    this.index = new VaultIndex(this.settings.vaultId)
    this.socket = new VaultSocket(this.settings.serverUrl, this.settings.vaultId, this.settings.token)
    const store = new DocStore(this.app, this.socket, this.index, this.state, this.backups, this.storeOptions())
    this.store = store

    // Editors bind as soon as the index is there, not after the whole vault
    // has been scanned: an open note is settled on its own, first.
    store.onReady(() => this.editors.refresh())
    this.unwatchSocket = this.socket.onStatus((status) => {
      this.status = status
      this.renderStatus()
      if (status !== 'connected' || this.store !== store) return
      // The first attempt gives up if the index does not arrive in time;
      // reconnecting is the moment to try again, otherwise a server that was
      // down at startup leaves the vault untracked until Obsidian restarts.
      if (!this.started) void this.runStart()
      else void store.resume().then(() => this.editors.refresh())
    })
    this.unwatchIndex = this.index.onChange(() => this.scheduleIndexApply())

    this.socket.connect()
    void this.backups.prune(this.settings.backupRetentionDays)

    await this.runStart()
  }

  private async runStart(): Promise<void> {
    const store = this.store
    if (!store || this.started || this.starting) return
    this.starting = true
    try {
      this.started = await store.start()
      if (!this.started) {
        new Notice(
          `Obsidian Connect: no answer from ${this.settings.serverUrl}. Nothing is synced until it responds.`,
          8_000
        )
        // A slow index is not a dead server; start the moment it arrives.
        void store.whenIndexSynced().then(() => {
          if (this.store === store) void this.runStart()
        })
      }
    } catch (error) {
      console.error('[obsidian-connect] starting sync failed', error)
      new Notice('Obsidian Connect could not start; see the console.')
    } finally {
      this.starting = false
    }
    this.editors.refresh()
    this.renderStatus()
  }

  private async stopSync(): Promise<void> {
    // Editors first: releasing them hands their files back to the store,
    // which must still be there to take them.
    this.editors.unbindAll()
    if (this.indexTimer !== null) {
      window.clearTimeout(this.indexTimer)
      this.indexTimer = null
    }
    this.unwatchIndex?.()
    this.unwatchIndex = null
    this.unwatchSocket?.()
    this.unwatchSocket = null
    const store = this.store
    this.store = null
    await store?.stop()
    this.socket?.destroy()
    this.index?.destroy()
    this.started = false
    this.starting = false
    this.socket = null
    this.index = null
    this.state = null
    this.backups = null
    this.statusBar.setText('')
  }

  async restartSync(): Promise<void> {
    await this.stopSync()
    await this.startSync()
  }

  // --- vault events --------------------------------------------------------

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.vault.on('modify', (file: TAbstractFile) => {
        if (file instanceof TFile) void this.store?.onModify(file)
      })
    )
    this.registerEvent(
      this.app.vault.on('create', (file: TAbstractFile) => {
        if (file instanceof TFile) void this.store?.onCreate(file)
      })
    )
    this.registerEvent(
      this.app.vault.on('delete', (file: TAbstractFile) => {
        if (file instanceof TFile) void this.store?.onDelete(file.path)
        else if (file instanceof TFolder) void this.store?.onDeleteFolder(file.path)
      })
    )
    this.registerEvent(
      this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        if (file instanceof TFile) void this.store?.onRename(file, oldPath)
      })
    )
  }

  private scheduleIndexApply(): void {
    if (this.indexTimer !== null) window.clearTimeout(this.indexTimer)
    this.indexTimer = window.setTimeout(() => {
      this.indexTimer = null
      const store = this.store
      if (!store) return
      void store.applyRemoteIndexChanges().then(() => {
        // New notes may have arrived, and a share may have started or ended.
        this.editors.refresh()
        this.renderStatus()
      })
    }, 500)
  }

  // --- sharing -------------------------------------------------------------

  private async shareActive(shared: boolean): Promise<void> {
    const file = this.activeFile()
    const store = this.store
    if (!file || !store?.ready || !this.index) {
      new Notice(store ? 'Open a synced note first.' : 'Obsidian Connect is off.')
      return
    }
    const docId = this.index.docIdForPath(file.path)
    if (!docId) {
      new Notice('This note is not synced yet.')
      return
    }

    store.share(docId, shared)
    this.editors.refresh()
    this.renderStatus()

    if (!shared) {
      new Notice(
        `${file.basename} is no longer shown as shared, and cursors are off. Anyone who has the link can still open it: until accounts exist, a link cannot be revoked.`,
        12_000
      )
      return
    }

    const link = shareLink({ docId, title: file.basename })
    let copied = false
    try {
      await navigator.clipboard.writeText(link)
      copied = true
    } catch {
      // Shown in the notice instead.
    }
    const who = this.settings.displayName
      ? ''
      : '\n\nSet a display name in the settings so the others see who is typing.'
    new Notice(
      `${copied ? 'Share link copied' : `Share link:\n${link}`}\n\nAnyone with this link who uses your server can open and edit ${file.basename} live. Copies they keep stay with them, even if you stop sharing.${who}`,
      20_000
    )
  }

  private async openShared(link: ShareLink): Promise<void> {
    const store = this.store
    if (!store?.ready) {
      new Notice('Obsidian Connect is not connected yet. Try again once the status bar says synced.')
      return
    }
    const file = await store.join(link.docId, link.title, this.settings.sharedFolder)
    if (!file) {
      new Notice('The shared note could not be loaded. Is the server reachable?')
      return
    }
    await this.app.workspace.getLeaf('tab').openFile(file)
    this.editors.refresh()
    this.renderStatus()
    if (file.stat.size === 0) {
      new Notice(
        `${file.basename} is empty. If the person who shared it sees text, the two of you are not on the same server.`,
        12_000
      )
    }
  }

  // --- commands ------------------------------------------------------------

  private renderStatus(): void {
    if (!this.store) {
      this.statusBar.setText('')
      return
    }
    const label =
      this.status === 'connected' ? 'synced' : this.status === 'connecting' ? 'connecting' : 'offline'
    this.statusBar.setText(`Connect: ${label} · ${this.store.loadedCount()}/${this.store.trackedCount()}`)
  }

  private showStatus(): void {
    if (!this.store) {
      new Notice('Obsidian Connect is off. Enable it in the plugin settings.')
      return
    }
    new Notice(
      [
        `Connection: ${this.status}`,
        `Server: ${this.settings.serverUrl}`,
        `Vault ID: ${this.settings.vaultId}`,
        `Notes tracked: ${this.store.trackedCount()}`,
        `Shared notes: ${this.store.sharedCount()}`,
        `Documents in memory: ${this.store.loadedCount()}`,
        `Editors bound: ${this.editors.boundCount()}`
      ].join('\n'),
      15_000
    )
  }

  private activeFile(): TFile | null {
    const file = this.app.workspace.getActiveFile()
    return file instanceof TFile && file.extension === 'md' ? file : null
  }

  private async openHistory(): Promise<void> {
    const file = this.activeFile()
    if (!file || !this.index) {
      new Notice('Open a markdown note first.')
      return
    }
    const docId = this.index.docIdForPath(file.path)
    if (!docId) {
      new Notice('This note is not tracked yet.')
      return
    }
    new HistoryModal(this.app, {
      httpUrl: serverHttpUrl(this.settings.serverUrl),
      token: this.settings.token,
      docId,
      file,
      // The rollback edits the live document, so it arrives like any other
      // remote change; nothing to do here beyond what the binding does.
      onRestored: () => this.editors.refresh()
    }).open()
  }

  private openBackups(): void {
    if (!this.backups) {
      new Notice('Obsidian Connect is off.')
      return
    }
    new BackupModal(this.app, this.backups).open()
  }

  private async resyncActive(): Promise<void> {
    const file = this.activeFile()
    if (!file || !this.store) {
      new Notice('Open a markdown note first.')
      return
    }
    try {
      await this.store.syncFile(file)
      new Notice(`${file.basename} resynced.`)
    } catch (error) {
      console.error('[obsidian-connect] resync failed', error)
      new Notice('Resync failed; see the console.')
    }
  }
}
