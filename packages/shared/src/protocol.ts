// Version 4: a subscribe says whether the room may be created, and the server
// knows accounts only by id - no names, no salts per name. Version 3: the
// server stores an ordered log of encrypted frames and can no longer read a
// document. Version 2 relayed plaintext Yjs sync messages.
export const PROTOCOL_VERSION = 4
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
// In a shared note's own document, next to its text: link -> SharedAttachment,
// and the note's sharing settings - for now only `attachments: boolean`.
export const NOTE_ATTACHMENTS_FIELD = 'attachments'
export const NOTE_SHARE_FIELD = 'share'

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

export type RoomKind = 'doc' | 'idx' | 'set'

export function roomKind(room: string): RoomKind | null {
  if (room.startsWith('doc:')) return 'doc'
  if (room.startsWith('idx:')) return 'idx'
  if (room.startsWith('set:')) return 'set'
  return null
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
   * owned by the caller; 0: it is answered with `denied` "missing")
   */
  subscribe: 1,
  /** room */
  unsubscribe: 2,
  /** room, varUint ref, varUint epoch, varUint8Array ciphertext */
  push: 3,
  /** room, varUint epoch, varUint8Array ciphertext - both directions */
  awareness: 4,

  // server -> client
  /** room, varUint seq, varUint ts, varUint epoch, varUint8Array ciphertext */
  frame: 10,
  /** room, varUint uptoSeq, varUint epoch, varUint8Array ciphertext */
  snapshot: 11,
  /** room, varUint headSeq, varUint epoch - everything readable has been sent */
  caughtUp: 12,
  /** room, varUint ref, varUint seq */
  ack: 13,
  /** room, varUint epoch - a push used an old epoch, or the epoch moved */
  rekey: 14,
  /** room, varString reason - access was taken away */
  revoked: 15,
  /** room, varString reason - never had access */
  denied: 16,
  /** varString kind, varString json - addressed to the account, not a room */
  notify: 17,
  /** varString message */
  error: 18
} as const

export type MuxMessage = (typeof MUX)[keyof typeof MUX]

export const API = {
  health: '/health',
  config: '/auth/config',
  register: '/auth/register',
  login: '/auth/login',
  refresh: '/auth/refresh',
  password: '/auth/password',
  account: '/account',
  vaults: '/vaults',
  /** `/accounts/:accountId/key`: someone's public key, by account id. */
  accounts: '/accounts',
  contacts: '/contacts',
  shares: '/shares',
  /** Shares that ended, kept for the participant until one of their devices forked. */
  forks: '/forks',
  keys: '/keys',
  log: '/log',
  compactable: '/compactable',
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
