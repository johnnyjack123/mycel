import { EditorState, Prec, StateEffect, StateField, type Extension, type Range, type Transaction } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, showPanel, type DecorationSet, type Panel, type ViewUpdate } from '@codemirror/view'
import { lineDiff } from '@obsidian-connect/shared'

// A note showing its past is shown in its own editor (`docs/TIMEMACHINE.md`,
// W1): read-only, and with the changes against now marked in it - the lines
// there then and not now highlighted, the lines there now and not then struck
// through between them. The editor never writes: the past is in the file, and
// nothing of it may become an edit. A note that is locked - the Time Machine's
// on this device, another device's on this one - is read-only the same way,
// without marks (the third round), and says so in a bar at its top: the lock
// in the note's header alone went unnoticed (0.8.16).

/** What an editor shows of the past: the note's text now (null: not there now), and whether changes are marked. */
export interface PastShown {
  now: string | null
  marks: boolean
}

/** The bar at the top of a locked note's editor: why, and the way to lift another device's lock. */
export interface LockBanner {
  text: string
  unlock: (() => void) | null
}

export interface PastEditorHost {
  /** For a file the Time Machine shows the past in, what to mark; null for any other. */
  pastOf(path: string): Promise<PastShown | null>
  /** Why a file may not be edited now; null when it may. */
  lockedWhy(path: string): string | null
  /** The bar a locked file's editor shows; null for none. */
  banner?(path: string): LockBanner | null
  onChange(listener: () => void): () => void
}

export type PathOf = (state: EditorState) => { path: string } | null

interface Shown {
  past: PastShown | null
  locked: string | null
  banner: LockBanner | null
}

const setShown = StateEffect.define<Shown>()

/** Lines there now and not then, shown where they would come back. */
class GoneLines extends WidgetType {
  constructor(private readonly text: string) {
    super()
  }

  eq(other: GoneLines): boolean {
    return other.text === this.text
  }

  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'connect-tm-now-lines'
    el.setAttribute('aria-label', 'There now, not then')
    el.textContent = this.text.replace(/\n$/, '')
    return el
  }
}

function marksFor(now: string | null, then: string): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const lineStarts = (from: number, to: number): number[] => {
    const starts: number[] = []
    for (let at = from; at < to; ) {
      starts.push(at)
      const end = then.indexOf('\n', at)
      if (end < 0 || end + 1 >= to) break
      at = end + 1
    }
    return starts
  }
  const markThen = (from: number, to: number): void => {
    for (const start of lineStarts(from, to)) ranges.push(Decoration.line({ class: 'connect-tm-then-line' }).range(start))
  }
  if (now === null) {
    markThen(0, then.length)
  } else {
    for (const hunk of lineDiff(now, then)) {
      if (hunk.type === 'equal') continue
      if (hunk.aTo > hunk.aFrom) ranges.push(Decoration.widget({ widget: new GoneLines(now.slice(hunk.aFrom, hunk.aTo)), block: true, side: -1 }).range(hunk.bFrom))
      if (hunk.bTo > hunk.bFrom) markThen(hunk.bFrom, hunk.bTo)
    }
  }
  return Decoration.set(ranges, true)
}

const NOTHING: Shown = { past: null, locked: null, banner: null }

function readOnly(shown: Shown): boolean {
  return shown.past !== null || shown.locked !== null
}

// One panel per bar: a new constructor would make CodeMirror build the panel
// again on every change of the note, flickering under remote edits.
const panels = new WeakMap<LockBanner, () => Panel>()

function panelOf(banner: LockBanner): () => Panel {
  let make = panels.get(banner)
  if (!make) {
    make = () => {
      const dom = document.createElement('div')
      dom.className = 'connect-lock-banner'
      const text = document.createElement('span')
      text.className = 'connect-lock-banner-text'
      text.textContent = banner.text
      dom.append(text)
      if (banner.unlock) {
        const button = document.createElement('button')
        button.textContent = 'Unlock…'
        button.addEventListener('click', () => banner.unlock?.())
        dom.append(button)
      }
      return { dom, top: true }
    }
    panels.set(banner, make)
  }
  return make
}

