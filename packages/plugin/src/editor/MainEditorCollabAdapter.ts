import type { Editor } from 'obsidian'
import type { EditorView } from '@codemirror/view'
import { Compartment, StateEffect } from '@codemirror/state'
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import type { CollabAdapter } from './types'
import { mainEditorCollab } from './cm/collab'
import type { YTextBinding } from './cm/binding'

export function getEditorView(editor: Editor): EditorView | null {
  const candidate = (editor as unknown as { cm?: EditorView }).cm
  return candidate ?? null
}

// Resolves the editor currently showing this session's note, or null when the
// note is not open in any editor.
export type SessionEditorResolver = () => EditorView | null

export class MainEditorCollabAdapter implements CollabAdapter {
  readonly kind = 'main-editor' as const
  private readonly compartment = new Compartment()
  private view: EditorView | null = null
  private binding: YTextBinding | null = null

  constructor(
    private readonly resolveView: SessionEditorResolver,
    private readonly ytext: Y.Text,
    private readonly awareness: Awareness
  ) {}

  attach(): void {
    const view = this.resolveView()
    if (!view) {
      throw new Error('Unable to access the Obsidian CodeMirror EditorView.')
    }
    this.install(view)
    console.info('[crdt-sync] main editor extension attached')
  }

  // Obsidian discards `StateEffect.appendConfig` extensions whenever it rebuilds
  // the EditorState, which it does on every file switch inside a leaf and on
  // every edit/preview mode change. The session stays connected, so the editor
  // just silently stops participating unless the extension is put back.
  // Returns true when it had to be installed again.
  ensureAttached(): boolean {
    const view = this.resolveView()
    // The note is not open anywhere. The session keeps running and the editor
    // picks the shared text up again when the note is reopened.
    if (!view) return false
    if (view === this.view && this.binding && view.plugin(this.binding) !== null) return false
    this.install(view)
    console.info('[crdt-sync] main editor extension re-attached')
    return true
  }

  detach(): void {
    const view = this.view
    const binding = this.binding
    this.view = null
    this.binding = null
    if (!view) return
    // Nothing to remove when Obsidian already rebuilt the state without us.
    if (binding && view.plugin(binding) === null) return
    try {
      view.dispatch({ effects: this.compartment.reconfigure([]) })
    } catch {
      // the editor view may already be destroyed
    }
  }

  private install(view: EditorView): void {
    this.detach()
    const collab = mainEditorCollab(this.ytext, this.awareness, () => this.resolveView() === view)
    view.dispatch({
      effects: StateEffect.appendConfig.of(this.compartment.of(collab.extension))
    })
    if (view.plugin(collab.binding) === null) {
      throw new Error(
        'The CodeMirror collaboration plugin did not start; see the console for the underlying error.'
      )
    }
    this.view = view
    this.binding = collab.binding
  }
}
