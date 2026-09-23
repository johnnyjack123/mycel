import * as Y from 'yjs'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates
} from 'y-protocols/awareness'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { MUX, awarenessAad, frameAad, snapshotAad, type NotifyKind, type ShareNotice } from '@obsidian-connect/shared'
import { bytes, decrypt, encrypt, packFrame, unpackFrame } from '@obsidian-connect/shared/crypto'

// One WebSocket carries every document of the vault, end-to-end encrypted.
// The server keeps an ordered log per room and cannot read it, so there is no
// state-vector exchange any more: a client asks for everything after the last
// frame it has, and sends what it changed until the server has acknowledged it.

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
// Keystrokes arriving this close together travel as one frame.
const SEND_DELAY_MS = 40

/** Keys of one room, by epoch. Null: this device may not read that epoch. */
export interface RoomCrypto {
  key(epoch: number): Promise<CryptoKey | null>
}

/** Where a room's position in the log and its unacknowledged changes are kept. */
export interface RoomCursor {
  /** The last frame applied. */
  lastSeq: number
  /** The epoch new frames are encrypted under. */
  epoch: number
  /** The payload waiting for its acknowledgement. */
  sending: Uint8Array | null
  /** Changes made since that payload was sent. */
  outbox: Uint8Array | null
  /**
   * Called after every change; debounce inside. `urgent` when a local edit
   * entered the outbox: the document is stored at once, and an outbox saved
   * later than it could lose that edit to a crash in between - stored locally,
   * never sent.
   */
  persist(urgent?: boolean): void
}

export function memoryCursor(): RoomCursor {
  return { lastSeq: 0, epoch: 0, sending: null, outbox: null, persist: () => undefined }
}

export interface RoomOptions {
  crypto: RoomCrypto
  cursor: RoomCursor
  awareness?: Awareness | null
  /** The server refuses changes; they stay out of the outbox. */
  readOnly?: boolean
}

export interface SocketHandlers {
  notify?(kind: NotifyKind, payload: ShareNotice): void
  /** Access to a room was taken away - also answered to a later subscribe. */
  revoked?(room: string): void
  denied?(room: string, reason: string): void
}

interface Registration {
  room: string
  doc: Y.Doc
  options: RoomOptions
  synced: boolean
  markSynced: () => void
  whenSynced: Promise<void>
  /** Incoming messages of this room, applied strictly in order. */
  chain: Promise<void>
  inflight: number | null
  sendTimer: number | null
  dead: boolean
  onDocUpdate: (update: Uint8Array, origin: unknown) => void
  onAwarenessUpdate: (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void
}

export type SocketStatus = 'connecting' | 'connected' | 'disconnected'

const never = new Promise<void>(() => undefined)

export class VaultSocket {
  private ws: WebSocket | null = null
  private readonly registrations = new Map<string, Registration>()
  private readonly statusListeners = new Set<(status: SocketStatus) => void>()
  private retries = 0
  private reconnectTimer: number | null = null
  private closed = false
  private nextRef = 1

