import type { ShareRole } from './protocol.js'

export interface JwtClaims {
  sub: string
  name: string
  color: string
  colorLight: string
  scope: 'user' | 'share'
  room?: string
  role?: ShareRole
  iat?: number
  exp?: number
}

export interface DevTokenRequest {
  name?: string
}

export interface LoginRequest {
  email: string
  password?: string
}

// One note in the vault index document. The path is a mirror of the index
// entry, not the identity: identity is the docId that keys the entry.
export interface IndexEntry {
  path: string
  updatedAt: number
  deletedAt?: number
}

export interface RoomSummary {
  name: string
  connections: number
  chars: number
  versions: number
}
