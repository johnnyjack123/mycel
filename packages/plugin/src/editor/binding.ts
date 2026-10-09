import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import {
  Annotation,
  Compartment,
  EditorState,
  StateEffect,
  Transaction,
  type Extension,
  type Range
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate
} from '@codemirror/view'
import { applyTextEdits, textEdits, type CollabUser, type TextEdit } from '@obsidian-connect/shared'
import { EDITOR_ORIGIN } from '../sync/origin.js'
import { log } from '../log.js'

// Keeps one Obsidian editor and one note's Y.Text identical, keystroke by
// keystroke. Installed into every Markdown editor through
// `registerEditorExtension`, so Obsidian itself carries it across file
// switches and mode changes - adding it to a live editor by hand was dropped
// on every such rebuild, and re-adding it mid-layout crashed CodeMirror.

/** Marks transactions that carry the document into the editor. */
export const remoteUpdate = Annotation.define<boolean>()

const refreshCursors = StateEffect.define<null>()

// One compartment for every editor: each state keeps its own content in it.
const readOnlyCompartment = new Compartment()
const READ_ONLY: Extension = [EditorState.readOnly.of(true), EditorView.editable.of(false)]

/** The note an editor shows. Compared by identity: it survives a rename. */
export interface NoteRef {
  readonly path: string
}

export interface EditorSession {
  readonly ytext: Y.Text
  /** Present only while the note is shared with other people. */
  readonly awareness: Awareness | null
  /** Someone else's note, shared to read: the editor must not take edits. */
  readonly readOnly: boolean
  /**
   * True when the editor could show `text` without anyone having typed in it:
   * it is what file and document last agreed on, or what this device wrote to
   * the file moments ago.
   */
  isUnedited(text: string): boolean
  /** What this device wrote to the file within the last few seconds, if anything. */
  recentWrite(): string | null
  /**
   * The text editor and document should both take on when the editor holds
   * edits the document does not - typed while the note was still settling.
   * Takes backups of whatever the result leaves out.
   */
  resolve(editorText: string, sharedText: string): Promise<string>
  /** True once the session no longer matches the store: restarted, unshared, deleted. */
  isStale(): boolean
  release(): void
}

export interface EditorSyncHost {
  acquire(note: NoteRef, binding: EditorBinding): Promise<EditorSession | null>
  attached(binding: EditorBinding): void
  detached(binding: EditorBinding): void
}

export type NoteResolver = (state: EditorState) => NoteRef | null

interface Change {
  from: number
  to?: number
  insert?: string
}

interface AwarenessCursor {
  anchor: Y.RelativePosition
  head: Y.RelativePosition
}

// Changes larger than this are compared against the document instead of being
// replayed position by position. Obsidian reloading a file replaces the whole
// buffer, and taken literally that is "delete everything, insert everything":
// two devices doing it at once keep both insertions.
const WHOLESALE_CHARS = 256
const ALIGN_ATTEMPTS = 5
// After an editor could not be aligned, because it or the document kept
// changing, give it a moment instead of retrying on every refresh.
const ALIGN_COOLDOWN_MS = 1_000

function toChanges(edits: TextEdit[]): Change[] {
  return edits.map((edit) => ({ from: edit.from, to: edit.to, insert: edit.insert }))
}

/**
 * A Y.Text delta as CodeMirror changes. CodeMirror reads every change in an
 * array against the text *before* the transaction, so the position advances
 * over retained and deleted text but not over inserted text. Counting
 * insertions instead - the order you would apply them in one by one - shifted
 * every later part of a multi-part change by the inserted length, and since
 * the length still matched, nothing noticed that editor and document had
 * parted ways.
 */
export function deltaToChanges(delta: Y.YTextEvent['delta']): Change[] {
  const changes: Change[] = []
  let position = 0
  for (const op of delta) {
    if (op.retain !== undefined) {
      position += op.retain
    } else if (op.insert !== undefined) {
      changes.push({ from: position, insert: typeof op.insert === 'string' ? op.insert : '' })
    } else if (op.delete !== undefined) {
      changes.push({ from: position, to: position + op.delete })
      position += op.delete
    }
  }
  return changes
}

class CaretWidget extends WidgetType {
  constructor(private readonly user: CollabUser) {
    super()
  }

  eq(other: CaretWidget): boolean {
    return other.user.name === this.user.name && other.user.color === this.user.color
  }

  toDOM(): HTMLElement {
    const caret = document.createElement('span')
    caret.className = 'connect-remote-caret'
    caret.style.borderColor = this.user.color
    const label = document.createElement('span')
    label.className = 'connect-remote-caret-label'
    label.style.backgroundColor = this.user.color
    label.textContent = this.user.name
    caret.appendChild(label)
    return caret
  }

  ignoreEvent(): boolean {
    return true
  }
}

