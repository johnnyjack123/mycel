import { MarkdownView, Notice, Plugin, TFile } from 'obsidian'
import type { CollabUser } from '@crdt-sync/shared'
import { CollabSession } from './collab/CollabSession'
import { CollabView, COLLAB_VIEW_TYPE } from './editor/CollabView'
import { CollabViewAdapter } from './editor/CollabViewAdapter'
import { getEditorView, MainEditorCollabAdapter } from './editor/MainEditorCollabAdapter'
import type { CollabAdapter } from './editor/types'
import { CrdtSyncSettingTab, DEFAULT_SETTINGS, type CrdtSyncSettings } from './settings'

interface ActiveCollab {
  session: CollabSession
  adapter: CollabAdapter
}

export default class CrdtSyncPlugin extends Plugin {
  settings: CrdtSyncSettings = { ...DEFAULT_SETTINGS }
  private readonly active = new Map<string, ActiveCollab>()
  private statusBar!: HTMLElement

  async onload(): Promise<void> {
    await this.loadSettings()

    this.statusBar = this.addStatusBarItem()
    this.registerView(COLLAB_VIEW_TYPE, (leaf) => new CollabView(leaf))
    this.addSettingTab(new CrdtSyncSettingTab(this.app, this))
    this.addRibbonIcon('users', 'Toggle CRDT collaboration', () => {
      void this.toggleActive()
    })
    this.addCommand({
      id: 'toggle-collaboration',
      name: 'Toggle collaboration on the current note',
      callback: () => {
        void this.toggleActive()
      }
    })
    this.addCommand({
      id: 'stop-all-collaboration',
      name: 'Stop all collaboration sessions',
      callback: () => this.stopAll()
    })
    this.addCommand({
      id: 'show-collaboration-status',
      name: 'Show collaboration status',
      callback: () => this.showStatus()
    })
  }

  onunload(): void {
    this.stopAll()
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  private async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<CrdtSyncSettings> | null
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {})
  }

  private async toggleActive(): Promise<void> {
    const file = this.app.workspace.getActiveFile()
    if (!(file instanceof TFile) || file.extension !== 'md') {
      new Notice('Open a markdown note first.')
      return
    }
    if (this.active.has(file.path)) {
      this.stop(file.path)
      new Notice(`Stopped collaboration on ${file.basename}.`)
      return
    }
    await this.start(file)
  }

  private async start(file: TFile): Promise<void> {
    if (!this.settings.vaultId) {
      this.settings.vaultId = crypto.randomUUID()
      await this.saveSettings()
    }

    const user: CollabUser = {
      id: this.settings.displayName || 'local-user',
      name: this.settings.displayName || 'Local user',
      color: '#30bced',
      colorLight: '#30bced33'
    }
    const session = new CollabSession(this.app, file, {
      serverUrl: this.settings.serverUrl,
      token: this.settings.token,
      vaultId: this.settings.vaultId,
      user
    })
    session.provider.on('status', (event: { status: string }) => {
      this.statusBar.setText(`CRDT ${event.status}: ${file.basename}`)
    })

    await session.ready()
    const adapter = await this.createAdapter(session)
    console.info(`[crdt-sync] adapter=${adapter.kind} room=${session.room}`)
    this.active.set(file.path, { session, adapter })
    new Notice(`Collaborating on ${file.basename}.`)
  }

  private async createAdapter(session: CollabSession): Promise<CollabAdapter> {
    if (this.settings.adapterMode === 'collab-view') {
      const adapter = new CollabViewAdapter(this.app, session)
      await adapter.attach()
      return adapter
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    const editor = view?.editor
    if (editor && getEditorView(editor)) {
      const adapter = new MainEditorCollabAdapter(editor, session.ytext, session.awareness)
      try {
        adapter.attach()
        return adapter
      } catch (error) {
        console.error('[crdt-sync] main editor integration failed', error)
        new Notice('Main editor integration unavailable; opening the fallback view.')
      }
    } else {
      new Notice('Main editor integration unavailable; opening the fallback view.')
    }

    const fallback = new CollabViewAdapter(this.app, session)
    await fallback.attach()
    return fallback
  }

  private stop(path: string): void {
    const entry = this.active.get(path)
    if (!entry) return
    void entry.adapter.detach()
    entry.session.dispose()
    this.active.delete(path)
    if (this.active.size === 0) this.statusBar.setText('')
  }

  private stopAll(): void {
    for (const path of Array.from(this.active.keys())) {
      this.stop(path)
    }
  }

  private showStatus(): void {
    if (this.active.size === 0) {
      new Notice('No active collaboration sessions.')
      return
    }
    const lines = Array.from(this.active.entries()).map(
      ([path, entry]) =>
        `${path} -> ${entry.session.provider.wsconnected ? 'connected' : 'offline'} (${entry.adapter.kind})\n${entry.session.room}`
    )
    new Notice(lines.join('\n\n'), 20_000)
  }
}
