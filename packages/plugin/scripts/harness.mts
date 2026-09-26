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
const { userColor } = await import('@obsidian-connect/shared')
const { ConnectApi, fetchHttp } = await import('../src/account/api.js')
const { Session } = await import('../src/account/Session.js')
const { KeyRing } = await import('../src/account/KeyRing.js')
const { hashWasmArgon2id } = await import('../src/account/argon2.js')
const { DocStore } = await import('../src/sync/DocStore.js')
const { StateStore } = await import('../src/sync/StateStore.js')
const { BackupStore } = await import('../src/sync/BackupStore.js')
const { VaultIndex } = await import('../src/sync/VaultIndex.js')
const { VaultSocket } = await import('../src/sync/VaultSocket.js')
const { Compactor } = await import('../src/sync/Compactor.js')
const { EditorSync } = await import('../src/editor/EditorSync.js')
const { Sharing } = await import('../src/share/Sharing.js')
const { FakeVault, FakeFileManager, FakeMarkdownView, MemoryLocalStores, noteOf } = await import(
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
  private readonly session = new Session(this.api, this.secrets, hashWasmArgon2id, async (token) => {
    this.token = token
  })
  // Outlives restarts, like the plugin's own: Obsidian keeps the extension in
  // its editors while sync is stopped and started again.
  readonly editors = new EditorSync(() => this.store, noteOf)
  store: DocStoreT | null = null
  index: InstanceType<typeof VaultIndex> | null = null
  keys: InstanceType<typeof KeyRing> | null = null
  sharing: InstanceType<typeof Sharing> | null = null
  compactor: InstanceType<typeof Compactor> | null = null
  retentionDays = 30
  private socket: InstanceType<typeof VaultSocket> | null = null
  private refs: Array<{ name: string; listener: (...args: unknown[]) => void }> = []
  private indexTimer: ReturnType<typeof setTimeout> | null = null
  readonly views: ViewT[] = []

  constructor(
    readonly username: string,
    private readonly signUp: boolean,
    files: Record<string, string> = {}
  ) {
    this.vault = new FakeVault(files)
  }

  async boot(): Promise<boolean> {
    // A restart unlocks with what the device kept; the first start signs in.
    const unlocked =
      (await this.session.unlock()) ??
      (this.signUp ? await this.session.register(this.username, PASSWORD) : await this.session.login(this.username, PASSWORD))
    const openVault = await this.session.openVault(unlocked, VAULT)
    const keys = new KeyRing(openVault, unlocked, this.api, this.secrets)
    const vault = this.vault
    const app = { vault, fileManager: new FakeFileManager(vault) }
    const state = new StateStore(vault.adapter as never, 'plugin')
    const backups = new BackupStore(vault.adapter as never, 'plugin')
    const index = new VaultIndex(openVault.vaultId, (path, generation) => keys.docId(path, generation))
    const socket = new VaultSocket(serverUrl, openVault.vaultId, () => this.token ?? '', {
      notify: (kind, payload) => void this.sharing?.onNotify(kind, payload).then(() => this.editors.refresh()),
      revoked: (room) => void this.sharing?.onRevoked(room).then(() => this.editors.refresh())
    })
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
      this.locals.open
    )
    const sharing = new Sharing(this.api, keys, store, { folder: () => 'Shared', syncTimeoutMs: 4_000, autoAccept: () => true })
    this.store = store
    this.index = index
    this.socket = socket
    this.keys = keys
    this.sharing = sharing
    this.compactor = new Compactor(this.api, keys, () => this.retentionDays)

    // What main.ts wires up.
    store.onReady(() => this.editors.refresh())
    store.onLeave((docId) => void sharing.leave(docId))
    index.onChange(() => {
      if (this.indexTimer) clearTimeout(this.indexTimer)
      this.indexTimer = setTimeout(() => {
        this.indexTimer = null
        void store.applyRemoteIndexChanges().then(() => this.editors.refresh())
      }, 100)
    })
    let started = false
    socket.onStatus((status) => {
      if (status === 'connected' && started) void store.resume().then(() => this.editors.refresh())
    })
    this.refs = [
      vault.on('modify', (file) => void store.onModify(file as never)),
      vault.on('create', (file) => {
        if ((file as { extension?: string }).extension !== undefined) void store.onCreate(file as never)
      }),
      vault.on('delete', (file) => void store.onDelete((file as { path: string }).path)),
      vault.on('rename', (file, oldPath) => void store.onRename(file as never, oldPath as string))
    ]
    socket.connect()
    started = await store.start()
    if (started) await sharing.checkIncoming()
    this.editors.refresh()
    return started
  }

  async shutdown(): Promise<void> {
    for (const view of this.views.splice(0)) view.close()
    this.editors.unbindAll()
    if (this.indexTimer) clearTimeout(this.indexTimer)
    for (const ref of this.refs) this.vault.offref(ref)
    this.refs = []
    const store = this.store
    this.store = null
    await store?.stop()
    this.socket?.destroy()
    this.index?.destroy()
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