export class EditorBinding implements PluginValue {
  decorations: DecorationSet = Decoration.none
  private note: NoteRef | null
  private session: EditorSession | null = null
  private connecting = false
  private destroyed = false
  private applyingRemote = false
  private cooldown: ReturnType<typeof setTimeout> | null = null
  /**
   * The view names a note whose text has not reached the buffer yet. Obsidian
   * reports the new file before it has read it, so for a moment the buffer
   * still holds the previous note - and binding then took that text for
   * edits to the new one.
   */
  private contentPending = false

  private readonly observer = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
    if (transaction.origin === EDITOR_ORIGIN) return
    this.applyRemote(event)
  }

  /** Bumped whenever someone else's caret changed; the carets drawn are of `drawnCursors`. */
  private cursorsVersion = 0
  private drawnCursors = -1
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  /** The caret last announced, so an unchanged one is not sent again. */
  private published = ''

  private readonly onAwarenessChange = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ): void => {
    const awareness = this.session?.awareness
    if (!awareness) return
    const others = changes.added
      .concat(changes.updated, changes.removed)
      .some((client) => client !== awareness.clientID)
    if (!others && origin !== 'unshare') return
    this.cursorsVersion += 1
    this.scheduleCursorRefresh()
  }

  /**
   * Redraws the carets soon. Awareness changes arrive from the socket, but also
   * from our own update handler, where a dispatch would be one inside an
   * update; later, and again if the editor was busy. Any update in between
   * draws them too - the version tells it they are stale.
   */
  private scheduleCursorRefresh(delay = 0): void {
    if (this.refreshTimer !== null) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      if (this.destroyed || !this.view.dom.isConnected || this.drawnCursors === this.cursorsVersion) return
      try {
        this.view.dispatch({ effects: refreshCursors.of(null) })
      } catch (error) {
        log.warn('redrawing the carets failed; trying again', error)
        this.scheduleCursorRefresh(50)
      }
    }, delay)
  }

  constructor(
    readonly view: EditorView,
    private readonly host: EditorSyncHost,
    private readonly noteOf: NoteResolver
  ) {
    this.note = noteOf(view.state)
    host.attached(this)
    // Never dispatch from here. CodeMirror constructs view plugins inside the
    // update that installs them, rejects a nested dispatch, and answers the
    // exception by deactivating the plugin for good - the editor then ignores
    // every keystroke while reporting success.
    queueMicrotask(() => this.refresh())
  }

  get isBound(): boolean {
    return this.session !== null
  }

  get isAlive(): boolean {
    return !this.destroyed
  }

  get shownNote(): NoteRef | null {
    return this.note
  }

  /** Binds if possible, and rebinds a session the store has moved past. */
  refresh(): void {
    if (this.destroyed) return
    if (this.session?.isStale()) this.unbind()
    if (!this.session && this.cooldown === null) void this.connect()
  }

  update(update: ViewUpdate): void {
    const loaded =
      update.docChanged && !update.transactions.some((transaction) => transaction.annotation(remoteUpdate))
    const note = this.noteOf(update.state)
    if (note !== this.note) {
      // Obsidian put another note into this editor without rebuilding its
      // state. Whatever changed the text belongs to the new note, not to the
      // document this binding was carrying.
      this.unbind()
      this.note = note
      this.contentPending = !loaded
      queueMicrotask(() => this.refresh())
      return
    }
    if (this.contentPending && loaded) {
      // The new note's text has arrived.
      this.contentPending = false
      this.endCooldown()
      queueMicrotask(() => this.refresh())
    }

    const session = this.session
    if (!session) return

    const local =
      update.docChanged &&
      !this.applyingRemote &&
      !update.transactions.some((transaction) => transaction.annotation(remoteUpdate))
    if (local) this.applyLocalChanges(update, session)

    if (session.awareness) {
      if (update.docChanged || this.drawnCursors !== this.cursorsVersion) this.drawCursors(session)
      // Remote changes move the caret only in absolute terms; its relative
      // position is still right, so there is nothing new to announce.
      if (update.selectionSet || local || update.focusChanged) this.publishSelection(session)
    }
  }

  destroy(): void {
    this.destroyed = true
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    this.endCooldown()
    this.unbind()
    this.host.detached(this)
  }

  private endCooldown(): void {
    if (this.cooldown !== null) clearTimeout(this.cooldown)
    this.cooldown = null
  }

  unbind(): void {
    const session = this.session
    if (!session) return
    this.session = null
    session.ytext.unobserve(this.observer)
    if (session.awareness) {
      session.awareness.off('change', this.onAwarenessChange)
      session.awareness.setLocalStateField('cursor', null)
    }
    this.published = ''
    this.decorations = Decoration.none
    if (session.readOnly) this.setReadOnly(false)
    session.release()
  }

  /** Later, not now: unbinding happens inside updates too, where no dispatch may. */
  private setReadOnly(readOnly: boolean): void {
    queueMicrotask(() => {
      if (this.destroyed || !this.view.dom.isConnected) return
      this.view.dispatch({ effects: readOnlyCompartment.reconfigure(readOnly ? READ_ONLY : []) })
    })
  }

  private async connect(): Promise<void> {
    const note = this.note
    if (this.destroyed || this.session || this.connecting || !note) return
    this.connecting = true
    try {
      const session = await this.host.acquire(note, this)
      if (!session) return
      if (this.destroyed || this.note !== note || this.noteOf(this.view.state) !== note) {
        session.release()
        return
      }
      if (!(await this.align(session))) {
        this.cooldown = setTimeout(() => {
          this.cooldown = null
          this.refresh()
        }, ALIGN_COOLDOWN_MS)
        session.release()
        return
      }
      this.session = session
      session.ytext.observe(this.observer)
      if (session.readOnly) this.setReadOnly(true)
      if (session.awareness) {
        session.awareness.on('change', this.onAwarenessChange)
        this.publishSelection(session)
        this.cursorsVersion += 1
        this.view.dispatch({ effects: refreshCursors.of(null) })
      }
    } catch (error) {
      log.error('binding the editor failed', error)
    } finally {
      this.connecting = false
    }
  }

  /**
   * Makes editor and document identical before the binding starts replaying
   * changes between them, which only works while they are.
   */
  private async align(session: EditorSession): Promise<boolean> {
    for (let attempt = 0; attempt < ALIGN_ATTEMPTS; attempt += 1) {
      const editorText = this.view.state.doc.toString()
      const sharedText = session.ytext.toString()
      const unedited = editorText === sharedText || session.isUnedited(editorText)
      // Until the note's own text has arrived, whatever differs is the
      // previous note's, not an edit to this one. Try again once it is in.
      if (!unedited && this.contentPending) return false
      const target = unedited ? sharedText : await session.resolve(editorText, sharedText)
      if (this.destroyed || this.noteOf(this.view.state) !== this.note) return false
      // Someone typed, or the document moved, while that was being worked
      // out. The result would be applied to texts it was not computed for.
      if (this.view.state.doc.toString() !== editorText || session.ytext.toString() !== sharedText) continue

      if (target !== sharedText) {
        const doc = session.ytext.doc
        doc?.transact(() => applyTextEdits(session.ytext, textEdits(sharedText, target)), EDITOR_ORIGIN)
      }
      if (target !== editorText) this.dispatchRemote(toChanges(textEdits(editorText, target)))
      this.contentPending = false
      return true
    }
    log.warn('the editor kept changing while it was being bound; retrying later')
    return false
  }

  private dispatchRemote(changes: Change[]): void {
    if (changes.length === 0) return
    this.applyingRemote = true
    try {
      this.view.dispatch({
        changes,
        // Undo is for your own typing. Remote changes in the history let
        // Ctrl+Z take back what somebody else wrote.
        annotations: [remoteUpdate.of(true), Transaction.addToHistory.of(false)]
      })
    } finally {
      this.applyingRemote = false
    }
  }

  private realign(): void {
    const session = this.session
    if (!session || this.destroyed) return
    const current = this.view.state.doc.toString()
    const next = session.ytext.toString()
    if (current !== next) this.dispatchRemote(toChanges(textEdits(current, next)))
  }

  private applyRemote(event: Y.YTextEvent): void {
    const changes = deltaToChanges(event.delta)
    try {
      this.dispatchRemote(changes)
    } catch (error) {
      // The delta is relative to a Y.Text state the editor may have drifted
      // from. Recovering the whole text is always correct, just coarser.
      log.error('applying a remote delta failed, resyncing', error)
      this.realign()
      return
    }
    if (this.view.state.doc.length !== event.target.length) this.realign()
  }

  private applyLocalChanges(update: ViewUpdate, session: EditorSession): void {
    const ytext = session.ytext
    const doc = ytext.doc
    if (!doc) return
    const after = update.state.doc

    // Obsidian replaces the whole buffer when it reloads a file, even when the
    // text is identical. Only the length check runs on a normal keystroke; the
    // full compare happens exactly when the change might be a no-op.
    if (after.length === ytext.length && after.toString() === ytext.toString()) return

    // A note shared to read: whatever changed the buffer - a plugin, a
    // reload - does not get into a document the server would refuse it for.
    if (session.readOnly) {
      queueMicrotask(() => this.realign())
      return
    }

    // Obsidian reloading a file this device wrote shortly before the editor
    // was bound. The document has moved on since; taking the reload as an
    // edit would revert that.
    const written = session.recentWrite()
    if (written !== null && written.length === after.length && after.toString() === written) {
      queueMicrotask(() => this.realign())
      return
    }

    let deleted = 0
    update.changes.iterChangedRanges((fromA, toA) => {
      deleted += toA - fromA
    })
    const before = update.startState.doc
    const drifted = before.length !== ytext.length
    const wholesale = deleted > WHOLESALE_CHARS && deleted * 2 >= before.length
    if (drifted || wholesale) {
      const current = ytext.toString()
      const next = after.toString()
      doc.transact(() => applyTextEdits(ytext, textEdits(current, next)), EDITOR_ORIGIN)
      return
    }

    let offset = 0
    doc.transact(() => {
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        const from = fromA + offset
        const removed = toA - fromA
        if (removed > 0) ytext.delete(from, removed)
        const text = inserted.toString()
        if (text.length > 0) ytext.insert(from, text)
        offset += text.length - removed
      })
    }, EDITOR_ORIGIN)
  }

  /**
   * Never throws: an exception out of `update` makes CodeMirror switch this
   * plugin off for good, and with it the whole binding.
   */
  private publishSelection(session: EditorSession): void {
    try {
      this.announceSelection(session)
    } catch (error) {
      log.error('announcing the caret failed', error)
    }
  }

  private drawCursors(session: EditorSession): void {
    this.drawnCursors = this.cursorsVersion
    try {
      this.decorations = this.buildCursors(session)
    } catch (error) {
      // A caret from another client that cannot be placed; the others still are.
      log.error('drawing the carets failed', error)
      this.decorations = Decoration.none
    }
  }

  private announceSelection(session: EditorSession): void {
    const awareness = session.awareness
    if (!awareness || !session.ytext.doc) return
    const range = this.view.state.selection.main
    // Keyed by the text around it too: the same offsets after an edit are another place.
    const key = `${range.anchor}:${range.head}:${session.ytext.length}`
    if (key === this.published) return
    this.published = key
    log.debug(`caret announced at ${range.head}`)
    // The editor can be ahead of Y.Text while an update is still settling;
    // an out-of-range index would throw out of the update handler.
    const limit = session.ytext.length
    // Anchored the way CodeMirror moves your own selection: a caret stays in
    // front of text someone inserts exactly at it, and a selection does not
    // grow at its edges. Tied to the character on its right instead, the
    // caret the others saw ran ahead of whatever they typed at it - somewhere
    // it never was on your own screen.
    const assoc = (position: number): number => (!range.empty && position === range.from ? 0 : -1)
    const relative = (position: number): Y.RelativePosition =>
      Y.createRelativePositionFromTypeIndex(session.ytext, Math.min(position, limit), assoc(position))
    awareness.setLocalStateField('cursor', { anchor: relative(range.anchor), head: relative(range.head) })
  }

  private buildCursors(session: EditorSession): DecorationSet {
    const awareness = session.awareness
    const ydoc = session.ytext.doc
    if (!awareness || !ydoc) return Decoration.none
    const length = this.view.state.doc.length
    const toIndex = (position: Y.RelativePosition): number | null => {
      const absolute = Y.createAbsolutePositionFromRelativePosition(position, ydoc)
      if (!absolute || absolute.type !== session.ytext) return null
      return Math.min(absolute.index, length)
    }

    const ranges: Range<ReturnType<typeof Decoration.mark>>[] = []
    const me = (awareness.getLocalState()?.user as CollabUser | undefined)?.id
    awareness.getStates().forEach((state, clientId) => {
      if (clientId === awareness.clientID) return
      const cursor = state.cursor as AwarenessCursor | null | undefined
      const user = state.user as CollabUser | undefined
      // The same account on another device: presence is for the others.
      if (!cursor || !user || user.id === me) return
      const anchor = toIndex(cursor.anchor)
      const head = toIndex(cursor.head)
      if (anchor === null || head === null) return
      const from = Math.min(anchor, head)
      const to = Math.max(anchor, head)
      if (from !== to) {
        ranges.push(
          Decoration.mark({
            class: 'connect-remote-selection',
            attributes: { style: `background-color: ${user.colorLight}` }
          }).range(from, to)
        )
      }
      ranges.push(Decoration.widget({ widget: new CaretWidget(user), side: 1 }).range(head))
    })
    log.debug(`carets drawn: ${ranges.filter((range) => range.value.spec.widget).length} of ${awareness.getStates().size - 1} other(s)`)
    return Decoration.set(ranges, true)
  }
}

/** The editor extension: one binding per Markdown editor Obsidian creates. */
export function editorSyncExtension(host: EditorSyncHost, noteOf: NoteResolver): Extension {
  return [
    readOnlyCompartment.of([]),
    ViewPlugin.define((view) => new EditorBinding(view, host, noteOf), {
      decorations: (binding) => binding.decorations
    })
  ]
}
