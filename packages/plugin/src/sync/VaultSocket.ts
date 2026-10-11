import * as Y from 'yjs'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates
} from 'y-protocols/awareness'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { MUX, awarenessAad, frameAad, snapshotAad, type Notice, type NotifyKind } from '@obsidian-connect/shared'
import { bytes, decrypt, encrypt, packFrame, sha256, toHex, unpackFrame } from '@obsidian-connect/shared/crypto'
import type { HistoryEntry } from './History.js'
import { log } from '../log.js'

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
  /**
   * Fingerprint of what the server sent as `lastSeq`. Seq numbers alone do
   * not tell one log from another: a server restored from a backup numbers
   * its new frames from where the backup ended, so a device that was away
   * would take them for frames it has and skip them.
   */
  lastHash: string | null
  /**
   * The server's log turned out not to be the one this device knew. Nothing
   * is sent until the user decided whose state is right - or a restored
   * server would be overwritten, or a lost one filled with half a state.
   */
  held: boolean
  /** When this room was last caught up with a log it recognised. */
  syncedAt: number
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
  return {
    lastSeq: 0,
    lastHash: null,
    held: false,
    syncedAt: 0,
    epoch: 0,
    sending: null,
    outbox: null,
    persist: () => undefined
  }
}

export interface RoomOptions {
  crypto: RoomCrypto
  cursor: RoomCursor
  awareness?: Awareness | null
  /** The server refuses changes; they stay out of the outbox. */
  readOnly?: boolean
  /** Every change seen, received or acknowledged, for the device's own history. */
  history?: ((entry: HistoryEntry) => void) | null
  /** Whether a room the server does not have is created. Only for rooms this account owns. */
  create?: boolean
}

export interface SocketHandlers {
  notify?(kind: NotifyKind, payload: Notice): void
  /** Access to a room was taken away - also answered to a later subscribe. */
  revoked?(room: string): void
  denied?(room: string, reason: string): void
  /**
   * The server's log of a room is not the one this device knew - it lost
   * data or was rolled back. The room is caught up with what the server has,
   * merged into the local state, and held until `keepLocal` or a reset.
   */
  diverged?(room: string): void
}

type Verification = 'none' | 'pending' | 'match' | 'mismatch'

