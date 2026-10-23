import { docRoom, folderRoom, indexRoom, settingsRoom, tiesAscend, type FolderTie, type KeysResponse } from '@obsidian-connect/shared'
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
  seal,
  titleContext,
  toBase64,
  unseal,
  utf8,
  vaultKeys,
  type Bytes
} from '@obsidian-connect/shared/crypto'
import type { RoomCrypto } from '../sync/VaultSocket.js'
import type { ConnectApi } from './api.js'
import type { OpenVault, SecretStore, Unlocked } from './Session.js'
import { log } from '../log.js'

const SEALED_PREFIX = 'obsidian-connect:sealed:'
const TIES_PREFIX = 'obsidian-connect:ties:'

/**
 * Which of a note's epochs it spent in a shared folder, and with which folder
 * epoch: those keys derive from the folder's. Every epoch up to `upTo` that is
 * not named is the note's own; a null entry is one known to be its own.
 */
interface KnownTies {
  ties: Record<string, FolderTie | null>
  upTo: number
}

/** How a note's keys are found. */
export interface NoteKeyOptions {
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

  get username(): string {
    return this.account.username
  }

  get vaultId(): string {
    return this.vault.vaultId
  }

  get accountId(): string {
    return this.account.accountId
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
    return { key: (epoch) => (epoch === 0 ? this.cached(room, () => vaultKeys.index(this.vault.key)) : Promise.resolve(null)) }
  }

  settingsCrypto(): RoomCrypto {
    const room = settingsRoom(this.vault.vaultId)
    return { key: (epoch) => (epoch === 0 ? this.cached(room, () => vaultKeys.settings(this.vault.key)) : Promise.resolve(null)) }
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
  async noteKey(docId: string, epoch: number, options: NoteKeyOptions = { owned: true }): Promise<Bytes | null> {
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
    const room = docRoom(docId)
    let sealed = this.sealed(room)[String(epoch)]
    if (!sealed) sealed = (await this.fetchSealed(room))[String(epoch)]
    if (!sealed) return null
    return unseal(this.account.privateKey, this.account.publicKey, sealed, epochKeyContext(room, epoch))
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
        const before = JSON.stringify(this.knownTies(room).ties)
        await this.fetchKeys(room)
        return JSON.stringify(this.knownTies(room).ties) !== before
      }
    }
  }

  ownDocCrypto(docId: string): RoomCrypto {
    return this.noteCrypto(docId, { owned: true })
  }

  /** Keys of a note someone else owns: sealed to this account, fetched when an epoch is missing. */
  sharedDocCrypto(docId: string): RoomCrypto {
    return this.noteCrypto(docId, { owned: false })
  }

  /**
   * Keys of a share that ended, from what the server kept for this account.
   * Nothing is fetched or stored: the room is no longer this account's to read.
   * A note of a shared folder comes with the folder's keys this account held.
   */
  endedDocCrypto(docId: string, sealed: Record<string, string>, folder?: { id: string; keys: Record<string, string>; epochs: Record<string, number> }): RoomCrypto {
    const room = docRoom(docId)
    return {
      key: async (epoch) => {
        const folderEpoch = folder?.epochs[String(epoch)]
        const sealedFolderKey = folderEpoch === undefined ? undefined : folder?.keys[String(folderEpoch)]
        if (folder && folderEpoch !== undefined && sealedFolderKey) {
          const folderKey = await unseal(
            this.account.privateKey,
            this.account.publicKey,
            sealedFolderKey,
            epochKeyContext(folderRoom(folder.id), folderEpoch)
          )
          return aesKey(await folderKeys.doc(folderKey, docId, epoch))
        }
        const known = sealed[String(epoch)] ?? this.sealed(room)[String(epoch)]
        if (!known) return null
        return aesKey(await unseal(this.account.privateKey, this.account.publicKey, known, epochKeyContext(room, epoch)))
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
    const room = folderRoom(folderId)
    let sealed = this.sealed(room)[String(epoch)]
    if (!sealed) sealed = (await this.fetchSealed(room))[String(epoch)]
    if (!sealed) return null
    return unseal(this.account.privateKey, this.account.publicKey, sealed, epochKeyContext(room, epoch))
  }

  /** The folder room's own keys. */
  folderRoomCrypto(folderId: string): RoomCrypto {
    const room = folderRoom(folderId)
    return {
      key: async (epoch) => {
        const id = `${room}#${epoch}`
        const existing = this.keys.get(id)
        if (existing) return existing
        const folderKey = await this.folderKey(folderId, epoch)
        return folderKey ? this.cached(id, () => folderKeys.room(folderKey)) : null
      }
    }
  }

  /** The key ids of notes and files created in the folder are derived under, in a folder epoch. */
  async folderIdKey(folderId: string, epoch: number): Promise<Bytes | null> {
    const folderKey = await this.folderKey(folderId, epoch)
    return folderKey ? folderKeys.ids(folderKey) : null
  }

  /** A folder epoch's key sealed for someone it is shared with. */
  async sealFolderKeys(folderId: string, epochs: number[], recipientPublicKey: Bytes): Promise<Record<string, string>> {
    const room = folderRoom(folderId)
    const sealed: Record<string, string> = {}
    for (const epoch of epochs) {
      const key = await this.folderKey(folderId, epoch)
      if (!key) throw new Error(`no key for epoch ${epoch} of the folder`)
      sealed[String(epoch)] = await seal(recipientPublicKey, key, epochKeyContext(room, epoch))
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
  private async tieOf(docId: string, epoch: number, options: NoteKeyOptions): Promise<FolderTie | null> {
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
    recipientPublicKey: Bytes,
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
      sealed[String(epoch)] = await seal(recipientPublicKey, key, epochKeyContext(room, epoch))
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
