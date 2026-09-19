import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { Annotation, type Extension } from '@codemirror/state'
import {
  type EditorView,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'

export const remoteUpdate = Annotation.define<boolean>()

const LOCAL_ORIGIN = Symbol('obsidian-connect-local')

interface PendingChange {
  from: number
  to?: number
  insert?: string
}

export type YTextBinding = ViewPlugin<PluginValue> & Extension

// `isSessionEditor` tells the binding whether the view it is installed in still
// shows this session's note. Obsidian reuses an editor across file switches, so
// without it a switch could push the next note's text into the shared document.
export function yTextBinding(
  ytext: Y.Text,
  awareness: Awareness,
  isSessionEditor: () => boolean
): YTextBinding {
  return ViewPlugin.fromClass(
    class {
      private applyingRemote = false
      private destroyed = false

      private readonly observer = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
        if (transaction.origin === LOCAL_ORIGIN) return
        this.applyRemote(event)
      }

      constructor(private readonly view: EditorView) {
        ytext.observe(this.observer)
        // CodeMirror refuses a dispatch while an update is in progress, and this
        // plugin is constructed from inside the transaction that installs it. A
        // dispatch here throws, CodeMirror catches it and deactivates the plugin
        // for good, so local edits would never reach Yjs again. Defer instead:
        // the installing update has finished by the time a microtask runs.
        queueMicrotask(() => this.initialSync())
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged &&
          !this.applyingRemote &&
          !update.transactions.some((transaction) => transaction.annotation(remoteUpdate)) &&
          isSessionEditor()
        ) {
          this.applyLocalChanges(update)
        }
        if (update.selectionSet) this.publishSelection()
      }

      destroy(): void {
        this.destroyed = true
        ytext.unobserve(this.observer)
        awareness.setLocalStateField('cursor', null)
      }

      private initialSync(): void {
        if (this.destroyed || !isSessionEditor()) return
        // The session owns seeding; the binding only makes the editor follow the
        // shared text, otherwise every attach would add another copy of the note.
        // An empty shared text means the room has not been seeded yet, so leaving
        // the editor alone here keeps it from wiping the open note.
        if (ytext.length > 0) this.replaceEditorWithYText()
        this.publishSelection()
      }

      private replaceEditorWithYText(): void {
        const current = this.view.state.doc.toString()
        const next = ytext.toString()
        if (current === next) return
        this.dispatchRemote({
          changes: { from: 0, to: this.view.state.doc.length, insert: next }
        })
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
        try {
          this.dispatchRemote({ changes })
        } catch (error) {
          // The delta is relative to a Y.Text state the editor may have drifted
          // from. Recovering the whole text is always correct, just coarser.
          console.error('[obsidian-connect] applying a remote delta failed, resyncing', error)
          this.replaceEditorWithYText()
          return
        }
        if (this.view.state.doc.length !== ytext.length) this.replaceEditorWithYText()
      }

      private dispatchRemote(spec: { changes: PendingChange | PendingChange[] }): void {
        this.applyingRemote = true
        try {
          this.view.dispatch({ ...spec, annotations: remoteUpdate.of(true) })
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
        // The editor can be ahead of Y.Text while an update is still settling;
        // an out-of-range index would throw out of the update handler.
        const limit = ytext.length
        const anchor = Y.createRelativePositionFromTypeIndex(
          ytext,
          Math.min(range.anchor, limit)
        )
        const head = Y.createRelativePositionFromTypeIndex(ytext, Math.min(range.head, limit))
        awareness.setLocalStateField('cursor', { anchor, head })
      }
    }
  )
}
