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
  /** The shared folder the note is part of, owned by this account or someone else. */
  folder?: string
  /**
   * The note's path relative to its folder as this vault last followed it.
   * While the note's file lies at the folder's place plus this, it follows the
   * folder's renames; moved elsewhere here, it stays where it was put.
   */
  folderPath?: string
}

/**
 * A shared folder in a vault index: one of the vault's own, or one someone
 * shared into it. The id is the identity, as a note's is; `path` is where the
 * folder lies in this vault, which for someone else's is entirely this
 * vault's business.
 */
export interface VaultFolder {
  path: string
  updatedAt: number
  /** Whose folder it is, when it is someone else's. */
  owner?: string
  role?: ShareRole
  /** The share ended - revoked, ended by its owner, detached: an ordinary folder now. */
  endedAt?: number
  /** This account left it; nothing of it is kept. */
  leftAt?: number
}

/** A note in a shared folder's own document, its path relative to the folder. */
export interface FolderNote {
  path: string
  updatedAt: number
  /** Deleted for everyone in the folder. */
  deletedAt?: number
  /** Its owner moved it out of the folder: everyone else keeps it as their own. */
  leftAt?: number
  /** The account that made the last change to the entry. */
  by?: string
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
  /** A note's epochs spent in a shared folder: their keys derive from the folder's. */
  ties?: Record<string, FolderTie>
}

export interface BackupRoomsResponse {
  vaultId: string
  rooms: BackupRoom[]
}

/** How many snapshots restic keeps by each rule; a rule left out keeps none by it. */
export interface KeepPolicy {
  last?: number
  hourly?: number
  daily?: number
  weekly?: number
  monthly?: number
  yearly?: number
}

// The vault's backup settings live in its account-wide settings document, one
// entry per key, so every device sees and changes them and the backup server
// reads them with its backup key.

/** `backupServer:<routeId>`: a backup server the vault is paired with; the route is the pairing's. */
export interface BackupServerSetting {
  routeId: string
  /** The pairing secret, base64: every device of the account reaches the backup server for this vault with it. */
  pairing: string
  label: string
  /** Its backup key on the sync server, which any device deletes when disconnecting it. */
  keyId: string
  addedAt: number
}

/**
 * `backupTask:<routeId>`: what the vault's backup server does with it. One
 * per backup server, under its route, so two devices setting it up at once
 * cannot make two. The backup server picks its folders itself; only a cloud
 * location is given.
 */
export interface BackupTaskSetting {
  /** The backup server's route id. */
  server: string
  /**
   * Where the restic repository lies: `local` on the backup server, in its
   * folder for encrypted vaults under the vault's id; `cloud` at `location`.
   */
  where: 'local' | 'cloud'
  /** A location restic reaches - `s3:…`, `b2:…`, `rest:…`, `sftp:…`; cloud only. */
  location?: string
  /** The repository's password. */
  password: string
  /** Credentials the cloud location needs, e.g. `AWS_ACCESS_KEY_ID`. */
  env?: Record<string, string>
  keep?: KeepPolicy
  /** How often it backs the vault up on its own, unless `at` says when; 0: only when started by hand. */
  everyHours: number
  /** At a time of day instead: daily, or weekly on one day. */
  at?: BackupAt
  /** Also the decrypted copy of the newest version, in the backup server's folder for decrypted vaults. */
  decrypted: boolean
  /**
   * The decrypted copy's guard: the share of the notes, or of the files, in
   * percent, that may vanish since the copy last followed before it waits for
   * a confirmation. 10 to 90; absent: `BACKUP_GUARD_DEFAULT`; 0: it never waits.
   */
  guard?: number
  createdAt: number
}

/**
 * A time the backup server backs a vault up at - in the time zone of the
 * device that set it, since a container's clock runs in UTC.
 */
export interface BackupAt {
  /** Minutes after midnight, 0 to 1439. */
  minutes: number
  /** The days, 0 Sunday to 6 Saturday; absent: every day. */
  weekdays?: number[]
  /** One day, as 0.7.18 set it; `weekdays` from 0.7.19 on. */
  weekday?: number
  /** An IANA time zone, e.g. `Europe/Berlin`. */
  zone: string
}

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]

