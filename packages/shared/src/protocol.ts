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
