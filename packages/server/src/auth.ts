import { SignJWT, jwtVerify } from 'jose'

export interface IssuedToken {
  token: string
  expiresIn: number
}

/** Access tokens name an account and nothing else; what it may do is decided per request. */
export class TokenService {
  private readonly key: Uint8Array

  constructor(
    secret: string,
    private readonly ttlSeconds: number
  ) {
    this.key = new TextEncoder().encode(secret)
  }

  async issue(username: string): Promise<IssuedToken> {
    const token = await new SignJWT({ scope: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(username)
      .setIssuer('obsidian-connect')
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.key)
    return { token, expiresIn: this.ttlSeconds }
  }

  /** The username the token was issued to. Throws for anything else. */
  async verify(token: string): Promise<string> {
    const { payload } = await jwtVerify(token, this.key, { issuer: 'obsidian-connect' })
    if (payload.scope !== 'user' || typeof payload.sub !== 'string') throw new Error('not a user token')
    return payload.sub
  }
}
