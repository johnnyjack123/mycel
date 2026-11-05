// Version 8: every frame of a note or folder is signed by its author, inside the
// encryption, with the owner's certificate for anyone else who writes. Version 7:
// keys sealed to members carry their sealer's signature, and every
// account has a signing key its contacts pin. Version 6: a device watches the
// notes it does not hold open (`watch`) and hears
// when their logs move on (`changed`). Version 5: shared folders - rooms of kind
// `fld`, and a subscribe may name the folder a new note is created in. Version 4:
// a subscribe says whether the room may be created, and the server knows accounts
// only by id - no names, no salts per name. Version 3: the server stores an
// ordered log of encrypted frames and can no longer read a document. Version 2
// relayed plaintext Yjs sync messages.
export const PROTOCOL_VERSION = 8
export const DEFAULT_SERVER_PORT = 1234

export type ShareRole = 'read' | 'write'

export interface CollabUser {
  id: string
  name: string
  color: string
  colorLight: string
}

// The Y.Text every note document stores its body in.
export const CONTENT_FIELD = 'content'
// The Y.Map in the vault index document, docId -> IndexEntry.
export const INDEX_FIELD = 'files'
// The Y.Map in the account settings document.
export const SETTINGS_FIELD = 'settings'
// The Y.Maps in the vault index document for files that are not notes:
// fileId -> AttachmentEntry, and `${fileId}:${hash}` -> AttachmentVersion.
// Maps of their own, because a device on 0.4 takes every entry of
// INDEX_FIELD for a note.
export const ATTACHMENTS_FIELD = 'attachments'
export const VERSIONS_FIELD = 'versions'
// `${docId}:${ref}` -> { at }: files of a shared note this account let go of.
export const DECLINED_FIELD = 'declined'
// `${docId}:${ref}` -> { hash, path }: what this vault last agreed with a shared note's list.
export const SHARED_BASES_FIELD = 'sharedBases'
// `${folderId}:${fileId}` -> { hash, path, prev? }: what this vault last agreed with a
// shared folder's file - its content, and its path relative to the folder.
export const FOLDER_BASES_FIELD = 'folderBases'
// In a shared note's own document, next to its text: link -> SharedAttachment,
// and the note's sharing settings - for now only `attachments: boolean`.
export const NOTE_ATTACHMENTS_FIELD = 'attachments'
export const NOTE_SHARE_FIELD = 'share'
// In the vault index document: folderId -> VaultFolder, the shared folders this
// vault owns or holds. A map of its own, like the attachments.
export const FOLDERS_FIELD = 'folders'
// In a shared folder's own document, with paths relative to the folder:
// docId -> FolderNote, fileId -> FolderFile, `${fileId}:${hash}` ->
// AttachmentVersion, and the folder's settings (`name`, `linkedFiles`).
export const FOLDER_NOTES_FIELD = 'notes'
export const FOLDER_FILES_FIELD = 'files'
export const FOLDER_VERSIONS_FIELD = 'versions'
export const FOLDER_META_FIELD = 'meta'

/**
 * Blobs are encrypted in chunks of this much plaintext, each with its own IV
 * and tag. On the server they lie end to end, so chunk i starts at
 * `i * (BLOB_CHUNK_BYTES + BLOB_CHUNK_OVERHEAD)`.
 */
export const BLOB_CHUNK_BYTES = 4 * 1024 * 1024
/** IV and GCM tag of one chunk. */
export const BLOB_CHUNK_OVERHEAD = 12 + 16

/** How many chunks a file of this size takes. An empty file is one empty chunk. */
export function blobChunkCount(plainBytes: number): number {
  return Math.max(1, Math.ceil(plainBytes / BLOB_CHUNK_BYTES))
}

/** Associated data of one chunk: a chunk moved, dropped or swapped no longer decrypts. */
export function blobChunkAad(blobId: string, index: number, count: number): string {
  return `blob:${blobId}#${index}/${count}`
}

// Rooms are keyed by a stable id, never by a path, so renaming a note keeps
// its history and its collaborators. Note rooms are global: two vaults hold the
// same docId under paths of their own when a note is shared.
export function docRoom(docId: string): string {
  return `doc:${docId}`
}

export function indexRoom(vaultId: string): string {
  return `idx:${vaultId}`
}

export function settingsRoom(vaultId: string): string {
  return `set:${vaultId}`
}

/**
 * A shared folder's structure: which notes and files are in it, where. Global
 * like a note's room - everyone in the folder reaches it from their own vault.
 */
export function folderRoom(folderId: string): string {
  return `fld:${folderId}`
}

export type RoomKind = 'doc' | 'idx' | 'set' | 'fld'

export function roomKind(room: string): RoomKind | null {
  if (room.startsWith('doc:')) return 'doc'
  if (room.startsWith('idx:')) return 'idx'
  if (room.startsWith('set:')) return 'set'
  if (room.startsWith('fld:')) return 'fld'
  return null
}

/**
 * Whether a note's epochs are tied to its folders' in order: a later epoch of
 * the note never to an earlier epoch of the same folder. A server tying a new
 * epoch to an old one would have everyone encrypt under a key someone revoked
 * holds.
 */
export function tiesAscend(ties: Record<string, { folder: string; epoch: number }>): boolean {
  const last = new Map<string, number>()
  for (const epoch of Object.keys(ties).map(Number).sort((a, b) => a - b)) {
    const tie = ties[String(epoch)]
    if (!tie || typeof tie.folder !== 'string' || !Number.isInteger(tie.epoch)) return false
    if (tie.epoch < (last.get(tie.folder) ?? -1)) return false
    last.set(tie.folder, tie.epoch)
  }
  return true
}

export function isDocRoom(room: string): boolean {
  return roomKind(room) === 'doc'
}

