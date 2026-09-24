import { Notice, Plugin, TFile, TFolder, editorInfoField, requestUrl, type TAbstractFile } from 'obsidian'
import { docRoom, settingsRoom, userColor, type CollabUser, type RegistrationMode } from '@obsidian-connect/shared'
import { ConnectApi, type HttpClient } from './account/api'
import { hashWasmArgon2id } from './account/argon2'
import { KeyRing } from './account/KeyRing'
import { PasswordModal } from './account/PasswordModal'
import { Session, type OpenVault, type SecretStore, type Unlocked } from './account/Session'
import { EditorSync } from './editor/EditorSync'
import { BackupModal } from './history/BackupModal'
import { HistoryModal } from './history/HistoryModal'
import { NoteHistory } from './history/NoteHistory'
import { AccessModal } from './share/AccessModal'
import { IncomingModal } from './share/IncomingModal'
import { ShareModal } from './share/ShareModal'
import { Sharing } from './share/Sharing'
import { AccountSettings, DEFAULT_SHARED_SETTINGS, type SharedSettings } from './sync/AccountSettings'
import { BackupStore } from './sync/BackupStore'
import { Compactor } from './sync/Compactor'
import { LocalCursor, openIndexedDb, type LocalStore } from './sync/DocHandle'
import { DocStore, type DocStoreOptions } from './sync/DocStore'
import { StateStore } from './sync/StateStore'
import { VaultIndex } from './sync/VaultIndex'
import { VaultSocket, type SocketStatus } from './sync/VaultSocket'
import { ObsidianConnectSettingTab, DEFAULT_SETTINGS, type ObsidianConnectSettings } from './settings'

// Settings of earlier versions that moved to the account, and are handed over
// once to its settings document.
const MOVED_TO_ACCOUNT = ['excludeGlobs', 'conflictMarkers', 'backupRetentionDays'] as const
const COMPACT_EVERY_MS = 6 * 60 * 60 * 1000
const COMPACT_DELAY_MS = 60 * 1000

