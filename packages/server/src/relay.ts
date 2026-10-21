import { createHash } from 'node:crypto'
import type { WebSocket } from 'ws'
import type { RelayFrame } from '@obsidian-connect/shared'
import { heartbeat } from './wshub.js'

// Brings a device and a backup server together, so the backup server needs no
// port of its own: both connect here, and frames of a session go back and
// forth unread - inside is a session encrypted end to end, keyed by a secret
// the sync server never sees. A backup server registers one route per secret
// it answers - an open invitation, a paired vault -, each known only by the
// hash of a token derived from that secret. A session is opened only by a
// signed-in account, so this is no open relay.

export interface RelayLimits {
  /** Sessions one device's connection may hold at once. */
  sessionsPerDevice: number
  /** Sessions one backup server may hold at once. */
  sessionsPerBackup: number
  /** Backup servers one address may connect. */
  backupsPerAddress: number
  /** Routes one backup server may register: its invitations and paired vaults. */
  routesPerBackup: number
  /** How long a backup server's connection may stay without a route. */
  registerMs: number
  /** How often every connection is pinged; one that does not answer by the next ping is let go. */
  pingMs: number
}

const DEFAULT_LIMITS: RelayLimits = {
  sessionsPerDevice: 8,
  sessionsPerBackup: 64,
  backupsPerAddress: 16,
  routesPerBackup: 1024,
  registerMs: 10_000,
  pingMs: 30_000
}

interface Endpoint {
  ws: WebSocket
  /** The account of a device; none for a backup server. */
  account: string | null
  address: string
  /** A backup server's routes. */
  routes: Set<string>
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
  /** Route -> the backup server answering it. */
  private readonly routes = new Map<string, Endpoint>()
  private readonly backups = new Set<Endpoint>()
  private readonly sessions = new Map<number, Session>()
  /** Session -> the route it was opened on. */
  private readonly sessionRoutes = new Map<number, string>()
  private nextSession = 1
  private readonly limits: RelayLimits

  constructor(limits: Partial<RelayLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
  }

  /** Routes answered now. */
  get registered(): number {
    return this.routes.size
  }

  /** A backup server's connection; it has a moment to register a route. */
  attachBackup(ws: WebSocket, address: string): void {
    const endpoint: Endpoint = { ws, account: null, address, routes: new Set(), sessions: new Set() }
    const fromHere = Array.from(this.backups).filter((other) => other.address === address).length
    if (fromHere >= this.limits.backupsPerAddress) {
      ws.close(4429, 'too many backup servers from this address')
      return
    }
    this.backups.add(endpoint)
    const timer = setTimeout(() => {
      if (endpoint.routes.size === 0) ws.close(4400, 'register first')
    }, this.limits.registerMs)
    timer.unref?.()
    // A backup server waits for devices for hours with nothing to say; behind a
    // reverse proxy its connection went every minute, and with it every route.
    const stopHeartbeat = heartbeat(ws, () => this.drop(endpoint), this.limits.pingMs)
    ws.on('message', (data) => {
      const frame = parse(data)
      if (!frame) return
      if (frame.t === 'register') this.register(endpoint, frame.token)
      else if (frame.t === 'unregister') this.unregister(endpoint, frame.route)
      else if (frame.t === 'data' || frame.t === 'close') this.fromBackup(endpoint, frame)
    })
    ws.on('close', () => {
      clearTimeout(timer)
      stopHeartbeat()
      this.drop(endpoint)
    })
  }

  /** A signed-in device's connection. */
  attachDevice(ws: WebSocket, account: string, address: string): void {
    const endpoint: Endpoint = { ws, account, address, routes: new Set(), sessions: new Set() }
    const stopHeartbeat = heartbeat(ws, () => this.drop(endpoint), this.limits.pingMs)
    ws.on('message', (data) => {
      const frame = parse(data)
      if (!frame) return
      if (frame.t === 'open') this.open(endpoint, frame.route, frame.ref)
      else if (frame.t === 'data' || frame.t === 'close') this.fromDevice(endpoint, frame)
    })
    ws.on('close', () => {
      stopHeartbeat()
      this.drop(endpoint)
    })
  }

  private register(endpoint: Endpoint, token: unknown): void {
    const raw = typeof token === 'string' ? Buffer.from(token, 'base64') : Buffer.alloc(0)
    if (raw.length < 32) {
      endpoint.ws.close(4400, 'not a route token')
      return
    }
    const route = createHash('sha256').update(raw).digest('hex')
    const existing = this.routes.get(route)
    if (existing && existing !== endpoint) {
      // The same backup server, connected again; the route moves to the new connection.
      existing.routes.delete(route)
      this.endSessionsOn(existing, route)
      if (existing.routes.size === 0) existing.ws.close(4409, 'replaced by a new connection')
    } else if (!existing && endpoint.routes.size >= this.limits.routesPerBackup) {
      endpoint.ws.close(4429, 'too many routes')
      return
    }
    endpoint.routes.add(route)
    this.routes.set(route, endpoint)
    send(endpoint, { t: 'registered', route })
  }

  private unregister(endpoint: Endpoint, route: unknown): void {
    if (typeof route !== 'string' || this.routes.get(route) !== endpoint) return
    this.routes.delete(route)
    endpoint.routes.delete(route)
    this.endSessionsOn(endpoint, route)
  }

  private endSessionsOn(endpoint: Endpoint, route: string): void {
    for (const id of Array.from(endpoint.sessions)) {
      const session = this.sessions.get(id)
      if (session && this.sessionRoutes.get(id) === route) this.end(id, session, 'the route went away')
    }
  }

  private open(device: Endpoint, route: unknown, ref: unknown): void {
    const reference = typeof ref === 'number' ? ref : 0
    const backup = typeof route === 'string' ? this.routes.get(route) : undefined
    if (!backup || typeof route !== 'string') {
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
    this.sessionRoutes.set(id, route)
    device.sessions.add(id)
    backup.sessions.add(id)
    send(backup, { t: 'incoming', s: id, route })
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
    this.sessionRoutes.delete(id)
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
    for (const route of endpoint.routes) {
      if (this.routes.get(route) === endpoint) this.routes.delete(route)
    }
    endpoint.routes.clear()
    this.backups.delete(endpoint)
  }

  close(): void {
    for (const endpoint of Array.from(this.backups)) endpoint.ws.terminate()
    this.backups.clear()
    this.routes.clear()
    this.sessions.clear()
    this.sessionRoutes.clear()
  }
}
