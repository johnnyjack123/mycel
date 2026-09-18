import * as Y from 'yjs'
import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType
} from '@codemirror/view'
import type { CollabUser } from '@crdt-sync/shared'
import { awarenessFacet, yTextFacet } from './facets'

interface AwarenessCursor {
  anchor: Y.RelativePosition
  head: Y.RelativePosition
}

const forceUpdate = StateEffect.define<null>()

class CaretWidget extends WidgetType {
  constructor(private readonly user: CollabUser) {
    super()
  }

  eq(other: CaretWidget): boolean {
    return other.user.id === this.user.id && other.user.color === this.user.color
  }

  toDOM(): HTMLElement {
    const caret = document.createElement('span')
    caret.className = 'crdt-remote-caret'
    caret.style.borderColor = this.user.color
    const label = document.createElement('span')
    label.className = 'crdt-remote-caret-label'
    label.style.backgroundColor = this.user.color
    label.textContent = this.user.name
    caret.appendChild(label)
    return caret
  }

  ignoreEvent(): boolean {
    return true
  }
}

function absoluteIndex(
  ytext: Y.Text,
  doc: Y.Doc,
  position: Y.RelativePosition
): number | null {
  const absolute = Y.createAbsolutePositionFromRelativePosition(position, doc)
  if (!absolute || absolute.type !== ytext) return null
  return absolute.index
}

function buildDecorations(state: EditorState): DecorationSet {
  const ytext = state.facet(yTextFacet)
  const awareness = state.facet(awarenessFacet)
  if (!ytext || !awareness || !ytext.doc) return Decoration.none

  const ranges: Range<Decoration>[] = []
  awareness.getStates().forEach((raw, clientId) => {
    if (clientId === awareness.clientID) return
    const cursor = raw.cursor as AwarenessCursor | undefined
    const user = raw.user as CollabUser | undefined
    if (!cursor || !user) return

    const anchor = absoluteIndex(ytext, ytext.doc as Y.Doc, cursor.anchor)
    const head = absoluteIndex(ytext, ytext.doc as Y.Doc, cursor.head)
    if (anchor === null || head === null) return

    const from = Math.min(anchor, head)
    const to = Math.max(anchor, head)
    if (from !== to) {
      ranges.push(
        Decoration.mark({
          class: 'crdt-remote-selection',
          attributes: { style: `background-color: ${user.colorLight}` }
        }).range(from, to)
      )
    }
    ranges.push(Decoration.widget({ widget: new CaretWidget(user), side: 1 }).range(head))
  })
  return Decoration.set(ranges, true)
}

const decorationsField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (value, transaction) => {
    if (transaction.docChanged || transaction.effects.some((effect) => effect.is(forceUpdate))) {
      return buildDecorations(transaction.state)
    }
    return value.map(transaction.changes)
  },
  provide: (field) => EditorView.decorations.from(field)
})

export function remoteCursors(): Extension {
  return [
    decorationsField,
    ViewPlugin.fromClass(
      class {
        private destroyed = false
        private readonly view: EditorView
        private readonly onChange: () => void

        constructor(view: EditorView) {
          this.view = view
          this.onChange = () => {
            queueMicrotask(() => {
              if (this.destroyed || !this.view.dom.isConnected) return
              this.view.dispatch({ effects: forceUpdate.of(null) })
            })
          }
          view.state.facet(awarenessFacet)?.on('change', this.onChange)
        }

        destroy(): void {
          this.destroyed = true
          this.view.state.facet(awarenessFacet)?.off('change', this.onChange)
        }
      }
    )
  ]
}