const shownField = StateField.define<Shown & { deco: DecorationSet }>({
  create: () => ({ ...NOTHING, deco: Decoration.none }),
  update(value, transaction) {
    let shown: Shown = value
    let set = false
    for (const effect of transaction.effects) {
      if (effect.is(setShown)) {
        shown = effect.value
        set = true
      }
    }
    if (!set && !transaction.docChanged) return value
    return {
      past: shown.past,
      locked: shown.locked,
      banner: shown.banner,
      deco: shown.past?.marks ? marksFor(shown.past.now, transaction.state.doc.toString()) : Decoration.none
    }
  },
  provide: (field) => [
    // Block widgets may only come from a state field, not from a view plugin.
    EditorView.decorations.from(field, (value) => value.deco),
    // Both facets take the first value given, and Obsidian gives its own before a
    // plugin's: at the default precedence the note stayed editable (0.8.14).
    Prec.highest([EditorState.readOnly.from(field, readOnly), EditorView.editable.from(field, (value) => !readOnly(value))]),
    showPanel.from(field, (value) => (value.banner ? panelOf(value.banner) : null))
  ]
})

/** Typing, pasting, dropping, deleting, undoing: what a person does in an editor. */
function typed(transaction: Transaction): boolean {
  return ['input', 'delete', 'move', 'undo', 'redo'].some((event) => transaction.isUserEvent(event))
}

/**
 * A change a person makes in a read-only note never gets through - not even by a
 * key binding of Obsidian's or another plugin that dispatches it directly. Obsidian
 * loading the file again, which the Time Machine relies on, is no person's.
 */
const refuseTyping = EditorState.transactionFilter.of((transaction) => {
  if (!transaction.docChanged || !typed(transaction)) return transaction
  const shown = transaction.startState.field(shownField, false)
  return shown && readOnly(shown) ? [] : transaction
})

function same(a: Shown, b: Shown): boolean {
  const past = a.past === b.past || (a.past !== null && b.past !== null && a.past.now === b.past.now && a.past.marks === b.past.marks)
  const banner = a.banner?.text === b.banner?.text && (a.banner?.unlock === null) === (b.banner?.unlock === null)
  return past && banner && a.locked === b.locked
}

export function pastEditorExtension(host: PastEditorHost, pathOf: PathOf): Extension {
  const follower = ViewPlugin.fromClass(
    class {
      private readonly unwatch: () => void
      private path: string | null = null
      private asked = 0
      private destroyed = false

      constructor(readonly view: EditorView) {
        this.path = pathOf(view.state)?.path ?? null
        this.unwatch = host.onChange(() => void this.follow())
        // Never from the constructor: CodeMirror would drop the plugin for good (CLAUDE.md, invariant 6).
        queueMicrotask(() => void this.follow())
      }

      update(update: ViewUpdate): void {
        const path = pathOf(update.state)?.path ?? null
        if (path === this.path) return
        this.path = path
        queueMicrotask(() => void this.follow())
      }

      private async follow(): Promise<void> {
        if (this.destroyed) return
        const ask = (this.asked += 1)
        const path = pathOf(this.view.state)?.path ?? null
        const past = path ? await host.pastOf(path).catch(() => null) : null
        if (this.destroyed || ask !== this.asked || !this.view.dom.isConnected) return
        const shown: Shown = { past, locked: path ? host.lockedWhy(path) : null, banner: path ? (host.banner?.(path) ?? null) : null }
        if (same(this.view.state.field(shownField, false) ?? NOTHING, shown)) return
        this.view.dispatch({ effects: setShown.of(shown) })
      }

      destroy(): void {
        this.destroyed = true
        this.unwatch()
      }
    }
  )
  return [shownField, refuseTyping, follower]
}
