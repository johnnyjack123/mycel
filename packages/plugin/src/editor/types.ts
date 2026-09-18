export interface CollabAdapter {
  readonly kind: 'main-editor' | 'collab-view'
  attach(): void | Promise<void>
  detach(): void | Promise<void>
  // Re-installs the editor integration if the host dropped it. Only the main
  // editor can lose it; the dedicated view owns its own EditorView.
  ensureAttached?(): boolean
}
