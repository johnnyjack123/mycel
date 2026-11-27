// The editor binding on its own, in real CodeMirror editors in jsdom, with
// two documents kept in sync through a relay that delays every update a
// little, like a network. `test:vault` covers the binding together with the
// store and the real server; this one pins down the details of keeping an
// editor and a Y.Text identical.
//
//   npm run test:sync
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
const { EditorState } = await import('@codemirror/state')
const { EditorView } = await import('@codemirror/view')
const { history, undo } = await import('@codemirror/commands')
const Y = await import('yjs')
const { deltaToChanges, editorSyncExtension } = await import('../src/editor/binding.js')
const { reconcile } = await import('../src/sync/Reconciler.js')
const { noteField, noteOf, showNote } = await import('./stubs/fake-vault.js')
const { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } = await import('y-protocols/awareness')

type Binding = import('../src/editor/binding.js').EditorBinding
type Session = import('../src/editor/binding.js').EditorSession
type NoteRef = import('../src/editor/binding.js').NoteRef
type YDoc = InstanceType<typeof Y.Doc>

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Stands in for the server: every update reaches the others a few
 * milliseconds later, so edits on both sides are truly concurrent.
 */
class Relay {
  readonly state = new Y.Doc()
  private readonly members = new Set<YDoc>()
  /** How long an update takes to reach the others. */
  delayMs = 5

  join(doc: YDoc): Promise<void> {
    this.members.add(doc)
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this) return
      setTimeout(() => {
        Y.applyUpdate(this.state, update, this)
        for (const other of this.members) if (other !== doc) Y.applyUpdate(other, update, this)
      }, this.delayMs)
    })
    return new Promise((resolve) =>
      setTimeout(() => {
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(this.state), this)
        resolve()
      }, 5)
    )
  }

  leave(doc: YDoc): void {
    this.members.delete(doc)
  }
}

const relay = new Relay()

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

// --- two editors through the relay ---------------------------------------------

class Host {
  releases = 0
  acquired = 0
  recent: string | null = null
  readOnly = false
  awareness: InstanceType<typeof Awareness> | null = null

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
      awareness: this.awareness,
      readOnly: this.readOnly,
      isUnedited: (text: string) => text === this.base || text === this.recent,
      recentWrite: () => this.recent,
      resolve: async (local: string, remote: string, released: string | null) => {
        const pristine = (this.ytext.doc?.store.clients.size ?? 0) === 0
        const outcome = reconcile({ base: released ?? this.base, local, remote, pristine })
        if (outcome.kind === 'merge') return outcome.text
        return outcome.kind === 'seed' || outcome.kind === 'adopt-local' ? local : remote
      },
      agreedText: () => this.ytext.toString(),
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
  const synced = relay.join(doc)
  const note: NoteRef = { path: `${label}.md` }
  const host = new Host(note, ytext, base, synced)
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
    synced,
    host,
    view,
    note,
    text: (): string => view.state.doc.toString(),
    type: (text: string, at = view.state.doc.length): void => {
      view.dispatch({ changes: { from: at, insert: text }, userEvent: 'input.type' })
    }
  }
}

// The binding only ever starts on a settled note, so the room holds the text
// before either editor binds.
relay.state.getText('content').insert(0, 'Hello world')

// A shows what the file said at the last agreement; B shows a copy nobody
// has typed in since an older agreement, which the document has moved past.
const a = client('A', 'Hello world', 'Hello world')
const b = client('B', 'Hello', 'Hello')
await Promise.all([a.synced, b.synced])
check(a.ytext.toString() === 'Hello world' && b.ytext.toString() === 'Hello world', 'both clients synced')

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
  await c.synced
  check(
    await eventually(() => b.text() === `${shared}\nwritten before binding` && c.text() === b.text()),
    'text typed before the binding started reaches the document once',
    { b: b.text().slice(-40), c: c.text().slice(-40) }
  )
  c.view.destroy()
  check(c.host.releases === 1, 'destroying the editor releases the document')
  relay.leave(c.doc)
}

