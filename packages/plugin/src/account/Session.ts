import type {
  AccountBundle,
  AuthConfigResponse,
  BackupGrant,
  RecoveryRecord,
  SecondFactorRequired,
  SessionResponse
} from '@obsidian-connect/shared'
import {
  CURRENT_KDF_VERSION,
  KDF_VERSIONS,
  accountKeys,
  accountSalt,
  aesKey,
  decodeRecoveryCode,
  decrypt,
  derivePasswordKeys,
  encodeRecoveryCode,
  encrypt,
  fromBase64,
  fromUtf8,
  generateIdentity,
  importPrivateKey,
  newRecoverySecret,
  normalizeName,
  randomBytes,
  recoveryKeys,
  toBase64,
  toHex,
  unwrapSecret,
  utf8,
  wrapSecret,
  type Argon2id,
  type Bytes
} from '@obsidian-connect/shared/crypto'
import { ApiError, type ConnectApi } from './api.js'

// Signing in without the server ever learning a name. The device derives the
// salt from the server's public id and the name, stretches the password with
// Argon2id, and sends only the resulting login key; the master key derived
// next to it never leaves the device. Name and password are all a person has
// to remember - nothing stored on a device is needed to get back in.

/** Secrets a signed-in device keeps: Obsidian's per-vault localStorage, never the vault itself. */
export interface SecretStore {
  load(key: string): string | null
  save(key: string, value: string | null): void
}

/** A signed-in device, in memory. */
export interface Unlocked {
  accountId: string
  /** The name signed in with. Known on this device only. */
  username: string
  publicKey: Bytes
  privateKey: CryptoKey
  masterKey: Bytes
  /** Random, made at registration, kept under the master key; vault ids, names and keys come from it. */
  accountSecret: Bytes
  bundle: AccountBundle
}

export interface OpenVault {
  vaultId: string
  name: string
  key: Bytes
}

const MASTER = 'obsidian-connect:master'
const BUNDLE = 'obsidian-connect:bundle'
const NAME = 'obsidian-connect:name'
const SERVER = 'obsidian-connect:server'
const PRIVATE_KEY = 'private-key'
const ACCOUNT_SECRET = 'account-secret'
// The recovery code's wrappings, under contexts of their own: neither can
// stand in for the password's.
const RECOVERY_PRIVATE_KEY = 'recovery-private-key'
const RECOVERY_ACCOUNT_SECRET = 'recovery-account-secret'
const VAULT_KEY = 'vault'

/** A new account, or one recovered: signed in, and the recovery code to show once. */
export interface Registered {
  unlocked: Unlocked
  recoveryCode: string | null
}

/**
 * Asked for a code from the authenticator app when the account wants one.
 * `again`: the last one was wrong. Null: the person gave up.
 */
export type AskCode = (again: boolean) => Promise<string | null>

/** Why a recovery asks again whether to keep two-factor sign-in. */
export type KeepProblem = 'wrong' | 'blocked' | null

/**
 * Asked during a recovery of an account with two-factor sign-in: a code from
 * the authenticator app keeps it, with the entry the app has; 'off' turns it
 * off. Null cancels the recovery - nothing changes, the code still works.
 */
export type AskKeepTotp = (problem: KeepProblem) => Promise<{ code: string } | 'off' | null>

/** The challenge of a sign-in that wants a second factor, or null for any other refusal. */
function secondFactorChallenge(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 403) return null
  const body = error.body as Partial<SecondFactorRequired> | null
  return body?.secondFactor === 'totp' && typeof body.challenge === 'string' ? body.challenge : null
}

/** What a refused recovery says about the code meant to keep two-factor sign-in; null for anything else. */
function keepProblem(error: unknown): KeepProblem {
  if (!(error instanceof ApiError)) return null
  if (error.status === 401 && error.message === 'wrong code') return 'wrong'
  if (error.status === 429 && error.message === 'too many wrong codes; try again later') return 'blocked'
  return null
}

/** Whether `wrapped` opens under `key` to exactly `expected`. */
async function opensTo(key: Bytes, wrapped: string, context: string, expected: Bytes): Promise<boolean> {
  try {
    return toHex(await unwrapSecret(key, wrapped, context)) === toHex(expected)
  } catch {
    return false
  }
}

