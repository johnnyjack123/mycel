import {
  MarkdownView,
  Menu,
  Notice,
  Platform,
  Plugin,
  TFile,
  TFolder,
  editorInfoField,
  requestUrl,
  setIcon,
  type TAbstractFile
} from 'obsidian'
import {
  roomKind,
  settingsRoom,
  userColor,
  type BackupTaskSetting,
  type CollabUser,
  type ContactNotice,
  type FolderNotice,
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
import { PasswordPromptModal, RecoveryCodeModal } from './account/RecoveryModals'
import { TotpSetupModal, askKeepTotp, askTotpCode } from './account/TotpModals'
import { Session, type OpenVault, type SecretStore, type Unlocked } from './account/Session'
import { Backups } from './backup/Backups'
import { BackupConnectModal, BackupTaskModal } from './backup/BackupModals'
import { CopyWaitsModal } from './backup/CopyWaitsModal'
import { EditorSync } from './editor/EditorSync'
import { BackupModal } from './history/BackupModal'
import { TIME_MACHINE_VIEW, TimeMachineView, type TimeMachineContext, type TimeMachineScope } from './history/TimeMachineView'
import { AccessModal } from './share/AccessModal'
import { FolderMarks } from './share/FolderMarks'
import { FolderAccessModal, MoveInModal, OutsideModal, ShareFolderModal } from './share/FolderModals'
import { Folders, type FolderNews } from './share/Folders'
import { IncomingModal } from './share/IncomingModal'
import { ShareModal } from './share/ShareModal'
import { linkedNotes, linkedOutside } from './share/LinkedNotes'
import { Contacts, type OpenCode } from './share/Contacts'
import { Sharing } from './share/Sharing'
import { SharedFiles } from './share/SharedFiles'
import { AccountSettings, DEFAULT_SHARED_SETTINGS, type Contact, type SharedSettings } from './sync/AccountSettings'
import { AttachmentIndex } from './sync/AttachmentIndex'
import { AttachmentStore, type AttachmentOptions, type AttachmentSyncState } from './sync/AttachmentStore'
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
import { Rollback, pruneRollbackCopies } from './sync/Rollback'
import { FileVersionsModal } from './history/FileVersionsModal'
import { ReviewStore, type Review } from './sync/Reviews'
import { ReviewListModal, ReviewModal } from './history/ReviewModal'
import { VaultIndex } from './sync/VaultIndex'
import { VaultSocket, type SocketStatus } from './sync/VaultSocket'
import { ObsidianConnectSettingTab, DEFAULT_SETTINGS, MOBILE_DOWNLOAD_LIMIT_MB, type ObsidianConnectSettings } from './settings'
import { log, withSummary } from './log'

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
// How often attachments are compared against what was last agreed, for changes no event reported.
const ATTACHMENT_RESCAN_MS = 60_000
// A version current for less than this keeps no content once the trash is emptied.
const ATTACHMENT_MIN_VERSION_AGE_MS = 10 * 60 * 1000
// The events of one move or delete in a shared folder are gathered this long
// before it is weighed: Obsidian reports a folder moved as an event per file.
const FOLDER_SETTLE_MS = 2_000
// A delete another device of the account made in a shared folder is left to it
// this long - its decision travels a moment behind the delete itself.
const FOLDER_DECIDE_MS = 30_000
// Shared notes' files are compared with their lists this often, besides on every change.
const SHARED_FILES_EVERY_MS = 60_000
// A link no list names yet waits this long before this device lists its own file for it.
const SHARED_FILES_CLAIM_MS = 10_000
// How often the backup servers are asked whether the vault's backups are well; the first time a minute after starting.
const BACKUP_CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const BACKUP_CHECK_DELAY_MS = 60 * 1000

type SyncState = Exclude<NoteSyncState | AttachmentSyncState, 'untracked'>

/** What the cloud says: briefly at the top of its menu, in full as its tooltip. */
const SYNC_STATUS: Record<SyncState, { label: string; note?: string; file?: string }> = {
  synced: {
    label: 'Synced',
    note: 'This note is synced: everything written here has reached the server.',
    file: 'This file is synced: the server holds it as it is here.'
  },
  unsent: {
    label: 'Not confirmed by the server yet',
    note: 'This note has changes the server has not confirmed yet.',
    file: 'This file has changes the server has not confirmed yet.'
  },
  waiting: {
    label: 'Waiting for the server',
    note: 'Not known yet whether this note is up to date: the server has not answered.',
    file: "Another device's version of this file is on its way."
  },
  held: {
    label: 'Waiting for your decision',
    note: "The server's copy of this note differs from what this device knew. It waits for your decision."
  },
  local: {
    label: 'Only on this device',
    file: 'This file is larger than the server takes; it stays on this device.'
  }
}

// Obsidian's menus have no headings; this section, under a label naming the
// plugin, keeps its items together and says where they come from.
const MENU_SECTION = 'obsidian-connect'

interface MenuAction {
  title: string
  icon: string
  run: () => unknown
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
  /** The vault's backup servers; the merge backups in the plugin folder are `backups`. */
  private readonly backupServers = new Backups({
    serverUrl: () => this.settings.serverUrl,
    token: () => this.settings.token || null,
    settings: () => this.accountSettings,
    makeGrant: async (password, label) => {
      if (!this.unlocked || !this.vault) throw new Error('Sync is not running.')
      const made = await this.session.makeBackupGrant(this.unlocked, password, this.vault, label)
      this.unlocked = made.unlocked
      return made.grant
    },
    deleteKey: async (keyId) => {
      if (!this.unlocked) throw new Error('Sign in first.')
      this.unlocked = await this.session.deleteBackupKey(this.unlocked, keyId)
    },
    lastGood: () => this.settings.backupLastGood,
    saveLastGood: async (value) => {
      this.settings.backupLastGood = value
      await this.saveSettings()
    }
  })
  private backupCheck: number | null = null
  /** The window about a held decrypted copy, while it is open. */
  private copyWaits: CopyWaitsModal | null = null

  private unlocked: Unlocked | null = null
  private vault: OpenVault | null = null
  private keys: KeyRing | null = null
  private socket: VaultSocket | null = null
  private index: VaultIndex | null = null
  private store: DocStore | null = null
  /** What the stopped store knew of the texts its editors held, for the next store of the same vault. */
  private carriedHeld: { vaultId: string; held: Map<string, Set<string>> } | null = null
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
  private folders: Folders | null = null
  private readonly folderMarks = new FolderMarks()
  private sharedFiles: SharedFiles | null = null
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
  private shareStatus!: HTMLElement
  private noteStatusKey = ''
  /** The lock in the header of each view showing a note shared to read only - where one tries to type. */
  private readonly readOnlyMarks = new Map<MarkdownView, { text: string; el: HTMLElement }>()
  private status: SocketStatus = 'disconnected'
  private unwatchIndex: (() => void) | null = null
  private unwatchSocket: (() => void) | null = null
  private unwatchSettings: (() => void) | null = null
  private indexTimer: number | null = null
  private started = false
  private starting = false
  private opening = false
  /**
   * Bumped by every stop. A start still waiting for the server or the disk
   * when it happens builds nothing after it: one that went on after the
   * plugin was unloaded left a second copy of the plugin running, unseen -
   * its own connection, no editor, a log nobody reads - which took
   * Obsidian's saves of the note open in the live copy for edits, and
   * merged them in with conflict markers.
   */
  private syncRun = 0
  private unloaded = false

  async onload(): Promise<void> {
    await this.loadSettings()
    log.verbose = this.settings.verboseLog
    await log.attach(this.app.vault.adapter, `${this.pluginDir()}/logs`)
    log.info(`loaded ${this.manifest.version}${Platform.isMobile ? ' on mobile' : ''}`)

    this.statusBar = this.addStatusBarItem()
    this.noteStatus = this.addStatusBarItem()
    this.noteStatus.addClass('connect-note-status')
    this.noteStatus.addEventListener('click', (event) => this.openConnectMenu(event))
    this.shareStatus = this.addStatusBarItem()
    this.shareStatus.addClass('connect-share-status')
    this.shareStatus.addEventListener('click', () => this.openAccess())
    this.register(() => this.unmarkReadOnlyViews())
    // Cheap - a few lookups for one note - and it catches every way a note
    // changes state without wiring each of them up.
    this.registerInterval(window.setInterval(() => this.renderNoteStatus(), NOTE_STATUS_MS))
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.renderNoteStatus()))
    // A shared note's links may have changed: its files follow.
    this.registerEvent(this.app.metadataCache.on('changed', (file) => this.sharedFiles?.noteChanged(file)))
    // Files over this device's download limit come when a note needs them.
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file?.extension === 'md') void this.attachments?.fetchFor(file)
        this.renderNoteStatus()
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
    this.register(this.backupServers.onChange(() => this.settingTab?.refresh()))
    // Obsidian adds this to every Markdown editor and keeps it there across
    // file switches and mode changes.
    this.registerEditorExtension(this.editors.extension)
    this.registerView(
      TIME_MACHINE_VIEW,
      (leaf) =>
        new TimeMachineView(leaf, {
          context: () => this.timeMachineContext(),
          includeBackups: () => this.settings.timeMachineBackups,
          setIncludeBackups: async (on) => {
            this.settings.timeMachineBackups = on
            await this.saveSettings()
          }
        })
    )

    this.addRibbonIcon('refresh-cw', 'Obsidian Connect status', () => this.showStatus())
    this.addCommand({ id: 'show-status', name: 'Show sync status', callback: () => this.showStatus() })
    this.addCommand({
      id: 'time-machine-note',
      name: 'Open the Time Machine for this note',
      callback: () => {
        const file = this.app.workspace.getActiveFile()
        if (file && file.extension !== 'md') this.openFileVersions(file)
        else this.openNoteTimeMachine()
      }
    })
    this.addCommand({ id: 'time-machine', name: 'Open the Time Machine for the vault', callback: () => void this.openTimeMachine({ kind: 'vault' }) })
    this.addCommand({ id: 'open-backups', name: 'Browse backups', callback: () => this.openBackups() })
    this.addCommand({ id: 'deleted-notes', name: 'Deleted notes and files…', callback: () => this.openTrash() })
    this.addCommand({ id: 'copy-log', name: 'Copy the log (for a bug report)', callback: () => void this.copyLog() })
    this.addCommand({ id: 'compare-versions', name: 'Compare the two versions of this note', callback: () => void this.openReview() })
    this.addCommand({ id: 'review-notes', name: 'Notes with two versions…', callback: () => void this.openReviews() })
    this.addCommand({ id: 'resync-note', name: 'Force resync of this note', callback: () => void this.resyncActive() })
    this.addCommand({
      id: 'restart-sync',
      name: 'Reconnect and rescan the vault',
      callback: () => void this.restartSync()
    })
    this.addCommand({ id: 'backup-now', name: 'Back up this vault now, on every backup server', callback: () => void this.backUpNow() })
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
    this.registerInterval(window.setInterval(() => this.sharedFiles?.scheduleAll(), SHARED_FILES_EVERY_MS))

    // The vault is not fully indexed while Obsidian is still starting, and a
    // scan that races it would treat half the notes as missing.
    this.app.workspace.onLayoutReady(() => {
      void this.startSync()
    })
  }

  async onunload(): Promise<void> {
    this.unloaded = true
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
    const header = `Obsidian Connect ${this.manifest.version}${Platform.isMobile ? ' on mobile' : ''}, log of today and yesterday (UTC)`
    await navigator.clipboard.writeText(withSummary(await log.recent(), header))
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
      settleMs: ATTACHMENT_SETTLE_MS,
      rescanMs: ATTACHMENT_RESCAN_MS,
      minVersionAgeMs: ATTACHMENT_MIN_VERSION_AGE_MS
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
    await this.session.login(username, password, (again) => askTotpCode(this.app, again))
    new Notice(`Obsidian Connect: signed in as ${this.settings.username}.`)
    await this.startSync()
  }

  /** Whether the configured server can be signed in to, and how it takes new accounts. */
  probeServer(): Promise<ServerProbe> {
    return probeServer(this.api, this.session.pinnedServerId())
  }

  /** Signed out: the server at this address was set up anew, or is another one; it is the one to use from now on. */
  useNewServer(): void {
    this.session.forgetServer()
    log.info(`the server at ${this.settings.serverUrl} is taken as a new one`)
  }

  async createAccount(username: string, password: string, repeat: string, invite: string): Promise<void> {
    if (!username) throw new Error('Choose a name.')
    const verdict = judgePassword(password, [username])
    if (!verdict.ok) throw new Error(verdict.reason)
    // A typo here, and only the recovery code still opens the account.
    if (password !== repeat) throw new Error('The passwords differ.')
    await this.stopSync()
    const { recoveryCode } = await this.session.register(username, password, invite)
    new Notice(`Obsidian Connect: account ${this.settings.username} created. Keep the password safe.`, 8_000)
    if (recoveryCode) {
      new RecoveryCodeModal(
        this.app,
        recoveryCode,
        'Your account is ready. If you ever forget your password - or the name you signed up with - this code gets you back in.'
      ).open()
    }
    await this.startSync()
  }

  /**
   * "Forgot your password?": the recovery code opens the account's keys, which
   * the name and password chosen now wrap anew. The code is spent; the new one
   * is shown once. Every other device of the account is signed out.
   */
  async recoverAccount(code: string, username: string, password: string, repeat: string): Promise<void> {
    if (!code.trim()) throw new Error('Enter your recovery code.')
    if (!username) throw new Error('Choose the name to sign in with from now on.')
    const verdict = judgePassword(password, [username])
    if (!verdict.ok) throw new Error(verdict.reason)
    if (password !== repeat) throw new Error('The passwords differ.')
    await this.stopSync()
    const { unlocked, recoveryCode, totpWasOn } = await this.session.recover(code, username, password, (problem) => askKeepTotp(this.app, problem))
    // Already, not only once sync started: the offer below may come first.
    this.unlocked = unlocked
    const withCode = unlocked.bundle.totp ? ' and a code from your authenticator app, as before' : ''
    new Notice(`Obsidian Connect: account recovered, signed in as ${this.settings.username}. Your other devices sign in again with the new password${withCode}.`, 12_000)
    // The recovery turned two-factor sign-in off - the phone was lost, or
    // its entry. Offered again once the new code is written down.
    const offerTotp = totpWasOn
      ? () => this.openTotpSetup('Two-factor sign-in was on, and the recovery turned it off. Turn it on again, with your phone - or close this to do it later in the settings.')
      : null
    new RecoveryCodeModal(this.app, recoveryCode, 'The code you used no longer works. This is your new one.', offerTotp).open()
    await this.startSync()
    void this.reconnectBackups(password)
  }

  /** What the settings show about two-factor sign-in; null while not signed in. */
  totpState(): 'on' | 'off' | 'unsupported' | null {
    const bundle = this.unlocked?.bundle
    if (!bundle) return null
    if (bundle.totp === undefined) return 'unsupported'
    return bundle.totp ? 'on' : 'off'
  }

  /**
   * What the server says about the account now - 2FA, the recovery code - and
   * an open settings tab shows it. Another device changed it, or this one was
   * away when that happened. Offline, what this device knew stays.
   */
  async refreshAccount(): Promise<void> {
    const unlocked = this.unlocked
    if (!unlocked) return
    try {
      const refreshed = await this.session.refreshBundle(unlocked)
      // Signed out or in again meanwhile: that is the account now.
      if (this.unlocked !== unlocked) return
      this.unlocked = refreshed
    } catch (error) {
      log.debug(`asking the server about the account failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.settingTab?.refresh()
  }

  openTotpSetup(intro: string | null = null): void {
    new TotpSetupModal(
      this.app,
      {
        checkPassword: async (password) => {
          if (!this.unlocked) throw new Error('Sign in first.')
          return this.session.checkPassword(this.unlocked, password)
        },
        hasRecoveryCode: () => this.recoveryState()?.state === 'made',
        makeRecoveryCode: async (password) => {
          if (!this.unlocked) throw new Error('Sign in first.')
          const made = await this.session.makeRecoveryCode(this.unlocked, password)
          this.unlocked = made.unlocked
          this.settingTab?.refresh()
          return made.code
        },
        label: () => this.settings.username,
        enable: async (password, secret, code) => {
          if (!this.unlocked) throw new Error('Sign in first.')
          this.unlocked = await this.session.enableTotp(this.unlocked, password, secret, code)
          this.settingTab?.refresh()
        }
      },
      intro
    ).open()
  }

  openTotpOff(): void {
    new PasswordPromptModal(
      this.app,
      'Turn off two-factor sign-in',
      'Signing in will ask for your name and password only. Devices signed in now stay signed in. Your password confirms it is you - no code needed, so a lost phone is no obstacle.',
      'Turn off',
      async (password) => {
        if (!this.unlocked) throw new Error('Sign in first.')
        this.unlocked = await this.session.disableTotp(this.unlocked, password)
        this.settingTab?.refresh()
        new Notice('Obsidian Connect: two-factor sign-in is off.')
      },
      true
    ).open()
  }

  /** What the settings show about the recovery code; null while not signed in. */
  recoveryState(): { state: 'made'; createdAt: number } | { state: 'none' } | { state: 'unsupported' } | null {
    const bundle = this.unlocked?.bundle
    if (!bundle) return null
    if (bundle.recovery === undefined) return { state: 'unsupported' }
    return bundle.recovery ? { state: 'made', createdAt: bundle.recovery.createdAt } : { state: 'none' }
  }

  openMakeRecoveryCode(): void {
    const replacing = this.recoveryState()?.state === 'made'
    new PasswordPromptModal(
      this.app,
      replacing ? 'Make a new recovery code' : 'Make a recovery code',
      replacing
        ? 'The code you have now stops working at once. Your password confirms it is you.'
        : 'With a recovery code, a forgotten password is not the end of your account. Your password confirms it is you.',
      'Make the code',
      async (password) => {
        if (!this.unlocked) throw new Error('Sign in first.')
        const made = await this.session.makeRecoveryCode(this.unlocked, password)
        this.unlocked = made.unlocked
        this.settingTab?.refresh()
        new RecoveryCodeModal(this.app, made.code, replacing ? 'The code before this one no longer works.' : 'Your account now has a recovery code.').open()
      }
    ).open()
  }

  openDeleteRecoveryCode(): void {
    new PasswordPromptModal(
      this.app,
      'Delete the recovery code',
      'Without a recovery code, a forgotten password means losing access to this account. Your notes stay on your devices, but they no longer sync.',
      'Delete',
      async (password) => {
        if (!this.unlocked) throw new Error('Sign in first.')
        this.unlocked = await this.session.deleteRecoveryCode(this.unlocked, password)
        this.settingTab?.refresh()
        new Notice('Obsidian Connect: the recovery code is deleted.')
      },
      true
    ).open()
  }

  async signOut(): Promise<void> {
    await this.stopSync()
    await this.session.signOut()
    this.unlocked = null
    this.renderStatus()
    new Notice('Obsidian Connect: signed out. Your notes stay in this vault.')
  }

  /**
   * The server closed the socket as signed out. Either this device changed the
   * password a moment ago and carries on with its new token, or another device
   * did - then this one stops. Files and unsent edits stay; they go out once
   * it is signed in to the account again.
   */
  private async checkSignedIn(socket: VaultSocket): Promise<void> {
    const still = await this.session.stillSignedIn()
    if (this.socket !== socket) return
    if (still !== false) {
      socket.reconnect(still === true)
      return
    }
    log.info('signed out by the server: the password was changed or the account recovered elsewhere')
    await this.stopSync()
    this.unlocked = null
    this.renderStatus()
    this.settingTab?.refresh()
    new Notice(
      'Obsidian Connect: this device was signed out - on another device the password was changed, the account recovered or two-factor sign-in turned on. Sign in again in the plugin settings.',
      0
    )
  }

  openPasswordChange(): void {
    new PasswordModal(this.app, async (current, next) => {
      if (!this.unlocked) throw new Error('Sign in first.')
      this.unlocked = await this.session.changePassword(this.unlocked, current, next)
      void this.reconnectBackups(next)
    }).open()
  }

  // --- backup servers --------------------------------------------------------

  /** The vault's backup servers, while the vault syncs. */
  backupsOf(): Backups | null {
    return this.accountSettings && this.vault ? this.backupServers : null
  }

  /** `again`: one paired before whose key ended; it gets a new one with the password. */
  openBackupConnect(again: { routeId: string; label: string } | null = null): void {
    if (!this.backupsOf()) {
      new Notice('Obsidian Connect: backups are set up while this vault syncs.')
      return
    }
    new BackupConnectModal(
      this.app,
      this.backupServers,
      (connected) => {
        this.settingTab?.refresh()
        // A backup server backs up nothing before it has a task: that comes next, unless it carried one over.
        if (connected && !this.accountSettings?.backupTask(connected.routeId)) void this.openBackupTask(connected.routeId)
        else if (connected) new Notice(`Obsidian Connect: ${connected.label} is connected and backs up as before.`, 8_000)
      },
      again
    ).open()
  }

  /** `existing`: the task to change; none sets one up. */
  async openBackupTask(routeId: string, existing: BackupTaskSetting | null = null): Promise<void> {
    // Asked first when it was not yet, so the form can name the backup server's folders for this vault.
    if (!this.backupServers.view(routeId)?.status) await this.backupServers.ask(routeId)
    new BackupTaskModal(this.app, this.backupServers, routeId, () => this.settingTab?.refresh(), existing).open()
  }

  private async backUpNow(): Promise<void> {
    const servers = this.backupsOf()?.servers() ?? []
    if (servers.length === 0) {
      new Notice('Obsidian Connect: this vault has no backup server. Connect one in the settings.')
      return
    }
    for (const server of servers) {
      try {
        await this.backupServers.runNow(server.routeId)
        new Notice(`Obsidian Connect: ${server.label} is backing up the vault.`)
      } catch (error) {
        new Notice(`Obsidian Connect: ${server.label} - ${error instanceof Error ? error.message : String(error)}`, 10_000)
      }
    }
  }

  /**
   * A password change or a recovery ended every backup key. The password is
   * at hand right now, so every backup server gets a new one at once.
   */
  private async reconnectBackups(password: string): Promise<void> {
    const servers = this.backupServers.servers()
    if (servers.length === 0) return
    // The server ended the sessions opened with the old token; new ones carry the new.
    this.backupServers.closeSessions()
    const done = await this.backupServers.reconnectAll(password)
    if (done === servers.length) new Notice(`Obsidian Connect: your backup server(s) got new keys and back up as before.`)
    else new Notice(`Obsidian Connect: ${servers.length - done} backup server(s) could not be reached and need connecting again - see the settings.`, 0)
  }

  /**
   * Asks about a decrypted copy the guard holds, over everything: one window
   * at a time, and not for a hold the person already said "not now" to
   * unless `again`. True when one is open now.
   */
  openCopyWaits(routeId: string, again = false): boolean {
    if (this.copyWaits) return true
    const held = this.backupServers.heldCopy(routeId)
    if (!held || (!again && this.backupServers.holdDismissed(held.key))) return false
    const label = this.backupServers.servers().find((server) => server.routeId === routeId)?.label ?? 'The backup server'
    this.copyWaits = new CopyWaitsModal(this.app, this.backupServers, routeId, label, held.run, held.key, () => this.openTrash(), () => {
      this.copyWaits = null
      this.settingTab?.refresh()
    })
    this.copyWaits.open()
    return true
  }

  /** A notice when backups are not well: failed, waiting, or overdue. Asked now and then while the vault syncs. */
  private scheduleBackupCheck(): void {
    if (this.backupCheck !== null) return
    const check = async (): Promise<void> => {
      const backups = this.backupsOf()
      if (!backups || backups.servers().length === 0) return
      const problems = await backups.problems()
      if (problems.length === 0) return
      const held = backups.servers().filter((server) => backups.heldCopy(server.routeId))
      const notice = new Notice(`Obsidian Connect - backups:\n${problems.join('\n')}${held.length > 0 ? '\nClick here to decide what the decrypted copy does.' : ''}`, 0)
      if (held.length > 0) {
        notice.noticeEl.addEventListener('click', () => {
          for (const server of held) if (this.openCopyWaits(server.routeId, true)) break
        })
      }
    }
    window.setTimeout(() => void check(), BACKUP_CHECK_DELAY_MS)
    this.backupCheck = window.setInterval(() => void check(), BACKUP_CHECK_EVERY_MS)
    this.registerInterval(this.backupCheck)
  }

  // --- lifecycle -----------------------------------------------------------

  private async startSync(): Promise<void> {
    // Obsidian still calls back an unloaded plugin, `onLayoutReady` included.
    if (this.unloaded || !this.settings.syncEnabled || this.store || this.opening) return
    const run = this.syncRun
    this.opening = true
    try {
      await this.openSync(run)
    } finally {
      // A stop in between let a newer start begin; the flag is its flag then.
      if (run === this.syncRun) this.opening = false
    }
  }

  /** Checked after every wait: whatever it built is torn down by the stop that bumped `syncRun`. */
  private async openSync(run: number): Promise<void> {
    const stopped = (): boolean => run !== this.syncRun
    const unlocked = await this.session.unlock()
    if (stopped()) return
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
      if (stopped()) return
      log.error('opening the vault failed', error)
      new Notice(`Obsidian Connect could not open the vault "${this.vaultName()}". Is the server reachable?`, 10_000)
      return
    }
    if (stopped()) return
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
      revoked: (room) =>
        void (roomKind(room) === 'fld' ? this.folders?.onRevoked(room) : this.sharing?.onRevoked(room))?.then(() => this.editors.refresh()),
      denied: (room, reason) => log.error(`${room} was refused: ${reason}`),
      diverged: (room) => this.recovery?.diverged(room),
      signedOut: () => void this.checkSignedIn(socket)
    })
    this.socket = socket
    this.history = indexedDbHistory(vault.vaultId)

    // The account's settings first: the scan depends on what is excluded.
    const accountSettings = new AccountSettings()
    this.accountSettings = accountSettings
    const settingsStore = openIndexedDb(`obsidian-connect/${vault.vaultId}/set`, accountSettings.doc)
    this.settingsStore = settingsStore
    await settingsStore.whenSynced
    if (stopped()) return
    const settingsCursor = await LocalCursor.load(settingsStore)
    if (stopped()) return
    this.settingsCursor = settingsCursor
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
        docCrypto: (docId, entry) => keys.noteCrypto(docId, { owned: !entry?.owner, folder: Boolean(entry?.folder) }),
        roomFolder: (docId, entry) => this.folders?.roomFolder(docId, entry) ?? null
      },
      openIndexedDb,
      this.history
    )
    this.store = store
    store.watchEditors((path) => this.editors.shows(path))
    if (this.carriedHeld?.vaultId === vault.vaultId) store.inheritHeld(this.carriedHeld.held)
    this.carriedHeld = null
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
    const sharing = new Sharing(
      this.api,
      keys,
      store,
      {
        folder: () => this.shared().sharedFolder,
        syncTimeoutMs: this.settings.syncTimeoutMs,
        autoAccept: () => (this.unlocked?.bundle.vaults.length ?? 0) <= 1,
        folderEpoch: (folderId) => folders.currentEpoch(folderId),
        folderOver: (folderId) => folders.over(folderId)
      },
      this.contacts
    )
    this.sharing = sharing
    // Before the vault is scanned: a note new in a shared folder takes its id from the folder.
    const folders: Folders = new Folders(
      this.app,
      this.api,
      keys,
      store,
      this.index,
      socket,
      openIndexedDb,
      sharing,
      {
        shareFolder: () => this.shared().sharedFolder,
        syncTimeoutMs: this.settings.syncTimeoutMs,
        autoAccept: () => (this.unlocked?.bundle.vaults.length ?? 0) <= 1,
        settleMs: FOLDER_SETTLE_MS,
        decideMs: FOLDER_DECIDE_MS
      },
      {
        moveIn: (question) => {
          const modal = new MoveInModal(this.app, question)
          modal.open()
          return modal.answered
        },
        outside: (question) => {
          const modal = new OutsideModal(this.app, question)
          modal.open()
          return modal.answered
        }
      },
      (news) => this.showFolderNews(news),
      this.attachments
    )
    this.folders = folders
    const index = this.index
    const unwatchFolders = index.onFoldersChange(() => this.renderFolderMarks())
    this.sharedFiles = new SharedFiles(this.app, store, this.attachments, this.api, keys, {
      folder: () => this.shared().sharedFolder,
      syncTimeoutMs: this.settings.syncTimeoutMs,
      claimDelayMs: SHARED_FILES_CLAIM_MS,
      folders
    })
    this.compactor = new Compactor(this.api, keys, () => this.shared().historyRetentionDays)
    this.trash = new Trash(this.api, store, () => this.shared().historyRetentionDays, this.attachments, folders)

    // Editors bind as soon as the index is there, not after the whole vault
    // has been scanned: an open note is settled on its own, first.
    store.onReady(() => this.editors.refresh())
    store.onLeave((docId) => void this.sharing?.leave(docId))
    store.onReview((review) => {
      void reviews.add(review).catch((error: unknown) => log.error(`keeping the review of ${review.path} failed`, error))
    })
    this.unwatchSettings = accountSettings.onChange((_settings, remote) => {
      this.store?.setOptions(this.storeOptions())
      this.attachments?.setOptions(this.attachmentOptions())
      // Changed on another device: an open settings tab shows it at once.
      if (remote) this.settingTab?.refresh()
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
        // What changed on the account while this device was away was not told to it.
        void this.refreshAccount()
      }
    })
    const unwatchNotes = this.index.onChange(() => this.scheduleIndexApply())
    const unwatchFiles = attachmentIndex.onChange(() => this.scheduleIndexApply())
    const unwatchTransfers = this.attachments.onTransfer(() => this.renderStatus())
    this.unwatchIndex = () => {
      unwatchNotes()
      unwatchFiles()
      unwatchTransfers()
      unwatchFolders()
    }

    socket.connect()
    await Promise.race([socket.whenSynced(settingsRoom(vault.vaultId)), delay(this.settings.syncTimeoutMs)])
    if (stopped()) return
    if (this.movedSettings && accountSettings.empty) accountSettings.set(this.movedSettings)
    this.movedSettings = null
    store.setOptions(this.storeOptions())
    void this.backups.prune(this.shared().backupRetentionDays)
    void pruneRollbackCopies(this.app.vault.adapter, root, this.shared().backupRetentionDays)

    await this.runStart()
  }

  private async runStart(): Promise<void> {
    const store = this.store
    if (!store || this.started || this.starting) return
    this.starting = true
    try {
      const started = await store.start()
      // Stopped meanwhile: that stop reset these, for the next start.
      if (this.store !== store) return
      this.started = started
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
        this.folders?.start()
        this.renderFolderMarks()
        // In the background: a first scan may have gigabytes to upload.
        void this.startAttachments()
        // Contacts first: a share may come from someone who became a contact while this device was away.
        await this.processContacts()
        void this.folders?.checkIncoming().then(
          (waiting) => {
            if (waiting > 0) new Notice(`${waiting} folder(s) were shared with you. Run "Notes shared with me".`, 10_000)
          },
          (error: unknown) => log.warn('checking for shared folders failed', error)
        )
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
        this.scheduleBackupCheck()
        this.wakeTimeMachines()
      }
    } catch (error) {
      log.error('starting sync failed', error)
      new Notice('Obsidian Connect could not start; see the console.')
    } finally {
      if (this.store === store) this.starting = false
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
      this.sharedFiles?.start()
      this.wakeTimeMachines()
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

  /** Everything deleted - or only what was deleted in `folder`. */
  openTrash(folder: string | null = null): void {
    if (!this.trash || !this.store?.ready) {
      new Notice(this.settings.username ? 'Obsidian Connect is not connected yet.' : 'Sign in to Obsidian Connect first.')
      return
    }
    new TrashModal(this.app, this.trash, this.shared().historyRetentionDays, folder).open()
  }

  /**
   * The Time Machine for the vault, a folder or a note: a tab of its own, the
   * one already showing it if there is one.
   */
  async openTimeMachine(scope: TimeMachineScope): Promise<void> {
    if (!this.timeMachineContext()) {
      new Notice(this.settings.username ? 'Obsidian Connect is not connected yet.' : 'Sign in to Obsidian Connect first.')
      return
    }
    const { workspace } = this.app
    const open = workspace.getLeavesOfType(TIME_MACHINE_VIEW).find((leaf) => leaf.view instanceof TimeMachineView && leaf.view.shows(scope))
    const leaf = open ?? workspace.getLeaf('tab')
    if (!open) await leaf.setViewState({ type: TIME_MACHINE_VIEW, active: true, state: scope })
    await workspace.revealLeaf(leaf)
  }

  /** Time Machines Obsidian restored before the vault synced, open while sync restarted, or opened before the files were ready. */
  private wakeTimeMachines(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(TIME_MACHINE_VIEW)) {
      if (leaf.view instanceof TimeMachineView) leaf.view.connected()
    }
  }

  private openNoteTimeMachine(file?: TFile): void {
    const note = this.activeNote(file)
    if (note) void this.openTimeMachine({ kind: 'note', path: note.file.path })
  }

  /** What the Time Machine reads the past with; null until the vault syncs. */
  private timeMachineContext(): TimeMachineContext | null {
    const { store, keys, accountSettings } = this
    if (!store?.ready || !keys || !accountSettings) return null
    return {
      api: this.api,
      vaultId: keys.vaultId,
      indexCrypto: keys.indexCrypto(),
      // Which epochs a shared folder's key opens is asked once: the history reads every one.
      noteCrypto: (docId) => keys.noteCrypto(docId, { owned: !store.entry(docId)?.owner, folder: true }),
      store,
      attachments: this.attachments?.isReady ? this.attachments : null,
      settings: accountSettings,
      backups: this.backupsOf(),
      rollback: () => this.makeRollback(store, keys, accountSettings),
      folderOwner: (path) => {
        const owner = this.folders?.placeOf(path)?.folder.owner
        return owner ? (this.sharing?.nameOf(owner) ?? owner) : null
      }
    }
  }

  private makeRollback(store: DocStore, keys: KeyRing, settings: AccountSettings): Rollback {
    return new Rollback({
      api: this.api,
      vaultId: keys.vaultId,
      indexCrypto: keys.indexCrypto(),
      docCrypto: (docId) => keys.noteCrypto(docId, { owned: true, folder: true }),
      store,
      attachments: this.attachments?.isReady ? this.attachments : null,
      settings,
      backups: this.backupsOf(),
      adapter: this.app.vault.adapter,
      root: this.pluginDir(),
      isExcluded: (path) => store.isExcluded(path)
    })
  }

  /** The version history of a file that is not a note - the active one unless given. */
  private openFileVersions(file?: TFile): void {
    const active = this.app.workspace.getActiveFile()
    const target = file ?? (active instanceof TFile ? active : null)
    if (!this.attachments?.isReady) {
      new Notice(this.settings.username ? 'Obsidian Connect is not connected yet.' : 'Sign in to Obsidian Connect first.')
      return
    }
    if (!target || target.extension === 'md') {
      new Notice('Open an image, a PDF or another file that is not a note first. A note has its Time Machine.')
      return
    }
    if (!this.attachments.knows(target)) {
      new Notice(`${target.name} is not synced yet.`)
      return
    }
    new FileVersionsModal(this.app, this.attachments, target, this.shared().historyRetentionDays).open()
  }

  /** What this account stores in attachments, as the server reports it; null while unknown. */
  async attachmentUsage(): Promise<{ bytes: number; quotaBytes: number | null } | null> {
    if (!this.unlocked || !this.attachments?.isReady) return null
    try {
      return await this.api.blobUsage(this.unlocked.accountId)
    } catch {
      return null
    }
  }

  private async stopSync(): Promise<void> {
    // A start under way stops at its next step; what it built so far goes below.
    this.syncRun += 1
    this.opening = false
    this.copyWaits?.close()
    this.backupServers.closeSessions()
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
    await this.folders?.stop()
    this.folders = null
    this.folderMarks.destroy()
    this.sharedFiles?.stop()
    this.sharedFiles = null
    // Before the notes: stopping those closes the state both write to.
    const attachments = this.attachments
    this.attachments = null
    await attachments?.stop()
    this.attachmentIndex?.destroy()
    this.attachmentIndex = null
    const store = this.store
    this.store = null
    if (store && this.vault) this.carriedHeld = { vaultId: this.vault.vaultId, held: store.heldTexts() }
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
          this.folders?.onFolderDeleted(file.path)
        }
      })
    )
    this.registerEvent(
      this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        if (file instanceof TFolder) {
          // A shared folder's place follows; its notes' own events come apart.
          this.folders?.onFolderRenamed(oldPath, file.path)
          this.renderFolderMarks()
          return
        }
        if (!(file instanceof TFile)) return
        void this.store?.onRename(file, oldPath)
        void this.attachments?.onRename(file, oldPath)
      })
    )
  }

  /** The explorer's mark on every shared folder: this vault's own, and the ones shared into it. */
  private renderFolderMarks(): void {
    const index = this.index
    if (!index) {
      this.folderMarks.destroy()
      return
    }
    const live = index.liveFolders()
    this.folderMarks.render(
      live.filter(({ folder }) => !folder.owner).map(({ folder }) => folder.path),
      live.filter(({ folder }) => folder.owner).map(({ folder }) => folder.path)
    )
  }

  /** What shared folders have to say, as a notice; a delete for everyone offers to undo it. */
  private showFolderNews(news: FolderNews): void {
    const name = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '')
    const people = (names: string[]): string =>
      names.length <= 1 ? (names[0] ?? 'nobody else') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    switch (news.kind) {
      case 'deleted': {
        const what = news.names.length === 1 ? `"${news.names[0]}" was` : `${news.names.length} notes were`
        const fragment = document.createDocumentFragment()
        fragment.createSpan({ text: `${what} deleted for everyone in "${name(news.folderPath)}" (${people(news.people)}). ` })
        let notice: Notice | null = null
        fragment.createEl('button', { text: 'Undo' }).addEventListener('click', () => {
          notice?.hide()
          void news.undo().then(
            () => new Notice(`${news.names.length === 1 ? `"${news.names[0]}" is` : 'They are'} back, for everyone.`),
            (error: unknown) => new Notice(`Bringing it back failed: ${error instanceof Error ? error.message : String(error)}`)
          )
        })
        notice = new Notice(fragment, 15_000)
        return
      }
      case 'moved-out':
        new Notice(`"${name(news.path)}" is no longer in its shared folder. ${people(news.people)} keep${news.people.length === 1 ? 's' : ''} their copy.`, 10_000)
        return
      case 'stays-yours':
        new Notice(`You can only read "${name(news.folderPath)}": "${name(news.path)}" stays yours and does not go into the folder.`, 10_000)
        return
      case 'not-yours':
        new Notice(`"${name(news.path)}" belongs to ${news.owner}; it stays out of your shared folder.`, 10_000)
        return
      case 'accepted':
        new Notice(`${news.owner} shared the folder "${name(news.path)}" with you. It is in ${news.path}, and everything added to it comes along.`, 10_000)
        return
      case 'ended':
        new Notice(
          `The share of the folder "${name(news.path)}" with ${news.owner} ended.${news.kept > 0 ? ' Your copy is kept as notes of your own, with their history.' : ''}`,
          12_000
        )
        return
      case 'left':
        new Notice(`${news.who} left the shared folder "${name(news.path)}". They no longer get what is written in it; what they had stays with them.`, 12_000)
        return
      case 'linked':
        new Notice(
          `The ${news.shared === 1 ? 'note' : `${news.shared} notes`} "${name(news.path)}" links to ${news.shared === 1 ? 'is' : 'are'} shared with ${people(news.people)} as well.${news.failed > 0 ? ` ${news.failed} could not be shared; see the log.` : ''}`,
          10_000
        )
        return
    }
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
      // A share may have started, and the files of shared notes may have moved.
      this.sharedFiles?.scheduleAll()
      // A file of a shared folder may have a new version here.
      this.folders?.scheduleAll()
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
    const files = this.attachments?.isReady && this.sharedFiles ? this.sharedFiles.summary(note.file) : null
    const sharing = this.sharing
    const linked = linkedNotes(this.app.metadataCache, this.store, note.file, (account) => sharing.nameOf(account))
    new ShareModal(this.app, sharing, note.file, note.docId, this.contactList(), files, linked).open()
  }

  private openAccess(file?: TFile): void {
    const note = this.activeNote(file)
    if (!note || !this.sharing) return
    const decidesFiles = Boolean(this.attachments?.isReady) && !this.store?.entry(note.docId)?.owner
    new AccessModal(this.app, this.sharing, note.file, note.docId, decidesFiles).open()
  }

  /**
   * The note's own menus - its "..." menu, the file explorer's, the editor's
   * right click - carry what the command palette does for the active note,
   * together and under the plugin's name.
   */
  private noteMenu(menu: Menu, file: TAbstractFile): void {
    const actions = this.connectActions(file)
    if (actions.length === 0) return
    menu.addItem((item) => item.setTitle(this.manifest.name).setIsLabel(true).setSection(MENU_SECTION))
    for (const action of actions) {
      menu.addItem((item) =>
        item
          .setTitle(action.title)
          .setIcon(action.icon)
          .setSection(MENU_SECTION)
          .onClick(() => void action.run())
      )
    }
  }

  /** The cloud's menu: where the file in front of you stands, and what can be done with it. */
  private openConnectMenu(event: MouseEvent): void {
    const active = this.activeState()
    const menu = new Menu()
    if (active) menu.addItem((item) => item.setTitle(SYNC_STATUS[active.state].label).setIsLabel(true))
    for (const action of active ? this.connectActions(active.file) : []) {
      menu.addItem((item) =>
        item
          .setTitle(action.title)
          .setIcon(action.icon)
          .onClick(() => void action.run())
      )
    }
    menu.addSeparator()
    menu.addItem((item) => item.setTitle('Deleted notes and files…').setIcon('trash-2').onClick(() => this.openTrash()))
    menu.addItem((item) => item.setTitle('Notes shared with me').setIcon('inbox').onClick(() => this.openIncoming()))
    menu.showAtMouseEvent(event)
  }

  /** What this plugin offers for a note, a file or a folder. */
  private connectActions(file: TAbstractFile): MenuAction[] {
    const store = this.store
    // Where a deleted note or picture was is where one looks for it.
    if (file instanceof TFolder) {
      if (!store?.ready) return []
      const folder = file.isRoot() ? null : file.path
      return [
        ...(folder ? this.folderActions(folder) : []),
        { title: 'Deleted notes and files…', icon: 'trash-2', run: () => this.openTrash(folder) },
        { title: 'Time Machine', icon: 'history', run: () => this.openTimeMachine(folder ? { kind: 'folder', path: folder } : { kind: 'vault' }) }
      ]
    }
    if (!(file instanceof TFile)) return []
    if (file.extension !== 'md') {
      return this.attachments?.knows(file) ? [{ title: 'Version history', icon: 'history', run: () => this.openFileVersions(file) }] : []
    }
    if (!store?.ready) return []
    const docId = store.docIdForPath(file.path)
    if (!docId) return []
    const entry = store.entry(docId)
    const actions: MenuAction[] = []
    const inFolder = this.folders?.folderOf(docId) ?? null
    if (inFolder) {
      const path = inFolder.folder.path
      actions.push({ title: 'Who has the folder', icon: 'users', run: () => this.openFolderAccess(path) })
    }
    if (entry?.owner) {
      // A note of someone else's folder is the folder's: its copy is made for the whole folder.
      if (!inFolder) {
        actions.push({ title: 'Who has access', icon: 'users', run: () => this.openAccess(file) })
        actions.push({ title: 'Make my own copy', icon: 'copy', run: () => this.detachActive(file) })
      }
    } else {
      actions.push({ title: 'Share…', icon: 'share-2', run: () => this.openShare(file) })
      if (entry?.shared && !inFolder) actions.push({ title: 'Who has access', icon: 'users', run: () => this.openAccess(file) })
    }
    actions.push({ title: 'Time Machine', icon: 'history', run: () => this.openNoteTimeMachine(file) })
    if (this.attachments?.isReady && this.settings.attachmentDownloadLimitMb >= 0) {
      actions.push({
        title: 'Download attachments',
        icon: 'download',
        run: async () => {
          const fetched = (await this.attachments?.fetchFor(file)) ?? 0
          new Notice(fetched > 0 ? `${fetched} attachment(s) of ${file.basename} downloaded.` : `${file.basename} has everything it embeds or links.`)
        }
      })
    }
    if (this.reviews?.pendingFor(docId)) {
      actions.push({ title: 'Compare versions', icon: 'git-compare', run: () => this.openReview(file) })
    }
    return actions
  }

  /** Sharing a folder, from its menu: its own, shared or not yet, or one shared into the vault. */
  private folderActions(path: string): MenuAction[] {
    const folders = this.folders
    if (!folders) return []
    const shared = folders.folderAt(path)
    if (shared?.folder.owner) return [{ title: 'Who has the folder', icon: 'users', run: () => this.openFolderAccess(path) }]
    // Inside someone else's folder, or inside one of this vault's shared ones: shared as part of that.
    const around = folders.placeOf(`${path}/x`)
    if (!shared && around) return []
    const actions: MenuAction[] = [{ title: shared ? 'Share the folder again…' : 'Share the folder…', icon: 'share-2', run: () => this.openShareFolder(path) }]
    if (shared) actions.push({ title: 'Who has the folder', icon: 'users', run: () => this.openFolderAccess(path) })
    return actions
  }

  private openShareFolder(path: string): void {
    if (!this.folders || !this.sharing || !this.store?.ready) {
      new Notice(this.settings.username ? 'Obsidian Connect is not connected yet.' : 'Sign in to Obsidian Connect first.')
      return
    }
    const sharing = this.sharing
    const inside = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${path}/`))
    const linked = linkedOutside(this.app.metadataCache, this.store, inside, path, (account) => sharing.nameOf(account))
    new ShareFolderModal(this.app, this.folders, sharing, path, this.contactList(), linked).open()
  }

  private openFolderAccess(path: string): void {
    const shared = this.folders?.folderAt(path)
    if (!this.folders || !this.sharing || !shared) {
      new Notice('This folder is not shared.')
      return
    }
    new FolderAccessModal(this.app, this.folders, this.sharing, shared.folderId, path).open()
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
    new IncomingModal(this.app, this.sharing, this.vault?.name ?? this.vaultName(), this.folders).open()
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
      this.settingTab?.refresh()
      return
    }
    if (kind === 'account-changed') {
      void this.refreshAccount()
      return
    }
    if (kind === 'folder-added' || kind === 'folder-changed' || kind === 'folder-removed') {
      void this.folders?.onNotify(kind, payload as FolderNotice).then(() => {
        this.editors.refresh()
        this.renderFolderMarks()
      })
      return
    }
    void this.sharing?.onNotify(kind, payload as ShareNotice).then(() => this.editors.refresh())
  }

  private async processContacts(): Promise<void> {
    try {
      const added = (await this.contacts?.processInbox()) ?? 0
      if (added > 0) {
        new Notice(`Obsidian Connect: ${added} contact(s) added.`)
        this.settingTab?.refresh()
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
    await this.folders?.endWith(accountId)
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

  /** The note or file in front of you and where it stands; null when it is not synced at all. */
  private activeState(): { file: TFile; state: SyncState; text: string } | null {
    const file = this.app.workspace.getActiveFile()
    if (!(file instanceof TFile)) return null
    const note = file.extension === 'md'
    const state = note ? (this.store?.noteState(file) ?? 'untracked') : (this.attachments?.fileState(file) ?? 'untracked')
    if (state === 'untracked') return null
    const status = SYNC_STATUS[state]
    return { file, state, text: (note ? status.note : status.file) ?? status.label }
  }

  /** Whether a note is shared, and whether only to read; null for one nobody else is in. */
  private shareState(file: TFile): { readOnly: boolean; text: string } | null {
    const store = this.store
    const docId = file.extension === 'md' && store?.ready ? store.docIdForPath(file.path) : undefined
    const entry = docId ? store?.entry(docId) : undefined
    if (!docId || !entry || entry.deletedAt) return null
    if (entry.owner) {
      const name = this.sharing?.nameOf(entry.owner) ?? 'Someone'
      return store?.isReadOnly(docId)
        ? {
            readOnly: true,
            text: `${name} shared this note with you to read only, so you cannot change it. "Make my own copy" ends the share for you and gives you a copy you can edit.`
          }
        : { readOnly: false, text: `${name} shared this note with you; you can edit it.` }
    }
    return entry.shared ? { readOnly: false, text: 'You share this note with others.' } : null
  }

  /**
   * The cloud next to the connection status: where the note or file in front
   * of you stands. Beside it, whether the note is shared and how.
   */
  private renderNoteStatus(): void {
    this.markReadOnlyViews()
    const active = this.activeState()
    const share = active ? this.shareState(active.file) : null
    const offline = this.status !== 'connected'
    const key = `${active?.state}:${active?.text}:${offline}:${share?.text}`
    if (key === this.noteStatusKey) return
    this.noteStatusKey = key

    const cloud = this.noteStatus
    cloud.empty()
    cloud.removeClass('is-synced', 'is-unsent', 'is-waiting', 'is-held', 'is-local')
    if (active) {
      cloud.show()
      cloud.addClass(`is-${active.state}`)
      setIcon(cloud, (active.state === 'waiting' && offline) || active.state === 'local' ? 'cloud-off' : 'cloud')
      cloud.setAttribute('aria-label', active.text)
      cloud.setAttribute('data-tooltip-position', 'top')
    } else {
      cloud.hide()
    }

    const mark = this.shareStatus
    mark.empty()
    mark.toggleClass('is-read-only', Boolean(share?.readOnly))
    if (share) {
      mark.show()
      setIcon(mark, share.readOnly ? 'lock' : 'users')
      mark.setAttribute('aria-label', share.text)
      mark.setAttribute('data-tooltip-position', 'top')
    } else {
      mark.hide()
    }
  }

  /**
   * A lock in the header of every view showing a note shared to read only.
   * The status bar says it too, but a phone has none, and the header is
   * where one looks when typing does nothing.
   */
  private markReadOnlyViews(): void {
    const shown = new Set<MarkdownView>()
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view
      if (!(view instanceof MarkdownView)) return
      shown.add(view)
      const share = view.file ? this.shareState(view.file) : null
      const text = share?.readOnly ? share.text : null
      const mark = this.readOnlyMarks.get(view)
      if (mark?.text === text) return
      mark?.el.remove()
      this.readOnlyMarks.delete(view)
      if (text) this.readOnlyMarks.set(view, { text, el: view.addAction('lock', text, () => new Notice(text, 10_000)) })
    })
    for (const [view, mark] of this.readOnlyMarks) {
      if (shown.has(view)) continue
      mark.el.remove()
      this.readOnlyMarks.delete(view)
    }
  }

  private unmarkReadOnlyViews(): void {
    for (const mark of this.readOnlyMarks.values()) mark.el.remove()
    this.readOnlyMarks.clear()
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
