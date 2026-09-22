import { join } from 'node:path'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import {
  CONTENT_FIELD,
  applyTextEdits,
  textEdits,
  type RoomSummary
} from '@obsidian-connect/shared'
import { HistoryStore } from './history.js'
import { Y } from './yjs.js'

// Rooms used to be handled by `y-websocket/bin/utils`, which opens one socket
// per room and owns its own persistence. Syncing a whole vault needs many
// documents over one connection and a history log, so the room layer is ours.

/** A transport that wants a room's traffic. One socket may hold many. */
export interface RoomSubscriber {
  sendSync(room: string, payload: Uint8Array): void
  sendAwareness(room: string, payload: Uint8Array): void
}

interface RoomState {
  name: string
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  history: HistoryStore
  subscribers: Set<RoomSubscriber>
  awarenessClients: Map<RoomSubscriber, Set<number>>
  ready: Promise<void>
  idleTimer: NodeJS.Timeout | null
}

const IDLE_CLOSE_MS = 30_000
const HISTORY_ORIGIN = 'history'

export interface RoomManagerOptions {
  dataDir: string
  historyRetentionDays: number
  logUpdates?: boolean
  /** How long an unused room stays in memory. */
  idleCloseMs?: number
}

export class RoomManager {
  private readonly rooms = new Map<string, RoomState>()

  constructor(private readonly options: RoomManagerOptions) {}

  private roomDir(name: string): string {
    return join(this.options.dataDir, encodeURIComponent(name))
  }

  private create(name: string): RoomState {
    const doc = new Y.Doc()
    const awareness = new awarenessProtocol.Awareness(doc)
    awareness.setLocalState(null)
    const history = new HistoryStore(this.roomDir(name))

    const room: RoomState = {
      name,
      doc,
      awareness,
      history,
      subscribers: new Set(),
      awarenessClients: new Map(),
      ready: history.load(doc),
      idleTimer: null
    }

    doc.on('update', (update: Uint8Array, origin: unknown) => {
      // Replayed history is already on disk; appending it again would grow the
      // log without adding a single new version.
      if (origin === HISTORY_ORIGIN) return
      void history.append(update)
      if (this.options.logUpdates) {
        console.info(`[obsidian-connect] ${name}: +${update.length}B -> ${room.subscribers.size - 1} peer(s)`)
      }
      const encoder = encoding.createEncoder()
      syncProtocol.writeUpdate(encoder, update)
      const payload = encoding.toUint8Array(encoder)
      for (const subscriber of room.subscribers) {
        if (subscriber !== origin) subscriber.sendSync(name, payload)
      }
    })

    awareness.on(
      'update',
      (
        changes: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown
      ) => {
        const changed = changes.added.concat(changes.updated, changes.removed)
        if (changed.length === 0) return
        const owned = this.trackAwareness(room, origin, changes)
        if (owned === false) return
        const payload = awarenessProtocol.encodeAwarenessUpdate(awareness, changed)
        for (const subscriber of room.subscribers) {
          if (subscriber !== origin) subscriber.sendAwareness(name, payload)
        }
      }
    )

    this.rooms.set(name, room)
    return room
  }

  private trackAwareness(
    room: RoomState,
    origin: unknown,
    changes: { added: number[]; removed: number[] }
  ): boolean {
    if (!origin || typeof origin !== 'object') return true
    const owned = room.awarenessClients.get(origin as RoomSubscriber)
    if (!owned) return true
    for (const client of changes.added) owned.add(client)
    for (const client of changes.removed) owned.delete(client)
    return true
  }

  private async open(name: string): Promise<RoomState> {
    const existing = this.rooms.get(name)
    const room = existing ?? this.create(name)
    if (room.idleTimer) {
      clearTimeout(room.idleTimer)
      room.idleTimer = null
    }
    await room.ready
    return room
  }

