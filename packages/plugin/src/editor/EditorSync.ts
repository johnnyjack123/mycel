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

// How long a note stays Obsidian's to write while its editor binds again. A
// rebind that has not happened by then is not going to; the file is ours again.
const REBIND_MS = 5_000

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
  /**
   * Notes whose editor let go only to bind again. The file stays Obsidian's
   * until it has: writing it meanwhile made Obsidian reload the editor, and
   * whatever was typed in between was gone.
   */
  private readonly rebinding = new Map<EditorBinding, { docId: string; store: DocStore; timer: number }>()

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
    this.endRebind(binding)
  }

  /** Every editor binds if it can and rebinds if its session went stale. */
  refresh(): void {
    for (const binding of this.bindings) binding.refresh()
  }

  unbindAll(): void {
    for (const binding of this.bindings) binding.unbind()
    for (const binding of Array.from(this.rebinding.keys())) this.endRebind(binding)
  }

  boundCount(): number {
    let count = 0
    for (const binding of this.bindings) if (binding.isBound) count += 1
    return count
  }

  /** `kept`: the binding bound again to the same note, and the claim carries on. */
  private endRebind(binding: EditorBinding, kept = false): void {
    const pending = this.rebinding.get(binding)
    if (!pending) return
    this.rebinding.delete(binding)
    window.clearTimeout(pending.timer)
    // Another pane may carry the note by now; the claim is its claim then.
    if (kept || this.primary.has(pending.docId)) return
    pending.store.unpin(pending.docId)
    pending.store.setEditorOwned(pending.docId, false)
    queueMicrotask(() => this.refresh())
  }

  async acquire(note: NoteRef, binding: EditorBinding): Promise<EditorSession | null> {
    const store = this.store()
    if (!store?.ready || !(note instanceof TFile)) {
      this.endRebind(binding)
      return null
    }

    // Only a note whose file and document agree can be bound. Binding
    // earlier - an empty document the server had not sent yet - put
    // keystrokes at positions that did not exist and then inserted the
    // server's text in front of the editor's own copy.
    const docId = await store.settle(note)
    if (!docId || this.store() !== store || !binding.isAlive || binding.shownNote !== note) {
      this.endRebind(binding)
      return null
    }

    const holder = this.primary.get(docId)
    if (holder && holder !== binding && holder.isAlive) {
      this.endRebind(binding)
      return null
    }
    const pending = this.rebinding.get(binding)
    this.endRebind(binding, pending?.docId === docId && pending.store === store)
    this.primary.set(docId, binding)
    store.pin(docId)
    // From here on Obsidian writes this file from the editor, and nothing else does.
    store.setEditorOwned(docId, true)

    let released = false
    let open: { readonly isDestroyed: boolean } | null = null
    const release = (rebinding = false): void => {
      if (released) return
      released = true
      if (this.primary.get(docId) === binding) this.primary.delete(docId)
      // Only while the document stays open: a new one has to be settled
      // against the server first, which a claimed file skips.
      if (rebinding && this.store() === store && binding.isAlive && open?.isDestroyed === false) {
        const timer = window.setTimeout(() => this.endRebind(binding), REBIND_MS)
        this.rebinding.set(binding, { docId, store, timer })
        return
      }
      store.unpin(docId)
      store.setEditorOwned(docId, false)
      // Another pane showing the same note can take over now.
      queueMicrotask(() => this.refresh())
    }

    try {
      const handle = await store.handleFor(docId)
      open = handle
      const base = await store.baseText(docId)
      const shared = handle.shared
      const readOnly = handle.readOnly
      return {
        ytext: handle.ytext,
        awareness: shared ? handle.awareness : null,
        readOnly,
        isUnedited: (text) => text === base || text === store.recentWrite(docId) || store.heldBefore(docId, text),
        recentWrite: () => store.recentWrite(docId),
        resolve: (editorText, sharedText, lastAgreed) => store.resolveEditorEdits(docId, editorText, sharedText, lastAgreed),
        agreedText: () => handle.lastText(),
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
