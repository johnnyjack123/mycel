// The editor binding on its own, in real CodeMirror editors in jsdom, with
// two documents kept in sync through a running server. `test:vault` covers
// the binding together with the store; this one pins down the details of
// keeping an editor and a Y.Text identical.
//
//   PORT=1235 OBSIDIAN_CONNECT_DATA_DIR=<scratch> npm run start:server
//   npm run test:sync -- ws://localhost:1235
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
const { EditorState } = await import('@codemirror/state')
const { EditorView } = await import('@codemirror/view')
const { history, undo } = await import('@codemirror/commands')
const Y = await import('yjs')
const { WebsocketProvider } = await import('y-websocket')
const { WebSocket } = await import('ws')
const { deltaToChanges, editorSyncExtension } = await import('../src/editor/binding.js')
const { reconcile } = await import('../src/sync/Reconciler.js')
const { noteField, noteOf, showNote } = await import('./stubs/fake-vault.js')

type Binding = import('../src/editor/binding.js').EditorBinding
type Session = import('../src/editor/binding.js').EditorSession
type NoteRef = import('../src/editor/binding.js').NoteRef

const serverUrl = process.argv[2] ?? process.env.OBSIDIAN_CONNECT_URL ?? 'ws://localhost:1234'
const room = `binding-selftest-${Date.now().toString(36)}`
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const failures: string[] = []
function check(ok: boolean, label: string, detail?: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`)
  if (!ok) {
    failures.push(label)
    if (detail !== undefined) console.log('      got:', JSON.stringify(detail))
  }
}

async function eventually(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await delay(30)
  }
  return predicate()
}

// --- the delta mapping, without a server ------------------------------------
{
  const source = new Y.Doc()
  const sourceText = source.getText('content')
  sourceText.insert(0, '0123456789')
  const target = new Y.Doc()
  Y.applyUpdate(target, Y.encodeStateAsUpdate(source))
  let delta: Parameters<typeof deltaToChanges>[0] = []
  target.getText('content').observe((event) => {
    delta = event.delta
  })
  source.transact(() => {
    sourceText.insert(2, 'ab')
    sourceText.delete(7, 2)
  })
  Y.applyUpdate(target, Y.encodeStateAsUpdate(source, Y.encodeStateVector(target)))
  const applied = EditorState.create({ doc: '0123456789' }).update({ changes: deltaToChanges(delta) }).state.doc
  check(
    applied.toString() === target.getText('content').toString(),
    'a delta with several parts maps onto the editor in the right places',
    applied.toString()
  )
}

// --- two editors through the server -------------------------------------------

class Host {
  releases = 0
  acquired = 0
  recent: string | null = null

  constructor(
    readonly note: NoteRef,
    readonly ytext: InstanceType<typeof Y.Text>,
    readonly base: string,
    // Stands in for settling: the real host only hands out a document whose
    // server state has arrived.
    private readonly settled: Promise<void>
  ) {}

  attached(): void {}
  detached(): void {}

  async acquire(note: NoteRef, _binding: Binding): Promise<Session | null> {
    if (note !== this.note) return null
    await this.settled
    this.acquired += 1
    return {
      ytext: this.ytext,
      awareness: null,
      isUnedited: (text: string) => text === this.base || text === this.recent,
      recentWrite: () => this.recent,
      resolve: async (local: string, remote: string) => {
        const outcome = reconcile({ base: this.base, local, remote, markers: false })
        if (outcome.kind === 'merge') return outcome.text
        return outcome.kind === 'seed' || outcome.kind === 'adopt-local' ? local : remote
      },
      isStale: () => false,
      release: () => {
        this.releases += 1
      }
    }
  }
}

function client(label: string, editorText: string, base: string) {
  const doc = new Y.Doc()
  const ytext = doc.getText('content')
  // BroadcastChannel would sync these clients inside this process and hide a
  // broken server, so everything goes through the WebSocket.
  const provider = new WebsocketProvider(serverUrl, room, doc, {
    connect: true,
    disableBc: true,
    WebSocketPolyfill: WebSocket as never
  })
  const note: NoteRef = { path: `${label}.md` }
  const host = new Host(note, ytext, base, whenSynced(provider))
  const view = new EditorView({
    state: EditorState.create({
      doc: editorText,
      extensions: [noteField.init(() => note), history(), editorSyncExtension(host, noteOf)]
    }),
    parent: document.body
  })
  return {
    label,
    doc,
    ytext,
    provider,
    host,
    view,
    note,
    text: (): string => view.state.doc.toString(),
    type: (text: string, at = view.state.doc.length): void => {
      view.dispatch({ changes: { from: at, insert: text }, userEvent: 'input.type' })
    }
  }
}

function whenSynced(provider: InstanceType<typeof WebsocketProvider>): Promise<void> {
  if (provider.synced) return Promise.resolve()
  return new Promise((resolve) => provider.once('sync', () => resolve()))
}

console.log(`server=${serverUrl} room=${room}`)

// The binding only ever starts on a settled note, so the room is filled
// before either editor binds.
const seed = new Y.Doc()
const seedProvider = new WebsocketProvider(serverUrl, room, seed, {
  disableBc: true,
  WebSocketPolyfill: WebSocket as never
})
await Promise.race([whenSynced(seedProvider), delay(6_000)])
seed.getText('content').insert(0, 'Hello world')
await delay(500)
seedProvider.destroy()

// A shows what the file said at the last agreement; B shows a copy nobody
// has typed in since an older agreement, which the document has moved past.
const a = client('A', 'Hello world', 'Hello world')
const b = client('B', 'Hello', 'Hello')
await Promise.race([Promise.all([whenSynced(a.provider), whenSynced(b.provider)]), delay(6_000)])
check(a.provider.synced && b.provider.synced, 'both clients synced')

check(await eventually(() => a.host.acquired === 1 && b.host.acquired === 1), 'both editors bind on their own')
check(await eventually(() => b.text() === 'Hello world'), 'an unedited editor takes on the document', b.text())

a.type(' from A')
check(await eventually(() => b.text() === 'Hello world from A'), 'A -> B')
b.type('B: ', 0)
check(await eventually(() => a.text() === 'B: Hello world from A'), 'B -> A')

a.type('<A>')
b.type('<B>', 0)
check(await eventually(() => a.text() === b.text() && a.text().length === 'B: Hello world from A<A><B>'.length), 'concurrent edits converge')
check(a.text() === a.ytext.toString() && b.text() === b.ytext.toString(), 'editors match their Y.Text')

// Undo is for your own typing.
b.type('!')
await eventually(() => a.text().endsWith('!'))
a.type('?')
await eventually(() => b.text().endsWith('?'))
undo(b.view)
check(
  await eventually(() => a.text() === b.text() && b.text().endsWith('?') && !b.text().includes('!')),
  'undo takes back your own typing and leaves the other side alone',
  b.text()
)

// Obsidian reloading an unchanged file replaces the whole buffer with the
// same text. Taken literally that is "delete everything, insert everything",
// and two devices doing it at once doubled the note on every round trip.
{
  let updates = 0
  const count = (): void => {
    updates += 1
  }
  a.doc.on('update', count)
  const before = a.text()
  for (let i = 0; i < 5; i += 1) {
    a.view.dispatch({ changes: { from: 0, to: a.view.state.doc.length, insert: before } })
    b.view.dispatch({ changes: { from: 0, to: b.view.state.doc.length, insert: b.text() } })
  }
  await delay(600)
  a.doc.off('update', count)
  check(updates === 0, 'replacing the buffer with identical text changes nothing', updates)
  check(a.text() === before && b.text() === before, 'and nothing grows', { a: a.text(), b: b.text() })
}

// A wholesale replacement that does change something becomes that change
// alone. Taken literally it re-inserts every character, which undoes what
// the other side deleted at the same moment.
{
  const long = `${'word '.repeat(80)}end`
  a.view.dispatch({ changes: { from: 0, to: a.view.state.doc.length, insert: long }, userEvent: 'input.paste' })
  await eventually(() => b.text() === long)
  const changed = long.replace('word word word end', 'word WORD word end')
  a.view.dispatch({ changes: { from: 0, to: a.view.state.doc.length, insert: changed } })
  b.view.dispatch({ changes: { from: 0, to: 5 }, userEvent: 'delete' })
  check(
    await eventually(() => a.text() === b.text() && a.text() === changed.slice(5)),
    'a wholesale replacement keeps what the other side deleted at the same moment',
    { a: a.text().slice(0, 30), b: b.text().slice(0, 30), length: a.text().length, expected: changed.length - 5 }
  )
}

// Obsidian reloading, into an editor bound in the meantime, a file this
// device wrote before the binding started. The document has moved on.
{
  const current = a.text()
  a.host.recent = current.slice(0, -4)
  a.view.dispatch({ changes: { from: 0, to: a.view.state.doc.length, insert: a.host.recent } })
  check(
    await eventually(() => a.text() === current && a.ytext.toString() === current),
    'reloading our own earlier write does not revert the document',
    { editor: a.text().slice(-20), doc: a.ytext.toString().slice(-20) }
  )
  a.host.recent = null
}

// Obsidian puts another note into the editor without rebuilding the state.
{
  const shared = a.ytext.toString()
  const other: NoteRef = { path: 'Other.md' }
  a.view.dispatch({
    changes: { from: 0, to: a.view.state.doc.length, insert: 'a different note' },
    effects: showNote.of(other)
  })
  a.view.dispatch({ changes: { from: 0, insert: 'typed in the other note ' }, userEvent: 'input.type' })
  await delay(500)
  check(a.ytext.toString() === shared && b.text() === shared, 'the next note does not leak into this one')
  check(a.host.releases === 1, 'and the binding let go of the document')

  // Back to the note, as Obsidian does on a file switch: a fresh state, with
  // what is on disk.
  a.view.setState(
    EditorState.create({
      doc: shared,
      extensions: [noteField.init(() => a.note), history(), editorSyncExtension(a.host, noteOf)]
    })
  )
  check(await eventually(() => a.host.acquired === 2), 'switching back binds again')
  a.type(' back')
  check(await eventually(() => b.text() === `${shared} back`), 'and typing reaches the other side', b.text().slice(-20))
}

// Edits made before the binding started are merged, not dropped.
{
  const shared = b.ytext.toString()
  const c = client('C', `${shared}\nwritten before binding`, shared)
  await Promise.race([whenSynced(c.provider), delay(6_000)])
  check(
    await eventually(() => b.text() === `${shared}\nwritten before binding` && c.text() === b.text()),
    'text typed before the binding started reaches the document once',
    { b: b.text().slice(-40), c: c.text().slice(-40) }
  )
  c.view.destroy()
  check(c.host.releases === 1, 'destroying the editor releases the document')
  c.provider.destroy()
}

a.provider.destroy()
b.provider.destroy()

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