/** The days a time of day backs up on, 0 Sunday to 6 Saturday, sorted - every day unless it names some. */
export function scheduleDays(at: Pick<BackupAt, 'weekdays' | 'weekday'>): number[] {
  const named = at.weekdays ?? (at.weekday === undefined ? EVERY_DAY : [at.weekday])
  const days = Array.from(new Set(named.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))).sort((a, b) => a - b)
  return days.length > 0 ? days : [...EVERY_DAY]
}

/** At most how many hours lie between two backups a task asks for - the longest gap between its days; 0 for none. */
export function scheduleHours(task: Pick<BackupTaskSetting, 'everyHours' | 'at'>): number {
  if (task.at) {
    const days = scheduleDays(task.at)
    let longest = 0
    days.forEach((day, index) => {
      const next = days[(index + 1) % days.length] as number
      longest = Math.max(longest, (next - day + 7) % 7 || 7)
    })
    return longest * 24
  }
  return task.everyHours > 0 ? task.everyHours : 0
}

export const BACKUP_GUARD_DEFAULT = 50
export const BACKUP_GUARD_MIN = 10
export const BACKUP_GUARD_MAX = 90

/** A guard as set, made one the backup server uses: 0, or 10 to 90. */
export function backupGuard(value: unknown): number {
  if (value === 0) return 0
  if (typeof value !== 'number' || !Number.isFinite(value)) return BACKUP_GUARD_DEFAULT
  return Math.min(BACKUP_GUARD_MAX, Math.max(BACKUP_GUARD_MIN, Math.round(value)))
}

export const BACKUP_SERVER_KEY = 'backupServer:'
export const BACKUP_TASK_KEY = 'backupTask:'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    const keys = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * What a backup server reads for its route - the vault's backup task -,
 * written the same way on both ends. A device hashes it to tell whether the
 * backup server has read the newest settings: a retention changed is a
 * change too.
 */
export function backupSettingsText(settings: Iterable<[string, unknown]>, routeId: string): string {
  let task: unknown = null
  for (const [key, value] of settings) if (key === `${BACKUP_TASK_KEY}${routeId}`) task = value
  return canonical(task)
}

/**
 * Frames on the sync server's `/relay`, JSON. The sync server numbers each
 * session (`s`) and forwards its data (`d`) without reading it: inside is a
 * session between a device and a backup server, encrypted end to end.
 */
export type RelayFrame =
  /** backup server -> sync server: one more route, by the token derived from its secret. */
  | { t: 'register'; token: string }
  | { t: 'registered'; route: string }
  /** backup server -> sync server: a route it no longer answers - an invitation spent, a vault disconnected. */
  | { t: 'unregister'; route: string }
  /** device -> sync server: a session on that route; `ref` matches the answer. */
  | { t: 'open'; route: string; ref: number }
  | { t: 'opened'; ref: number; s: number }
  /** sync server -> backup server: someone opened a session on one of its routes. */
  | { t: 'incoming'; s: number; route: string }
  | { t: 'data'; s: number; d: string }
  | { t: 'close'; s: number; reason?: string }
  | { t: 'error'; error: string; ref?: number }

/** What connecting with an invitation answers, inside the session. */
export interface BackupConnected {
  vaultId: string
  /** The pairing secret, base64, from now on the vault's way to this backup server. */
  pairing: string
  /** The route of the pairing this one replaced - the same vault connected again; null for a first. */
  replaced: string | null
}

/** What a backup server tells about itself. */
export interface BackupServerInfo {
  /** What the backup server is called, set where it runs. */
  name: string
  version: string
  restic: string
  /** Free space in its folder for encrypted vaults, in bytes, when the system says. */
  free?: number
}

/** A destination's outcome in a run; see the backup server's report. */
export interface BackupDestinationStatus {
  id: string
  ok: boolean
  notesSnapshot?: string
  filesSnapshot?: string
  filesUnchanged?: boolean
  checked?: 'quick' | 'deep'
  error?: string
}