function parse<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function vaultNameAad(vaultId: string): string {
  return `vault-name:${vaultId}`
}

export class Session {
  /**
   * A request of this device that moves the account's session generation,
   * while it runs. The server closes every socket of the account before this
   * device has its new token, so whether it is still signed in can only be
   * asked once the request is done.
   */
  private moving: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly api: ConnectApi,
    private readonly secrets: SecretStore,
    private readonly argon2id: Argon2id,
    /** Persists the access token and the name signed in with (device-local, `data.json`). */
    private readonly onToken: (token: string | null, username: string | null) => Promise<void>,
    /** The server this session talks to, to pin its id against. */
    private readonly serverUrl: () => string = () => ''
  ) {}

  /**
   * The server's id, part of every salt. Pinned per address on first contact:
   * a different id behind the same address is a different server, and one
   * that hands out an id of its choosing could have prepared for it.
   */
  private async serverId(): Promise<string> {
    return (await this.server()).serverId
  }

  /** The server's settings, its id checked against the pinned one. */
  private async server(): Promise<AuthConfigResponse> {
    const config = await this.api.config()
    const address = this.serverUrl()
    const pinned = parse<{ address: string; serverId: string }>(this.secrets.load(SERVER))
    if (pinned && pinned.address === address && pinned.serverId !== config.serverId) {
      throw new Error(
        this.secrets.load(MASTER)
          ? 'This is not the server this device knew: its id changed. If you set it up again on purpose, sign out first, then sign in.'
          : 'This is not the server this device knew: its id changed. If you set it up again on purpose, choose "Use this server" in the settings first.'
      )
    }
    return config
  }

  /** The server id this device pinned for the address it talks to now; null for none. */
  pinnedServerId(): string | null {
    const pinned = parse<{ address: string; serverId: string }>(this.secrets.load(SERVER))
    return pinned && pinned.address === this.serverUrl() ? pinned.serverId : null
  }

  /**
   * Lets go of the pinned id, signed out only: the person says the server at
   * this address was set up anew, or is another one. A device the server
   * signed out - its token refused by the new one - kept the old id and had
   * no way left to sign in or create an account; signing out by hand lets go
   * of it the same way. The next sign-in pins the new id.
   */
  forgetServer(): void {
    if (this.secrets.load(MASTER)) throw new Error('Sign out first.')
    this.secrets.save(SERVER, null)
  }

  /**
   * A new account, with its recovery code. The code is null when the server
   * did not keep it - one from before recovery codes.
   */
  async register(username: string, password: string, invite?: string): Promise<Registered> {
    const name = normalizeName(username)
    const serverId = await this.serverId()
    const keys = await derivePasswordKeys(password, await accountSalt(serverId, name), CURRENT_KDF_VERSION, this.argon2id)
    const identity = await generateIdentity()
    const accountSecret = randomBytes(32)
    const recovery = await this.newRecovery(identity.privateKey, accountSecret)
    const response = await this.api.register({
      invite: invite?.trim() || undefined,
      loginKey: toBase64(keys.loginKey),
      kdfVersion: CURRENT_KDF_VERSION,
      publicKey: toBase64(identity.publicKey),
      wrappedPrivateKey: await wrapSecret(keys.masterKey, identity.privateKey, PRIVATE_KEY),
      wrappedAccountSecret: await wrapSecret(keys.masterKey, accountSecret, ACCOUNT_SECRET),
      recovery: recovery.record
    })
    const unlocked = await this.adopt(response, keys.masterKey, name, serverId)
    return { unlocked, recoveryCode: response.account.recovery ? recovery.code : null }
  }

  /** A new recovery code for these keys, and what the server keeps of it. */
  private async newRecovery(privateKey: Bytes, accountSecret: Bytes): Promise<{ code: string; record: RecoveryRecord }> {
    const secret = newRecoverySecret()
    const keys = await recoveryKeys(secret)
    const record: RecoveryRecord = {
      recoveryKey: toBase64(keys.recoveryKey),
      wrappedPrivateKey: await wrapSecret(keys.wrapKey, privateKey, RECOVERY_PRIVATE_KEY),
      wrappedAccountSecret: await wrapSecret(keys.wrapKey, accountSecret, RECOVERY_ACCOUNT_SECRET)
    }
    // A wrapping of nothing would only show when the code is needed - and
    // after a recovery it would be all the account's keys there are.
    if (
      !(await opensTo(keys.wrapKey, record.wrappedPrivateKey, RECOVERY_PRIVATE_KEY, privateKey)) ||
      !(await opensTo(keys.wrapKey, record.wrappedAccountSecret, RECOVERY_ACCOUNT_SECRET, accountSecret))
    ) {
      throw new Error('making the recovery code failed')
    }
    return { code: await encodeRecoveryCode(secret), record }
  }

  /** Whether this is the password the device signed in with: the master key it derives is the one in use. */
  async checkPassword(unlocked: Unlocked, password: string): Promise<boolean> {
    const salt = await accountSalt(await this.serverId(), unlocked.username)
    const keys = await derivePasswordKeys(password, salt, unlocked.bundle.kdfVersion, this.argon2id)
    return toHex(keys.masterKey) === toHex(unlocked.masterKey)
  }

  /** The login key of the current password, which the server asks for before replacing anything. */
  private async currentLoginKey(unlocked: Unlocked, password: string): Promise<string> {
    const salt = await accountSalt(await this.serverId(), unlocked.username)
    return toBase64((await derivePasswordKeys(password, salt, unlocked.bundle.kdfVersion, this.argon2id)).loginKey)
  }

  private withBundle(unlocked: Unlocked, bundle: AccountBundle): Unlocked {
    this.secrets.save(BUNDLE, JSON.stringify(bundle))
    return { ...unlocked, bundle }
  }

  /** What the server says about the account now: 2FA or a recovery code changed on another device. */
  async refreshBundle(unlocked: Unlocked): Promise<Unlocked> {
    return this.withBundle(unlocked, await this.api.account())
  }

  /** Makes a recovery code, or a new one in place of the old - which stops working at once. */
  async makeRecoveryCode(unlocked: Unlocked, password: string): Promise<{ unlocked: Unlocked; code: string }> {
    const loginKey = await this.currentLoginKey(unlocked, password)
    const privateKey = await unwrapSecret(unlocked.masterKey, unlocked.bundle.wrappedPrivateKey, PRIVATE_KEY)
    const { code, record } = await this.newRecovery(privateKey, unlocked.accountSecret)
    const bundle = await this.api.setRecovery({ loginKey, recovery: record })
    return { unlocked: this.withBundle(unlocked, bundle), code }
  }

  async deleteRecoveryCode(unlocked: Unlocked, password: string): Promise<Unlocked> {
    const bundle = await this.api.deleteRecovery({ loginKey: await this.currentLoginKey(unlocked, password) })
    return this.withBundle(unlocked, bundle)
  }

  /**
   * A backup key for one vault, and everything a backup server needs to read
   * and decrypt it. The grant holds the vault key and the account's private
   * key: it goes to the backup server inside an encrypted session and nowhere
   * else.
   */
  async makeBackupGrant(unlocked: Unlocked, password: string, vault: OpenVault, label: string): Promise<{ unlocked: Unlocked; grant: BackupGrant }> {
    const loginKey = await this.currentLoginKey(unlocked, password)
    const backupKey = toBase64(randomBytes(32))
    const created = await this.api.createBackupKey({ loginKey, vaultId: vault.vaultId, backupKey, label })
    const privateKey = await unwrapSecret(unlocked.masterKey, unlocked.bundle.wrappedPrivateKey, PRIVATE_KEY)
    const grant: BackupGrant = {
      server: this.serverUrl(),
      accountId: unlocked.accountId,
      vaultId: vault.vaultId,
      vaultName: vault.name,
      vaultKey: toBase64(vault.key),
      publicKey: toBase64(unlocked.publicKey),
      privateKey: toBase64(privateKey),
      backupKey,
      keyId: created.id
    }
    return { unlocked: this.withBundle(unlocked, created.account), grant }
  }

  /** Takes a backup server's access away; the signed-in device is enough for that. */
  async deleteBackupKey(unlocked: Unlocked, keyId: string): Promise<Unlocked> {
    return this.withBundle(unlocked, await this.api.deleteBackupKey(keyId))
  }

  /**
   * A forgotten password, or name: the recovery code opens the account's keys,
   * which are wrapped anew under the name and password chosen now. The code is
   * spent; the new one comes back and has to be shown. Every other device of
   * the account is signed out. `askKeep`: whether to keep two-factor sign-in;
   * without it, the recovery turns it off.
   */
  async recover(
    code: string,
    username: string,
    password: string,
    askKeep?: AskKeepTotp
  ): Promise<Registered & { recoveryCode: string; totpWasOn: boolean }> {
    const secret = await decodeRecoveryCode(code)
    if (!secret) throw new Error('That is not a recovery code. Check it for a typo.')
    const server = await this.server()
    if (!server.features?.includes('recovery')) throw new Error('This server does not take recovery codes yet. It needs an update.')
    const name = normalizeName(username)
    const keys = await recoveryKeys(secret)
    const found = await this.api.recover({ recoveryKey: toBase64(keys.recoveryKey) })
    let privateKey: Bytes
    let accountSecret: Bytes
    try {
      privateKey = await unwrapSecret(keys.wrapKey, found.wrappedPrivateKey, RECOVERY_PRIVATE_KEY)
      accountSecret = await unwrapSecret(keys.wrapKey, found.wrappedAccountSecret, RECOVERY_ACCOUNT_SECRET)
    } catch {
      throw new Error('The server answered this code with keys it does not open.')
    }
    const cancelled = (): Error => new Error('The recovery was cancelled. Nothing changed; your recovery code still works.')
    let keep = found.totp === true && askKeep ? await askKeep(null) : 'off'
    if (keep === null) throw cancelled()
    const next = await derivePasswordKeys(password, await accountSalt(server.serverId, name), CURRENT_KDF_VERSION, this.argon2id)
    const wrappedPrivateKey = await wrapSecret(next.masterKey, privateKey, PRIVATE_KEY)
    const wrappedAccountSecret = await wrapSecret(next.masterKey, accountSecret, ACCOUNT_SECRET)
    // These replace the account's only other wrapping; one that does not
    // open would lose the account.
    if (
      !(await opensTo(next.masterKey, wrappedPrivateKey, PRIVATE_KEY, privateKey)) ||
      !(await opensTo(next.masterKey, wrappedAccountSecret, ACCOUNT_SECRET, accountSecret))
    ) {
      throw new Error('re-encrypting the keys failed')
    }
    const fresh = await this.newRecovery(privateKey, accountSecret)
    const request = {
      recoveryKey: toBase64(keys.recoveryKey),
      newLoginKey: toBase64(next.loginKey),
      kdfVersion: CURRENT_KDF_VERSION,
      wrappedPrivateKey,
      wrappedAccountSecret,
      recovery: fresh.record
    }
    // The server changes nothing for a wrong code, so the same request goes
    // again with the next one.
    for (;;) {
      const totpCode = keep === 'off' ? undefined : keep.code.replace(/\s/g, '')
      let totpWasOn = false
      try {
        const unlocked = await this.move(async () => {
          const response = await this.api.recoverCommit({ ...request, totpCode })
          totpWasOn = response.totpWasOn === true
          return this.adopt(response, next.masterKey, name, server.serverId)
        })
        return { unlocked, recoveryCode: fresh.code, totpWasOn }
      } catch (error) {
        const problem = keep === 'off' ? null : keepProblem(error)
        if (problem === null || !askKeep) throw error
        keep = await askKeep(problem)
        if (keep === null) throw cancelled()
      }
    }
  }

  /** `askCode`: for an account with two-factor sign-in, the code from the authenticator app. */
  async login(username: string, password: string, askCode?: AskCode): Promise<Unlocked> {
    const name = normalizeName(username)
    const serverId = await this.serverId()
    const salt = await accountSalt(serverId, name)
    // Newest parameters first; an account made with older ones still opens.
    const versions = Object.keys(KDF_VERSIONS)
      .map(Number)
      .sort((a, b) => b - a)
    let refusal: unknown = null
    for (const version of versions) {
      const keys = await derivePasswordKeys(password, salt, version, this.argon2id)
      let response: SessionResponse
      try {
        response = await this.api.login({ loginKey: toBase64(keys.loginKey) })
      } catch (error) {
        const challenge = secondFactorChallenge(error)
        if (challenge !== null) return this.adopt(await this.secondStep(challenge, askCode), keys.masterKey, name, serverId)
        if (!(error instanceof ApiError) || error.status !== 401) throw error
        refusal = error
        continue
      }
      return this.adopt(response, keys.masterKey, name, serverId)
    }
    throw refusal ?? new Error('wrong name or password')
  }

  /** The password was right; the code from the app, until it is right too or the person gives up. */
  private async secondStep(challenge: string, askCode?: AskCode): Promise<SessionResponse> {
    if (!askCode) throw new Error('This account signs in with a code from an authenticator app.')
    for (let again = false; ; again = true) {
      const code = await askCode(again)
      if (code === null) throw new Error('Signing in was cancelled.')
      try {
        return await this.api.loginTotp({ challenge, code: code.replace(/\s/g, '') })
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401 || error.message !== 'wrong code') throw error
      }
    }
  }

  /**
   * Turns two-factor sign-in on with the secret this device made and showed
   * to the app, and a first code from it. Every other device is signed out.
   */
  async enableTotp(unlocked: Unlocked, password: string, secret: Bytes, code: string): Promise<Unlocked> {
    const serverId = await this.serverId()
    const request = { loginKey: await this.currentLoginKey(unlocked, password), secret: toBase64(secret), code: code.replace(/\s/g, '') }
    return this.move(async () => this.adopt(await this.api.enableTotp(request), unlocked.masterKey, unlocked.username, serverId))
  }

  /** The password alone: whoever has it and this device could make a recovery code, which turns it off anyway. */
  async disableTotp(unlocked: Unlocked, password: string): Promise<Unlocked> {
    let bundle: AccountBundle
    try {
      bundle = await this.api.disableTotp({ loginKey: await this.currentLoginKey(unlocked, password) })
    } catch (error) {
      // A server from 0.6.2 to 0.6.5 still asks for a code as well.
      if (error instanceof ApiError && error.message === 'the code does not match') {
        throw new Error('This server still wants a code from the app to turn it off. It needs an update.')
      }
      throw error
    }
    return this.withBundle(unlocked, bundle)
  }

  private async adopt(response: SessionResponse, masterKey: Bytes, username: string, serverId: string): Promise<Unlocked> {
    const unlocked = await this.unlockWith(response.account, masterKey, username)
    await this.onToken(response.token, username)
    this.secrets.save(MASTER, toBase64(masterKey))
    this.secrets.save(BUNDLE, JSON.stringify(response.account))
    this.secrets.save(NAME, username)
    this.secrets.save(SERVER, JSON.stringify({ address: this.serverUrl(), serverId }))
    return unlocked
  }

  private async unlockWith(bundle: AccountBundle, masterKey: Bytes, username: string): Promise<Unlocked> {
    const privateKey = await importPrivateKey(await unwrapSecret(masterKey, bundle.wrappedPrivateKey, PRIVATE_KEY))
    const accountSecret = await unwrapSecret(masterKey, bundle.wrappedAccountSecret, ACCOUNT_SECRET)
    return { accountId: bundle.accountId, username, publicKey: fromBase64(bundle.publicKey), privateKey, masterKey, accountSecret, bundle }
  }

  /**
   * A signed-in device after a restart: the stored master key and the
   * freshest account bundle there is - the server's, or the cached one while
   * offline. Null means the device has to sign in again.
   */
  async unlock(): Promise<Unlocked | null> {
    const stored = this.secrets.load(MASTER)
    if (!stored) return null
    const masterKey = fromBase64(stored)
    const username = this.secrets.load(NAME) ?? ''
    let bundle = parse<AccountBundle>(this.secrets.load(BUNDLE))
    try {
      const refreshed = await this.api.refresh()
      await this.onToken(refreshed.token, username)
      bundle = await this.api.account()
      this.secrets.save(BUNDLE, JSON.stringify(bundle))
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.forget()
        return null
      }
      // Unreachable: carry on with the cached bundle.
    }
    if (!bundle) return null
    try {
      return await this.unlockWith(bundle, masterKey, username)
    } catch {
      // The password was changed on another device; this master key is stale.
      this.forget()
      return null
    }
  }

  /** The names of the account's vaults, decrypted here. */
  async vaultNames(unlocked: Unlocked): Promise<string[]> {
    const key = await aesKey(await accountKeys.vaultName(unlocked.accountSecret))
    const names: string[] = []
    for (const vault of unlocked.bundle.vaults) {
      try {
        names.push(fromUtf8(await decrypt(key, fromBase64(vault.sealedName), vaultNameAad(vault.vaultId))))
      } catch {
        // Not readable with this secret: nothing to show.
      }
    }
    return names
  }

  /** The vault of that name, created on first use. A second device finds it by name. */
  async openVault(unlocked: Unlocked, name: string): Promise<OpenVault> {
    const vaultName = name.trim()
    const vaultId = await accountKeys.vaultId(unlocked.accountSecret, vaultName)
    const wrapKey = await accountKeys.vaultWrap(unlocked.accountSecret)
    let record = unlocked.bundle.vaults.find((vault) => vault.vaultId === vaultId)
    if (!record) {
      const key = randomBytes(32)
      const nameKey = await aesKey(await accountKeys.vaultName(unlocked.accountSecret))
      // If another device created it a moment ago, the server returns that
      // one, wrapped key and all, and this key is simply dropped.
      record = await this.api.createVault({
        vaultId,
        sealedName: toBase64(await encrypt(nameKey, utf8(vaultName), vaultNameAad(vaultId))),
        wrappedKey: await wrapSecret(wrapKey, key, VAULT_KEY)
      })
      unlocked.bundle.vaults.push(record)
      this.secrets.save(BUNDLE, JSON.stringify(unlocked.bundle))
    }
    return { vaultId, name: vaultName, key: await unwrapSecret(wrapKey, record.wrappedKey, VAULT_KEY) }
  }

  /**
   * Re-wraps the private key and the account secret under the new master
   * key. Vault keys hang off the account secret, so vaults and documents are
   * not touched.
   */
  async changePassword(unlocked: Unlocked, current: string, next: string): Promise<Unlocked> {
    const serverId = await this.serverId()
    const salt = await accountSalt(serverId, unlocked.username)
    const currentKeys = await derivePasswordKeys(current, salt, unlocked.bundle.kdfVersion, this.argon2id)
    const nextKeys = await derivePasswordKeys(next, salt, CURRENT_KDF_VERSION, this.argon2id)
    const privateKey = await unwrapSecret(unlocked.masterKey, unlocked.bundle.wrappedPrivateKey, PRIVATE_KEY)
    const request = {
      loginKey: toBase64(currentKeys.loginKey),
      newLoginKey: toBase64(nextKeys.loginKey),
      kdfVersion: CURRENT_KDF_VERSION,
      wrappedPrivateKey: await wrapSecret(nextKeys.masterKey, privateKey, PRIVATE_KEY),
      wrappedAccountSecret: await wrapSecret(nextKeys.masterKey, unlocked.accountSecret, ACCOUNT_SECRET)
    }
    return this.move(async () => this.adopt(await this.api.changePassword(request), nextKeys.masterKey, unlocked.username, serverId))
  }

  /** Runs a request that moves the session generation; see `moving`. */
  private move<T>(task: () => Promise<T>): Promise<T> {
    const run = this.moving.then(task)
    this.moving = run.catch(() => undefined)
    return run
  }

  /**
   * Asked when the server closed the socket as signed out: true if the token
   * still holds (it is renewed), false if this device was signed out - the
   * keys are forgotten then - and null if the server cannot be asked now.
   */
  async stillSignedIn(): Promise<boolean | null> {
    await this.moving
    try {
      const refreshed = await this.api.refresh()
      await this.onToken(refreshed.token, this.secrets.load(NAME))
      return true
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) return null
      // Unlike signing out, the server's id stays pinned: it is the same server.
      this.forget()
      await this.onToken(null, null)
      return false
    }
  }

  async signOut(): Promise<void> {
    this.forget()
    // Signing out also lets go of the server's id: signing in again - to a
    // server set up anew at the same address - pins the new one.
    this.secrets.save(SERVER, null)
    await this.onToken(null, null)
  }

  private forget(): void {
    this.secrets.save(MASTER, null)
    this.secrets.save(BUNDLE, null)
    this.secrets.save(NAME, null)
  }
}
