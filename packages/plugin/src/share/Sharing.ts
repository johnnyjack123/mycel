import { type TFile } from 'obsidian'
import { Notice } from '../notices.js'
import * as Y from 'yjs'
import {
  NOTE_SHARE_FIELD,
  docRoom,
  folderRoom,
  frameAad,
  roomSubject,
  snapshotAad,
  type FolderTie,
  type ForkResponse,
  type IncomingShare,
  type NotifyKind,
  type Rotation,
  type ShareMembersResponse,
  type ShareNotice,
  type ShareRole
} from '@mycel/shared'
import {
  aesKey,
  decrypt,
  encrypt,
  fromBase64,
  toBase64,
  unpackFrame,
  type Bytes
} from '@mycel/shared/crypto'
import { ApiError, type ConnectApi } from '../account/api.js'
import type { KeyRing, Recipient } from '../account/KeyRing.js'
import type { DocStore } from '../sync/DocStore.js'
import { entryKey, type HistoryEntry } from '../sync/History.js'
import type { Contacts } from './Contacts.js'
import type { LinkedNote } from './LinkedNotes.js'
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
  /**
   * The current epoch of a shared folder of this vault's: a note in it takes
   * the key of every new epoch from there.
   */
  folderEpoch?: (folderId: string) => Promise<number>
  /** Whether this account's share of a folder is over; the folder announces that for its notes. */
  folderOver?: (folderId: string) => boolean
  /**
   * Whether the account's settings - its contacts - have come from the server
   * since the start; false when they did not arrive in time. Without it the
   * contacts on the device are taken as all there are.
   */
  contactsReady?: () => Promise<boolean>
  /** The server listed members who are not contacts: said in a window over everything. */
  unknownMembers?: (accounts: string[], place: MemberPlace) => void
  /** This account's own record of who may write where: writers' certificates follow it, never the server's word. */
  roles: {
    get(room: string, account: string): ShareRole | null
    set(room: string, account: string, role: ShareRole | null): void
  }
  /** A note is shared from here with its files: the files its links show now may go along (`SharedFiles.approve`). */
  approveFiles?: (docId: string) => void
  /** A note is shared from here: the links it holds that nobody claimed are this account's (`LinkClaims.claimAll`). */
  claimLinks?: (docId: string) => Promise<void>
}

/** A note or a folder of this account's, whose members a new key is sealed to. */
export type MemberPlace = { kind: 'note'; docId: string } | { kind: 'folder'; folderId: string }

/**
 * The server listed members who are not contacts. Sharing adds contacts
 * only, and removing a contact ends every share between the two, so such a
 * member comes from the server - or from a contact removed whose shares did
 * not all end. Nothing is sealed for them, and so nothing moves.
 */
export class UnknownMembersError extends Error {
  constructor(
    readonly accounts: string[],
    readonly place: MemberPlace
  ) {
    super(
      `The server lists ${accounts.length === 1 ? 'someone' : `${accounts.length} people`} as member who ${accounts.length === 1 ? 'is' : 'are'} not one of your contacts; nothing was sealed for them.`
    )
  }
}

const STALE_RETRIES = 5
const STALE_WAIT_MS = 300

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function replacedMessage(names: string[]): string {
  return `${names.join(', ')} replaced their keys. Exchange a new friend code with ${names.length === 1 ? 'them' : 'each of them'} first - until then nothing is sealed to them.`
}

function titleOf(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/, '') || 'Shared note'
}

export class Sharing {
  /** The end of a share arrives as a message, a notice and a detach; one of them carries it out. */
  private readonly ending = new Map<string, Promise<TFile | null>>()
  private readonly detaching = new Set<string>()
  private incomingRunning: Promise<unknown> = Promise.resolve()
  private incomingQueued: Promise<number> | null = null

  constructor(
    private readonly api: ConnectApi,
    private readonly keys: KeyRing,
    private readonly store: DocStore,
    private readonly options: SharingOptions,
    private readonly contacts: Contacts
  ) {}

  get accountId(): string {
    return this.keys.accountId
  }

  /** What this account calls someone. */
  nameOf(account: string): string {
    return this.contacts.name(account)
  }

  /** The name of a contact; null for an account this one does not know. */
  knownName(account: string): string | null {
    // `Contacts.name` falls back to the id for anyone else.
    return this.contacts.isContact(account) ? this.contacts.name(account) : null
  }