export interface BackupRunStatus {
  startedAt: number
  finishedAt: number
  ok: boolean
  error?: string
  accessEnded?: boolean
  notes: number
  files: number
  problems: string[]
  destinations: BackupDestinationStatus[]
  trusted?: {
    ok: boolean
    /** Why the copy waits, in words. */
    held?: string
    /** The same in numbers: per kind, how many there are now and the most at the runs it followed in the week before. */
    shrunk?: Array<{ what: 'notes' | 'files'; now: number; before: number }>
    written?: number
    deleted?: number
    kept?: number
    error?: string
  }
}

/** One vault on a backup server, as its owner's devices see it. */
export interface BackupVaultStatus {
  vaultId: string
  running: boolean
  /** When the schedule runs it next; null without one. */
  nextRunAt: number | null
  /** A run that is due waits for nobody to write in the vault - at most until then; null when none waits. */
  waitingUntil: number | null
  /** It found the vault's backup task in the settings and can carry it out. */
  ready: boolean
  /** Its folders for this vault, as its operator finds them: `encrypted/<vaultId>` and `decrypted/<name>/<vault>`. */
  folders: { encrypted: string; decrypted: string }
  /** The schedule as it read it; 0 for none. */
  everyHours: number
  /** SHA-256, hex, of `backupSettingsText` as it last read the settings; empty before it did. */
  settingsDigest: string
  /** Settings the backup server cannot use, and why. */
  problems: string[]
  /** Newest first. */
  runs: BackupRunStatus[]
}

/** One backup of a vault a backup server can read a rollback's content from: a notes snapshot and the files snapshot of then. */
export interface BackupSnapshotRef {
  /** The repository that holds it, by the id the backup server reports its runs under. */
  destination: string
  /** The vault's folder in the backup. */
  folder: string
  notes: { id: string; time: number }
  files: { id: string; time: number } | null
}

/** A note or file in a backup, by its path in the vault. */
export interface BackupListedEntry {
  path: string
  size: number
  /** SHA-256 of the content, hex - as attachments name their content. */
  hash: string
  /** Which snapshot holds it: notes and canvases, or the stream of every other file. */
  part: 'notes' | 'files'
}

/** A piece of a backup's content on its way to a device, as a session event `backup-data`. */
export interface BackupDataEvent {
  /** The request it answers. */
  rid: string
  path: string
  /** Base64; empty on the last piece of a file that ended. */
  data: string
  last: boolean
}

/**
 * Everything a backup server needs to read and decrypt one vault, handed over
 * by a device of the account - never through the sync server in the clear.
 * Byte values are base64.
 */