// A note someone shared to read only.
{
  const shared = b.ytext.toString()
  const reader = client('R', shared, shared)
  reader.host.readOnly = true
  await reader.synced
  check(await eventually(() => reader.host.acquired === 1 && reader.view.state.readOnly), 'a read-only note binds, and the editor refuses input')
  reader.view.dispatch({ changes: { from: 0, insert: 'slipped in ' } })
  check(
    await eventually(() => reader.text() === shared) && reader.ytext.toString() === shared && b.text() === shared,
    'a change that gets into its buffer anyway is taken back, not sent'
  )
  b.type(' more')
  check(await eventually(() => reader.text() === `${shared} more`), 'while what the others write still arrives')
  relay.leave(reader.doc)
}

// Presence on a shared note: carets that only move, without anyone typing.
// Typing rebuilds the carets anyway, which is why that alone proved nothing.
{
  const shared = b.ytext.toString()
  const p = client('P', shared, shared)
  const q = client('Q', shared, shared)
  const presence = [p, q].map((side) => {
    const awareness = new Awareness(side.doc)
    awareness.setLocalStateField('user', { id: side.label, name: side.label, color: '#f00', colorLight: '#fcc' })
    side.host.awareness = awareness
    return awareness
  })
  // The socket's part: every update of one side reaches the other a moment later.
  let presenceDelayMs = 5
  presence.forEach((awareness, index) => {
    const other = presence[1 - index] as InstanceType<typeof Awareness>
    awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === 'relay') return
      const update = encodeAwarenessUpdate(awareness, added.concat(updated, removed))
      setTimeout(() => applyAwarenessUpdate(other, update, 'relay'), presenceDelayMs)
    })
  })
  await Promise.all([p.synced, q.synced])
  check(await eventually(() => p.host.acquired === 1 && q.host.acquired === 1), 'two editors of a shared note bind')
  const caretOn = (side: typeof p): number => {
    const caret = side.view.dom.querySelector('.mycel-remote-caret')
    return caret ? side.view.posAtDOM(caret) : -1
  }
  p.view.dispatch({ selection: { anchor: 3 } })
  check(await eventually(() => caretOn(q) === 3), "Q sees P's caret", caretOn(q))
  p.view.dispatch({ selection: { anchor: 9 } })
  check(await eventually(() => caretOn(q) === 9), "and follows it when P only moves it, typing nothing", caretOn(q))
  q.view.dispatch({ selection: { anchor: 5 } })
  check(await eventually(() => caretOn(p) === 5), "P sees Q's caret move too", caretOn(p))

  // Typing: the letters and the caret travel apart, either first. Drawn by its
  // anchor alone the caret sat in front of each new letter until the caret
  // came, or vanished until the letter did - a flicker on every keystroke.
  {
    const typeAt = (at: number, letter: string): void => {
      p.view.dispatch({ changes: { from: at, insert: letter }, selection: { anchor: at + 1 }, userEvent: 'input.type' })
    }
    check(await eventually(() => caretOn(q) === 9), "Q sees P's caret before P types")
    presenceDelayMs = 200
    typeAt(9, 'X')
    check(await eventually(() => q.text().slice(9, 10) === 'X'), 'the letter arrives before the caret')
    check(caretOn(q) === 10, "P's caret is behind the letter as soon as the letter is there", caretOn(q))
    await delay(250)
    presenceDelayMs = 5
    relay.delayMs = 200
    typeAt(10, 'Y')
    await delay(60)
    check(q.text().slice(10, 11) !== 'Y' && caretOn(q) === 10, "with the caret first, it stays where it was until the letter comes - it never vanishes", caretOn(q))
    check(await eventually(() => q.text().slice(10, 11) === 'Y' && caretOn(q) === 11), 'and is behind the letter once it came', caretOn(q))
    relay.delayMs = 5
  }
  for (const side of [p, q]) {
    side.view.destroy()
    relay.leave(side.doc)
  }
}

