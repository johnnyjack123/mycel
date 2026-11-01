import type { VaultLockInfo, VaultLockKind } from '@obsidian-connect/shared'
import { decrypt, encrypt, fromBase64, fromUtf8, randomBytes, toBase64, toHex, utf8 } from '@obsidian-connect/shared/crypto'
import { ApiError, type ConnectApi } from '../account/api.js'
import type { RoomCrypto } from './VaultSocket.js'
import { log } from '../log.js'

// The vault's lock (`docs/TIMEMACHINE.md`, V2). While one device shows the past
// in its files, or applies it, the server takes nothing from the account's other
// devices into the vault - they keep what they write and send it afterwards. It
// is the server's, so it holds even against a device whose own guard failed;
// and it lapses when its holder stops renewing it, so a device that crashed
// locks nothing for long. Any device of the account can lift it by hand.

/** What a lock covers: the vault, a folder or a note. */
export type LockScope = { kind: 'vault' } | { kind: 'folder'; path: string } | { kind: 'note'; path: string }

/** What a lock is for, as the devices read it; the server only holds it sealed. */
export interface LockPurpose {
  /** "the vault", "the folder Projects", "the note Plan". */
  what: string
  /** The device that took it, as far as it can say: a phone or a computer. */
  device: string
  /** Tells two locks for the same thing apart, so a device knows its own. */
  nonce: string
  /**
   * What the other devices may not edit meanwhile (0.8.15). A lock without one,
   * from an older plugin, covers the vault.
   */
  scope?: LockScope
}

function lockScope(value: unknown): LockScope | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { kind, path } = value as { kind?: unknown; path?: unknown }
  if (kind === 'vault') return { kind }
  if ((kind === 'folder' || kind === 'note') && typeof path === 'string') return { kind, path }
  return undefined
}

/** Whether a path lies in what a lock covers. */
export function inLockScope(scope: LockScope, path: string): boolean {
  if (scope.kind === 'vault') return true
  if (scope.kind === 'note') return path === scope.path
  return scope.path === '' || path.startsWith(`${scope.path}/`)
}

/** Half the lease of the server's (two minutes): one renewal may get lost. */
export const LOCK_RENEW_MS = 30_000

/** The vault is locked already - by another device, or a lock of this one that never ended. */
export class VaultLockedError extends Error {
  constructor(readonly lock: VaultLockInfo | null) {
    super('the vault is locked already')
  }
}

/** Seals what a lock is for under the vault's settings key, which only the account's devices hold. */
export class LockSeal {
  constructor(
    private readonly crypto: RoomCrypto,
    private readonly vaultId: string
  ) {}

  private get aad(): string {
    return `lock:${this.vaultId}`
  }

  async seal(purpose: LockPurpose): Promise<string> {
    const key = await this.crypto.key(0)
    if (!key) throw new Error('no key for the vault settings')
    return toBase64(await encrypt(key, utf8(JSON.stringify(purpose)), this.aad))
  }

  /** Null when it cannot be read - not this vault's, or damaged. */
  async open(sealed: string): Promise<LockPurpose | null> {
    try {
      const key = await this.crypto.key(0)
      if (!key) return null
      const value = JSON.parse(fromUtf8(await decrypt(key, fromBase64(sealed), this.aad))) as Partial<LockPurpose>
      if (typeof value.what !== 'string' || typeof value.device !== 'string' || typeof value.nonce !== 'string') return null
      const scope = lockScope(value.scope)
      return { what: value.what, device: value.device, nonce: value.nonce, ...(scope ? { scope } : {}) }
    } catch {
      return null
    }
  }
}

export function lockNonce(): string {
  return toHex(randomBytes(8))
}

/** A lock this device took: renewed until released, and `onLost` told when the server ended it first. */
export class HeldLock {
  private timer: number | null = null
  private ended = false

  constructor(
    private readonly api: ConnectApi,
    private readonly vaultId: string,
    readonly id: string,
    readonly info: VaultLockInfo,
    private readonly onLost: (why: string) => void
  ) {
    this.timer = window.setInterval(() => void this.renew(), LOCK_RENEW_MS)
  }

  get active(): boolean {
    return !this.ended
  }

  private async renew(): Promise<void> {
    if (this.ended) return
    try {
      await this.api.renewVaultLock(this.vaultId, this.id)
    } catch (error) {
      // Unreachable is not an end: the lease outlasts a renewal or three.
      if (!(error instanceof ApiError) || error.status !== 404 || this.ended) return
      this.stop()
      log.warn('the vault lock ended on the server - lifted on another device, or it lapsed')
      this.onLost('lifted on another device, or it lapsed')
    }
  }

  private stop(): void {
    this.ended = true
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
  }

  /** Lets go of it; the server lets it lapse anyway if this does not reach it. */
  async release(): Promise<void> {
    if (this.ended) return
    this.stop()
    try {
      await this.api.releaseVaultLock(this.vaultId, this.id)
    } catch (error) {
      log.warn('releasing the vault lock failed; it lapses within two minutes', error)
    }
  }
}

/** Takes the vault's lock, or says who holds it (`VaultLockedError`). */
export async function takeVaultLock(
  api: ConnectApi,
  vaultId: string,
  kind: VaultLockKind,
  sealed: string,
  onLost: (why: string) => void
): Promise<HeldLock> {
  try {
    const taken = await api.takeVaultLock(vaultId, { kind, sealed })
    const { id, ...info } = taken
    log.info(`locked the vault for a ${kind}`)
    return new HeldLock(api, vaultId, id, info, onLost)
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      const current = await api.vaultLock(vaultId).catch(() => ({ lock: null }))
      throw new VaultLockedError(current.lock)
    }
    // Without a lock the other devices would go on writing into what is shown or rolled back.
    if (error instanceof ApiError && error.status === 404) throw new Error('the sync server is older than 0.8.13 and cannot lock the vault - update it first')
    throw error
  }
}
