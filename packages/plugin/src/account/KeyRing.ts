import { docRoom, folderRoom, indexRoom, settingsRoom, tiesAscend, type FolderTie, type KeysResponse } from '@mycel/shared'
import {
  aesKey,
  blobIdFor,
  deriveDocId,
  deriveFileId,
  deriveFolderId,
  epochKeyContext,
  folderKeys,
  fromBase64,
  fromUtf8,
  packSignedFrame,
  seal,
  signSealed,
  signWriterCert,
  splitSealed,
  titleContext,
  toBase64,
  unseal,
  utf8,
  vaultKeys,
  verifyFrame,
  verifySealed,
  verifyWriterCert,
  type Bytes,
  type OpenedFrame,
  type WriterCert
} from '@mycel/shared/crypto'
import type { FrameVerdict, RoomCrypto } from '../sync/VaultSocket.js'
import type { ConnectApi } from './api.js'
import type { OpenVault, SecretStore, Unlocked } from './Session.js'
import { log } from '../log.js'

const SEALED_PREFIX = 'mycel:sealed:'
const TIES_PREFIX = 'mycel:ties:'

/**
 * Which of a note's epochs it spent in a shared folder, and with which folder
 * epoch: those keys derive from the folder's. Every epoch up to `upTo` that is
 * not named is the note's own; a null entry is one known to be its own.
 */
interface KnownTies {
  ties: Record<string, FolderTie | null>
  upTo: number
}

/** Someone a key is sealed to: their account, and their sealing key as pinned. */
export interface Recipient {
  account: string
  publicKey: Bytes
  /**
   * Someone who may write gets the owner's certificate with the key, over
   * their signing key - without one, nobody takes what they write.
   */
  writer?: { signingKey: Bytes } | null
}

/** How a note's keys are found. */
export interface NoteKeyPlace {
  /** This vault owns the note: its own epochs derive from the vault key. */
  owned: boolean
  /**
   * The note is or was in a shared folder, as far as this device knows. An
   * epoch whose tie is unknown is then asked for before a key is derived;
   * otherwise the note's own key is tried and the server asked only when it
   * does not fit.
   */
  folder?: boolean
}

export interface NoteKeyOptions extends NoteKeyPlace {
  /**
   * Who owns the note: null for this account. Its frames are signed on the way
   * out and checked against it on the way in. As a function it is asked at
   * every frame: a note copied into someone else's folder becomes theirs after
   * it was opened.
   */
  owner: string | null | (() => string | null)
}

/**
 * Every key this vault uses. The owner's keys are derived from the vault key
 * and never stored; keys of notes other people shared arrive sealed to this
 * account and are kept sealed on the device, so they work offline.
 */
export class KeyRing {
  private readonly keys = new Map<string, Promise<CryptoKey>>()
  private readonly sealedByRoom = new Map<string, Record<string, string>>()
  private readonly tiesByRoom = new Map<string, KnownTies>()
  /** Raw folder keys, by `${folderId}#${epoch}`: notes' keys derive from them. */
  private readonly folderKeyCache = new Map<string, Promise<Bytes | null>>()
  private blobIdKey: Promise<Bytes> | null = null
  /** Whether a shared folder is one of this vault's own; set once the vault index is there. */
  private ownsFolder: (folderId: string) => boolean = () => false
  /** A contact's signing key, as pinned; null for anyone else. */
  private signerKey: (account: string) => Bytes | null = () => null

  constructor(
    private readonly vault: OpenVault,
    private readonly account: Unlocked,
    private readonly api: ConnectApi,
    private readonly secrets: SecretStore
  ) {}

  /** Tells which shared folders this vault owns: their keys are derived, everyone else's arrive sealed. */
  setFolderOwnership(owns: (folderId: string) => boolean): void {
    this.ownsFolder = owns
  }

  /** Where the signing keys of contacts come from: the contact list. */
  setSigners(resolve: (account: string) => Bytes | null): void {
    this.signerKey = resolve
  }

