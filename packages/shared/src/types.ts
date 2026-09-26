import type { ShareRole } from './protocol.js'

// Everything below that is named `…Key`, `wrapped…`, `sealed…`, `data` or
// `title` in a share travels base64-encoded and is opaque to the server.

export interface JwtClaims {
  /** The account id. Never a name: the server does not know any. */
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
  /** The owner's account id, when the note belongs to someone else and was shared with this account. */
  owner?: string
  /** What this account may do with a note someone else owns. */
  role?: ShareRole
}

// --- accounts ------------------------------------------------------------------

export type RegistrationMode = 'open' | 'invite'

export interface KdfParams {
  algorithm: 'argon2id'
  memoryKiB: number
  iterations: number
  parallelism: number
}

export interface AuthConfigResponse {
  registration: RegistrationMode
  protocol: number
  /** Random, made once by the server; part of every account's salt. */
  serverId: string
}

export interface RegisterRequest {
  /** Required unless registration is open. */
  invite?: string
  loginKey: string
  /** Which of the pinned Argon2id parameter sets derived the login key. */
  kdfVersion: number
  publicKey: string
  wrappedPrivateKey: string
  wrappedAccountSecret: string
}

export interface LoginRequest {
  loginKey: string
}

export interface VaultRecord {
  vaultId: string
  /** The vault's name, encrypted under a key from the account secret. */
  sealedName: string
  wrappedKey: string
}

export interface AccountBundle {
  accountId: string
  kdfVersion: number
  publicKey: string
  wrappedPrivateKey: string
  wrappedAccountSecret: string
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
  /** Derived on the device from the account secret and the name. */
  vaultId: string
  sealedName: string
  wrappedKey: string
}

export interface PasswordChangeRequest {
  /** Proves the current password. */
  loginKey: string
  newLoginKey: string
  kdfVersion: number
  wrappedPrivateKey: string
  wrappedAccountSecret: string
}

export interface AccountKeyResponse {
  accountId: string
  publicKey: string
}

// --- sharing -------------------------------------------------------------------

/** A move to a new epoch, sealed for everyone who keeps access. */
export interface Rotation {
  epoch: number
  /** account id -> the new epoch key sealed to that account. */
  keys: Record<string, string>
  /** For a share without history: the note at the server's head, under the new epoch. */
  snapshot?: { uptoSeq: number; data: string }
}

export interface ShareRequest {
  docId: string
  /** The recipient's account id. */
  account: string
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
  /** The owner's account id. */
  owner: string
  role: ShareRole
  title: string
  addedAt: number
}

export interface IncomingSharesResponse {
  shares: IncomingShare[]
}

export interface ShareMember {
  account: string
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
  account: string
  rotation: Rotation
}

export interface RoleRequest {
  docId: string
  account: string
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
