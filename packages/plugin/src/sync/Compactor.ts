import * as Y from 'yjs'
import { frameAad, roomKind, roomSubject, snapshotAad } from '@obsidian-connect/shared'
import { decrypt, encrypt, fromBase64, packFrame, toBase64, unpackFrame } from '@obsidian-connect/shared/crypto'
import type { ConnectApi } from '../account/api.js'
import type { KeyRing } from '../account/KeyRing.js'
import type { RoomCrypto } from './VaultSocket.js'
import { log } from '../log.js'

// History retention, done by the owner's client because only it can read the
// log. Frames older than the retention are folded into one snapshot; the
// server drops them only once that snapshot is stored. Nothing is lost but
// the granularity of old versions.
//
// Only rooms this account owns are ever offered by the server: a participant
// with a shorter retention must not shorten everyone's history.

const DAY_MS = 24 * 60 * 60 * 1000

export class Compactor {
  constructor(
    private readonly api: ConnectApi,
    private readonly keys: KeyRing,
    private readonly retentionDays: () => number
  ) {}

  /** Compacts every room that holds frames older than the retention. Returns how many. */
  async run(): Promise<number> {
    const days = this.retentionDays()
    if (days <= 0) return 0
    const cutoff = Date.now() - days * DAY_MS
    const { rooms } = await this.api.compactable(this.keys.vaultId, cutoff)
    let compacted = 0
    for (const room of rooms) {
      try {
        if (await this.compact(room, cutoff)) compacted += 1
      } catch (error) {
        log.warn(`compacting ${room} failed`, error)
      }
    }
    return compacted
  }

  private crypto(room: string): RoomCrypto | null {
    switch (roomKind(room)) {
      case 'idx':
        return this.keys.indexCrypto()
      case 'set':
        return this.keys.settingsCrypto()
      case 'doc':
        return this.keys.ownDocCrypto(roomSubject(room))
      default:
        return null
    }
  }

  private async compact(room: string, cutoff: number): Promise<boolean> {
    const crypto = this.crypto(room)
    if (!crypto) return false
    const log = await this.api.log(room)
    const doc = new Y.Doc()
    try {
      if (log.snapshot) {
        const key = await crypto.key(log.snapshot.epoch)
        if (!key) return false
        const plaintext = await decrypt(key, fromBase64(log.snapshot.data), snapshotAad(room, log.snapshot.epoch))
        Y.applyUpdate(doc, unpackFrame(plaintext).update)
      }
      let uptoSeq = 0
      for (const frame of log.frames) {
        if (frame.ts > cutoff) break
        const key = await crypto.key(frame.epoch)
        // A frame that cannot be read here cannot be folded in either.
        if (!key) return false
        const plaintext = await decrypt(key, fromBase64(frame.data), frameAad(room, frame.epoch))
        Y.applyUpdate(doc, unpackFrame(plaintext).update)
        uptoSeq = frame.seq
      }
      if (uptoSeq === 0) return false
      // Under the current epoch: everyone who still has access holds that key.
      const key = await crypto.key(log.epoch)
      if (!key) return false
      const data = await encrypt(key, packFrame(Date.now(), Y.encodeStateAsUpdate(doc)), snapshotAad(room, log.epoch))
      await this.api.snapshot(room, { uptoSeq, epoch: log.epoch, data: toBase64(data) })
      return true
    } finally {
      doc.destroy()
    }
  }
}
