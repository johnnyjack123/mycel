import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { IndexeddbPersistence } from 'y-indexeddb'
import { CONTENT_FIELD, docRoom, type CollabUser } from '@obsidian-connect/shared'
import type { VaultSocket } from './VaultSocket.js'

// One note. The document is persisted locally before anything touches the
// network, so edits made offline survive closing Obsidian - previously they
// lived only in RAM and were gone on restart.

/** Where a device keeps its copy of a document between sessions. */
export interface LocalStore {
  whenSynced: Promise<unknown>
  destroy(): Promise<unknown> | void
}

export type OpenLocalStore = (name: string, doc: Y.Doc) => LocalStore

export const openIndexedDb: OpenLocalStore = (name, doc) => new IndexeddbPersistence(name, doc)

export class DocHandle {
  readonly doc = new Y.Doc()
  readonly ytext: Y.Text
  /**
   * Exists for every note but is registered with the socket only while the
   * note is shared: syncing your own devices must not broadcast a caret.
   */
  readonly awareness: Awareness
  readonly room: string

  private readonly persistence: LocalStore
  private destroyed = false
  private sharedNow: boolean

  constructor(
    readonly docId: string,
    vaultId: string,
    private readonly socket: VaultSocket,
    private readonly user: CollabUser,
    shared: boolean,
    openLocal: OpenLocalStore = openIndexedDb
  ) {
    this.ytext = this.doc.getText(CONTENT_FIELD)
    this.room = docRoom(docId)
    this.awareness = new Awareness(this.doc)
    this.sharedNow = shared
    if (shared) this.awareness.setLocalStateField('user', user)
    this.persistence = openLocal(`obsidian-connect/${vaultId}/${docId}`, this.doc)
    socket.register(this.room, this.doc, shared ? this.awareness : null)
  }

  get shared(): boolean {
    return this.sharedNow
  }

  setShared(shared: boolean): void {
    if (this.destroyed || shared === this.sharedNow) return
    this.sharedNow = shared
    if (shared) this.awareness.setLocalStateField('user', this.user)
    this.socket.setAwareness(this.room, shared ? this.awareness : null)
  }

  /** Resolves once the locally stored state is loaded. */
  whenLocalReady(): Promise<unknown> {
    return this.persistence.whenSynced
  }

  /**
   * Resolves once the server state has arrived since the last (re)connect, or
   * after `timeoutMs` if it has not. Callers must treat `false` as "state
   * unknown" and never seed or reconcile against it.
   */
  async whenRemoteReady(timeoutMs: number): Promise<boolean> {
    if (this.socket.isSynced(this.room)) return true
    // Offline, waiting only costs time: nothing is going to arrive.
    if (!this.socket.connected) return false
    let timer: number | undefined
    const timeout = new Promise<boolean>((resolve) => {
      timer = window.setTimeout(() => resolve(false), timeoutMs)
    })
    try {
      return await Promise.race([this.socket.whenSynced(this.room).then(() => true), timeout])
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

  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    this.socket.unregister(this.room)
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
}
