export const PROTOCOL_VERSION = 2
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

// Rooms are keyed by a stable id, never by a path, so renaming a note keeps
// its history and its collaborators.
export function docRoom(docId: string): string {
  return `doc:${docId}`
}

export function indexRoom(vaultId: string): string {
  return `idx:${vaultId}`
}

export function isDocRoom(room: string): boolean {
  return room.startsWith('doc:')
}

// A shared note is addressed by its document id alone. Rooms are global, so
// the recipient keeps it under a path of their own choosing in their own vault.
export const SHARE_ACTION = 'connect-share'

export interface ShareLink {
  docId: string
  /** Suggested file name for the recipient; the id is what identifies the note. */
  title: string
}

// `stableDocId` yields 32 hex digits; its no-WebCrypto fallback is a UUID.
const DOC_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

export function isDocId(value: string): boolean {
  return DOC_ID.test(value)
}

export function shareLink(link: ShareLink): string {
  return `obsidian://${SHARE_ACTION}?id=${link.docId}&title=${encodeURIComponent(link.title)}`
}

/** Accepts a share link or a bare document id; anything else is null. */
export function parseShareLink(input: string): ShareLink | null {
  const trimmed = input.trim()
  if (isDocId(trimmed)) return { docId: trimmed, title: '' }
  const query = trimmed.split('?')[1]
  if (!query) return null
  const params = new Map<string, string>()
  for (const pair of query.split('&')) {
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    try {
      params.set(pair.slice(0, separator), decodeURIComponent(pair.slice(separator + 1).replace(/\+/g, ' ')))
    } catch {
      return null
    }
  }
  const docId = params.get('id') ?? ''
  if (!isDocId(docId)) return null
  return { docId, title: params.get('title') ?? '' }
}

// Messages on the multiplexed vault socket. One connection carries every note
// of a vault; opening a WebSocket per note does not scale past a few hundred.
export const MUX = {
  sync: 0,
  awareness: 1,
  subscribe: 2,
  unsubscribe: 3,
  error: 4
} as const

export type MuxMessage = (typeof MUX)[keyof typeof MUX]

export const API = {
  health: '/health',
  devToken: '/auth/dev-token',
  login: '/auth/login',
  rooms: '/rooms',
  history: '/history'
} as const

export interface HistoryVersion {
  ts: number
  bytes: number
}

export interface HistoryListResponse {
  room: string
  versions: HistoryVersion[]
}

export interface HistoryTextResponse {
  room: string
  ts: number
  text: string
}

export interface HistoryRestoreRequest {
  ts: number
}

export interface HistoryRestoreResponse {
  room: string
  ts: number
  restored: boolean
  chars: number
}

/** @deprecated Phase 0 path-keyed rooms. Kept so the relay self-test keeps working. */
export interface RoomRef {
  vaultId: string
  path: string
}

const ROOM_SEPARATOR = '::'

/** @deprecated Use {@link docRoom}. */
export function toRoomName(ref: RoomRef): string {
  return encodeURIComponent(`${ref.vaultId}${ROOM_SEPARATOR}${ref.path}`)
}

/** @deprecated Use {@link docRoom}. */
export function fromRoomName(room: string): RoomRef | null {
  const decoded = decodeURIComponent(room)
  const index = decoded.indexOf(ROOM_SEPARATOR)
  if (index < 0) return null
  return {
    vaultId: decoded.slice(0, index),
    path: decoded.slice(index + ROOM_SEPARATOR.length)
  }
}