  members(docId: string): Promise<ShareMembersResponse> {
    return this.api.members(docId)
  }

  /**
   * Where a note's next epoch takes its key from: the current epoch of its
   * shared folder, or the note's own. The server refuses a rotation whose
   * folder epoch moved meanwhile, and the caller tries again.
   */
  private async nextTie(docId: string): Promise<FolderTie | null> {
    const folder = this.store.entry(docId)?.folder
    if (!folder || !this.options.folderEpoch) return null
    return { folder, epoch: await this.options.folderEpoch(folder) }
  }

  /** The key of someone a note or folder is shared with now: pinned when the contact was made. */
  recipientKey(account: string): Recipient {
    const pinned = this.contacts.publicKey(account)
    if (!pinned) throw new Error('Notes are shared with contacts only. Add them under Settings → Mycel → Contacts first.')
    if (this.contacts.isReplaced(account)) throw new Error(replacedMessage([this.nameOf(account)]))
    return { account, publicKey: pinned }
  }

  /** Someone about to receive keys - one who may write with a writer's certificate. */
  recipient(account: string, role: ShareRole): Recipient {
    return this.withCert(this.recipientKey(account), role)
  }

  /** One who may write gets the owner's certificate, over the signing key pinned with the contact. */
  private withCert(recipient: Recipient, role: ShareRole): Recipient {
    if (role !== 'write') return recipient
    const signingKey = this.contacts.signingKey(recipient.account)
    if (!signingKey) throw new Error('Notes are shared with contacts only.')
    return { ...recipient, writer: { signingKey } }
  }

  /** Who may write in a room of this account's, as this account recorded it; nobody unrecorded may. */
  roleOf(room: string, account: string): ShareRole {
    return this.options.roles.get(room, account) ?? 'read'
  }

  recordRole(room: string, account: string, role: ShareRole | null): void {
    this.options.roles.set(room, account, role)
  }

  /**
   * The pinned keys of everyone the server lists in a note or folder, for a
   * key about to be sealed to them. Never the server's word for a key: a
   * member it made up, given a key of its own, would receive every later key
   * and read the share. So anyone not a contact - once the contacts are
   * surely here - stops the whole rotation before anything is sealed.
   */
  async memberKeys(members: Array<{ account: string }>, place: MemberPlace): Promise<Map<string, Recipient>> {
    const accounts = members.map((member) => member.account)
    const room = place.kind === 'note' ? docRoom(place.docId) : folderRoom(place.folderId)
    // A contact the server lists who was never given this note or folder from
    // here counts as a stranger: the server could otherwise add any contact -
    // one working with it - and have every later key sealed to them. This
    // account records everyone it shares with (`recordRole`), on every device.
    const strangers = (): string[] => accounts.filter((account) => !this.contacts.isContact(account) || this.options.roles.get(room, account) === null)
    if (strangers().length > 0 && this.options.contactsReady && !(await this.options.contactsReady())) {
      throw new Error('Your contacts have not arrived from the server yet. Try again once it is reachable.')
    }
    const unknown = strangers()
    if (unknown.length > 0) {
      const where = place.kind === 'note' ? (this.store.entry(place.docId)?.path ?? place.docId) : `the folder ${place.folderId}`
      log.error(`${where}: the server lists ${unknown.map((account) => account.slice(0, 8)).join(', ')} as member, not a contact; nothing sealed`)
      this.options.unknownMembers?.(unknown, place)
      throw new UnknownMembersError(unknown, place)
    }
    // Whoever took the keys they replaced would open what is sealed to them now.
    const replaced = accounts.filter((account) => this.contacts.isReplaced(account))
    if (replaced.length > 0) throw new Error(replacedMessage(replaced.map((account) => this.nameOf(account))))
    const keys = new Map<string, Recipient>()
    for (const { account } of members) {
      const pinned: Recipient = { account, publicKey: this.contacts.publicKey(account) as Bytes }
      keys.set(account, this.withCert(pinned, this.roleOf(room, account)))
    }
    return keys
  }

