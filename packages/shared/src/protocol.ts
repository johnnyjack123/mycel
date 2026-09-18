export const PROTOCOL_VERSION = 1
export const DEFAULT_SERVER_PORT = 1234

export type ShareRole = 'read' | 'write'

export interface CollabUser {
  id: string
  name: string
  color: string
  colorLight: string
}

export interface RoomRef {
  vaultId: string
  path: string
}

const ROOM_SEPARATOR = '::'

export function toRoomName(ref: RoomRef): string {
  return encodeURIComponent(`${ref.vaultId}${ROOM_SEPARATOR}${ref.path}`)
}

export function fromRoomName(room: string): RoomRef | null {
  const decoded = decodeURIComponent(room)
  const index = decoded.indexOf(ROOM_SEPARATOR)
  if (index < 0) return null
  return {
    vaultId: decoded.slice(0, index),
    path: decoded.slice(index + ROOM_SEPARATOR.length)
  }
}

export const API = {
  health: '/health',
  devToken: '/auth/dev-token',
  login: '/auth/login'
} as const
