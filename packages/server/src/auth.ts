import { SignJWT, jwtVerify } from 'jose'

export interface IssuedToken {
  token: string
  expiresIn: number
}

/** Whose token, and from which of the account's session generations. */
export interface TokenSession {
  accountId: string
  /** Valid only while the account is still at it; tokens from before generations are 0. */
  gen: number
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

  async issue(accountId: string, gen: number): Promise<IssuedToken> {
    const token = await new SignJWT({ scope: 'user', gen })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(accountId)
      .setIssuer('obsidian-connect')
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.key)
    return { token, expiresIn: this.ttlSeconds }
  }

  /** The session the token was issued for. Throws for anything else. */
  async verify(token: string): Promise<TokenSession> {
    return this.check(token, 'user')
  }

  /**
   * What the right password earns an account with two-factor sign-in: a
   * token for the second step only, for a few minutes. No route but that
   * step accepts it.
   */
  async challenge(accountId: string, gen: number): Promise<string> {
    return new SignJWT({ scope: '2fa', gen })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(accountId)
      .setIssuer('obsidian-connect')
      .setIssuedAt()
      .setExpirationTime(`${CHALLENGE_SECONDS}s`)
      .sign(this.key)
  }

  async verifyChallenge(token: string): Promise<TokenSession> {
    return this.check(token, '2fa')
  }

  private async check(token: string, scope: 'user' | '2fa'): Promise<TokenSession> {
    const { payload } = await jwtVerify(token, this.key, { issuer: 'obsidian-connect' })
    if (payload.scope !== scope || typeof payload.sub !== 'string') throw new Error(`not a ${scope} token`)
    return { accountId: payload.sub, gen: typeof payload.gen === 'number' ? payload.gen : 0 }
  }
}

const CHALLENGE_SECONDS = 5 * 60
