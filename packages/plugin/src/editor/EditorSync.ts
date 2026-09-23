import { TFile } from 'obsidian'
import type { Extension } from '@codemirror/state'
import type { DocStore } from '../sync/DocStore.js'
import {
  editorSyncExtension,
  type EditorBinding,
  type EditorSession,
  type EditorSyncHost,
  type NoteRef,
  type NoteResolver
} from './binding.js'

/** Connects the editor bindings Obsidian creates to the documents of the store. */
export class EditorSync implements EditorSyncHost {
  readonly extension: Extension
  private readonly bindings = new Set<EditorBinding>()
  /**
   * The one editor per note that carries it. Obsidian keeps several panes of
   * the same note in step by itself; a second binding would apply every
   * remote change to that note twice.
   */
  private readonly primary = new Map<string, EditorBinding>()

  constructor(
    private readonly store: () => DocStore | null,
    noteOf: NoteResolver
  ) {
    this.extension = editorSyncExtension(this, noteOf)
  }

  attached(binding: EditorBinding): void {
    this.bindings.add(binding)
  }

  detached(binding: EditorBinding): void {
    this.bindings.delete(binding)
  }

  /** Every editor binds if it can and rebinds if its session went stale. */
  refresh(): void {
    for (const binding of this.bindings) binding.refresh()
  }

  unbindAll(): void {
    for (const binding of this.bindings) binding.unbind()
  }

  boundCount(): number {
    let count = 0
    for (const binding of this.bindings) if (binding.isBound) count += 1
    return count
  }

  async acquire(note: NoteRef, binding: EditorBinding): Promise<EditorSession | null> {
    const store = this.store()
    if (!store?.ready || !(note instanceof TFile)) return null

    // Only a note whose file and document agree can be bound. Binding
    // earlier - an empty document the server had not sent yet - put
    // keystrokes at positions that did not exist and then inserted the
    // server's text in front of the editor's own copy.
    const docId = await store.settle(note)
    if (!docId || this.store() !== store || !binding.isAlive || binding.shownNote !== note) return null

    const holder = this.primary.get(docId)
    if (holder && holder !== binding && holder.isAlive) return null
    this.primary.set(docId, binding)
    store.pin(docId)
    // From here on Obsidian writes this file from the editor, and nothing else does.
    store.setEditorOwned(docId, true)

    let released = false
    const release = (): void => {
      if (released) return
      released = true
      if (this.primary.get(docId) === binding) this.primary.delete(docId)
      store.unpin(docId)
      store.setEditorOwned(docId, false)
      // Another pane showing the same note can take over now.
      queueMicrotask(() => this.refresh())
    }

    try {
      const handle = await store.handleFor(docId)
      const base = await store.baseText(docId)
      const shared = handle.shared
      const readOnly = handle.readOnly
      return {
        ytext: handle.ytext,
        awareness: shared ? handle.awareness : null,
        readOnly,
        isUnedited: (text) => text === base || text === store.recentWrite(docId),
        recentWrite: () => store.recentWrite(docId),
        resolve: (editorText, sharedText) => store.resolveEditorEdits(docId, editorText, sharedText),
        isStale: () =>
          this.store() !== store ||
          handle.isDestroyed ||
          store.isShared(docId) !== shared ||
          store.isReadOnly(docId) !== readOnly,
        release
      }
    } catch (error) {
      release()
      throw error
    }
  }
}
