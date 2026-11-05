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
// reach. A snapshot carries the time of the newest change it holds.

export interface HistoryStep {
  seq: number
  ts: number
  update: Uint8Array
}

export interface ReadLog {
  /** The snapshot the log starts from; null while it holds every change. */
  base: HistoryStep | null
  /** By the author's time, then by seq. */
  steps: HistoryStep[]
  /** Frames, or the snapshot, this device has no key for or does not take. */
  unreadable: number
}

/** A room's readable log, decrypted - only what the live room would take, as its signatures say. */
export async function readLog(api: { log(room: string): Promise<LogResponse> }, room: string, crypto: RoomCrypto): Promise<ReadLog> {
  const log = await api.log(room)
  let base: HistoryStep | null = null
  let unreadable = 0
  if (log.snapshot) {
    const key = await crypto.key(log.snapshot.epoch)
    const snapshot = key ? unpackFrame(await decrypt(key, fromBase64(log.snapshot.data), snapshotAad(room, log.snapshot.epoch))) : null
    if (snapshot && (await crypto.check('snapshot', log.snapshot.uptoSeq, log.snapshot.epoch, snapshot)) === 'ok') {
      base = { seq: log.snapshot.uptoSeq, ts: snapshot.authorTs, update: snapshot.update }
    } else {
      unreadable += 1
    }
  }
  const steps: HistoryStep[] = []
  for (const frame of log.frames) {
    const key = await crypto.key(frame.epoch)
    if (!key) {
      unreadable += 1
      continue
    }
    const change = unpackFrame(await decrypt(key, fromBase64(frame.data), frameAad(room, frame.epoch)))
    if (!change || (await crypto.check('frame', frame.seq, frame.epoch, change)) !== 'ok') {
      unreadable += 1
      continue
    }
    steps.push({ seq: frame.seq, ts: change.authorTs, update: change.update })
  }
  steps.sort((a, b) => a.ts - b.ts || a.seq - b.seq)
  return { base, steps, unreadable }
}

// A slider going back replays from the newest checkpoint before its place, never from the start.
const CHECKPOINT_EVERY = 200

/**
 * A room replayed to one moment after another, as the Time Machine's slider
 * asks for them: forward from where it stood, back from a checkpoint.
 */
export class Replay {
  private doc: Y.Doc
  /** How many steps the document holds. */
  private applied = 0
  private readonly checkpoints = new Map<number, Uint8Array>()

  constructor(
    private readonly base: HistoryStep | null,
    private readonly steps: readonly HistoryStep[]
  ) {
    this.doc = this.from(0)
  }

  /** How many steps were made at or before `ts`. */
  countAt(ts: number): number {
    let low = 0
    let high = this.steps.length
    while (low < high) {
      const middle = (low + high) >> 1
      if ((this.steps[middle] as HistoryStep).ts <= ts) low = middle + 1
      else high = middle
    }
    return low
  }

  /** The room with its first `count` steps applied. Valid until the next call; the replay owns it. */
  to(count: number): Y.Doc {
    const target = Math.max(0, Math.min(count, this.steps.length))
    if (target < this.applied) {
      let from = 0
      for (const at of this.checkpoints.keys()) if (at <= target && at > from) from = at
      this.doc.destroy()
      this.doc = this.from(from)
    }
    this.doc.transact(() => {
      while (this.applied < target) {
        Y.applyUpdate(this.doc, (this.steps[this.applied] as HistoryStep).update)
        this.applied += 1
        if (this.applied % CHECKPOINT_EVERY === 0 && !this.checkpoints.has(this.applied)) {
          this.checkpoints.set(this.applied, Y.encodeStateAsUpdate(this.doc))
        }
      }
    })
    return this.doc
  }

  destroy(): void {
    this.doc.destroy()
    this.checkpoints.clear()
  }

  private from(checkpoint: number): Y.Doc {
    const doc = new Y.Doc()
    const state = checkpoint > 0 ? this.checkpoints.get(checkpoint) : this.base?.update
    if (state) Y.applyUpdate(doc, state)
    this.applied = checkpoint
    return doc
  }
}

export class RoomHistory {
  private constructor(
    private readonly base: HistoryStep | null,
    private readonly steps: HistoryStep[],
    /** Frames, or the snapshot, this device has no key for. */
    readonly unreadable: number
  ) {}

  static async load(api: { log(room: string): Promise<LogResponse> }, room: string, crypto: RoomCrypto): Promise<RoomHistory> {
    const { base, steps, unreadable } = await readLog(api, room, crypto)
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

  /**
   * Replays the room once, step by step, telling `visit` after the snapshot
   * (with `ts` = its time, or 0) and after each step. The document is the
   * walk's; it is destroyed afterwards.
   */
  walk(visit: (doc: Y.Doc, ts: number, isBase: boolean) => void): void {
    const doc = new Y.Doc()
    try {
      if (this.base) Y.applyUpdate(doc, this.base.update)
      visit(doc, this.base?.ts ?? 0, true)
      for (const step of this.steps) {
        Y.applyUpdate(doc, step.update)
        visit(doc, step.ts, false)
      }
    } finally {
      doc.destroy()
    }
  }
}
