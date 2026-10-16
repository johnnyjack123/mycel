import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AccountBundle,
  PasswordChangeRequest,
  RecoverCommitRequest,
  RecoveryRecord,
  RegisterRequest,
  RegistrationMode,
  VaultRecord
} from '@obsidian-connect/shared'
import { TOTP_SECRET_BYTES, totpMatch } from './totp.js'

// Accounts live in one JSON file. The server and the CLI (`docker exec …
// obsidian-connect invite`) both write it, so every change re-reads the file
// first and replaces it atomically, and the server reloads it when it changed.
//
// The server knows no names. An account is a random id; it is found by the
// hash of a login key the device derived from name and password together, so
// neither part alone leads anywhere, and nothing stored here says who anyone
// is. Nothing here can decrypt anything either: the key material is wrapped
// under a master key that never leaves a device.

export interface StoredVault {
  sealedName: string
  wrappedKey: string
  createdAt: number
}

export interface StoredAccount {
  accountId: string
  createdAt: number
  /** sha256 of the login key. */
  loginHash: string
  kdfVersion: number
  publicKey: string
  wrappedPrivateKey: string
  wrappedAccountSecret: string
  vaults: Record<string, StoredVault>
  /**
   * The session generation every valid token carries. Moving it on signs out
   * every device holding an older token; absent is 0.
   */
  sessions?: number
  /** The recovery code: the hash of its key, and the account's keys wrapped under it. */
  recovery?: StoredRecovery
  /** Two-factor sign-in, when it is on. */
  totp?: StoredTotp
  /** Backup keys, by id: each reads one vault for a backup server. */
  backupKeys?: Record<string, StoredBackupKey>
}

export interface StoredBackupKey {
  /** sha256 of the key. */
  hash: string
  vaultId: string
  label: string
  createdAt: number
  lastUsedAt?: number
}

export interface StoredTotp {
  /** Base64. The server has to read it to check a code. */
  secret: string
  createdAt: number
  /** The last time step a code was accepted for; it and every one before are spent. */
  lastStep: number
}

export interface StoredRecovery {
  /** sha256 of the recovery key. */
  hash: string
  wrappedPrivateKey: string
  wrappedAccountSecret: string
  createdAt: number
}

/** The generation a token of this account must carry. */
export function sessionOf(account: StoredAccount): number {
  return account.sessions ?? 0
}

export interface StoredInvite {
  createdAt: number
}

interface AccountFile {
  accounts: Record<string, StoredAccount>
  /** loginHash -> account id. */
  logins: Record<string, string>
  /** Recovery hash -> account id: a code alone finds its account, no name needed. */
  recoveries: Record<string, string>
  /** Backup key hash -> whose key it is. */
  backupLogins: Record<string, { account: string; id: string }>
  /** sha256 of an invite code -> the invite. Consumed by registering. */
  invites: Record<string, StoredInvite>
  /**
   * Account id -> when it was removed, until the server has ended its shares
   * and deleted its folder. Only what is listed here is ever deleted: an
   * account merely missing - a damaged or half-restored file - takes nothing
   * with it.
   */
  removed: Record<string, number>
}

export class AccountError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

const HEX_ID = /^[0-9a-f]{32}$/

export function isAccountId(value: unknown): value is string {
  return typeof value === 'string' && HEX_ID.test(value)
}

function decoded(value: unknown, minBytes: number): Buffer | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const buffer = Buffer.from(value, 'base64')
  return buffer.length >= minBytes ? buffer : null
}

function loginHash(loginKey: Buffer): string {
  return createHash('sha256').update(loginKey).digest('hex')
}

function inviteHash(code: string): string {
  return createHash('sha256').update(code.trim().toLowerCase()).digest('hex')
}

function newInviteCode(): string {
  const hex = randomBytes(10).toString('hex')
  return hex.match(/.{4}/g)?.join('-') ?? hex
}

function empty(): AccountFile {
  return { accounts: {}, logins: {}, recoveries: {}, backupLogins: {}, invites: {}, removed: {} }
}

/** Plenty for a few backup servers per vault; a bound on what a token can pile up. */
const MAX_BACKUP_KEYS = 32
const MAX_LABEL = 100

