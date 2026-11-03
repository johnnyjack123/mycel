// What the end-to-end self-tests share: a DOM for real CodeMirror editors,
// the check helpers, and `Device` - one device of one person, with the real
// accounts, keys, DocStore, socket and editor binding, against a fake vault
// that saves and reloads the way Obsidian does.
import { JSDOM } from 'jsdom'
import type { KeepProblem } from '../src/account/Session.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
const globals = globalThis as Record<string, unknown>
globals.window = dom.window
globals.document = dom.window.document
for (const key of [
  'navigator', 'Node', 'Element', 'HTMLElement', 'DocumentFragment', 'Range', 'Text',
  'DOMParser', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'CustomEvent', 'Event', 'KeyboardEvent', 'InputEvent',
  'ClipboardEvent', 'DragEvent', 'MouseEvent', 'CompositionEvent', 'ResizeObserver',
  'IntersectionObserver'
]) {
  const value = (dom.window as unknown as Record<string, unknown>)[key]
  if (globals[key] === undefined && value !== undefined) globals[key] = value
}
// jsdom has no layout. CodeMirror measures text in an animation frame and
// throws there without this - harmless, but it buries the test output.
const rangeProto = dom.window.Range.prototype as unknown as { getClientRects?: () => unknown }
rangeProto.getClientRects ??= () => []

// Imported after the DOM globals exist; CodeMirror reads them at module scope.
const { settingsRoom, userColor } = await import('@obsidian-connect/shared')
const { AccountSettings } = await import('../src/sync/AccountSettings.js')
const { LocalCursor } = await import('../src/sync/DocHandle.js')
const { Recovery } = await import('../src/sync/Recovery.js')
const { ConnectApi, fetchHttp } = await import('../src/account/api.js')
const { Session } = await import('../src/account/Session.js')
const { probeServer } = await import('../src/account/probe.js')
const { KeyRing } = await import('../src/account/KeyRing.js')
const { hashWasmArgon2id } = await import('../src/account/argon2.js')
const { DocStore } = await import('../src/sync/DocStore.js')
const { AttachmentIndex } = await import('../src/sync/AttachmentIndex.js')
const { AttachmentStore } = await import('../src/sync/AttachmentStore.js')
const { Blobs } = await import('../src/sync/Blobs.js')
const { StateStore } = await import('../src/sync/StateStore.js')
const { BackupStore } = await import('../src/sync/BackupStore.js')
const { VaultIndex } = await import('../src/sync/VaultIndex.js')
const { VaultSocket } = await import('../src/sync/VaultSocket.js')
const { Compactor } = await import('../src/sync/Compactor.js')
const { Trash } = await import('../src/sync/Trash.js')
const { EditorSync } = await import('../src/editor/EditorSync.js')
const { Sharing } = await import('../src/share/Sharing.js')
const { Folders } = await import('../src/share/Folders.js')
const { SharedFiles } = await import('../src/share/SharedFiles.js')
const { Contacts } = await import('../src/share/Contacts.js')
const { openInviteSession, openPairingSession } = await import('../src/backup/BackupLink.js')
const { Backups } = await import('../src/backup/Backups.js')
const { Rollback } = await import('../src/sync/Rollback.js')
const { LockSeal, lockNonce, takeVaultLock } = await import('../src/sync/VaultLock.js')
const { FakeVault, FakeFileManager, FakeMarkdownView, FakeMetadataCache, MemoryLocalStores, noteOf } = await import(
  './stubs/fake-vault.js'
)
const { TFolder: TFolderT } = await import('obsidian')

type DocStoreT = InstanceType<typeof DocStore>
type Unlocked = Awaited<ReturnType<InstanceType<typeof Session>['login']>>
type ViewT = InstanceType<typeof FakeMarkdownView>

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const failures: string[] = []