/** The document or vault id a room is named after. */
export function roomSubject(room: string): string {
  return room.slice(room.indexOf(':') + 1)
}

const HEX_ID = /^[0-9a-f]{32}$/

/** Document and vault ids are 128 bits, hex. */
export function isHexId(value: string): boolean {
  return HEX_ID.test(value)
}

/**
 * Messages on the multiplexed vault socket: `[varUint type][...]`. Room
 * messages continue with `[varString room]`. One connection carries every
 * note of a vault; a WebSocket per note does not survive a real vault.
 */
export const MUX = {
  // client -> server
  /**
   * room, varUint afterSeq, varUint create (1: a missing room is created and
   * owned by the caller; 0: it is answered with `denied` "missing"), and
   * optionally varString folder: a missing note is created in that shared
   * folder, owned by the folder's owner - if the caller may write in it.
   */
  subscribe: 1,
  /** room */
  unsubscribe: 2,
  /** room, varUint ref, varUint epoch, varUint8Array ciphertext */
  push: 3,
  /** room, varUint epoch, varUint8Array ciphertext - both directions */
  awareness: 4,
  /**
   * room (empty), varString lock id: this connection holds the vault's lock and
   * writes under it - a rollback, or a restore from the Time Machine. Sent
   * again after every reconnect. Before 0.8.15 the server let it write only
   * under a lock of kind `rollback`.
   */
  holdLock: 5,
  /**
   * room (empty), varUint count, then per note varString room, varUint seq:
   * notes this device knows up to `seq` and does not hold open. The server
   * answers with `changed` for each whose log is further on, and again
   * whenever a frame lands in one. Sent again, whole, after every reconnect.
   */
  watch: 6,
  /** room (empty), varUint count, then varString room each: no longer watched - held open, or gone. */
  unwatch: 7,

  // server -> client
  /** room, varUint seq, varUint ts, varUint epoch, varUint8Array ciphertext */
  frame: 10,
  /** room, varUint uptoSeq, varUint epoch, varUint8Array ciphertext */
  snapshot: 11,
  /**
   * room, varUint headSeq, varUint epoch - everything readable has been sent;
   * for an epoch a note spends in a shared folder also varString folder,
   * varUint folder epoch: what its key derives from
   */
  caughtUp: 12,
  /** room, varUint ref, varUint seq */
  ack: 13,
  /** room, varUint epoch - a push used an old epoch, or the epoch moved; the folder tie as with caughtUp */
  rekey: 14,
  /** room, varString reason - access was taken away */
  revoked: 15,
  /** room, varString reason - never had access */
  denied: 16,
  /** varString kind, varString json - addressed to the account, not a room */
  notify: 17,
  /** varString message */
  error: 18,
  /**
   * room, varUint ref - the push was refused because the vault is locked
   * (`docs/TIMEMACHINE.md`): the device keeps it and sends it once the lock ends.
   */
  locked: 19,
  /** room, varUint headSeq - a watched note's log reaches further than the device knows; no content. */
  changed: 20
} as const

export type MuxMessage = (typeof MUX)[keyof typeof MUX]

/**
 * The close code of a vault socket whose token no longer holds - the
 * password was changed, or the account signed its other devices out. A
 * browser WebSocket cannot see the HTTP status of a refused upgrade, so the
 * server accepts the upgrade and closes with this instead.
 */
export const CLOSE_SIGNED_OUT = 4401

export const API = {
  health: '/health',
  config: '/auth/config',
  register: '/auth/register',
  login: '/auth/login',
  refresh: '/auth/refresh',
  password: '/auth/password',
  /** With a recovery code: the second wrapping, then `/commit` with a new name and password. */
  recover: '/auth/recover',
  account: '/account',
  /** Makes or replaces the recovery code; `/delete` removes it. */
  recovery: '/account/recovery',
  /** The second step of signing in with two-factor sign-in. */
  loginTotp: '/auth/login/totp',
  /** Turns two-factor sign-in on; `/off` turns it off. */
  totp: '/account/totp',
  /** Makes a backup key for one vault; `/delete` removes one. */
  backupKeys: '/account/backup-keys',
  /** A backup server signing in with its backup key. */
  backupLogin: '/auth/backup',
  /** The rooms of the vault a backup token reads. */
  backupRooms: '/backup/rooms',
  /**
   * Also `/vaults/:vaultId/lock`: the vault's lock (`docs/TIMEMACHINE.md`) -
   * taken, `/renew`ed and `/release`d by its holder, `/break`able by any device
   * of the account.
   */
  vaults: '/vaults',
  contacts: '/contacts',
  shares: '/shares',
  /** Shared folders: sharing, notes joining and leaving, revoking, ending. */
  folders: '/folders',
  /** Shares that ended, kept for the participant until one of their devices forked. */
  forks: '/forks',
  keys: '/keys',
  log: '/log',
  compactable: '/compactable',
  /** The rooms of a vault that took a frame since a moment: what planning a rollback must read. */
  changed: '/changed',
  /** When the notes of a vault took frames, to the minute: the Time Machine's ticks. */
  times: '/times',
  /** `/blobs/:account/:vaultId/...`: the encrypted contents of a vault's files. */
  blobs: '/blobs'
} as const

/** Associated data for a frame: binds the ciphertext to its room and epoch. */
export function frameAad(room: string, epoch: number): string {
  return `${room}#${epoch}`
}

/** Associated data for a snapshot, so one can never be replayed as a frame or the reverse. */
export function snapshotAad(room: string, epoch: number): string {
  return `${frameAad(room, epoch)}:snapshot`
}

/** Associated data for presence. */
export function awarenessAad(room: string, epoch: number): string {
  return `${frameAad(room, epoch)}:awareness`
}
