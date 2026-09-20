import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { IndexeddbPersistence } from 'y-indexeddb'
import { CONTENT_FIELD, docRoom, type CollabUser } from '@obsidian-connect/shared'
import type { VaultSocket } from './VaultSocket.js'

// One note. The document is persisted locally before anything touches the
// network, so edits made offline survive closing Obsidian - previously they
// lived only in RAM and were gone on restart.

export class DocHandle {
  readonly doc = new Y.Doc()
  readonly ytext: Y.Text
  readonly awareness: Awareness
  readonly room: string

  private readonly persistence: IndexeddbPersistence
  private readonly socketSynced: Promise<void>
  private destroyed = false

  constructor(
    readonly docId: string,
    vaultId: string,
    socket: VaultSocket,
    user: CollabUser,
    readonly collabEnabled: boolean
  ) {
    this.ytext = this.doc.getText(CONTENT_FIELD)
    this.room = docRoom(docId)
    // The awareness object always exists because the fallback view's `yCollab`
    // needs one, but with collaboration off it is never registered with the
    // socket: no presence leaves this device and no remote cursors arrive.
    // Syncing your own devices should not broadcast where your caret is.
    this.awareness = new Awareness(this.doc)
    if (collabEnabled) this.awareness.setLocalStateField('user', user)
    this.persistence = new IndexeddbPersistence(`obsidian-connect/${vaultId}/${docId}`, this.doc)
    this.socketSynced = socket.register(
      this.room,
      this.doc,
      collabEnabled ? this.awareness : null
    )
  }

  /** Resolves once the locally stored state is loaded. */
  whenLocalReady(): Promise<unknown> {
    return this.persistence.whenSynced
  }

  /**
   * Resolves once the server state has arrived, or after `timeoutMs` if it has
   * not. Callers must treat the timeout as "state unknown" and never seed or
   * reconcile against it.
   */
  async whenRemoteReady(timeoutMs: number): Promise<boolean> {
    let timer: number | undefined
    const timeout = new Promise<boolean>((resolve) => {
      timer = window.setTimeout(() => resolve(false), timeoutMs)
    })
    try {
      return await Promise.race([this.socketSynced.then(() => true), timeout])
    } finally {
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }

  text(): string {
    return this.ytext.toString()
  }

  get isDestroyed(): boolean {
    return this.destroyed
  }

  async destroy(socket: VaultSocket): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    socket.unregister(this.room)
    this.awareness.destroy()
    // Flush before tearing the document down, or the last edits never reach
    // IndexedDB.
    try {
      await this.persistence.destroy()
    } catch (error) {
      console.error(`[obsidian-connect] closing local storage for ${this.docId} failed`, error)
    }
    this.doc.destroy()
  }

  /** Removes this note's locally stored copy. */
  async clearLocal(): Promise<void> {
    try {
      await this.persistence.clearData()
    } catch (error) {
      console.error(`[obsidian-connect] clearing local storage for ${this.docId} failed`, error)
    }
  }
}