export function check(ok: boolean, label: string, detail?: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`)
  if (!ok) {
    failures.push(label)
    if (detail !== undefined) console.log('      got:', JSON.stringify(detail))
  }
}

export async function eventually(predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await delay(40)
  }
  return predicate()
}

export function finish(): never {
  console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
  process.exit(failures.length === 0 ? 0 : 1)
}

let serverUrl = 'ws://localhost:1234'

/** Read whenever a device connects, so a test can move to a restarted server. */
export function useServer(url: string): void {
  serverUrl = url
}

export const PASSWORD = 'correct horse battery staple'
export const VAULT = 'Test vault'

export class Device {
  readonly vault: InstanceType<typeof FakeVault>
  /** What the user renames with in Obsidian; it rewrites the links to the file. */
  readonly fileManager: InstanceType<typeof FakeFileManager>
  readonly metadataCache: InstanceType<typeof FakeMetadataCache>
  readonly locals = new MemoryLocalStores()
  private readonly secretMap = new Map<string, string>()
  private readonly secrets = {
    load: (key: string): string | null => this.secretMap.get(key) ?? null,
    save: (key: string, value: string | null): void => {
      if (value === null) this.secretMap.delete(key)
      else this.secretMap.set(key, value)
    }
  }
  private token: string | null = null
  readonly api = new ConnectApi(() => serverUrl, fetchHttp, () => this.token)
  private readonly session = new Session(
    this.api,
    this.secrets,
    hashWasmArgon2id,
    async (token) => {
      this.token = token
    },
    () => serverUrl
  )
  /** The server knows this account by this id alone; sharing addresses it. */
  accountId = ''
  /** What this device signs in with; a password change elsewhere does not tell it. */
  password = PASSWORD
  private unlocked: Unlocked | null = null
  /** The recovery code this device was last shown. */
  recoveryCode: string | null = null
  /** Whether the last recovery on this device turned two-factor sign-in off (false when it kept it). */
  totpWasOn = false
  /** The person's authenticator app, as far as signing in on this device goes; null: no code to give. */
  authenticator: { code(): Promise<string> } | null = null
  /** Every time signing in asked for a code: whether it was asked again after a wrong one. */
  readonly askedForCode: boolean[] = []
  /**
   * What the person answers when a recovery asks whether to keep two-factor
   * sign-in: the app's code if they have one, otherwise turn it off.
   */
  keepTotp: (problem: KeepProblem) => Promise<{ code: string } | 'off' | null> = async () =>
    this.authenticator ? { code: await this.authenticator.code() } : 'off'
  /** Every time a recovery asked that: why it asked (null: the first time). */
  readonly askedToKeep: KeepProblem[] = []
  /** How often the server signed this device out while it ran. */
  signedOut = 0
  // Outlives restarts, like the plugin's own: Obsidian keeps the extension in
  // its editors while sync is stopped and started again.
  readonly editors = new EditorSync(() => this.store, noteOf)
  store: DocStoreT | null = null
  attachments: InstanceType<typeof AttachmentStore> | null = null
  sharedFiles: InstanceType<typeof SharedFiles> | null = null
  attachmentIndex: InstanceType<typeof AttachmentIndex> | null = null
  /** This device's download limit for attachments, in bytes; null fetches everything. */
  downloadLimit: number | null = null
  /** Files shown in a view that is not a Markdown editor, such as a canvas. */
  readonly openFiles = new Set<string>()
  private maxFileBytes = 0
  index: InstanceType<typeof VaultIndex> | null = null
  keys: InstanceType<typeof KeyRing> | null = null
  sharing: InstanceType<typeof Sharing> | null = null
  folders: InstanceType<typeof Folders> | null = null
  /** What the person answers when a note is moved into a shared folder; null leaves the window open. */
  moveInAnswer: 'share' | 'back' | null = 'share'
  /** Whether that answer shares the notes it links to as well. */
  moveInWithLinked = false
  /** Every time a window asked about moving a note into a shared folder, and where it was. */
  readonly askedMoveIn: string[] = []
  /** The same windows with what they said: who would see it, the files and notes going along, when it opened. */
  readonly moveInQuestions: Array<{ path: string; files: string[]; linked: string[]; strangers: number; people: string[]; at: number }> = []
  /** What the person answers when a note of theirs lies outside its shared folder after a crash. */
  outsideAnswer: 'end' | 'back' | null = null
  /** What this device said about shared folders, oldest first. */
  readonly folderNews: Array<{ kind: string; batch?: unknown; [key: string]: unknown }> = []
  /** Members the server listed who are not contacts, as the window over everything would name them. */
  readonly unknownMembers: Array<{ accounts: string[]; place: { kind: string } }> = []
  compactor: InstanceType<typeof Compactor> | null = null
  trash: InstanceType<typeof Trash> | null = null
  settings: InstanceType<typeof AccountSettings> | null = null
  contacts: InstanceType<typeof Contacts> | null = null
  recovery: InstanceType<typeof Recovery> | null = null
  retentionDays = 30
  /** How many notes the device holds open at most (`maxLoadedDocuments`). */
  maxLoaded = 500
  /** How far a rollback trusts the server's clock; an hour unless a test says otherwise. */
  rollbackClockMarginMs: number | undefined = undefined
  /** What the user answers when the server turns out to have other data. */
  recoveryAnswer: 'device' | 'server' | null = null
  /** How many times this device had to ask. */
  asked = 0
  /** Which notes each question named. */
  readonly askedAbout: string[][] = []
  /** Notes kept in two versions, waiting for someone to choose. */
  readonly reviews: Array<{ docId: string; path: string; kind: string; mine: string; theirs: string; merged: string }> = []
  private settingsStore: { destroy(): unknown } | null = null
  private settingsCursor: InstanceType<typeof LocalCursor> | null = null
  socket: InstanceType<typeof VaultSocket> | null = null
  private refs: Array<{ name: string; listener: (...args: unknown[]) => void }> = []
  private indexTimer: ReturnType<typeof setTimeout> | null = null
  readonly views: ViewT[] = []
  private carriedHeld: { vaultId: string; held: Map<string, Set<string>> } | null = null

  constructor(
    /** A recovery may choose another. */
    public username: string,
    private readonly signUp: boolean,
    files: Record<string, string | Uint8Array> = {}
  ) {
    this.vault = new FakeVault(files)
    this.fileManager = new FakeFileManager(this.vault)
    this.metadataCache = new FakeMetadataCache(this.vault)
  }

  async boot(): Promise<boolean> {
    // A restart unlocks with what the device kept; the first start signs in.
    const register = async (): Promise<Unlocked> => {
      const registered = await this.session.register(this.username, this.password)
      this.recoveryCode = registered.recoveryCode
      return registered.unlocked
    }
    const askCode = async (again: boolean): Promise<string | null> => {
      this.askedForCode.push(again)
      return this.authenticator ? this.authenticator.code() : null
    }
    const unlocked =
      (await this.session.unlock()) ??
      (this.signUp && !this.accountId ? await register() : await this.session.login(this.username, this.password, askCode))
    this.unlocked = unlocked
    this.accountId = unlocked.accountId
    const openVault = await this.session.openVault(unlocked, VAULT)
    const keys = new KeyRing(openVault, unlocked, this.api, this.secrets)
    const vault = this.vault
    // Leaves showing files that are not notes - a canvas, a PDF - as far as
    // attachments care: which file each one shows.
    const workspace = {
      iterateAllLeaves: (visit: (leaf: { view: { file: unknown } }) => void): void => {
        for (const path of this.openFiles) visit({ view: { file: vault.getAbstractFileByPath(path) } })
      }
    }
    const app = { vault, fileManager: this.fileManager, metadataCache: this.metadataCache, workspace }
    const state = new StateStore(vault.adapter as never, 'plugin')
    const backups = new BackupStore(vault.adapter as never, 'plugin')
    const index = new VaultIndex(openVault.vaultId, (path, generation) => keys.docId(path, generation))
    const socket = new VaultSocket(serverUrl, openVault.vaultId, () => this.token ?? '', {
      notify: (kind, payload) => {
        // Caught, as main.ts's `processContacts` does: the next notice reads the inbox again.
        if (kind === 'contact') void this.contacts?.processInbox().catch(() => undefined)
        else if (kind === 'contact-removed') this.contacts?.forget((payload as { account: string }).account)
        // What main.ts's `refreshAccount` does.
        else if (kind === 'account-changed') void this.refreshAccount()
        else if (kind.startsWith('folder-')) void this.folders?.onNotify(kind, payload as never).then(() => this.editors.refresh())
        // What main.ts's `showVaultLock` does, without its window.
        else if (kind === 'vault-lock') this.followLock((payload as { lock: { sealed: string } | null }).lock)
        else void this.sharing?.onNotify(kind, payload as never).then(() => this.editors.refresh())
      },
      locked: () =>
        void this.api.vaultLock(openVault.vaultId).then(
          ({ lock }) => this.followLock(lock),
          () => undefined
        ),
      revoked: (room) =>
        void (room.startsWith('fld:') ? this.folders?.onRevoked(room) : this.sharing?.onRevoked(room))?.then(() => this.editors.refresh()),
      diverged: (room) => this.recovery?.diverged(room),
      // What main.ts's `checkSignedIn` does.
      signedOut: () =>
        void this.session.stillSignedIn().then(async (still) => {
          if (this.socket !== socket) return
          if (still !== false) {
            socket.reconnect(still === true)
            return
          }
          this.signedOut += 1
          await this.shutdown()
        })
    })
    // As main.ts: a restore from the Time Machine starts the sync under the lock it holds.
    if (this.heldLockId) socket.holdLock(this.heldLockId)
    const settings = new AccountSettings()
    const settingsStore = this.locals.open(`obsidian-connect/${openVault.vaultId}/set`, settings.doc)
    this.settingsCursor = await LocalCursor.load(settingsStore)
    this.settingsStore = settingsStore
    this.settings = settings
    socket.register(settingsRoom(openVault.vaultId), settings.doc, { crypto: keys.settingsCrypto(), cursor: this.settingsCursor })
    const user = { id: this.username, name: this.username, ...userColor(this.username) }
    const store = new DocStore(
      app as never,
      socket,
      index,
      state,
      backups,
      {
        vaultId: openVault.vaultId,
        user,
        excludeGlobs: [],
        conflictMarkers: true,
        maxLoadedDocuments: this.maxLoaded,
        syncTimeoutMs: 4_000,
        writeDebounceMs: 150
      },
      {
        indexCrypto: keys.indexCrypto(),
        docCrypto: (docId, entry) => keys.noteCrypto(docId, { owned: !entry?.owner, folder: Boolean(entry?.folder) }),
        roomFolder: (docId, entry) => this.folders?.roomFolder(docId, entry) ?? null
      },
      this.locals.open,
      this.locals.history
    )
    this.recovery = new Recovery({
      socket,
      store,
      settings,
      settingsReady: () => Promise.race([socket.whenSynced(settingsRoom(openVault.vaultId)), delay(4_000)]),
      ask: async (notes) => {
        this.asked += 1
        this.askedAbout.push(notes)
        return this.recoveryAnswer
      },
      onResolved: () => this.editors.refresh()
    })
    const contacts = new Contacts(
      this.api,
      { accountId: unlocked.accountId, username: unlocked.username, publicKey: unlocked.publicKey, privateKey: unlocked.privateKey },
      settings
    )
    this.contacts = contacts
    const attachmentIndex = new AttachmentIndex(index.doc, (path, generation) => keys.fileId(path, generation))
    this.maxFileBytes = (await this.api.config()).maxFileBytes ?? 0
    const attachments = new AttachmentStore(app as never, attachmentIndex, state, new Blobs(this.api, keys), this.attachmentOptions())
    this.attachments = attachments
    this.attachmentIndex = attachmentIndex
    const sharing: InstanceType<typeof Sharing> = new Sharing(
      this.api,
      keys,
      store,
      {
        folder: () => 'Shared',
        syncTimeoutMs: 4_000,
        autoAccept: () => true,
        folderEpoch: (id): Promise<number> => folders.currentEpoch(id),
        folderOver: (id): boolean => folders.over(id),
        contactsReady: () =>
          Promise.race([socket.whenSynced(settingsRoom(openVault.vaultId)).then(() => true), delay(4_000).then(() => false)]),
        // What main.ts's window says.
        unknownMembers: (accounts, place) => {
          this.unknownMembers.push({ accounts, place })
        }
      },
      contacts
    )
    const folders: InstanceType<typeof Folders> = new Folders(
      app as never,
      this.api,
      keys,
      store,
      index,
      socket,
      this.locals.open,
      sharing,
      { shareFolder: () => 'Shared', syncTimeoutMs: 4_000, autoAccept: () => true, settleMs: 300, decideMs: 2_000 },
      {
        moveIn: async (question) => {
          this.askedMoveIn.push(question.path)
          this.moveInQuestions.push({
            path: question.path,
            files: question.files,
            linked: question.linked.map((note) => note.path),
            strangers: question.strangers,
            people: question.people,
            at: Date.now()
          })
          if (this.moveInAnswer === null) {
            await question.moot
            return null
          }
          return { choice: this.moveInAnswer, withLinked: this.moveInWithLinked }
        },
        outside: async (question) => {
          if (this.outsideAnswer === null) {
            await question.moot
            return null
          }
          return this.outsideAnswer
        }
      },
      (news) => this.folderNews.push(news as never),
      attachments
    )
    this.folders = folders
    const sharedFiles = new SharedFiles(app as never, store, attachments, this.api, keys, {
      folder: () => 'Shared',
      syncTimeoutMs: 4_000,
      claimDelayMs: 300,
      folders
    })
    this.sharedFiles = sharedFiles
    this.store = store
    // As main.ts: the editors that outlived a restart, and what the store before knew of them.
    store.watchEditors((path) => this.editors.shows(path))
    if (this.carriedHeld?.vaultId === openVault.vaultId) store.inheritHeld(this.carriedHeld.held)
    this.carriedHeld = null
    this.index = index
    this.socket = socket
    this.keys = keys
    this.sharing = sharing
    this.compactor = new Compactor(this.api, keys, () => this.retentionDays)
    this.trash = new Trash(this.api, store, () => this.retentionDays, attachments, folders)

    // What main.ts wires up.
    store.onReady(() => this.editors.refresh())
    // What main.ts does when a note let go was caught up.
    store.onRefreshed((docId) => {
      const entry = store.entry(docId)
      if (entry?.shared || entry?.owner) sharedFiles.schedule(docId)
    })
    store.onLeave((docId) => void sharing.leave(docId))
    store.onReview((review) => this.reviews.push(review))
    const applyIndex = (): void => {
      if (this.indexTimer) clearTimeout(this.indexTimer)
      this.indexTimer = setTimeout(() => {
        this.indexTimer = null
        void store.applyRemoteIndexChanges().then(() => this.editors.refresh())
        void attachments.applyRemoteChanges()
        sharedFiles.scheduleAll()
      }, 100)
    }
    index.onChange(applyIndex)
    attachmentIndex.onChange(applyIndex)
    // A file of a shared folder with a new version here: it goes out from the folder's pass.
    attachmentIndex.onChange(() => folders.scheduleAll())
    let started = false
    socket.onStatus((status) => {
      if (status === 'connected' && started) {
        void store.resume().then(() => this.editors.refresh())
        void attachments.resume()
        void this.refreshAccount()
        // What main.ts's `checkVaultLock` does on a reconnect: a lock lifted while away was told to nobody here.
        void this.api.vaultLock(openVault.vaultId).then(
          ({ lock }) => this.followLock(lock),
          () => undefined
        )
      }
    })
    this.refs = [
      vault.on('modify', (file) => {
        void store.onModify(file as never)
        attachments.onModify(file as never)
        // Obsidian's metadata cache reports a note's changed links.
        sharedFiles.noteChanged(file as never)
      }),
      vault.on('create', (file) => {
        if ((file as { extension?: string }).extension === undefined) return
        void store.onCreate(file as never)
        attachments.onCreate(file as never)
        sharedFiles.noteChanged(file as never)
      }),
      vault.on('delete', (file) => {
        const path = (file as { path: string }).path
        if (file instanceof TFolderT) {
          void store.onDeleteFolder(path)
          void attachments.onDeleteFolder(path)
          folders.onFolderDeleted(path)
          return
        }
        void store.onDelete(path)
        void attachments.onDelete(path)
      }),
      vault.on('rename', (file, oldPath) => {
        if (file instanceof TFolderT) {
          folders.onFolderRenamed(oldPath as string, (file as { path: string }).path)
          return
        }
        void store.onRename(file as never, oldPath as string)
        void attachments.onRename(file as never, oldPath as string)
      })
    ]
    socket.connect()
    started = await store.start()
    if (started) {
      folders.start()
      await attachments.start()
      sharedFiles.start()
    }
    if (started) {
      await contacts.processInbox()
      await sharing.checkEnded()
      await sharing.checkIncoming()
      await folders.checkIncoming()
    }
    this.editors.refresh()
    return started
  }

  /** What the password dialog does. The other devices of the account are not told the new one. */
  async changePassword(next: string): Promise<void> {
    if (!this.unlocked) throw new Error('not signed in')
    this.unlocked = await this.session.changePassword(this.unlocked, this.password, next)
    this.password = next
  }

  /** What the settings do: needs the password, replaces the code. */
  async makeRecoveryCode(password = this.password): Promise<void> {
    if (!this.unlocked) throw new Error('not signed in')
    const made = await this.session.makeRecoveryCode(this.unlocked, password)
    this.unlocked = made.unlocked
    this.recoveryCode = made.code
  }

  async deleteRecoveryCode(password = this.password): Promise<void> {
    if (!this.unlocked) throw new Error('not signed in')
    this.unlocked = await this.session.deleteRecoveryCode(this.unlocked, password)
  }

  /** What connecting a backup server does on the device: a backup key for this vault, and the grant it hands over. */
  async makeBackupGrant(label = 'backup server', password = this.password): Promise<import('@obsidian-connect/shared').BackupGrant> {
    if (!this.unlocked) throw new Error('not signed in')
    const vault = await this.session.openVault(this.unlocked, VAULT)
    const made = await this.session.makeBackupGrant(this.unlocked, password, vault, label)
    this.unlocked = made.unlocked
    return made.grant
  }

  async deleteBackupKey(keyId: string): Promise<void> {
    if (!this.unlocked) throw new Error('not signed in')
    this.unlocked = await this.session.deleteBackupKey(this.unlocked, keyId)
  }

  private backupsController: InstanceType<typeof Backups> | null = null
  /** When this device last saw a good backup, per backup server - main.ts keeps it in data.json. */
  backupLastGood: Record<string, number> = {}

  /** The backup servers of the vault, wired the way main.ts wires them. */
  get backups(): InstanceType<typeof Backups> {
    this.backupsController ??= new Backups({
      serverUrl: () => serverUrl,
      token: () => this.token,
      settings: () => this.settings,
      makeGrant: (password, label) => this.makeBackupGrant(label, password),
      deleteKey: (keyId) => this.deleteBackupKey(keyId),
      lastGood: () => this.backupLastGood,
      saveLastGood: async (value) => {
        this.backupLastGood = value
      }
    })
    return this.backupsController
  }

  /** What the settings ask the server before anyone signs in, with the id this device pinned. */
  probe(): ReturnType<typeof probeServer> {
    return probeServer(this.api, this.session.pinnedServerId())
  }

  /** "Use this server", signed out: the server at the address was set up anew. */
  useNewServer(): void {
    this.session.forgetServer()
  }

  /** Locks of the vault this device took itself, by what they say. */
  readonly ownLocks = new Set<string>()
  /** The lock this device writes under, named to every new connection - main.ts's `heldLockId`. */
  heldLockId: string | null = null

  /** Another device's lock holds what this one writes; its end lets it go. */
  private followLock(lock: { sealed: string } | null): void {
    if (lock && this.ownLocks.has(lock.sealed)) return
    this.socket?.setLocked(lock !== null)
  }

  /** The vault locked for a rollback, this connection writing under it - as main.ts's `lockForRollback`. */
  async lockForRollback(folder = ''): Promise<{ release(): Promise<void> }> {
    const keys = this.keys
    if (!keys) throw new Error('not running')
    const scope = folder ? { kind: 'folder' as const, path: folder } : { kind: 'vault' as const }
    const sealed = await new LockSeal(keys.settingsCrypto(), keys.vaultId).seal({ what: 'a rollback', device: this.username, nonce: lockNonce(), scope })
    this.ownLocks.add(sealed)
    const lock = await takeVaultLock(this.api, keys.vaultId, 'rollback', sealed, () => undefined)
    this.heldLockId = lock.id
    this.socket?.holdLock(lock.id)
    return {
      release: async () => {
        await this.store?.whenAllSent(30_000)
        this.heldLockId = null
        this.socket?.holdLock(null)
        await lock.release()
        this.ownLocks.delete(sealed)
      }
    }
  }

  /** Rolling the vault back, wired the way main.ts wires it. */
  get rollback(): InstanceType<typeof Rollback> {
    const keys = this.keys
    if (!keys || !this.store || !this.settings) throw new Error('not running')
    return new Rollback({
      api: this.api,
      vaultId: keys.vaultId,
      indexCrypto: keys.indexCrypto(),
      docCrypto: (docId) => keys.noteCrypto(docId, { owned: true, folder: true }),
      store: this.store,
      attachments: this.attachments,
      settings: this.settings,
      // The backup servers once the test has reached for them, as main.ts hands them over.
      backups: this.backupsController,
      adapter: this.vault.adapter as never,
      root: 'plugin',
      isExcluded: () => false,
      clockMarginMs: this.rollbackClockMarginMs,
      lock: (folder) => this.lockForRollback(folder)
    })
  }

  /** A session on an invitation's route, through the sync server's relay, as connecting opens one. */
  openInviteSession(code: string, timeoutMs?: number): ReturnType<typeof openInviteSession> {
    return openInviteSession(serverUrl, this.token ?? '', code, timeoutMs)
  }

  /** A session on a vault's pairing route, as the settings open one. */
  openPairingSession(pairing: string, timeoutMs?: number): ReturnType<typeof openPairingSession> {
    return openPairingSession(serverUrl, this.token ?? '', pairing, timeoutMs)
  }

  /** Whether the server keeps a recovery code for the account, as this device last heard. */
  get hasRecoveryCode(): boolean | undefined {
    return this.unlocked?.bundle.recovery === undefined ? undefined : this.unlocked.bundle.recovery !== null
  }

  /** When the account's recovery code was made, as this device last heard; null for none. */
  get recoveryMadeAt(): number | null | undefined {
    const recovery = this.unlocked?.bundle.recovery
    return recovery === undefined ? undefined : (recovery?.createdAt ?? null)
  }

  private async refreshAccount(): Promise<void> {
    const unlocked = this.unlocked
    if (!unlocked) return
    const refreshed = await this.session.refreshBundle(unlocked).catch(() => null)
    if (refreshed && this.unlocked === unlocked) this.unlocked = refreshed
  }

  /** The sign-in screen's "Forgot your password?": signs this device in under the name and password chosen. */
  async recover(code: string, username: string, password: string): Promise<void> {
    const recovered = await this.session.recover(code, username, password, (problem) => {
      this.askedToKeep.push(problem)
      return this.keepTotp(problem)
    })
    this.recoveryCode = recovered.recoveryCode
    this.totpWasOn = recovered.totpWasOn
    this.username = username
    this.password = password
  }

  /** What the setup dialog does once the app shows a code for the secret. */
  async enableTotp(secret: Uint8Array, code: string, password = this.password): Promise<void> {
    if (!this.unlocked) throw new Error('not signed in')
    this.unlocked = await this.session.enableTotp(this.unlocked, password, new Uint8Array(secret), code)
  }

  async disableTotp(password = this.password): Promise<void> {
    if (!this.unlocked) throw new Error('not signed in')
    this.unlocked = await this.session.disableTotp(this.unlocked, password)
  }

  /** Whether signing in asks for a code, as this device last heard. */
  get hasTotp(): boolean | undefined {
    return this.unlocked?.bundle.totp
  }

  /** Whether the device holds a token and keys - what the settings show as "signed in". */
  get signedIn(): boolean {
    return this.token !== null
  }

  /** For tests that speak to the sync server as this account, without the plugin's code. */
  get accessToken(): string {
    return this.token ?? ''
  }

  /**
   * `keepViews`: sync stops while Obsidian goes on showing its editors - a
   * restart of sync, as signing out and in or a changed setting does - and
   * whatever is typed meanwhile stays in them.
   */
  async shutdown(options: { keepViews?: boolean } = {}): Promise<void> {
    this.backupsController?.closeSessions()
    if (!options.keepViews) for (const view of this.views.splice(0)) view.close()
    this.editors.unbindAll()
    if (this.indexTimer) clearTimeout(this.indexTimer)
    for (const ref of this.refs) this.vault.offref(ref)
    this.refs = []
    this.recovery?.stop()
    this.recovery = null
    await this.folders?.stop()
    this.folders = null
    this.sharedFiles?.stop()
    this.sharedFiles = null
    const attachments = this.attachments
    this.attachments = null
    await attachments?.stop()
    this.attachmentIndex?.destroy()
    const store = this.store
    this.store = null
    if (store && this.keys) this.carriedHeld = { vaultId: this.keys.vaultId, held: store.heldTexts() }
    await store?.stop()
    await this.settingsCursor?.flush()
    this.settingsStore?.destroy()
    this.settingsStore = null
    this.socket?.destroy()
    this.index?.destroy()
    this.settings?.destroy()
    this.settings = null
  }

  private attachmentOptions(): ConstructorParameters<typeof AttachmentStore>[4] {
    return {
      excludeGlobs: [],
      downloadLimitBytes: this.downloadLimit,
      maxFileBytes: this.maxFileBytes,
      settleMs: 100,
      rescanMs: 1_000,
      // Versions here live for seconds; all of them count.
      minVersionAgeMs: 0
    }
  }

  /** What the settings tab does when the limit is changed. */
  setDownloadLimit(bytes: number | null): void {
    this.downloadLimit = bytes
    this.attachments?.setOptions(this.attachmentOptions())
  }

  /** `saveEveryMs`: how often the view saves while it changes; Obsidian takes about two seconds. */
  open(path: string, saveEveryMs?: number): ViewT {
    const view = new FakeMarkdownView(this.vault, this.vault.file(path), this.editors.extension, document.body, saveEveryMs)
    this.views.push(view)
    return view
  }

  close(view: ViewT): void {
    view.close()
    this.views.splice(this.views.indexOf(view), 1)
  }

  docText(path: string): string | undefined {
    const docId = this.index?.docIdForPath(path)
    return docId ? this.handleText(docId) : undefined
  }

  private handleText(docId: string): string | undefined {
    const handles = (this.store as unknown as { handles: Map<string, { text(): string }> }).handles
    return handles.get(docId)?.text()
  }
}