  /**
   * A key sealed to this account, opened only with its sealer's signature:
   * this account's own, or a contact's whose signing key is pinned.
   * A server handing out a key of its own - and frames under it - would
   * otherwise have this device read what it wrote as the owner's.
   */
  private async openSealed(room: string, epoch: number, value: string): Promise<Bytes | null> {
    const signed = splitSealed(value)
    if (!signed) {
      log.warn(`${room}: the key of epoch ${epoch} carries no signature; not taken`)
      return null
    }
    const signerKey = this.signerPublicKey(signed.signer)
    if (!signerKey) {
      log.warn(`${room}: the key of epoch ${epoch} was sealed by ${signed.signer.slice(0, 8)}, whose signing key this account does not know`)
      return null
    }
    if (!(await verifySealed(signerKey, room, epoch, this.account.accountId, signed))) {
      log.error(`${room}: the signature on the key of epoch ${epoch} does not hold; not taken`)
      return null
    }
    try {
      return await unseal(this.account.privateKey, this.account.publicKey, signed.sealed, epochKeyContext(room, epoch))
    } catch {
      // Sealed to the key this account had before it replaced its keys: the owner seals it anew once they confirmed the new one.
      log.info(`${room}: the key of epoch ${epoch} is sealed to a key this account no longer has`)
      return null
    }
  }

  /** A sealed epoch key of `room`: the one kept here, or - when that does not open - the server's, which the owner may have sealed anew. */
  private async sealedKeyOf(room: string, epoch: number): Promise<Bytes | null> {
    const kept = this.sealed(room)[String(epoch)]
    const opened = kept ? await this.openSealed(room, epoch, kept) : null
    if (opened) return opened
    const fetched = (await this.fetchSealed(room))[String(epoch)]
    return fetched && fetched !== kept ? this.openSealed(room, epoch, fetched) : null
  }

  /** A key sealed for `recipient`, signed by this account as the one who sealed it - with a writer's certificate for one who may write. */
  private async sealFor(room: string, epoch: number, recipient: Recipient, key: Bytes): Promise<string> {
    const signing = this.account.signing
    const sealed = await seal(recipient.publicKey, key, epochKeyContext(room, epoch))
    const cert = recipient.writer ? await signWriterCert(signing.privateKey, room, epoch, recipient.account, recipient.writer.signingKey) : undefined
    return signSealed(signing.privateKey, this.account.accountId, room, epoch, recipient.account, sealed, cert)
  }

  // --- signed frames --------------------------------------------------------------
  // Every frame is signed by its author inside the encryption. Whoever is not the
  // room's owner adds the owner's certificate that they may write there, which
  // came with their key. A frame is taken only when its author is the owner, or
  // holds such a certificate; and its signature holds.

  private readonly certsAsked = new Set<string>()

  /** The signing key of an account: this one's own, or a contact's as pinned. */
  private signerPublicKey(account: string): Bytes | null {
    return account === this.account.accountId ? this.account.signing.publicKey : this.signerKey(account)
  }

  /** This account's certificate to write in a room in an epoch, from the key it came with; asked for once when missing. */
  private async ownCert(scopeRoom: string, scopeEpoch: number): Promise<WriterCert | null> {
    const signing = this.account.signing
    const find = (): WriterCert | null => {
      const value = this.sealed(scopeRoom)[String(scopeEpoch)]
      const cert = value ? splitSealed(value)?.cert : undefined
      return cert ? { signingKey: signing.publicKey, signature: fromBase64(cert) } : null
    }
    const found = find()
    if (found) return found
    const id = `${scopeRoom}#${scopeEpoch}`
    if (this.certsAsked.has(id)) return null
    this.certsAsked.add(id)
    await this.fetchKeys(scopeRoom)
    return find()
  }

  /** Signs what this device writes in a room; null while it may not - a writer whose certificate has not come. */
  private async packFor(room: string, epoch: number, owner: string, tie: FolderTie | null, authorTs: number, update: Uint8Array): Promise<Bytes | null> {
    const signing = this.account.signing
    let cert: WriterCert | null = null
    if (owner !== this.account.accountId) {
      cert = (tie ? await this.ownCert(folderRoom(tie.folder), tie.epoch) : null) ?? (await this.ownCert(room, epoch))
      if (!cert) {
        log.warn(`${room}: no certificate to write under epoch ${epoch} yet; what was written here waits`)
        return null
      }
    }
    return packSignedFrame(signing.privateKey, room, epoch, this.account.accountId, cert, authorTs, update)
  }

