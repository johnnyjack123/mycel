// What the end-to-end self-tests share: a DOM for real CodeMirror editors,
// the check helpers, and `Device` - one device of one person, with the real
// accounts, keys, DocStore, socket and editor binding, against a fake vault
// that saves and reloads the way Obsidian does.
import { JSDOM } from 'jsdom'

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
const { SharedFiles } = await import('../src/share/SharedFiles.js')
const { Contacts } = await import('../src/share/Contacts.js')
const { FakeVault, FakeFileManager, FakeMarkdownView, FakeMetadataCache, MemoryLocalStores, noteOf } = await import(
  './stubs/fake-vault.js'
)

type DocStoreT = InstanceType<typeof DocStore>
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
  compactor: InstanceType<typeof Compactor> | null = null
  trash: InstanceType<typeof Trash> | null = null
  settings: InstanceType<typeof AccountSettings> | null = null
  contacts: InstanceType<typeof Contacts> | null = null
  recovery: InstanceType<typeof Recovery> | null = null
  retentionDays = 30
  /** What the user answers when the server turns out to have other data. */
  recoveryAnswer: 'device' | 'server' | null = null
  /** How many times this device had to ask. */
  asked = 0
  /** Notes kept in two versions, waiting for someone to choose. */
  readonly reviews: Array<{ docId: string; path: string; kind: string; mine: string; theirs: string; merged: string }> = []
  private settingsStore: { destroy(): unknown } | null = null
  private settingsCursor: InstanceType<typeof LocalCursor> | null = null
  socket: InstanceType<typeof VaultSocket> | null = null
  private refs: Array<{ name: string; listener: (...args: unknown[]) => void }> = []
  private indexTimer: ReturnType<typeof setTimeout> | null = null
  readonly views: ViewT[] = []

  constructor(
    readonly username: string,
    private readonly signUp: boolean,
    files: Record<string, string | Uint8Array> = {}
  ) {
    this.vault = new FakeVault(files)
    this.fileManager = new FakeFileManager(this.vault)
  }

  async boot(): Promise<boolean> {
    // A restart unlocks with what the device kept; the first start signs in.
    const unlocked =
      (await this.session.unlock()) ??
      (this.signUp ? await this.session.register(this.username, PASSWORD) : await this.session.login(this.username, PASSWORD))
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
    const app = { vault, fileManager: this.fileManager, metadataCache: new FakeMetadataCache(vault), workspace }
    const state = new StateStore(vault.adapter as never, 'plugin')
    const backups = new BackupStore(vault.adapter as never, 'plugin')
    const index = new VaultIndex(openVault.vaultId, (path, generation) => keys.docId(path, generation))
    const socket = new VaultSocket(serverUrl, openVault.vaultId, () => this.token ?? '', {
      notify: (kind, payload) => {
        if (kind === 'contact') void this.contacts?.processInbox()
        else if (kind === 'contact-removed') this.contacts?.forget((payload as { account: string }).account)
        else void this.sharing?.onNotify(kind, payload as never).then(() => this.editors.refresh())
      },
      revoked: (room) => void this.sharing?.onRevoked(room).then(() => this.editors.refresh()),
      diverged: (room) => this.recovery?.diverged(room)
    })
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
        maxLoadedDocuments: 500,
        syncTimeoutMs: 4_000,
        writeDebounceMs: 150
      },
      {
        indexCrypto: keys.indexCrypto(),
        docCrypto: (docId, entry) => (entry?.owner ? keys.sharedDocCrypto(docId) : keys.ownDocCrypto(docId))
      },
      this.locals.open,
      this.locals.history
    )
    this.recovery = new Recovery({
      socket,
      store,
      settings,
      settingsReady: () => Promise.race([socket.whenSynced(settingsRoom(openVault.vaultId)), delay(4_000)]),
      ask: async () => {
        this.asked += 1
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
    const sharing = new Sharing(this.api, keys, store, { folder: () => 'Shared', syncTimeoutMs: 4_000, autoAccept: () => true }, contacts)
    const attachmentIndex = new AttachmentIndex(index.doc, (path, generation) => keys.fileId(path, generation))
    this.maxFileBytes = (await this.api.config()).maxFileBytes ?? 0
    const attachments = new AttachmentStore(app as never, attachmentIndex, state, new Blobs(this.api, keys), this.attachmentOptions())
    this.attachments = attachments
    this.attachmentIndex = attachmentIndex
    const sharedFiles = new SharedFiles(app as never, store, attachments, this.api, keys, {
      folder: () => 'Shared',
      syncTimeoutMs: 4_000,
      claimDelayMs: 300
    })
    this.sharedFiles = sharedFiles
    this.store = store
    this.index = index
    this.socket = socket
    this.keys = keys
    this.sharing = sharing
    this.compactor = new Compactor(this.api, keys, () => this.retentionDays)
    this.trash = new Trash(this.api, store, () => this.retentionDays, attachments)

    // What main.ts wires up.
    store.onReady(() => this.editors.refresh())
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
    let started = false
    socket.onStatus((status) => {
      if (status === 'connected' && started) {
        void store.resume().then(() => this.editors.refresh())
        void attachments.resume()
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
        void store.onDelete((file as { path: string }).path)
        void attachments.onDelete((file as { path: string }).path)
      }),
      vault.on('rename', (file, oldPath) => {
        void store.onRename(file as never, oldPath as string)
        void attachments.onRename(file as never, oldPath as string)
      })
    ]
    socket.connect()
    started = await store.start()
    if (started) {
      await attachments.start()
      sharedFiles.start()
    }
    if (started) {
      await contacts.processInbox()
      await sharing.checkEnded()
      await sharing.checkIncoming()
    }
    this.editors.refresh()
    return started
  }

  async shutdown(): Promise<void> {
    for (const view of this.views.splice(0)) view.close()
    this.editors.unbindAll()
    if (this.indexTimer) clearTimeout(this.indexTimer)
    for (const ref of this.refs) this.vault.offref(ref)
    this.refs = []
    this.recovery?.stop()
    this.recovery = null
    this.sharedFiles?.stop()
    this.sharedFiles = null
    const attachments = this.attachments
    this.attachments = null
    await attachments?.stop()
    this.attachmentIndex?.destroy()
    const store = this.store
    this.store = null
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

  open(path: string): ViewT {
    const view = new FakeMarkdownView(this.vault, this.vault.file(path), this.editors.extension, document.body)
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
