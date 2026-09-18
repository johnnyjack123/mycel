import { ItemView, type WorkspaceLeaf } from 'obsidian'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { yCollab } from 'y-codemirror.next'
import type { CollabSession } from '../collab/CollabSession'

export const COLLAB_VIEW_TYPE = 'crdt-sync-collab-view'

export class CollabView extends ItemView {
  private editorView: EditorView | null = null
  private session: CollabSession | null = null

  constructor(leaf: WorkspaceLeaf) {
    super(leaf)
  }

  getViewType(): string {
    return COLLAB_VIEW_TYPE
  }

  getDisplayText(): string {
    return this.session ? `Collab: ${this.session.title()}` : 'CRDT collaboration'
  }

  getIcon(): string {
    return 'users'
  }

  async onOpen(): Promise<void> {
    this.rebuild()
  }

  async onClose(): Promise<void> {
    this.destroyEditor()
  }

  setSession(session: CollabSession): void {
    this.session = session
    this.rebuild()
  }

  private rebuild(): void {
    this.destroyEditor()
    if (!this.session) return

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      yCollab(this.session.ytext, this.session.awareness)
    ]
    const state = EditorState.create({
      doc: this.session.ytext.toString(),
      extensions
    })
    this.editorView = new EditorView({ state, parent: this.contentEl })
  }

  private destroyEditor(): void {
    this.editorView?.destroy()
    this.editorView = null
  }
}
