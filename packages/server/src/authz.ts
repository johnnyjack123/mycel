import type { CollabUser, JwtClaims } from '@obsidian-connect/shared'
import type { TokenService } from './auth.js'

export interface AccessDecision {
  user: CollabUser
  claims: JwtClaims | null
  canWrite: boolean
}

const ANONYMOUS: CollabUser = {
  id: 'anonymous',
  name: 'Anonymous',
  color: '#888888',
  colorLight: '#88888833'
}

export async function authorizeRoom(
  tokens: TokenService,
  token: string | null,
  room: string,
  devAllowAnonymous: boolean
): Promise<AccessDecision | null> {
  if (!token) {
    if (!devAllowAnonymous) return null
    return { user: ANONYMOUS, claims: null, canWrite: true }
  }

  try {
    const claims = await tokens.verify(token)
    const user: CollabUser = {
      id: claims.sub,
      name: claims.name,
      color: claims.color,
      colorLight: claims.colorLight
    }
    if (claims.scope === 'share') {
      if (claims.room !== room) return null
      return { user, claims, canWrite: claims.role === 'write' }
    }
    return { user, claims, canWrite: true }
  } catch {
    return null
  }
}
