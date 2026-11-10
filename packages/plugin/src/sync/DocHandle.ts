import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { IndexeddbPersistence } from 'y-indexeddb'
import { CONTENT_FIELD, docRoom, type CollabUser } from '@mycel/shared'
import { fromBase64, toBase64 } from '@mycel/shared/crypto'
import type { HistoryStore } from './History.js'
import type { RoomCrypto, RoomCursor, VaultSocket } from './VaultSocket.js'
import { log } from '../log.js'

// One note. The document is persisted locally before anything touches the
// network, so edits made offline survive closing Obsidian. Next to it lives
// the note's place in the server's log and whatever the server has not yet
// acknowledged - an edit made offline must still be sent after a restart.

/** Where a device keeps its copy of a document between sessions. */
export interface LocalStore {
  whenSynced: Promise<unknown>
  destroy(): Promise<unknown> | void
  /** Deletes what this store kept - document and log position - and closes it. */
  clear(): Promise<void>
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  del(key: string): Promise<void>
}

export type OpenLocalStore = (name: string, doc: Y.Doc) => LocalStore

export const openIndexedDb: OpenLocalStore = (name, doc) => {
  const persistence = new IndexeddbPersistence(name, doc)
  return {
    whenSynced: persistence.whenSynced,
    destroy: () => persistence.destroy(),
    clear: () => persistence.clearData(),
    get: async (key) => {
      const value: unknown = await persistence.get(key)
      return typeof value === 'string' ? value : null
    },
    set: async (key, value) => {
      await persistence.set(key, value)
    },
    del: async (key) => {
      await persistence.del(key)
    }
  }
}

const CURSOR_KEY = 'cursor'
const SENDING_KEY = 'sending'
const PIECE_PREFIX = 'outbox:'
const PERSIST_DELAY_MS = 250
/**
 * Pieces of the outbox kept apart, on the disk too, before they are merged into one: merging
 * them all on every keystroke, and writing the whole of it again, made typing offline slower
 * with every keystroke - 15 ms a keystroke after 20,000 unsent ones (0.9.14, `docs/PERFORMANCE.md`).
 */
const PIECES_MERGED_AT = 256

interface SavedCursor {
  lastSeq: number
  lastHash?: string | null
  lastContent?: string | null
  held?: boolean
  syncedAt?: number
  epoch: number
  /** The first piece of the outbox still waiting (`outbox:<n>`); the others follow it without a gap. */
  outboxFrom?: number
  /** A payload waits for its acknowledgement, under `sending`. */
  sendingKept?: boolean
  /** Before 0.9.14 both payloads were kept here, whole, written anew with every keystroke. */
  sending?: string | null
  outbox?: string | null
}

interface Piece {
  key: number
  data: Uint8Array
  stored: boolean
}

/**
 * A room cursor kept next to the document it belongs to. Each change made here enters the
 * outbox as a piece of its own and is stored at once, alone (invariant 15); the pieces are
 * merged only when they are sent, or once there are many.
 */
export class LocalCursor implements RoomCursor {
  lastSeq = 0
  lastHash: string | null = null
  lastContent: string | null = null
  held = false
  syncedAt = 0
  epoch = 0
  private sendingNow: Uint8Array | null = null
  private sendingStored = true
  private pieces: Piece[] = []
  private nextKey = 0
  private from = 0
  /** Pieces taken out of the outbox, deleted from the disk once what replaced them is written. */
  private obsolete: number[] = []
  private savedText: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private writes: Promise<void> = Promise.resolve()

  private constructor(private readonly store: LocalStore) {}

