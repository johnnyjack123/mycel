import type { WebSocket } from 'ws'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { MUX, indexRoom, isDocRoom } from '@obsidian-connect/shared'
import type { RoomManager, RoomSubscriber } from './rooms.js'

const WS_OPEN = 1
const WS_CONNECTING = 0
const PING_INTERVAL_MS = 30_000

// Legacy single-room wire format, as spoken by the `y-websocket` client that
// the relay self-test uses. Note the asymmetry: a sync body is appended raw,
// an awareness body is length-prefixed.
const LEGACY_SYNC = 0
const LEGACY_AWARENESS = 1

function send(ws: WebSocket, data: Uint8Array): void {
  if (ws.readyState !== WS_OPEN && ws.readyState !== WS_CONNECTING) return
  try {
    ws.send(data)
  } catch {
    ws.close()
  }
}

function toUint8Array(message: unknown): Uint8Array {
  if (message instanceof ArrayBuffer) return new Uint8Array(message)
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
  }
  if (Array.isArray(message)) return new Uint8Array(Buffer.concat(message as Buffer[]))
  return new Uint8Array(0)
}

/** Keeps message handling in arrival order even though room access is async. */
function serializer(): (task: () => Promise<void>) => void {
  let chain: Promise<void> = Promise.resolve()
  return (task) => {
    chain = chain.then(task).catch((error) => {
      console.error('[obsidian-connect] websocket message failed', error)
    })
  }
}

function heartbeat(ws: WebSocket, onDead: () => void): () => void {
  let alive = true
  ws.on('pong', () => {
    alive = true
  })
  const timer = setInterval(() => {
    if (!alive) {
      onDead()
      ws.terminate()
      clearInterval(timer)
      return
    }
    alive = false
    try {
      ws.ping()
    } catch {
      clearInterval(timer)
    }
  }, PING_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

class SingleRoomConnection implements RoomSubscriber {
  constructor(
    private readonly ws: WebSocket,
    private readonly room: string
  ) {}

  sendSync(_room: string, payload: Uint8Array): void {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, LEGACY_SYNC)
    encoding.writeUint8Array(encoder, payload)
    send(this.ws, encoding.toUint8Array(encoder))
  }

  sendAwareness(_room: string, payload: Uint8Array): void {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, LEGACY_AWARENESS)
    encoding.writeVarUint8Array(encoder, payload)
    send(this.ws, encoding.toUint8Array(encoder))
  }

  get name(): string {
    return this.room
  }
}

export function setupSingleRoomConnection(
  ws: WebSocket,
  room: string,
  rooms: RoomManager
): void {
  ws.binaryType = 'arraybuffer'
  const connection = new SingleRoomConnection(ws, room)
  const queue = serializer()
  const stopHeartbeat = heartbeat(ws, () => rooms.unsubscribeAll(connection))

  queue(() => rooms.subscribe(room, connection))

  ws.on('message', (raw: unknown) => {
    const message = toUint8Array(raw)
    if (message.length === 0) return
    queue(async () => {
      const decoder = decoding.createDecoder(message)
      const type = decoding.readVarUint(decoder)
      if (type === LEGACY_SYNC) {
        await rooms.handleSync(room, decoding.readTailAsUint8Array(decoder), connection)
      } else if (type === LEGACY_AWARENESS) {
        await rooms.handleAwareness(room, decoding.readVarUint8Array(decoder), connection)
      }
    })
  })

  ws.on('close', () => {
    stopHeartbeat()
    rooms.unsubscribe(room, connection)
  })
}

class VaultConnection implements RoomSubscriber {
  readonly subscribed = new Set<string>()

  constructor(private readonly ws: WebSocket) {}

  private frame(type: number, room: string, payload: Uint8Array): void {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, type)
    encoding.writeVarString(encoder, room)
    encoding.writeVarUint8Array(encoder, payload)
    send(this.ws, encoding.toUint8Array(encoder))
  }

  sendSync(room: string, payload: Uint8Array): void {
    this.frame(MUX.sync, room, payload)
  }

  sendAwareness(room: string, payload: Uint8Array): void {
    this.frame(MUX.awareness, room, payload)
  }

  sendError(message: string): void {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MUX.error)
    encoding.writeVarString(encoder, message)
    send(this.ws, encoding.toUint8Array(encoder))
  }
}

/**
 * One socket carries every note of a vault. A connection per note would mean
 * thousands of sockets for a normal vault, which neither the browser nor the
 * server survives.
 */
export function setupVaultConnection(ws: WebSocket, vaultId: string, rooms: RoomManager): void {
  ws.binaryType = 'arraybuffer'
  const connection = new VaultConnection(ws)
  const queue = serializer()
  const stopHeartbeat = heartbeat(ws, () => rooms.unsubscribeAll(connection))

  const allowed = (room: string): boolean => isDocRoom(room) || room === indexRoom(vaultId)

  ws.on('message', (raw: unknown) => {
    const message = toUint8Array(raw)
    if (message.length === 0) return
    queue(async () => {
      const decoder = decoding.createDecoder(message)
      const type = decoding.readVarUint(decoder)
      if (type === MUX.error) return

      const room = decoding.readVarString(decoder)
      if (!allowed(room)) {
        connection.sendError(`room "${room}" is not part of this vault`)
        return
      }

      switch (type) {
        case MUX.subscribe:
          if (connection.subscribed.has(room)) return
          connection.subscribed.add(room)
          await rooms.subscribe(room, connection)
          return
        case MUX.unsubscribe:
          connection.subscribed.delete(room)
          rooms.unsubscribe(room, connection)
          return
        case MUX.sync:
          await rooms.handleSync(room, decoding.readVarUint8Array(decoder), connection)
          return
        case MUX.awareness:
          await rooms.handleAwareness(room, decoding.readVarUint8Array(decoder), connection)
          return
        default:
          return
      }
    })
  })

  ws.on('close', () => {
    stopHeartbeat()
    for (const room of connection.subscribed) rooms.unsubscribe(room, connection)
    connection.subscribed.clear()
  })
}
