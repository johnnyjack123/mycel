import * as Y from 'yjs'
import {
  folderRoom,
  frameAad,
  roomKind,
  roomSubject,
  snapshotAad,
  type FolderTie,
  type RewriteRequest,
  type Rotation,
  type WholeLogResponse
} from '@obsidian-connect/shared'
import { decrypt, encrypt, fromBase64, recertifyFrame, toBase64, unpackFrame, type Bytes, type OpenedFrame } from '@obsidian-connect/shared/crypto'
import { ApiError, type ConnectApi } from './api.js'
import { KeyRing, type Recipient } from './KeyRing.js'
import type { OpenVault, PreviousKeys, SecretStore, Unlocked } from './Session.js'
import { AccountSettings } from '../sync/AccountSettings.js'
import { AttachmentIndex } from '../sync/AttachmentIndex.js'
import { BlobMissing, Blobs } from '../sync/Blobs.js'
import { LockSeal, VaultLockedError, lockNonce, takeVaultLock, type HeldLock } from '../sync/VaultLock.js'
import type { RoomCrypto } from '../sync/VaultSocket.js'
import { log } from '../log.js'

// Replacing every key of the account (`docs/PHASE8.md`, S2), the part after the
// server took the new ones: every room the account owns, in every vault, written
// anew in place under the new keys - every frame at its seq, every snapshot,
// every key a member holds -, and every file uploaded anew under the new key and
// the old content let go of. Nothing on the server opens with the keys before
// afterwards. Under the vault's lock; whichever device of the account gets there
// does it, and one that broke off is taken up where it stopped: a room already
// written anew is marked, and a room a crash left half written is read with both
// kinds of keys.
//
// Only what the keys before vouch for is signed anew: the account's own frames
// with its new signing key, a writer's with a new certificate over the key they
// signed with. Whatever no signature holds for was dropped by every device
// anyway and becomes an empty change; whatever no key opens stops it all - it
// is never thrown away.

const RETRIES = 5
const ORDER = ['set', 'idx', 'fld', 'doc']

export interface ReplacementProgress {
  vault: string
  what: 'notes' | 'files'
  done: number
  of: number
}

/** Stops the replacement: nothing that was written is undone, and it goes on from there next time. */
export class KeyReplacementError extends Error {}

interface Rings {
  before: KeyRing
  after: KeyRing
}

type Opened = { ok: true; frame: OpenedFrame } | { ok: false; authorTs: number }

/** The keys the replacement reads with are never kept on the device. */
function memoryStore(): SecretStore {
  const values = new Map<string, string>()
  return {
    load: (key) => values.get(key) ?? null,
    save: (key, value) => {
      if (value === null) values.delete(key)
      else values.set(key, value)
    }
  }
}

const EMPTY_UPDATE = Y.encodeStateAsUpdate(new Y.Doc())

export class KeyReplacement {
  constructor(
    private readonly api: ConnectApi,
    private readonly unlocked: Unlocked,
    private readonly vaults: OpenVault[],
    private readonly options: { device: string; progress?: (progress: ReplacementProgress) => void }
  ) {}

  private get previous(): PreviousKeys {
    const previous = this.unlocked.previous
    if (!previous) throw new KeyReplacementError('No replacement of the keys is under way.')
    return previous
  }

  /** Every vault written anew. Throws `KeyReplacementError` for what stops it - another device at it, a member who is no contact. */
  async run(): Promise<void> {
    const previous = this.previous
    for (const vault of this.vaults) {
      const before = previous.vaultKeys.get(vault.vaultId)
      if (before) await this.vault(vault, before)
    }
  }

  private async vault(vault: OpenVault, keyBefore: Bytes): Promise<void> {
    const previous = this.previous
    const signingBefore = { privateKey: this.unlocked.signing.privateKey, publicKey: previous.signingPublicKey }
    const rings: Rings = {
      before: new KeyRing({ ...vault, key: keyBefore }, { ...this.unlocked, signing: signingBefore }, this.api, memoryStore()),
      after: new KeyRing(vault, this.unlocked, this.api, memoryStore())
    }
    // Only the account's own rooms are written anew, and its folders' keys derive from its vault key.
    for (const ring of Object.values(rings)) ring.setFolderOwnership(() => true)
    const lock = await this.lock(vault, rings.after)
    try {
      const rooms = (await this.api.ownedRooms(vault.vaultId)).rooms
      rooms.sort((a, b) => ORDER.indexOf(roomKind(a.room) ?? '') - ORDER.indexOf(roomKind(b.room) ?? ''))
      let settings: AccountSettings | null = null
      let index: Y.Doc | null = null
      let done = 0
      for (const { room } of rooms) {
        if (!lock.active) throw new KeyReplacementError('The vault lock ended before the vault was written anew.')
        const kind = roomKind(room)
        const doc = await this.room(room, rings, lock.id, settings, kind === 'set' || kind === 'idx')
        if (kind === 'set' && doc) {
          settings = new AccountSettings()
          Y.applyUpdate(settings.doc, Y.encodeStateAsUpdate(doc))
        }
        if (kind === 'idx') index = doc
        done += 1
        this.options.progress?.({ vault: vault.name, what: 'notes', done, of: rooms.length })
      }
      if (index) await this.files(vault, rings, index)
      log.info(`${vault.name}: written anew under the new keys, ${rooms.length} room(s)`)
    } finally {
      await lock.release()
    }
  }

