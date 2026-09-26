import { Notice, type TFile } from 'obsidian'
import * as Y from 'yjs'
import {
  docRoom,
  frameAad,
  roomSubject,
  snapshotAad,
  type IncomingShare,
  type NotifyKind,
  type ShareMembersResponse,
  type ShareNotice,
  type ShareRole
} from '@obsidian-connect/shared'
import {
  aesKey,
  decrypt,
  encrypt,
  fromBase64,
  packFrame,
  toBase64,
  type Bytes
} from '@obsidian-connect/shared/crypto'
import { ApiError, type ConnectApi } from '../account/api.js'
import type { KeyRing } from '../account/KeyRing.js'
import type { DocStore } from '../sync/DocStore.js'
import type { Contacts } from './Contacts.js'

// Sharing a note with a person, and everything that follows from it: the
// keys they get, the epoch that moves when someone loses access, and what
// happens to a copy when a share ends.

export interface SharingOptions {
  /** Where accepted shares land. */
  folder: () => string
  syncTimeoutMs: number
  /** Accept incoming shares into this vault without asking - true when the account has one vault. */
  autoAccept: () => boolean
}

const STALE_RETRIES = 5
const STALE_WAIT_MS = 300

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function titleOf(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/, '') || 'Shared note'
}

export class Sharing {
  /** A revocation arrives as a message and as a notice; one of them handles it. */
  private readonly revoking = new Set<string>()

  constructor(
    private readonly api: ConnectApi,
    private readonly keys: KeyRing,
    private readonly store: DocStore,
    private readonly options: SharingOptions,
    private readonly contacts: Contacts | null = null
  ) {}

  /** What this account calls someone. */
  nameOf(account: string): string {
    return this.contacts?.name(account) ?? account.slice(0, 8)
  }

  members(docId: string): Promise<ShareMembersResponse> {
    return this.api.members(docId)
  }

  /**
   * The key pinned when the contact was made. Only someone who is a member
   * without being a contact - which sharing does not allow - falls back to
   * what the server says, so a rotation can still seal for everyone who stays.
   */
  private async publicKey(account: string): Promise<Bytes> {
    const pinned = this.contacts?.publicKey(account)
    if (pinned) return pinned
    console.warn(`[obsidian-connect] ${account} is not a contact; using the key the server has for them`)
    return fromBase64((await this.api.accountKey(account)).publicKey)
  }

  /**
   * Ends everything shared with someone, before the contact goes: their
   * access to this account's notes, and this account's copies of theirs, kept
   * as notes of its own.
   */
  async endWith(account: string): Promise<void> {
    for (const { docId, entry } of this.store.sharedEntries()) {
      try {
        if (entry.owner === account) {
          await this.detach(docId)
        } else if (!entry.owner) {
          const { members } = await this.api.members(docId)
          if (members.some((member) => member.account === account)) await this.revoke(docId, account)
        }
      } catch (error) {
        console.error(`[obsidian-connect] ending the share of ${docId} failed`, error)
      }
    }
  }

