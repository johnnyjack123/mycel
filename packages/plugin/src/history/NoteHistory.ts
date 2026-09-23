import * as Y from 'yjs'
import { CONTENT_FIELD, frameAad, snapshotAad } from '@obsidian-connect/shared'
import { decrypt, fromBase64, unpackFrame } from '@obsidian-connect/shared/crypto'
import type { ConnectApi } from '../account/api.js'
import type { RoomCrypto } from '../sync/VaultSocket.js'

// A note's history, read on this device: the server holds only ciphertext, so
// replaying to a point in time happens here. Restoring then edits the live
// document like any other change, so a restore can be undone.

export interface Version {
  /** Replaying up to and including this frame shows the version. */
  seq: number
  ts: number
}

// Frames this close together count as one version; a version per keystroke
// batch would bury the ones people look for.
const SESSION_GAP_MS = 60_000

interface Step {
  seq: number
  ts: number
  update: Uint8Array
}

export class NoteHistory {
  private base: { seq: number; ts: number; update: Uint8Array } | null = null
  private steps: Step[] = []
  /** Frames this device has no key for - they are skipped, and the view says so. */
  unreadable = 0

  constructor(
    private readonly api: ConnectApi,
    private readonly room: string,
    private readonly crypto: RoomCrypto,
    private readonly sessionGapMs = SESSION_GAP_MS
  ) {}

  async load(): Promise<void> {
    const log = await this.api.log(this.room)
    this.base = null
    this.steps = []
    this.unreadable = 0
    if (log.snapshot) {
      const key = await this.crypto.key(log.snapshot.epoch)
      if (key) {
        const plaintext = await decrypt(key, fromBase64(log.snapshot.data), snapshotAad(this.room, log.snapshot.epoch))
        this.base = { seq: log.snapshot.uptoSeq, ts: log.snapshot.ts, update: unpackFrame(plaintext).update }
      } else {
        this.unreadable += 1
      }
    }
    for (const frame of log.frames) {
      const key = await this.crypto.key(frame.epoch)
      if (!key) {
        this.unreadable += 1
        continue
      }
      const plaintext = await decrypt(key, fromBase64(frame.data), frameAad(this.room, frame.epoch))
      this.steps.push({ seq: frame.seq, ts: frame.ts, update: unpackFrame(plaintext).update })
    }
  }

  /** Newest first, one per editing session. */
  versions(): Version[] {
    const versions: Version[] = []
    if (this.base) versions.push({ seq: this.base.seq, ts: this.base.ts })
    for (let i = 0; i < this.steps.length; i += 1) {
      const step = this.steps[i] as Step
      const next = this.steps[i + 1]
      if (!next || next.ts - step.ts > this.sessionGapMs) versions.push({ seq: step.seq, ts: step.ts })
    }
    return versions.reverse()
  }

  textAt(seq: number): string {
    const doc = new Y.Doc()
    try {
      doc.transact(() => {
        if (this.base) Y.applyUpdate(doc, this.base.update)
        for (const step of this.steps) {
          if (step.seq > seq) break
          Y.applyUpdate(doc, step.update)
        }
      })
      return doc.getText(CONTENT_FIELD).toString()
    } finally {
      doc.destroy()
    }
  }
}
