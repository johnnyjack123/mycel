import type { WebSocket } from 'ws'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { MUX, type FolderTie, type Notice, type NotifyKind } from '@obsidian-connect/shared'
import type { Frame } from './log.js'
import type { RoomClient, RoomHub } from './rooms.js'

const WS_OPEN = 1
const WS_CONNECTING = 0
const PING_INTERVAL_MS = 30_000

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

/**
 * Pings a connection now and then, and ends it when the last ping went
 * unanswered. Also what keeps it open behind a reverse proxy: nginx closes a
 * WebSocket the server sent nothing on for a minute.
 */
export function heartbeat(ws: WebSocket, onDead: () => void, intervalMs = PING_INTERVAL_MS): () => void {
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
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** Trailing, so a plugin before shared folders reads the message as it always did. */
function writeTie(encoder: encoding.Encoder, tie: FolderTie | null): void {
  if (!tie) return
  encoding.writeVarString(encoder, tie.folder)
  encoding.writeVarUint(encoder, tie.epoch)
}

class VaultConnection implements RoomClient {
  constructor(
    private readonly ws: WebSocket,
    readonly account: string,
    readonly vaultId: string
  ) {}

  private message(type: number, room: string | null, write: (encoder: encoding.Encoder) => void): void {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, type)
    if (room !== null) encoding.writeVarString(encoder, room)
    write(encoder)
    send(this.ws, encoding.toUint8Array(encoder))
  }

  sendFrame(room: string, frame: Frame): void {
    this.message(MUX.frame, room, (encoder) => {
      encoding.writeVarUint(encoder, frame.seq)
      encoding.writeVarUint(encoder, frame.ts)
      encoding.writeVarUint(encoder, frame.epoch)
      encoding.writeVarUint8Array(encoder, frame.data)
    })
  }

  sendSnapshot(room: string, uptoSeq: number, epoch: number, data: Uint8Array): void {
    this.message(MUX.snapshot, room, (encoder) => {
      encoding.writeVarUint(encoder, uptoSeq)
      encoding.writeVarUint(encoder, epoch)
      encoding.writeVarUint8Array(encoder, data)
    })
  }

  sendCaughtUp(room: string, headSeq: number, epoch: number, tie: FolderTie | null): void {
    this.message(MUX.caughtUp, room, (encoder) => {
      encoding.writeVarUint(encoder, headSeq)
      encoding.writeVarUint(encoder, epoch)
      writeTie(encoder, tie)
    })
  }

  sendAck(room: string, ref: number, seq: number): void {
    this.message(MUX.ack, room, (encoder) => {
      encoding.writeVarUint(encoder, ref)
      encoding.writeVarUint(encoder, seq)
    })
  }

  sendAwareness(room: string, epoch: number, data: Uint8Array): void {
    this.message(MUX.awareness, room, (encoder) => {
      encoding.writeVarUint(encoder, epoch)
      encoding.writeVarUint8Array(encoder, data)
    })
  }

  sendRekey(room: string, epoch: number, tie: FolderTie | null): void {
    this.message(MUX.rekey, room, (encoder) => {
      encoding.writeVarUint(encoder, epoch)
      writeTie(encoder, tie)
    })
  }

  sendRevoked(room: string, reason: string): void {
    this.message(MUX.revoked, room, (encoder) => encoding.writeVarString(encoder, reason))
  }

  sendDenied(room: string, reason: string): void {
    this.message(MUX.denied, room, (encoder) => encoding.writeVarString(encoder, reason))
  }

  sendLocked(room: string, ref: number): void {
    this.message(MUX.locked, room, (encoder) => encoding.writeVarUint(encoder, ref))
  }

  sendNotify(kind: NotifyKind, payload: Notice): void {
    this.message(MUX.notify, null, (encoder) => {
      encoding.writeVarString(encoder, kind)
      encoding.writeVarString(encoder, JSON.stringify(payload))
    })
  }

  sendError(message: string): void {
    this.message(MUX.error, null, (encoder) => encoding.writeVarString(encoder, message))
  }

  close(code: number, reason: string): void {
    this.ws.close(code, reason)
  }
}

/**
 * One socket carries every note of a vault. The upgrade already checked that
 * the account owns the vault; each room is checked again on subscribe.
 */
export function setupVaultConnection(ws: WebSocket, account: string, vaultId: string, hub: RoomHub): void {
  ws.binaryType = 'arraybuffer'
  const connection = new VaultConnection(ws, account, vaultId)
  const queue = serializer()
  hub.attach(connection)
  const stopHeartbeat = heartbeat(ws, () => hub.detach(connection))

  ws.on('message', (raw: unknown) => {
    const message = toUint8Array(raw)
    if (message.length === 0) return
    queue(async () => {
      const decoder = decoding.createDecoder(message)
      const type = decoding.readVarUint(decoder)
      const room = decoding.readVarString(decoder)
      switch (type) {
        case MUX.subscribe: {
          const afterSeq = decoding.readVarUint(decoder)
          const create = decoding.readVarUint(decoder) === 1
          // A plugin before shared folders sends no folder.
          const folder = decoding.hasContent(decoder) ? decoding.readVarString(decoder) : undefined
          await hub.subscribe(connection, room, afterSeq, create, folder)
          return
        }
        case MUX.unsubscribe:
          hub.unsubscribe(connection, room)
          return
        case MUX.push: {
          const ref = decoding.readVarUint(decoder)
          const epoch = decoding.readVarUint(decoder)
          await hub.push(connection, room, ref, epoch, decoding.readVarUint8Array(decoder))
          return
        }
        case MUX.awareness: {
          const epoch = decoding.readVarUint(decoder)
          hub.awareness(connection, room, epoch, decoding.readVarUint8Array(decoder))
          return
        }
        case MUX.holdLock:
          if (!hub.holdLock(connection, decoding.readVarString(decoder))) connection.sendError('no such lock')
          return
        default:
          connection.sendError(`unknown message type ${type}`)
      }
    })
  })

  ws.on('close', () => {
    stopHeartbeat()
    hub.detach(connection)
  })
}
