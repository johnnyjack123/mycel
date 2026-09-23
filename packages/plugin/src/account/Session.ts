import type { AccountBundle, SessionResponse } from '@obsidian-connect/shared'
import {
  derivePasswordKeys,
  fromBase64,
  generateIdentity,
  importPrivateKey,
  newKdfParams,
  randomBytes,
  toBase64,
  unwrapSecret,
  wrapSecret,
  type Argon2id,
  type Bytes
} from '@obsidian-connect/shared/crypto'
import { ApiError, type ConnectApi } from './api.js'

/** Secrets a signed-in device keeps: Obsidian's per-vault localStorage, never the vault itself. */
export interface SecretStore {
  load(key: string): string | null
  save(key: string, value: string | null): void
}

/** A signed-in device, in memory. */
export interface Unlocked {
  username: string
  publicKey: Bytes
  privateKey: CryptoKey
  masterKey: Bytes
  bundle: AccountBundle
}

export interface OpenVault {
  vaultId: string
  name: string
  key: Bytes
}

const MASTER = 'obsidian-connect:master'
const BUNDLE = 'obsidian-connect:bundle'
const PRIVATE_KEY = 'private-key'
const VAULT_KEY = 'vault'

function parseBundle(raw: string | null): AccountBundle | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as AccountBundle
  } catch {
    return null
  }
}

export class Session {
  constructor(
    private readonly api: ConnectApi,
    private readonly secrets: SecretStore,
    private readonly argon2id: Argon2id,
    /** Persists the access token (device-local, `data.json`). */
    private readonly onToken: (token: string | null, username: string | null) => Promise<void>
  ) {}

  async register(username: string, password: string, invite?: string): Promise<Unlocked> {
    const kdf = newKdfParams()
    const keys = await derivePasswordKeys(password, kdf, this.argon2id)
    const identity = await generateIdentity()
    const response = await this.api.register({
      username,
      invite: invite?.trim() || undefined,
      kdf,
      authKey: toBase64(keys.authKey),
      publicKey: toBase64(identity.publicKey),
      wrappedPrivateKey: await wrapSecret(keys.masterKey, identity.privateKey, PRIVATE_KEY)
    })
    return this.adopt(response, keys.masterKey)
  }

  async login(username: string, password: string): Promise<Unlocked> {
    const { kdf } = await this.api.prelogin(username)
    const keys = await derivePasswordKeys(password, kdf, this.argon2id)
    const response = await this.api.login({ username, authKey: toBase64(keys.authKey) })
    return this.adopt(response, keys.masterKey)
  }

  private async adopt(response: SessionResponse, masterKey: Bytes): Promise<Unlocked> {
    const unlocked = await this.unlockWith(response.account, masterKey)
    await this.onToken(response.token, response.account.username)
    this.secrets.save(MASTER, toBase64(masterKey))
    this.secrets.save(BUNDLE, JSON.stringify(response.account))
    return unlocked
  }

  private async unlockWith(bundle: AccountBundle, masterKey: Bytes): Promise<Unlocked> {
    const privateKey = await importPrivateKey(await unwrapSecret(masterKey, bundle.wrappedPrivateKey, PRIVATE_KEY))
    return { username: bundle.username, publicKey: fromBase64(bundle.publicKey), privateKey, masterKey, bundle }
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
    let bundle = parseBundle(this.secrets.load(BUNDLE))
    try {
      const refreshed = await this.api.refresh()
      await this.onToken(refreshed.token, bundle?.username ?? null)
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
      return await this.unlockWith(bundle, masterKey)
    } catch {
      // The password was changed on another device; this master key is stale.
      this.forget()
      return null
    }
  }

  /** The vault of that name, created on first use. A second device finds it by name. */
  async openVault(unlocked: Unlocked, name: string): Promise<OpenVault> {
    let record = unlocked.bundle.vaults.find((vault) => vault.name === name)
    if (!record) {
      const key = randomBytes(32)
      // If another device created it a moment ago, the server returns that
      // one, wrapped key and all, and this key is simply dropped.
      record = await this.api.createVault({ name, wrappedKey: await wrapSecret(unlocked.masterKey, key, VAULT_KEY) })
      unlocked.bundle.vaults.push(record)
      this.secrets.save(BUNDLE, JSON.stringify(unlocked.bundle))
    }
    return {
      vaultId: record.vaultId,
      name: record.name,
      key: await unwrapSecret(unlocked.masterKey, record.wrappedKey, VAULT_KEY)
    }
  }

  /** Re-wraps the private key and every vault key. Documents are not touched. */
  async changePassword(unlocked: Unlocked, current: string, next: string): Promise<Unlocked> {
    const currentKeys = await derivePasswordKeys(current, unlocked.bundle.kdf, this.argon2id)
    const kdf = newKdfParams()
    const nextKeys = await derivePasswordKeys(next, kdf, this.argon2id)
    const privateKey = await unwrapSecret(unlocked.masterKey, unlocked.bundle.wrappedPrivateKey, PRIVATE_KEY)
    const vaults: Record<string, string> = {}
    for (const vault of unlocked.bundle.vaults) {
      const key = await unwrapSecret(unlocked.masterKey, vault.wrappedKey, VAULT_KEY)
      vaults[vault.vaultId] = await wrapSecret(nextKeys.masterKey, key, VAULT_KEY)
    }
    const response = await this.api.changePassword({
      authKey: toBase64(currentKeys.authKey),
      kdf,
      newAuthKey: toBase64(nextKeys.authKey),
      wrappedPrivateKey: await wrapSecret(nextKeys.masterKey, privateKey, PRIVATE_KEY),
      vaults
    })
    return this.adopt(response, nextKeys.masterKey)
  }

  async signOut(): Promise<void> {
    this.forget()
    await this.onToken(null, null)
  }

  private forget(): void {
    this.secrets.save(MASTER, null)
    this.secrets.save(BUNDLE, null)
  }
}