/**
 * Ends every backup key of the account, as a password change or a recovery
 * signs out every other device: a key made with a stolen password goes too.
 */
function dropBackupKeys(data: AccountFile, account: StoredAccount): void {
  for (const key of Object.values(account.backupKeys ?? {})) delete data.backupLogins[key.hash]
  delete account.backupKeys
}

/** A recovery code as the device sent it, checked, or why not. */
function recoveryOf(record: unknown, now: number): StoredRecovery {
  const { recoveryKey, wrappedPrivateKey, wrappedAccountSecret } = (record ?? {}) as Partial<RecoveryRecord>
  const key = decoded(recoveryKey, 32)
  if (!key || !decoded(wrappedPrivateKey, 16) || !decoded(wrappedAccountSecret, 16)) {
    throw new AccountError(400, 'incomplete recovery code')
  }
  return {
    hash: loginHash(key),
    wrappedPrivateKey: wrappedPrivateKey as string,
    wrappedAccountSecret: wrappedAccountSecret as string,
    createdAt: now
  }
}

/** Replaces the account's recovery code in the account and the index, in one change of the file. */
function setRecoveryIn(data: AccountFile, account: StoredAccount, recovery: StoredRecovery | null): void {
  // 128 random bits do not collide; a code already in use - this account's
  // own too, which a recovery has to replace - was sent twice.
  if (recovery && data.recoveries[recovery.hash] !== undefined) throw new AccountError(409, 'make another recovery code')
  if (account.recovery) delete data.recoveries[account.recovery.hash]
  if (recovery) {
    account.recovery = recovery
    data.recoveries[recovery.hash] = account.accountId
  } else {
    delete account.recovery
  }
}

export class AccountStore {
  private cache: { mtimeMs: number; data: AccountFile } | null = null
  private writes: Promise<unknown> = Promise.resolve()
  private serverIdOnce: Promise<string> | null = null

  constructor(private readonly dataDir: string) {}

  private get file(): string {
    return join(this.dataDir, 'accounts.json')
  }

  private async load(): Promise<AccountFile> {
    let mtimeMs: number
    try {
      mtimeMs = (await stat(this.file)).mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return empty()
    }
    if (this.cache && this.cache.mtimeMs === mtimeMs) return this.cache.data
    const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<AccountFile>
    const data = { ...empty(), ...parsed }
    this.cache = { mtimeMs, data }
    return data
  }

