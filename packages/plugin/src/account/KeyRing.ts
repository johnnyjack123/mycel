import { docRoom, indexRoom, settingsRoom } from '@obsidian-connect/shared'
import {
  aesKey,
  deriveDocId,
  epochKeyContext,
  fromBase64,
  fromUtf8,
  seal,
  titleContext,
  unseal,
  utf8,
  vaultKeys,
  type Bytes
} from '@obsidian-connect/shared/crypto'
import type { RoomCrypto } from '../sync/VaultSocket.js'
import type { ConnectApi } from './api.js'
import type { OpenVault, SecretStore, Unlocked } from './Session.js'

const SEALED_PREFIX = 'obsidian-connect:sealed:'

/**
 * Every key this vault uses. The owner's keys are derived from the vault key
 * and never stored; keys of notes other people shared arrive sealed to this
 * account and are kept sealed on the device, so they work offline.
 */
export class KeyRing {
  private readonly keys = new Map<string, Promise<CryptoKey>>()
  private readonly sealedByRoom = new Map<string, Record<string, string>>()

  constructor(
    private readonly vault: OpenVault,
    private readonly account: Unlocked,
    private readonly api: ConnectApi,
    private readonly secrets: SecretStore
  ) {}

  get username(): string {
    return this.account.username
  }

  get vaultId(): string {
    return this.vault.vaultId
  }

  /** A note's id in this vault: stable on every device, unguessable elsewhere. */
  docId(path: string, generation: number): Promise<string> {
    return deriveDocId(this.vault.key, path, generation)
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

  /** The raw key of one epoch of a note this vault owns. */
  ownDocKey(docId: string, epoch: number): Promise<Bytes> {
    return vaultKeys.doc(this.vault.key, docId, epoch)
  }

  ownDocCrypto(docId: string): RoomCrypto {
    const room = docRoom(docId)
    return { key: (epoch) => this.cached(`${room}#${epoch}`, () => this.ownDocKey(docId, epoch)) }
  }

  /** Keys of a note someone else owns: sealed to this account, fetched when an epoch is missing. */
  sharedDocCrypto(docId: string): RoomCrypto {
    const room = docRoom(docId)
    return {
      key: async (epoch) => {
        const id = `${room}#${epoch}`
        const existing = this.keys.get(id)
        if (existing) return existing
        let sealed = this.sealed(room)[String(epoch)]
        if (!sealed) sealed = (await this.fetchSealed(room))[String(epoch)]
        if (!sealed) return null
        const opened = sealed
        return this.cached(id, () =>
          unseal(this.account.privateKey, this.account.publicKey, opened, epochKeyContext(room, epoch))
        )
      }
    }
  }

  /**
   * Keys of a share that ended, from what the server kept for this account.
   * Nothing is fetched or stored: the room is no longer this account's to read.
   */
  endedDocCrypto(docId: string, sealed: Record<string, string>): RoomCrypto {
    const room = docRoom(docId)
    return {
      key: async (epoch) => {
        const known = sealed[String(epoch)] ?? this.sealed(room)[String(epoch)]
        if (!known) return null
        return aesKey(await unseal(this.account.privateKey, this.account.publicKey, known, epochKeyContext(room, epoch)))
      }
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
    try {
      const response = await this.api.keys(room)
      const merged = { ...this.sealed(room), ...response.keys }
      this.sealedByRoom.set(room, merged)
      this.secrets.save(`${SEALED_PREFIX}${room}`, JSON.stringify(merged))
      return merged
    } catch (error) {
      console.warn(`[obsidian-connect] fetching the keys of ${room} failed`, error)
      return this.sealed(room)
    }
  }

  /** Forgets what this device knows about a note it no longer has access to. */
  forgetShared(docId: string): void {
    const room = docRoom(docId)
    this.sealedByRoom.delete(room)
    this.secrets.save(`${SEALED_PREFIX}${room}`, null)
    for (const id of Array.from(this.keys.keys())) if (id.startsWith(`${room}#`)) this.keys.delete(id)
  }

  /** Epoch keys of an owned note, sealed for someone it is shared with. */
  async sealEpochKeys(docId: string, epochs: number[], recipientPublicKey: Bytes): Promise<Record<string, string>> {
    const room = docRoom(docId)
    const sealed: Record<string, string> = {}
    for (const epoch of epochs) {
      sealed[String(epoch)] = await seal(recipientPublicKey, await this.ownDocKey(docId, epoch), epochKeyContext(room, epoch))
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