  /**
   * Shares a note of this vault. With history the person gets every epoch
   * key; without, the note moves to a new epoch and they get that key and a
   * snapshot of the note as it is now - the frames before it are deltas they
   * could not read anyway.
   */
  async share(docId: string, account: string, role: ShareRole, withHistory: boolean): Promise<void> {
    const entry = this.store.entry(docId)
    if (!entry || entry.deletedAt) throw new Error('This note is not synced yet.')
    if (entry.owner) throw new Error(`Only ${this.nameOf(entry.owner)} can share this note.`)
    if (this.contacts && !this.contacts.isContact(account)) {
      throw new Error('Notes are shared with contacts only. Add them under Settings → Obsidian Connect → Contacts first.')
    }
    const recipientKey = await this.publicKey(account)
    const handle = await this.store.handle(docId)
    // Without the room's current state there is nothing to hand over, and
    // without it on the server there is no room to share yet.
    if (!(await handle.whenRemoteReady(this.options.syncTimeoutMs))) throw new Error('The server is not reachable.')
    const title = await this.keys.sealTitle(docId, titleOf(entry.path), recipientKey)
    const room = docRoom(docId)

    for (let attempt = 0; ; attempt += 1) {
      const members = await this.api.members(docId)
      try {
        if (withHistory) {
          const epochs = Array.from({ length: members.epoch + 1 }, (_value, index) => index)
          await this.api.share({
            docId,
            account,
            role,
            withHistory: true,
            keys: await this.keys.sealEpochKeys(docId, epochs, recipientKey),
            title
          })
        } else {
          const epoch = members.epoch + 1
          const rotationKeys: Record<string, string> = {}
          rotationKeys[account] = (await this.keys.sealEpochKeys(docId, [epoch], recipientKey))[String(epoch)] as string
          for (const member of members.members) {
            if (member.account === account) continue
            const sealed = await this.keys.sealEpochKeys(docId, [epoch], await this.publicKey(member.account))
            rotationKeys[member.account] = sealed[String(epoch)] as string
          }
          // The note as far as the server's log goes. The server refuses it
          // when frames arrived meanwhile, and the loop tries again once they
          // are in.
          const key = await aesKey(await this.keys.ownDocKey(docId, epoch))
          const state = packFrame(Date.now(), Y.encodeStateAsUpdate(handle.doc))
          const snapshot = await encrypt(key, state, snapshotAad(room, epoch))
          await this.api.share({
            docId,
            account,
            role,
            withHistory: false,
            keys: {},
            title,
            rotation: { epoch, keys: rotationKeys, snapshot: { uptoSeq: handle.lastSeq, data: toBase64(snapshot) } }
          })
        }
        break
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && attempt < STALE_RETRIES) {
          await delay(STALE_WAIT_MS)
          continue
        }
        throw error
      }
    }
    this.store.share(docId, true)
  }

  /** Takes access away and moves the note to an epoch the person never gets. */
  async revoke(docId: string, account: string): Promise<void> {
    const members = await this.api.members(docId)
    const epoch = members.epoch + 1
    const keys: Record<string, string> = {}
    for (const member of members.members) {
      if (member.account === account) continue
      const sealed = await this.keys.sealEpochKeys(docId, [epoch], await this.publicKey(member.account))
      keys[member.account] = sealed[String(epoch)] as string
    }
    await this.api.revoke({ docId, account, rotation: { epoch, keys } })
    // Nobody left to see a caret.
    if (Object.keys(keys).length === 0) this.store.share(docId, false)
  }

  async setRole(docId: string, account: string, role: ShareRole): Promise<void> {
    await this.api.setRole({ docId, account, role })
  }

  async incoming(): Promise<IncomingShare[]> {
    return (await this.api.incoming()).shares
  }

  /** Adds a note someone shared into this vault. */
  async accept(share: IncomingShare): Promise<TFile | null> {
    const title = (await this.keys.openTitle(share.docId, share.title)) || 'Shared note'
    const file = await this.store.acceptShare(
      { docId: share.docId, owner: share.owner, role: share.role, title },
      this.options.folder()
    )
    if (!file) return null
    await this.api.accept({ docId: share.docId, vaultId: this.keys.vaultId })
    new Notice(
      `${share.owner} shared "${title}" with you${share.role === 'read' ? ' to read' : ''}. It is in ${file.path}.`,
      10_000
    )
    return file
  }

  /** Accepts everything waiting, if this vault may do so without asking. Returns how many are still waiting. */
  async checkIncoming(): Promise<number> {
    const waiting = await this.incoming()
    if (!this.options.autoAccept()) return waiting.length
    for (const share of waiting) {
      try {
        await this.accept(share)
      } catch (error) {
        console.error(`[obsidian-connect] accepting ${share.docId} failed`, error)
      }
    }
    return 0
  }

  async onNotify(kind: NotifyKind, notice: ShareNotice): Promise<void> {
    switch (kind) {
      case 'share-added': {
        const waiting = await this.checkIncoming()
        if (waiting > 0) {
          new Notice(`${notice.owner} shared a note with you. Run "Notes shared with me" to add it to this vault.`, 10_000)
        }
        return
      }
      case 'share-changed':
        if (notice.role && this.store.entry(notice.docId)?.owner) {
          this.store.setShareRole(notice.docId, notice.role)
          new Notice(`${notice.owner} changed your access to a shared note: you can now ${notice.role === 'read' ? 'only read' : 'edit'} it.`)
        }
        return
      case 'share-removed':
        await this.onRevoked(docRoom(notice.docId))
        return
    }
  }

  /** The owner took access away. The copy stays, as a note of this vault's own. */
  async onRevoked(room: string): Promise<void> {
    const docId = roomSubject(room)
    const entry = this.store.entry(docId)
    if (!entry?.owner || entry.deletedAt || this.revoking.has(docId)) return
    this.revoking.add(docId)
    try {
      this.keys.forgetShared(docId)
      const file = await this.store.rekeyToOwn(docId)
      new Notice(
        `${this.nameOf(entry.owner)} stopped sharing "${titleOf(entry.path)}" with you.${file ? ' Your copy is kept as a note of your own.' : ''}`,
        12_000
      )
    } finally {
      this.revoking.delete(docId)
    }
  }

  /** This account leaves a share by deleting its copy. */
  async leave(docId: string): Promise<void> {
    this.keys.forgetShared(docId)
    try {
      await this.api.leave(docId)
    } catch (error) {
      console.error(`[obsidian-connect] leaving the share of ${docId} failed`, error)
    }
  }

  /**
   * Turns a note someone shared into one of this vault's own, with a new id
   * and everything of its history this account may read.
   */
  async detach(docId: string): Promise<TFile | null> {
    const entry = this.store.entry(docId)
    if (!entry?.owner) throw new Error('This note is already yours.')
    const newDocId = await this.store.nextDocId(entry.path)
    try {
      await this.copyHistory(docId, newDocId)
    } catch (error) {
      // A copy without its history is still a copy.
      console.warn(`[obsidian-connect] the history of ${entry.path} could not be copied`, error)
    }
    const file = await this.store.rekeyToOwn(docId, newDocId)
    await this.leave(docId)
    return file
  }

  private async copyHistory(fromDocId: string, toDocId: string): Promise<void> {
    const fromRoom = docRoom(fromDocId)
    const toRoom = docRoom(toDocId)
    const log = await this.api.log(fromRoom)
    const source = this.keys.sharedDocCrypto(fromDocId)
    const target = await aesKey(await this.keys.ownDocKey(toDocId, 0))
    const frames: Array<{ epoch: number; data: string }> = []
    if (log.snapshot) {
      const key = await source.key(log.snapshot.epoch)
      if (key) {
        const plaintext = await decrypt(key, fromBase64(log.snapshot.data), snapshotAad(fromRoom, log.snapshot.epoch))
        frames.push({ epoch: 0, data: toBase64(await encrypt(target, plaintext, frameAad(toRoom, 0))) })
      }
    }
    for (const frame of log.frames) {
      const key = await source.key(frame.epoch)
      if (!key) continue
      const plaintext = await decrypt(key, fromBase64(frame.data), frameAad(fromRoom, frame.epoch))
      frames.push({ epoch: 0, data: toBase64(await encrypt(target, plaintext, frameAad(toRoom, 0))) })
    }
    if (frames.length > 0) await this.api.importFrames(toRoom, this.keys.vaultId, { frames })
  }
}
