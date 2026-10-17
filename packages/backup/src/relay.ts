import type { RelayFrame } from '@obsidian-connect/shared'
import { log } from './log.js'
import { explainUnreachable } from './probe.js'

// The backup server's one connection to the sync server's relay. It answers a
// route for every open invitation and every paired vault, each registered by
// the token derived from its secret, and waits there for devices to open
// sessions. It only ever connects outward, so it needs no port of its own -
// and only while it has a route to answer. Lost connections are made again,
// with growing pauses.

export interface IncomingSession {
  readonly id: number
  /** The route it was opened on: which invitation or vault it is about. */
  readonly route: string
  send(data: string): void
  close(reason?: string): void
  onData(listener: (data: string) => void): void
  onClose(listener: () => void): void
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]

/** `ws://host:port` or `wss://…`, as devices are given it; `http(s)://` works too. */
function relayUrl(server: string): string {
  const base = server.trim().replace(/\/+$/, '').replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
  return `${base}/relay?role=backup`
}

/** How the connection to the relay stands, for `status` and an invitation just made. */
export interface RelayState {
  connected: boolean
  /** Why it is not connected, as the last attempt failed; null while it is, or before any attempt. */
  error: string | null
  /** When `connected` last changed. */
  since: number
  /** The routes the relay answers for this backup server now. */
  registered: string[]
}

/** What a failed WebSocket says about why, as far as Node's says anything. */
function reasonOf(event: unknown): string | null {
  const detail = event as { message?: unknown; error?: { message?: unknown; cause?: { code?: unknown; message?: unknown } } }
  const text = detail.error?.cause?.message ?? detail.error?.cause?.code ?? detail.error?.message ?? detail.message
  return typeof text === 'string' && text !== '' ? text : null
}

export class RelayLink {
  private socket: WebSocket | null = null
  private stopped = false
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private status = { connected: false, error: null as string | null, since: Date.now() }
  private lastError: string | null = null
  /** What asking the sync server over HTTP last found, said once in the log. */
  private explained: string | null = null
  private readonly stateListeners = new Set<() => void>()
  /** Route id -> its token, base64: what this backup server answers. */
  private wanted = new Map<string, string>()
  private readonly registered = new Set<string>()
  private readonly waiters = new Map<string, Array<() => void>>()
  private readonly sessions = new Map<number, { data: Array<(data: string) => void>; close: Array<() => void> }>()

  constructor(
    private readonly server: string,
    private readonly incoming: (session: IncomingSession) => void
  ) {}

  /** The routes to answer from now on; new ones are registered, gone ones dropped. */
  setRoutes(routes: ReadonlyMap<string, string>): void {
    const before = this.wanted
    this.wanted = new Map(routes)
    if (this.stopped) return
    if (this.wanted.size === 0) {
      // Nothing to answer: no connection, until there is.
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      const socket = this.socket
      this.socket = null
      this.registered.clear()
      this.closeAll()
      socket?.close()
      if (this.status.connected) this.changed({ connected: false, error: null })
      return
    }
    if (!this.socket) {
      if (!this.timer) this.connect()
      return
    }
    if (this.socket.readyState !== WebSocket.OPEN) return
    for (const [route, token] of this.wanted) if (!before.has(route)) this.send({ t: 'register', token })
    for (const route of before.keys()) {
      if (this.wanted.has(route)) continue
      this.registered.delete(route)
      this.send({ t: 'unregister', route })
    }
  }

  state(): RelayState {
    return { ...this.status, registered: Array.from(this.registered) }
  }

