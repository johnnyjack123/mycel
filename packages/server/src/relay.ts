import { createHash } from 'node:crypto'
import type { WebSocket } from 'ws'
import type { RelayFrame } from '@obsidian-connect/shared'

// Brings a device and a backup server together, so the backup server needs no
// port of its own: both connect here, and frames of a session go back and
// forth unread - inside is a session encrypted end to end, keyed by a code the
// sync server never sees. A backup server is known by the hash of a token
// derived from its code; a session is opened only by a signed-in account, so
// this is no open relay.

export interface RelayLimits {
  /** Sessions one device's connection may hold at once. */
  sessionsPerDevice: number
  /** Sessions one backup server may hold at once. */
  sessionsPerBackup: number
  /** Backup servers one address may register. */
  backupsPerAddress: number
  /** How long a backup server's connection may stay unregistered. */
  registerMs: number
}

const DEFAULT_LIMITS: RelayLimits = { sessionsPerDevice: 8, sessionsPerBackup: 64, backupsPerAddress: 16, registerMs: 10_000 }

interface Endpoint {
  ws: WebSocket
  /** The account of a device; none for a backup server. */
  account: string | null
  address: string
  route: string | null
  sessions: Set<number>
}

interface Session {
  device: Endpoint
  backup: Endpoint
}

function send(endpoint: Endpoint, frame: RelayFrame): void {
  if (endpoint.ws.readyState === endpoint.ws.OPEN) endpoint.ws.send(JSON.stringify(frame))
}

function parse(data: unknown): RelayFrame | null {
  try {
    const frame = JSON.parse(String(data)) as RelayFrame
    return frame && typeof frame === 'object' && typeof frame.t === 'string' ? frame : null
  } catch {
    return null
  }
}

export class Relay {
  private readonly backups = new Map<string, Endpoint>()
  private readonly sessions = new Map<number, Session>()
  private nextSession = 1
  private readonly limits: RelayLimits

  constructor(limits: Partial<RelayLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
  }

  /** Backup servers connected now. */
  get registered(): number {
    return this.backups.size
  }

  /** A backup server's connection; it has a moment to say who it is. */
  attachBackup(ws: WebSocket, address: string): void {
    const endpoint: Endpoint = { ws, account: null, address, route: null, sessions: new Set() }
    const timer = setTimeout(() => {
      if (!endpoint.route) ws.close(4400, 'register first')
    }, this.limits.registerMs)
    timer.unref?.()
    ws.on('message', (data) => {
      const frame = parse(data)
      if (!frame) return
      if (frame.t === 'register') this.register(endpoint, frame.token)
      else if (frame.t === 'data' || frame.t === 'close') this.fromBackup(endpoint, frame)
    })
    ws.on('close', () => {
      clearTimeout(timer)
      this.drop(endpoint)
    })
  }

  /** A signed-in device's connection. */
  attachDevice(ws: WebSocket, account: string, address: string): void {
    const endpoint: Endpoint = { ws, account, address, route: null, sessions: new Set() }
    ws.on('message', (data) => {
      const frame = parse(data)
      if (!frame) return
      if (frame.t === 'open') this.open(endpoint, frame.route, frame.ref)
      else if (frame.t === 'data' || frame.t === 'close') this.fromDevice(endpoint, frame)
    })
    ws.on('close', () => this.drop(endpoint))
  }

  private register(endpoint: Endpoint, token: unknown): void {
    const raw = typeof token === 'string' ? Buffer.from(token, 'base64') : Buffer.alloc(0)
    if (raw.length < 32 || endpoint.route) {
      endpoint.ws.close(4400, 'not a route token')
      return
    }
    const route = createHash('sha256').update(raw).digest('hex')
    const existing = this.backups.get(route)
    if (existing && existing !== endpoint) {
      // The same backup server, connected again; its old connection is gone or about to be.
      this.drop(existing)
      existing.ws.close(4409, 'connected again elsewhere')
    } else {
      const fromHere = Array.from(this.backups.values()).filter((other) => other.address === endpoint.address).length
      if (fromHere >= this.limits.backupsPerAddress) {
        endpoint.ws.close(4429, 'too many backup servers from this address')
        return
      }
    }
    endpoint.route = route
    this.backups.set(route, endpoint)
    send(endpoint, { t: 'registered', route })
  }

  private open(device: Endpoint, route: unknown, ref: unknown): void {
    const reference = typeof ref === 'number' ? ref : 0
    const backup = typeof route === 'string' ? this.backups.get(route) : undefined
    if (!backup) {
      send(device, { t: 'error', ref: reference, error: 'the backup server is not connected' })
      return
    }
    if (device.sessions.size >= this.limits.sessionsPerDevice || backup.sessions.size >= this.limits.sessionsPerBackup) {
      send(device, { t: 'error', ref: reference, error: 'too many sessions' })
      return
    }
    const id = this.nextSession
    this.nextSession += 1
    this.sessions.set(id, { device, backup })
    device.sessions.add(id)
    backup.sessions.add(id)
    send(backup, { t: 'incoming', s: id })
    send(device, { t: 'opened', ref: reference, s: id })
  }

  private fromDevice(device: Endpoint, frame: Extract<RelayFrame, { t: 'data' | 'close' }>): void {
    const session = this.sessions.get(frame.s)
    if (!session || session.device !== device) return
    if (frame.t === 'close') this.end(frame.s, session, frame.reason)
    else send(session.backup, { t: 'data', s: frame.s, d: String(frame.d) })
  }

  private fromBackup(backup: Endpoint, frame: Extract<RelayFrame, { t: 'data' | 'close' }>): void {
    const session = this.sessions.get(frame.s)
    if (!session || session.backup !== backup) return
    if (frame.t === 'close') this.end(frame.s, session, frame.reason)
    else send(session.device, { t: 'data', s: frame.s, d: String(frame.d) })
  }

  private end(id: number, session: Session, reason?: string): void {
    this.sessions.delete(id)
    session.device.sessions.delete(id)
    session.backup.sessions.delete(id)
    const frame: RelayFrame = reason ? { t: 'close', s: id, reason } : { t: 'close', s: id }
    send(session.device, frame)
    send(session.backup, frame)
  }

  private drop(endpoint: Endpoint): void {
    for (const id of Array.from(endpoint.sessions)) {
      const session = this.sessions.get(id)
      if (session) this.end(id, session, 'the other side went away')
    }
    if (endpoint.route && this.backups.get(endpoint.route) === endpoint) this.backups.delete(endpoint.route)
  }

  close(): void {
    for (const endpoint of Array.from(this.backups.values())) endpoint.ws.terminate()
    this.backups.clear()
    this.sessions.clear()
  }
}