async function fingerprint(data: Uint8Array): Promise<string> {
  return toHex(await sha256(bytes(data))).slice(0, 32)
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
  /** What is in flight: its author time, payload and fingerprint, for the ack. */
  inflightFrame: { authorTs: number; payload: Uint8Array; hash: string } | null
  /** Old changes sent again after the server lost them, each as its own frame. */
  replay: HistoryEntry[]
  /** The author time of a replayed change being sent, so its history keeps its time. */
  sendingTs: number | null
  /** Whether the frame the cursor ends at came back unchanged in this catch-up. */
  verify: { seq: number; hash: string | null; state: Verification }
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
      log.error('opening the vault socket failed', error)
      this.scheduleReconnect()
      return
    }
    socket.binaryType = 'arraybuffer'
    this.ws = socket

    socket.onopen = () => {
      this.retries = 0
      log.info(`connected to ${this.serverUrl}, ${this.registrations.size} room(s)`)
      this.emit('connected')
      for (const registration of this.registrations.values()) this.subscribe(registration)
    }
    socket.onmessage = (event: MessageEvent) => {
      this.receive(new Uint8Array(event.data as ArrayBuffer))
    }
    socket.onclose = (event: CloseEvent) => {
      if (!this.closed) log.info(`disconnected (${event.code}${event.reason ? ` ${event.reason}` : ''}), retry ${this.retries + 1}`)
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
      log.error('sending on the vault socket failed', error)
    }
  }

  /**
   * Asks for one frame more than needed: the one the cursor ends at. It has
   * to come back exactly as this device saw it, or the server's log is not
   * the one the cursor points into.
   */
  private subscribe(registration: Registration): void {
    const cursor = registration.options.cursor
    const lastSeq = cursor.lastSeq
    registration.verify =
      lastSeq > 0 && cursor.lastHash
        ? { seq: lastSeq, hash: cursor.lastHash, state: 'pending' }
        : { seq: 0, hash: null, state: 'none' }
    this.send((encoder) => {
      encoding.writeVarUint(encoder, MUX.subscribe)
      encoding.writeVarString(encoder, registration.room)
      encoding.writeVarUint(encoder, registration.verify.state === 'pending' ? lastSeq - 1 : lastSeq)
      encoding.writeVarUint(encoder, registration.options.create === false ? 0 : 1)
    })
  }

  private checkVerification(registration: Registration, seq: number, hash: string): void {
    const verify = registration.verify
    if (verify.state === 'pending' && seq === verify.seq) verify.state = hash === verify.hash ? 'match' : 'mismatch'
  }

  // --- incoming ------------------------------------------------------------------

  private enqueue(registration: Registration, task: () => Promise<void>): void {
    registration.chain = registration.chain.then(task).catch((error) => {
      log.error(`handling a message for ${registration.room} failed`, error)
    })
  }

  private receive(message: Uint8Array): void {
    if (message.length === 0) return
    const decoder = decoding.createDecoder(message)
    const type = decoding.readVarUint(decoder)

    if (type === MUX.notify) {
      const kind = decoding.readVarString(decoder) as NotifyKind
      try {
        this.handlers.notify?.(kind, JSON.parse(decoding.readVarString(decoder)) as Notice)
      } catch (error) {
        log.error('a notification could not be read', error)
      }
      return
    }
    if (type === MUX.error) {
      log.error(`server error: ${decoding.readVarString(decoder)}`)
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
          const cursor = registration.options.cursor
          const verify = registration.verify
          if (verify.state === 'pending' || verify.state === 'mismatch') {
            // The frame the cursor ends at is gone or different. Everything the
            // server has is fetched and merged in - nothing local is dropped -
            // and the room waits for the user's decision.
            log.warn(`${registration.room}: the server's log is not the one this device knew (${verify.state} at #${verify.seq}); holding it`)
            cursor.held = true
            cursor.lastSeq = 0
            cursor.lastHash = null
            cursor.persist(true)
            this.subscribe(registration)
            return
          }
          cursor.epoch = epoch
          if (!cursor.held) cursor.syncedAt = Date.now()
          cursor.persist()
          if (!registration.synced) {
            registration.synced = true
            registration.markSynced()
          }
          this.announcePresence(registration)
          if (cursor.held) {
            this.handlers.diverged?.(registration.room)
            return
          }
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
          const frame = registration.inflightFrame
          registration.inflight = null
          registration.inflightFrame = null
          registration.sendingTs = null
          cursor.sending = null
          // Everything the server sent before this acknowledgement has been
          // applied - the chain keeps that order - so nothing below seq is missing.
          if (seq > cursor.lastSeq) {
            cursor.lastSeq = seq
            cursor.lastHash = frame?.hash ?? null
          }
          if (frame) registration.options.history?.({ authorTs: frame.authorTs, update: frame.payload })
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
        log.info(`${room}: access ended (${decoding.readVarString(decoder)})`)
        registration.dead = true
        this.handlers.revoked?.(room)
        return
      case MUX.denied: {
        const reason = decoding.readVarString(decoder)
        // Missing is not final: the server lost a note someone else owns, and
        // it may come back once they reconnect. Asked again on every connect.
        if (reason !== 'missing') registration.dead = true
        log.error(`the server refused ${room}: ${reason}`)
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
      log.error(`no key for ${registration.room} epoch ${epoch}`)
      return null
    }
    return decrypt(key, data, aad)
  }

  private async applyFrame(registration: Registration, seq: number, epoch: number, data: Uint8Array): Promise<void> {
    const cursor = registration.options.cursor
    const hash = await fingerprint(data)
    this.checkVerification(registration, seq, hash)
    // The catch-up and the live stream can overlap by a frame or two, and the
    // catch-up starts one frame early on purpose.
    if (seq <= cursor.lastSeq) return
    const plaintext = await this.open(registration, epoch, data, frameAad(registration.room, epoch))
    // Unreadable: leave lastSeq where it is, so the next catch-up brings it again.
    if (!plaintext || registration.dead) return
    const frame = unpackFrame(plaintext)
    log.debug(`${registration.room}: frame #${seq}, ${frame.update.length} B, epoch ${epoch}`)
    Y.applyUpdate(registration.doc, frame.update, this)
    registration.options.history?.({ authorTs: frame.authorTs, update: frame.update })
    cursor.lastSeq = seq
    cursor.lastHash = hash
    cursor.persist()
  }

  private async applySnapshot(registration: Registration, uptoSeq: number, epoch: number, data: Uint8Array): Promise<void> {
    const hash = `snapshot:${await fingerprint(data)}`
    const verify = registration.verify
    // Folded up to or past where this device stood: the frames it knew are
    // inside, and can no longer be compared one by one. Folded exactly at its
    // last frame is the common case - a note nobody touched for longer than
    // the retention - and taking that for another server held every old
    // note and asked about each of them. Only a snapshot this device already
    // stood on is compared, against itself.
    const folded = uptoSeq > verify.seq || (uptoSeq === verify.seq && !verify.hash?.startsWith('snapshot:'))
    if (verify.state === 'pending' && folded) verify.state = 'match'
    else this.checkVerification(registration, uptoSeq, hash)
    const plaintext = await this.open(registration, epoch, data, snapshotAad(registration.room, epoch))
    if (!plaintext || registration.dead) return
    const snapshot = unpackFrame(plaintext)
    Y.applyUpdate(registration.doc, snapshot.update, this)
    registration.options.history?.({ authorTs: snapshot.authorTs, update: snapshot.update })
    const cursor = registration.options.cursor
    if (uptoSeq >= cursor.lastSeq) {
      cursor.lastSeq = uptoSeq
      cursor.lastHash = hash
    }
    cursor.persist()
  }

  private async applyAwareness(registration: Registration, epoch: number, data: Uint8Array): Promise<void> {
    const awareness = registration.options.awareness
    if (!awareness) {
      log.debug(`${registration.room}: presence received for a room that shows none`)
      return
    }
    try {
      const plaintext = await this.open(registration, epoch, data, awarenessAad(registration.room, epoch))
      if (!plaintext || registration.options.awareness !== awareness) {
        log.debug(`${registration.room}: presence under epoch ${epoch} dropped`)
        return
      }
      applyAwarenessUpdate(awareness, plaintext, this)
      log.debug(`${registration.room}: presence received, epoch ${epoch}, ${awareness.getStates().size} present`)
    } catch (error) {
      log.warn(`presence for ${registration.room} could not be read`, error)
    }
  }

  // --- outgoing ------------------------------------------------------------------

  private scheduleSend(registration: Registration): void {
    const cursor = registration.options.cursor
    if (registration.dead || registration.options.readOnly || !registration.synced || cursor.held) return
    if (registration.inflight !== null || registration.sendTimer !== null) return
    if (!cursor.sending && !cursor.outbox && registration.replay.length === 0) return
    registration.sendTimer = window.setTimeout(() => {
      registration.sendTimer = null
      void this.sendNext(registration).catch((error) => {
        log.error(`sending ${registration.room} failed`, error)
      })
    }, SEND_DELAY_MS)
  }

  private async sendNext(registration: Registration): Promise<void> {
    const cursor = registration.options.cursor
    if (!this.connected || !registration.synced || registration.inflight !== null || registration.dead || cursor.held) return
    if (!cursor.sending) {
      if (cursor.outbox) {
        cursor.sending = cursor.outbox
        cursor.outbox = null
      } else {
        const replayed = registration.replay.shift()
        if (!replayed) return
        cursor.sending = replayed.update
        registration.sendingTs = replayed.authorTs
      }
      cursor.persist()
    }
    const payload = cursor.sending
    const authorTs = registration.sendingTs ?? Date.now()
    const epoch = cursor.epoch
    const key = await registration.options.crypto.key(epoch)
    if (!key) {
      log.error(`no key to send ${registration.room} under epoch ${epoch}`)
      return
    }
    const data = await encrypt(key, packFrame(authorTs, payload), frameAad(registration.room, epoch))
    const hash = await fingerprint(data)
    if (this.registrations.get(registration.room) !== registration || !this.connected || registration.inflight !== null) return
    const ref = this.nextRef
    this.nextRef += 1
    registration.inflight = ref
    registration.inflightFrame = { authorTs, payload, hash }
    log.debug(`${registration.room}: push ${ref}, ${payload.length} B, epoch ${epoch}`)
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
    if (!this.connected || !registration.synced || registration.dead) {
      log.debug(`${registration.room}: presence not sent (${this.connected ? (registration.dead ? 'room ended' : 'not caught up') : 'offline'})`)
      return
    }
    const epoch = registration.options.cursor.epoch
    const key = await registration.options.crypto.key(epoch)
    if (!key) {
      log.warn(`${registration.room}: no key to send presence under epoch ${epoch}`)
      return
    }
    log.debug(`${registration.room}: presence sent, epoch ${epoch}`)
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
      inflightFrame: null,
      replay: [],
      sendingTs: null,
      verify: { seq: 0, hash: null, state: 'none' },
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

  /** Whether a room waits for the user to decide whose state is right. */
  isHeld(room: string): boolean {
    return this.registrations.get(room)?.options.cursor.held ?? false
  }

  /** When a room was last caught up with a log this device recognised; 0 if never. */
  syncedAtOf(room: string): number {
    return this.registrations.get(room)?.options.cursor.syncedAt ?? 0
  }

  /**
   * This device's state is right: all of it goes to the server - the whole
   * document first, so nothing is missing there even if sending stops half
   * way, then the old changes one by one with their own times, for the
   * history.
   */
  keepLocal(room: string, history: HistoryEntry[] = []): void {
    const registration = this.registrations.get(room)
    if (!registration || !registration.options.cursor.held) return
    const cursor = registration.options.cursor
    const state = Y.encodeStateAsUpdate(registration.doc)
    cursor.outbox = cursor.outbox ? Y.mergeUpdates([cursor.outbox, state]) : state
    cursor.held = false
    cursor.persist(true)
    registration.replay = history.slice()
    this.scheduleSend(registration)
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
