import {
  API,
  type BackupRoomsResponse,
  type BackupSessionResponse,
  type BlobInfo,
  type KeysResponse,
  type LogResponse
} from '@obsidian-connect/shared'

// The backup server's side of the sync server's REST API: signing in with a
// backup key, and reading. A backup token writes nothing, so there is nothing
// here that could.

/** The sync server took the backup key away: deleted, or ended by a password change. */
export class AccessEnded extends Error {
  constructor() {
    super('the backup key no longer opens the vault')
  }
}

export class SyncError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

/** Waits before sending a request again after the network failed. */
const RETRIES = [250, 1_000, 3_000]

/** The REST endpoint behind a `ws://` or `wss://` address. */
export function httpBase(server: string): string {
  const trimmed = server.trim().replace(/\/+$/, '')
  if (trimmed.startsWith('wss://')) return `https://${trimmed.slice('wss://'.length)}`
  if (trimmed.startsWith('ws://')) return `http://${trimmed.slice('ws://'.length)}`
  return trimmed
}

export class SyncClient {
  private token: string | null = null
  private readonly base: string

  constructor(
    server: string,
    private readonly backupKey: string
  ) {
    this.base = httpBase(server)
  }

  /**
   * A request, sent again when the network failed under it: a sync server that
   * restarted leaves pooled connections behind that reset on first use. Every
   * request here only reads, so sending one twice changes nothing.
   */
  private async send(url: string, init?: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fetch(url, init)
      } catch (error) {
        if (!(error instanceof TypeError) || attempt >= RETRIES.length) throw error
        await new Promise((resolve) => setTimeout(resolve, RETRIES[attempt]))
      }
    }
  }

  async signIn(): Promise<BackupSessionResponse> {
    const response = await this.send(`${this.base}${API.backupLogin}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backupKey: this.backupKey })
    })
    if (response.status === 401) throw new AccessEnded()
    if (!response.ok) throw new SyncError(response.status, await errorOf(response))
    const session = (await response.json()) as BackupSessionResponse
    this.token = session.token
    return session
  }

  /** One request, signed in again once when the token ran out. */
  private async request(path: string): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      if (!this.token) await this.signIn()
      const response = await this.send(`${this.base}${path}`, { headers: { authorization: `Bearer ${this.token}` } })
      if (response.status === 401 && attempt === 0) {
        this.token = null
        continue
      }
      if (response.status === 401) throw new AccessEnded()
      return response
    }
  }

  private async json<T>(path: string): Promise<T> {
    const response = await this.request(path)
    if (!response.ok) throw new SyncError(response.status, await errorOf(response))
    return (await response.json()) as T
  }

  rooms(): Promise<BackupRoomsResponse> {
    return this.json(API.backupRooms)
  }

  /** The whole readable log, or with `from` the frames from that seq on while its frame is still there. */
  log(room: string, from?: number): Promise<LogResponse> {
    const query = from === undefined ? '' : `?from=${from}`
    return this.json(`${API.log}/${encodeURIComponent(room)}${query}`)
  }

  keys(room: string): Promise<KeysResponse> {
    return this.json(`${API.keys}/${encodeURIComponent(room)}`)
  }

  /** Null when the server has no such blob, or not all of it. */
  async blobInfo(account: string, vault: string, blob: string): Promise<BlobInfo | null> {
    const response = await this.request(`${API.blobs}/${account}/${vault}/${blob}`)
    if (response.status === 404) return null
    if (!response.ok) throw new SyncError(response.status, await errorOf(response))
    const info = (await response.json()) as BlobInfo
    return info.complete ? info : null
  }

  async blobChunk(account: string, vault: string, blob: string, index: number): Promise<Uint8Array> {
    const response = await this.request(`${API.blobs}/${account}/${vault}/${blob}/${index}`)
    if (!response.ok) throw new SyncError(response.status, await errorOf(response))
    return new Uint8Array(await response.arrayBuffer())
  }
}

async function errorOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string') return body.error
  } catch {
    // no JSON body
  }
  return `HTTP ${response.status}`
}
