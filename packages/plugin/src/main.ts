import { Notice, Platform, Plugin, TFile, TFolder, editorInfoField, requestUrl, setIcon, type Menu, type TAbstractFile } from 'obsidian'
import {
  docRoom,
  settingsRoom,
  userColor,
  type CollabUser,
  type ContactNotice,
  type Notice as ServerNotice,
  type NotifyKind,
  type ShareNotice
} from '@obsidian-connect/shared'
import { ConnectApi, type HttpClient } from './account/api'
import { judgePassword } from './account/password'
import { probeServer, type ServerProbe } from './account/probe'
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
import { Contacts, type OpenCode } from './share/Contacts'
import { Sharing } from './share/Sharing'
import { AccountSettings, DEFAULT_SHARED_SETTINGS, type Contact, type SharedSettings } from './sync/AccountSettings'
import { AttachmentIndex } from './sync/AttachmentIndex'
import { AttachmentStore, type AttachmentOptions } from './sync/AttachmentStore'
import { BackupStore } from './sync/BackupStore'
import { Blobs } from './sync/Blobs'
import { Compactor } from './sync/Compactor'
import { LocalCursor, openIndexedDb, type LocalStore } from './sync/DocHandle'
import { DocStore, type DocStoreOptions, type NoteSyncState } from './sync/DocStore'
import { indexedDbHistory, type HistoryStore } from './sync/History'
import { Recovery } from './sync/Recovery'
import { RecoveryModal } from './history/RecoveryModal'
import { StateStore } from './sync/StateStore'
import { Trash } from './sync/Trash'
import { TrashModal } from './history/TrashModal'
import { ReviewStore, type Review } from './sync/Reviews'
import { ReviewListModal, ReviewModal } from './history/ReviewModal'
import { VaultIndex } from './sync/VaultIndex'
import { VaultSocket, type SocketStatus } from './sync/VaultSocket'
import { ObsidianConnectSettingTab, DEFAULT_SETTINGS, MOBILE_DOWNLOAD_LIMIT_MB, type ObsidianConnectSettings } from './settings'
import { log } from './log'

// Settings of earlier versions that moved to the account, and are handed over
// once to its settings document.
const MOVED_TO_ACCOUNT = ['excludeGlobs', 'conflictMarkers', 'backupRetentionDays'] as const
const COMPACT_EVERY_MS = 6 * 60 * 60 * 1000
const COMPACT_DELAY_MS = 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const NOTE_STATUS_MS = 400
const MB = 1024 * 1024
// Programs write a file in pieces; it is taken in once it stayed unchanged this long.
const ATTACHMENT_SETTLE_MS = 2_000

const NOTE_STATUS_TEXT: Record<Exclude<NoteSyncState, 'untracked'>, string> = {
  synced: 'This note is synced: everything written here has reached the server.',
  unsent: 'This note has changes the server has not confirmed yet.',
  waiting: 'Not known yet whether this note is up to date: the server has not answered.',
  held: "The server's copy of this note differs from what this device knew. It waits for your decision."
}