  static async load(store: LocalStore): Promise<LocalCursor> {
    const cursor = new LocalCursor(store)
    try {
      const raw = await store.get(CURSOR_KEY)
      const saved = raw ? (JSON.parse(raw) as SavedCursor) : null
      if (saved) {
        cursor.lastSeq = saved.lastSeq ?? 0
        cursor.lastHash = saved.lastHash ?? null
        cursor.lastContent = saved.lastContent ?? null
        cursor.held = saved.held ?? false
        cursor.syncedAt = saved.syncedAt ?? 0
        cursor.epoch = saved.epoch ?? 0
        cursor.from = saved.outboxFrom ?? 0
        if (typeof saved.sending === 'string' && saved.sending) {
          cursor.sendingNow = fromBase64(saved.sending)
          cursor.sendingStored = false
        } else if (saved.sendingKept) {
          const kept = await store.get(SENDING_KEY)
          cursor.sendingNow = kept ? fromBase64(kept) : null
        }
      }
      // Every piece from there on: one written just before a crash is in the outbox too, whatever the cursor said.
      for (let key = cursor.from; ; key += 1) {
        const piece = await store.get(`${PIECE_PREFIX}${key}`)
        if (!piece) break
        cursor.pieces.push({ key, data: fromBase64(piece), stored: true })
      }
      cursor.nextKey = cursor.from + cursor.pieces.length
      if (typeof saved?.outbox === 'string' && saved.outbox) {
        cursor.pieces.push({ key: cursor.nextKey++, data: fromBase64(saved.outbox), stored: false })
      } else if (raw && saved?.sending === undefined) {
        // Written in this form already: the first flush need not write it again.
        cursor.savedText = raw
      }
    } catch (error) {
      // Starting from zero only costs a full catch-up.
      log.error('the local log position is unreadable', error)
    }
    return cursor
  }

  get sending(): Uint8Array | null {
    return this.sendingNow
  }

  set sending(value: Uint8Array | null) {
    if (value === this.sendingNow) return
    this.sendingNow = value
    this.sendingStored = false
  }

  get hasOutbox(): boolean {
    return this.pieces.length > 0
  }

  /** How many bytes wait in the outbox, merged or not. */
  get outboxBytes(): number {
    return this.pieces.reduce((sum, piece) => sum + piece.data.length, 0)
  }

  enqueue(update: Uint8Array): void {
    this.pieces.push({ key: this.nextKey++, data: update, stored: false })
    void this.flush()
  }

  takeOutbox(): Uint8Array | null {
    if (this.pieces.length === 0) return null
    const merged = this.pieces.length === 1 ? (this.pieces[0] as Piece).data : Y.mergeUpdates(this.pieces.map((piece) => piece.data))
    this.retire()
    return merged
  }

  dropOutbox(): void {
    this.retire()
  }

  private retire(): void {
    this.obsolete.push(...this.pieces.map((piece) => piece.key))
    this.pieces = []
    this.from = this.nextKey
  }

  persist(urgent = false): void {
    if (urgent) {
      void this.flush()
      return
    }
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, PERSIST_DELAY_MS)
  }

  /**
   * Writes what changed: new pieces first, then the payload in flight, then the cursor - which
   * says where the outbox starts - and only then deletes the pieces it no longer names. A crash
   * anywhere in between leaves a piece twice at worst, which Yjs takes once.
   */
  flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (this.pieces.length > PIECES_MERGED_AT) {
      const merged = Y.mergeUpdates(this.pieces.map((piece) => piece.data))
      this.retire()
      this.pieces = [{ key: this.nextKey++, data: merged, stored: false }]
      this.from = this.pieces[0]?.key ?? this.from
    }
    const fresh = this.pieces.filter((piece) => !piece.stored)
    for (const piece of fresh) piece.stored = true
    const sending = this.sendingStored ? undefined : this.sendingNow
    this.sendingStored = true
    const saved: SavedCursor = {
      lastSeq: this.lastSeq,
      lastHash: this.lastHash,
      lastContent: this.lastContent,
      held: this.held,
      syncedAt: this.syncedAt,
      epoch: this.epoch,
      outboxFrom: this.from,
      sendingKept: this.sendingNow !== null
    }
    const text = JSON.stringify(saved)
    const cursorChanged = text !== this.savedText
    this.savedText = text
    const obsolete = this.obsolete.splice(0)
    this.writes = this.writes
      .then(async () => {
        for (const piece of fresh) await this.store.set(`${PIECE_PREFIX}${piece.key}`, toBase64(piece.data))
        if (sending !== undefined) await this.store.set(SENDING_KEY, sending ? toBase64(sending) : '')
        if (cursorChanged) await this.store.set(CURSOR_KEY, text)
        for (const key of obsolete) await this.store.del(`${PIECE_PREFIX}${key}`)
      })
      .catch((error) => log.error('saving the local log position failed', error))
    return this.writes
  }
}

