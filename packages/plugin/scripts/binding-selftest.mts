// End-to-end check of the editor integration against a running server, in jsdom.
//
// `ws-selftest.mjs` only proves the server relays Yjs updates. This one drives
// the real MainEditorCollabAdapter, which is where live sharing actually broke:
// a view plugin that throws during construction is silently deactivated by
// CodeMirror, so attaching "succeeds" while typing never reaches Yjs.
//
//   npm run start:server
//   npm run test:sync -w @obsidian-connect/plugin -- ws://localhost:1234
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
const Y = await import('yjs')
const { WebsocketProvider } = await import('y-websocket')
const { WebSocket } = await import('ws')
const { MainEditorCollabAdapter } = await import('../src/editor/MainEditorCollabAdapter.js')

const serverUrl = process.argv[2] ?? process.env.OBSIDIAN_CONNECT_URL ?? 'ws://localhost:1234'
const room = `binding-selftest-${Date.now().toString(36)}`
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const failures: string[] = []
function check(ok: boolean, label: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`)
  if (!ok) failures.push(label)
}

function makeClient(label: string, editorText: string) {
  const doc = new Y.Doc()
  const ytext = doc.getText('content')
  // BroadcastChannel would sync these clients inside this process and hide a
  // broken server, so the test forces everything through the WebSocket. The
  // polyfill is explicit because Node only exposes a global WebSocket from v22
  // on, and `engines` allows Node 20.
  const provider = new WebsocketProvider(serverUrl, room, doc, {
    connect: true,
    disableBc: true,
    WebSocketPolyfill: WebSocket
  })
  const view = new EditorView({
    state: EditorState.create({ doc: editorText }),
    parent: dom.window.document.body
  })
  // Stands in for "the note is open in a Markdown leaf". Setting it to false is
  // how the test closes the note without destroying the editor.
  let noteIsOpen = true
  const adapter = new MainEditorCollabAdapter(
    () => (noteIsOpen ? view : null),
    ytext,
    provider.awareness
  )
  return {
    label,
    doc,
    ytext,
    provider,
    view,
    adapter,
    text: (): string => view.state.doc.toString(),
    setNoteOpen: (open: boolean): void => {
      noteIsOpen = open
    },
    // Obsidian throws the EditorState away on a file switch or an edit/preview
    // mode change, which takes every appendConfig extension with it.
    simulateObsidianRebuild: (fileText: string): void => {
      view.setState(EditorState.create({ doc: fileText }))
    }
  }
}

type Client = ReturnType<typeof makeClient>

function attach(client: Client): void {
  client.adapter.attach()
  check(client.adapter.ensureAttached() === false, `${client.label}: binding plugin is live`)
}

function whenSynced(provider: InstanceType<typeof WebsocketProvider>): Promise<void> {
  if (provider.synced) return Promise.resolve()
  return new Promise((resolve) => provider.once('sync', () => resolve()))
}

console.log(`server=${serverUrl} room=${room}`)

// The editors start on content that differs from the room. That is the normal
// case whenever a room already holds state, and it used to kill the binding.
const a = makeClient('A', 'local content that differs from the room')
const b = makeClient('B', 'local content that differs from the room')

await Promise.race([Promise.all([whenSynced(a.provider), whenSynced(b.provider)]), delay(6_000)])
check(a.provider.synced && b.provider.synced, 'both clients synced')

a.doc.transact(() => a.ytext.insert(0, 'Hello world'))
await delay(500)

attach(a)
attach(b)
await delay(300)
check(a.text() === 'Hello world', 'A reconciled to the room content')
check(b.text() === 'Hello world', 'B reconciled to the room content')

a.view.dispatch({ changes: { from: a.view.state.doc.length, insert: ' from A' } })
await delay(1_000)
check(b.text() === a.text(), 'A -> B propagates')

b.view.dispatch({ changes: { from: 0, insert: 'B: ' } })
await delay(1_000)
check(a.text() === b.text(), 'B -> A propagates')

a.view.dispatch({ changes: { from: a.view.state.doc.length, insert: '<A>' } })
b.view.dispatch({ changes: { from: 0, insert: '<B>' } })
await delay(1_500)
check(a.text() === b.text(), 'concurrent edits converge')
check(a.text() === a.ytext.toString() && b.text() === b.ytext.toString(), 'editors match their Y.Text')

a.view.dispatch({ changes: { from: 3, to: 9 } })
await delay(1_000)
check(a.text() === b.text(), 'deletions propagate')

// Obsidian reloads an open buffer when it thinks the file changed, replacing
// the whole document even when the text is identical. Treated as a user edit
// that is "delete everything, insert everything", and two devices doing it
// concurrently keep both insertions - the text doubled on every round trip
// until the note was unusable.
{
  let updates = 0
  const count = (): void => {
    updates += 1
  }
  a.doc.on('update', count)
  const before = a.text()
  a.view.dispatch({ changes: { from: 0, to: a.view.state.doc.length, insert: before } })
  await delay(800)
  a.doc.off('update', count)

  check(updates === 0, 'replacing the buffer with identical text emits no update', updates)
  check(a.text() === before, 'and leaves the document untouched')
  check(b.text() === before, 'and does not reach the other client', b.text())
}

// The same replacement repeated must not accumulate either.
{
  const before = a.text()
  for (let i = 0; i < 5; i += 1) {
    a.view.dispatch({ changes: { from: 0, to: a.view.state.doc.length, insert: before } })
    b.view.dispatch({ changes: { from: 0, to: b.view.state.doc.length, insert: before } })
  }
  await delay(1_200)
  check(a.text() === before && b.text() === before, 'repeated no-op replacements do not grow the text', {
    a: a.text().length,
    b: b.text().length,
    expected: before.length
  })
}

// --- Obsidian rebuilding the editor state -----------------------------------
const beforeRebuild = a.text()
a.simulateObsidianRebuild('whatever is on disk')
check(a.text() === 'whatever is on disk', 'rebuild replaced the editor state')

a.view.dispatch({ changes: { from: a.view.state.doc.length, insert: ' typed while detached' } })
await delay(800)
check(b.text() === beforeRebuild, 'a detached editor does not corrupt the room')

check(a.adapter.ensureAttached() === true, 'ensureAttached re-installs after a rebuild')
await delay(500)
check(a.text() === beforeRebuild, 'A is back on the room content after re-attach')
check(a.adapter.ensureAttached() === false, 'a healthy adapter is not re-installed')

a.view.dispatch({ changes: { from: a.view.state.doc.length, insert: ' after re-attach' } })
await delay(1_000)
check(b.text() === a.text(), 'A -> B propagates again after re-attach')

// --- The note is closed while the session keeps running ----------------------
const beforeClose = b.text()
a.setNoteOpen(false)
a.view.dispatch({ changes: { from: 0, insert: 'NOT MY NOTE ' } })
await delay(800)
check(b.text() === beforeClose, 'edits in a closed note are not pushed to the room')
check(a.adapter.ensureAttached() === false, 'a closed note is not re-attached')

a.setNoteOpen(true)
check(a.adapter.ensureAttached() === false, 'reopening keeps the still-live extension')

// --- Rejoining a room that has to come back from disk ------------------------
const finalText = b.text()
a.provider.destroy()
b.provider.destroy()
await delay(500)

const c = makeClient('C', 'stale local content')
await Promise.race([whenSynced(c.provider), delay(6_000)])
await delay(500)
attach(c)
await delay(300)
check(c.text() === finalText, 'a rejoining client gets the persisted room state')
c.provider.destroy()

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
