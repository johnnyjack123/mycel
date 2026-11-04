import * as Y from 'yjs'
import { folderRoom, frameAad, roomKind, roomSubject, snapshotAad, type BackupGrant } from '@obsidian-connect/shared'
import {
  aesKey,
  blobIdFor,
  decrypt,
  decryptBlobChunk,
  epochKeyContext,
  folderKeys,
  fromBase64,
  importPrivateKey,
  splitSealed,
  unpackFrame,
  unseal,
  vaultKeys,
  type Bytes
} from '@obsidian-connect/shared/crypto'
import type { CachedRoom } from './cache.js'

// Every key one vault uses, from what a device granted: the vault key derives
// the owner's keys, and the account's private key opens those of notes others
// shared into the vault. The same derivations as the plugin's `KeyRing`.

export interface Replayed {
  doc: Y.Doc
  /** When the sync server took the newest change in it; the time a file gets. */
  changedAt: number
  /** Frames there was no key for. */
  unreadable: number
}

export class VaultKeys {
  private readonly keys = new Map<string, Promise<CryptoKey>>()
  private blobIdKey: Promise<Bytes> | null = null

  private constructor(
    readonly grant: BackupGrant,
    private readonly vaultKey: Bytes,
    private readonly publicKey: Bytes,
    private readonly privateKey: CryptoKey
  ) {}

  static async open(grant: BackupGrant): Promise<VaultKeys> {
    const privateKey = await importPrivateKey(fromBase64(grant.privateKey))
    return new VaultKeys(grant, fromBase64(grant.vaultKey), fromBase64(grant.publicKey), privateKey)
  }

  private cached(id: string, make: () => Promise<Bytes>): Promise<CryptoKey> {
    let key = this.keys.get(id)
    if (!key) {
      key = make().then(aesKey)
      this.keys.set(id, key)
      key.catch(() => this.keys.delete(id))
    }
    return key
  }

  /** The key of one epoch of a room; null when there is none to be had. */
  async roomKey(cached: CachedRoom, epoch: number): Promise<CryptoKey | null> {
    const kind = roomKind(cached.room)
    const subject = roomSubject(cached.room)
    if (kind === 'idx' || kind === 'set') {
      if (epoch !== 0 || subject !== this.grant.vaultId) return null
      return this.cached(cached.room, () => (kind === 'idx' ? vaultKeys.index(this.vaultKey) : vaultKeys.settings(this.vaultKey)))
    }
    const own = cached.owner === this.grant.accountId
    // An epoch the note spent in a shared folder opens with the folder's key.
    const tie = cached.ties?.[String(epoch)]
    if (tie) {
      const id = `${cached.room}#${epoch}#${tie.folder}.${tie.epoch}`
      const existing = this.keys.get(id)
      if (existing) return existing
      const folderKey = own ? await vaultKeys.folder(this.vaultKey, tie.folder, tie.epoch) : await this.sealedFolderKey(cached, tie.folder, tie.epoch)
      if (folderKey) return this.cached(id, () => folderKeys.doc(folderKey, subject, epoch))
    }
    if (own && kind === 'fld') {
      return this.cached(`${cached.room}#${epoch}`, async () => folderKeys.room(await vaultKeys.folder(this.vaultKey, subject, epoch)))
    }
    if (own) {
      return this.cached(`${cached.room}#${epoch}`, () => vaultKeys.doc(this.vaultKey, subject, epoch))
    }
    const sealed = cached.sealed[String(epoch)]
    if (!sealed) return null
    if (kind === 'fld') {
      return this.cached(`${cached.room}#${epoch}`, async () => folderKeys.room(await this.unsealKey(sealed, epochKeyContext(cached.room, epoch))))
    }
    return this.cached(`${cached.room}#${epoch}`, () => this.unsealKey(sealed, epochKeyContext(cached.room, epoch)))
  }

  private async sealedFolderKey(cached: CachedRoom, folder: string, epoch: number): Promise<Bytes | null> {
    const sealed = cached.folderKeys?.[folder]?.[String(epoch)]
    if (!sealed) return null
    return this.unsealKey(sealed, epochKeyContext(folderRoom(folder), epoch))
  }

  /**
   * A key sealed to the account. Its sealer's signature (0.9.3) is the devices'
   * to check, against the contacts they pinned; the backup server reads the
   * vault as the account's devices left it and holds no contact list.
   */
  private unsealKey(value: string, context: string): Promise<Bytes> {
    return unseal(this.privateKey, this.publicKey, splitSealed(value)?.sealed ?? value, context)
  }

  /**
   * The room's document from its snapshot and frames. Frames are applied in
   * seq order; Yjs merges the same whatever the order, so this is the state
   * every device converges on.
   */
  async replay(cached: CachedRoom): Promise<Replayed> {
    const doc = new Y.Doc()
    let changedAt = 0
    let unreadable = 0
    const apply = async (epoch: number, data: string, aad: string, ts: number): Promise<void> => {
      const key = await this.roomKey(cached, epoch)
      if (!key) {
        unreadable += 1
        return
      }
      let plaintext: Uint8Array
      try {
        plaintext = await decrypt(key, fromBase64(data), aad)
      } catch {
        // A key that does not fit is a frame this run cannot read - said as a
        // problem of the note, never a run that fails for every other one.
        unreadable += 1
        return
      }
      Y.applyUpdate(doc, unpackFrame(plaintext).update)
      changedAt = Math.max(changedAt, ts)
    }
    if (cached.snapshot) {
      await apply(cached.snapshot.epoch, cached.snapshot.data, snapshotAad(cached.room, cached.snapshot.epoch), cached.snapshot.ts)
    }
    for (const frame of cached.frames) await apply(frame.epoch, frame.data, frameAad(cached.room, frame.epoch), frame.ts)
    return { doc, changedAt, unreadable }
  }

  /** The name of the blob holding this content, in the vault's store. */
  blobId(hash: string): Promise<string> {
    this.blobIdKey ??= vaultKeys.blobId(this.vaultKey)
    return this.blobIdKey.then((key) => blobIdFor(key, hash))
  }

  blobKey(blobId: string): Promise<CryptoKey> {
    return this.cached(`blob:${blobId}`, () => vaultKeys.blob(this.vaultKey, blobId))
  }

  async decryptChunk(blobId: string, data: Uint8Array, index: number, count: number): Promise<Bytes> {
    return decryptBlobChunk(await this.blobKey(blobId), data, blobId, index, count)
  }
}
