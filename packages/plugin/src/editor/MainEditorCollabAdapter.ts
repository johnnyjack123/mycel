import type { Editor } from 'obsidian'
import type { EditorView } from '@codemirror/view'
import { Compartment, StateEffect } from '@codemirror/state'
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import type { CollabAdapter } from './types'
import { mainEditorCollab } from './cm/collab'

export function getEditorView(editor: Editor): EditorView | null {
  const candidate = (editor as unknown as { cm?: EditorView }).cm
  return candidate ?? null
}

export class MainEditorCollabAdapter implements CollabAdapter {
  readonly kind = 'main-editor' as const
  private readonly compartment = new Compartment()
  private view: EditorView | null = null

  constructor(
    private readonly editor: Editor,
    private readonly ytext: Y.Text,
    private readonly awareness: Awareness
  ) {}

  attach(): void {
    const view = getEditorView(this.editor)
    if (!view) {
      throw new Error('Unable to access the Obsidian CodeMirror EditorView.')
    }
    this.view = view
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        this.compartment.of(mainEditorCollab(this.ytext, this.awareness))
      )
    })
    console.info('[crdt-sync] main editor extension attached')
  }

  detach(): void {
    if (!this.view) return
    try {
      this.view.dispatch({ effects: this.compartment.reconfigure([]) })
    } catch {
      // the editor view may already be destroyed
    }
    this.view = null
  }
}
