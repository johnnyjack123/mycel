import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AccountBundle,
  KdfParams,
  PasswordChangeRequest,
  RegisterRequest,
  RegistrationMode,
  VaultRecord
} from '@obsidian-connect/shared'

// Accounts live in one JSON file. The server and the CLI (`docker exec …
// obsidian-connect user add`) both write it, so every change re-reads the file
// first and replaces it atomically, and the server reloads it when it changed.
//
// Nothing here can decrypt anything. The server keeps a keyed hash of a key
// the client derived from the password, and key material that only the
// client's master key opens.

export interface StoredVault {
  name: string
  wrappedKey: string
  createdAt: number
}

export interface StoredAccount {
  username: string
  createdAt: number
  status: 'pending' | 'active'
  /** sha256 of the invite code, while the account waits to be claimed. */
  inviteHash?: string
  kdf?: KdfParams
  authSalt?: string
  authHash?: string
  publicKey?: string
  wrappedPrivateKey?: string
  vaults: Record<string, StoredVault>
}

type AccountMap = Record<string, StoredAccount>

export class AccountError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/
const MIN_MEMORY_KIB = 8_192

export function normalizeUsername(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const normalized = name.trim().toLowerCase()
  return USERNAME.test(normalized) ? normalized : null
}

/** One vault per name per account; a second device finds it by signing in and naming it. */
export function vaultIdFor(username: string, vaultName: string): string {
  return createHash('sha256').update(`vault::${username}::${vaultName}`).digest('hex').slice(0, 32)
}

function decoded(value: unknown, minBytes: number): Buffer | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const buffer = Buffer.from(value, 'base64')
  return buffer.length >= minBytes ? buffer : null
}

function validKdf(kdf: unknown): kdf is KdfParams {
  if (!kdf || typeof kdf !== 'object') return false
  const params = kdf as Partial<KdfParams>
  return (
    params.algorithm === 'argon2id' &&
    Number.isInteger(params.memoryKiB) &&
    (params.memoryKiB ?? 0) >= MIN_MEMORY_KIB &&
    Number.isInteger(params.iterations) &&
    (params.iterations ?? 0) >= 1 &&
    Number.isInteger(params.parallelism) &&
    (params.parallelism ?? 0) >= 1 &&
    decoded(params.salt, 16) !== null
  )
}

function authHash(salt: string, authKey: string): string {
  return createHmac('sha256', Buffer.from(salt, 'base64')).update(Buffer.from(authKey, 'base64')).digest('base64')
}

function inviteHash(code: string): string {
  return createHash('sha256').update(code.trim().toLowerCase()).digest('hex')
}

function newInviteCode(): string {
  const hex = randomBytes(8).toString('hex')
  return hex.match(/.{4}/g)?.join('-') ?? hex
}

