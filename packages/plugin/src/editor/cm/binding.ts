import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { Annotation, type Extension } from '@codemirror/state'
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

export const remoteUpdate = Annotation.define<boolean>()

const LOCAL_ORIGIN = Symbol('crdt-sync-local')

interface PendingChange {
  from: number
  to?: number
  insert?: string
}

export function yTextBinding(ytext: Y.Text, awareness: Awareness): Extension {
  return ViewPlugin.fromClass(
    class {
      private applyingRemote = false

      private readonly observer = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
        if (transaction.origin === LOCAL_ORIGIN) return
        this.applyRemote(event)
      }

      constructor(private readonly view: EditorView) {
        ytext.observe(this.observer)
        // The session owns seeding; the binding only makes the editor follow the
        // shared text, otherwise every attach would add another copy of the note.
        this.syncFromYText()
        this.publishSelection()
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged &&
          !this.applyingRemote &&
          !update.transactions.some((transaction) => transaction.annotation(remoteUpdate))
        ) {
          this.applyLocalChanges(update)
        }
        if (update.selectionSet) this.publishSelection()
      }

      destroy(): void {
        ytext.unobserve(this.observer)
        awareness.setLocalStateField('cursor', null)
      }

      private syncFromYText(): void {
        const current = this.view.state.doc.toString()
        const next = ytext.toString()
        if (current === next) return
        this.applyingRemote = true
        try {
          this.view.dispatch({
            changes: { from: 0, to: this.view.state.doc.length, insert: next },
            annotations: remoteUpdate.of(true)
          })
        } finally {
          this.applyingRemote = false
        }
      }

      private applyRemote(event: Y.YTextEvent): void {
        const changes: PendingChange[] = []
        let index = 0
        for (const op of event.delta) {
          if (op.retain !== undefined) {
            index += op.retain
            continue
          }
          if (op.insert !== undefined) {
            const text = typeof op.insert === 'string' ? op.insert : ''
            changes.push({ from: index, insert: text })
            index += text.length
            continue
          }
          if (op.delete !== undefined) {
            changes.push({ from: index, to: index + op.delete })
          }
        }
        if (changes.length === 0) return
        console.info(`[crdt-sync] remote -> editor changes=${changes.length} ytext=${ytext.length}`)
        this.applyingRemote = true
        try {
          this.view.dispatch({ changes, annotations: remoteUpdate.of(true) })
        } finally {
          this.applyingRemote = false
        }
      }

      private applyLocalChanges(update: ViewUpdate): void {
        const doc = ytext.doc
        if (!doc) return
        let offset = 0
        doc.transact(() => {
          update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            const from = fromA + offset
            const deleted = toA - fromA
            if (deleted > 0) ytext.delete(from, deleted)
            const text = inserted.toString()
            if (text.length > 0) ytext.insert(from, text)
            offset += text.length - deleted
          })
        }, LOCAL_ORIGIN)
      }

      private publishSelection(): void {
        if (!ytext.doc) return
        const range = this.view.state.selection.main
        const anchor = Y.createRelativePositionFromTypeIndex(ytext, range.anchor)
        const head = Y.createRelativePositionFromTypeIndex(ytext, range.head)
        awareness.setLocalStateField('cursor', { anchor, head })
      }
    }
  )
}
