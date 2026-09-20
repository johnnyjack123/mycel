import type { Editor } from 'obsidian'
import { EditorView } from '@codemirror/view'
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
    private readonly awareness: Awareness | null
  ) {}

  attach(): void {
    const view = this.resolveView()
    if (!view) {
      throw new Error('Unable to access the Obsidian CodeMirror EditorView.')
    }
    this.install(view)
    console.info('[obsidian-connect] main editor extension attached')
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
    console.info('[obsidian-connect] main editor extension re-attached')
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

    let crash: unknown = null
    const collab = mainEditorCollab(
      this.ytext,
      this.awareness,
      () => this.resolveView() === view,
      (error) => {
        crash = error
        console.error('[obsidian-connect] the editor extension threw', error)
      }
    )

    try {
      view.dispatch({
        effects: StateEffect.appendConfig.of(this.compartment.of(collab.extension))
      })
    } catch (error) {
      throw new Error(`installing the editor extension failed: ${describe(error)}`)
    }

    if (view.plugin(collab.binding) === null) {
      // Everything known about the editor at the moment it refused, because
      // the cause has so far only been reproducible on one machine.
      const context = [
        `crash=${crash ? describe(crash) : 'none reported'}`,
        `docLength=${view.state.doc.length}`,
        `inDom=${view.dom.isConnected}`,
        `editable=${view.state.facet(EditorView.editable)}`
      ].join(', ')
      throw new Error(`the editor extension did not start (${context})`)
    }

    this.view = view
    this.binding = collab.binding
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
