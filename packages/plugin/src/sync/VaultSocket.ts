import * as Y from 'yjs'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates
} from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { MUX } from '@obsidian-connect/shared'

// One WebSocket carries every document of the vault. `y-websocket` opens a
// socket per room, which is fine for a handful of shared notes and impossible
// for a whole vault.

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

interface Registration {
  room: string
  doc: Y.Doc
  awareness: Awareness | null
  synced: boolean
  markSynced: () => void
  whenSynced: Promise<void>
  onDocUpdate: (update: Uint8Array, origin: unknown) => void
  onAwarenessUpdate: (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => void
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

  constructor(
    private readonly serverUrl: string,
    private readonly vaultId: string,
    private readonly token: string
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
    const path = `${base}/vault/${encodeURIComponent(this.vaultId)}`
    return this.token ? `${path}?token=${encodeURIComponent(this.token)}` : path
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
      for (const registration of this.registrations.values()) {
        this.sendSubscribe(registration)
      }
    }
    socket.onmessage = (event: MessageEvent) => {
      this.receive(new Uint8Array(event.data as ArrayBuffer))
    }
    socket.onclose = () => {
      this.ws = null
      // Whatever arrives after a reconnect has to be waited for again. Keeping
      // the old, resolved promise would report a state as known that the
      // server has not confirmed since.
      for (const registration of this.registrations.values()) this.resetSync(registration)
      this.emit('disconnected')
      this.scheduleReconnect()
    }
    socket.onerror = () => {
      // `onclose` always follows, which is where the reconnect lives.
      socket.close()
    }
  }

  private resetSync(registration: Registration): void {
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

  private send(data: Uint8Array): void {
    if (!this.connected) return
    try {
      this.ws?.send(data)
    } catch (error) {
      console.error('[obsidian-connect] sending on the vault socket failed', error)
    }
  }

  private frame(type: number, room: string, payload: Uint8Array): void {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, type)
    encoding.writeVarString(encoder, room)
    encoding.writeVarUint8Array(encoder, payload)
    this.send(encoding.toUint8Array(encoder))
  }

  private sendSubscribe(registration: Registration): void {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MUX.subscribe)
    encoding.writeVarString(encoder, registration.room)
    this.send(encoding.toUint8Array(encoder))

    // The server announces its state too, but asking for theirs in the same
    // breath means neither side waits for the other.
    const sync = encoding.createEncoder()
    syncProtocol.writeSyncStep1(sync, registration.doc)
    this.frame(MUX.sync, registration.room, encoding.toUint8Array(sync))

    this.sendLocalAwareness(registration)
  }

  private sendLocalAwareness(registration: Registration): void {
    const awareness = registration.awareness
    if (!awareness || !awareness.getLocalState()) return
    this.frame(MUX.awareness, registration.room, encodeAwarenessUpdate(awareness, [awareness.clientID]))
  }

  private receive(message: Uint8Array): void {
    if (message.length === 0) return
    const decoder = decoding.createDecoder(message)
    const type = decoding.readVarUint(decoder)

    if (type === MUX.error) {
      console.error(`[obsidian-connect] server rejected a room: ${decoding.readVarString(decoder)}`)
      return
    }

    const room = decoding.readVarString(decoder)
    const registration = this.registrations.get(room)
    if (!registration) return

    if (type === MUX.sync) {
      const body = decoding.readVarUint8Array(decoder)
      const reply = encoding.createEncoder()
      const messageType = syncProtocol.readSyncMessage(
        decoding.createDecoder(body),
        reply,
        registration.doc,
        this
      )
      if (encoding.length(reply) > 0) {
        this.frame(MUX.sync, room, encoding.toUint8Array(reply))
      }
      if (messageType === syncProtocol.messageYjsSyncStep2 && !registration.synced) {
        registration.synced = true
        registration.markSynced()
      }
      return
    }

    if (type === MUX.awareness && registration.awareness) {
      applyAwarenessUpdate(registration.awareness, decoding.readVarUint8Array(decoder), this)
    }
  }

  register(room: string, doc: Y.Doc, awareness: Awareness | null = null): Promise<void> {
    const existing = this.registrations.get(room)
    if (existing) return existing.whenSynced

    let markSynced: () => void = () => undefined
    const whenSynced = new Promise<void>((resolve) => {
      markSynced = resolve
    })

    const registration: Registration = {
      room,
      doc,
      awareness,
      synced: false,
      markSynced,
      whenSynced,
      onDocUpdate: (update, origin) => {
        // Updates this socket just applied would otherwise bounce straight back.
        if (origin === this) return
        const encoder = encoding.createEncoder()
        syncProtocol.writeUpdate(encoder, update)
        this.frame(MUX.sync, room, encoding.toUint8Array(encoder))
      },
      onAwarenessUpdate: (changes, origin) => {
        const current = registration.awareness
        if (origin === this || !current) return
        const changed = changes.added.concat(changes.updated, changes.removed)
        if (changed.length === 0) return
        this.frame(MUX.awareness, room, encodeAwarenessUpdate(current, changed))
      }
    }

    doc.on('update', registration.onDocUpdate)
    awareness?.on('update', registration.onAwarenessUpdate)
    this.registrations.set(room, registration)

    if (this.connected) this.sendSubscribe(registration)
    else this.connect()

    return whenSynced
  }

  /**
   * Starts or stops exchanging presence for a room that is already
   * registered - a note becoming shared while it is open.
   */
  setAwareness(room: string, awareness: Awareness | null): void {
    const registration = this.registrations.get(room)
    if (!registration || registration.awareness === awareness) return
    const previous = registration.awareness
    if (previous) {
      // Announce the departure while the listener is still attached, or the
      // others keep showing a caret that is no longer there.
      removeAwarenessStates(previous, [previous.clientID], 'unshare')
      previous.off('update', registration.onAwarenessUpdate)
    }
    registration.awareness = awareness
    if (awareness) {
      awareness.on('update', registration.onAwarenessUpdate)
      this.sendLocalAwareness(registration)
    }
  }

  unregister(room: string): void {
    const registration = this.registrations.get(room)
    if (!registration) return
    registration.doc.off('update', registration.onDocUpdate)
    registration.awareness?.off('update', registration.onAwarenessUpdate)
    if (registration.awareness) {
      removeAwarenessStates(
        registration.awareness,
        [registration.awareness.clientID],
        'unregister'
      )
    }
    this.registrations.delete(room)

    if (this.connected) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MUX.unsubscribe)
      encoding.writeVarString(encoder, room)
      this.send(encoding.toUint8Array(encoder))
    }
  }

  isSynced(room: string): boolean {
    return this.registrations.get(room)?.synced ?? false
  }

  /**
   * Resolves once the server state of a registered room has arrived since the
   * last (re)connect. An unregistered room never resolves: its state is
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