export interface DocHandleOptions {
  shared: boolean
  readOnly: boolean
  crypto: RoomCrypto
  /** Where every change seen is kept on this device. */
  history?: HistoryStore | null
  /** This account owns the note, so the server may create it if it lost it. */
  owned?: boolean
  /** A shared folder this account writes in: a missing note is created there, owned by the folder's owner. */
  folder?: string | null
}

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
  private cursor: LocalCursor | null = null
  private destroyed = false
  private closedWith: string | null = null
  private sharedNow: boolean
  private readOnlyNow: boolean

  constructor(
    readonly docId: string,
    vaultId: string,
    private readonly socket: VaultSocket,
    private readonly user: CollabUser,
    private readonly options: DocHandleOptions,
    openLocal: OpenLocalStore = openIndexedDb
  ) {
    this.ytext = this.doc.getText(CONTENT_FIELD)
    this.room = docRoom(docId)
    this.awareness = new Awareness(this.doc)
    this.sharedNow = options.shared
    this.readOnlyNow = options.readOnly
    if (options.shared) this.awareness.setLocalStateField('user', user)
    this.persistence = openLocal(`mycel/${vaultId}/${docId}`, this.doc)
  }

  /**
   * Loads the local copy and its log position, then joins the room. Nothing
   * registers before the local state is in, or loading it would be taken for
   * edits and sent again.
   */
  async open(): Promise<void> {
    await this.persistence.whenSynced
    this.cursor = await LocalCursor.load(this.persistence)
    if (this.destroyed) return
    const history = this.options.history
    this.socket.register(this.room, this.doc, {
      crypto: this.options.crypto,
      cursor: this.cursor,
      awareness: this.sharedNow ? this.awareness : null,
      readOnly: this.readOnlyNow,
      history: history ? (entry) => history.add(this.room, entry) : null,
      create: (this.options.owned ?? true) || Boolean(this.options.folder),
      folder: this.options.folder ?? null
    })
  }

  get shared(): boolean {
    return this.sharedNow
  }

  get readOnly(): boolean {
    return this.readOnlyNow
  }

  setShared(shared: boolean): void {
    if (this.destroyed || shared === this.sharedNow) return
    this.sharedNow = shared
    if (shared) this.awareness.setLocalStateField('user', this.user)
    this.socket.setAwareness(this.room, shared ? this.awareness : null)
  }

  setReadOnly(readOnly: boolean): void {
    if (this.destroyed || readOnly === this.readOnlyNow) return
    this.readOnlyNow = readOnly
    this.socket.setReadOnly(this.room, readOnly)
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

  /** The last frame of the server's log this copy has applied. */
  get lastSeq(): number {
    return this.cursor?.lastSeq ?? 0
  }

  text(): string {
    return this.ytext.toString()
  }

  /**
   * The text while open; once closed, the text it was closed with - what this
   * device kept, and what the next handle of the note starts from. An editor
   * can go on writing into a closed document until it notices.
   */
  lastText(): string {
    return this.closedWith ?? this.text()
  }

  /**
   * No change was ever applied to this document, here or on the server. Every
   * insertion leaves a trace in the store, deleted or not, so an emptied note
   * is not pristine.
   */
  get pristine(): boolean {
    return this.doc.store.clients.size === 0
  }

  get isDestroyed(): boolean {
    return this.destroyed
  }

  /**
   * `clearLocal`: also deletes this device's copy - document, log position
   * and history - so the next handle starts from what the server has. Only
   * after the text was backed up.
   */
  async destroy(clearLocal = false): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    this.closedWith = this.text()
    this.socket.unregister(this.room)
    this.awareness.destroy()
    try {
      if (clearLocal) {
        await this.cursor?.flush()
        await this.persistence.clear()
        await this.options.history?.clear(this.room)
      } else {
        // Flush before tearing the document down, or the last edits and the
        // unacknowledged ones never reach local storage.
        await this.cursor?.flush()
        await this.persistence.destroy()
      }
    } catch (error) {
      log.error(`closing local storage for ${this.docId} failed`, error)
    }
    this.doc.destroy()
  }
}
