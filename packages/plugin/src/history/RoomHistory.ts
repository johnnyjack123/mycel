import * as Y from 'yjs'
import { frameAad, snapshotAad, type LogResponse } from '@obsidian-connect/shared'
import { decrypt, fromBase64, unpackFrame } from '@obsidian-connect/shared/crypto'
import type { RoomCrypto } from '../sync/VaultSocket.js'

// A room's history as the server keeps it - the vault index, a note -,
// decrypted here and replayed to any moment it reaches. Ordered by when each
// change was made, as its author's device sealed it into the frame, the way
// the history view orders a note's versions.
//
// A compaction folds the oldest changes into a snapshot, which keeps their
// result but not when each was made: a moment before the snapshot is out of
// reach. Since 0.7.8 a snapshot carries the time of the newest change it
// holds; one made before says when the compaction ran, which is later, so its
// reach errs on the safe side.

interface Step {
  seq: number
  ts: number
  update: Uint8Array
}

export class RoomHistory {
  private constructor(
    private readonly base: Step | null,
    private readonly steps: Step[],
    /** Frames, or the snapshot, this device has no key for. */
    readonly unreadable: number
  ) {}

  static async load(api: { log(room: string): Promise<LogResponse> }, room: string, crypto: RoomCrypto): Promise<RoomHistory> {
    const log = await api.log(room)
    let base: Step | null = null
    let unreadable = 0
    if (log.snapshot) {
      const key = await crypto.key(log.snapshot.epoch)
      if (key) {
        const snapshot = unpackFrame(await decrypt(key, fromBase64(log.snapshot.data), snapshotAad(room, log.snapshot.epoch)))
        base = { seq: log.snapshot.uptoSeq, ts: snapshot.authorTs, update: snapshot.update }
      } else {
        unreadable += 1
      }
    }
    const steps: Step[] = []
    for (const frame of log.frames) {
      const key = await crypto.key(frame.epoch)
      if (!key) {
        unreadable += 1
        continue
      }
      const change = unpackFrame(await decrypt(key, fromBase64(frame.data), frameAad(room, frame.epoch)))
      steps.push({ seq: frame.seq, ts: change.authorTs, update: change.update })
    }
    steps.sort((a, b) => a.ts - b.ts || a.seq - b.seq)
    return new RoomHistory(base, steps, unreadable)
  }

  /** The earliest moment this history replays to: 0 while it holds every change. */
  get reach(): number {
    return this.base?.ts ?? 0
  }

  /** Whether the room's state at `ts` can be told: every change readable, none folded away after it. */
  reaches(ts: number): boolean {
    return this.unreadable === 0 && ts >= this.reach
  }

  /** The room with every change made up to `ts`; the caller destroys it. */
  stateAt(ts: number): Y.Doc {
    const doc = new Y.Doc()
    doc.transact(() => {
      if (this.base) Y.applyUpdate(doc, this.base.update)
      for (const step of this.steps) {
        if (step.ts > ts) break
        Y.applyUpdate(doc, step.update)
      }
    })
    return doc
  }

  /** With every change there is. */
  latest(): Y.Doc {
    return this.stateAt(Number.POSITIVE_INFINITY)
  }
}