/** Obsidian's own request function: no CORS, works on mobile. */
const obsidianHttp: HttpClient = async (request) => {
  const headers: Record<string, string> = {}
  if (request.token) headers.Authorization = `Bearer ${request.token}`
  const response = await requestUrl({
    url: request.url,
    method: request.method,
    headers,
    contentType: request.body === undefined ? undefined : 'application/json',
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    throw: false
  })
  let json: unknown = null
  try {
    json = response.json
  } catch {
    // not every error has a body
  }
  return { status: response.status, json }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export default class ObsidianConnectPlugin extends Plugin {
  settings: ObsidianConnectSettings = { ...DEFAULT_SETTINGS }

  private readonly secrets: SecretStore = {
    load: (key) => {
      const value: unknown = this.app.loadLocalStorage(key)
      return typeof value === 'string' ? value : null
    },
    save: (key, value) => this.app.saveLocalStorage(key, value)
  }
  private readonly api = new ConnectApi(
    () => this.settings.serverUrl,
    obsidianHttp,
    () => this.settings.token || null
  )
  private readonly session = new Session(this.api, this.secrets, hashWasmArgon2id, (token, username) =>
    this.storeToken(token, username)
  )
  private readonly editors = new EditorSync(
    () => this.store,
    (state) => state.field(editorInfoField, false)?.file ?? null
  )

  private unlocked: Unlocked | null = null
  private vault: OpenVault | null = null
  private keys: KeyRing | null = null
  private socket: VaultSocket | null = null
  private index: VaultIndex | null = null
  private store: DocStore | null = null
  private state: StateStore | null = null
  private backups: BackupStore | null = null
  private accountSettings: AccountSettings | null = null
  private settingsStore: LocalStore | null = null
  private settingsCursor: LocalCursor | null = null
  private sharing: Sharing | null = null
  private compactor: Compactor | null = null
  private movedSettings: Partial<SharedSettings> | null = null
  private settingTab: ObsidianConnectSettingTab | null = null
  private statusBar!: HTMLElement
  private status: SocketStatus = 'disconnected'
  private unwatchIndex: (() => void) | null = null
  private unwatchSocket: (() => void) | null = null
  private unwatchSettings: (() => void) | null = null
  private indexTimer: number | null = null
  private started = false
  private starting = false
  private opening = false

  async onload(): Promise<void> {
    await this.loadSettings()

    this.statusBar = this.addStatusBarItem()
    this.settingTab = new ObsidianConnectSettingTab(this.app, this)
    this.addSettingTab(this.settingTab)
    // Obsidian adds this to every Markdown editor and keeps it there across
    // file switches and mode changes.
    this.registerEditorExtension(this.editors.extension)

    this.addRibbonIcon('refresh-cw', 'Obsidian Connect status', () => this.showStatus())
    this.addCommand({ id: 'show-status', name: 'Show sync status', callback: () => this.showStatus() })
    this.addCommand({
      id: 'open-history',
      name: 'Open version history for this note',
      callback: () => this.openHistory()
    })
    this.addCommand({ id: 'open-backups', name: 'Browse backups', callback: () => this.openBackups() })
    this.addCommand({ id: 'resync-note', name: 'Force resync of this note', callback: () => void this.resyncActive() })
    this.addCommand({
      id: 'restart-sync',
      name: 'Reconnect and rescan the vault',
      callback: () => void this.restartSync()
    })
    this.addCommand({ id: 'share-note', name: 'Share this note…', callback: () => this.openShare() })
    this.addCommand({ id: 'note-access', name: 'Who has access to this note', callback: () => this.openAccess() })
    this.addCommand({ id: 'shared-with-me', name: 'Notes shared with me', callback: () => this.openIncoming() })
    this.addCommand({
      id: 'detach-note',
      name: 'Make this shared note my own copy',
      callback: () => void this.detachActive()
    })

    this.registerVaultEvents()
    this.registerInterval(window.setInterval(() => void this.compact(), COMPACT_EVERY_MS))

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
    const stored = ((await this.loadData()) ?? {}) as Record<string, unknown>
    const settings = { ...DEFAULT_SETTINGS }
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof ObsidianConnectSettings>) {
      const value = stored[key]
      if (typeof value === typeof DEFAULT_SETTINGS[key]) (settings as Record<string, unknown>)[key] = value
    }
    this.settings = settings
    const moved: Partial<SharedSettings> = {}
    for (const key of MOVED_TO_ACCOUNT) {
      if (stored[key] !== undefined) (moved as Record<string, unknown>)[key] = stored[key]
    }
    this.movedSettings = Object.keys(moved).length > 0 ? moved : null
  }

  private async storeToken(token: string | null, username: string | null): Promise<void> {
    this.settings.token = token ?? ''
    this.settings.username = username ?? ''
    await this.saveData(this.settings)
  }

  private vaultName(): string {
    return this.settings.vaultName || this.app.vault.getName()
  }

  private user(): CollabUser {
    const name = this.unlocked?.username ?? 'me'
    return { id: name, name, ...userColor(name) }
  }

  private pluginDir(): string {
    return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`
  }

  private shared(): SharedSettings {
    return this.accountSettings?.get() ?? DEFAULT_SHARED_SETTINGS
  }

  sharedSettings(): SharedSettings | null {
    return this.accountSettings?.get() ?? null
  }

  updateSharedSettings(patch: Partial<SharedSettings>): void {
    this.accountSettings?.set(patch)
    this.store?.setOptions(this.storeOptions())
  }

  private storeOptions(): DocStoreOptions {
    const shared = this.shared()
    return {
      vaultId: this.vault?.vaultId ?? '',
      user: this.user(),
      excludeGlobs: shared.excludeGlobs,
      conflictMarkers: shared.conflictMarkers,
      maxLoadedDocuments: this.settings.maxLoadedDocuments,
      syncTimeoutMs: this.settings.syncTimeoutMs,
      writeDebounceMs: this.settings.writeDebounceMs
    }
  }

  // --- account -------------------------------------------------------------

  async signIn(username: string, password: string): Promise<void> {
    if (!username || !password) throw new Error('Enter your name and password.')
    await this.stopSync()
    await this.session.login(username, password)
    new Notice(`Obsidian Connect: signed in as ${this.settings.username}.`)
    await this.startSync()
  }

  /** Whether the server lets anyone create an account; null while it cannot be reached. */
  async registration(): Promise<RegistrationMode | null> {
    try {
      return (await this.api.config()).registration
    } catch {
      return null
    }
  }

  async createAccount(username: string, password: string, repeat: string, invite: string): Promise<void> {
    if (!username) throw new Error('Choose a name.')
    if (password.length < 8) throw new Error('Use a password of at least 8 characters.')
    // There is no reset: a typo here locks the account's notes for good.
    if (password !== repeat) throw new Error('The passwords differ.')
    await this.stopSync()
    await this.session.register(username, password, invite)
    new Notice(
      `Obsidian Connect: account ${this.settings.username} created. Keep the password safe - it is the only way to decrypt your notes.`,
      12_000
    )
    await this.startSync()
  }

  async signOut(): Promise<void> {
    await this.stopSync()
    await this.session.signOut()
    this.unlocked = null
    this.renderStatus()
    new Notice('Obsidian Connect: signed out. Your notes stay in this vault.')
  }

  openPasswordChange(): void {
    new PasswordModal(this.app, async (current, next) => {
      if (!this.unlocked) throw new Error('Sign in first.')
      this.unlocked = await this.session.changePassword(this.unlocked, current, next)
    }).open()
  }

  // --- lifecycle -----------------------------------------------------------

  private async startSync(): Promise<void> {
    if (!this.settings.syncEnabled || this.store || this.opening) return
    this.opening = true
    try {
      await this.openSync()
    } finally {
      this.opening = false
    }
  }

  private async openSync(): Promise<void> {
    const unlocked = await this.session.unlock()
    if (!unlocked) {
      if (this.settings.username) {
        new Notice('Obsidian Connect: sign in again in the plugin settings.', 10_000)
        await this.storeToken(null, null)
      }
      this.renderStatus()
      return
    }
    this.unlocked = unlocked

    let vault: OpenVault
    try {
      vault = await this.session.openVault(unlocked, this.vaultName())
    } catch (error) {
      console.error('[obsidian-connect] opening the vault failed', error)
      new Notice(`Obsidian Connect could not open the vault "${this.vaultName()}". Is the server reachable?`, 10_000)
      return
    }
    this.vault = vault
    const keys = new KeyRing(vault, unlocked, this.api, this.secrets)
    this.keys = keys

    const root = this.pluginDir()
    this.state = new StateStore(this.app.vault.adapter, root)
    this.backups = new BackupStore(this.app.vault.adapter, root)
    this.index = new VaultIndex(vault.vaultId, (path, generation) => keys.docId(path, generation))
    const socket = new VaultSocket(this.settings.serverUrl, vault.vaultId, () => this.settings.token, {
      notify: (kind, payload) => void this.sharing?.onNotify(kind, payload).then(() => this.editors.refresh()),
      revoked: (room) => void this.sharing?.onRevoked(room).then(() => this.editors.refresh()),
      denied: (room, reason) => console.error(`[obsidian-connect] ${room} was refused: ${reason}`)
    })
    this.socket = socket

    // The account's settings first: the scan depends on what is excluded.
    const accountSettings = new AccountSettings()
    this.accountSettings = accountSettings
    this.settingsStore = openIndexedDb(`obsidian-connect/${vault.vaultId}/set`, accountSettings.doc)
    await this.settingsStore.whenSynced
    this.settingsCursor = await LocalCursor.load(this.settingsStore)
    socket.register(settingsRoom(vault.vaultId), accountSettings.doc, {
      crypto: keys.settingsCrypto(),
      cursor: this.settingsCursor
    })

    const store = new DocStore(
      this.app,
      socket,
      this.index,
      this.state,
      this.backups,
      this.storeOptions(),
      {
        indexCrypto: keys.indexCrypto(),
        docCrypto: (docId, entry) => (entry?.owner ? keys.sharedDocCrypto(docId) : keys.ownDocCrypto(docId))
      }
    )
    this.store = store
    this.sharing = new Sharing(this.api, keys, store, {
      folder: () => this.shared().sharedFolder,
      syncTimeoutMs: this.settings.syncTimeoutMs,
      autoAccept: () => (this.unlocked?.bundle.vaults.length ?? 0) <= 1
    })
    this.compactor = new Compactor(this.api, keys, () => this.shared().historyRetentionDays)

    // Editors bind as soon as the index is there, not after the whole vault
    // has been scanned: an open note is settled on its own, first.
    store.onReady(() => this.editors.refresh())
    store.onLeave((docId) => void this.sharing?.leave(docId))
    this.unwatchSettings = accountSettings.onChange(() => this.store?.setOptions(this.storeOptions()))
    this.unwatchSocket = socket.onStatus((status) => {
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

    socket.connect()
    await Promise.race([socket.whenSynced(settingsRoom(vault.vaultId)), delay(this.settings.syncTimeoutMs)])
    if (this.movedSettings && accountSettings.empty) accountSettings.set(this.movedSettings)
    this.movedSettings = null
    store.setOptions(this.storeOptions())
    void this.backups.prune(this.shared().backupRetentionDays)

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
      } else {
        void this.sharing?.checkIncoming().then(
          (waiting) => {
            if (waiting > 0) new Notice(`${waiting} note(s) were shared with you. Run "Notes shared with me".`, 10_000)
            this.editors.refresh()
          },
          (error: unknown) => console.warn('[obsidian-connect] checking for shared notes failed', error)
        )
        window.setTimeout(() => void this.compact(), COMPACT_DELAY_MS)
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

  private async compact(): Promise<void> {
    if (!this.started || !this.compactor) return
    try {
      const compacted = await this.compactor.run()
      if (compacted > 0) console.info(`[obsidian-connect] folded old history of ${compacted} note(s)`)
    } catch (error) {
      console.warn('[obsidian-connect] compacting history failed', error)
    }
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
    this.unwatchSettings?.()
    this.unwatchSettings = null
    const store = this.store
    this.store = null
    await store?.stop()
    try {
      await this.settingsCursor?.flush()
      await this.settingsStore?.destroy()
    } catch (error) {
      console.error('[obsidian-connect] closing the account settings failed', error)
    }
    this.socket?.destroy()
    this.index?.destroy()
    this.accountSettings?.destroy()
    this.started = false
    this.starting = false
    this.socket = null
    this.index = null
    this.state = null
    this.backups = null
    this.accountSettings = null
    this.settingsStore = null
    this.settingsCursor = null
    this.sharing = null
    this.compactor = null
    this.keys = null
    this.vault = null
    this.statusBar?.setText('')
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

  /** The active note and its id, or a notice saying why there is none. */
  private activeNote(): { file: TFile; docId: string } | null {
    const file = this.activeFile()
    if (!this.store?.ready) {
      new Notice(this.settings.username ? 'Obsidian Connect is not connected yet.' : 'Sign in to Obsidian Connect first.')
      return null
    }
    if (!file) {
      new Notice('Open a markdown note first.')
      return null
    }
    const docId = this.store.docIdForPath(file.path)
    if (!docId) {
      new Notice('This note is not synced yet.')
      return null
    }
    return { file, docId }
  }

  private openShare(): void {
    const note = this.activeNote()
    if (!note || !this.sharing || !this.store) return
    const owner = this.store.entry(note.docId)?.owner
    if (owner) {
      new Notice(`This note belongs to ${owner}; only they can share it.`)
      return
    }
    new ShareModal(this.app, this.sharing, note.file, note.docId).open()
  }

  private openAccess(): void {
    const note = this.activeNote()
    if (!note || !this.sharing) return
    new AccessModal(this.app, this.sharing, note.file, note.docId).open()
  }

  private openIncoming(): void {
    if (!this.sharing || !this.store?.ready) {
      new Notice('Sign in to Obsidian Connect first.')
      return
    }
    new IncomingModal(this.app, this.sharing, this.vault?.name ?? this.vaultName()).open()
  }

  private async detachActive(): Promise<void> {
    const note = this.activeNote()
    if (!note || !this.sharing || !this.store) return
    if (!this.store.entry(note.docId)?.owner) {
      new Notice('This note is already yours.')
      return
    }
    try {
      await this.sharing.detach(note.docId)
      this.editors.refresh()
      new Notice(`${note.file.basename} is now a note of your own. The share ended for you; the others keep theirs.`)
    } catch (error) {
      console.error('[obsidian-connect] detaching failed', error)
      new Notice(`Making a copy failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // --- commands ------------------------------------------------------------

  statusLine(): string {
    if (!this.store) return this.settings.syncEnabled ? 'Not syncing yet.' : 'Sync is off on this device.'
    const label =
      this.status === 'connected' ? 'synced' : this.status === 'connecting' ? 'connecting' : 'offline'
    return `Vault "${this.vault?.name ?? ''}": ${label}, ${this.store.trackedCount()} notes`
  }

  private renderStatus(): void {
    if (!this.store) {
      this.statusBar.setText(this.settings.username ? '' : 'Connect: signed out')
      return
    }
    const label =
      this.status === 'connected' ? 'synced' : this.status === 'connecting' ? 'connecting' : 'offline'
    this.statusBar.setText(`Connect: ${label} · ${this.store.loadedCount()}/${this.store.trackedCount()}`)
  }

  private showStatus(): void {
    if (!this.store) {
      new Notice(
        this.settings.username
          ? 'Obsidian Connect is not syncing. Enable it in the plugin settings.'
          : 'Obsidian Connect: sign in in the plugin settings.'
      )
      return
    }
    new Notice(
      [
        `Connection: ${this.status}`,
        `Server: ${this.settings.serverUrl}`,
        `Account: ${this.settings.username}`,
        `Vault: ${this.vault?.name ?? '-'}`,
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

  private openHistory(): void {
    const note = this.activeNote()
    const store = this.store
    const keys = this.keys
    if (!note || !store || !keys) return
    const crypto = store.entry(note.docId)?.owner ? keys.sharedDocCrypto(note.docId) : keys.ownDocCrypto(note.docId)
    new HistoryModal(this.app, {
      history: new NoteHistory(this.api, docRoom(note.docId), crypto),
      file: note.file,
      canRestore: !store.isReadOnly(note.docId),
      restore: (text) => store.restore(note.docId, text)
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
