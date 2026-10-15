import type { RelayFrame } from '@obsidian-connect/shared'
import { toBase64 } from '@obsidian-connect/shared/crypto'
import type { Identity } from './identity.js'
import { log } from './log.js'

// The backup server's one connection to the sync server's relay: registered
// under the route token from its code, it waits there for devices to open
// sessions. It only ever connects outward, so it needs no port of its own.
// Lost connections are made again, with growing pauses.

export interface IncomingSession {
  readonly id: number
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

export class RelayLink {
  private socket: WebSocket | null = null
  private stopped = false
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly sessions = new Map<number, { data: Array<(data: string) => void>; close: Array<() => void> }>()
  private registeredOnce: (() => void) | null = null
  /** Resolves once the relay accepted the registration the first time. */
  readonly registered: Promise<void>

  constructor(
    private readonly server: string,
    private readonly identity: Identity,
    private readonly incoming: (session: IncomingSession) => void
  ) {
    this.registered = new Promise((resolve) => {
      this.registeredOnce = resolve
    })
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.socket?.close()
    this.socket = null
    this.closeAll()
  }

  private connect(): void {
    if (this.stopped) return
    const socket = new WebSocket(relayUrl(this.server))
    this.socket = socket
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ t: 'register', token: toBase64(this.identity.keys.routeToken) } satisfies RelayFrame))
    })
    socket.addEventListener('message', (event) => this.receive(String(event.data)))
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.closeAll()
      if (this.stopped) return
      const pause = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] as number
      this.attempt += 1
      this.timer = setTimeout(() => this.connect(), pause)
      this.timer.unref?.()
    })
    // An error is followed by a close, which tries again.
    socket.addEventListener('error', () => undefined)
  }

  private receive(raw: string): void {
    let frame: RelayFrame
    try {
      frame = JSON.parse(raw) as RelayFrame
    } catch {
      return
    }
    if (frame.t === 'registered') {
      this.attempt = 0
      log.info('connected to the sync server, waiting for devices')
      this.registeredOnce?.()
      this.registeredOnce = null
    } else if (frame.t === 'incoming') {
      this.open(frame.s)
    } else if (frame.t === 'data') {
      for (const listener of this.sessions.get(frame.s)?.data ?? []) listener(frame.d)
    } else if (frame.t === 'close') {
      this.ended(frame.s)
    }
  }

  private open(id: number): void {
    const listeners = { data: [] as Array<(data: string) => void>, close: [] as Array<() => void> }
    this.sessions.set(id, listeners)
    const send = (frame: RelayFrame): void => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame))
    }
    this.incoming({
      id,
      send: (data) => send({ t: 'data', s: id, d: data }),
      close: (reason) => {
        send(reason ? { t: 'close', s: id, reason } : { t: 'close', s: id })
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
