export interface CollabAdapter {
  readonly kind: 'main-editor' | 'collab-view'
  attach(): void | Promise<void>
  detach(): void | Promise<void>
}
