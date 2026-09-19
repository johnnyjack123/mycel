import { ItemView, type WorkspaceLeaf } from 'obsidian'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { yCollab } from 'y-codemirror.next'
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'

export const COLLAB_VIEW_TYPE = 'obsidian-connect-collab-view'

/** What the fallback view needs; deliberately not tied to a whole document handle. */
export interface CollabTarget {
  ytext: Y.Text
  awareness: Awareness
  title: string
}

export class CollabView extends ItemView {
  private editorView: EditorView | null = null
  private target: CollabTarget | null = null

  constructor(leaf: WorkspaceLeaf) {
    super(leaf)
  }

  getViewType(): string {
    return COLLAB_VIEW_TYPE
  }

  getDisplayText(): string {
    return this.target ? `Collab: ${this.target.title}` : 'CRDT collaboration'
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

  setTarget(target: CollabTarget): void {
    this.target = target
    this.rebuild()
  }

  private rebuild(): void {
    this.destroyEditor()
    if (!this.target) return

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      yCollab(this.target.ytext, this.target.awareness)
    ]
    const state = EditorState.create({
      doc: this.target.ytext.toString(),
      extensions
    })
    this.editorView = new EditorView({ state, parent: this.contentEl })
  }

  private destroyEditor(): void {
    this.editorView?.destroy()
    this.editorView = null
  }
}
