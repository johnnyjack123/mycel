import * as Y from 'yjs'
import { frameAad, roomKind, roomSubject, snapshotAad } from '@mycel/shared'
import { decrypt, encrypt, fromBase64, toBase64, unpackFrame } from '@mycel/shared/crypto'
import type { ConnectApi } from '../account/api.js'
import type { KeyRing } from '../account/KeyRing.js'
import type { RoomCrypto } from './VaultSocket.js'
import { log, log as logger } from '../log.js'

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
        // Asked which epochs belong to a shared folder: compaction is rare, and
        // a note of a folder must never be folded under its own key.
        return this.keys.noteCrypto(roomSubject(room), { owned: true, folder: true, owner: null })
      case 'fld':
        return this.keys.folderRoomCrypto(roomSubject(room), null)
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
      // The time of the newest change folded in: a rollback reaches back to
      // it and no further (`RoomHistory`). An earlier snapshot of this room
      // may say when it was made instead, which is later - and safe.
      let newest = 0
      if (log.snapshot) {
        const key = await crypto.key(log.snapshot.epoch)
        if (!key) return false
        const plaintext = await decrypt(key, fromBase64(log.snapshot.data), snapshotAad(room, log.snapshot.epoch))
        const snapshot = unpackFrame(plaintext)
        // A snapshot not the owner's is never folded into one that is.
        if (!snapshot || (await crypto.check('snapshot', log.snapshot.uptoSeq, log.snapshot.epoch, snapshot)) !== 'ok') {
          logger.error(`${room}: its snapshot is not signed by this account; not compacted`)
          return false
        }
        Y.applyUpdate(doc, snapshot.update)
        newest = snapshot.authorTs
      }
      let uptoSeq = 0
      for (const frame of log.frames) {
        if (frame.ts > cutoff) break
        const key = await crypto.key(frame.epoch)
        // A frame that cannot be read here cannot be folded in either.
        if (!key) return false
        const plaintext = await decrypt(key, fromBase64(frame.data), frameAad(room, frame.epoch))
        const change = unpackFrame(plaintext)
        // Folded in, a frame would carry this account's signature from then on: only what it takes is.
        const verdict = change ? await crypto.check('frame', frame.seq, frame.epoch, change) : 'forged'
        if (verdict === 'unknown') return false
        if (verdict === 'ok' && change) {
          Y.applyUpdate(doc, change.update)
          newest = Math.max(newest, change.authorTs)
        } else {
          logger.error(`${room}: frame #${frame.seq} is not signed by someone who may write there; not folded in`)
        }
        uptoSeq = frame.seq
      }
      if (uptoSeq === 0) return false
      // Under the current epoch: everyone who still has access holds that key -
      // unless the server tied it to a folder this vault has the note in not.
      if (crypto.mayEncrypt && !(await crypto.mayEncrypt(log.epoch))) return false
      const key = await crypto.key(log.epoch)
      if (!key) return false
      const packed = await this.keys.packAsOwner(room, log.epoch, newest, Y.encodeStateAsUpdate(doc))
      const data = await encrypt(key, packed, snapshotAad(room, log.epoch))
      await this.api.snapshot(room, { uptoSeq, epoch: log.epoch, data: toBase64(data) })
      return true
    } finally {
      doc.destroy()
    }
  }
}
