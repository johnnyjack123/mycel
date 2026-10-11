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
  /**
   * On the tombstone of a note someone else owned: the share ended and this
   * vault's own note carries on under that id. Another device of the account
   * merges what it still holds of the old note into it instead of dropping it.
   */
  forkedTo?: string
  /**
   * On the tombstone of a note deleted longer ago than the history retention:
   * the server let go of it, so it can no longer be restored.
   */
  purgedAt?: number
}

/**
 * A file of the vault that is not a note, in the index document. Its content
 * is a blob named after the content's hash, so two devices holding the same
 * bytes agree without comparing anything else.
 */
export interface AttachmentEntry {
  path: string
  /** SHA-256 of the content, hex. */
  hash: string
  size: number
  updatedAt: number
  /**
   * The content this one replaced, as its writer knew it. An entry is
   * replaced whole, so of two devices writing at once one write is simply
   * gone; this is how the other device tells "replaced mine knowingly" from
   * "never saw mine".
   */
  prev?: string
  deletedAt?: number
  /** The server let go of its content, so it can no longer be restored. */
  purgedAt?: number
  /** It came in through a shared note, for this link. */
  via?: { docId: string; ref: string }
}

/**
 * One file a shared note embeds or links, in the note's own document - so
 * it is encrypted under the note's key, readable to everyone in the note and
 * to nobody else. The content lies in the store of whoever put it there.
 */
export interface SharedAttachment {
  account: string
  vault: string
  blob: string
  /** The blob's key, base64. */
  key: string
  hash: string
  size: number
  updatedAt: number
  /** The account that set this version. */
  by: string
  /** The version this one replaced, as its writer knew it (invariant 24). */
  prev?: string
}

/** A blob in someone's store, as a shared note names it to the server. */
export interface BlobRef {
  account: string
  vault: string
  blob: string
}

export interface AttachBlobsRequest {
  attach?: BlobRef[]
  detach?: BlobRef[]
}

/**
 * A content an attachment had before. Recorded for every replacement, as
 * the file's lineage; the content itself is kept for the history retention
 * unless it was current only briefly.
 */
export interface AttachmentVersion {
  fileId: string
  hash: string
  size: number
  /** When it became current. */
  since: number
  /** When it was replaced. */
  at: number
  /** Its content is gone from the server; the record stays as lineage until the retention ends. */
  purgedAt?: number
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
  /** The largest file the server takes. Absent: a server from before attachments. */
  maxFileBytes?: number
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
export type NotifyKind = 'share-added' | 'share-changed' | 'share-removed' | 'contact' | 'contact-removed'

export interface ShareNotice {
  docId: string
  owner: string
  role?: ShareRole
}

/** For `contact` (something waits in the inbox) and `contact-removed`. */
export interface ContactNotice {
  account: string
}

export type Notice = ShareNotice | ContactNotice

// --- the end of a share ------------------------------------------------------------

/**
 * `revoked`: the owner took access away. `detached`: the participant kept a
 * copy of their own. `owner-removed`: the owner's account was deleted.
 */
export type ForkReason = 'revoked' | 'detached' | 'owner-removed'

export interface ForkSummary {
  docId: string
  owner: string
  reason: ForkReason
  endedAt: number
}

export interface ForksResponse {
  /** Shares that ended and that none of the caller's devices has forked yet. */
  forks: ForkSummary[]
}

/**
 * What the server kept for a participant when a share ended: everything they
 * could read then, with their keys, until one of their devices has forked.
 */
export interface ForkResponse extends ForkSummary {
  /** epoch -> that epoch's key sealed to the participant. */
  keys: Record<string, string>
  /** Null once forked, or when the owner's account has been gone for 90 days. */
  log: LogResponse | null
  /** The participant's own note the share carries on in, once a device has forked. */
  forkedTo?: string
}

export interface ForkDoneRequest {
  forkedTo: string
}

// --- contacts --------------------------------------------------------------------

export interface ContactCodeRequest {
  codeId: string
  /** sha256 of the redeem key, hex. The key itself only ever comes with a redemption. */
  redeemHash: string
  expiresAt: number
}

/** What a code's holder needs to check the creator's key against the fingerprint in the code. */
export interface ContactCodeInfo {
  owner: string
  publicKey: string
}

export interface RedeemRequest {
  codeId: string
  redeemKey: string
  /** The redeemer's name, account and key, sealed to the code's creator and MAC'd with the code. */
  sealed: string
}

export interface ContactReplyRequest {
  to: string
  codeId: string
  /** The creator's name, sealed to the redeemer and MAC'd with the code. */
  sealed: string
}

export interface InboxItem {
  id: string
  kind: 'request' | 'reply'
  from: string
  codeId: string
  sealed: string
  at: number
}

export interface InboxResponse {
  items: InboxItem[]
}

export interface ContactsResponse {
  /** Account ids this account is connected with, as far as the server knows. */
  contacts: string[]
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

// --- blobs -------------------------------------------------------------------------

/**
 * A blob as the server has it. `size` counts ciphertext. While an upload is
 * under way, its owner sees how many chunks arrived, so it can resume.
 */
export interface BlobInfo {
  complete: boolean
  count: number
  /** Chunks the server has, in order. Equal to `count` once complete. */
  received: number
  size: number
}

export interface BlobIdsRequest {
  ids: string[]
}

export interface BlobHaveResponse {
  /** The blobs of the request that are complete on the server. */
  have: string[]
}

export interface BlobPurgeResponse {
  purged: string[]
  /**
   * Still there: uploaded again a moment ago, so another device may be about
   * to name it. Asked about again next time.
   */
  kept: string[]
}

export interface BlobUsageResponse {
  /** Ciphertext bytes the account keeps, over all its vaults. */
  bytes: number
  quotaBytes: number | null
}