  /** A snapshot or starting point this account makes of a room of its own, signed as its owner. */
  packAsOwner(room: string, epoch: number, authorTs: number, update: Uint8Array): Promise<Bytes> {
    return packSignedFrame(this.account.signing.privateKey, room, epoch, this.account.accountId, null, authorTs, update)
  }

  /** This account's certificate, as a room's owner, that `account` may write there with `signingKey` in an epoch. */
  async certFor(room: string, epoch: number, account: string, signingKey: Bytes): Promise<WriterCert> {
    return { signingKey, signature: fromBase64(await signWriterCert(this.account.signing.privateKey, room, epoch, account, signingKey)) }
  }

  /** Whether a frame or snapshot read from a room's log is taken (`RoomCrypto.check`). */
  private async checkFrame(
    room: string,
    epoch: number,
    owner: string,
    tie: FolderTie | null,
    kind: 'frame' | 'snapshot',
    frame: OpenedFrame
  ): Promise<FrameVerdict> {
    const author = frame.author
    const ownerKey = this.signerPublicKey(owner)
    if (!ownerKey) return 'unknown'
    if (author === owner) return (await verifyFrame(ownerKey, room, epoch, frame)) ? 'ok' : 'forged'
    // Only the owner makes snapshots and starting points.
    const cert = frame.cert
    if (kind === 'snapshot' || !cert) return 'forged'
    const certified =
      (tie !== null && (await verifyWriterCert(ownerKey, folderRoom(tie.folder), tie.epoch, author, cert))) ||
      (await verifyWriterCert(ownerKey, room, epoch, author, cert))
    if (!certified) return 'forged'
    return (await verifyFrame(cert.signingKey, room, epoch, frame)) ? 'ok' : 'forged'
  }

  get username(): string {
    return this.account.username
  }

  get vaultId(): string {
    return this.vault.vaultId
  }

  get accountId(): string {
    return this.account.accountId
  }

  /** This account's signing key, public half. */
  get signingPublicKey(): Bytes {
    return this.account.signing.publicKey
  }

  /** A note's id in this vault: stable on every device, unguessable elsewhere. */
  docId(path: string, generation: number): Promise<string> {
    return deriveDocId(this.vault.key, path, generation)
  }

  /** An attachment's id in this vault, derived like a note's. */
  fileId(path: string, generation: number): Promise<string> {
    return deriveFileId(this.vault.key, path, generation)
  }

  /** The name of the blob holding this content, in this vault's store. */
  blobId(hash: string): Promise<string> {
    this.blobIdKey ??= vaultKeys.blobId(this.vault.key)
    return this.blobIdKey.then((key) => blobIdFor(key, hash))
  }

  /** The key of one blob of this vault. */
  blobKey(blobId: string): Promise<CryptoKey> {
    return this.cached(`blob:${blobId}`, () => vaultKeys.blob(this.vault.key, blobId))
  }

