import { roomKind, roomSubject } from '@obsidian-connect/shared'
import type { AccountSettings, RecoveryDecision } from './AccountSettings.js'
import type { DocStore } from './DocStore.js'
import type { VaultSocket } from './VaultSocket.js'
import { log } from '../log.js'

// A server whose log of a room is not the one a device knew lost data or was
// rolled back. Nothing about that is decided automatically: uploading
// everything would undo a restore made on purpose, taking the server's state
// would drop what the devices wrote since. The user decides once; the answer
// is kept in the account's settings and every other device of the account
// follows it without asking again.

export type RecoveryChoice = RecoveryDecision['choice']

export interface RecoveryOptions {
  socket: VaultSocket
  store: DocStore
  settings: AccountSettings
  /** Resolves once the account settings are caught up, so an earlier decision is known. */
  settingsReady: () => Promise<void>
  /** How many notes are affected; null keeps them held and asks again on the next connect. */
  ask: (notes: number) => Promise<RecoveryChoice | null>
  onResolved?: () => void
}

// Every room of a vault diverges at once after a restore; one question for all.
const GATHER_MS = 1_500

export class Recovery {
  private readonly pending = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(private readonly options: RecoveryOptions) {}

  diverged(room: string): void {
    if (this.stopped) return
    this.pending.add(room)
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.running = this.running.then(() => this.resolve()).catch((error) => {
        log.error('resolving a server with other data failed', error)
      })
    }, GATHER_MS)
  }

  /** Waits for a resolution already under way. */
  settled(): Promise<void> {
    return this.running
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
  }

  private async resolve(): Promise<void> {
    const { socket, store, settings } = this.options
    const rooms = Array.from(this.pending).filter((room) => socket.isHeld(room))
    this.pending.clear()
    if (rooms.length === 0 || this.stopped) return

    // Structure is never rolled back. The index and the settings keep both
    // sides: a note created after the restore point exists as a file anyway,
    // and the settings carry the very decision the others read.
    for (const room of rooms) if (roomKind(room) !== 'doc') socket.keepLocal(room)
    const notes = rooms.filter((room) => roomKind(room) === 'doc')
    if (notes.length === 0) return

    await this.options.settingsReady()
    const decision = settings.recoveryDecision()
    // Made after this device last saw these notes in a log it recognised:
    // someone already answered for exactly this situation.
    const lastSeen = Math.min(...notes.map((room) => socket.syncedAtOf(room)))
    let choice: RecoveryChoice | null = decision && decision.at > lastSeen ? decision.choice : null
    if (choice) {
      log.info(`${notes.length} note(s) differ from the server's log; following the decision "${choice}" made on ${new Date(decision?.at ?? 0).toISOString()}`)
    } else {
      log.warn(`${notes.length} note(s) differ from the server's log; asking`)
      choice = await this.options.ask(notes.length)
      log.info(`recovery answer: ${choice ?? 'none yet'}`)
      if (!choice || this.stopped) return
      settings.decideRecovery({ choice, at: Date.now() })
    }

    for (const room of notes) {
      if (this.stopped) return
      const docId = roomSubject(room)
      if (choice === 'device') await store.keepLocal(docId)
      else await store.adoptServer(docId)
    }
    this.options.onResolved?.()
  }
}
