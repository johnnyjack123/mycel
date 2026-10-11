import { Notice, type TFile } from 'obsidian'
import * as Y from 'yjs'
import {
  NOTE_SHARE_FIELD,
  docRoom,
  frameAad,
  roomSubject,
  snapshotAad,
  type ForkResponse,
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
  unpackFrame,
  type Bytes
} from '@obsidian-connect/shared/crypto'
import { ApiError, type ConnectApi } from '../account/api.js'
import type { KeyRing } from '../account/KeyRing.js'
import type { DocStore } from '../sync/DocStore.js'
import { entryKey, type HistoryEntry } from '../sync/History.js'
import type { Contacts } from './Contacts.js'
import { setAttachmentsShared } from './SharedFiles.js'
import { log } from '../log.js'

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
  /** The end of a share arrives as a message, a notice and a detach; one of them carries it out. */
  private readonly ending = new Map<string, Promise<TFile | null>>()

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
    log.warn(`${account} is not a contact; using the key the server has for them`)
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
        log.error(`ending the share of ${docId} failed`, error)
      }
    }
  }

  /**
   * Shares a note of this vault. With history the person gets every epoch
   * key; without, the note moves to a new epoch and they get that key and a
   * snapshot of the note as it is now - the frames before it are deltas they
   * could not read anyway.
   */
  /**
   * Whether the files the note embeds or links travel with it - the owner's
   * choice, per note: everyone in it reads the same document. Null while it
   * was never chosen.
   */
  async attachmentsShared(docId: string): Promise<boolean | null> {
    const handle = await this.store.handle(docId)
    if (!(await handle.whenRemoteReady(this.options.syncTimeoutMs))) return null
    const value = handle.doc.getMap(NOTE_SHARE_FIELD).get('attachments')
    return typeof value === 'boolean' ? value : null
  }

  async setAttachmentsShared(docId: string, shared: boolean): Promise<void> {
    const entry = this.store.entry(docId)
    if (!entry || entry.owner) throw new Error('Only the owner of a note decides whether its files go along.')
    const handle = await this.store.handle(docId)
    // Never into a document whose state is unknown, nor into one never written:
    // the file of a pristine note could no longer be seeded (invariant 18).
    if (!(await handle.whenRemoteReady(this.options.syncTimeoutMs)) || handle.pristine) {
      throw new Error('The server is not reachable.')
    }
    setAttachmentsShared(handle.doc, shared)
    log.info(`${entry.path}: its files ${shared ? 'go along with it' : 'no longer go along with it'}`)
  }

  async share(docId: string, account: string, role: ShareRole, withHistory: boolean, withAttachments?: boolean): Promise<void> {
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
    if (withAttachments !== undefined && !handle.pristine) setAttachmentsShared(handle.doc, withAttachments)
    log.info(
      `${entry.path}: shared with ${account} to ${role}, ${withHistory ? 'with' : 'without'} history${withAttachments ? ', with its files' : ''}`
    )
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
    log.info(`${this.store.entry(docId)?.path ?? docId}: access of ${account} revoked, now epoch ${epoch}`)
    // Nobody left to see a caret.
    if (Object.keys(keys).length === 0) this.store.share(docId, false)
  }

  /** Someone left a note of this account's: it is shared only while anyone else is still in it. */
  async refreshShared(docId: string): Promise<void> {
    const { members } = await this.api.members(docId)
    if (members.length === 0 && this.store.isShared(docId)) {
      this.store.share(docId, false)
      log.info(`${this.store.entry(docId)?.path ?? docId}: nobody else has it any more; no longer shared`)
    }
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
    log.info(`${file.path}: shared by ${share.owner} to ${share.role}, added`)
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
        log.error(`accepting ${share.docId} failed`, error)
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
      case 'share-changed': {
        const entry = this.store.entry(notice.docId)
        if (notice.role && entry?.owner) {
          this.store.setShareRole(notice.docId, notice.role)
          new Notice(`${notice.owner} changed your access to a shared note: you can now ${notice.role === 'read' ? 'only read' : 'edit'} it.`)
        } else if (entry && !entry.owner && !entry.deletedAt) {
          await this.refreshShared(notice.docId)
        }
        return
      }
      case 'share-removed':
        await this.onRevoked(docRoom(notice.docId))
        return
    }
  }

  /** The server says a share ended - revoked, detached on another device, or its owner's account removed. */
  async onRevoked(room: string): Promise<void> {
    const docId = roomSubject(room)
    const entry = this.store.entry(docId)
    if (!entry?.owner || entry.deletedAt) return
    const file = await this.endShare(docId)
    new Notice(
      `The share of "${titleOf(entry.path)}" with ${this.nameOf(entry.owner)} ended.${file ? ' Your copy is kept as a note of your own, with its history.' : ''}`,
      12_000
    )
  }

  /** This account leaves a share by deleting its copy. */
  async leave(docId: string): Promise<void> {
    this.keys.forgetShared(docId)
    try {
      await this.api.leave(docId)
    } catch (error) {
      log.error(`leaving the share of ${docId} failed`, error)
    }
  }

  /** Leaves a share but keeps the note, as one of this vault's own with the history this account could read. */
  async detach(docId: string): Promise<TFile | null> {
    const entry = this.store.entry(docId)
    if (!entry?.owner) throw new Error('This note is already yours.')
    await this.api.detach(docId)
    return this.endShare(docId)
  }

  /**
   * Shares that ended while this device was away. A fork another device of
   * this account made but could not report is reported here.
   */
  async checkEnded(): Promise<number> {
    const { forks } = await this.api.forks()
    let forked = 0
    for (const fork of forks) {
      const entry = this.store.entry(fork.docId)
      try {
        if (entry?.deletedAt && entry.forkedTo) await this.api.forkDone(fork.docId, entry.forkedTo)
        else if (entry?.owner && (await this.endShare(fork.docId))) forked += 1
      } catch (error) {
        log.error(`carrying on the ended share of ${fork.docId} failed`, error)
      }
    }
    return forked
  }

  /**
   * The share of a note someone else owns ended. The note carries on as one
   * of this vault's own, at the same path: with every change this account
   * could read - what the server kept, and what this device kept itself - and
   * whatever this device had not sent yet. A second device of the account
   * finds the first one's note and adds what it held to it.
   */
  endShare(docId: string): Promise<TFile | null> {
    const running = this.ending.get(docId)
    if (running) return running
    const ending = this.carryOn(docId).finally(() => this.ending.delete(docId))
    this.ending.set(docId, ending)
    return ending
  }

  private async carryOn(docId: string): Promise<TFile | null> {
    const entry = this.store.entry(docId)
    if (!entry?.owner || entry.deletedAt) return null
    let kept: ForkResponse | null = null
    try {
      kept = await this.api.fork(docId)
    } catch (error) {
      // Nothing kept - the note was never accepted, or the server predates
      // this. What this device holds is all there is. Unreachable is another
      // matter: the kept history may still come, so the fork waits for it.
      if (!(error instanceof ApiError) || error.status !== 404) throw error
    }
    const target = kept?.forkedTo ?? (await this.store.nextDocId(entry.path))
    log.info(
      `${entry.path}: share with ${entry.owner} ended (${kept?.reason ?? 'nothing kept on the server'})${kept?.forkedTo ? ', another device forked it already' : `, ${kept?.log?.frames.length ?? 0} kept change(s)`}`
    )
    if (!kept?.forkedTo) await this.importHistory(docId, target, kept)
    const file = await this.store.forkInto(docId, target)
    if (kept && !kept.forkedTo) {
      await this.api.forkDone(docId, target).catch((error: unknown) => {
        log.warn(`reporting the fork of ${docId} failed; it is reported on the next start`, error)
      })
    }
    this.keys.forgetShared(docId)
    return file
  }

  /** Fills the new note with the old one's history, each change under its author's time. */
  private async importHistory(docId: string, target: string, kept: ForkResponse | null): Promise<void> {
    const changes = new Map<string, HistoryEntry>()
    for (const change of kept?.log ? await this.readKept(docId, kept) : []) changes.set(entryKey(change), change)
    for (const change of await this.store.historyOf(docId)) changes.set(entryKey(change), change)
    const ordered = Array.from(changes.values()).sort((a, b) => a.authorTs - b.authorTs)
    // Unsent edits, and anything else the history lacks, as one last change.
    const local = await this.store.localState(docId)
    const rest = local ? missingFrom(ordered, local) : null
    if (rest) ordered.push({ authorTs: Date.now(), update: rest })
    if (ordered.length === 0) return

    const room = docRoom(target)
    const key = await aesKey(await this.keys.ownDocKey(target, 0))
    const frames: Array<{ epoch: number; data: string }> = []
    for (const change of ordered) {
      frames.push({ epoch: 0, data: toBase64(await encrypt(key, packFrame(change.authorTs, change.update), frameAad(room, 0))) })
    }
    try {
      await this.api.importFrames(room, this.keys.vaultId, { frames })
    } catch (error) {
      // Another device of this account forked into the same note a moment
      // earlier. `forkInto` adds what this one holds.
      if (!(error instanceof ApiError) || error.status !== 409) throw error
    }
  }

  /** What the server kept, decrypted with the keys it kept alongside. */
  private async readKept(docId: string, kept: ForkResponse): Promise<HistoryEntry[]> {
    const room = docRoom(docId)
    const crypto = this.keys.endedDocCrypto(docId, kept.keys)
    const open = async (epoch: number, data: string, aad: string): Promise<HistoryEntry | null> => {
      try {
        const key = await crypto.key(epoch)
        return key ? unpackFrame(await decrypt(key, fromBase64(data), aad)) : null
      } catch (error) {
        log.warn(`a kept change of ${docId} could not be read`, error)
        return null
      }
    }
    const changes: HistoryEntry[] = []
    const snapshot = kept.log?.snapshot
    if (snapshot) {
      const change = await open(snapshot.epoch, snapshot.data, snapshotAad(room, snapshot.epoch))
      if (change) changes.push(change)
    }
    for (const frame of kept.log?.frames ?? []) {
      const change = await open(frame.epoch, frame.data, frameAad(room, frame.epoch))
      if (change) changes.push(change)
    }
    return changes
  }
}

/** What `state` holds beyond the changes, or null if nothing. */
function missingFrom(changes: HistoryEntry[], state: Uint8Array): Uint8Array | null {
  const replayed = new Y.Doc()
  const local = new Y.Doc()
  try {
    for (const change of changes) Y.applyUpdate(replayed, change.update)
    Y.applyUpdate(local, state)
    const before = Y.encodeStateAsUpdate(replayed)
    const rest = Y.encodeStateAsUpdate(local, Y.encodeStateVector(replayed))
    Y.applyUpdate(replayed, rest)
    const after = Y.encodeStateAsUpdate(replayed)
    return before.length === after.length && before.every((byte, index) => byte === after[index]) ? null : rest
  } finally {
    replayed.destroy()
    local.destroy()
  }
}