  /**
   * The keys this vault's shares hold, sealed anew and signed - for exactly
   * the epochs each member holds as the server keeps them, so nobody gains
   * history. False when something is left for later: a room not reachable.
   */
  async resealAll(folderIds: string[]): Promise<boolean> {
    let complete = true
    let resealed = 0
    const rooms: Array<{ room: string; seal: (epochs: number[], recipient: Recipient) => Promise<Record<string, string>> }> = [
      ...this.store
        .allEntries()
        .filter(({ entry }) => !entry.deletedAt && !entry.owner && (entry.shared || entry.folder))
        .map(({ docId }) => ({ room: docRoom(docId), seal: (epochs: number[], recipient: Recipient) => this.keys.sealEpochKeys(docId, epochs, recipient) })),
      ...folderIds.map((folderId) => ({
        room: folderRoom(folderId),
        seal: (epochs: number[], recipient: Recipient) => this.keys.sealFolderKeys(folderId, epochs, recipient)
      }))
    ]
    for (const { room, seal } of rooms) {
      try {
        const state = await this.api.sealedEpochs(room)
        const keys: Record<string, Record<string, string>> = {}
        for (const [member, epochs] of Object.entries(state.members)) {
          const publicKey = this.contacts.publicKey(member)
          if (epochs.length === 0) continue
          // Sealed to nobody this account does not know - `memberKeys` says the same at the next rotation.
          if (!publicKey) {
            log.warn(`${room}: ${member.slice(0, 8)} is no contact; their keys are not sealed anew`)
            continue
          }
          keys[member] = await seal(epochs, this.withCert({ account: member, publicKey }, this.roleOf(room, member)))
        }
        if (Object.keys(keys).length === 0) continue
        await this.api.reseal({ room, keys })
        resealed += 1
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) continue
        complete = false
        log.warn(`${room}: sealing its keys anew failed; tried again at the next start`, error)
      }
    }
    if (resealed > 0) log.info(`the keys of ${resealed} shared note(s) and folder(s) sealed anew, signed`)
    return complete
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
    if (shared) this.options.approveFiles?.(docId)
    log.info(`${entry.path}: its files ${shared ? 'go along with it' : 'no longer go along with it'}`)
  }

  /** The files a note of this vault's links now go along with it - the folder sharing it says so. */
  approveFilesOf(docId: string): void {
    this.options.approveFiles?.(docId)
  }

  /**
   * Shares a note of this vault. With history the person gets every epoch
   * key; without, the note moves to a new epoch and they get that key and a
   * snapshot of the note as it is now - the frames before it are deltas they
   * could not read anyway. `landing` is where it lands below their share
   * folder, folders included; by default its name.
   */
  async share(
    docId: string,
    account: string,
    role: ShareRole,
    withHistory: boolean,
    withAttachments?: boolean,
    landing?: string
  ): Promise<void> {
    const entry = this.store.entry(docId)
    if (!entry || entry.deletedAt) throw new Error('This note is not synced yet.')
    if (entry.owner) throw new Error(`Only ${this.nameOf(entry.owner)} can share this note.`)
    const recipientKey = this.recipient(account, role)
    const handle = await this.store.handle(docId)
    // Without the room's current state there is nothing to hand over, and
    // without it on the server there is no room to share yet.
    if (!(await handle.whenRemoteReady(this.options.syncTimeoutMs))) throw new Error('The server is not reachable.')
    const title = await this.keys.sealTitle(docId, landing || titleOf(entry.path), recipientKey)
    const room = docRoom(docId)
    const wasWriter = this.roleOf(room, account) === 'write'

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
          const epoch = this.keys.nextEpoch(room, members.epoch)
          const tie = await this.nextTie(docId)
          const next = { epoch, tie }
          const others = members.members.filter((member) => member.account !== account)
          const memberKeys = await this.memberKeys(others, { kind: 'note', docId })
          const rotationKeys: Record<string, string> = {}
          rotationKeys[account] = (await this.keys.sealEpochKeys(docId, [epoch], recipientKey, next))[String(epoch)] as string
          for (const [member, key] of memberKeys) {
            rotationKeys[member] = (await this.keys.sealEpochKeys(docId, [epoch], key, next))[String(epoch)] as string
          }
          // The note as far as the server's log goes - this device's own last
          // change acknowledged first. The server refuses it when frames
          // arrived meanwhile, and the loop tries again once they are in.
          await this.store.whenSent(docId, this.options.syncTimeoutMs)
          const raw = await this.keys.noteKeyUnder(docId, epoch, tie)
          if (!raw) throw new Error('The key of the shared folder is not here yet.')
          const key = await aesKey(raw)
          const state = await this.keys.packAsOwner(room, epoch, Date.now(), Y.encodeStateAsUpdate(handle.doc))
          const snapshot = await encrypt(key, state, snapshotAad(room, epoch))
          const rotation: Rotation = { epoch, keys: rotationKeys, snapshot: { uptoSeq: handle.lastSeq, data: toBase64(snapshot) } }
          if (tie) rotation.folderEpoch = tie.epoch
          await this.api.share({ docId, account, role, withHistory: false, keys: {}, title, rotation })
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
    this.recordRole(room, account, role)
    // Shared again to read, with history: the certificate they hold for the current epoch has to stop counting.
    if (wasWriter && role === 'read' && withHistory) await this.rotate(docId)
    this.store.share(docId, true)
    if (withAttachments !== undefined && !handle.pristine) setAttachmentsShared(handle.doc, withAttachments)
    if (withAttachments) this.options.approveFiles?.(docId)
    await this.options.claimLinks?.(docId).catch((error: unknown) => log.warn(`${entry.path}: naming its links as this account's failed`, error))
    log.info(
      `${entry.path}: shared with ${account} to ${role}, ${withHistory ? 'with' : 'without'} history${withAttachments ? ', with its files' : ''}`
    )
  }

  /**
   * Shares the notes a note links to along with it, with the same person and
   * choices - once: a link added later shares nothing by itself, because
   * nobody saw it listed. A note the person has already keeps the access and
   * place it has, and one shared before keeps its choice about its files,
   * which applies to everyone in it.
   */
  async shareLinked(
    notes: LinkedNote[],
    account: string,
    role: ShareRole,
    withHistory: boolean,
    withAttachments?: boolean
  ): Promise<{ shared: number; had: number; failed: number }> {
    const outcome = { shared: 0, had: 0, failed: 0 }
    for (const note of notes) {
      if (!note.docId) continue
      try {
        const { members } = await this.api.members(note.docId)
        if (members.some((member) => member.account === account)) {
          outcome.had += 1
          continue
        }
        const files = withAttachments !== undefined && (await this.attachmentsShared(note.docId)) === null ? withAttachments : undefined
        await this.share(note.docId, account, role, withHistory, files, note.title)
        outcome.shared += 1
      } catch (error) {
        log.warn(`${note.path}: sharing it along with the note that links to it failed`, error)
        outcome.failed += 1
      }
    }
    return outcome
  }

  /**
   * A contact confirmed anew after they replaced their keys: the keys they
   * hold of this account's notes are sealed anew to their new one, and each
   * note moves to a new epoch - whoever took their keys before could open
   * everything sealed to those, and opens nothing from here on. A note of a
   * shared folder moves on with the folder (`Folders.renewFor`).
   */
  async renewFor(account: string): Promise<void> {
    for (const { docId, entry } of this.store.allEntries()) {
      if (entry.owner || entry.deletedAt || (!entry.shared && !entry.folder)) continue
      const room = docRoom(docId)
      let epochs: number[]
      try {
        epochs = (await this.api.sealedEpochs(room)).members[account] ?? []
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) continue
        throw error
      }
      if (epochs.length === 0) continue
      const sealed = await this.keys.sealEpochKeys(docId, epochs, this.recipient(account, this.roleOf(room, account)))
      await this.api.reseal({ room, keys: { [account]: sealed } })
      if (!entry.folder) await this.rotate(docId)
      log.info(`${entry.path}: sealed anew to ${account.slice(0, 8)}'s new keys`)
    }
  }

  /** Takes access away and moves the note to an epoch the person never gets. */
  async revoke(docId: string, account: string): Promise<void> {
    const members = await this.api.members(docId)
    const staying = members.members.filter((member) => member.account !== account)
    const rotation = await this.rotationFor(docId, this.keys.nextEpoch(docRoom(docId), members.epoch), staying)
    await this.api.revoke({ docId, account, rotation })
    this.recordRole(docRoom(docId), account, null)
    log.info(`${this.store.entry(docId)?.path ?? docId}: access of ${account} revoked, now epoch ${rotation.epoch}`)
    // Nobody left to see a caret.
    if (Object.keys(rotation.keys).length === 0) this.store.share(docId, false)
  }

  /** The note's next epoch, its key sealed for `members` - with certificates for those recorded as writers. */
  private async rotationFor(docId: string, epoch: number, members: Array<{ account: string }>): Promise<Rotation> {
    const tie = await this.nextTie(docId)
    const keys: Record<string, string> = {}
    for (const [member, key] of await this.memberKeys(members, { kind: 'note', docId })) {
      keys[member] = (await this.keys.sealEpochKeys(docId, [epoch], key, { epoch, tie }))[String(epoch)] as string
    }
    const rotation: Rotation = { epoch, keys }
    if (tie) rotation.folderEpoch = tie.epoch
    return rotation
  }

  /** Notes being moved past an epoch the server went back from (`catchUpEpoch`). */
  private readonly catchingUp = new Set<string>()

  /**
   * The server says a note of this account's is in an epoch below one this
   * account already knew it in - restored from a backup, or moved back to a key
   * someone who left still holds. Nothing is written under it (`KeyRing`); the
   * note moves on to an epoch past both, sealed to the members this account
   * recorded, and everyone writes again.
   */
  async catchUpEpoch(docId: string): Promise<void> {
    if (this.catchingUp.has(docId)) return
    this.catchingUp.add(docId)
    try {
      const members = await this.api.members(docId)
      if (members.epoch >= this.keys.epochFloor(docRoom(docId))) return
      await this.rotate(docId)
      log.info(`${this.store.entry(docId)?.path ?? docId}: moved on past the epoch the server went back from`)
    } catch (error) {
      log.error(`${this.store.entry(docId)?.path ?? docId}: moving it past the epoch the server went back from failed`, error)
    } finally {
      this.catchingUp.delete(docId)
    }
  }

  /** The note to its next epoch, everyone keeping access - each with a certificate as recorded now. */
  private async rotate(docId: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const members = await this.api.members(docId)
        await this.api.rotateNote({ docId, rotation: await this.rotationFor(docId, this.keys.nextEpoch(docRoom(docId), members.epoch), members.members) })
        return
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && attempt < STALE_RETRIES) {
          await delay(STALE_WAIT_MS)
          continue
        }
        throw error
      }
    }
  }

  /** Someone left a note of this account's: it is shared only while anyone else is still in it. */
  async refreshShared(docId: string): Promise<void> {
    const { members } = await this.api.members(docId)
    if (members.length === 0 && this.store.isShared(docId)) {
      this.store.share(docId, false)
      log.info(`${this.store.entry(docId)?.path ?? docId}: nobody else has it any more; no longer shared`)
    }
  }

  /**
   * Changes what someone may do, and moves the note to a new epoch whose key
   * carries their certificate or not. A reader's certificate for the current
   * epoch would let them go on writing, and nobody could tell; a writer's is
   * there before the server lets them write.
   */
  async setRole(docId: string, account: string, role: ShareRole): Promise<void> {
    this.recordRole(docRoom(docId), account, role)
    if (role === 'read') await this.api.setRole({ docId, account, role })
    await this.rotate(docId)
    if (role === 'write') await this.api.setRole({ docId, account, role })
  }

  async incoming(): Promise<IncomingShare[]> {
    return (await this.api.incoming()).shares
  }

  /** Adds a note someone shared into this vault. */
  async accept(share: IncomingShare, announce = true): Promise<TFile | null> {
    const title = (await this.keys.openTitle(share.docId, share.title, share.owner)) || 'Shared note'
    const file = await this.store.acceptShare(
      { docId: share.docId, owner: share.owner, role: share.role, title },
      this.options.folder()
    )
    if (!file) return null
    await this.api.accept({ docId: share.docId, vaultId: this.keys.vaultId })
    log.info(`${file.path}: shared by ${share.owner} to ${share.role}, added`)
    if (announce) {
      new Notice(
        `${this.nameOf(share.owner)} shared "${file.basename}" with you${share.role === 'read' ? ' to read' : ''}. It is in ${file.path}.`,
        10_000
      )
    }
    return file
  }

  /**
   * Accepts everything waiting, if this vault may do so without asking.
   * Returns how many are still waiting. A note shared with the notes it links
   * to announces each of them separately; one pass at a time takes them all,
   * each once, and a pass asked for meanwhile runs after it.
   */
  checkIncoming(): Promise<number> {
    if (this.incomingQueued) return this.incomingQueued
    const queued = this.incomingRunning.then(() => {
      this.incomingQueued = null
      return this.acceptWaiting()
    })
    this.incomingQueued = queued
    this.incomingRunning = queued.catch(() => 0)
    return queued
  }

  private async acceptWaiting(): Promise<number> {
    const waiting = await this.incoming()
    if (!this.options.autoAccept()) return waiting.length
    const added = new Map<string, TFile[]>()
    for (const share of waiting) {
      try {
        const file = await this.accept(share, waiting.length === 1)
        if (file) added.set(share.owner, [...(added.get(share.owner) ?? []), file])
      } catch (error) {
        log.error(`accepting ${share.docId} failed`, error)
      }
    }
    if (waiting.length === 1) return 0
    for (const [owner, files] of added) {
      const what = files.length === 1 ? `"${files[0]?.basename}"` : `${files.length} notes`
      new Notice(`${this.nameOf(owner)} shared ${what} with you. ${files.length === 1 ? 'It is' : 'They are'} in ${this.options.folder()}.`, 10_000)
    }
    return 0
  }

  async onNotify(kind: NotifyKind, notice: ShareNotice): Promise<void> {
    switch (kind) {
      case 'share-added': {
        const waiting = await this.checkIncoming()
        if (waiting > 0) {
          new Notice(`${this.nameOf(notice.owner)} shared a note with you. Run "Notes shared with me" to add it to this vault.`, 10_000)
        }
        return
      }
      case 'share-changed': {
        const entry = this.store.entry(notice.docId)
        if (notice.role && entry?.owner) {
          this.store.setShareRole(notice.docId, notice.role)
          new Notice(`${this.nameOf(notice.owner)} changed your access to a shared note: you can now ${notice.role === 'read' ? 'only read' : 'edit'} it.`)
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

  /**
   * The server says a share ended - revoked, detached on another device, or its
   * owner's account removed. It says so twice, as a message and as a notice, and
   * for a folder's notes once more with the folder: one of them announces it.
   */
  async onRevoked(room: string): Promise<void> {
    const docId = roomSubject(room)
    const entry = this.store.entry(docId)
    if (!entry?.owner || entry.deletedAt) return
    const first = !this.ending.has(docId) && !this.detaching.has(docId)
    const file = await this.endShare(docId)
    if (!first || (entry.folder && this.options.folderOver?.(entry.folder))) return
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
    // The server's word that the share ended can come before its answer; the dialog that asked says so itself.
    this.detaching.add(docId)
    try {
      await this.api.detach(docId)
      return await this.endShare(docId)
    } finally {
      this.detaching.delete(docId)
    }
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
      // Nothing kept - the note was never accepted. What this device holds is
      // all there is. Unreachable is another matter: the kept history may
      // still come, so the fork waits for it.
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
    // Signed as this account's: the new note is its own, whoever wrote what it carries on.
    for (const change of ordered) {
      const packed = await this.keys.packAsOwner(room, 0, change.authorTs, change.update)
      frames.push({ epoch: 0, data: toBase64(await encrypt(key, packed, frameAad(room, 0))) })
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
    // Checked against the owner this vault recorded, not the one the server says it kept:
    // naming another contact let what that contact signed become this account's own note.
    const owner = this.store.entry(docId)?.owner ?? kept.owner
    const crypto = this.keys.endedDocCrypto(docId, kept.keys, kept.folder, owner)
    // Only what the live note would have taken: a frame no writer signed does not become this account's own.
    const open = async (kind: 'frame' | 'snapshot', seq: number, epoch: number, data: string, aad: string): Promise<HistoryEntry | null> => {
      try {
        const key = await crypto.key(epoch)
        if (!key) return null
        const change = unpackFrame(await decrypt(key, fromBase64(data), aad))
        if (!change || (await crypto.check(kind, seq, epoch, change)) !== 'ok') {
          log.warn(`${docId}: a kept ${kind} #${seq} is not signed by someone who could write there; left out`)
          return null
        }
        return change
      } catch (error) {
        log.warn(`a kept change of ${docId} could not be read`, error)
        return null
      }
    }
    const changes: HistoryEntry[] = []
    const snapshot = kept.log?.snapshot
    if (snapshot) {
      const change = await open('snapshot', snapshot.uptoSeq, snapshot.epoch, snapshot.data, snapshotAad(room, snapshot.epoch))
      if (change) changes.push(change)
    }
    for (const frame of kept.log?.frames ?? []) {
      const change = await open('frame', frame.seq, frame.epoch, frame.data, frameAad(room, frame.epoch))
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
