// Three devices of one person, and a second person, against a running server,
// end-to-end encrypted. Everything real except Obsidian itself: accounts and
// keys, the DocStore, the editor binding in real CodeMirror editors, the
// socket, the server. The vault and the Markdown view are fakes that save and
// reload the way Obsidian does, because that interplay is what doubled text
// before.
//
//   PORT=1235 OBSIDIAN_CONNECT_REGISTRATION=open OBSIDIAN_CONNECT_DATA_DIR=<scratch> npm run start:server
//   npm run test:vault -- ws://localhost:1235
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
const { Notice } = await import('obsidian')
const { docRoom, userColor } = await import('@obsidian-connect/shared')
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
const { NoteHistory } = await import('../src/history/NoteHistory.js')
const { Sharing } = await import('../src/share/Sharing.js')
const { FakeVault, FakeFileManager, FakeMarkdownView, MemoryLocalStores, noteOf } = await import(
  './stubs/fake-vault.js'
)

type DocStoreT = InstanceType<typeof DocStore>
type ViewT = InstanceType<typeof FakeMarkdownView>

const serverUrl = process.argv[2] ?? process.env.OBSIDIAN_CONNECT_URL ?? 'ws://localhost:1234'
const run = Date.now().toString(36)
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const failures: string[] = []
function check(ok: boolean, label: string, detail?: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`)
  if (!ok) {
    failures.push(label)
    if (detail !== undefined) console.log('      got:', JSON.stringify(detail))
  }
}

async function eventually(predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await delay(40)
  }
  return predicate()
}

const PASSWORD = 'correct horse battery staple'
const VAULT = 'Test vault'

class Device {
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

const alice = `alice${run}`
const carol = `carol${run}`
console.log(`server=${serverUrl} accounts=${alice},${carol}`)

const A = new Device(alice, true, {
  'Welcome.md': 'Hello from A\n',
  'Projects/Plan.md': 'step 1\nstep 2\n'
})
const B = new Device(alice, false)

try {
  // --- a second device pulls the vault ---------------------------------------
  check(await A.boot(), 'A creates the account and starts')
  check(await B.boot(), 'B signs in to the same account with an empty vault')
  check(
    await eventually(() => B.vault.paths().join(',') === 'Projects/Plan.md,Welcome.md'),
    'B creates every note it only knows from the index, folders included',
    B.vault.paths()
  )
  check(B.vault.text('Welcome.md') === 'Hello from A\n', 'with the right content', B.vault.text('Welcome.md'))

  {
    const docId = A.index?.docIdForPath('Welcome.md') as string
    const log = await A.api.log(docRoom(docId))
    const stored = log.frames.map((frame) => Buffer.from(frame.data, 'base64').toString('latin1')).join('')
    check(log.frames.length > 0 && !stored.includes('Hello from A'), 'the server stores the note encrypted')
  }

  // --- live, without editors -------------------------------------------------
  await A.vault.userCreate('Ideas.md', 'an idea\n')
  check(
    await eventually(() => B.vault.text('Ideas.md') === 'an idea\n'),
    'a note created on A appears on B',
    B.vault.text('Ideas.md')
  )

  await A.vault.userWrite('Welcome.md', 'Hello from A\nsecond line\n')
  check(
    await eventually(() => B.vault.text('Welcome.md') === 'Hello from A\nsecond line\n'),
    'an edit saved on A reaches the file on B',
    B.vault.text('Welcome.md')
  )

  await A.vault.createFolder('Archive')
  await A.vault.rename(A.vault.file('Projects/Plan.md'), 'Archive/Plan.md')
  check(
    await eventually(() => B.vault.text('Archive/Plan.md') === 'step 1\nstep 2\n' && !B.vault.text('Projects/Plan.md')),
    'a rename on A becomes a rename on B, into a folder B did not have',
    B.vault.paths()
  )

  const backupsBeforeDelete = B.vault.adapter.backups().length
  await A.vault.trash(A.vault.file('Ideas.md'))
  check(await eventually(() => B.vault.text('Ideas.md') === undefined), 'a delete on A removes the note on B')
  check(B.vault.adapter.backups().length > backupsBeforeDelete, 'and B keeps a backup of it')

  // --- live editors on both devices ------------------------------------------
  const aView = A.open('Welcome.md')
  const bView = B.open('Welcome.md')
  check(
    await eventually(() => A.editors.boundCount() === 1 && B.editors.boundCount() === 1),
    'both editors bind once the note is settled'
  )

  const backupsBeforeTyping = A.vault.adapter.backups().length + B.vault.adapter.backups().length
  const noticesBeforeTyping = Notice.shown.length

  // "tt" was all it took to flood a note with t's.
  aView.type('t')
  await delay(30)
  aView.type('t')
  check(
    await eventually(() => bView.text() === 'Hello from A\nsecond line\ntt'),
    'two quick keystrokes on A arrive on B exactly once',
    bView.text()
  )

  // Both typing in bursts, with Obsidian saving in the pauses while the other
  // side is still typing: every save lags the document by a few characters.
  const aTyped: string[] = []
  const bTyped: string[] = []
  for (let burst = 0; burst < 6; burst += 1) {
    for (let i = 0; i < 5; i += 1) {
      const a = String.fromCharCode(97 + ((burst * 5 + i) % 26))
      aView.type(a)
      aTyped.push(a)
      const b = String.fromCharCode(65 + ((burst * 5 + i) % 26))
      bView.type(b, 0)
      bTyped.push(b)
      await delay(12)
    }
    await delay(160)
  }
  const expectedLength = 'Hello from A\nsecond line\ntt'.length + aTyped.length + bTyped.length
  check(
    await eventually(() => aView.text() === bView.text() && aView.text().length === expectedLength),
    'concurrent typing on both devices converges without losing or doubling a character',
    { a: aView.text(), b: bView.text(), expectedLength }
  )
  check(
    aView.text().startsWith(bTyped.slice().reverse().join('')) && aView.text().endsWith(`tt${aTyped.join('')}`),
    'and each side kept its own typing in order',
    aView.text()
  )
  await delay(600)
  check(
    A.vault.text('Welcome.md') === aView.text() && B.vault.text('Welcome.md') === bView.text(),
    'Obsidian saved the same text to disk on both devices',
    { a: A.vault.text('Welcome.md'), b: B.vault.text('Welcome.md') }
  )
  check(!aView.text().includes('<<<<<<<'), 'no conflict markers from racing saves')
  check(
    A.vault.adapter.backups().length + B.vault.adapter.backups().length === backupsBeforeTyping,
    'typing produced no merge backups',
    A.vault.adapter.backups().concat(B.vault.adapter.backups())
  )
  check(Notice.shown.length === noticesBeforeTyping, 'and no merge notices', Notice.shown.slice(noticesBeforeTyping))

  // A save that lags the editor must not be merged back in: the editor is the
  // only writer, and merging its own older copy duplicated whatever was typed
  // since. The dangerous shape: newer than the last agreement, older than the
  // document. A three-way merge sees both sides change the same line.
  check(await eventually(() => B.vault.text('Welcome.md') === bView.text()), 'B saved before the next edit')
  await delay(200)
  bView.type('!')
  const halfway = bView.text()
  bView.type('?')
  await bView.saveStale(halfway)
  await delay(500)
  check(
    B.docText('Welcome.md') === `${halfway}?` && aView.text() === `${halfway}?` && bView.text() === `${halfway}?`,
    'a stale save of a bound editor is not merged into the document',
    { doc: B.docText('Welcome.md'), editor: bView.text(), expected: `${halfway}?` }
  )
  check(await eventually(() => B.vault.text('Welcome.md') === bView.text()), 'and the next save puts the file right')

  // A change with several parts in one transaction. Mapping its delta onto
  // the editor used to shift every later part by the length of the earlier
  // insertions. At the start of lines, so a misplaced second part still lands
  // inside the text - silently wrong instead of out of range and caught.
  A.close(aView)
  await delay(300)
  const lines = bView.text().split('\n')
  const reshaped = [`>> ${lines[0]}`, lines[1], `>> ${lines[2]}`].join('\n')
  await A.vault.userWrite('Welcome.md', reshaped)
  check(
    await eventually(() => bView.text() === reshaped),
    'a change in two places arrives in the editor in the right places',
    { editor: bView.text(), expected: reshaped }
  )
  check(B.docText('Welcome.md') === bView.text(), 'and the editor still matches its document')

  // Opening another note in the same leaf rebuilds the editor state.
  bView.showFile(B.vault.file('Archive/Plan.md'))
  check(
    await eventually(() => B.editors.boundCount() === 1 && B.docText('Archive/Plan.md') === bView.text()),
    'switching notes in a leaf rebinds to the new note'
  )
  check(B.docText('Welcome.md') === reshaped, 'without carrying the other note into the old document')
  bView.type('\nstep 3')
  check(
    await eventually(() => A.vault.text('Archive/Plan.md') === 'step 1\nstep 2\n\nstep 3'),
    'and typing there reaches the other device',
    A.vault.text('Archive/Plan.md')
  )

  // --- offline ----------------------------------------------------------------
  const plan = 'step 1\nstep 2\n\nstep 3'
  await B.shutdown()
  await A.vault.userWrite('Archive/Plan.md', `STEP 1\nstep 2\n\nstep 3`)
  B.vault.offlineWrite('Archive/Plan.md', `step 1\nstep 2\n\nstep 3\nstep 4 (offline)`)
  check(await B.boot(), 'B comes back after both sides edited the same note')
  const merged = 'STEP 1\nstep 2\n\nstep 3\nstep 4 (offline)'
  check(
    await eventually(() => B.vault.text('Archive/Plan.md') === merged && A.vault.text('Archive/Plan.md') === merged),
    'both offline edits survive, on both devices',
    { a: A.vault.text('Archive/Plan.md'), b: B.vault.text('Archive/Plan.md'), before: plan }
  )

  await B.shutdown()
  await A.vault.userCreate('Scratch.md', 'temporary\n')
  await delay(600)
  check(await B.boot(), 'B restarts, unlocking with what it kept')
  check(await eventually(() => B.vault.text('Scratch.md') === 'temporary\n'), 'B has Scratch.md')
  await B.shutdown()
  await A.vault.trash(A.vault.file('Scratch.md'))
  await delay(600)
  check(await B.boot(), 'B restarts after A deleted a note it has not changed')
  await delay(1_000)
  check(B.vault.text('Scratch.md') === undefined, 'B applies the delete instead of bringing the note back')
  check(A.vault.text('Scratch.md') === undefined, 'and A does not get it back either')

  await B.shutdown()
  await A.vault.trash(A.vault.file('Welcome.md'))
  B.vault.offlineWrite('Welcome.md', `${reshaped}\nwritten on B while offline`)
  await delay(600)
  check(await B.boot(), 'B restarts after A deleted a note B changed')
  check(
    await eventually(() => A.vault.text('Welcome.md') === `${reshaped}\nwritten on B while offline`),
    'the change wins over the delete and comes back to A',
    A.vault.text('Welcome.md')
  )
  check(B.vault.text('Welcome.md') === `${reshaped}\nwritten on B while offline`, 'and B keeps it')

  // --- an editor that was open before sync started ----------------------------
  await B.shutdown()
  const early = B.open('Archive/Plan.md')
  early.type('\ntyped before sync started')
  await delay(300)
  check(await B.boot(), 'B starts with the note already open and edited')
  const expectedEarly = `${merged}\ntyped before sync started`
  check(
    await eventually(() => A.vault.text('Archive/Plan.md') === expectedEarly && early.text() === expectedEarly),
    'what was typed before sync started arrives once, and the editor gains nothing twice',
    { a: A.vault.text('Archive/Plan.md'), editor: early.text() }
  )
  check(await eventually(() => B.editors.boundCount() === 1), 'and the editor binds')

  // --- deleting and re-creating ------------------------------------------------
  // Obsidian names every new note "Untitled" and the user renames it, so a
  // note's id usually comes from a path it no longer has.
  await A.vault.userCreate('Untitled.md', 'doomed text\n')
  await delay(300)
  await A.vault.rename(A.vault.file('Untitled.md'), 'Doomed.md')
  check(await eventually(() => B.vault.text('Doomed.md') === 'doomed text\n'), 'B has Doomed.md')

  // Deleted on one device while it is open on the other. The open editor
  // re-acquired the note from its now deleted file and registered it again,
  // so it came back - empty - on both devices.
  const doomedView = A.open('Doomed.md')
  check(await eventually(() => A.editors.boundCount() === 1), 'A has Doomed.md open')
  await B.vault.trash(B.vault.file('Doomed.md'))
  check(await eventually(() => A.vault.text('Doomed.md') === undefined), 'the delete reaches the device showing the note')
  await delay(1_500)
  check(
    A.vault.text('Doomed.md') === undefined && B.vault.text('Doomed.md') === undefined,
    'and the note does not come back, on either device',
    { a: A.vault.text('Doomed.md'), b: B.vault.text('Doomed.md') }
  )
  A.close(doomedView)

  // A new note at a path an earlier note was created under must be a new
  // document, not that one.
  await A.vault.userCreate('Untitled.md', 'first note\n')
  await delay(300)
  await A.vault.rename(A.vault.file('Untitled.md'), 'First.md')
  await A.vault.userCreate('Untitled.md', '')
  check(
    await eventually(() => B.vault.text('Untitled.md') === '' && B.vault.text('First.md') === 'first note\n'),
    'a second "Untitled" note syncs on its own, next to the renamed first one',
    { untitled: B.vault.text('Untitled.md'), first: B.vault.text('First.md') }
  )

  await A.vault.userCreate('Gone.md', 'content of a note that was deleted\n')
  check(await eventually(() => B.vault.text('Gone.md') !== undefined), 'B has Gone.md')
  await A.vault.trash(A.vault.file('Gone.md'))
  check(await eventually(() => B.vault.text('Gone.md') === undefined), 'Gone.md is deleted on B')
  await A.vault.userCreate('Gone.md', 'a new note\n')
  await delay(1_500)
  check(
    A.vault.text('Gone.md') === 'a new note\n' && B.vault.text('Gone.md') === 'a new note\n',
    'a new note under a deleted name does not inherit the deleted text',
    { a: A.vault.text('Gone.md'), b: B.vault.text('Gone.md') }
  )

  // Opening a new note in a leaf that showed another one. For a moment the
  // view already names the new note while the buffer still holds the old
  // text; binding then took that text for edits to the new note.
  const leaf = A.open('First.md')
  check(await eventually(() => A.editors.boundCount() === 1), 'A has First.md open')
  for (const [name, rebuild] of [['Fresh.md', true], ['Fresher.md', false]] as const) {
    await A.vault.userCreate(name, '')
    await delay(300)
    await leaf.showFileSlowly(A.vault.file(name), 400, rebuild)
    await delay(1_000)
    check(
      A.vault.text(name) === '' && B.vault.text(name) === '' && leaf.text() === '',
      `a new note opened in a used leaf stays empty (${rebuild ? 'fresh state' : 'same state'})`,
      { editor: leaf.text(), a: A.vault.text(name), b: B.vault.text(name) }
    )
    check(A.vault.text('First.md') === 'first note\n', 'and the note that was open before is untouched')
    leaf.showFile(A.vault.file('First.md'))
    await delay(300)
  }
  leaf.showFile(A.vault.file('Fresh.md'))
  check(await eventually(() => A.editors.boundCount() === 1), 'Fresh.md binds')
  leaf.type('fresh text')
  check(await eventually(() => B.vault.text('Fresh.md') === 'fresh text'), 'typing in it then reaches the other device')
  A.close(leaf)

  // --- a new device whose vault is a copy, with a note open at startup ----------
  // Nothing stored locally yet, so the document is empty until the server
  // answers. Binding then seeded the room with the editor's copy of a note the
  // room already held - the note doubled on every device.
  const D = new Device(alice, false, {
    'Archive/Plan.md': A.vault.text('Archive/Plan.md') ?? '',
    'Welcome.md': A.vault.text('Welcome.md') ?? ''
  })
  try {
    const planBefore = A.vault.text('Archive/Plan.md')
    const dPlan = D.open('Archive/Plan.md')
    check(await D.boot(), 'a new device with a copied vault signs in and starts')
    check(await eventually(() => D.editors.boundCount() === 1), 'its open editor binds')
    await delay(800)
    check(
      dPlan.text() === planBefore && A.vault.text('Archive/Plan.md') === planBefore,
      'and the note is not doubled anywhere',
      { phone: dPlan.text(), a: A.vault.text('Archive/Plan.md'), expected: planBefore }
    )
  } finally {
    await D.shutdown()
  }

  // --- sharing one note with a person ------------------------------------------------
  // The history view merges edits less than a minute apart into one version;
  // here the draft lives for well under a second.
  const HISTORY_GAP_MS = 150
  const C = new Device(carol, true)
  try {
    check(await C.boot(), 'C creates an account of her own')
    await A.vault.userCreate('Together.md', 'a draft nobody else should see\n')
    await delay(400)
    await A.vault.userWrite('Together.md', 'shared text\n')
    check(await eventually(() => A.docText('Together.md') === 'shared text\n'), 'A has Together.md')
    const docId = A.index?.docIdForPath('Together.md') as string
    const room = docRoom(docId)

    await A.sharing?.share(docId, carol, 'write', false)
    check(
      await eventually(() => C.vault.text('Shared/Together.md') === 'shared text\n'),
      'C receives the note in her share folder, without being asked',
      C.vault.paths()
    )
    check(C.vault.paths().join(',') === 'Shared/Together.md', "and nothing else from A's vault", C.vault.paths())

    {
      const history = new NoteHistory(C.api, room, (C.keys as InstanceType<typeof KeyRing>).sharedDocCrypto(docId), HISTORY_GAP_MS)
      await history.load()
      const texts = history.versions().map((version) => history.textAt(version.seq))
      check(
        texts.length > 0 && texts.every((text) => !text.includes('draft')),
        'shared without history, C cannot see what the note said before',
        texts
      )
      const own = new NoteHistory(A.api, room, (A.keys as InstanceType<typeof KeyRing>).ownDocCrypto(docId), HISTORY_GAP_MS)
      await own.load()
      check(
        own.versions().some((version) => own.textAt(version.seq).includes('draft')),
        'while A still sees every version'
      )
    }

    const aTogether = A.open('Together.md')
    const cTogether = C.open('Shared/Together.md')
    check(
      await eventually(() => A.editors.boundCount() === 1 && C.editors.boundCount() === 1),
      'both editors bind the shared note'
    )
    aTogether.type('from Alice ')
    check(await eventually(() => cTogether.text() === 'shared text\nfrom Alice '), 'A types, C sees it live')
    cTogether.type('and Carol', 0)
    check(
      await eventually(() => aTogether.text() === 'and Carolshared text\nfrom Alice '),
      'C types, A sees it live',
      aTogether.text()
    )
    check(
      await eventually(() => cTogether.view.dom.querySelector('.connect-remote-caret-label')?.textContent === alice),
      "C sees Alice's cursor"
    )
    check(
      await eventually(() => aTogether.view.dom.querySelector('.connect-remote-caret-label')?.textContent === carol),
      "A sees Carol's cursor"
    )

    // Typing exactly at someone's caret. On their own screen the caret stays
    // in front of the new text, so that is where everyone else must see it.
    {
      const carolAt = 'and Carol'.length
      const carolOnA = (): number => {
        const caret = aTogether.view.dom.querySelector('.connect-remote-caret')
        return caret ? aTogether.view.posAtDOM(caret) : -1
      }
      check(await eventually(() => carolOnA() === carolAt), "A sees Carol's caret where she stopped typing", carolOnA())
      aTogether.view.dispatch({ changes: { from: carolAt, insert: 'XYZ' }, userEvent: 'input.type' })
      check(await eventually(() => cTogether.text().startsWith('and CarolXYZ')), 'C gets what A typed at her caret')
      check(cTogether.view.state.selection.main.head === carolAt, "Carol's own caret stays in front of it")
      await delay(300)
      check(carolOnA() === carolAt, 'and A sees it there too, not pushed past the new text', carolOnA())
    }
    check(await eventually(() => B.store?.isShared(docId) === true), "A's other device learns the note is shared")

    // Syncing your own devices never shows a caret.
    const bWelcome = B.open('Welcome.md')
    const aWelcome = A.open('Welcome.md')
    check(
      await eventually(() => A.editors.boundCount() === 2 && B.editors.boundCount() === 2),
      "an unshared note binds on both of A's devices"
    )
    aWelcome.type(' caret?')
    await delay(600)
    check(bWelcome.view.dom.querySelector('.connect-remote-caret') === null, 'and shows no cursor between them')
    {
      const welcome = await B.store?.handle(A.index?.docIdForPath('Welcome.md') as string)
      check(welcome?.awareness.getLocalState()?.user === undefined, 'nor announces anyone')
    }

    // Read only.
    await A.sharing?.setRole(docId, carol, 'read')
    check(await eventually(() => C.store?.isReadOnly(docId) === true), 'C learns she may only read now')
    check(await eventually(() => cTogether.view.state.readOnly), "and C's editor stops taking input")
    const beforeReading = aTogether.text()
    cTogether.view.dispatch({ changes: { from: 0, insert: 'NOT ALLOWED ' } })
    await delay(600)
    check(aTogether.text() === beforeReading && cTogether.text() === beforeReading, 'nothing C slips in reaches A')
    aTogether.type(' for readers')
    check(await eventually(() => cTogether.text() === `${beforeReading} for readers`), 'while what A writes still reaches C')

    // Revoking: C keeps her copy, as a note of her own, and they part ways.
    C.close(cTogether)
    await A.sharing?.revoke(docId, carol)
    const keptByCarol = `${beforeReading} for readers`
    check(
      await eventually(() => C.store?.entry(C.index?.docIdForPath('Shared/Together.md') ?? '')?.owner === undefined && Boolean(C.index?.docIdForPath('Shared/Together.md'))),
      'after the share is revoked, C has the note as one of her own',
      C.index?.docIdForPath('Shared/Together.md')
    )
    check(C.vault.text('Shared/Together.md') === keptByCarol, 'with everything up to that point', C.vault.text('Shared/Together.md'))
    {
      // The revocation arrives as a message and as a notice. Handling both
      // minted a second copy of the note, which the duplicate merge then
      // folded back - harmless only while both copies are identical.
      await delay(300)
      const everIndexed = [...(C.index?.live() ?? []), ...(C.index?.deleted() ?? [])]
        .filter(({ entry }) => entry.path === 'Shared/Together.md')
        .map(({ docId }) => docId)
      check(everIndexed.length === 2, 'the revoke moves the note once, not once per message', everIndexed)
    }
    aTogether.type(' after revoke')
    await C.vault.userWrite('Shared/Together.md', `${keptByCarol}\nCarol's own line`)
    await delay(1_200)
    check(!C.vault.text('Shared/Together.md')?.includes('after revoke'), 'what A writes afterwards no longer reaches C')
    check(!aTogether.text().includes("Carol's own line"), "and C's copy no longer reaches A")

    // History, restored on the client.
    A.close(aTogether)
    await delay(300)
    {
      const history = new NoteHistory(A.api, room, (A.keys as InstanceType<typeof KeyRing>).ownDocCrypto(docId), HISTORY_GAP_MS)
      await history.load()
      const draft = history.versions().find((version) => history.textAt(version.seq).includes('draft'))
      check(Boolean(draft), 'A finds the draft in the history')
      if (draft) await A.store?.restore(docId, history.textAt(draft.seq))
      check(
        await eventually(() => A.vault.text('Together.md') === 'a draft nobody else should see\n' && B.vault.text('Together.md') === 'a draft nobody else should see\n'),
        'restoring it reaches the file and the other device',
        { a: A.vault.text('Together.md'), b: B.vault.text('Together.md') }
      )
    }

    // Compaction: the owner folds old history into a snapshot, and the note
    // still reads the same everywhere.
    A.retentionDays = 1e-9
    const compacted = (await A.compactor?.run()) ?? 0
    check(compacted > 0, 'the owner compacts old history', compacted)
    {
      const history = new NoteHistory(A.api, room, (A.keys as InstanceType<typeof KeyRing>).ownDocCrypto(docId), HISTORY_GAP_MS)
      await history.load()
      const latest = history.versions()[0]
      check(Boolean(latest) && history.textAt(latest?.seq ?? 0) === 'a draft nobody else should see\n', 'the history still ends in the current text')
    }
    await B.shutdown()
    check(await B.boot(), 'B restarts after compaction')
    check(
      await eventually(() => B.vault.text('Together.md') === 'a draft nobody else should see\n' && B.vault.text('Archive/Plan.md') === A.vault.text('Archive/Plan.md')),
      'and still has every note right'
    )
  } finally {
    await C.shutdown()
  }

  // --- the same existing vault on two devices, both starting at once ----------------
  // Notes that were there before the plugin: each device seeds the note's
  // document from its file. Started at the same moment, both see an empty
  // document and both seed it.
  {
    const erin = `erin${run}`
    const files = { 'Existing/One.md': 'a note from before the plugin\n', 'Existing/Two.md': 'another\none\n' }
    const E0 = new Device(erin, true)
    check(await E0.boot(), 'E0 creates the account')
    await E0.shutdown()
    const E1 = new Device(erin, false, files)
    const E2 = new Device(erin, false, files)
    try {
      const started = await Promise.all([E1.boot(), E2.boot()])
      check(started.every(Boolean), 'two devices with the same notes start at the same moment')
      await delay(1_500)
      const texts = Object.keys(files).map((path) => ({ path, e1: E1.vault.text(path), e2: E2.vault.text(path), doc: E1.docText(path) }))
      check(
        texts.every(({ path, e1, e2, doc }) => e1 === files[path as keyof typeof files] && e2 === e1 && doc === e1),
        'and every note is there once, on both',
        texts
      )

      // The same seed again, into a document that held it and was emptied
      // since: Yjs takes it for known and does nothing, so the device has to
      // insert its text itself - or its file was emptied, without a backup.
      const note = files['Existing/One.md']
      await E1.vault.userWrite('Existing/One.md', '')
      check(await eventually(() => E2.vault.text('Existing/One.md') === ''), 'E1 empties a note, E2 follows')
      const E3 = new Device(erin, false, { 'Existing/One.md': note })
      try {
        check(await E3.boot(), 'a device with an old copy of it starts')
        await delay(800)
        check(E3.vault.text('Existing/One.md') === note, 'and keeps its text', E3.vault.text('Existing/One.md'))
        check(await eventually(() => E1.vault.text('Existing/One.md') === note), 'which comes back everywhere, as without a base it must')
      } finally {
        await E3.shutdown()
      }
    } finally {
      await E1.shutdown()
      await E2.shutdown()
    }
  }
} catch (error) {
  check(false, 'the scenario ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  await A.shutdown()
  await B.shutdown()
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