  private async lock(vault: OpenVault, after: KeyRing): Promise<HeldLock> {
    const sealed = await new LockSeal(after.settingsCrypto(), vault.vaultId).seal({
      what: 'the vault, written anew under replaced keys',
      device: this.options.device,
      nonce: lockNonce(),
      scope: { kind: 'vault' }
    })
    try {
      return await takeVaultLock(this.api, vault.vaultId, 'replace', sealed, (why) => log.warn(`the replacement's vault lock ended: ${why}`))
    } catch (error) {
      if (error instanceof VaultLockedError) {
        throw new KeyReplacementError('The vault is locked - by another device of yours writing it anew, or by one that stopped a moment ago. Try again in two minutes.')
      }
      throw error
    }
  }

  private cryptoOf(ring: KeyRing, room: string): RoomCrypto {
    switch (roomKind(room)) {
      case 'idx':
        return ring.indexCrypto()
      case 'set':
        return ring.settingsCrypto()
      case 'fld':
        return ring.folderRoomCrypto(roomSubject(room), null)
      default:
        return ring.noteCrypto(roomSubject(room), { owned: true, folder: true, owner: null })
    }
  }

  /**
   * One room written anew - or, written already, only read. With `keep`, its
   * document as everything in it builds it: the settings and the index are
   * needed further on.
   */
  private async room(room: string, rings: Rings, lockId: string, settings: AccountSettings | null, keep: boolean): Promise<Y.Doc | null> {
    const previous = this.previous
    const crypto = { before: this.cryptoOf(rings.before, room), after: this.cryptoOf(rings.after, room) }
    for (let attempt = 0; ; attempt += 1) {
      const whole = await this.api.wholeLog(room)
      const written = whole.rewrittenBy === previous.id
      const doc = keep ? new Y.Doc() : null
      const request: RewriteRequest = {
        replacement: previous.id,
        lockId,
        headSeq: whole.headSeq,
        epoch: whole.epoch,
        frames: [],
        snapshots: [],
        keys: {}
      }
      for (const snapshot of whole.snapshots) {
        const aad = snapshotAad(room, snapshot.epoch)
        const opened = await this.open(room, crypto, 'snapshot', snapshot.uptoSeq, snapshot.epoch, snapshot.data, aad)
        if (doc && opened.ok) Y.applyUpdate(doc, opened.frame.update)
        if (!written) request.snapshots.push({ uptoSeq: snapshot.uptoSeq, data: await this.seal(rings.after, crypto.after, room, snapshot.epoch, opened, aad) })
      }
      for (const frame of whole.frames) {
        const aad = frameAad(room, frame.epoch)
        const opened = await this.open(room, crypto, 'frame', frame.seq, frame.epoch, frame.data, aad)
        if (doc && opened.ok) Y.applyUpdate(doc, opened.frame.update)
        if (!written) request.frames.push({ seq: frame.seq, data: await this.seal(rings.after, crypto.after, room, frame.epoch, opened, aad) })
      }
      if (written) return doc
      await this.sealKeys(room, whole, rings.after, settings, request)
      try {
        await this.api.rewrite(room, request)
        return doc
      } catch (error) {
        // Something moved meanwhile - a member wrote, the folder moved on: read it again.
        if (error instanceof ApiError && error.status === 409 && attempt < RETRIES) continue
        throw error
      }
    }
  }

  /**
   * An item of the log, opened with the new keys or those before - a room a
   * crash left half written has both - and checked by the keys that opened it.
   */
  private async open(
    room: string,
    crypto: { before: RoomCrypto; after: RoomCrypto },
    kind: 'frame' | 'snapshot',
    seq: number,
    epoch: number,
    data: string,
    aad: string
  ): Promise<Opened> {
    for (const which of [crypto.after, crypto.before]) {
      const key = await which.key(epoch)
      if (!key) continue
      let plaintext: Bytes
      try {
        plaintext = await decrypt(key, fromBase64(data), aad)
      } catch {
        continue
      }
      const frame = unpackFrame(plaintext)
      const verdict = frame ? await which.check(kind, seq, epoch, frame) : 'forged'
      if (verdict === 'unknown') throw new KeyReplacementError(`${room}: a key or certificate of #${seq} cannot be had; nothing of it was changed`)
      if (verdict === 'ok' && frame) return { ok: true, frame }
      log.warn(`${room}: ${kind} #${seq} is signed by nobody who may write there; it goes on as an empty change`)
      return { ok: false, authorTs: frame?.authorTs ?? 0 }
    }
    throw new KeyReplacementError(`${room}: no key opens ${kind} #${seq}; nothing of it was changed`)
  }