export interface BackupGrant {
  /** The sync server, as the device reaches it (`ws(s)://` or `http(s)://`). */
  server: string
  accountId: string
  /** The name the account signs in with; the folder of its decrypted copies is named after it. Not unique. */
  accountName: string
  vaultId: string
  vaultName: string
  vaultKey: string
  /** The account's key pair: notes others share are sealed to it. */
  publicKey: string
  /** PKCS#8. */
  privateKey: string
  backupKey: string
  keyId: string
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
  /**
   * A note in a shared folder: the folder's epoch the new key was derived
   * from. Every new epoch of such a note belongs to the folder's current one.
   */
  folderEpoch?: number
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
export type NotifyKind =
  | 'share-added'
  | 'share-changed'
  | 'share-removed'
  | 'contact'
  | 'contact-removed'
  | 'account-changed'
  | 'folder-added'
  | 'folder-changed'
  | 'folder-removed'

export interface ShareNotice {
  docId: string
  owner: string
  role?: ShareRole
}

/** For `folder-added`, `folder-changed` and `folder-removed`. */
export interface FolderNotice {
  folderId: string
  owner: string
  role?: ShareRole
}

/** For `contact` (something waits in the inbox), `contact-removed` and `account-changed`. */
export interface ContactNotice {
  account: string
}

export type Notice = ShareNotice | ContactNotice | FolderNotice

// --- shared folders --------------------------------------------------------------
// A folder is a room of its own (`fld:<folderId>`) whose members reach every
// note in it; each folder epoch's key is sealed to each member once, and the
// keys of the notes in it derive from it (`folderKeys`). `docs/PHASE7.md`.

/**
 * A note's own members, and the note's next epoch sealed for each of them: a
 * folder's epoch moving moves the note's, and those people hold the note's key
 * rather than the folder's.
 */
export interface NoteRotation {
  /** The note's next epoch; refused when the note moved meanwhile. */
  epoch: number
  /** account -> the key of that epoch sealed to them. */
  keys: Record<string, string>
}

/** The folder to its next epoch, and every note in it along. */
export interface FolderRotation {
  /** The folder's next epoch. */
  epoch: number
  /** account -> the folder key of that epoch sealed to them, for everyone who keeps access. */
  keys: Record<string, string>
  /** docId -> the note's next epoch for its own members; only notes that have any. */
  notes: Record<string, NoteRotation>
}

export interface FolderShareRequest {
  folderId: string
  account: string
  role: ShareRole
  withHistory: boolean
  /** The owner's name for the folder, sealed to the recipient. */
  title: string
  /**
   * folder epoch -> the folder key sealed to the recipient: every epoch with
   * history, the current one without. Without history every note must have a
   * starting point in the current epoch first (`StartSnapshotRequest`).
   */
  keys: Record<string, string>
  /**
   * With history: docId -> note epoch -> key sealed to the recipient, for the
   * epochs a note had before it joined the folder - whose history the folder's
   * members read (a note that joined with its history).
   */
  noteKeys?: Record<string, Record<string, string>>
}

/** A note of the owner's into a folder. */
export interface FolderJoinRequest {
  docId: string
  /** The note's next epoch, tied to the folder's current one. */
  epoch: number
  folderEpoch: number
  /** The new epoch's key sealed to the note's own members. */
  keys: Record<string, string>
  /**
   * The note at the server's head under the new epoch: where the folder's
   * members start reading it. Required while the folder has members; without
   * one the note joins with its whole history, for a folder shared next.
   */
  snapshot?: { uptoSeq: number; data: string }
}

/** A note of the folder back to its owner alone; the members keep theirs as forks. */
export interface FolderLeaveRequest {
  docId: string
  rotation: NoteRotation
}

export interface FolderRevokeRequest {
  account: string
  rotation: FolderRotation
}

export interface FolderRoleRequest {
  account: string
  role: ShareRole
}

export interface FolderAcceptRequest {
  vaultId: string
}

/** The share ends for everyone; each note to its next epoch, under the owner's vault key again. */
export interface FolderEndRequest {
  notes: Record<string, NoteRotation>
}

/**
 * Where someone joining a folder without history starts reading a room of it:
 * the room in its current epoch, at or after the epoch began.
 */
export interface StartSnapshotRequest {
  epoch: number
  uptoSeq: number
  data: string
}

/** A note of the folder as its owner needs it for the next rotation or share. */
export interface FolderNoteState {
  docId: string
  epoch: number
  headSeq: number
  /** Where the folder's members start reading it; 0 for the whole history. */
  since: number
  /** The latest starting point in the current epoch, if there is one. */
  start: number | null
  /** The note's own members. */
  members: string[]
}

export interface FolderStateResponse {
  folderId: string
  owner: string
  epoch: number
  headSeq: number
  start: number | null
  members: ShareMember[]
  /** For the owner only. */
  notes?: FolderNoteState[]
}

export interface IncomingFolder {
  folderId: string
  owner: string
  role: ShareRole
  /** The owner's name for the folder, sealed to the recipient. */
  title: string
  addedAt: number
}

export interface IncomingFoldersResponse {
  folders: IncomingFolder[]
}

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
  /**
   * A note of a shared folder: the folder's keys the participant held, by
   * folder epoch, and which of the note's epochs belong to which of those.
   */
  folder?: { id: string; keys: Record<string, string>; epochs: Record<string, number> }
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
  /**
   * For a note that is or was in a shared folder: which of its epochs belong
   * to which folder and folder epoch - those keys come from the folder's.
   * Every epoch up to `epoch` not named here is the note's own.
   */
  ties?: Record<string, FolderTie>
}

/** A note epoch spent in a shared folder: its key derives from that folder epoch's key. */
export interface FolderTie {
  folder: string
  epoch: number
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
