import type { ShareRole } from './protocol.js'

// Everything below that is named `…Key`, `wrapped…`, `sealed…`, `data` or
// `title` in a share travels base64-encoded and is opaque to the server.

export interface JwtClaims {
  /** The username. */
  sub: string
  scope: 'user'
  iat?: number
  exp?: number
}

// One note in the vault index document. The path is a mirror of the index
// entry, not the identity: identity is the docId that keys the entry.
export interface IndexEntry {
  path: string
  updatedAt: number
  deletedAt?: number
  /**
   * Other people work on this document too. Presence - cursors and
   * selections - is exchanged only for these; syncing your own devices never
   * broadcasts a caret.
   */
  shared?: boolean
  /** Set when the note belongs to someone else and was shared with this account. */
  owner?: string
  /** What this account may do with a note someone else owns. */
  role?: ShareRole
}

// --- accounts ------------------------------------------------------------------

export type RegistrationMode = 'open' | 'invite'

export interface KdfParams {
  algorithm: 'argon2id'
  salt: string
  memoryKiB: number
  iterations: number
  parallelism: number
}

export interface AuthConfigResponse {
  registration: RegistrationMode
  protocol: number
}

export interface PreloginRequest {
  username: string
}

export interface PreloginResponse {
  kdf: KdfParams
}

export interface RegisterRequest {
  username: string
  /** Required unless registration is open. */
  invite?: string
  kdf: KdfParams
  authKey: string
  publicKey: string
  wrappedPrivateKey: string
}

export interface LoginRequest {
  username: string
  authKey: string
}

export interface VaultRecord {
  vaultId: string
  name: string
  wrappedKey: string
}

export interface AccountBundle {
  username: string
  kdf: KdfParams
  publicKey: string
  wrappedPrivateKey: string
  vaults: VaultRecord[]
}

export interface SessionResponse {
  token: string
  expiresIn: number
  account: AccountBundle
}

export interface RefreshResponse {
  token: string
  expiresIn: number
}

export interface CreateVaultRequest {
  name: string
  wrappedKey: string
}

export interface PasswordChangeRequest {
  /** Proves the current password. */
  authKey: string
  kdf: KdfParams
  newAuthKey: string
  wrappedPrivateKey: string
  /** vaultId -> vault key wrapped under the new master key. */
  vaults: Record<string, string>
}

export interface UsersResponse {
  users: string[]
}

export interface UserKeyResponse {
  username: string
  publicKey: string
}

// --- sharing -------------------------------------------------------------------

/** A move to a new epoch, sealed for everyone who keeps access. */
export interface Rotation {
  epoch: number
  /** username -> the new epoch key sealed to that account. */
  keys: Record<string, string>
  /** For a share without history: the note at the server's head, under the new epoch. */
  snapshot?: { uptoSeq: number; data: string }
}

export interface ShareRequest {
  docId: string
  username: string
  role: ShareRole
  withHistory: boolean
  /** epoch -> key sealed to the recipient. Every epoch with history, none without. */
  keys: Record<string, string>
  /** The owner's name for the note, sealed to the recipient. */
  title: string
  /** Required without history. */
  rotation?: Rotation
}

export interface IncomingShare {
  docId: string
  owner: string
  role: ShareRole
  title: string
  addedAt: number
}

export interface IncomingSharesResponse {
  shares: IncomingShare[]
}

export interface ShareMember {
  username: string
  role: ShareRole
  addedAt: number
}

export interface ShareMembersResponse {
  docId: string
  owner: string
  epoch: number
  members: ShareMember[]
}

export interface RevokeRequest {
  docId: string
  username: string
  rotation: Rotation
}

export interface RoleRequest {
  docId: string
  username: string
  role: ShareRole
}

export interface DocRequest {
  docId: string
}

export interface AcceptRequest {
  docId: string
  vaultId: string
}

/** Why a notification was sent to an account. */
export type NotifyKind = 'share-added' | 'share-changed' | 'share-removed'

export interface ShareNotice {
  docId: string
  owner: string
  role?: ShareRole
}

// --- keys and log ----------------------------------------------------------------

export interface KeysResponse {
  room: string
  epoch: number
  /** epoch -> key sealed to the caller. Empty for rooms the caller owns. */
  keys: Record<string, string>
}

export interface LogFrame {
  seq: number
  ts: number
  epoch: number
  data: string
}

export interface LogSnapshot {
  uptoSeq: number
  ts: number
  epoch: number
  data: string
}

export interface LogResponse {
  room: string
  epoch: number
  headSeq: number
  snapshot: LogSnapshot | null
  frames: LogFrame[]
}

export interface SnapshotRequest {
  uptoSeq: number
  epoch: number
  data: string
}

export interface ImportRequest {
  frames: Array<{ epoch: number; data: string }>
}

export interface CompactableResponse {
  rooms: string[]
}