  private async save(data: AccountFile): Promise<void> {
    await mkdir(this.dataDir, { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(data, null, 2))
    await rename(temp, this.file)
    this.cache = { mtimeMs: (await stat(this.file)).mtimeMs, data }
  }

  /** Read, change, write - one at a time within this process. */
  private update<T>(mutate: (data: AccountFile) => T | Promise<T>): Promise<T> {
    const run = this.writes.then(async () => {
      this.cache = null
      const data = structuredClone(await this.load())
      const result = await mutate(data)
      await this.save(data)
      return result
    })
    this.writes = run.catch(() => undefined)
    return run
  }

  /**
   * 128 random bits, made on the very first start and kept with the data:
   * every account's salt includes it, so it must never change - and it moves
   * with the data when the server moves.
   */
  serverId(): Promise<string> {
    this.serverIdOnce ??= (async () => {
      const file = join(this.dataDir, 'server.json')
      try {
        const stored = JSON.parse(await readFile(file, 'utf8')) as { serverId?: unknown }
        if (typeof stored.serverId === 'string' && HEX_ID.test(stored.serverId)) return stored.serverId
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const serverId = randomBytes(16).toString('hex')
      await mkdir(this.dataDir, { recursive: true })
      await writeFile(file, JSON.stringify({ serverId }, null, 2), { flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
        // Another process made it first; theirs counts.
        if (error.code !== 'EEXIST') throw error
      })
      const kept = JSON.parse(await readFile(file, 'utf8')) as { serverId: string }
      return kept.serverId
    })()
    return this.serverIdOnce
  }

  async get(accountId: string): Promise<StoredAccount | undefined> {
    return (await this.load()).accounts[accountId]
  }

  async list(): Promise<StoredAccount[]> {
    return Object.values((await this.load()).accounts).sort((a, b) => a.createdAt - b.createdAt)
  }

  async invites(): Promise<number> {
    return Object.keys((await this.load()).invites).length
  }

  /** A code that lets one person create one account. It names nobody. */
  invite(): Promise<string> {
    const code = newInviteCode()
    return this.update((data) => {
      data.invites[inviteHash(code)] = { createdAt: Date.now() }
      return code
    })
  }

  register(request: RegisterRequest, mode: RegistrationMode): Promise<StoredAccount> {
    const loginKey = decoded(request.loginKey, 32)
    if (!loginKey) return Promise.reject(new AccountError(400, 'the login key is missing'))
    if (!Number.isInteger(request.kdfVersion) || request.kdfVersion < 1) {
      return Promise.reject(new AccountError(400, 'unknown key derivation version'))
    }
    if (!decoded(request.publicKey, 65) || !decoded(request.wrappedPrivateKey, 16) || !decoded(request.wrappedAccountSecret, 16)) {
      return Promise.reject(new AccountError(400, 'incomplete key material'))
    }
    let recovery: StoredRecovery | null
    try {
      recovery = request.recovery === undefined ? null : recoveryOf(request.recovery, Date.now())
    } catch (error) {
      return Promise.reject(error)
    }
    return this.update((data) => {
      const hash = loginHash(loginKey)
      // Only someone who typed exactly these name and password gets here, and
      // they could sign in with them just as well - refusing tells nothing new.
      if (data.logins[hash]) throw new AccountError(409, 'choose another name or password')
      const invite = request.invite ? inviteHash(request.invite) : null
      if (mode === 'invite' || invite) {
        if (!invite || !data.invites[invite]) throw new AccountError(403, 'a valid invite code is required')
        delete data.invites[invite]
      }
      const accountId = randomBytes(16).toString('hex')
      const account: StoredAccount = {
        accountId,
        createdAt: Date.now(),
        loginHash: hash,
        kdfVersion: request.kdfVersion,
        publicKey: request.publicKey as string,
        wrappedPrivateKey: request.wrappedPrivateKey as string,
        wrappedAccountSecret: request.wrappedAccountSecret as string,
        vaults: {}
      }
      if (recovery) setRecoveryIn(data, account, recovery)
      data.accounts[accountId] = account
      data.logins[hash] = accountId
      return account
    })
  }

  /** The account a login key opens, or null - never why. */
  async login(loginKey: unknown): Promise<StoredAccount | null> {
    const key = decoded(loginKey, 32)
    if (!key) return null
    const data = await this.load()
    const accountId = data.logins[loginHash(key)]
    return accountId ? (data.accounts[accountId] ?? null) : null
  }

  /** Registers a vault under the id the device derived, or returns the one it already has. */
  addVault(accountId: string, vaultId: unknown, sealedName: unknown, wrappedKey: unknown): Promise<VaultRecord> {
    if (!isAccountId(vaultId)) return Promise.reject(new AccountError(400, 'not a vault id'))
    if (!decoded(sealedName, 16) || !decoded(wrappedKey, 16)) {
      return Promise.reject(new AccountError(400, 'a vault needs its sealed name and wrapped key'))
    }
    return this.update((data) => {
      const account = data.accounts[accountId]
      if (!account) throw new AccountError(401, 'unknown account')
      const existing = account.vaults[vaultId]
      // First writer wins: a second device creating the same vault at the same
      // moment gets the first one's key back and uses that.
      if (existing) return { vaultId, sealedName: existing.sealedName, wrappedKey: existing.wrappedKey }
      account.vaults[vaultId] = { sealedName: sealedName as string, wrappedKey: wrappedKey as string, createdAt: Date.now() }
      return { vaultId, sealedName: sealedName as string, wrappedKey: wrappedKey as string }
    })
  }

  changePassword(accountId: string, request: PasswordChangeRequest): Promise<StoredAccount> {
    const current = decoded(request.loginKey, 32)
    const next = decoded(request.newLoginKey, 32)
    if (!current || !next) return Promise.reject(new AccountError(400, 'the login keys are missing'))
    if (!Number.isInteger(request.kdfVersion) || request.kdfVersion < 1) {
      return Promise.reject(new AccountError(400, 'unknown key derivation version'))
    }
    if (!decoded(request.wrappedPrivateKey, 16) || !decoded(request.wrappedAccountSecret, 16)) {
      return Promise.reject(new AccountError(400, 'incomplete key material'))
    }
    return this.update((data) => {
      const account = data.accounts[accountId]
      // A token alone - it travels in the socket URL - is not enough to
      // replace every wrapped key of the account.
      if (!account || account.loginHash !== loginHash(current)) throw new AccountError(403, 'the current password is wrong')
      const hash = loginHash(next)
      if (data.logins[hash] && data.logins[hash] !== accountId) throw new AccountError(409, 'choose another name or password')
      delete data.logins[account.loginHash]
      data.logins[hash] = accountId
      account.loginHash = hash
      account.kdfVersion = request.kdfVersion
      account.wrappedPrivateKey = request.wrappedPrivateKey
      account.wrappedAccountSecret = request.wrappedAccountSecret
      // Whoever signed in with the old password keeps the account secret, but
      // not the server: their token stops working here.
      account.sessions = sessionOf(account) + 1
      dropBackupKeys(data, account)
      return account
    })
  }

  /**
   * Makes or replaces the recovery code, or removes it (`record` null). Needs
   * the current password: a token alone could otherwise plant a code its
   * holder knows - with wrappings of nothing - and through a recovery replace
   * the account's keys.
   */
  setRecovery(accountId: string, loginKey: unknown, record: unknown, now = Date.now()): Promise<StoredAccount> {
    const current = decoded(loginKey, 32)
    if (!current) return Promise.reject(new AccountError(400, 'the login key is missing'))
    let recovery: StoredRecovery | null
    try {
      recovery = record === null ? null : recoveryOf(record, now)
    } catch (error) {
      return Promise.reject(error)
    }
    return this.update((data) => {
      const account = data.accounts[accountId]
      if (!account || account.loginHash !== loginHash(current)) throw new AccountError(403, 'the current password is wrong')
      setRecoveryIn(data, account, recovery)
      return account
    })
  }

  /** The account a recovery key opens, or null - never why. */
  async findByRecovery(recoveryKey: unknown): Promise<StoredAccount | null> {
    const key = decoded(recoveryKey, 32)
    if (!key) return null
    const data = await this.load()
    const accountId = data.recoveries[loginHash(key)]
    return accountId ? (data.accounts[accountId] ?? null) : null
  }

  /**
   * A forgotten password: the recovery code sets a new name and password and
   * is spent - the request carries the next one. Every device signed in so far
   * is signed out. Null when the code opens no account. A wrong `totpCode`
   * changes nothing, so the code is not spent by a typo.
   */
  recover(request: RecoverCommitRequest, now = Date.now()): Promise<StoredAccount | null> {
    const key = decoded(request.recoveryKey, 32)
    const next = decoded(request.newLoginKey, 32)
    if (!key) return Promise.resolve(null)
    if (!next) return Promise.reject(new AccountError(400, 'the login key is missing'))
    if (!Number.isInteger(request.kdfVersion) || request.kdfVersion < 1) {
      return Promise.reject(new AccountError(400, 'unknown key derivation version'))
    }
    if (!decoded(request.wrappedPrivateKey, 16) || !decoded(request.wrappedAccountSecret, 16)) {
      return Promise.reject(new AccountError(400, 'incomplete key material'))
    }
    let recovery: StoredRecovery
    try {
      recovery = recoveryOf(request.recovery, now)
    } catch (error) {
      return Promise.reject(error)
    }
    return this.update((data) => {
      const accountId = data.recoveries[loginHash(key)]
      const account = accountId ? data.accounts[accountId] : undefined
      if (!account) return null
      const hash = loginHash(next)
      if (data.logins[hash] && data.logins[hash] !== account.accountId) throw new AccountError(409, 'choose another name or password')
      // The code stands in for every factor: a lost phone is a reason to use
      // it. Whoever still has the app proves it with a code and keeps it -
      // never weaker than turning it off, which the code allows anyway.
      if (account.totp && request.totpCode !== undefined) {
        const step = totpMatch(Buffer.from(account.totp.secret, 'base64'), request.totpCode, now, account.totp.lastStep)
        if (step === null) throw new AccountError(401, 'wrong code')
        account.totp.lastStep = step
      } else {
        delete account.totp
      }
      setRecoveryIn(data, account, recovery)
      delete data.logins[account.loginHash]
      data.logins[hash] = account.accountId
      account.loginHash = hash
      account.kdfVersion = request.kdfVersion
      account.wrappedPrivateKey = request.wrappedPrivateKey
      account.wrappedAccountSecret = request.wrappedAccountSecret
      account.sessions = sessionOf(account) + 1
      dropBackupKeys(data, account)
      return account
    })
  }

  // --- backup keys -------------------------------------------------------------

  /**
   * A key a backup server reads one vault with. Needs the current password, as
   * a recovery code does: a token alone - it travels in the socket URL - must
   * not hand out a vault for good.
   */
  addBackupKey(accountId: string, loginKey: unknown, vaultId: unknown, backupKey: unknown, label: unknown, now = Date.now()): Promise<string> {
    const current = decoded(loginKey, 32)
    const key = decoded(backupKey, 32)
    if (!current) return Promise.reject(new AccountError(400, 'the login key is missing'))
    if (!key) return Promise.reject(new AccountError(400, 'the backup key is missing'))
    if (!isAccountId(vaultId)) return Promise.reject(new AccountError(400, 'not a vault id'))
    if (typeof label !== 'string' || label.length > MAX_LABEL) return Promise.reject(new AccountError(400, 'the label is missing or too long'))
    return this.update((data) => {
      const account = data.accounts[accountId]
      if (!account || account.loginHash !== loginHash(current)) throw new AccountError(403, 'the current password is wrong')
      if (!account.vaults[vaultId]) throw new AccountError(403, 'not your vault')
      const keys = (account.backupKeys ??= {})
      if (Object.keys(keys).length >= MAX_BACKUP_KEYS) throw new AccountError(409, 'too many backup keys; delete one first')
      const hash = loginHash(key)
      // 256 random bits do not collide: this one was sent twice.
      if (data.backupLogins[hash]) throw new AccountError(409, 'make another backup key')
      const id = randomBytes(8).toString('hex')
      keys[id] = { hash, vaultId, label: label.trim(), createdAt: now }
      data.backupLogins[hash] = { account: accountId, id }
      return id
    })
  }

  /** Removing one only takes access away, so the signed-in device is enough. */
  deleteBackupKey(accountId: string, id: unknown): Promise<StoredAccount> {
    return this.update((data) => {
      const account = data.accounts[accountId]
      if (!account) throw new AccountError(401, 'unknown account')
      const key = typeof id === 'string' ? account.backupKeys?.[id] : undefined
      if (key && account.backupKeys) {
        delete data.backupLogins[key.hash]
        delete account.backupKeys[id as string]
      }
      return account
    })
  }

  /** The account and key a backup key opens, or null - never why. */
  async findBackupKey(backupKey: unknown): Promise<{ account: StoredAccount; id: string; key: StoredBackupKey } | null> {
    const key = decoded(backupKey, 32)
    if (!key) return null
    const data = await this.load()
    const found = data.backupLogins[loginHash(key)]
    const account = found ? data.accounts[found.account] : undefined
    const stored = found ? account?.backupKeys?.[found.id] : undefined
    return account && stored && found ? { account, id: found.id, key: stored } : null
  }

  async touchBackupKey(accountId: string, id: string, now = Date.now()): Promise<void> {
    await this.update((data) => {
      const key = data.accounts[accountId]?.backupKeys?.[id]
      if (key) key.lastUsedAt = now
    })
  }

  // --- two-factor sign-in ------------------------------------------------------

  /**
   * Turns two-factor sign-in on, with the secret the device made, once a code
   * from the app proves the app has it. Signs out every other device: they
   * sign in again, with a code.
   */
  enableTotp(accountId: string, loginKey: unknown, secret: unknown, code: unknown, now = Date.now()): Promise<StoredAccount> {
    const current = decoded(loginKey, 32)
    const key = decoded(secret, TOTP_SECRET_BYTES)
    if (!current) return Promise.reject(new AccountError(400, 'the login key is missing'))
    if (!key) return Promise.reject(new AccountError(400, 'the secret is missing'))
    return this.update((data) => {
      const account = data.accounts[accountId]
      if (!account || account.loginHash !== loginHash(current)) throw new AccountError(403, 'the current password is wrong')
      if (account.totp) throw new AccountError(409, 'two-factor sign-in is on already')
      const step = totpMatch(key, code, now, -1)
      if (step === null) throw new AccountError(403, 'the code does not match')
      account.totp = { secret: secret as string, createdAt: now, lastStep: step }
      account.sessions = sessionOf(account) + 1
      return account
    })
  }

  /**
   * Whether the code is right for the account now, and if so spends its step.
   * Null for an account without two-factor sign-in.
   */
  checkTotp(accountId: string, code: unknown, now = Date.now()): Promise<boolean | null> {
    return this.update((data) => {
      const totp = data.accounts[accountId]?.totp
      if (!totp) return null
      const step = totpMatch(Buffer.from(totp.secret, 'base64'), code, now, totp.lastStep)
      if (step === null) return false
      totp.lastStep = step
      return true
    })
  }

  /**
   * In the settings, on a device signed in: the password alone. Asking for a
   * code as well added nothing - session and password already make a new
   * recovery code, and that turns it off - and it locked out exactly the
   * person it is for: someone whose phone is gone.
   */
  disableTotp(accountId: string, loginKey: unknown): Promise<StoredAccount> {
    const current = decoded(loginKey, 32)
    if (!current) return Promise.reject(new AccountError(400, 'the login key is missing'))
    return this.update((data) => {
      const account = data.accounts[accountId]
      if (!account || account.loginHash !== loginHash(current)) throw new AccountError(403, 'the current password is wrong')
      delete account.totp
      return account
    })
  }

  /**
   * The admin's way, for a lost phone without a recovery code. The password
   * is still needed to sign in - and to decrypt anything.
   */
  turnOffTotp(accountId: string): Promise<boolean> {
    return this.update((data) => {
      const account = data.accounts[accountId]
      if (!account?.totp) return false
      delete account.totp
      return true
    })
  }

  /** The account can no longer sign in at once; its data goes with the server's next sweep. */
  remove(accountId: string, now = Date.now()): Promise<boolean> {
    return this.update((data) => {
      const account = data.accounts[accountId]
      if (!account) return false
      delete data.logins[account.loginHash]
      if (account.recovery) delete data.recoveries[account.recovery.hash]
      dropBackupKeys(data, account)
      delete data.accounts[accountId]
      data.removed[accountId] = now
      return true
    })
  }

  /** Accounts removed whose data the server has not cleared yet, with when. */
  async removed(): Promise<Record<string, number>> {
    return { ...(await this.load()).removed }
  }

  /** The server has cleared everything of a removed account. */
  settleRemoval(accountId: string): Promise<void> {
    return this.update((data) => {
      delete data.removed[accountId]
    })
  }

  bundle(account: StoredAccount): AccountBundle {
    return {
      accountId: account.accountId,
      kdfVersion: account.kdfVersion,
      publicKey: account.publicKey,
      wrappedPrivateKey: account.wrappedPrivateKey,
      wrappedAccountSecret: account.wrappedAccountSecret,
      vaults: Object.entries(account.vaults).map(([vaultId, vault]) => ({
        vaultId,
        sealedName: vault.sealedName,
        wrappedKey: vault.wrappedKey
      })),
      recovery: account.recovery ? { createdAt: account.recovery.createdAt } : null,
      totp: Boolean(account.totp),
      backupKeys: Object.entries(account.backupKeys ?? {})
        .map(([id, key]) => ({ id, vaultId: key.vaultId, label: key.label, createdAt: key.createdAt, lastUsedAt: key.lastUsedAt }))
        .sort((a, b) => a.createdAt - b.createdAt)
    }
  }
}