/// --- "Compare versions": both versions line beside line, the note put together passage by passage (0.9.23, 0.9.26) ---
{
  const obsidian = await import('obsidian')
  obsidian.installDomHelpers()
  const { Modal } = obsidian
  const { ReviewModal } = await import('../src/history/ReviewModal.js')
  const review = {
    id: 'r1',
    docId: 'd1',
    path: 'Einkauf.md',
    at: Date.now(),
    kind: 'no-base' as const,
    mine: '# Einkauf\n- Milch\n- Eier\nend\n',
    theirs: '# Einkauf\n- Brot\nend\n',
    merged: '# Einkauf\n- Brot\n- Milch\n- Eier\nend\n'
  }
  const opened = (applied: string[], dismissed: string[]): InstanceType<typeof ReviewModal> => {
    const modal = new ReviewModal(
      {} as never,
      review,
      async (text) => {
        applied.push(text)
        return 'applied'
      },
      async () => {
        dismissed.push(review.id)
      }
    )
    modal.open()
    return modal
  }
  const passages = (modal: InstanceType<typeof ReviewModal>): HTMLElement[] => Array.from(modal.contentEl.querySelectorAll<HTMLElement>('.mycel-merge-passage'))
  const button = (root: HTMLElement, text: string): HTMLButtonElement | undefined =>
    Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((each) => each.textContent?.trim() === text)
  const progress = (modal: InstanceType<typeof ReviewModal>): string => modal.contentEl.querySelector('.mycel-merge-progress')?.textContent ?? ''
  const texts = (root: Element, selector: string): string[] => Array.from(root.querySelectorAll(selector)).map((el) => el.textContent ?? '')

  const middleLines = (root: Element | undefined): string[] => (root ? texts(root, '.mycel-merge-item .mycel-merge-text') : [])

  // jsdom lays nothing out: every line and line of the middle gets a row of its own, 20 pixels
  // high, in the order it stands, and the window's hit test is told what lies under the pointer.
  let under: Element | null = null
  ;(document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => under
  const layOut = (root: Element): void => {
    Array.from(root.querySelectorAll<HTMLElement>('.mycel-merge-line, .mycel-merge-item, .mycel-merge-slot')).forEach((el, at) => {
      const top = at * 20
      el.getBoundingClientRect = () => ({ top, bottom: top + 20, left: 0, right: 100, width: 100, height: 20, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    })
  }
  const pointer = (type: string, target: EventTarget, y: number): void => {
    target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, clientX: 50, clientY: y, button: 0, pointerType: 'mouse' }))
  }
  /** Presses `from`, moves onto `onto` - its upper or lower half - and lets go there. */
  const dragTo = async (modal: InstanceType<typeof ReviewModal>, from: Element | null | undefined, onto: Element | null | undefined, half: 'upper' | 'lower' = 'upper', release = true): Promise<void> => {
    if (!from || !onto) throw new Error('nothing to drag, or nowhere to')
    layOut(modal.contentEl)
    const y = onto.getBoundingClientRect().top + (half === 'upper' ? 5 : 15)
    pointer('pointerdown', from, 0)
    under = onto
    pointer('pointermove', document, y)
    if (!release) return
    pointer('pointerup', document, y)
    // The click a release makes is swallowed until then.
    await delay(5)
  }

  const applied: string[] = []
  const dismissed: string[] = []
  const modal = opened(applied, dismissed)
  const rows = passages(modal)
  check(
    rows.length === 1 && rows[0]?.classList.contains('is-open') === true && rows[0]?.querySelector('.mycel-merge-placeholder') !== null && progress(modal) === '1 of 1 passage still open',
    'the window opens with each passage that differs empty in the middle',
    { rows: rows.length, progress: progress(modal) }
  )
  const same = modal.contentEl.querySelector('.mycel-merge-same') as HTMLElement
  check(
    texts(same, '.mycel-merge-line.is-mine .mycel-merge-text').join() === '# Einkauf' &&
      texts(same, '.mycel-merge-line.is-result .mycel-merge-text').join() === '# Einkauf' &&
      texts(same, '.mycel-merge-line.is-theirs .mycel-merge-text').join() === '# Einkauf',
    'a line both versions have stands in all three columns - this device, the result and the other version',
    texts(same, '.mycel-merge-line .mycel-merge-text')
  )
  const passage = rows[0] as HTMLElement
  check(
    texts(passage, '.mycel-merge-line.is-mine .mycel-merge-text').join('|') === '- Milch|- Eier' &&
      texts(passage, '.mycel-merge-line.is-theirs .mycel-merge-text').join('|') === '- Brot' &&
      passage.querySelectorAll('.mycel-merge-line.is-theirs.is-gap').length === 1 &&
      texts(passage, '.mycel-merge-line.is-mine .mycel-merge-num').join() === '2,3',
    'a passage shows each side whole with its line numbers, a gap where one side has fewer lines',
    { mine: texts(passage, '.mycel-merge-line.is-mine'), theirs: texts(passage, '.mycel-merge-line.is-theirs') }
  )
  const take = (side: 'mine' | 'theirs'): void => passages(modal)[0]?.querySelector<HTMLButtonElement>(`.mycel-merge-take-cell.is-${side} .mycel-merge-take`)?.click()
  take('theirs')
  take('mine')
  check(
    middleLines(passages(modal)[0]).join('|') === '- Brot|- Milch|- Eier' && !passages(modal)[0]?.classList.contains('is-open') && progress(modal) === 'All 1 passage decided',
    'Take brings each side into the middle, in the order taken, a line each',
    { middle: middleLines(passages(modal)[0]), progress: progress(modal) }
  )
  passages(modal)[0]?.querySelector<HTMLElement>('.mycel-merge-item .mycel-merge-text')?.click()
  const textarea = passages(modal)[0]?.querySelector('textarea')
  check(textarea?.value === '- Brot\n- Milch\n- Eier', 'clicked into, the middle becomes a field to write in, holding its lines', textarea?.value)
  if (textarea) {
    textarea.value = '- Brot\n- Milch\n- Hafermilch'
    textarea.dispatchEvent(new window.Event('input'))
    textarea.dispatchEvent(new window.FocusEvent('blur'))
  }
  check(
    middleLines(passages(modal)[0]).join('|') === '- Brot|- Milch|- Hafermilch' && passages(modal)[0]?.querySelector('.mycel-merge-item.is-typed .mycel-merge-text')?.textContent === '- Hafermilch',
    'left, it shows its lines again - the one written by hand marked as such',
    middleLines(passages(modal)[0])
  )
  button(modal.contentEl, 'Apply')?.click()
  await delay(20)
  check(applied.join() === '# Einkauf\n- Brot\n- Milch\n- Hafermilch\nend\n' && Modal.open.length === 0, 'what is written in the middle by hand is what Apply writes', applied)

  // Lines dragged by their number, from either side, to where they belong (0.9.32).
  const picked: string[] = []
  const lined = opened(picked, [])
  const number = (side: 'mine' | 'theirs', text: string): HTMLButtonElement | undefined =>
    Array.from(lined.contentEl.querySelectorAll<HTMLButtonElement>(`.mycel-merge-line.is-${side} .mycel-merge-num`)).find((each) => each.textContent === text)
  const hint = (modal: InstanceType<typeof ReviewModal>): string => modal.contentEl.querySelector('.mycel-merge-hint')?.textContent ?? ''
  number('theirs', '2')?.click()
  check(
    number('theirs', '2')?.closest('.mycel-merge-line')?.classList.contains('is-selected') === true &&
      middleLines(passages(lined)[0]).length === 0 &&
      hint(lined).includes('1 line of the other version selected'),
    "a line's number clicked selects the line - nothing goes into the middle yet",
    hint(lined)
  )
  number('theirs', '2')?.click()
  check(lined.contentEl.querySelectorAll('.is-selected').length === 0 && hint(lined) === '', 'clicked again, it is let go', hint(lined))
  await dragTo(lined, number('theirs', '2'), passages(lined)[0]?.querySelector('.mycel-merge-slot'))
  check(
    middleLines(passages(lined)[0]).join() === '- Brot' && progress(lined) === 'All 1 passage decided' && lined.contentEl.querySelector('.mycel-merge-ghost, .mycel-merge-drop') === null && document.querySelector('.mycel-merge-ghost') === null,
    'a number dragged into an empty middle brings its line there; nothing of the drag is left behind',
    middleLines(passages(lined)[0])
  )
  await dragTo(lined, number('mine', '3'), passages(lined)[0]?.querySelector('.mycel-merge-item'), 'upper')
  check(middleLines(passages(lined)[0]).join('|') === '- Eier|- Brot', "let go over a line's upper half, it goes before that line", middleLines(passages(lined)[0]))
  await dragTo(lined, number('mine', '2'), passages(lined)[0]?.querySelectorAll('.mycel-merge-item')[1], 'lower')
  check(
    middleLines(passages(lined)[0]).join('|') === '- Eier|- Brot|- Milch' && passages(lined)[0]?.querySelectorAll('.mycel-merge-line.is-picked').length === 3,
    'over its lower half, after it; every line in the middle is marked in its version',
    middleLines(passages(lined)[0])
  )
  // Lines of the middle, by their handle: moved, and out again.
  const grip = (modal: InstanceType<typeof ReviewModal>, text: string): HTMLButtonElement | null | undefined =>
    Array.from(modal.contentEl.querySelectorAll('.mycel-merge-item'))
      .find((item) => item.querySelector('.mycel-merge-text')?.textContent === text)
      ?.querySelector<HTMLButtonElement>('.mycel-merge-grip')
  await dragTo(lined, grip(lined, '- Eier'), passages(lined)[0]?.querySelectorAll('.mycel-merge-item')[2], 'lower')
  check(middleLines(passages(lined)[0]).join('|') === '- Brot|- Milch|- Eier', 'a line of the middle dragged by its handle moves', middleLines(passages(lined)[0]))
  await dragTo(lined, grip(lined, '- Milch'), number('mine', '2')?.closest('.mycel-merge-line'), 'upper', false)
  check(
    document.querySelector('.mycel-merge-ghost')?.textContent === 'Take out of the middle' && document.querySelector('.mycel-merge-ghost')?.classList.contains('is-removing') === true,
    'held over a version, it says it is taken out',
    document.querySelector('.mycel-merge-ghost')?.textContent
  )
  pointer('pointerup', document, 5)
  await delay(5)
  check(
    middleLines(passages(lined)[0]).join('|') === '- Brot|- Eier' && number('mine', '2')?.closest('.mycel-merge-line')?.classList.contains('is-picked') === false,
    'let go there, it is out of the middle and no longer marked in its version',
    middleLines(passages(lined)[0])
  )
  grip(lined, '- Eier')?.click()
  lined.contentEl.querySelector('.mycel-merge-list')?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
  check(middleLines(passages(lined)[0]).join('|') === '- Brot', 'a line of the middle selected, Delete takes it out', middleLines(passages(lined)[0]))
  await dragTo(lined, number('mine', '3'), passages(lined)[0]?.querySelector('.mycel-merge-item'), 'lower')

  // Copying from one side gives that side's lines alone, without numbers or the other columns.
  const passageEl = passages(lined)[0] as HTMLElement
  const mineTexts = Array.from(passageEl.querySelectorAll<HTMLElement>('.mycel-merge-line.is-mine .mycel-merge-text'))
  const from = mineTexts[0]?.firstChild
  const to = mineTexts[1]?.firstChild
  let copied: string | null = null
  if (from && to) {
    mineTexts[0]?.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
    const range = document.createRange()
    range.setStart(from, 2)
    range.setEnd(to, (to.textContent ?? '').length)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    const event = new window.Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: {
        setData: (_type: string, text: string) => {
          copied = text
        }
      }
    })
    mineTexts[0]?.dispatchEvent(event)
  }
  check(copied === 'Milch\n- Eier', 'copying a selection made in one version takes its text alone, line by line', copied)
  button(lined.contentEl, 'Apply')?.click()
  await delay(20)
  check(picked.join() === '# Einkauf\n- Brot\n- Eier\nend\n', 'and Apply writes the note so put together', picked)

  // Nothing taken: asked first, left out only when confirmed.
  const empty: string[] = []
  const second = opened(empty, [])
  button(second.contentEl, 'Apply')?.click()
  await delay(20)
  const asked = Modal.open.at(-1)
  check(
    asked !== undefined && asked !== second && (asked.titleEl.textContent ?? '').includes('1 passage is still empty') && empty.length === 0,
    'Apply with a passage still empty asks first',
    asked?.titleEl.textContent
  )
  if (asked) button(asked.contentEl, 'Stop')?.click()
  await delay(20)
  check(empty.length === 0 && Modal.open.at(-1) === second, 'Stop goes back to the window, nothing applied')
  button(second.contentEl, 'Apply')?.click()
  await delay(20)
  const again = Modal.open.at(-1)
  if (again && again !== second) button(again.contentEl, 'Apply anyway')?.click()
  await delay(20)
  check(empty.join() === '# Einkauf\nend\n', 'and "Apply anyway" leaves the empty passage out', empty)

  const done: string[] = []
  const third = opened([], done)
  button(third.contentEl, 'Done')?.click()
  await delay(20)
  check(done.join() === 'r1' && Modal.open.length === 0, 'Done takes the note off the list as it is')

  // The user's two blocks (2026-11-26), one under the other: this device's taken, the other's
  // lines 11 to 17 selected and dragged below this device's closing "---" (0.9.32).
  const head = 'Gleicher Stand\n\nAuf beiden Seiten:\n\n---\ncontent content\ncontent content\n\n---\n\n'
  const block = (device: string): string => `${device}:\n\n---\ncontent content ${device}\ncontent content ${device}\n\n---\n`
  const blocks = {
    ...review,
    id: 'r2',
    mine: `${head}${block('PC')}\ngleicher text, selbe Zeile\ngleicher Text, andere Zeile\n`,
    theirs: `${head}${block('Laptop')}\ngleicher text, selbe Zeile\n\ngleicher Text, andere Zeile\n`
  }
  const blockWindow = (applied: string[]): InstanceType<typeof ReviewModal> => {
    const modal = new ReviewModal({} as never, blocks, async (text) => {
      applied.push(text)
      return 'applied'
    }, async () => undefined)
    modal.open()
    return modal
  }
  /** The number of a line of a side, wherever it stands - in a passage or among the lines both have. */
  const numberOf = (modal: InstanceType<typeof ReviewModal>, side: 'mine' | 'theirs', line: number): HTMLButtonElement | undefined =>
    Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>(`.mycel-merge-line.is-${side} .mycel-merge-num`)).find((each) => each.textContent === String(line))
  /** The middle's copy of a line both have, by this device's number for it. */
  const sharedMiddle = (modal: InstanceType<typeof ReviewModal>, line: number): Element | null | undefined =>
    numberOf(modal, 'mine', line)?.closest('.mycel-merge-line')?.nextElementSibling
  const press = (el: HTMLElement | undefined, shiftKey = false): void => {
    el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, shiftKey }))
  }

  const stacked: string[] = []
  const board = blockWindow(stacked)
  check(passages(board).length === 3 && progress(board) === '3 of 3 passages still open', 'the two blocks stand as three passages', progress(board))
  passages(board)[0]?.querySelector<HTMLButtonElement>('.mycel-merge-take-cell.is-mine .mycel-merge-take')?.click()
  passages(board)[1]?.querySelector<HTMLButtonElement>('.mycel-merge-take-cell.is-mine .mycel-merge-take')?.click()
  press(numberOf(board, 'theirs', 11))
  press(numberOf(board, 'theirs', 17), true)
  check(
    board.contentEl.querySelectorAll('.mycel-merge-line.is-theirs.is-selected').length === 7 && hint(board).includes('7 lines of the other version selected'),
    'a number clicked and another Shift-clicked select every line between, the lines both have too',
    hint(board)
  )
  await dragTo(board, numberOf(board, 'theirs', 14), sharedMiddle(board, 17), 'lower', false)
  const marker = board.contentEl.querySelector<HTMLElement>('.mycel-merge-drop')
  check(
    document.querySelector('.mycel-merge-ghost')?.textContent === '7 lines' &&
      marker?.style.display === 'block' &&
      board.contentEl.querySelectorAll('.mycel-merge-line.is-theirs.is-dragging').length === 7,
    'dragging one of them carries all seven, a line drawn where they would go',
    { ghost: document.querySelector('.mycel-merge-ghost')?.textContent, marker: marker?.style.display }
  )
  pointer('pointerup', document, 0)
  await delay(5)
  const inserted = board.contentEl.querySelector('.mycel-merge-passage.is-inserted')
  check(
    passages(board).length === 4 &&
      middleLines(inserted ?? undefined).join('|') === block('Laptop').slice(0, -1).split('\n').join('|') &&
      inserted?.previousElementSibling?.classList.contains('mycel-merge-same') === true &&
      progress(board) === '1 of 3 passages still open' &&
      board.contentEl.querySelectorAll('.is-selected').length === 0,
    "let go after the closing \"---\", a place of their own opens there, with the other's whole block - no passage to decide",
    { middle: middleLines(inserted ?? undefined), progress: progress(board) }
  )
  passages(board)[3]?.querySelector<HTMLButtonElement>('.mycel-merge-take-cell.is-mine .mycel-merge-take')?.click()
  button(board.contentEl, 'Apply')?.click()
  await delay(20)
  check(
    stacked.join() === `${head}${block('PC')}${block('Laptop')}\ngleicher text, selbe Zeile\ngleicher Text, andere Zeile\n`,
    'Apply writes both blocks whole, one under the other',
    stacked
  )

  // A place opened goes again: emptied by the eraser, by dragging its lines out, by "Empty again".
  const undone = blockWindow([])
  await dragTo(undone, numberOf(undone, 'theirs', 11), sharedMiddle(undone, 17), 'lower')
  check(passages(undone).length === 4, 'a line dragged between lines both have opens a place', passages(undone).length)
  undone.contentEl.querySelector<HTMLButtonElement>('.mycel-merge-passage.is-inserted .mycel-merge-clear')?.click()
  check(passages(undone).length === 3 && progress(undone) === '3 of 3 passages still open', 'the eraser empties it, and it goes', progress(undone))
  // The lines both have at the top fold away but for the last few; shown, the first one is there.
  undone.contentEl.querySelector<HTMLButtonElement>('.mycel-merge-fold')?.click()
  await dragTo(undone, numberOf(undone, 'theirs', 11), sharedMiddle(undone, 1), 'upper')
  const top = undone.contentEl.querySelector('.mycel-merge-passage.is-inserted')
  check(
    top !== null && top.previousElementSibling?.classList.contains('mycel-merge-head') === true,
    'one let go over the upper half of the first line opens a place at the very top',
    top?.previousElementSibling?.className
  )
  await dragTo(undone, grip(undone, 'Laptop:'), passages(undone)[1]?.querySelector('.mycel-merge-slot'))
  check(
    passages(undone).length === 3 && middleLines(passages(undone)[0]).join() === 'Laptop:' && undone.contentEl.querySelector('.is-inserted') === null,
    'its last line dragged into a passage, the place goes',
    middleLines(passages(undone)[0])
  )
  await dragTo(undone, numberOf(undone, 'mine', 14), sharedMiddle(undone, 9), 'lower')
  check(passages(undone).length === 4, 'one let go between two lines both have opens a place there', passages(undone).length)
  button(undone.contentEl, 'Empty again')?.click()
  check(passages(undone).length === 3 && progress(undone) === '3 of 3 passages still open', '"Empty again" empties every passage and closes every place opened', progress(undone))
  undone.close()
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
