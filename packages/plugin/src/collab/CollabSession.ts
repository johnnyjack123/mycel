import { App, TFile } from 'obsidian'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import type { Awareness } from 'y-protocols/awareness'
import { toRoomName, type CollabUser } from '@crdt-sync/shared'

export interface CollabSessionOptions {
  serverUrl: string
  token: string
  vaultId: string
  user: CollabUser
}

const SYNC_TIMEOUT_MS = 5_000
const SEED_GRACE_MS = 1_500

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class CollabSession {
  readonly doc: Y.Doc
  readonly ytext: Y.Text
  readonly awareness: Awareness
  readonly provider: WebsocketProvider
  readonly room: string

  private readonly synced: Promise<void>
  private readonly markSynced: () => void

  constructor(
    private readonly app: App,
    readonly file: TFile,
    private readonly options: CollabSessionOptions
  ) {
    let mark: () => void = () => undefined
    this.synced = new Promise<void>((resolve) => {
      mark = resolve
    })
    this.markSynced = mark

    this.room = toRoomName({ vaultId: options.vaultId, path: file.path })
    this.doc = new Y.Doc()
    this.ytext = this.doc.getText('content')
    this.provider = new WebsocketProvider(options.serverUrl, this.room, this.doc, {
      connect: true,
      params: options.token ? { token: options.token } : {}
    })
    this.awareness = this.provider.awareness
    this.awareness.setLocalStateField('user', options.user)
    this.provider.on('sync', (isSynced: boolean) => {
      if (isSynced) this.markSynced()
    })
    console.info(`[crdt-sync] room="${this.room}" server="${options.serverUrl}"`)
    this.provider.on('status', (event: { status: string }) => {
      console.info(`[crdt-sync] ${event.status} (${this.room})`)
    })
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const source = origin === this.provider ? 'remote' : 'local'
      console.info(`[crdt-sync] doc update ${source} bytes=${update.length} (${this.room})`)
    })
  }

  title(): string {
    return this.file.basename
  }

  // Resolves once the room state is known, reporting whether the server was
  // reached. The document is seeded from the file only when the room is still
  // empty, and after a short grace period so a peer that joins at the same time
  // can win the seed instead of duplicating it. Seeding a room whose state we
  // never received would create a second, independent copy of the note.
  async ready(): Promise<boolean> {
    const synced = await Promise.race([
      this.synced.then(() => true),
      delay(SYNC_TIMEOUT_MS).then(() => false)
    ])
    if (!synced) return false
    if (this.ytext.length > 0) return true

    await delay(SEED_GRACE_MS)
    if (this.ytext.length > 0) return true

    const content = await this.app.vault.read(this.file)
    if (content.length === 0 || this.ytext.length > 0) return true
    this.doc.transact(() => {
      this.ytext.insert(0, content)
    })
    return true
  }

  dispose(): void {
    this.provider.destroy()
    this.doc.destroy()
  }
}