  /** An item sealed anew: this account's signed anew, a writer's certified anew, anything else as an empty change of its own. */
  private async seal(ring: KeyRing, crypto: RoomCrypto, room: string, epoch: number, opened: Opened, aad: string): Promise<string> {
    const key = await crypto.key(epoch)
    if (!key) throw new KeyReplacementError(`${room}: no new key for epoch ${epoch}`)
    let plaintext: Bytes
    if (!opened.ok) {
      plaintext = await ring.packAsOwner(room, epoch, opened.authorTs, EMPTY_UPDATE)
    } else if (opened.frame.author === ring.accountId) {
      plaintext = await ring.packAsOwner(room, epoch, opened.frame.authorTs, opened.frame.update)
    } else {
      const cert = opened.frame.cert
      if (!cert) throw new KeyReplacementError(`${room}: a writer's frame without a certificate passed`)
      plaintext = recertifyFrame(opened.frame, await ring.certFor(room, epoch, opened.frame.author, cert.signingKey))
    }
    return toBase64(await encrypt(key, plaintext, aad))
  }

  /** Every key a member holds sealed anew, and - for a room others write in - the next epoch sealed to each member. */
  private async sealKeys(room: string, whole: WholeLogResponse, ring: KeyRing, settings: AccountSettings | null, request: RewriteRequest): Promise<void> {
    const kind = roomKind(room)
    const subject = roomSubject(room)
    const sealAll = async (epochs: number[], recipient: Recipient, next?: { epoch: number; tie: FolderTie | null }): Promise<Record<string, string>> =>
      kind === 'fld' ? ring.sealFolderKeys(subject, epochs, recipient) : ring.sealEpochKeys(subject, epochs, recipient, next)
    for (const [holder, epochs] of Object.entries(whole.keys)) request.keys[holder] = await sealAll(epochs, this.recipient(settings, room, holder))
    if (whole.members.length === 0 && !whole.folder) return
    const epoch = whole.epoch + 1
    const rotation: Rotation = { epoch, keys: {} }
    let tie: FolderTie | null = null
    if (kind === 'doc' && whole.folder) {
      const folderEpoch = await this.api
        .keys(folderRoom(whole.folder))
        .then((keys) => keys.epoch)
        .catch(() => null)
      if (folderEpoch !== null) {
        tie = { folder: whole.folder, epoch: folderEpoch }
        rotation.folderEpoch = folderEpoch
      }
    }
    for (const member of whole.members) {
      const sealed = await sealAll([epoch], this.recipient(settings, room, member), { epoch, tie })
      rotation.keys[member] = sealed[String(epoch)] as string
    }
    request.rotation = rotation
  }

  /** Someone who holds a room's keys, as this account pinned them; a writer with a certificate over their signing key. */
  private recipient(settings: AccountSettings | null, room: string, account: string): Recipient {
    const contact = settings?.contact(account)
    if (!contact) {
      throw new KeyReplacementError(
        `${account.slice(0, 8)} holds keys of a shared note or folder of yours but is no contact. Take them out of it, then let the replacement go on.`
      )
    }
    const role = settings?.shareRole(room, account) ?? 'read'
    return { account, publicKey: fromBase64(contact.publicKey), writer: role === 'write' ? { signingKey: fromBase64(contact.signingKey) } : null }
  }

  /**
   * Every file the index names uploaded anew under the new key, then every
   * other content of the vault's store let go of - what lay there under the
   * keys before. The server keeps what a shared note's list still names.
   */
  private async files(vault: OpenVault, rings: Rings, index: Y.Doc): Promise<void> {
    const named = Array.from(new AttachmentIndex(index, async () => '').namedHashes())
    const before = new Blobs(this.api, rings.before)
    const after = new Blobs(this.api, rings.after)
    const kept = new Set<string>()
    let missing = 0
    let done = 0
    for (const hash of named) {
      kept.add(await rings.after.blobId(hash))
      if (!(await after.has(hash))) {
        try {
          await after.upload(await before.download(hash), hash)
        } catch (error) {
          if (!(error instanceof BlobMissing)) throw error
          missing += 1
        }
      }
      done += 1
      this.options.progress?.({ vault: vault.name, what: 'files', done, of: named.length })
    }
    const listing = await this.api.listBlobs(this.unlocked.accountId, vault.vaultId)
    const stale = [...listing.blobs, ...listing.uploads].map((blob) => blob.id).filter((id) => !kept.has(id))
    const left = stale.length > 0 ? await after.purgeIds(stale, this.previous.id) : new Set<string>()
    log.info(
      `${vault.name}: ${named.length} file content(s) uploaded anew${missing > 0 ? `, ${missing} the server did not have` : ''}; ${stale.length - left.size} let go of, ${left.size} still named by a shared note`
    )
  }
}
