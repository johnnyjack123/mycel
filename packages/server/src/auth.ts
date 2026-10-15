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

  /**
   * What a backup key earns: reading one vault, for an hour - a backup server
   * signs in again with its key whenever it needs to. Only the reading routes
   * accept it, and only for that vault.
   */
  async issueBackup(accountId: string, gen: number, vaultId: string, keyId: string): Promise<IssuedToken> {
    const token = await new SignJWT({ scope: 'backup', gen, vault: vaultId, kid: keyId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(accountId)
      .setIssuer('obsidian-connect')
      .setIssuedAt()
      .setExpirationTime(`${BACKUP_SECONDS}s`)
      .sign(this.key)
    return { token, expiresIn: BACKUP_SECONDS }
  }

  async verifyBackup(token: string): Promise<BackupSession> {
    const { payload } = await jwtVerify(token, this.key, { issuer: 'obsidian-connect' })
    if (payload.scope !== 'backup' || typeof payload.sub !== 'string' || typeof payload.vault !== 'string' || typeof payload.kid !== 'string') {
      throw new Error('not a backup token')
    }
    return { accountId: payload.sub, gen: typeof payload.gen === 'number' ? payload.gen : 0, vaultId: payload.vault, keyId: payload.kid }
  }

  private async check(token: string, scope: 'user' | '2fa'): Promise<TokenSession> {
    const { payload } = await jwtVerify(token, this.key, { issuer: 'obsidian-connect' })
    if (payload.scope !== scope || typeof payload.sub !== 'string') throw new Error(`not a ${scope} token`)
    return { accountId: payload.sub, gen: typeof payload.gen === 'number' ? payload.gen : 0 }
  }
}

/** A backup server's session: one vault, through one backup key. */
export interface BackupSession extends TokenSession {
  vaultId: string
  keyId: string
}

const CHALLENGE_SECONDS = 5 * 60
const BACKUP_SECONDS = 60 * 60
