import { EditorState, StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { lineDiff } from '@obsidian-connect/shared'

// A note showing its past is shown in its own editor (`docs/TIMEMACHINE.md`,
// W1): read-only, and with the changes against now marked in it - the lines
// there then and not now highlighted, the lines there now and not then struck
// through between them. The editor never writes: the past is in the file, and
// nothing of it may become an edit.

/** What an editor shows of the past: the note's text now (null: not there now), and whether changes are marked. */
export interface PastShown {
  now: string | null
  marks: boolean
}

export interface PastEditorHost {
  /** For a file the Time Machine shows the past in, what to mark; null for any other. */
  pastOf(path: string): Promise<PastShown | null>
  onChange(listener: () => void): () => void
}

export type PathOf = (state: EditorState) => { path: string } | null

const setPast = StateEffect.define<PastShown | null>()

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

const pastField = StateField.define<{ past: PastShown | null; deco: DecorationSet }>({
  create: () => ({ past: null, deco: Decoration.none }),
  update(value, transaction) {
    let past = value.past
    let set = false
    for (const effect of transaction.effects) {
      if (effect.is(setPast)) {
        past = effect.value
        set = true
      }
    }
    if (!set && !transaction.docChanged) return value
    return { past, deco: past?.marks ? marksFor(past.now, transaction.state.doc.toString()) : Decoration.none }
  },
  // Block widgets may only come from a state field, not from a view plugin.
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.deco),
    EditorState.readOnly.from(field, (value) => value.past !== null),
    EditorView.editable.from(field, (value) => value.past === null)
  ]
})

function same(a: PastShown | null, b: PastShown | null): boolean {
  return a === b || (a !== null && b !== null && a.now === b.now && a.marks === b.marks)
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
        if (same(this.view.state.field(pastField, false)?.past ?? null, past)) return
        this.view.dispatch({ effects: setPast.of(past) })
      }

      destroy(): void {
        this.destroyed = true
        this.unwatch()
      }
    }
  )
  return [pastField, follower]
}
