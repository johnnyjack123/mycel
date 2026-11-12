import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Notice, VaultLockInfo, VaultLockKind, VaultLockRequest, VaultLockTaken } from '@mycel/shared'
import { writeDurable } from './durable.js'
import { HubError } from './hubError.js'
import type { RoomClient } from './rooms.js'

// While one device shows the past in its files or applies it, the server takes
// nothing from the account's other devices into the vault; they keep what they
// write and send it once the lock ends. Other people in shared notes are not
// the account's devices and go on.

/** A lock not renewed for this long lapses: its device crashed or lost its connection. */
export const LOCK_LEASE_MS = 2 * 60_000
const LOCK_SWEEP_MS = 10_000
const LOCK_KINDS: readonly VaultLockKind[] = ['preview', 'rollback', 'replace']
/** What a lock is for, sealed by the device that takes it - as long as a room's sealed key may be. */
const SEALED_MAX = 4_096

/**
 * A vault's lock (`docs/TIMEMACHINE.md`). Kept in `locks.json` as well (0.9.1):
 * a restart of the server ended it, and the other devices wrote again while
 * the Time Machine still showed the past. It lasts until its lease runs out,
 * unless its holder renews it once the server is back.
 */
interface HeldLock {
  id: string
  info: VaultLockInfo
  /**
   * The connections of its holder that named its id - the only ones that write:
   * a rollback, or a restore from the Time Machine before it lets go.
   */
  holders: Set<RoomClient>
}

/** Every vault's lock, by account and vault; the account's devices hear each one taken and ended. */
export class VaultLocks {
  /** `account/vault` -> the vault's lock. */
  private readonly locks = new Map<string, HeldLock>()
  private sweep: NodeJS.Timeout | null = null
  private writes: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dataDir: string,
    private readonly notify: (account: string, payload: Notice) => void
  ) {}

  private get file(): string {
    return join(this.dataDir, 'locks.json')
  }

  /** The locks the server held when it stopped, as long as their leases last. */
  async load(): Promise<void> {
    let stored: Record<string, { id: string; info: VaultLockInfo }>
    try {
      stored = JSON.parse(await readFile(this.file, 'utf8')) as typeof stored
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      console.error('[mycel] the vault locks kept before the restart could not be read; none is held', error)
      return
    }
    const now = Date.now()
    for (const [key, lock] of Object.entries(stored)) {
      if (this.locks.has(key) || typeof lock?.id !== 'string' || !(lock.info?.expiresAt > now)) continue
      this.locks.set(key, { id: lock.id, info: lock.info, holders: new Set() })
    }
    if (this.locks.size > 0) this.startSweep()
  }

  private save(): void {
    const stored: Record<string, { id: string; info: VaultLockInfo }> = {}
    for (const [key, lock] of this.locks) stored[key] = { id: lock.id, info: lock.info }
    const json = JSON.stringify(stored, null, 2)
    this.writes = this.writes
      .then(() => writeDurable(this.file, json))
      .catch((error: unknown) => console.error('[mycel] keeping the vault locks failed', error))
  }

  private startSweep(): void {
    if (this.sweep) return
    this.sweep = setInterval(() => this.sweepLapsed(), LOCK_SWEEP_MS)
    this.sweep.unref?.()
  }

  private key(account: string, vaultId: string): string {
    return `${account}/${vaultId}`
  }

  /** The vault's lock while it holds; one that lapsed is let go on the way. */
  private lockOf(account: string, vaultId: string): HeldLock | null {
    const lock = this.locks.get(this.key(account, vaultId))
    if (!lock) return null
    if (lock.info.expiresAt > Date.now()) return lock
    this.end(account, vaultId, lock)
    return null
  }

  private end(account: string, vaultId: string, lock: HeldLock): void {
    const key = this.key(account, vaultId)
    if (this.locks.get(key) !== lock) return
    this.locks.delete(key)
    this.save()
    this.notify(account, { vaultId, lock: null })
    if (this.locks.size === 0 && this.sweep) {
      clearInterval(this.sweep)
      this.sweep = null
    }
  }

  /** Whether the vault's lock keeps this connection from writing. */
  lockedOut(client: RoomClient): boolean {
    const lock = this.lockOf(client.account, client.vaultId)
    return lock !== null && !lock.holders.has(client)
  }

  /** For what changes a vault over REST: refused while it is locked. */
  refuse(account: string, vaultId: string): void {
    if (this.lockOf(account, vaultId)) throw new HubError(409, 'the vault is locked')
  }

  current(account: string, vaultId: string): VaultLockInfo | null {
    return this.lockOf(account, vaultId)?.info ?? null
  }

  /** Whether the vault is locked under this id: work only that lock's holder may do. */
  isHeld(account: string, vaultId: string, id: unknown): boolean {
    const lock = this.lockOf(account, vaultId)
    return lock !== null && lock.id === id
  }

  take(account: string, vaultId: string, request: Partial<VaultLockRequest>): VaultLockTaken {
    if (!request.kind || !LOCK_KINDS.includes(request.kind)) throw new HubError(400, 'a lock is for a preview or a rollback')
    if (typeof request.sealed !== 'string' || request.sealed.length === 0 || request.sealed.length > SEALED_MAX) {
      throw new HubError(400, 'what the lock is for is missing or too long')
    }
    if (this.lockOf(account, vaultId)) throw new HubError(409, 'the vault is locked already')
    const now = Date.now()
    const lock: HeldLock = {
      id: randomBytes(16).toString('hex'),
      info: { kind: request.kind, sealed: request.sealed, takenAt: now, expiresAt: now + LOCK_LEASE_MS },
      holders: new Set()
    }
    this.locks.set(this.key(account, vaultId), lock)
    this.save()
    this.startSweep()
    this.notify(account, { vaultId, lock: lock.info })
    return { id: lock.id, ...lock.info }
  }

  /** Refused once the lock lapsed or someone lifted it: its holder learns that here. */
  renew(account: string, vaultId: string, id: unknown): VaultLockInfo {
    const lock = this.lockOf(account, vaultId)
    if (!lock || lock.id !== id) throw new HubError(404, 'the lock ended')
    lock.info = { ...lock.info, expiresAt: Date.now() + LOCK_LEASE_MS }
    this.save()
    return lock.info
  }

  release(account: string, vaultId: string, id: unknown): void {
    const lock = this.lockOf(account, vaultId)
    if (lock && lock.id === id) this.end(account, vaultId, lock)
  }

  /** Lifted by any device of the account, should its holder never let go. */
  lift(account: string, vaultId: string): boolean {
    const lock = this.lockOf(account, vaultId)
    if (!lock) return false
    this.end(account, vaultId, lock)
    return true
  }

  /** The connection of the lock's holder: it writes under the lock, whatever its kind. */
  hold(client: RoomClient, id: string): boolean {
    const lock = this.lockOf(client.account, client.vaultId)
    if (!lock || lock.id !== id) return false
    lock.holders.add(client)
    return true
  }

  /** A connection closed: it holds no lock any more. */
  forget(client: RoomClient): void {
    for (const lock of this.locks.values()) lock.holders.delete(client)
  }

  private sweepLapsed(): void {
    for (const key of Array.from(this.locks.keys())) {
      const slash = key.indexOf('/')
      this.lockOf(key.slice(0, slash), key.slice(slash + 1))
    }
  }

  /** Stops the sweep and waits for what was being written to `locks.json`. */
  async shutdown(): Promise<void> {
    if (this.sweep) clearInterval(this.sweep)
    this.sweep = null
    await this.writes
  }
}
