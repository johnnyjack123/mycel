import type { RelayFrame } from '@obsidian-connect/shared'
import {
  SessionCipher,
  backupRouteKeys,
  decodeBackupInvite,
  finishSession,
  fromBase64,
  openSession,
  sessionProof,
  type Bytes,
  type SessionAnswer,
  type SessionKeys
} from '@obsidian-connect/shared/crypto'

// A session with a backup server, through the sync server's relay, on the
// route of a secret the two share: an invitation, or the vault's pairing. The
// secret never leaves this device: the backup server proves it knows it
// before this device says anything but an ephemeral key, and this device
// proves it in turn - so a sync server that relays the session can neither
// read it nor pose as either end.

export class BackupLinkError extends Error {}

export type BackupEvent = { ev: string; p: unknown }

const OPEN_TIMEOUT_MS = 15_000
const CALL_TIMEOUT_MS = 60_000

/** `/relay` on the sync server a device signs in to. */
function relayUrl(serverUrl: string, token: string): string {
  const base = serverUrl.trim().replace(/\/+$/, '').replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
  return `${base}/relay?token=${encodeURIComponent(token)}`
}

export class BackupSession {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly listeners = new Set<(event: BackupEvent) => void>()
  private closed: string | null = null

  constructor(
    private readonly socket: WebSocket,
    private readonly session: number,
    private readonly cipher: SessionCipher,
    /** The route the session runs on. */
    readonly routeId: string
  ) {}

  /** For the link: a sealed message that arrived. */
  receive(message: { id?: number; r?: unknown; e?: string; ev?: string; p?: unknown }): void {
    if (typeof message.ev === 'string') {
      for (const listener of this.listeners) listener({ ev: message.ev, p: message.p })
      return
    }
    const waiting = typeof message.id === 'number' ? this.pending.get(message.id) : undefined
    if (!waiting) return
    this.pending.delete(message.id as number)
    clearTimeout(waiting.timer)
    if (typeof message.e === 'string') waiting.reject(new BackupLinkError(message.e))
    else waiting.resolve(message.r)
  }

  /** For the link: the session is over. */
  end(reason: string): void {
    if (this.closed) return
    this.closed = reason
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer)
      waiting.reject(new BackupLinkError(reason))
      this.pending.delete(id)
    }
  }

  get open(): boolean {
    return this.closed === null
  }

  onEvent(listener: (event: BackupEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private sending: Promise<unknown> = Promise.resolve()

  /** Sealed in order: the backup server counts every message. */
  private send(message: unknown): Promise<void> {
    const sent = this.sending.then(async () => {
      const sealed = await this.cipher.seal(JSON.stringify(message))
      const frame: RelayFrame = { t: 'data', s: this.session, d: JSON.stringify({ c: sealed }) }
      this.socket.send(JSON.stringify(frame))
    })
    this.sending = sent.catch(() => undefined)
    return sent
  }

  call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new BackupLinkError(this.closed))
    const id = this.nextId
    this.nextId += 1
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BackupLinkError('the backup server did not answer'))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.send({ id, m: method, p: params }).catch((error: unknown) => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new BackupLinkError(String(error)))
      })
    })
  }

  close(): void {
    this.end('closed')
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ t: 'close', s: this.session } satisfies RelayFrame))
      this.socket.close()
    }
  }
}

/** A session on an invitation's route: it can connect a vault, once. */
export async function openInviteSession(serverUrl: string, token: string, code: string, timeoutMs = OPEN_TIMEOUT_MS): Promise<BackupSession> {
  const secret = await decodeBackupInvite(code)
  if (!secret) throw new BackupLinkError('That is not an invitation to a backup server. Check it for a typo.')
  return openBackupSession(serverUrl, token, secret, timeoutMs)
}

/** A session on a vault's pairing route: everything about that vault's backups. */
export function openPairingSession(serverUrl: string, token: string, pairing: string, timeoutMs = OPEN_TIMEOUT_MS): Promise<BackupSession> {
  return openBackupSession(serverUrl, token, fromBase64(pairing), timeoutMs)
}

/**
 * Opens a session on the route of this secret. Rejects when nothing answers
 * the route, or what answers cannot prove it knows the secret.
 */
async function openBackupSession(serverUrl: string, token: string, secret: Bytes, timeoutMs: number): Promise<BackupSession> {
  const keys = await backupRouteKeys(secret)
  const opening = await openSession()
  const socket = new WebSocket(relayUrl(serverUrl, token))

  return new Promise<BackupSession>((resolve, reject) => {
    let sessionId = 0
    let cipher: SessionCipher | null = null
    let link: BackupSession | null = null
    let settled = false
    let work: Promise<unknown> = Promise.resolve()
    const fail = (message: string): void => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new BackupLinkError(message))
      }
      link?.end(message)
      socket.close()
    }
    const timer = setTimeout(() => fail('the backup server did not answer in time'), timeoutMs)
    const sendData = (payload: unknown): void => {
      socket.send(JSON.stringify({ t: 'data', s: sessionId, d: JSON.stringify(payload) } satisfies RelayFrame))
    }

    const handle = async (frame: RelayFrame): Promise<void> => {
      if (frame.t === 'error') {
        fail(frame.error)
        return
      }
      if (frame.t === 'opened') {
        sessionId = frame.s
        sendData({ hello: opening.hello })
        return
      }
      if (frame.t === 'close') {
        fail(frame.reason ?? 'the backup server ended the session')
        return
      }
      if (frame.t !== 'data' || frame.s !== sessionId) return
      const data = JSON.parse(frame.d) as { answer?: SessionAnswer; c?: string }
      if (!cipher) {
        if (!data.answer) {
          fail('the backup server did not answer the opening')
          return
        }
        let sessionKeys: SessionKeys
        try {
          sessionKeys = await finishSession(keys.psk, opening.pending, data.answer)
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error))
          return
        }
        cipher = new SessionCipher(sessionKeys, 'plugin')
        link = new BackupSession(socket, sessionId, cipher, keys.routeId)
        const proof = await sessionProof(keys.psk, 'plugin', sessionKeys.transcript)
        sendData({ c: await cipher.seal(JSON.stringify({ proof })) })
        return
      }
      if (typeof data.c !== 'string') return
      let message: Record<string, unknown>
      try {
        message = JSON.parse(await cipher.open(data.c)) as Record<string, unknown>
      } catch {
        fail('a message from the backup server did not open')
        return
      }
      if (!settled) {
        if (message.ok !== true || !link) {
          fail('the backup server refused the session')
          return
        }
        settled = true
        clearTimeout(timer)
        resolve(link)
        return
      }
      link?.receive(message)
    }

    socket.addEventListener('open', () => socket.send(JSON.stringify({ t: 'open', route: keys.routeId, ref: 1 } satisfies RelayFrame)))
    socket.addEventListener('message', (event) => {
      let frame: RelayFrame
      try {
        frame = JSON.parse(String(event.data)) as RelayFrame
      } catch {
        return
      }
      // In order: the cipher counts every message.
      work = work.then(() => handle(frame)).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
    })
    socket.addEventListener('close', () => fail('the connection to the sync server closed'))
    socket.addEventListener('error', () => undefined)
  })
}
