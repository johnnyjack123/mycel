import {
  API,
  type AcceptRequest,
  type AccountBundle,
  type AccountKeyResponse,
  type AuthConfigResponse,
  type BlobHaveResponse,
  type BlobIdsRequest,
  type BlobInfo,
  type BlobPurgeResponse,
  type CompactableResponse,
  type ContactCodeInfo,
  type ContactCodeRequest,
  type ContactReplyRequest,
  type ContactsResponse,
  type InboxResponse,
  type RedeemRequest,
  type CreateVaultRequest,
  type ForkDoneRequest,
  type ForkResponse,
  type ForksResponse,
  type ImportRequest,
  type IncomingSharesResponse,
  type KeysResponse,
  type LoginRequest,
  type LogResponse,
  type PasswordChangeRequest,
  type RefreshResponse,
  type RegisterRequest,
  type RevokeRequest,
  type RoleRequest,
  type SessionResponse,
  type ShareMembersResponse,
  type ShareRequest,
  type SnapshotRequest,
  type VaultRecord
} from '@obsidian-connect/shared'

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT'
  url: string
  /** Sent as JSON. */
  body?: unknown
  /** Sent as it is, `application/octet-stream`, instead of `body`. */
  bytes?: Uint8Array
  /** The answer is bytes, not JSON - unless it is an error. */
  binary?: boolean
  token?: string | null
}

export interface HttpResponse {
  status: number
  json: unknown
  /** For a `binary` request that succeeded. */
  bytes?: Uint8Array
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

  private async send(request: Omit<HttpRequest, 'url' | 'token'>, path: string, auth = true): Promise<HttpResponse> {
    let response: HttpResponse
    try {
      response = await this.http({ ...request, url: `${httpBase(this.serverUrl())}${path}`, token: auth ? this.token() : null })
    } catch (error) {
      // Unreachable is not a refusal; callers treat status 0 as "try later".
      throw new ApiError(0, error instanceof Error ? error.message : String(error))
    }
    if (response.status >= 200 && response.status < 300) return response
    const message = (response.json as { error?: string } | null)?.error ?? `HTTP ${response.status}`
    throw new ApiError(response.status, message)
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, auth = true): Promise<T> {
    return (await this.send({ method, body }, path, auth)).json as T
  }

  /** Answered by every server version, so an old one can be told apart from none. */
  health(): Promise<unknown> {
    return this.call('GET', API.health, undefined, false)
  }