  async subscribe(name: string, subscriber: RoomSubscriber): Promise<void> {
    const room = await this.open(name)
    room.subscribers.add(subscriber)
    room.awarenessClients.set(subscriber, new Set())

    const sync = encoding.createEncoder()
    syncProtocol.writeSyncStep1(sync, room.doc)
    subscriber.sendSync(name, encoding.toUint8Array(sync))

    const states = room.awareness.getStates()
    if (states.size > 0) {
      subscriber.sendAwareness(
        name,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(states.keys()))
      )
    }
  }

  unsubscribe(name: string, subscriber: RoomSubscriber): void {
    const room = this.rooms.get(name)
    if (!room) return
    room.subscribers.delete(subscriber)
    const owned = room.awarenessClients.get(subscriber)
    room.awarenessClients.delete(subscriber)
    if (owned && owned.size > 0) {
      awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(owned), null)
    }
    if (room.subscribers.size === 0) this.scheduleIdleClose(room)
  }

  unsubscribeAll(subscriber: RoomSubscriber): void {
    for (const name of Array.from(this.rooms.keys())) {
      this.unsubscribe(name, subscriber)
    }
  }

  // No snapshot on close. Replaying to a timestamp starts from the snapshot,
  // so a snapshot of the current state made every earlier version read as the
  // latest one and turned every restore into a no-op. The snapshot may only
  // ever hold what `prune` folded out of the log.
  private scheduleIdleClose(room: RoomState): void {
    if (room.idleTimer) clearTimeout(room.idleTimer)
    room.idleTimer = setTimeout(() => {
      if (room.subscribers.size > 0) return
      void room.history
        .flush()
        .finally(() => {
          if (room.subscribers.size > 0) return
          this.rooms.delete(room.name)
          room.doc.destroy()
        })
    }, this.options.idleCloseMs ?? IDLE_CLOSE_MS)
    room.idleTimer.unref?.()
  }

  async handleSync(name: string, body: Uint8Array, subscriber: RoomSubscriber): Promise<void> {
    const room = await this.open(name)
    const decoder = decoding.createDecoder(body)
    const encoder = encoding.createEncoder()
    syncProtocol.readSyncMessage(decoder, encoder, room.doc, subscriber)
    if (encoding.length(encoder) > 0) {
      subscriber.sendSync(name, encoding.toUint8Array(encoder))
    }
  }

  async handleAwareness(name: string, body: Uint8Array, subscriber: RoomSubscriber): Promise<void> {
    const room = await this.open(name)
    awarenessProtocol.applyAwarenessUpdate(room.awareness, body, subscriber)
  }

  async summaries(): Promise<RoomSummary[]> {
    const summaries: RoomSummary[] = []
    for (const room of this.rooms.values()) {
      summaries.push({
        name: room.name,
        connections: room.subscribers.size,
        chars: room.doc.getText(CONTENT_FIELD).length,
        versions: (await room.history.versions()).length
      })
    }
    return summaries
  }

  async versions(name: string): Promise<{ ts: number; bytes: number }[]> {
    const room = await this.open(name)
    return room.history.versions()
  }

  async textAt(name: string, ts: number): Promise<string> {
    const room = await this.open(name)
    return room.history.textAt(ts)
  }

  /**
   * Restores by editing the live document rather than replacing it, so the
   * rollback reaches every connected client through the normal sync path and
   * is itself recorded as a new version - a restore can be undone.
   */
  async restore(name: string, ts: number): Promise<number> {
    const room = await this.open(name)
    const previous = await room.history.textAt(ts)
    const ytext = room.doc.getText(CONTENT_FIELD)
    const edits = textEdits(ytext.toString(), previous)
    if (edits.length > 0) {
      room.doc.transact(() => applyTextEdits(ytext, edits), 'restore')
    }
    return ytext.length
  }

  async pruneAll(): Promise<number> {
    const retention = this.options.historyRetentionDays
    if (retention <= 0) return 0
    let pruned = 0
    for (const room of this.rooms.values()) {
      if (await room.history.prune(retention)) pruned += 1
    }
    return pruned
  }

  async shutdown(): Promise<void> {
    for (const room of this.rooms.values()) {
      if (room.idleTimer) clearTimeout(room.idleTimer)
      await room.history.flush()
      room.doc.destroy()
    }
    this.rooms.clear()
  }
}
