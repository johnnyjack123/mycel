import { SignJWT, jwtVerify } from 'jose'
import { userColor, type CollabUser, type JwtClaims } from '@obsidian-connect/shared'

export interface IssuedToken {
  token: string
  expiresIn: number
  user: CollabUser
}

export interface UserIdentity {
  id: string
  name: string
}

export class TokenService {
  private readonly key: Uint8Array

  constructor(secret: string, private readonly ttlSeconds: number) {
    this.key = new TextEncoder().encode(secret)
  }

  async issueUserToken(identity: UserIdentity): Promise<IssuedToken> {
    const palette = userColor(identity.id)
    const user: CollabUser = {
      id: identity.id,
      name: identity.name,
      color: palette.color,
      colorLight: palette.colorLight
    }
    const token = await this.sign({ ...user, scope: 'user' })
    return { token, expiresIn: this.ttlSeconds, user }
  }

  async verify(token: string): Promise<JwtClaims> {
    const { payload } = await jwtVerify(token, this.key, { issuer: 'obsidian-connect' })
    return payload as unknown as JwtClaims
  }

  private async sign(claims: Omit<JwtClaims, 'sub'> & { id: string }): Promise<string> {
    const { id, ...rest } = claims
    return new SignJWT({ ...(rest as Record<string, unknown>) })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(id)
      .setIssuer('obsidian-connect')
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.key)
  }
}