export class AccountStore {
  private cache: { mtimeMs: number; accounts: AccountMap } | null = null
  private writes: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dataDir: string,
    private readonly secret: string
  ) {}

  private get file(): string {
    return join(this.dataDir, 'accounts.json')
  }

  private async load(): Promise<AccountMap> {
    let mtimeMs: number
    try {
      mtimeMs = (await stat(this.file)).mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return {}
    }
    if (this.cache && this.cache.mtimeMs === mtimeMs) return this.cache.accounts
    const parsed = JSON.parse(await readFile(this.file, 'utf8')) as { accounts?: AccountMap }
    const accounts = parsed.accounts ?? {}
    this.cache = { mtimeMs, accounts }
    return accounts
  }

  private async save(accounts: AccountMap): Promise<void> {
    await mkdir(this.dataDir, { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify({ accounts }, null, 2))
    await rename(temp, this.file)
    this.cache = { mtimeMs: (await stat(this.file)).mtimeMs, accounts }
  }

  /** Read, change, write - one at a time within this process. */
  private update<T>(mutate: (accounts: AccountMap) => T | Promise<T>): Promise<T> {
    const run = this.writes.then(async () => {
      this.cache = null
      const accounts = structuredClone(await this.load())
      const result = await mutate(accounts)
      await this.save(accounts)
      return result
    })
    this.writes = run.catch(() => undefined)
    return run
  }

  async get(username: string): Promise<StoredAccount | undefined> {
    return (await this.load())[username]
  }

  async list(): Promise<StoredAccount[]> {
    return Object.values(await this.load()).sort((a, b) => a.username.localeCompare(b.username))
  }

  async activeUsernames(): Promise<string[]> {
    return (await this.list()).filter((account) => account.status === 'active').map((account) => account.username)
  }

  /** Creates a pending account, or renews the code of one, and returns the code. */
  invite(name: string): Promise<string> {
    const username = normalizeUsername(name)
    if (!username) return Promise.reject(new AccountError(400, 'usernames are 2-32 of a-z, 0-9, . _ -'))
    const code = newInviteCode()
    return this.update((accounts) => {
      const existing = accounts[username]
      if (existing?.status === 'active') throw new AccountError(409, `${username} already exists`)
      accounts[username] = {
        username,
        createdAt: existing?.createdAt ?? Date.now(),
        status: 'pending',
        inviteHash: inviteHash(code),
        vaults: {}
      }
      return code
    })
  }

  register(request: RegisterRequest, mode: RegistrationMode): Promise<StoredAccount> {
    const username = normalizeUsername(request.username)
    if (!username) return Promise.reject(new AccountError(400, 'usernames are 2-32 of a-z, 0-9, . _ -'))
    if (!validKdf(request.kdf)) return Promise.reject(new AccountError(400, 'invalid key derivation parameters'))
    if (!decoded(request.authKey, 32) || !decoded(request.publicKey, 65) || !decoded(request.wrappedPrivateKey, 16)) {
      return Promise.reject(new AccountError(400, 'incomplete key material'))
    }
    return this.update((accounts) => {
      const existing = accounts[username]
      if (existing?.status === 'active') throw new AccountError(409, 'that name is taken')
      // An invited name needs its invite even when anyone may register: the
      // admin meant it for someone.
      if (existing?.status === 'pending' || mode === 'invite') {
        if (!existing || !request.invite || existing.inviteHash !== inviteHash(request.invite)) {
          throw new AccountError(403, 'a valid invite code is required')
        }
      }
      const authSalt = randomBytes(16).toString('base64')
      const account: StoredAccount = {
        username,
        createdAt: existing?.createdAt ?? Date.now(),
        status: 'active',
        kdf: request.kdf,
        authSalt,
        authHash: authHash(authSalt, request.authKey),
        publicKey: request.publicKey,
        wrappedPrivateKey: request.wrappedPrivateKey,
        vaults: {}
      }
      accounts[username] = account
      return account
    })
  }

  /** The account if `authKey` is right, otherwise null - never which part was wrong. */
  async verify(name: string, authKey: unknown): Promise<StoredAccount | null> {
    const username = normalizeUsername(name)
    if (!username || typeof authKey !== 'string') return null
    const account = await this.get(username)
    if (!account || account.status !== 'active' || !account.authSalt || !account.authHash) return null
    const expected = Buffer.from(account.authHash, 'base64')
    const actual = Buffer.from(authHash(account.authSalt, authKey), 'base64')
    return expected.length === actual.length && timingSafeEqual(expected, actual) ? account : null
  }

  /**
   * The parameters to derive a login key with. An unknown name gets a salt
   * derived from the server secret, stable across calls, so asking does not
   * tell whether an account exists.
   */
  async kdfFor(name: string): Promise<KdfParams> {
    const username = normalizeUsername(name) ?? ''
    const account = username ? await this.get(username) : undefined
    if (account?.status === 'active' && account.kdf) return account.kdf
    const salt = createHmac('sha256', this.secret).update(`prelogin::${username}`).digest().subarray(0, 16)
    return { algorithm: 'argon2id', salt: salt.toString('base64'), memoryKiB: 19_456, iterations: 2, parallelism: 1 }
  }

  /** Registers a vault, or returns the one the account already has under that name. */
  addVault(username: string, name: unknown, wrappedKey: unknown): Promise<VaultRecord> {
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 200) {
      return Promise.reject(new AccountError(400, 'a vault needs a name'))
    }
    if (!decoded(wrappedKey, 16)) return Promise.reject(new AccountError(400, 'a vault needs its wrapped key'))
    const vaultName = name.trim()
    return this.update((accounts) => {
      const account = accounts[username]
      if (!account || account.status !== 'active') throw new AccountError(401, 'unknown account')
      const vaultId = vaultIdFor(username, vaultName)
      const existing = account.vaults[vaultId]
      // First writer wins: a second device creating the same vault at the same
      // moment gets the first one's key back and uses that.
      if (existing) return { vaultId, name: existing.name, wrappedKey: existing.wrappedKey }
      account.vaults[vaultId] = { name: vaultName, wrappedKey: wrappedKey as string, createdAt: Date.now() }
      return { vaultId, name: vaultName, wrappedKey: wrappedKey as string }
    })
  }

  changePassword(username: string, request: PasswordChangeRequest): Promise<StoredAccount> {
    if (!validKdf(request.kdf)) return Promise.reject(new AccountError(400, 'invalid key derivation parameters'))
    if (!decoded(request.newAuthKey, 32) || !decoded(request.wrappedPrivateKey, 16)) {
      return Promise.reject(new AccountError(400, 'incomplete key material'))
    }
    return this.verify(username, request.authKey).then((verified) => {
      if (!verified) throw new AccountError(403, 'the current password is wrong')
      return this.update((accounts) => {
        const account = accounts[username]
        if (!account) throw new AccountError(401, 'unknown account')
        // Every vault must come along; a missing one would be locked for good.
        for (const vaultId of Object.keys(account.vaults)) {
          if (!decoded(request.vaults?.[vaultId], 16)) throw new AccountError(400, `vault ${vaultId} is missing`)
        }
        const authSalt = randomBytes(16).toString('base64')
        account.kdf = request.kdf
        account.authSalt = authSalt
        account.authHash = authHash(authSalt, request.newAuthKey)
        account.wrappedPrivateKey = request.wrappedPrivateKey
        for (const [vaultId, vault] of Object.entries(account.vaults)) {
          vault.wrappedKey = request.vaults[vaultId] as string
        }
        return account
      })
    })
  }

  remove(name: string): Promise<boolean> {
    const username = normalizeUsername(name)
    if (!username) return Promise.resolve(false)
    return this.update((accounts) => {
      if (!accounts[username]) return false
      delete accounts[username]
      return true
    })
  }

  bundle(account: StoredAccount): AccountBundle {
    if (!account.kdf || !account.publicKey || !account.wrappedPrivateKey) {
      throw new AccountError(409, 'the account has not been set up yet')
    }
    return {
      username: account.username,
      kdf: account.kdf,
      publicKey: account.publicKey,
      wrappedPrivateKey: account.wrappedPrivateKey,
      vaults: Object.entries(account.vaults).map(([vaultId, vault]) => ({
        vaultId,
        name: vault.name,
        wrappedKey: vault.wrappedKey
      }))
    }
  }
}
