import type { App, WorkspaceLeaf } from 'obsidian'
import type { CollabSession } from '../collab/CollabSession'
import { COLLAB_VIEW_TYPE, CollabView } from './CollabView'
import type { CollabAdapter } from './types'

export class CollabViewAdapter implements CollabAdapter {
  readonly kind = 'collab-view' as const
  private leaf: WorkspaceLeaf | null = null

  constructor(private readonly app: App, private readonly session: CollabSession) {}

  async attach(): Promise<void> {
    const leaf = this.app.workspace.getLeaf(true)
    await leaf.setViewState({ type: COLLAB_VIEW_TYPE, active: true })
    this.leaf = leaf
    if (leaf.view instanceof CollabView) {
      leaf.view.setSession(this.session)
    }
  }

  async detach(): Promise<void> {
    this.leaf?.detach()
    this.leaf = null
  }
}
