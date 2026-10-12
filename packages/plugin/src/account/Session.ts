import type { AccountBundle, AuthConfigResponse, RecoveryRecord, SessionResponse } from '@obsidian-connect/shared'
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
        'This is not the server this device knew: its id changed. If you set it up again on purpose, sign out first, then sign in.'
      )
    }
    return config
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

  /** The login key of the current password, which the server asks for before replacing anything. */
  private async currentLoginKey(unlocked: Unlocked, password: string): Promise<string> {
    const salt = await accountSalt(await this.serverId(), unlocked.username)
    return toBase64((await derivePasswordKeys(password, salt, unlocked.bundle.kdfVersion, this.argon2id)).loginKey)
  }

  private withBundle(unlocked: Unlocked, bundle: AccountBundle): Unlocked {
    this.secrets.save(BUNDLE, JSON.stringify(bundle))
    return { ...unlocked, bundle }
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
   * A forgotten password, or name: the recovery code opens the account's keys,
   * which are wrapped anew under the name and password chosen now. The code is
   * spent; the new one comes back and has to be shown. Every other device of
   * the account is signed out.
   */
  async recover(code: string, username: string, password: string): Promise<Registered & { recoveryCode: string }> {
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
    const unlocked = await this.move(async () => this.adopt(await this.api.recoverCommit(request), next.masterKey, name, server.serverId))
    return { unlocked, recoveryCode: fresh.code }
  }

  async login(username: string, password: string): Promise<Unlocked> {
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
      try {
        const response = await this.api.login({ loginKey: toBase64(keys.loginKey) })
        return await this.adopt(response, keys.masterKey, name, serverId)
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error
        refusal = error
      }
    }
    throw refusal ?? new Error('wrong name or password')
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