/** Obsidian's own request function: no CORS, works on mobile. */
const obsidianHttp: HttpClient = async (request) => {
  const headers: Record<string, string> = {}
  if (request.token) headers.Authorization = `Bearer ${request.token}`
  const bytes = request.bytes
  const response = await requestUrl({
    url: request.url,
    method: request.method,
    headers,
    contentType: bytes ? 'application/octet-stream' : request.body === undefined ? undefined : 'application/json',
    // A copy, so the body is exactly the chunk and not the buffer it was cut from.
    body: bytes ? bytes.slice().buffer : request.body === undefined ? undefined : JSON.stringify(request.body),
    throw: false
  })
  if (request.binary && response.status >= 200 && response.status < 300) {
    return { status: response.status, json: null, bytes: new Uint8Array(response.arrayBuffer) }
  }
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
  private readonly session = new Session(
    this.api,
    this.secrets,
    hashWasmArgon2id,
    (token, username) => this.storeToken(token, username),
    () => this.settings.serverUrl
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
  private attachmentIndex: AttachmentIndex | null = null
  private attachments: AttachmentStore | null = null
  /** What the server takes, from its config; 0 until it answered. */
  private maxFileBytes = 0
  private state: StateStore | null = null
  private backups: BackupStore | null = null
  private accountSettings: AccountSettings | null = null
  private settingsStore: LocalStore | null = null
  private settingsCursor: LocalCursor | null = null
  private sharing: Sharing | null = null
  private contacts: Contacts | null = null
  private compactor: Compactor | null = null
  private trash: Trash | null = null
  private reviews: ReviewStore | null = null
  private history: HistoryStore | null = null
  private recovery: Recovery | null = null
  private movedSettings: Partial<SharedSettings> | null = null
  private settingTab: ObsidianConnectSettingTab | null = null
  private statusBar!: HTMLElement
  private noteStatus!: HTMLElement
  private noteStatusKey = ''
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
    log.verbose = this.settings.verboseLog
    await log.attach(this.app.vault.adapter, `${this.pluginDir()}/logs`)
    log.info(`loaded ${this.manifest.version}${Platform.isMobile ? ' on mobile' : ''}`)

    this.statusBar = this.addStatusBarItem()
    this.noteStatus = this.addStatusBarItem()
    this.noteStatus.addClass('connect-note-status')
    this.noteStatus.addEventListener('click', () => this.explainNoteStatus())
    // Cheap - a few lookups for one note - and it catches every way a note
    // changes state without wiring each of them up.
    this.registerInterval(window.setInterval(() => this.renderNoteStatus(), NOTE_STATUS_MS))
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.renderNoteStatus()))
    // Files over this device's download limit come when a note needs them.
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file?.extension === 'md') void this.attachments?.fetchFor(file)
      })
    )
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => this.noteMenu(menu, file)))
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, _editor, info) => {
        if (info.file) this.noteMenu(menu, info.file)
      })
    )
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
    this.addCommand({ id: 'deleted-notes', name: 'Deleted notes…', callback: () => this.openTrash() })
    this.addCommand({ id: 'copy-log', name: 'Copy the log (for a bug report)', callback: () => void this.copyLog() })
    this.addCommand({ id: 'compare-versions', name: 'Compare the two versions of this note', callback: () => void this.openReview() })
    this.addCommand({ id: 'review-notes', name: 'Notes with two versions…', callback: () => void this.openReviews() })
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
    log.info('unloaded')
    await log.detach()
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
    log.verbose = this.settings.verboseLog
    this.store?.setOptions(this.storeOptions())
    this.attachments?.setOptions(this.attachmentOptions())
    // A higher limit may let files in that waited.
    void this.attachments?.applyRemoteChanges()
  }

  /** Everything still only on the server, whatever this device's limit. */
  async downloadAllAttachments(): Promise<number> {
    if (!this.attachments?.isReady) throw new Error('Obsidian Connect is not connected yet.')
    return this.attachments.fetchAll()
  }

  /** The recent log, onto the clipboard - for a bug report. */
  async copyLog(): Promise<void> {
    await navigator.clipboard.writeText(await log.recent())
    new Notice('Obsidian Connect: the log of today and yesterday is on the clipboard.')
  }

  private async loadSettings(): Promise<void> {
    const stored = ((await this.loadData()) ?? {}) as Record<string, unknown>
    const settings = { ...DEFAULT_SETTINGS }
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof ObsidianConnectSettings>) {
      const value = stored[key]
      if (typeof value === typeof DEFAULT_SETTINGS[key]) (settings as Record<string, unknown>)[key] = value
    }
    if (stored.attachmentDownloadLimitMb === undefined && Platform.isMobile) settings.attachmentDownloadLimitMb = MOBILE_DOWNLOAD_LIMIT_MB
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

  /** The account id, not the name: names are not unique, and a caret of one's own other device is told apart by it. */
  private user(): CollabUser {
    const name = this.unlocked?.username ?? 'me'
    return { id: this.unlocked?.accountId ?? name, name, ...userColor(name) }
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
    this.attachments?.setOptions(this.attachmentOptions())
  }

  private attachmentOptions(): AttachmentOptions {
    const limit = this.settings.attachmentDownloadLimitMb
    return {
      excludeGlobs: this.shared().excludeGlobs,
      downloadLimitBytes: limit < 0 ? null : Math.round(limit * MB),
      maxFileBytes: this.maxFileBytes,
      settleMs: ATTACHMENT_SETTLE_MS
    }
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

  /** Whether the configured server can be signed in to, and how it takes new accounts. */
  probeServer(): Promise<ServerProbe> {
    return probeServer(this.api)
  }

  async createAccount(username: string, password: string, repeat: string, invite: string): Promise<void> {
    if (!username) throw new Error('Choose a name.')
    const verdict = judgePassword(password, [username])
    if (!verdict.ok) throw new Error(verdict.reason)
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
      log.error('opening the vault failed', error)
      new Notice(`Obsidian Connect could not open the vault "${this.vaultName()}". Is the server reachable?`, 10_000)
      return
    }
    this.vault = vault
    const keys = new KeyRing(vault, unlocked, this.api, this.secrets)
    this.keys = keys

    const root = this.pluginDir()
    this.state = new StateStore(this.app.vault.adapter, root)
    this.backups = new BackupStore(this.app.vault.adapter, root)
    const reviews = new ReviewStore(this.app.vault.adapter, root)
    this.reviews = reviews
    void reviews.list()
    this.index = new VaultIndex(vault.vaultId, (path, generation) => keys.docId(path, generation))
    const socket = new VaultSocket(this.settings.serverUrl, vault.vaultId, () => this.settings.token, {
      notify: (kind, payload) => this.onNotify(kind, payload),
      revoked: (room) => void this.sharing?.onRevoked(room).then(() => this.editors.refresh()),
      denied: (room, reason) => log.error(`${room} was refused: ${reason}`),
      diverged: (room) => this.recovery?.diverged(room)
    })
    this.socket = socket
    this.history = indexedDbHistory(vault.vaultId)

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
      },
      openIndexedDb,
      this.history
    )
    this.store = store
    const attachmentIndex = new AttachmentIndex(this.index.doc, (path, generation) => keys.fileId(path, generation))
    this.attachmentIndex = attachmentIndex
    this.attachments = new AttachmentStore(this.app, attachmentIndex, this.state, new Blobs(this.api, keys), this.attachmentOptions())
    this.recovery = new Recovery({
      socket,
      store,
      settings: accountSettings,
      settingsReady: () =>
        Promise.race([socket.whenSynced(settingsRoom(vault.vaultId)), delay(this.settings.syncTimeoutMs)]),
      ask: (notes) => new RecoveryModal(this.app, notes).choose(),
      onResolved: () => this.editors.refresh()
    })
    this.contacts = new Contacts(
      this.api,
      { accountId: unlocked.accountId, username: unlocked.username, publicKey: unlocked.publicKey, privateKey: unlocked.privateKey },
      accountSettings
    )
    this.sharing = new Sharing(
      this.api,
      keys,
      store,
      {
        folder: () => this.shared().sharedFolder,
        syncTimeoutMs: this.settings.syncTimeoutMs,
        autoAccept: () => (this.unlocked?.bundle.vaults.length ?? 0) <= 1
      },
      this.contacts
    )
    this.compactor = new Compactor(this.api, keys, () => this.shared().historyRetentionDays)
    this.trash = new Trash(this.api, store, () => this.shared().historyRetentionDays)

    // Editors bind as soon as the index is there, not after the whole vault
    // has been scanned: an open note is settled on its own, first.
    store.onReady(() => this.editors.refresh())
    store.onLeave((docId) => void this.sharing?.leave(docId))
    store.onReview((review) => {
      void reviews.add(review).catch((error: unknown) => log.error(`keeping the review of ${review.path} failed`, error))
    })
    this.unwatchSettings = accountSettings.onChange(() => {
      this.store?.setOptions(this.storeOptions())
      this.attachments?.setOptions(this.attachmentOptions())
    })
    this.unwatchSocket = socket.onStatus((status) => {
      this.status = status
      this.renderStatus()
      if (status !== 'connected' || this.store !== store) return
      // The first attempt gives up if the index does not arrive in time;
      // reconnecting is the moment to try again, otherwise a server that was
      // down at startup leaves the vault untracked until Obsidian restarts.
      if (!this.started) void this.runStart()
      else {
        void store.resume().then(() => this.editors.refresh())
        void this.resumeAttachments()
      }
    })
    const unwatchNotes = this.index.onChange(() => this.scheduleIndexApply())
    const unwatchFiles = attachmentIndex.onChange(() => this.scheduleIndexApply())
    const unwatchTransfers = this.attachments.onTransfer(() => this.renderStatus())
    this.unwatchIndex = () => {
      unwatchNotes()
      unwatchFiles()
      unwatchTransfers()
    }

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
        // In the background: a first scan may have gigabytes to upload.
        void this.startAttachments()
        // Contacts first: a share may come from someone who became a contact while this device was away.
        await this.processContacts()
        void this.sharing?.checkEnded().then(
          (forked) => {
            if (forked > 0) new Notice(`${forked} shared note(s) ended while this device was away. Your copies are kept as notes of your own.`, 10_000)
            this.editors.refresh()
          },
          (error: unknown) => log.warn('checking for ended shares failed', error)
        )
        void this.sharing?.checkIncoming().then(
          (waiting) => {
            if (waiting > 0) new Notice(`${waiting} note(s) were shared with you. Run "Notes shared with me".`, 10_000)
            this.editors.refresh()
          },
          (error: unknown) => log.warn('checking for shared notes failed', error)
        )
        window.setTimeout(() => void this.compact(), COMPACT_DELAY_MS)
      }
    } catch (error) {
      log.error('starting sync failed', error)
      new Notice('Obsidian Connect could not start; see the console.')
    } finally {
      this.starting = false
    }
    this.editors.refresh()
    this.renderStatus()
  }

  /**
   * Attachments need to know how large a file the server takes. A server
   * from before attachments does not say, and its vaults sync notes only.
   */
  private async startAttachments(): Promise<void> {
    const attachments = this.attachments
    if (!attachments || attachments.isReady) return
    try {
      const config = await this.api.config()
      if (config.maxFileBytes === undefined) {
        log.warn('the server does not store attachments; only notes are synced')
        return
      }
      this.maxFileBytes = config.maxFileBytes
      attachments.setOptions(this.attachmentOptions())
      await attachments.start()
    } catch (error) {
      log.warn('starting to sync attachments failed; trying again on the next connection', error)
    }
    this.renderStatus()
  }

  private async resumeAttachments(): Promise<void> {
    if (this.attachments?.isReady) await this.attachments.resume()
    else await this.startAttachments()
  }

  private async compact(): Promise<void> {
    if (!this.started || !this.compactor) return
    try {
      const compacted = await this.compactor.run()
      if (compacted > 0) log.info(`folded old history of ${compacted} note(s)`)
    } catch (error) {
      log.warn('compacting history failed', error)
    }
    // The device's own copy of the history follows the same retention.
    const days = this.shared().historyRetentionDays
    if (days > 0) {
      await this.history?.prune(Date.now() - days * DAY_MS).catch((error: unknown) => {
        log.warn('pruning the local history failed', error)
      })
    }
    // And so do deleted notes: restorable within it, gone after.
    try {
      const purged = (await this.trash?.purge()) ?? 0
      if (purged > 0) log.info(`let go of ${purged} note(s) deleted more than ${days} days ago`)
    } catch (error) {
      log.warn('emptying the trash failed', error)
    }
  }

  private openTrash(): void {
    if (!this.trash || !this.store?.ready) {
      new Notice(this.settings.username ? 'Obsidian Connect is not connected yet.' : 'Sign in to Obsidian Connect first.')
      return
    }
    new TrashModal(this.app, this.trash, this.shared().historyRetentionDays).open()
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
    this.recovery?.stop()
    this.recovery = null
    // Before the notes: stopping those closes the state both write to.
    const attachments = this.attachments
    this.attachments = null
    await attachments?.stop()
    this.attachmentIndex?.destroy()
    this.attachmentIndex = null
    const store = this.store
    this.store = null
    await store?.stop()
    try {
      await this.settingsCursor?.flush()
      await this.settingsStore?.destroy()
    } catch (error) {
      log.error('closing the account settings failed', error)
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
    this.trash = null
    this.reviews = null
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
    // Both stores hear every event; each takes the files that are its own.
    this.registerEvent(
      this.app.vault.on('modify', (file: TAbstractFile) => {
        if (!(file instanceof TFile)) return
        void this.store?.onModify(file)
        this.attachments?.onModify(file)
      })
    )
    this.registerEvent(
      this.app.vault.on('create', (file: TAbstractFile) => {
        if (!(file instanceof TFile)) return
        void this.store?.onCreate(file)
        this.attachments?.onCreate(file)
      })
    )
    this.registerEvent(
      this.app.vault.on('delete', (file: TAbstractFile) => {
        if (file instanceof TFile) {
          void this.store?.onDelete(file.path)
          void this.attachments?.onDelete(file.path)
        } else if (file instanceof TFolder) {
          void this.store?.onDeleteFolder(file.path)
          void this.attachments?.onDeleteFolder(file.path)
        }
      })
    )
    this.registerEvent(
      this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        if (!(file instanceof TFile)) return
        void this.store?.onRename(file, oldPath)
        void this.attachments?.onRename(file, oldPath)
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
      void this.attachments?.applyRemoteChanges()
    }, 500)
  }

  // --- sharing -------------------------------------------------------------

  /** A note and its id - the active one unless given - or a notice saying why there is none. */
  private activeNote(file: TFile | null = this.activeFile()): { file: TFile; docId: string } | null {
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

  private openShare(file?: TFile): void {
    const note = this.activeNote(file)
    if (!note || !this.sharing || !this.store) return
    const owner = this.store.entry(note.docId)?.owner
    if (owner) {
      new Notice(`This note belongs to ${this.sharing.nameOf(owner)}; only they can share it.`)
      return
    }
    new ShareModal(this.app, this.sharing, note.file, note.docId, this.contactList()).open()
  }

  private openAccess(file?: TFile): void {
    const note = this.activeNote(file)
    if (!note || !this.sharing) return
    new AccessModal(this.app, this.sharing, note.file, note.docId).open()
  }

  /**
   * The note's own menus - its "..." menu, the file explorer's, the editor's
   * right click - carry what the command palette does for the active note.
   */
  private noteMenu(menu: Menu, file: TAbstractFile): void {
    const store = this.store
    if (!(file instanceof TFile) || file.extension !== 'md' || !store?.ready) return
    const docId = store.docIdForPath(file.path)
    if (!docId) return
    const entry = store.entry(docId)
    if (entry?.owner) {
      menu.addItem((item) => item.setTitle('Who has access').setIcon('users').onClick(() => this.openAccess(file)))
      menu.addItem((item) => item.setTitle('Make my own copy').setIcon('copy').onClick(() => void this.detachActive(file)))
    } else {
      menu.addItem((item) => item.setTitle('Share…').setIcon('share-2').onClick(() => this.openShare(file)))
      if (entry?.shared) menu.addItem((item) => item.setTitle('Who has access').setIcon('users').onClick(() => this.openAccess(file)))
    }
    menu.addItem((item) => item.setTitle('Version history').setIcon('history').onClick(() => this.openHistory(file)))
    if (this.attachments?.isReady && this.settings.attachmentDownloadLimitMb >= 0) {
      menu.addItem((item) =>
        item
          .setTitle('Download attachments')
          .setIcon('download')
          .onClick(async () => {
            const fetched = (await this.attachments?.fetchFor(file)) ?? 0
            new Notice(fetched > 0 ? `${fetched} attachment(s) of ${file.basename} downloaded.` : `${file.basename} has everything it embeds or links.`)
          })
      )
    }
    if (this.reviews?.pendingFor(docId)) {
      menu.addItem((item) => item.setTitle('Compare versions').setIcon('git-compare').onClick(() => void this.openReview(file)))
    }
  }

  /** The two versions of a note that were merged, to choose from. */
  private async openReview(file?: TFile): Promise<void> {
    const note = this.activeNote(file)
    const reviews = this.reviews
    if (!note || !reviews) return
    const review = (await reviews.list()).find((candidate) => candidate.docId === note.docId)
    if (!review) {
      new Notice(`${note.file.basename} has one version on all your devices; there is nothing to compare.`)
      return
    }
    this.showReview(review)
  }

  private async openReviews(): Promise<void> {
    const reviews = this.reviews
    if (!reviews) {
      new Notice('Sign in to Obsidian Connect first.')
      return
    }
    new ReviewListModal(this.app, await reviews.list(), (review) => this.showReview(review)).open()
  }

  private showReview(review: Review): void {
    const store = this.store
    const reviews = this.reviews
    if (!store || !reviews) return
    new ReviewModal(
      this.app,
      review,
      async (text) => {
        const outcome = await store.applyReview(review.docId, review.merged, text)
        await reviews.remove(review.id)
        return outcome
      },
      () => reviews.remove(review.id)
    ).open()
  }

  private openIncoming(): void {
    if (!this.sharing || !this.store?.ready) {
      new Notice('Sign in to Obsidian Connect first.')
      return
    }
    new IncomingModal(this.app, this.sharing, this.vault?.name ?? this.vaultName()).open()
  }

  private async detachActive(file?: TFile): Promise<void> {
    const note = this.activeNote(file)
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
      log.error('detaching failed', error)
      new Notice(`Making a copy failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // --- commands ------------------------------------------------------------

  private onNotify(kind: NotifyKind, payload: ServerNotice): void {
    if (kind === 'contact') {
      void this.processContacts()
      return
    }
    if (kind === 'contact-removed') {
      this.contacts?.forget((payload as ContactNotice).account)
      this.settingTab?.display()
      return
    }
    void this.sharing?.onNotify(kind, payload as ShareNotice).then(() => this.editors.refresh())
  }

  private async processContacts(): Promise<void> {
    try {
      const added = (await this.contacts?.processInbox()) ?? 0
      if (added > 0) {
        new Notice(`Obsidian Connect: ${added} contact(s) added.`)
        this.settingTab?.display()
      }
    } catch (error) {
      log.warn('reading the contact inbox failed', error)
    }
  }

  // --- contacts, for the settings tab --------------------------------------

  contactList(): Contact[] {
    return this.contacts?.list() ?? []
  }

  contactName(accountId: string): string {
    return this.contacts?.name(accountId) ?? accountId.slice(0, 8)
  }

  async createContactCode(): Promise<string> {
    if (!this.contacts) throw new Error('Sign in first.')
    return this.contacts.createCode()
  }

  async contactCodes(): Promise<OpenCode[]> {
    return (await this.contacts?.openCodes()) ?? []
  }

  async revokeContactCode(codeId: string): Promise<void> {
    if (!this.contacts) throw new Error('Sign in first.')
    await this.contacts.revokeCode(codeId)
  }

  async redeemContactCode(code: string): Promise<void> {
    if (!this.contacts) throw new Error('Sign in first.')
    await this.contacts.redeem(code)
  }

  renameContact(accountId: string, name: string): void {
    this.contacts?.rename(accountId, name)
  }

  /** Ends every share with them first, each side keeping what it has. */
  async removeContact(accountId: string): Promise<void> {
    if (!this.contacts || !this.sharing) throw new Error('Sign in first.')
    await this.sharing.endWith(accountId)
    await this.contacts.remove(accountId)
    this.editors.refresh()
  }

  /** For debugging and for the admin: the server knows accounts and vaults only by these. */
  ids(): { account: string; vault: string } | null {
    if (!this.unlocked) return null
    return { account: this.unlocked.accountId, vault: this.vault?.vaultId ?? '' }
  }

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
    const transfers = this.attachments?.activeTransfers()
    const moving = [transfers?.uploads ? `↑${transfers.uploads}` : '', transfers?.downloads ? `↓${transfers.downloads}` : '']
      .filter(Boolean)
      .join(' ')
    this.statusBar.setText(`Connect: ${label} · ${this.store.loadedCount()}/${this.store.trackedCount()}${moving ? ` · ${moving}` : ''}`)
  }

  private activeNoteState(): NoteSyncState {
    const file = this.activeFile()
    return file && this.store ? this.store.noteState(file) : 'untracked'
  }

  /** The cloud next to the connection status: where the note in front of you stands. */
  private renderNoteStatus(): void {
    const state = this.activeNoteState()
    const offline = this.status !== 'connected'
    const key = `${state}:${offline}`
    if (key === this.noteStatusKey) return
    this.noteStatusKey = key
    const el = this.noteStatus
    el.empty()
    el.removeClass('is-synced', 'is-unsent', 'is-waiting', 'is-held')
    if (state === 'untracked') {
      el.hide()
      return
    }
    el.show()
    el.addClass(`is-${state}`)
    setIcon(el, state === 'waiting' && offline ? 'cloud-off' : 'cloud')
    el.setAttribute('aria-label', NOTE_STATUS_TEXT[state])
    el.setAttribute('data-tooltip-position', 'top')
  }

  private explainNoteStatus(): void {
    const state = this.activeNoteState()
    if (state !== 'untracked') new Notice(NOTE_STATUS_TEXT[state], 8_000)
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
        `Attachments tracked: ${this.attachments?.isReady ? this.attachments.trackedCount() : 'not yet'}`,
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

  private openHistory(file?: TFile): void {
    const note = this.activeNote(file)
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
      log.error('resync failed', error)
      new Notice('Resync failed; see the console.')
    }
  }
}
