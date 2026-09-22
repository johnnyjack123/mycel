// Devices of one person against a running server.
// Everything real except Obsidian itself: the DocStore, the editor binding in
// real CodeMirror editors, the socket, the server. The vault and the Markdown
// view are fakes that save and reload the way Obsidian does, because that
// interplay is what doubled text before.
//
//   PORT=1235 OBSIDIAN_CONNECT_DATA_DIR=<scratch> npm run start:server
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

// Imported after the DOM globals exist; CodeMirror reads them at module scope.
const { Notice } = await import('obsidian')
const { DocStore } = await import('../src/sync/DocStore.js')
const { StateStore } = await import('../src/sync/StateStore.js')
const { BackupStore } = await import('../src/sync/BackupStore.js')
const { VaultIndex } = await import('../src/sync/VaultIndex.js')
const { VaultSocket } = await import('../src/sync/VaultSocket.js')
const { EditorSync } = await import('../src/editor/EditorSync.js')
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

class Device {
  readonly vault: InstanceType<typeof FakeVault>
  readonly locals = new MemoryLocalStores()
  // Outlives restarts, like the plugin's own: Obsidian keeps the extension in
  // its editors while sync is stopped and started again.
  readonly editors = new EditorSync(() => this.store, noteOf)
  store: DocStoreT | null = null
  index: InstanceType<typeof VaultIndex> | null = null
  private socket: InstanceType<typeof VaultSocket> | null = null
  private refs: Array<{ name: string; listener: (...args: unknown[]) => void }> = []
  private indexTimer: ReturnType<typeof setTimeout> | null = null
  readonly views: ViewT[] = []

  constructor(
    readonly name: string,
    readonly vaultId: string,
    files: Record<string, string> = {}
  ) {
    this.vault = new FakeVault(files)
  }

  async boot(): Promise<boolean> {
    const vault = this.vault
    const app = { vault, fileManager: new FakeFileManager(vault) }
    const state = new StateStore(vault.adapter as never, 'plugin')
    const backups = new BackupStore(vault.adapter as never, 'plugin')
    const index = new VaultIndex(this.vaultId)
    const socket = new VaultSocket(serverUrl, this.vaultId, '')
    const user = { id: this.name, name: this.name, color: '#30bced', colorLight: '#30bced33' }
    const store = new DocStore(
      app as never,
      socket,
      index,
      state,
      backups,
      {
        vaultId: this.vaultId,
        user,
        excludeGlobs: [],
        conflictMarkers: true,
        maxLoadedDocuments: 500,
        syncTimeoutMs: 4_000,
        writeDebounceMs: 150
      },
      this.locals.open
    )
    this.store = store
    this.index = index
    this.socket = socket

    // What main.ts wires up.
    store.onReady(() => this.editors.refresh())
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

  docText(path: string): string | undefined {
    const docId = this.index?.docIdForPath(path)
    return docId ? this.handleText(docId) : undefined
  }

  private handleText(docId: string): string | undefined {
    const handles = (this.store as unknown as { handles: Map<string, { text(): string }> }).handles
    return handles.get(docId)?.text()
  }
}

const vaultId = `vault-selftest-${run}`
console.log(`server=${serverUrl} vault=${vaultId}`)

const A = new Device('Alice', vaultId, {
  'Welcome.md': 'Hello from A\n',
  'Projects/Plan.md': 'step 1\nstep 2\n'
})
const B = new Device('Alice-laptop', vaultId)

try {
  // --- a second device pulls the vault ---------------------------------------
  check(await A.boot(), 'A starts')
  check(await B.boot(), 'B starts with an empty vault')
  check(
    await eventually(() => B.vault.paths().join(',') === 'Projects/Plan.md,Welcome.md'),
    'B creates every note it only knows from the index, folders included',
    B.vault.paths()
  )
  check(B.vault.text('Welcome.md') === 'Hello from A\n', 'with the right content', B.vault.text('Welcome.md'))

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
  // since.
  // The dangerous shape: newer than the last agreement, older than the
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
  // insertions.
  aView.close()
  A.views.splice(A.views.indexOf(aView), 1)
  await delay(300)
  // At the start of lines, so a misplaced second part still lands inside the
  // text - silently wrong instead of out of range and caught.
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
  check(await B.boot(), 'B restarts')
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

  // --- a new device whose vault is a copy, with a note open at startup ----------
  // Nothing stored locally yet, so the document is empty until the server
  // answers. Binding then seeded the room with the editor's copy of a note the
  // room already held - the note doubled on every device.
  const D = new Device('Alice-phone', vaultId, {
    'Archive/Plan.md': A.vault.text('Archive/Plan.md') ?? '',
    'Welcome.md': A.vault.text('Welcome.md') ?? ''
  })
  try {
    const planBefore = A.vault.text('Archive/Plan.md')
    const dPlan = D.open('Archive/Plan.md')
    check(await D.boot(), 'a new device with a copied vault starts')
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
} catch (error) {
  check(false, 'the scenario ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  await A.shutdown()
  await B.shutdown()
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