  /** Fires when the connection opens or closes, or a route is answered. */
  onState(listener: () => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  private changed(patch: Partial<typeof this.status>): void {
    const connected = patch.connected ?? this.status.connected
    this.status = { ...this.status, ...patch, since: connected !== this.status.connected ? Date.now() : this.status.since }
    for (const listener of this.stateListeners) listener()
  }

  /** Resolves once the relay answers this route for this backup server. */
  whenRegistered(route: string): Promise<void> {
    if (this.registered.has(route)) return Promise.resolve()
    return new Promise((resolve) => {
      const list = this.waiters.get(route) ?? []
      list.push(resolve)
      this.waiters.set(route, list)
    })
  }

  start(): void {
    this.stopped = false
    if (this.wanted.size > 0) this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.socket?.close()
    this.socket = null
    this.registered.clear()
    this.closeAll()
  }

  private send(frame: RelayFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame))
  }

  private retry(why: string): void {
    this.changed({ connected: false, error: why })
    if (this.stopped || this.wanted.size === 0) return
    const pause = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] as number
    // With the pauses growing to a minute, this says so at most once a minute.
    log.warn(`the sync server at ${relayUrl(this.server)} cannot be reached: ${why}; trying again in ${pause / 1000} s`)
    this.attempt += 1
    this.timer = setTimeout(() => this.connect(), pause)
  }

  /** Asks the sync server over HTTP why the WebSocket failed, and says so where it is shown. */
  private async explain(why: string): Promise<void> {
    const found = await explainUnreachable(this.server).catch(() => null)
    if (!found || this.status.connected || this.stopped) return
    this.changed({ error: `${why}: ${found}` })
    if (found !== this.explained) log.warn(`the sync server at ${this.server}: ${found}`)
    this.explained = found
  }

  private connect(): void {
    this.timer = null
    if (this.stopped || this.wanted.size === 0) return
    let socket: WebSocket
    try {
      socket = new WebSocket(relayUrl(this.server))
    } catch (error) {
      // An address WebSocket cannot even parse: said, and tried again, as for any other failure.
      this.retry(error instanceof Error ? error.message : String(error))
      return
    }
    this.socket = socket
    this.lastError = null
    socket.addEventListener('open', () => {
      this.explained = null
      this.changed({ connected: true, error: null })
      for (const token of this.wanted.values()) this.send({ t: 'register', token })
    })
    socket.addEventListener('message', (event) => this.receive(String(event.data)))
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return
      this.socket = null
      this.registered.clear()
      this.closeAll()
      const why = event.reason ? `${event.reason} (${event.code})` : (this.lastError ?? `the connection closed (${event.code})`)
      this.retry(why)
      // "Closed (1006)" alone helped nobody - wss:// on the sync server's own port looked exactly like that.
      if (!event.reason && !this.lastError) void this.explain(why)
    })
    // An error is followed by a close, which tries again; it only says why.
    socket.addEventListener('error', (event) => {
      this.lastError = reasonOf(event) ?? this.lastError
    })
  }

  private receive(raw: string): void {
    let frame: RelayFrame
    try {
      frame = JSON.parse(raw) as RelayFrame
    } catch {
      return
    }
    if (frame.t === 'registered') {
      if (this.attempt > 0 || this.registered.size === 0) log.info('connected to the sync server, waiting for devices')
      this.attempt = 0
      this.registered.add(frame.route)
      for (const resolve of this.waiters.get(frame.route) ?? []) resolve()
      this.waiters.delete(frame.route)
      this.changed({})
    } else if (frame.t === 'incoming') {
      this.open(frame.s, frame.route)
    } else if (frame.t === 'data') {
      for (const listener of this.sessions.get(frame.s)?.data ?? []) listener(frame.d)
    } else if (frame.t === 'close') {
      this.ended(frame.s)
    }
  }

  private open(id: number, route: string): void {
    const listeners = { data: [] as Array<(data: string) => void>, close: [] as Array<() => void> }
    this.sessions.set(id, listeners)
    this.incoming({
      id,
      route,
      send: (data) => this.send({ t: 'data', s: id, d: data }),
      close: (reason) => {
        this.send(reason ? { t: 'close', s: id, reason } : { t: 'close', s: id })
        this.ended(id)
      },
      onData: (listener) => listeners.data.push(listener),
      onClose: (listener) => listeners.close.push(listener)
    })
  }

  private ended(id: number): void {
    const listeners = this.sessions.get(id)
    if (!listeners) return
    this.sessions.delete(id)
    for (const listener of listeners.close) listener()
  }

  private closeAll(): void {
    for (const id of Array.from(this.sessions.keys())) this.ended(id)
  }
}
