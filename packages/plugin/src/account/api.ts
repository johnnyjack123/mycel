import {
  API,
  type AcceptRequest,
  type AccountBundle,
  type AccountKeyResponse,
  type AttachBlobsRequest,
  type AuthConfigResponse,
  type BackupKeyCreated,
  type BackupKeyDeleteRequest,
  type BackupKeyRequest,
  type BlobHaveResponse,
  type BlobIdsRequest,
  type BlobInfo,
  type BlobListResponse,
  type BlobPurgeResponse,
  type BlobTouchResponse,
  type BlobUsageResponse,
  type ChangedResponse,
  type CompactableResponse,
  type ContactCodeInfo,
  type ContactCodeRequest,
  type ContactReplyRequest,
  type ContactsResponse,
  type InboxResponse,
  type RedeemRequest,
  type CreateVaultRequest,
  type FolderAcceptRequest,
  type FolderEndRequest,
  type FolderJoinRequest,
  type FolderLeaveRequest,
  type FolderRevokeRequest,
  type FolderRoleRequest,
  type FolderRotation,
  type FolderShareRequest,
  type FolderStateResponse,
  type ForkDoneRequest,
  type ForkResponse,
  type ForksResponse,
  type ImportRequest,
  type IncomingFoldersResponse,
  type IncomingSharesResponse,
  type KeysResponse,
  type LoginRequest,
  type LogResponse,
  type PasswordChangeRequest,
  type RecoverCommitRequest,
  type RecoverRequest,
  type RecoverResponse,
  type RecoveryDeleteRequest,
  type RecoverySetRequest,
  type RefreshResponse,
  type RegisterRequest,
  type RevokeRequest,
  type RoleRequest,
  type SessionResponse,
  type ShareMembersResponse,
  type ShareRequest,
  type SnapshotRequest,
  type StartSnapshotRequest,
  type TotpDisableRequest,
  type TotpEnableRequest,
  type TotpLoginRequest,
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
    message: string,
    /** What the server answered, for refusals that carry more than a message. */
    readonly body: unknown = null
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
    throw new ApiError(response.status, message, response.json)
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

  /** The second wrapping of the account's keys, for whoever has the recovery code. */
  recover(request: RecoverRequest): Promise<RecoverResponse> {
    return this.call('POST', API.recover, request, false)
  }

  recoverCommit(request: RecoverCommitRequest): Promise<SessionResponse> {
    return this.call('POST', `${API.recover}/commit`, request, false)
  }

  setRecovery(request: RecoverySetRequest): Promise<AccountBundle> {
    return this.call('POST', API.recovery, request)
  }

  deleteRecovery(request: RecoveryDeleteRequest): Promise<AccountBundle> {
    return this.call('POST', `${API.recovery}/delete`, request)
  }

  /** The second step of signing in, with the challenge the first answered. */
  loginTotp(request: TotpLoginRequest): Promise<SessionResponse> {
    return this.call('POST', API.loginTotp, request, false)
  }

  enableTotp(request: TotpEnableRequest): Promise<SessionResponse> {
    return this.call('POST', API.totp, request)
  }

  disableTotp(request: TotpDisableRequest): Promise<AccountBundle> {
    return this.call('POST', `${API.totp}/off`, request)
  }

  account(): Promise<AccountBundle> {
    return this.call('GET', API.account)
  }

  createBackupKey(request: BackupKeyRequest): Promise<BackupKeyCreated> {
    return this.call('POST', API.backupKeys, request)
  }

  deleteBackupKey(id: string): Promise<AccountBundle> {
    const request: BackupKeyDeleteRequest = { id }
    return this.call('POST', `${API.backupKeys}/delete`, request)
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

  // --- shared folders --------------------------------------------------------------

  shareFolder(request: FolderShareRequest): Promise<unknown> {
    return this.call('POST', API.folders, request)
  }

  incomingFolders(): Promise<IncomingFoldersResponse> {
    return this.call('GET', `${API.folders}/incoming`)
  }

  folderState(folderId: string): Promise<FolderStateResponse> {
    return this.call('GET', `${API.folders}/${folderId}`)
  }

  private folderAction(folderId: string, action: string, body: unknown = {}): Promise<unknown> {
    return this.call('POST', `${API.folders}/${folderId}/${action}`, body)
  }

  rotateFolder(folderId: string, rotation: FolderRotation): Promise<unknown> {
    return this.folderAction(folderId, 'rotate', rotation)
  }

  joinFolderNote(folderId: string, request: FolderJoinRequest): Promise<unknown> {
    return this.folderAction(folderId, 'notes/join', request)
  }

  leaveFolderNote(folderId: string, request: FolderLeaveRequest): Promise<unknown> {
    return this.folderAction(folderId, 'notes/leave', request)
  }

  revokeFolder(folderId: string, request: FolderRevokeRequest): Promise<unknown> {
    return this.folderAction(folderId, 'revoke', request)
  }

  setFolderRole(folderId: string, request: FolderRoleRequest): Promise<unknown> {
    return this.folderAction(folderId, 'role', request)
  }

  acceptFolder(folderId: string, vaultId: string): Promise<unknown> {
    const request: FolderAcceptRequest = { vaultId }
    return this.folderAction(folderId, 'accept', request)
  }

  /** Leaves a folder keeping its notes as this account's own; the server holds what it read of each. */
  detachFolder(folderId: string): Promise<unknown> {
    return this.folderAction(folderId, 'detach')
  }

  leaveFolder(folderId: string): Promise<unknown> {
    return this.folderAction(folderId, 'leave')
  }

  endFolder(folderId: string, request: FolderEndRequest): Promise<unknown> {
    return this.folderAction(folderId, 'end', request)
  }

  /** A starting point in a room's current epoch, for someone joining its folder without history. */
  startSnapshot(roomName: string, request: StartSnapshotRequest): Promise<unknown> {
    return this.call('POST', `${API.log}/${room(roomName)}/start`, request)
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

  /** The vault's notes that took a change since `since`, by the server's clock. */
  changedRooms(vaultId: string, since: number): Promise<ChangedResponse> {
    return this.call('GET', `${API.changed}?vaultId=${vaultId}&since=${Math.floor(since)}`)
  }

  // --- blobs ---------------------------------------------------------------------

  private blobPath(account: string, vaultId: string, rest: string): string {
    return `${API.blobs}/${encodeURIComponent(account)}/${encodeURIComponent(vaultId)}/${rest}`
  }

  /** `room`: read someone else's blob through a shared note that names it. */
  blobInfo(account: string, vaultId: string, blobId: string, room?: string): Promise<BlobInfo> {
    return this.call('GET', this.blobPath(account, vaultId, `${blobId}${room ? `?room=${encodeURIComponent(room)}` : ''}`))
  }

  async putBlobChunk(account: string, vaultId: string, blobId: string, index: number, count: number, data: Uint8Array): Promise<BlobInfo> {
    const response = await this.send({ method: 'PUT', bytes: data }, this.blobPath(account, vaultId, `${blobId}/${index}?count=${count}`))
    return response.json as BlobInfo
  }

  async blobChunk(account: string, vaultId: string, blobId: string, index: number, room?: string): Promise<Uint8Array> {
    const query = room ? `?room=${encodeURIComponent(room)}` : ''
    const response = await this.send({ method: 'GET', binary: true }, this.blobPath(account, vaultId, `${blobId}/${index}${query}`))
    return response.bytes ?? new Uint8Array(0)
  }

  /** Which blobs a shared note's attachment list names, so its members may read them. */
  attachBlobs(roomName: string, request: AttachBlobsRequest): Promise<unknown> {
    return this.call('POST', `${API.log}/${room(roomName)}/attachments`, request)
  }

  haveBlobs(account: string, vaultId: string, ids: string[]): Promise<BlobHaveResponse> {
    const request: BlobIdsRequest = { ids }
    return this.call('POST', this.blobPath(account, vaultId, 'have'), request)
  }

  purgeBlobs(account: string, vaultId: string, ids: string[]): Promise<BlobPurgeResponse> {
    const request: BlobIdsRequest = { ids }
    return this.call('POST', this.blobPath(account, vaultId, 'purge'), request)
  }

  touchBlobs(account: string, vaultId: string, ids: string[]): Promise<BlobTouchResponse> {
    const request: BlobIdsRequest = { ids }
    return this.call('POST', this.blobPath(account, vaultId, 'touch'), request)
  }

  /** Everything in one of this account's stores. */
  listBlobs(account: string, vaultId: string): Promise<BlobListResponse> {
    return this.call('GET', this.blobPath(account, vaultId, 'list'))
  }

  /** What the account stores in attachments, over all its vaults. */
  blobUsage(account: string): Promise<BlobUsageResponse> {
    return this.call('GET', `${API.blobs}/${encodeURIComponent(account)}/usage`)
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
