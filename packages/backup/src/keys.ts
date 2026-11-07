import * as Y from 'yjs'
import { folderRoom, frameAad, roomKind, roomSubject, snapshotAad, type BackupGrant, type FolderTie } from '@mycel/shared'
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
  verifyFrame,
  verifyWriterCert,
  type Bytes,
  type OpenedFrame
} from '@mycel/shared/crypto'
import type { CachedRoom } from './cache.js'

/** The keys of the account settings' contacts, as the plugin's `AccountSettings` writes them. */
const CONTACT_PREFIX = 'contact:'

// Every key one vault uses, from what a device granted: the vault key derives
// the owner's keys, and the account's private key opens those of notes others
// shared into the vault. The same derivations as the plugin's `KeyRing`.

export interface Replayed {
  doc: Y.Doc
  /** When the sync server took the newest change in it; the time a file gets. */
  changedAt: number
  /** Frames there was no key for. */
  unreadable: number
  /** Frames nobody who may write in the room signed - left out, as every device leaves them out. */
  unsigned: number
}

export class VaultKeys {
  private readonly keys = new Map<string, Promise<CryptoKey>>()
  private blobIdKey: Promise<Bytes> | null = null
  /**
   * Signing keys by account: this account's own, from the grant, and its
   * contacts', as its settings pin them. A frame is taken only with a signature
   * that holds - as on every device: the sync server could otherwise have its
   * own frames, or a revoked member's, backed up and restored as the vault.
   */
  private readonly signers = new Map<string, Bytes>()

  private constructor(
    readonly grant: BackupGrant,
    private readonly vaultKey: Bytes,
    private readonly publicKey: Bytes,
    private readonly privateKey: CryptoKey
  ) {
    if (grant.signingPublicKey) this.signers.set(grant.accountId, fromBase64(grant.signingPublicKey))
  }

  static async open(grant: BackupGrant): Promise<VaultKeys> {
    const privateKey = await importPrivateKey(fromBase64(grant.privateKey))
    return new VaultKeys(grant, fromBase64(grant.vaultKey), fromBase64(grant.publicKey), privateKey)
  }

  /**
   * Whether frames are checked at all: a pairing made before 0.9.9 carries no
   * signing key of the account's, and the vault is read as it was then until a
   * device hands over a new grant (a password change does).
   */
  get checksSignatures(): boolean {
    return this.signers.has(this.grant.accountId)
  }

  /** The contacts' signing keys from the vault's settings document; one that replaced its keys is not taken until confirmed again. */
  learnContacts(settings: ReadonlyMap<string, unknown>): void {
    for (const [key, value] of settings) {
      if (!key.startsWith(CONTACT_PREFIX) || !value || typeof value !== 'object') continue
      const contact = value as { accountId?: unknown; signingKey?: unknown; replacedAt?: unknown }
      if (typeof contact.accountId !== 'string' || typeof contact.signingKey !== 'string' || contact.replacedAt !== undefined) continue
      if (contact.accountId === this.grant.accountId) continue
      try {
        this.signers.set(contact.accountId, fromBase64(contact.signingKey))
      } catch {
        // A key that does not decode signs nothing.
      }
    }
  }

  /** As the plugin's `KeyRing.checkFrame`: the owner signs; anyone else carries the owner's certificate, and signs with the key it names. */
  private async signedByWriter(room: string, epoch: number, owner: string, tie: FolderTie | null, kind: 'frame' | 'snapshot', frame: OpenedFrame): Promise<boolean> {
    const ownerKey = this.signers.get(owner)
    if (!ownerKey) return false
    if (frame.author === owner) return verifyFrame(ownerKey, room, epoch, frame)
    const cert = frame.cert
    if (kind === 'snapshot' || !cert) return false
    const certified =
      (tie !== null && (await verifyWriterCert(ownerKey, folderRoom(tie.folder), tie.epoch, frame.author, cert))) ||
      (await verifyWriterCert(ownerKey, room, epoch, frame.author, cert))
    return certified && verifyFrame(cert.signingKey, room, epoch, frame)
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
   * A key sealed to the account. Its sealer's signature is the devices' to
   * check, against the contacts they pinned; the backup server reads the vault
   * as the account's devices left it and holds no contact list.
   */
  private unsealKey(value: string, context: string): Promise<Bytes> {
    const signed = splitSealed(value)
    if (!signed) return Promise.reject(new Error('a key without its sealer’s signature'))
    return unseal(this.privateKey, this.publicKey, signed.sealed, context)
  }

  /**
   * The room's document from its snapshot and frames. Frames are applied in
   * seq order; Yjs merges the same whatever the order, so this is the state
   * every device converges on. `owner`: whose the room is as the vault's own
   * index has it - not as the sync server says; the vault's index and settings
   * are always the account's.
   */
  async replay(cached: CachedRoom, owner?: string): Promise<Replayed> {
    const doc = new Y.Doc()
    let changedAt = 0
    let unreadable = 0
    let unsigned = 0
    const kind = roomKind(cached.room)
    const roomOwner = kind === 'idx' || kind === 'set' ? this.grant.accountId : (owner ?? cached.owner)
    const apply = async (epoch: number, data: string, aad: string, ts: number, frameKind: 'frame' | 'snapshot'): Promise<void> => {
      let plaintext: Uint8Array
      try {
        const key = await this.roomKey(cached, epoch)
        if (!key) {
          unreadable += 1
          return
        }
        plaintext = await decrypt(key, fromBase64(data), aad)
      } catch {
        // A key that does not fit is a frame this run cannot read - said as a
        // problem of the note, never a run that fails for every other one.
        unreadable += 1
        return
      }
      const frame = unpackFrame(plaintext)
      if (!frame) {
        unreadable += 1
        return
      }
      if (this.checksSignatures && !(await this.signedByWriter(cached.room, epoch, roomOwner, cached.ties?.[String(epoch)] ?? null, frameKind, frame))) {
        unsigned += 1
        return
      }
      Y.applyUpdate(doc, frame.update)
      changedAt = Math.max(changedAt, ts)
    }
    if (cached.snapshot) {
      await apply(cached.snapshot.epoch, cached.snapshot.data, snapshotAad(cached.room, cached.snapshot.epoch), cached.snapshot.ts, 'snapshot')
    }
    for (const frame of cached.frames) await apply(frame.epoch, frame.data, frameAad(cached.room, frame.epoch), frame.ts, 'frame')
    return { doc, changedAt, unreadable, unsigned }
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