  constructor(
    private readonly serverUrl: string,
    private readonly vaultId: string,
    private readonly token: () => string,
    private readonly handlers: SocketHandlers = {}
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  onStatus(listener: (status: SocketStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private emit(status: SocketStatus): void {
    for (const listener of this.statusListeners) listener(status)
  }

  private url(): string {
    const base = this.serverUrl.replace(/\/+$/, '')
    return `${base}/vault/${encodeURIComponent(this.vaultId)}?token=${encodeURIComponent(this.token())}`
  }

  connect(): void {
    if (this.closed || this.ws) return
    this.emit('connecting')
    let socket: WebSocket
    try {
      socket = new WebSocket(this.url())
    } catch (error) {
      console.error('[obsidian-connect] opening the vault socket failed', error)
      this.scheduleReconnect()
      return
    }
    socket.binaryType = 'arraybuffer'
    this.ws = socket

    socket.onopen = () => {
      this.retries = 0
      this.emit('connected')
      for (const registration of this.registrations.values()) this.subscribe(registration)
    }
    socket.onmessage = (event: MessageEvent) => {
      this.receive(new Uint8Array(event.data as ArrayBuffer))
    }
    socket.onclose = () => {
      this.ws = null
      for (const registration of this.registrations.values()) this.resetSync(registration)
      this.emit('disconnected')
      this.scheduleReconnect()
    }
    socket.onerror = () => {
      // `onclose` always follows, which is where the reconnect lives.
      socket.close()
    }
  }

  /**
   * Everything after a reconnect is waited for again: an old, resolved
   * promise would report a state as known that the server has not confirmed
   * since. What was in flight is sent again once caught up.
   */
  private resetSync(registration: Registration): void {
    registration.inflight = null
    if (registration.sendTimer !== null) window.clearTimeout(registration.sendTimer)
    registration.sendTimer = null
    if (!registration.synced) return
    registration.synced = false
    registration.whenSynced = new Promise<void>((resolve) => {
      registration.markSynced = resolve
    })
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.retries, RECONNECT_MAX_MS)
    this.retries += 1
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private send(write: (encoder: encoding.Encoder) => void): void {
    if (!this.connected) return
    const encoder = encoding.createEncoder()
    write(encoder)
    try {
      this.ws?.send(encoding.toUint8Array(encoder))
    } catch (error) {
      console.error('[obsidian-connect] sending on the vault socket failed', error)
    }
  }

  private subscribe(registration: Registration): void {
    this.send((encoder) => {
      encoding.writeVarUint(encoder, MUX.subscribe)
      encoding.writeVarString(encoder, registration.room)
      encoding.writeVarUint(encoder, registration.options.cursor.lastSeq)
    })
  }

  // --- incoming ------------------------------------------------------------------

  private enqueue(registration: Registration, task: () => Promise<void>): void {
    registration.chain = registration.chain.then(task).catch((error) => {
      console.error(`[obsidian-connect] handling a message for ${registration.room} failed`, error)
    })
  }

  private receive(message: Uint8Array): void {
    if (message.length === 0) return
    const decoder = decoding.createDecoder(message)
    const type = decoding.readVarUint(decoder)

    if (type === MUX.notify) {
      const kind = decoding.readVarString(decoder) as NotifyKind
      try {
        this.handlers.notify?.(kind, JSON.parse(decoding.readVarString(decoder)) as ShareNotice)
      } catch (error) {
        console.error('[obsidian-connect] a notification could not be read', error)
      }
      return
    }
    if (type === MUX.error) {
      console.error(`[obsidian-connect] server error: ${decoding.readVarString(decoder)}`)
      return
    }

    const room = decoding.readVarString(decoder)
    const registration = this.registrations.get(room)
    if (!registration) return

    switch (type) {
      case MUX.frame: {
        const seq = decoding.readVarUint(decoder)
        decoding.readVarUint(decoder) // the server's clock; the history view asks for it separately
        const epoch = decoding.readVarUint(decoder)
        const data = decoding.readVarUint8Array(decoder)
        this.enqueue(registration, () => this.applyFrame(registration, seq, epoch, data))
        return
      }
      case MUX.snapshot: {
        const uptoSeq = decoding.readVarUint(decoder)
        const epoch = decoding.readVarUint(decoder)
        const data = decoding.readVarUint8Array(decoder)
        this.enqueue(registration, () => this.applySnapshot(registration, uptoSeq, epoch, data))
        return
      }
      case MUX.caughtUp: {
        decoding.readVarUint(decoder) // headSeq
        const epoch = decoding.readVarUint(decoder)
        this.enqueue(registration, async () => {
          registration.options.cursor.epoch = epoch
          registration.options.cursor.persist()
          if (!registration.synced) {
            registration.synced = true
            registration.markSynced()
          }
          this.announcePresence(registration)
          this.scheduleSend(registration)
        })
        return
      }
      case MUX.ack: {
        const ref = decoding.readVarUint(decoder)
        const seq = decoding.readVarUint(decoder)
        this.enqueue(registration, async () => {
          if (registration.inflight !== ref) return
          const cursor = registration.options.cursor
          registration.inflight = null
          cursor.sending = null
          // Everything the server sent before this acknowledgement has been
          // applied - the chain keeps that order - so nothing below seq is missing.
          cursor.lastSeq = Math.max(cursor.lastSeq, seq)
          cursor.persist()
          this.scheduleSend(registration)
        })
        return
      }
      case MUX.awareness: {
        const epoch = decoding.readVarUint(decoder)
        const data = decoding.readVarUint8Array(decoder)
        void this.applyAwareness(registration, epoch, data)
        return
      }
      case MUX.rekey: {
        const epoch = decoding.readVarUint(decoder)
        this.enqueue(registration, async () => {
          registration.options.cursor.epoch = epoch
          registration.options.cursor.persist()
          // A push under the old epoch was refused and will never be
          // acknowledged; send it again under the new one.
          registration.inflight = null
          this.scheduleSend(registration)
        })
        return
      }
      case MUX.revoked:
        registration.dead = true
        this.handlers.revoked?.(room)
        return
      case MUX.denied: {
        const reason = decoding.readVarString(decoder)
        registration.dead = true
        console.error(`[obsidian-connect] the server refused ${room}: ${reason}`)
        this.handlers.denied?.(room, reason)
        return
      }
      default:
        return
    }
  }

  private async open(registration: Registration, epoch: number, data: Uint8Array, aad: string): Promise<Uint8Array | null> {
    const key = await registration.options.crypto.key(epoch)
    if (!key) {
      console.error(`[obsidian-connect] no key for ${registration.room} epoch ${epoch}`)
      return null
    }
    return decrypt(key, data, aad)
  }

  private async applyFrame(registration: Registration, seq: number, epoch: number, data: Uint8Array): Promise<void> {
    const cursor = registration.options.cursor
    // The catch-up and the live stream can overlap by a frame or two.
    if (seq <= cursor.lastSeq) return
    const plaintext = await this.open(registration, epoch, data, frameAad(registration.room, epoch))
    // Unreadable: leave lastSeq where it is, so the next catch-up brings it again.
    if (!plaintext || registration.dead) return
    Y.applyUpdate(registration.doc, unpackFrame(plaintext).update, this)
    cursor.lastSeq = seq
    cursor.persist()
  }

  private async applySnapshot(registration: Registration, uptoSeq: number, epoch: number, data: Uint8Array): Promise<void> {
    const plaintext = await this.open(registration, epoch, data, snapshotAad(registration.room, epoch))
    if (!plaintext || registration.dead) return
    Y.applyUpdate(registration.doc, unpackFrame(plaintext).update, this)
    const cursor = registration.options.cursor
    cursor.lastSeq = Math.max(cursor.lastSeq, uptoSeq)
    cursor.persist()
  }

  private async applyAwareness(registration: Registration, epoch: number, data: Uint8Array): Promise<void> {
    const awareness = registration.options.awareness
    if (!awareness) return
    try {
      const plaintext = await this.open(registration, epoch, data, awarenessAad(registration.room, epoch))
      if (plaintext && registration.options.awareness === awareness) applyAwarenessUpdate(awareness, plaintext, this)
    } catch (error) {
      console.warn(`[obsidian-connect] presence for ${registration.room} could not be read`, error)
    }
  }

  // --- outgoing ------------------------------------------------------------------

  private scheduleSend(registration: Registration): void {
    const cursor = registration.options.cursor
    if (registration.dead || registration.options.readOnly || !registration.synced) return
    if (registration.inflight !== null || registration.sendTimer !== null) return
    if (!cursor.sending && !cursor.outbox) return
    registration.sendTimer = window.setTimeout(() => {
      registration.sendTimer = null
      void this.sendNext(registration).catch((error) => {
        console.error(`[obsidian-connect] sending ${registration.room} failed`, error)
      })
    }, SEND_DELAY_MS)
  }

  private async sendNext(registration: Registration): Promise<void> {
    if (!this.connected || !registration.synced || registration.inflight !== null || registration.dead) return
    const cursor = registration.options.cursor
    if (!cursor.sending) {
      if (!cursor.outbox) return
      cursor.sending = cursor.outbox
      cursor.outbox = null
      cursor.persist()
    }
    const payload = cursor.sending
    const epoch = cursor.epoch
    const key = await registration.options.crypto.key(epoch)
    if (!key) {
      console.error(`[obsidian-connect] no key to send ${registration.room} under epoch ${epoch}`)
      return
    }
    const data = await encrypt(key, packFrame(Date.now(), payload), frameAad(registration.room, epoch))
    if (this.registrations.get(registration.room) !== registration || !this.connected || registration.inflight !== null) return
    const ref = this.nextRef
    this.nextRef += 1
    registration.inflight = ref
    this.send((encoder) => {
      encoding.writeVarUint(encoder, MUX.push)
      encoding.writeVarString(encoder, registration.room)
      encoding.writeVarUint(encoder, ref)
      encoding.writeVarUint(encoder, epoch)
      encoding.writeVarUint8Array(encoder, data)
    })
  }

  private announcePresence(registration: Registration): void {
    const awareness = registration.options.awareness
    if (!awareness?.getLocalState()) return
    void this.sendAwareness(registration, encodeAwarenessUpdate(awareness, [awareness.clientID]))
  }

  private async sendAwareness(registration: Registration, update: Uint8Array): Promise<void> {
    if (!this.connected || !registration.synced || registration.dead) return
    const epoch = registration.options.cursor.epoch
    const key = await registration.options.crypto.key(epoch)
    if (!key) return
    const data = await encrypt(key, bytes(update), awarenessAad(registration.room, epoch))
    this.send((encoder) => {
      encoding.writeVarUint(encoder, MUX.awareness)
      encoding.writeVarString(encoder, registration.room)
      encoding.writeVarUint(encoder, epoch)
      encoding.writeVarUint8Array(encoder, data)
    })
  }

  // --- registrations -------------------------------------------------------------

  register(room: string, doc: Y.Doc, options: RoomOptions): Promise<void> {
    const existing = this.registrations.get(room)
    if (existing) return existing.whenSynced

    let markSynced: () => void = () => undefined
    const whenSynced = new Promise<void>((resolve) => {
      markSynced = resolve
    })

    const registration: Registration = {
      room,
      doc,
      options: { ...options, awareness: options.awareness ?? null },
      synced: false,
      markSynced,
      whenSynced,
      chain: Promise.resolve(),
      inflight: null,
      sendTimer: null,
      dead: false,
      onDocUpdate: (update, origin) => {
        // What this socket applied came from the server already.
        if (origin === this || registration.options.readOnly) return
        const cursor = registration.options.cursor
        cursor.outbox = cursor.outbox ? Y.mergeUpdates([cursor.outbox, update]) : update
        cursor.persist(true)
        this.scheduleSend(registration)
      },
      onAwarenessUpdate: (changes, origin) => {
        const awareness = registration.options.awareness
        if (origin === this || !awareness) return
        const changed = changes.added.concat(changes.updated, changes.removed)
        if (changed.length === 0) return
        void this.sendAwareness(registration, encodeAwarenessUpdate(awareness, changed))
      }
    }

    doc.on('update', registration.onDocUpdate)
    registration.options.awareness?.on('update', registration.onAwarenessUpdate)
    this.registrations.set(room, registration)

    if (this.connected) this.subscribe(registration)
    else this.connect()
    return whenSynced
  }

  /** Starts or stops exchanging presence for a registered room - a note becoming shared while open. */
  setAwareness(room: string, awareness: Awareness | null): void {
    const registration = this.registrations.get(room)
    if (!registration || registration.options.awareness === awareness) return
    const previous = registration.options.awareness
    if (previous) {
      // Announce the departure while the listener is still attached, or the
      // others keep showing a caret that is no longer there.
      removeAwarenessStates(previous, [previous.clientID], 'unshare')
      previous.off('update', registration.onAwarenessUpdate)
    }
    registration.options.awareness = awareness
    if (awareness) {
      awareness.on('update', registration.onAwarenessUpdate)
      this.announcePresence(registration)
    }
  }

  setReadOnly(room: string, readOnly: boolean): void {
    const registration = this.registrations.get(room)
    if (!registration) return
    registration.options.readOnly = readOnly
    if (readOnly) {
      // Nothing of it would be accepted.
      registration.options.cursor.sending = null
      registration.options.cursor.outbox = null
      registration.options.cursor.persist()
    } else {
      this.scheduleSend(registration)
    }
  }

  unregister(room: string): void {
    const registration = this.registrations.get(room)
    if (!registration) return
    registration.dead = true
    if (registration.sendTimer !== null) window.clearTimeout(registration.sendTimer)
    registration.doc.off('update', registration.onDocUpdate)
    const awareness = registration.options.awareness
    if (awareness) {
      removeAwarenessStates(awareness, [awareness.clientID], 'unregister')
      awareness.off('update', registration.onAwarenessUpdate)
    }
    this.registrations.delete(room)
    this.send((encoder) => {
      encoding.writeVarUint(encoder, MUX.unsubscribe)
      encoding.writeVarString(encoder, room)
    })
  }

  isSynced(room: string): boolean {
    return this.registrations.get(room)?.synced ?? false
  }

  /** Whether every local change of a room has been acknowledged. */
  isSettled(room: string): boolean {
    const cursor = this.registrations.get(room)?.options.cursor
    return !cursor || (!cursor.sending && !cursor.outbox)
  }

  epochOf(room: string): number {
    return this.registrations.get(room)?.options.cursor.epoch ?? 0
  }

  lastSeqOf(room: string): number {
    return this.registrations.get(room)?.options.cursor.lastSeq ?? 0
  }

  /**
   * Resolves once the server's state of a registered room has arrived since
   * the last (re)connect. An unregistered room never resolves: its state is
   * unknown, and callers race this against a timeout.
   */
  whenSynced(room: string): Promise<void> {
    return this.registrations.get(room)?.whenSynced ?? never
  }

  destroy(): void {
    this.closed = true
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    for (const room of Array.from(this.registrations.keys())) this.unregister(room)
    this.statusListeners.clear()
    this.ws?.close()
    this.ws = null
  }
}