  /**
   * The same key, base64, to put into a shared note's attachment list - the
   * only place a blob key ever leaves the vault, encrypted under the note's key.
   */
  async blobKeyForShare(blobId: string): Promise<string> {
    return toBase64(await vaultKeys.blob(this.vault.key, blobId))
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

  indexCrypto(): RoomCrypto {
    const room = indexRoom(this.vault.vaultId)
    return this.ownRoomCrypto(room, (epoch) => (epoch === 0 ? this.cached(room, () => vaultKeys.index(this.vault.key)) : Promise.resolve(null)))
  }

  settingsCrypto(): RoomCrypto {
    const room = settingsRoom(this.vault.vaultId)
    return this.ownRoomCrypto(room, (epoch) => (epoch === 0 ? this.cached(room, () => vaultKeys.settings(this.vault.key)) : Promise.resolve(null)))
  }

  /** A room only this account ever reads or writes: signed by it, taken only from it. */
  private ownRoomCrypto(room: string, key: RoomCrypto['key']): RoomCrypto {
    const me = this.account.accountId
    return {
      key,
      pack: (epoch, authorTs, update) => this.packFor(room, epoch, me, null, authorTs, update),
      check: (kind, _seq, epoch, frame) => this.checkFrame(room, epoch, me, null, kind, frame)
    }
  }

  // --- notes ---------------------------------------------------------------------
  // A note's epoch has the note's own key - derived from the owner's vault key,
  // sealed to everyone else - unless the note spent it in a shared folder: then
  // the key derives from that folder epoch's key, which the folder's members
  // hold. One place decides which, for every use of a note's keys.

  /**
   * The raw key of an epoch a note already has. `owned` and `folder` as in
   * `noteCrypto`; null when this account cannot read that epoch.
   */
  async noteKey(docId: string, epoch: number, options: NoteKeyPlace = { owned: true }): Promise<Bytes | null> {
    const tie = await this.tieOf(docId, epoch, options)
    return this.noteKeyUnder(docId, epoch, tie, options.owned)
  }

  /**
   * The raw key of a note's epoch under a known tie - also for an epoch about
   * to begin, which a note in a folder takes from the folder's current epoch.
   */
  async noteKeyUnder(docId: string, epoch: number, tie: FolderTie | null, owned = true): Promise<Bytes | null> {
    if (tie) {
      const folderKey = await this.folderKey(tie.folder, tie.epoch)
      if (folderKey) return folderKeys.doc(folderKey, docId, epoch)
      // Not in that folder, yet given the note on its own: sealed like any other.
    } else if (owned) {
      return vaultKeys.doc(this.vault.key, docId, epoch)
    }
    return this.sealedKeyOf(docRoom(docId), epoch)
  }

  /** The raw key of one epoch of a note this vault owns. */
  async ownDocKey(docId: string, epoch: number): Promise<Bytes> {
    const key = await this.noteKey(docId, epoch, { owned: true })
    if (!key) throw new Error(`no key for epoch ${epoch} of ${docId}`)
    return key
  }

  /**
   * A note's keys, for the socket and everything reading its log. The socket
   * tells it which folder epoch the current epoch belongs to (`learn`) before
   * anything is sent under it, and asks again (`refresh`) when a frame does not
   * open with the key it was given.
   */
  noteCrypto(docId: string, options: NoteKeyOptions): RoomCrypto {
    const room = docRoom(docId)
    const given = options.owner
    const ownerOf = (): string => (typeof given === 'function' ? given() : given) ?? this.account.accountId
    return {
      key: async (epoch) => {
        const tie = await this.tieOf(docId, epoch, options)
        const id = `${room}#${epoch}#${tie ? `${tie.folder}.${tie.epoch}` : 'own'}`
        const existing = this.keys.get(id)
        if (existing) return existing
        const raw = await this.noteKeyUnder(docId, epoch, tie, options.owned)
        return raw ? this.cached(id, () => Promise.resolve(raw)) : null
      },
      learn: (epoch, tie) => this.learnTie(room, epoch, tie),
      refresh: async () => {
        const before = this.keyState(room)
        await this.fetchKeys(room)
        let changed = this.keyState(room) !== before
        for (const folder of new Set(Object.values(this.knownTies(room).ties).map((tie) => tie?.folder))) {
          if (folder) changed = (await this.refreshFolder(folder)) || changed
        }
        if (changed) this.forgetKeys(room)
        return changed
      },
      pack: async (epoch, authorTs, update) => this.packFor(room, epoch, ownerOf(), await this.tieOf(docId, epoch, options), authorTs, update),
      check: async (kind, _seq, epoch, frame) => {
        const verdict = await this.checkFrame(room, epoch, ownerOf(), await this.tieOf(docId, epoch, options), kind, frame)
        if (verdict !== 'forged' || !frame.cert) return verdict
        // The certificate may be the folder's, for an epoch this device has not heard was a folder's -
        // a note a writer made in the folder a moment ago: asked once before it is dropped.
        await this.fetchKeys(room)
        const tie = this.knownTies(room).ties[String(epoch)] ?? null
        return tie ? this.checkFrame(room, epoch, ownerOf(), tie, kind, frame) : verdict
      }
    }
  }

  ownDocCrypto(docId: string): RoomCrypto {
    return this.noteCrypto(docId, { owned: true, owner: null })
  }

  /** Keys of a note `owner` shared with this account: sealed to it, fetched when an epoch is missing. */
  sharedDocCrypto(docId: string, owner: string): RoomCrypto {
    return this.noteCrypto(docId, { owned: false, owner })
  }

  /**
   * Keys of a share that ended, from what the server kept for this account.
   * Nothing is fetched or stored: the room is no longer this account's to read.
   * A note of a shared folder comes with the folder's keys this account held.
   * What was kept is checked as the live note was, against its owner.
   */
  endedDocCrypto(
    docId: string,
    sealed: Record<string, string>,
    folder: { id: string; keys: Record<string, string>; epochs: Record<string, number> } | undefined,
    owner: string
  ): RoomCrypto {
    const room = docRoom(docId)
    return {
      // Nothing is written into a share that ended.
      pack: async () => null,
      check: (kind, _seq, epoch, frame) => {
        const folderEpoch = folder?.epochs[String(epoch)]
        const tie = folder && folderEpoch !== undefined ? { folder: folder.id, epoch: folderEpoch } : null
        return this.checkFrame(room, epoch, owner, tie, kind, frame)
      },
      key: async (epoch) => {
        const folderEpoch = folder?.epochs[String(epoch)]
        const sealedFolderKey = folderEpoch === undefined ? undefined : folder?.keys[String(folderEpoch)]
        if (folder && folderEpoch !== undefined && sealedFolderKey) {
          const folderKey = await this.openSealed(folderRoom(folder.id), folderEpoch, sealedFolderKey)
          return folderKey ? aesKey(await folderKeys.doc(folderKey, docId, epoch)) : null
        }
        const known = sealed[String(epoch)] ?? this.sealed(room)[String(epoch)]
        if (!known) return null
        const raw = await this.openSealed(room, epoch, known)
        return raw ? aesKey(raw) : null
      }
    }
  }

  // --- shared folders ------------------------------------------------------------

  /** A shared folder's id in this vault, derived like a note's. */
  folderId(path: string, generation: number): Promise<string> {
    return deriveFolderId(this.vault.key, path, generation)
  }

  /**
   * The raw key of a folder epoch: derived for a folder of this vault's,
   * sealed to this account for someone else's. Null when it never got it.
   */
  folderKey(folderId: string, epoch: number): Promise<Bytes | null> {
    const id = `${folderId}#${epoch}`
    let key = this.folderKeyCache.get(id)
    if (!key) {
      key = this.makeFolderKey(folderId, epoch)
      this.folderKeyCache.set(id, key)
      // Not got yet is not never: asked again next time.
      void key.then((found) => {
        if (!found) this.folderKeyCache.delete(id)
      }, () => this.folderKeyCache.delete(id))
    }
    return key
  }

  private async makeFolderKey(folderId: string, epoch: number): Promise<Bytes | null> {
    if (this.ownsFolder(folderId)) return vaultKeys.folder(this.vault.key, folderId, epoch)
    return this.sealedKeyOf(folderRoom(folderId), epoch)
  }

  /** What this device knows of a room's keys: the folder epochs its epochs belong to, and the keys sealed to it. */
  private keyState(room: string): string {
    return JSON.stringify([this.knownTies(room).ties, this.sealed(room)])
  }

  /** Lets go of the keys opened or derived for a room: its owner sealed them anew - after replacing its own. */
  private forgetKeys(room: string): void {
    for (const id of Array.from(this.keys.keys())) if (id.startsWith(`${room}#`)) this.keys.delete(id)
  }

  /** A folder's keys asked for again; true when they changed, and what was derived from them is let go of. */
  private async refreshFolder(folderId: string): Promise<boolean> {
    const room = folderRoom(folderId)
    const before = this.keyState(room)
    await this.fetchKeys(room)
    if (this.keyState(room) === before) return false
    for (const id of Array.from(this.folderKeyCache.keys())) if (id.startsWith(`${folderId}#`)) this.folderKeyCache.delete(id)
    this.forgetKeys(room)
    // Every note's key in the folder derives from its keys.
    for (const id of Array.from(this.keys.keys())) if (id.includes(`#${folderId}.`)) this.keys.delete(id)
    return true
  }

  /** The folder room's own keys; its frames signed and checked against `owner` (null: this account). */
  folderRoomCrypto(folderId: string, owner: string | null): RoomCrypto {
    const room = folderRoom(folderId)
    const ownerId = owner ?? this.account.accountId
    return {
      refresh: () => this.refreshFolder(folderId),
      key: async (epoch) => {
        const id = `${room}#${epoch}`
        const existing = this.keys.get(id)
        if (existing) return existing
        const folderKey = await this.folderKey(folderId, epoch)
        return folderKey ? this.cached(id, () => folderKeys.room(folderKey)) : null
      },
      pack: (epoch, authorTs, update) => this.packFor(room, epoch, ownerId, null, authorTs, update),
      check: (kind, _seq, epoch, frame) => this.checkFrame(room, epoch, ownerId, null, kind, frame)
    }
  }

  /** The key ids of notes and files created in the folder are derived under, in a folder epoch. */
  async folderIdKey(folderId: string, epoch: number): Promise<Bytes | null> {
    const folderKey = await this.folderKey(folderId, epoch)
    return folderKey ? folderKeys.ids(folderKey) : null
  }

  /** A folder epoch's key sealed for someone it is shared with, signed. */
  async sealFolderKeys(folderId: string, epochs: number[], recipient: Recipient): Promise<Record<string, string>> {
    const room = folderRoom(folderId)
    const sealed: Record<string, string> = {}
    for (const epoch of epochs) {
      const key = await this.folderKey(folderId, epoch)
      if (!key) throw new Error(`no key for epoch ${epoch} of the folder`)
      sealed[String(epoch)] = await this.sealFor(room, epoch, recipient, key)
    }
    return sealed
  }

  // --- ties ----------------------------------------------------------------------

  private knownTies(room: string): KnownTies {
    let known = this.tiesByRoom.get(room)
    if (!known) {
      known = { ties: {}, upTo: -1 }
      try {
        const saved = JSON.parse(this.secrets.load(`${TIES_PREFIX}${room}`) ?? 'null') as KnownTies | null
        if (saved && typeof saved.upTo === 'number' && saved.ties) known = saved
      } catch {
        // Asked again when needed.
      }
      this.tiesByRoom.set(room, known)
    }
    return known
  }

  private saveTies(room: string, known: KnownTies): void {
    this.tiesByRoom.set(room, known)
    // A note never in a folder keeps nothing on the device.
    if (Object.values(known.ties).some((tie) => tie !== null)) this.secrets.save(`${TIES_PREFIX}${room}`, JSON.stringify(known))
  }

  /**
   * Takes what the server said about the epoch it is in: a tie that goes
   * backwards is refused (`tiesAscend`) - it would have this device encrypt
   * under a key someone revoked still holds.
   */
  private learnTie(room: string, epoch: number, tie: FolderTie | null): void {
    const known = this.knownTies(room)
    const current = known.ties[String(epoch)]
    if (current === tie || (current && tie && current.folder === tie.folder && current.epoch === tie.epoch)) return
    const ties = { ...known.ties, [String(epoch)]: tie }
    if (!tiesAscend(Object.fromEntries(Object.entries(ties).filter(([, value]) => value !== null)) as Record<string, FolderTie>)) {
      log.error(`${room}: the server tied epoch ${epoch} to an earlier folder epoch; refused`)
      return
    }
    this.saveTies(room, { ties, upTo: known.upTo })
  }

  /** Which folder epoch a note's epoch belongs to, if any - asked of the server when it matters and is unknown. */
  private async tieOf(docId: string, epoch: number, options: NoteKeyPlace): Promise<FolderTie | null> {
    const room = docRoom(docId)
    const known = this.knownTies(room)
    const tie = known.ties[String(epoch)]
    if (tie !== undefined) return tie
    if (epoch <= known.upTo) return null
    // A note of this vault's never seen in a folder: its own key, and the
    // server is asked only if that does not fit (`refresh`) - not once for
    // every note of the vault.
    if (options.owned && !options.folder) return null
    await this.fetchKeys(room)
    return this.knownTies(room).ties[String(epoch)] ?? null
  }

  private async fetchKeys(room: string): Promise<KeysResponse | null> {
    try {
      const response = await this.api.keys(room)
      const merged = { ...this.sealed(room), ...response.keys }
      this.sealedByRoom.set(room, merged)
      if (Object.keys(response.keys).length > 0) this.secrets.save(`${SEALED_PREFIX}${room}`, JSON.stringify(merged))
      if (!tiesAscend(response.ties ?? {})) {
        log.error(`${room}: the server's folder epochs go backwards; refused`)
        return response
      }
      // The server's word for every epoch up to its current one; a tie
      // announced since, for a later epoch, stays.
      const known = this.knownTies(room)
      const later = Object.entries(known.ties).filter(([epoch]) => Number(epoch) > response.epoch)
      const ties: Record<string, FolderTie | null> = { ...Object.fromEntries(later), ...(response.ties ?? {}) }
      this.saveTies(room, { ties, upTo: Math.max(known.upTo, response.epoch) })
      return response
    } catch (error) {
      log.warn(`fetching the keys of ${room} failed`, error)
      return null
    }
  }

  private sealed(room: string): Record<string, string> {
    let known = this.sealedByRoom.get(room)
    if (!known) {
      try {
        known = JSON.parse(this.secrets.load(`${SEALED_PREFIX}${room}`) ?? '{}') as Record<string, string>
      } catch {
        known = {}
      }
      this.sealedByRoom.set(room, known)
    }
    return known
  }

  private async fetchSealed(room: string): Promise<Record<string, string>> {
    await this.fetchKeys(room)
    return this.sealed(room)
  }

  /** Forgets what this device knows about a note it no longer has access to. */
  forgetShared(docId: string): void {
    const room = docRoom(docId)
    this.sealedByRoom.delete(room)
    this.secrets.save(`${SEALED_PREFIX}${room}`, null)
    this.tiesByRoom.delete(room)
    this.secrets.save(`${TIES_PREFIX}${room}`, null)
    for (const id of Array.from(this.keys.keys())) if (id.startsWith(`${room}#`)) this.keys.delete(id)
  }

  /**
   * Epoch keys of an owned note, sealed for someone it is shared with. `next`:
   * an epoch about to begin, with the folder epoch it will belong to - the
   * server does not know it yet.
   */
  async sealEpochKeys(
    docId: string,
    epochs: number[],
    recipient: Recipient,
    next?: { epoch: number; tie: FolderTie | null }
  ): Promise<Record<string, string>> {
    const room = docRoom(docId)
    const sealed: Record<string, string> = {}
    for (const epoch of epochs) {
      const key =
        next && epoch === next.epoch
          ? await this.noteKeyUnder(docId, epoch, next.tie)
          : await this.noteKey(docId, epoch, { owned: true, folder: true })
      if (!key) throw new Error(`no key for epoch ${epoch} of ${docId}`)
      sealed[String(epoch)] = await this.sealFor(room, epoch, recipient, key)
    }
    return sealed
  }

  sealTitle(docId: string, title: string, recipientPublicKey: Bytes): Promise<string> {
    return seal(recipientPublicKey, utf8(title), titleContext(docId))
  }

  async openTitle(docId: string, sealed: string): Promise<string> {
    try {
      return fromUtf8(await unseal(this.account.privateKey, this.account.publicKey, sealed, titleContext(docId)))
    } catch {
      return ''
    }
  }

  static publicKey(encoded: string): Bytes {
    return fromBase64(encoded)
  }
}