  config(): Promise<AuthConfigResponse> {
    return this.call('GET', API.config, undefined, false)
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

  /** Someone's public key as the server has it. Contacts pin it; until then it is the server's word. */
  accountKey(accountId: string): Promise<AccountKeyResponse> {
    return this.call('GET', `${API.accounts}/${encodeURIComponent(accountId)}/key`)
  }

  addContactCode(request: ContactCodeRequest): Promise<unknown> {
    return this.call('POST', `${API.contacts}/codes`, request)
  }

  revokeContactCode(codeId: string): Promise<unknown> {
    return this.call('POST', `${API.contacts}/codes/${encodeURIComponent(codeId)}/revoke`, {})
  }

  contactCode(codeId: string): Promise<ContactCodeInfo> {
    return this.call('GET', `${API.contacts}/codes/${encodeURIComponent(codeId)}`)
  }

  redeemContact(request: RedeemRequest): Promise<{ owner: string }> {
    return this.call('POST', `${API.contacts}/redeem`, request)
  }

  replyContact(request: ContactReplyRequest): Promise<unknown> {
    return this.call('POST', `${API.contacts}/reply`, request)
  }

  contactInbox(): Promise<InboxResponse> {
    return this.call('GET', `${API.contacts}/inbox`)
  }

  contactInboxDone(ids: string[]): Promise<unknown> {
    return this.call('POST', `${API.contacts}/inbox/done`, { ids })
  }

  contacts(): Promise<ContactsResponse> {
    return this.call('GET', API.contacts)
  }

  removeContact(account: string): Promise<unknown> {
    return this.call('POST', `${API.contacts}/remove`, { account })
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

  /** Ends this account's share of a note it keeps; the server holds what it could read for the fork. */
  detach(docId: string): Promise<unknown> {
    return this.call('POST', `${API.shares}/detach`, { docId })
  }

  forks(): Promise<ForksResponse> {
    return this.call('GET', API.forks)
  }

  fork(docId: string): Promise<ForkResponse> {
    return this.call('GET', `${API.forks}/${docId}`)
  }

  /** Resolves to where the note carries on: this device's answer, or an earlier device's. */
  forkDone(docId: string, forkedTo: string): Promise<{ forkedTo: string }> {
    const request: ForkDoneRequest = { forkedTo }
    return this.call('POST', `${API.forks}/${docId}/done`, request)
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

  /** Lets the server delete a note of this account that was deleted longer ago than the retention. */
  purge(roomName: string): Promise<unknown> {
    return this.call('POST', `${API.log}/${room(roomName)}/purge`, {})
  }

  importFrames(roomName: string, vaultId: string, request: ImportRequest): Promise<{ headSeq: number }> {
    return this.call('POST', `${API.log}/${room(roomName)}/import?vaultId=${vaultId}`, request)
  }

  compactable(vaultId: string, before: number): Promise<CompactableResponse> {
    return this.call('GET', `${API.compactable}?vaultId=${vaultId}&before=${Math.floor(before)}`)
  }

  // --- blobs ---------------------------------------------------------------------

  private blobPath(account: string, vaultId: string, rest: string): string {
    return `${API.blobs}/${encodeURIComponent(account)}/${encodeURIComponent(vaultId)}/${rest}`
  }

  blobInfo(account: string, vaultId: string, blobId: string): Promise<BlobInfo> {
    return this.call('GET', this.blobPath(account, vaultId, blobId))
  }

  async putBlobChunk(account: string, vaultId: string, blobId: string, index: number, count: number, data: Uint8Array): Promise<BlobInfo> {
    const response = await this.send({ method: 'PUT', bytes: data }, this.blobPath(account, vaultId, `${blobId}/${index}?count=${count}`))
    return response.json as BlobInfo
  }

  async blobChunk(account: string, vaultId: string, blobId: string, index: number): Promise<Uint8Array> {
    const response = await this.send({ method: 'GET', binary: true }, this.blobPath(account, vaultId, `${blobId}/${index}`))
    return response.bytes ?? new Uint8Array(0)
  }

  haveBlobs(account: string, vaultId: string, ids: string[]): Promise<BlobHaveResponse> {
    const request: BlobIdsRequest = { ids }
    return this.call('POST', this.blobPath(account, vaultId, 'have'), request)
  }

  purgeBlobs(account: string, vaultId: string, ids: string[]): Promise<BlobPurgeResponse> {
    const request: BlobIdsRequest = { ids }
    return this.call('POST', this.blobPath(account, vaultId, 'purge'), request)
  }
}

/** A `fetch`-based client, for tests and anything outside Obsidian. */
export const fetchHttp: HttpClient = async (request) => {
  const headers: Record<string, string> = {}
  if (request.bytes) headers['Content-Type'] = 'application/octet-stream'
  else if (request.body !== undefined) headers['Content-Type'] = 'application/json'
  if (request.token) headers.Authorization = `Bearer ${request.token}`
  const response = await fetch(request.url, {
    method: request.method,
    headers,
    body: request.bytes ? new Uint8Array(request.bytes) : request.body === undefined ? undefined : JSON.stringify(request.body)
  })
  if (request.binary && response.ok) return { status: response.status, json: null, bytes: new Uint8Array(await response.arrayBuffer()) }
  let json: unknown = null
  try {
    json = await response.json()
  } catch {
    // not every error has a body
  }
  return { status: response.status, json }
}
