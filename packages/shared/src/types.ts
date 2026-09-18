import type { CollabUser, ShareRole } from './protocol'

export interface AuthTokens {
  accessToken: string
  expiresIn: number
  user: CollabUser
}

export interface DevTokenRequest {
  name?: string
}

export interface LoginRequest {
  email: string
  password: string
}

export interface ShareTokenRequest {
  room: string
  role: ShareRole
  expiresInSeconds?: number
}

export interface ShareTokenResponse {
  token: string
  room: string
  role: ShareRole
  expiresAt: string
}

export interface JwtClaims {
  sub: string
  name: string
  color: string
  colorLight: string
  scope: 'user' | 'share'
  room?: string
  role?: ShareRole
}
