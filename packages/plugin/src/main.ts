import { MarkdownView, Notice, Plugin, TFile, type TAbstractFile } from 'obsidian'
import type { EditorView } from '@codemirror/view'
import type { CollabUser } from '@obsidian-connect/shared'
import { CollabView, COLLAB_VIEW_TYPE } from './editor/CollabView'
import { CollabViewAdapter } from './editor/CollabViewAdapter'
import { getEditorView, MainEditorCollabAdapter } from './editor/MainEditorCollabAdapter'
import type { CollabAdapter } from './editor/types'
import { HistoryModal } from './history/HistoryModal'
import { BackupModal } from './history/BackupModal'
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

interface BoundEditor {
  docId: string
  adapter: CollabAdapter
}

const PLUGIN_COLOR = '#30bced'

export default class ObsidianConnectPlugin extends Plugin {
  settings: ObsidianConnectSettings = { ...DEFAULT_SETTINGS }

  private socket: VaultSocket | null = null
  private index: VaultIndex | null = null
  private store: DocStore | null = null
  private state: StateStore | null = null
  private backups: BackupStore | null = null
  private statusBar!: HTMLElement
  private status: SocketStatus = 'disconnected'
  private readonly bound = new Map<string, BoundEditor>()
  private unwatchIndex: (() => void) | null = null
  private indexTimer: number | null = null
  private started = false
  private starting = false

  async onload(): Promise<void> {
    await this.loadSettings()

    this.statusBar = this.addStatusBarItem()
    this.registerView(COLLAB_VIEW_TYPE, (leaf) => new CollabView(leaf))
    this.addSettingTab(new ObsidianConnectSettingTab(this.app, this))

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

    this.registerVaultEvents()

    const refresh = (): void => this.syncEditorBindings()
    this.registerEvent(this.app.workspace.on('layout-change', refresh))
    this.registerEvent(this.app.workspace.on('active-leaf-change', refresh))
    this.registerEvent(this.app.workspace.on('file-open', refresh))

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
    if (!this.settings.vaultId) {
      this.settings.vaultId = crypto.randomUUID()
      await this.saveData(this.settings)
    }
  }

  private user(): CollabUser {
    const name = this.settings.displayName || 'Local user'
    return { id: name, name, color: PLUGIN_COLOR, colorLight: `${PLUGIN_COLOR}33` }
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
      liveCollaboration: this.settings.liveCollaboration,
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
    this.store = new DocStore(
      this.app,
      this.socket,
      this.index,
      this.state,
      this.backups,
      this.storeOptions()
    )

    this.register(
      this.socket.onStatus((status) => {
        this.status = status
        this.renderStatus()
        // The first attempt gives up if the index does not arrive in time;
        // reconnecting is the moment to try again, otherwise a server that was
        // down at startup leaves the vault untracked until Obsidian restarts.
        if (status === 'connected' && !this.started) void this.runStart()
      })
    )
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
      }
    } catch (error) {
      console.error('[obsidian-connect] starting sync failed', error)
      new Notice('Obsidian Connect could not start; see the console.')
    } finally {
      this.starting = false
    }
    this.syncEditorBindings()
    this.renderStatus()
  }

  private async stopSync(): Promise<void> {
    for (const [path, entry] of this.bound) {
      void entry.adapter.detach()
      this.bound.delete(path)
    }
    if (this.indexTimer !== null) {
      window.clearTimeout(this.indexTimer)
      this.indexTimer = null
    }
    this.unwatchIndex?.()
    this.unwatchIndex = null
    await this.store?.stop()
    this.socket?.destroy()
    this.index?.destroy()
    this.started = false
    this.starting = false
    this.store = null
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
        void this.store?.onDelete(file.path)
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
      void this.store?.applyRemoteIndexChanges()
    }, 500)
  }

  // --- editor integration --------------------------------------------------

  private markdownViews(): MarkdownView[] {
    const views: MarkdownView[] = []
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file) views.push(leaf.view)
    }
    return views
  }

  private syncEditorBindings(): void {
    const store = this.store
    const index = this.index
    if (!store || !index) return

    const open = new Set<string>()
    for (const view of this.markdownViews()) {
      const file = view.file
      if (!file || store.isExcluded(file.path)) continue
      open.add(file.path)
      const docId = index.docIdForPath(file.path)
      if (!docId) continue

      const existing = this.bound.get(file.path)
      if (existing && existing.docId === docId) {
        try {
          existing.adapter.ensureAttached?.()
        } catch (error) {
          console.error(`[obsidian-connect] re-attaching ${file.path} failed`, error)
        }
        continue
      }
      if (existing) {
        void existing.adapter.detach()
        store.unpin(existing.docId)
        store.setEditorOwned(existing.docId, false)
        this.bound.delete(file.path)
      }
      void this.bindEditor(file, docId)
    }

    for (const [path, entry] of Array.from(this.bound)) {
      if (open.has(path)) continue
      void entry.adapter.detach()
      store.unpin(entry.docId)
      store.setEditorOwned(entry.docId, false)
      this.bound.delete(path)
    }
  }

  private async bindEditor(file: TFile, docId: string): Promise<void> {
    const store = this.store
    if (!store) return
    // Pin first: the handle must not be evicted while an editor shows it.
    store.pin(docId)
    const handle = await store.handleFor(docId)

    if (this.settings.adapterMode === 'collab-view') {
      const adapter = new CollabViewAdapter(this.app, {
        ytext: handle.ytext,
        awareness: handle.awareness,
        title: file.basename
      })
      await adapter.attach()
      this.bound.set(file.path, { docId, adapter })
      return
    }

    const resolveView = (): EditorView | null => {
      for (const view of this.markdownViews()) {
        if (view.file?.path !== file.path) continue
        const editor = view.editor
        return editor ? getEditorView(editor) : null
      }
      return null
    }

    if (!resolveView()) {
      store.unpin(docId)
      return
    }

    const adapter = new MainEditorCollabAdapter(
      resolveView,
      handle.ytext,
      handle.collabEnabled ? handle.awareness : null
    )
    try {
      adapter.attach()
      // Obsidian saves this buffer itself; a second writer would loop.
      store.setEditorOwned(docId, true)
      this.bound.set(file.path, { docId, adapter })
    } catch (error) {
      console.error('[obsidian-connect] main editor integration failed', error)
      new Notice('Main editor integration unavailable; opening the fallback view.')
      const fallback = new CollabViewAdapter(this.app, {
        ytext: handle.ytext,
        awareness: handle.awareness,
        title: file.basename
      })
      await fallback.attach()
      this.bound.set(file.path, { docId, adapter: fallback })
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
        `Documents in memory: ${this.store.loadedCount()}`,
        `Editors bound: ${this.bound.size}`
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
      onRestored: () => this.syncEditorBindings()
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
      await this.store.syncFile(file, true)
      new Notice(`${file.basename} resynced.`)
    } catch (error) {
      console.error('[obsidian-connect] resync failed', error)
      new Notice('Resync failed; see the console.')
    }
  }
}
