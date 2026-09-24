import {
  API,
  type AcceptRequest,
  type AccountBundle,
  type AuthConfigResponse,
  type CompactableResponse,
  type CreateVaultRequest,
  type ImportRequest,
  type IncomingSharesResponse,
  type KeysResponse,
  type LoginRequest,
  type LogResponse,
  type PasswordChangeRequest,
  type PreloginResponse,
  type RefreshResponse,
  type RegisterRequest,
  type RevokeRequest,
  type RoleRequest,
  type SessionResponse,
  type ShareMembersResponse,
  type ShareRequest,
  type SnapshotRequest,
  type UserKeyResponse,
  type UsersResponse,
  type VaultRecord
} from '@obsidian-connect/shared'

export interface HttpRequest {
  method: 'GET' | 'POST'
  url: string
  body?: unknown
  token?: string | null
}

export interface HttpResponse {
  status: number
  json: unknown
}

/** Obsidian's `requestUrl` in the plugin, `fetch` in the tests. */
export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

/** The REST endpoint that belongs to a `ws://` or `wss://` server URL. */
export function httpBase(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, '')
  if (trimmed.startsWith('wss://')) return `https://${trimmed.slice('wss://'.length)}`
  if (trimmed.startsWith('ws://')) return `http://${trimmed.slice('ws://'.length)}`
  return trimmed
}

function room(name: string): string {
  return encodeURIComponent(name)
}

export class ConnectApi {
  constructor(
    private readonly serverUrl: () => string,
    private readonly http: HttpClient,
    private readonly token: () => string | null
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, auth = true): Promise<T> {
    let response: HttpResponse
    try {
      response = await this.http({
        method,
        url: `${httpBase(this.serverUrl())}${path}`,
        body,
        token: auth ? this.token() : null
      })
    } catch (error) {
      // Unreachable is not a refusal; callers treat status 0 as "try later".
      throw new ApiError(0, error instanceof Error ? error.message : String(error))
    }
    if (response.status >= 200 && response.status < 300) return response.json as T
    const message = (response.json as { error?: string } | null)?.error ?? `HTTP ${response.status}`
    throw new ApiError(response.status, message)
  }

  /** Answered by every server version, so an old one can be told apart from none. */
  health(): Promise<unknown> {
    return this.call('GET', API.health, undefined, false)
  }

  config(): Promise<AuthConfigResponse> {
    return this.call('GET', API.config, undefined, false)
  }

  prelogin(username: string): Promise<PreloginResponse> {
    return this.call('POST', API.prelogin, { username }, false)
  }

  register(request: RegisterRequest): Promise<SessionResponse> {
    return this.call('POST', API.register, request, false)
  }

  login(request: LoginRequest): Promise<SessionResponse> {
    return this.call('POST', API.login, request, false)
  }

  refresh(): Promise<RefreshResponse> {
    return this.call('POST', API.refresh, {})
  }

  changePassword(request: PasswordChangeRequest): Promise<SessionResponse> {
    return this.call('POST', API.password, request)
  }

  account(): Promise<AccountBundle> {
    return this.call('GET', API.account)
  }

  createVault(request: CreateVaultRequest): Promise<VaultRecord> {
    return this.call('POST', API.vaults, request)
  }

  users(): Promise<UsersResponse> {
    return this.call('GET', API.users)
  }

  userKey(username: string): Promise<UserKeyResponse> {
    return this.call('GET', `${API.users}/${encodeURIComponent(username)}/key`)
  }

  share(request: ShareRequest): Promise<unknown> {
    return this.call('POST', API.shares, request)
  }

  incoming(): Promise<IncomingSharesResponse> {
    return this.call('GET', `${API.shares}/incoming`)
  }

  members(docId: string): Promise<ShareMembersResponse> {
    return this.call('GET', `${API.shares}/${docId}`)
  }

  revoke(request: RevokeRequest): Promise<unknown> {
    return this.call('POST', `${API.shares}/revoke`, request)
  }

  leave(docId: string): Promise<unknown> {
    return this.call('POST', `${API.shares}/leave`, { docId })
  }

  setRole(request: RoleRequest): Promise<unknown> {
    return this.call('POST', `${API.shares}/role`, request)
  }

  accept(request: AcceptRequest): Promise<unknown> {
    return this.call('POST', `${API.shares}/accept`, request)
  }

  keys(roomName: string): Promise<KeysResponse> {
    return this.call('GET', `${API.keys}/${room(roomName)}`)
  }

  log(roomName: string): Promise<LogResponse> {
    return this.call('GET', `${API.log}/${room(roomName)}`)
  }

  snapshot(roomName: string, request: SnapshotRequest): Promise<unknown> {
    return this.call('POST', `${API.log}/${room(roomName)}/snapshot`, request)
  }

  importFrames(roomName: string, vaultId: string, request: ImportRequest): Promise<{ headSeq: number }> {
    return this.call('POST', `${API.log}/${room(roomName)}/import?vaultId=${vaultId}`, request)
  }

  compactable(vaultId: string, before: number): Promise<CompactableResponse> {
    return this.call('GET', `${API.compactable}?vaultId=${vaultId}&before=${Math.floor(before)}`)
  }
}

/** A `fetch`-based client, for tests and anything outside Obsidian. */
export const fetchHttp: HttpClient = async (request) => {
  const headers: Record<string, string> = {}
  if (request.body !== undefined) headers['Content-Type'] = 'application/json'
  if (request.token) headers.Authorization = `Bearer ${request.token}`
  const response = await fetch(request.url, {
    method: request.method,
    headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body)
  })
  let json: unknown = null
  try {
    json = await response.json()
  } catch {
    // not every error has a body
  }
  return { status: response.status, json }
}
