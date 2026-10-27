import { CONTENT_FIELD } from '@obsidian-connect/shared'
import type { ConnectApi } from '../account/api.js'
import type { RoomCrypto } from '../sync/VaultSocket.js'
import { Replay, readLog, type HistoryStep } from './RoomHistory.js'
import type { Tick } from './Timeline.js'

// A note's history, read on this device: the server holds only ciphertext, so
// replaying to a point in time happens here. Restoring then edits the live
// document like any other change, so a restore can be undone.
//
// Ordered by when each change was made, as its author's device recorded it
// inside the encrypted frame - not by the server's seq or clock. A device that
// uploads a history again after the server lost it sends old changes late;
// they still belong where they were made. And the author's time is sealed,
// the server's is only claimed.

export interface Version {
  /** Identifies the last change of the version; `textAt` replays up to it. */
  seq: number
  ts: number
}

// Changes this close together count as one version; a version per keystroke
// batch would bury the ones people look for.
const SESSION_GAP_MS = 60_000

export class NoteHistory {
  private base: HistoryStep | null = null
  private steps: HistoryStep[] = []
  private replay: Replay | null = null
  /** Frames this device has no key for - they are skipped, and the view says so. */
  unreadable = 0

  constructor(
    private readonly api: Pick<ConnectApi, 'log'>,
    private readonly room: string,
    private readonly crypto: RoomCrypto,
    private readonly sessionGapMs = SESSION_GAP_MS
  ) {}

  async load(): Promise<void> {
    const { base, steps, unreadable } = await readLog(this.api, this.room, this.crypto)
    this.replay?.destroy()
    this.base = base
    this.steps = steps
    this.unreadable = unreadable
    this.replay = new Replay(base, steps)
  }

  /** The earliest moment the history replays to: 0 while it holds every change. */
  get reach(): number {
    return this.base?.ts ?? 0
  }

  /** Whether the note's text at `ts` can be told. */
  reaches(ts: number): boolean {
    return this.unreadable === 0 && ts >= this.reach
  }

  /** Newest first, one per editing session. */
  versions(): Version[] {
    return this.sessions()
      .map((session) => ({ seq: session.seq, ts: session.ts }))
      .reverse()
  }

  /** The Time Machine's ticks: a version each, oldest first. */
  ticks(): Tick[] {
    return this.sessions()
      .map((session) => ({ at: session.ts, from: session.from, last: session.ts, changed: 1 }))
      .sort((a, b) => a.at - b.at)
  }

  /** The text up to the change `seq`. */
  textAt(seq: number): string {
    if (this.base?.seq === seq) return this.textOf(0)
    const index = this.steps.findIndex((step) => step.seq === seq)
    return this.textOf(index < 0 ? this.steps.length : index + 1)
  }

  /** The text with every change made up to `ts`, by the authors' clocks. */
  textAtTime(ts: number): string {
    return this.textOf(this.replayer().countAt(ts))
  }

  destroy(): void {
    this.replay?.destroy()
    this.replay = null
  }

  private replayer(): Replay {
    this.replay ??= new Replay(this.base, this.steps)
    return this.replay
  }

  private textOf(count: number): string {
    return this.replayer().to(count).getText(CONTENT_FIELD).toString()
  }

  private sessions(): Array<{ seq: number; ts: number; from: number }> {
    const sessions: Array<{ seq: number; ts: number; from: number }> = []
    if (this.base) sessions.push({ seq: this.base.seq, ts: this.base.ts, from: this.base.ts })
    let from: number | null = null
    for (let i = 0; i < this.steps.length; i += 1) {
      const step = this.steps[i] as HistoryStep
      const next = this.steps[i + 1]
      from ??= step.ts
      if (!next || next.ts - step.ts > this.sessionGapMs) {
        sessions.push({ seq: step.seq, ts: step.ts, from })
        from = null
      }
    }
    return sessions
  }
}
