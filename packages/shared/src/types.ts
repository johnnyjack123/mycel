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
  /** What the server can beyond signing in, e.g. `recovery`. Absent: a server from before 0.6. */
  features?: ServerFeature[]
}

export type ServerFeature = 'recovery' | 'totp' | 'backup'

/**
 * The answer to the right login key of an account with two-factor sign-in
 * (status 403): no session yet, a challenge to send back with the code.
 */
export interface SecondFactorRequired {
  error: string
  secondFactor: 'totp'
  /** A short-lived token that only `/auth/login/totp` accepts. */
  challenge: string
}

export interface TotpLoginRequest {
  challenge: string
  code: string
}

/** Turns two-factor sign-in on: the secret the device made, and a first code from the app. */
export interface TotpEnableRequest {
  loginKey: string
  /** Base64. */
  secret: string
  code: string
}

/** Turns two-factor sign-in off: the password is enough. */
export interface TotpDisableRequest {
  loginKey: string
  /** Sent by 0.6.2 to 0.6.5, and ignored since. */
  code?: string
}

/** A recovery code as the server keeps it: the key it finds the account by, and the second wrapping. */
export interface RecoveryRecord {
  recoveryKey: string
  wrappedPrivateKey: string
  wrappedAccountSecret: string
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
  /** The account's recovery code, made with it. A server from before 0.6 ignores it. */
  recovery?: RecoveryRecord
}

/** Makes or replaces the account's recovery code. */
export interface RecoverySetRequest {
  /** Proves the current password: a token alone must not plant a code. */
  loginKey: string
  recovery: RecoveryRecord
}

export interface RecoveryDeleteRequest {
  loginKey: string
}

export interface RecoverRequest {
  recoveryKey: string
}

/** What a recovery code opens: the second wrapping of the account's keys. */
export interface RecoverResponse {
  accountId: string
  publicKey: string
  wrappedPrivateKey: string
  wrappedAccountSecret: string
  /** Whether the account signs in with a second factor, which the recovery may keep. Absent before 0.6.3. */
  totp?: boolean
}

/** A new name and password for the account, and a new code; the old one is spent. */
export interface RecoverCommitRequest {
  recoveryKey: string
  newLoginKey: string
  kdfVersion: number
  wrappedPrivateKey: string
  wrappedAccountSecret: string
  recovery: RecoveryRecord
  /**
   * A current code from the authenticator app: two-factor sign-in stays on,
   * with the entry the app has. Without one the recovery turns it off.
   */
  totpCode?: string
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
  /** When the recovery code was made; null without one, absent from a server before 0.6. */
  recovery?: { createdAt: number } | null
  /** Whether signing in asks for a code from an authenticator app. */
  totp?: boolean
  /** The account's backup keys. Absent from a server before 0.7. */
  backupKeys?: BackupKeyInfo[]
}

// --- backup keys -------------------------------------------------------------------
//
// A backup server reads one vault with a key of its own: the server keeps only
// its hash, and a token signed in with it reads that vault and writes nothing.

export interface BackupKeyInfo {
  id: string
  vaultId: string
  /** What the person called the backup server it is for. */
  label: string
  createdAt: number
  /** When a backup server last signed in with it. */
  lastUsedAt?: number
}

export interface BackupKeyRequest {
  /** Proves the current password: a token alone must not hand out a vault. */
  loginKey: string
  vaultId: string
  /** 32 random bytes, base64; the server keeps only the hash. */
  backupKey: string
  label: string
}

export interface BackupKeyCreated {
  id: string
  account: AccountBundle
}

export interface BackupKeyDeleteRequest {
  id: string
}

export interface BackupLoginRequest {
  backupKey: string
}

export interface BackupSessionResponse {
  /** Reads the vault and nothing else; short-lived, signed in for again with the key. */
  token: string
  expiresIn: number
  accountId: string
  vaultId: string
  keyId: string
}

/** One room of the vault, and what tells whether it changed. */
export interface BackupRoom {
  room: string
  /** The room's owner: the account itself, or whoever shared the note into the vault. */
  owner: string
  epoch: number
  compactedUpTo: number
  /** Changes whenever the room's log does; nothing to read from it. */
  tag: string
}

export interface BackupRoomsResponse {
  vaultId: string
  rooms: BackupRoom[]
}

export interface SessionResponse {
  token: string
  expiresIn: number
  account: AccountBundle
  /** After a recovery: two-factor sign-in was on, and the recovery turned it off. False when it was kept. */
  totpWasOn?: boolean
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

/**
 * Why a notification was sent to an account. `account-changed` (0.6.8): what the
 * account bundle says changed - two-factor sign-in turned off, a recovery code
 * made or deleted - and the devices still signed in show it; its notice names
 * the account. Older plugins ignore kinds they do not know.
 */
export type NotifyKind = 'share-added' | 'share-changed' | 'share-removed' | 'contact' | 'contact-removed' | 'account-changed'

export interface ShareNotice {
  docId: string
  owner: string
  role?: ShareRole
}

/** For `contact` (something waits in the inbox), `contact-removed` and `account-changed`. */
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
  /**
   * Asked `?from=` a seq whose frame is still there: only the frames from it on,
   * that one included, so the caller can tell its log is this one. Absent: the
   * whole readable part, snapshot and all.
   */
  from?: number
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
