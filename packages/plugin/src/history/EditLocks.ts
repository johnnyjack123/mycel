import { inLockScope, type LockScope } from '../sync/VaultLock.js'

// What may not be edited on this device right now, and why (`docs/TIMEMACHINE.md`,
// the third round): what this device's Time Machine shows the past of or is
// restoring, and what another device of the account locked. The server holds
// back what a locked device sends; this keeps it from being written in the first
// place - typed into a note a restore then overwrote, it looked lost.

export interface EditLock {
  scope: LockScope
  /** A sentence for the lock in a note's header. */
  why: string
  /** This device's own Time Machine or rollback; otherwise another device's lock. */
  own: boolean
}

export class EditLocks {
  private own: EditLock | null = null
  private other: EditLock | null = null
  private readonly listeners = new Set<() => void>()

  /** This device's own lock, or another device's; null lets go of it. */
  set(own: boolean, lock: EditLock | null): void {
    if (own) this.own = lock
    else this.other = lock
    for (const listener of this.listeners) listener()
  }

  get ownLock(): EditLock | null {
    return this.own
  }

  get otherLock(): EditLock | null {
    return this.other
  }

  /** The lock a path lies in, this device's own first; null when it may be edited. */
  lockOf(path: string): EditLock | null {
    if (this.own && inLockScope(this.own.scope, path)) return this.own
    if (this.other && inLockScope(this.other.scope, path)) return this.other
    return null
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
