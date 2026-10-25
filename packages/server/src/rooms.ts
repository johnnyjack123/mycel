import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CLOSE_SIGNED_OUT,
  docRoom,
  folderRoom,
  isHexId,
  roomKind,
  roomSubject,
  type AttachBlobsRequest,
  type BackupRoom,
  type BlobRef,
  type FolderEndRequest,
  type FolderJoinRequest,
  type FolderLeaveRequest,
  type FolderNoteState,
  type FolderRevokeRequest,
  type FolderRoleRequest,
  type FolderRotation,
  type FolderShareRequest,
  type FolderStateResponse,
  type FolderTie,
  type ForkReason,
  type ForkResponse,
  type ForkSummary,
  type IncomingFolder,
  type IncomingShare,
  type KeysResponse,
  type LogResponse,
  type NoteRotation,
  type NotifyKind,
  type RevokeRequest,
  type RoleRequest,
  type ShareMembersResponse,
  type Notice,
  type ShareRequest,
  type ShareRole,
  type SnapshotRequest,
  type StartSnapshotRequest
} from '@obsidian-connect/shared'
import { isAccountId, type AccountStore } from './accounts.js'
import type { ContactStore } from './contacts.js'
import type { FolderKept, ForkStore } from './forks.js'
import {
  RoomLog,
  loadAllMeta,
  roomDir,
  saveMetaOf,
  type Frame,
  type RoomFolder,
  type RoomMeta,
  type SnapshotInfo
} from './log.js'

// The server's side of an end-to-end encrypted vault: it keeps every room's
// frames in order, decides who may read and write, and fans frames out. It
// never holds a document - it could not read one.

/** A connection that wants a room's traffic. One socket may hold many rooms. */
export interface RoomClient {
  readonly account: string
  /** The vault the connection was opened for. */
  readonly vaultId: string
  sendFrame(room: string, frame: Frame): void
  sendSnapshot(room: string, uptoSeq: number, epoch: number, data: Uint8Array): void
  /**
   * `tie`, for an epoch a note spends in a shared folder: the folder epoch its
   * key derives from. A device sending under that epoch must know it, or it
   * would encrypt under the note's own key - which nobody in the folder holds.
   */
  sendCaughtUp(room: string, headSeq: number, epoch: number, tie: FolderTie | null): void
  sendAck(room: string, ref: number, seq: number): void
  sendAwareness(room: string, epoch: number, data: Uint8Array): void
  sendRekey(room: string, epoch: number, tie: FolderTie | null): void
  sendRevoked(room: string, reason: string): void
  sendDenied(room: string, reason: string): void
  sendNotify(kind: NotifyKind, payload: Notice): void
  /** Ends the connection; the device learns why from the close code. */
  close(code: number, reason: string): void
}

export class HubError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

interface Access {
  owner: boolean
  write: boolean
  fromSeq: number
}

interface OpenRoom {
  log: RoomLog
  subscribers: Set<RoomClient>
  idleTimer: NodeJS.Timeout | null
}

export interface RoomHubOptions {
  dataDir: string
  /** How long an unused room stays in memory. */
  idleCloseMs?: number
  logUpdates?: boolean
}

const IDLE_CLOSE_MS = 30_000
const ROLES: readonly ShareRole[] = ['read', 'write']

function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString('base64')
}

function fromBase64(value: unknown, what: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) throw new HubError(400, `${what} is missing`)
  return new Uint8Array(Buffer.from(value, 'base64'))
}

function docRoomOf(docId: unknown): string {
  if (typeof docId !== 'string' || !isHexId(docId)) throw new HubError(400, 'not a document id')
  return docRoom(docId)
}

export class RoomHub {
  private readonly metas = new Map<string, RoomMeta>()
  private readonly rooms = new Map<string, OpenRoom>()
  private readonly opening = new Map<string, Promise<OpenRoom | null>>()
  private readonly clients = new Set<RoomClient>()
  private readonly disconnectListeners = new Set<(account: string) => void>()
  /** Accounts removed while connections of theirs may still be open; they create nothing any more. */
  private readonly gone = new Set<string>()
  /** `account/vault/blob` -> the rooms whose attachment lists name it. */
  private readonly attached = new Map<string, Set<string>>()
  private sweeping: Promise<void> | null = null
  private readonly ready: Promise<void>

  constructor(
    private readonly options: RoomHubOptions,
    private readonly accounts: AccountStore,
    private readonly contacts: ContactStore,
    private readonly forks: ForkStore
  ) {
    this.ready = loadAllMeta(options.dataDir).then((metas) => {
      for (const meta of metas) {
        this.metas.set(meta.room, meta)
        for (const key of meta.attachments ?? []) this.markAttached(key, meta.room, true)
      }
    })
  }

  private markAttached(key: string, room: string, attached: boolean): void {
    const rooms = this.attached.get(key) ?? new Set<string>()
    if (attached) rooms.add(room)
    else rooms.delete(room)
    if (rooms.size > 0) this.attached.set(key, rooms)
    else this.attached.delete(key)
  }

  /** A room went: its attachment list no longer holds any blob. */
  private forgetAttachments(meta: RoomMeta): void {
    for (const key of meta.attachments ?? []) this.markAttached(key, meta.room, false)
  }

  /** Whether a shared note names this blob; such a blob is never purged. */
  isAttached(account: string, vault: string, blob: string): boolean {
    return this.attached.has(`${account}/${vault}/${blob}`)
  }

  // --- rooms -------------------------------------------------------------------

  /**
   * A note's own members, and the members of the shared folder it is in; reached
   * both ways, the higher role and the earlier start count.
   */
  private access(meta: RoomMeta, account: string): Access | 'revoked' | null {
    if (meta.owner === account) return { owner: true, write: true, fromSeq: 0 }
    const member = meta.members[account]
    const own: Access | null = member ? { owner: false, write: member.role === 'write', fromSeq: member.fromSeq } : null
    const viaFolder = this.folderAccess(meta, account)
    if (own && viaFolder && viaFolder !== 'revoked') {
      return { owner: false, write: own.write || viaFolder.write, fromSeq: Math.min(own.fromSeq, viaFolder.fromSeq) }
    }
    if (own) return own
    if (viaFolder) return viaFolder
    if (meta.revoked[account]) return 'revoked'
    return null
  }

  /** Access to a note through the shared folder it is in. */
  private folderAccess(meta: RoomMeta, account: string): Access | 'revoked' | null {
    if (!meta.folder) return null
    const folder = this.metas.get(folderRoom(meta.folder.id))
    const member = folder?.members[account]
    if (member) return { owner: false, write: member.role === 'write', fromSeq: meta.folder.from?.[account] ?? meta.folder.since }
    return folder?.revoked[account] ? 'revoked' : null
  }

  private async load(room: string): Promise<OpenRoom | null> {
    await this.ready
    const open = this.rooms.get(room)
    if (open) {
      if (open.idleTimer) clearTimeout(open.idleTimer)
      open.idleTimer = null
      return open
    }
    const pending = this.opening.get(room)
    if (pending) return pending
    const meta = this.metas.get(room)
    if (!meta) return null
    const loading = RoomLog.load(this.options.dataDir, meta)
      .then((log) => {
        const loaded: OpenRoom = { log, subscribers: new Set(), idleTimer: null }
        this.rooms.set(room, loaded)
        return loaded
      })
      .finally(() => this.opening.delete(room))
    this.opening.set(room, loading)
    return loading
  }

  /**
   * Creates a room owned by `owner`. Whoever gets here first owns it. The
   * checks and the creation happen without an await in between, so two
   * devices subscribing at once cannot both create it.
   */
  private claim(room: string, owner: string, vaultId: string, folder?: RoomFolder, ties?: Record<string, FolderTie>): Promise<OpenRoom> {
    const open = this.rooms.get(room)
    if (open) return Promise.resolve(open)
    const pending = this.opening.get(room)
    if (pending) return pending.then((result) => result ?? this.claim(room, owner, vaultId, folder, ties))
    if (this.metas.has(room)) {
      return this.load(room).then((result) => result ?? Promise.reject(new HubError(500, 'the room vanished')))
    }
    const creating = (async (): Promise<OpenRoom> => {
      const meta: RoomMeta = {
        room,
        owner,
        vaultId,
        createdAt: Date.now(),
        epoch: 0,
        compactedUpTo: 0,
        oldestFrameTs: null,
        members: {},
        revoked: {},
        sealedKeys: {},
        snapshots: []
      }
      if (folder) meta.folder = folder
      if (ties) meta.ties = ties
      this.metas.set(room, meta)
      const log = await RoomLog.create(this.options.dataDir, meta)
      const created: OpenRoom = { log, subscribers: new Set(), idleTimer: null }
      this.rooms.set(room, created)
      return created
    })().finally(() => this.opening.delete(room))
    this.opening.set(room, creating)
    return creating
  }

  private async require(room: string): Promise<OpenRoom> {
    const open = await this.load(room)
    if (!open) throw new HubError(404, 'no such room')
    return open
  }

  private scheduleIdle(room: string, open: OpenRoom): void {
    if (open.idleTimer) clearTimeout(open.idleTimer)
    open.idleTimer = setTimeout(() => {
      if (open.subscribers.size > 0) return
      void open.log.flush().finally(() => {
        if (open.subscribers.size === 0 && this.rooms.get(room) === open) this.rooms.delete(room)
      })
    }, this.options.idleCloseMs ?? IDLE_CLOSE_MS)
    open.idleTimer.unref?.()
  }

  // --- connections -------------------------------------------------------------

  attach(client: RoomClient): void {
    this.clients.add(client)
  }

  detach(client: RoomClient): void {
    this.clients.delete(client)
    for (const [room, open] of this.rooms) {
      if (open.subscribers.delete(client) && open.subscribers.size === 0) this.scheduleIdle(room, open)
    }
  }

  notify(account: string, kind: NotifyKind, payload: Notice): void {
    for (const client of this.clients) if (client.account === account) client.sendNotify(kind, payload)
  }

  /**
   * Closes every connection of the account: its session generation moved. A
   * token checked once at the upgrade would otherwise keep a socket - and the
   * frames on it - for as long as the socket stays open. Devices still signed
   * in come straight back with their new token.
   */
  disconnect(account: string): void {
    for (const client of Array.from(this.clients)) {
      if (client.account === account) client.close(CLOSE_SIGNED_OUT, 'signed out')
    }
    for (const listener of this.disconnectListeners) listener(account)
  }

  /** Other connections an account holds - the relay's - closed on the same occasions. */
  onDisconnect(listener: (account: string) => void): () => void {
    this.disconnectListeners.add(listener)
    return () => this.disconnectListeners.delete(listener)
  }

  /**
   * `create`: a missing room is created, owned by the caller. A device asks
   * for that only for its own notes - after a server lost a note someone else
   * owns, claiming it would take it from them. With `folder`, a missing note
   * is created in that shared folder instead, owned by the folder's owner, if
   * the caller may write in it.
   */
  async subscribe(client: RoomClient, room: string, afterSeq: number, create = true, folder?: string): Promise<void> {
    const kind = roomKind(room)
    const subject = roomSubject(room)
    if (!kind || !isHexId(subject)) {
      client.sendDenied(room, 'unknown room')
      return
    }
    // The index and settings of a vault only ever travel over that vault's own
    // connection, which the upgrade already checked belongs to this account.
    if ((kind === 'idx' || kind === 'set') && subject !== client.vaultId) {
      client.sendDenied(room, 'not this vault')
      return
    }
    const loaded = await this.load(room)
    // A share that ended - even with its room gone along with the owner's
    // account - is answered as ended, so the device forks instead of waiting
    // for the room, or claiming it.
    const ended = kind === 'doc' && (await this.forks.has(client.account, subject))
    if (!loaded && ended) {
      client.sendRevoked(room, 'the share ended')
      return
    }
    if (!loaded && (!create || this.gone.has(client.account))) {
      client.sendDenied(room, 'missing')
      return
    }
    let open = loaded
    if (!open && folder !== undefined && kind === 'doc') {
      open = await this.claimInFolder(client, room, folder)
      if (!open) {
        client.sendDenied(room, 'not a folder you may write in')
        return
      }
    }
    open ??= await this.claim(room, client.account, client.vaultId)
    const access = this.access(open.log.meta, client.account)
    if (access === 'revoked' || (!access && ended)) {
      client.sendRevoked(room, 'access was revoked')
      return
    }
    if (!access) {
      client.sendDenied(room, 'no access')
      return
    }

    // Reading a snapshot is the only wait. Everything after it runs without
    // one, so no frame appended meanwhile can slip between the catch-up and
    // the live stream, or arrive ahead of it.
    for (let attempt = 0; ; attempt += 1) {
      const compactedBefore = open.log.meta.compactedUpTo
      const plan = open.log.catchUp(access.fromSeq, afterSeq)
      const snapshotData = plan.snapshot ? await open.log.readSnapshot(plan.snapshot) : null
      if (open.log.meta.compactedUpTo !== compactedBefore && attempt < 3) continue
      const fresh = open.log.catchUp(access.fromSeq, afterSeq)
      const snapshot: SnapshotInfo | null = plan.snapshot
      const after = snapshot ? snapshot.uptoSeq : Math.max(afterSeq, access.fromSeq - 1)
      if (snapshot && snapshotData) client.sendSnapshot(room, snapshot.uptoSeq, snapshot.epoch, snapshotData)
      const frames = snapshot ? open.log.frames.filter((frame) => frame.seq > after && frame.seq >= access.fromSeq) : fresh.frames
      for (const frame of frames) client.sendFrame(room, frame)
      client.sendCaughtUp(room, open.log.headSeq, open.log.meta.epoch, this.tieOf(room, open.log.meta.epoch))
      open.subscribers.add(client)
      if (open.idleTimer) clearTimeout(open.idleTimer)
      open.idleTimer = null
      return
    }
  }

  /**
   * A note created in a shared folder belongs to the folder's owner - as the
   * text one writes into a shared note does - and lives in the owner's vault.
   * Its first epoch is the folder's current one.
   */
  private claimInFolder(client: RoomClient, room: string, folderId: string): Promise<OpenRoom> | null {
    const folder = isHexId(folderId) ? this.metas.get(folderRoom(folderId)) : undefined
    if (!folder || this.gone.has(folder.owner)) return null
    const access = this.access(folder, client.account)
    if (!access || access === 'revoked' || !access.write) return null
    return this.claim(room, folder.owner, folder.vaultId, { id: folderId, since: 0 }, { '0': { folder: folderId, epoch: folder.epoch } })
  }

  unsubscribe(client: RoomClient, room: string): void {
    const open = this.rooms.get(room)
    if (open?.subscribers.delete(client) && open.subscribers.size === 0) this.scheduleIdle(room, open)
  }

  async push(client: RoomClient, room: string, ref: number, epoch: number, data: Uint8Array): Promise<void> {
    const open = this.rooms.get(room)
    if (!open || !open.subscribers.has(client)) {
      client.sendDenied(room, 'not subscribed')
      return
    }
    const access = this.access(open.log.meta, client.account)
    if (access === 'revoked' || !access) {
      client.sendRevoked(room, 'access was revoked')
      open.subscribers.delete(client)
      return
    }
    if (!access.write) {
      client.sendDenied(room, 'read-only')
      return
    }
    // Encrypted under an epoch the others may not hold any more, or not yet.
    if (epoch !== open.log.meta.epoch) {
      client.sendRekey(room, open.log.meta.epoch, this.tieOf(room, open.log.meta.epoch))
      return
    }
    const frame = await open.log.append(epoch, data)
    if (this.options.logUpdates) {
      console.info(`[obsidian-connect] ${room}: #${frame.seq} ${data.length}B -> ${open.subscribers.size - 1} peer(s)`)
    }
    client.sendAck(room, ref, frame.seq)
    for (const subscriber of open.subscribers) if (subscriber !== client) subscriber.sendFrame(room, frame)
  }

  awareness(client: RoomClient, room: string, epoch: number, data: Uint8Array): void {
    const open = this.rooms.get(room)
    if (!open || !open.subscribers.has(client)) return
    for (const subscriber of open.subscribers) {
      if (subscriber !== client) subscriber.sendAwareness(room, epoch, data)
    }
  }

  // --- sharing -----------------------------------------------------------------

  private async owned(owner: string, docId: unknown): Promise<OpenRoom> {
    const open = await this.require(docRoomOf(docId))
    if (open.log.meta.owner !== owner) throw new HubError(403, 'only the owner can do that')
    return open
  }

  private async recipient(id: unknown, owner: string): Promise<string> {
    if (!isAccountId(id) || !(await this.accounts.get(id))) throw new HubError(404, 'no such person')
    if (id === owner) throw new HubError(400, 'that is you')
    // The client checks this too; the server holds it even for one that does not.
    if (!(await this.contacts.connected(owner, id))) throw new HubError(403, 'notes are shared with contacts only')
    return id
  }

  private rekeyAll(open: OpenRoom): void {
    const { room, epoch } = open.log.meta
    for (const subscriber of open.subscribers) subscriber.sendRekey(room, epoch, this.tieOf(room, epoch))
  }

  /**
   * A note in a shared folder takes every new epoch's key from the folder's
   * current one, or the folder's members could no longer read it; the device
   * says which folder epoch it derived from, and a folder that moved meanwhile
   * is a reason to try again.
   */
  private checkFolderEpoch(meta: RoomMeta, folderEpoch: number | undefined): void {
    if (!meta.folder) return
    const folder = this.metas.get(folderRoom(meta.folder.id))
    if (folder && folderEpoch !== folder.epoch) throw new HubError(409, 'the folder moved to another epoch; try again')
  }

  /** The room moves to its next epoch - a note in a folder tied to the folder's current one. */
  private moveEpoch(meta: RoomMeta, epoch: number): void {
    meta.epoch = epoch
    meta.epochSince = this.headOf(meta)
    if (!meta.folder) return
    const folder = this.metas.get(folderRoom(meta.folder.id))
    if (folder) meta.ties = { ...meta.ties, [String(epoch)]: { folder: meta.folder.id, epoch: folder.epoch } }
  }

  /** The folder epoch a note's epoch derives its key from, if it spent that epoch in a folder. */
  tieOf(room: string, epoch: number): FolderTie | null {
    return this.metas.get(room)?.ties?.[String(epoch)] ?? null
  }

  /** A note's epochs spent in one folder, each with the folder epoch it derives from. */
  private tiesIn(meta: RoomMeta, folderId: string): Record<string, number> {
    const epochs: Record<string, number> = {}
    for (const [epoch, tie] of Object.entries(meta.ties ?? {})) if (tie.folder === folderId) epochs[epoch] = tie.epoch
    return epochs
  }

  private headOf(meta: RoomMeta): number {
    const open = this.rooms.get(meta.room)
    if (open) return open.log.headSeq
    // A room moved without being open - which a folder's operations avoid by
    // loading every note first - knows no more than its snapshots.
    return meta.snapshots.reduce((max, snapshot) => Math.max(max, snapshot.uptoSeq), meta.compactedUpTo)
  }

  async share(owner: string, request: ShareRequest): Promise<void> {
    const open = await this.owned(owner, request.docId)
    const meta = open.log.meta
    const account = await this.recipient(request.account, owner)
    if (!ROLES.includes(request.role)) throw new HubError(400, 'the role is read or write')
    if (typeof request.title !== 'string') throw new HubError(400, 'the title is missing')
    const existing = meta.members[account]
    let fromSeq: number

    if (request.withHistory) {
      for (let epoch = 0; epoch <= meta.epoch; epoch += 1) {
        if (typeof request.keys?.[String(epoch)] !== 'string') throw new HubError(400, `the key of epoch ${epoch} is missing`)
      }
      meta.sealedKeys[account] = { ...meta.sealedKeys[account], ...request.keys }
      fromSeq = 0
    } else {
      const rotation = request.rotation
      if (!rotation || rotation.epoch !== meta.epoch + 1) throw new HubError(409, 'the note moved to another epoch; try again')
      if (!rotation.snapshot || rotation.snapshot.uptoSeq !== open.log.headSeq) {
        throw new HubError(409, 'the note changed meanwhile; try again')
      }
      for (const member of [account, ...Object.keys(meta.members).filter((name) => name !== account)]) {
        if (typeof rotation.keys?.[member] !== 'string') throw new HubError(400, `the new key for ${member} is missing`)
      }
      this.checkFolderEpoch(meta, rotation.folderEpoch)
      const snapshot = fromBase64(rotation.snapshot.data, 'the snapshot')
      // Before anything is awaited: from here on a push under the old epoch is
      // refused, so nothing lands after the snapshot that the recipient
      // could not decrypt.
      this.moveEpoch(meta, rotation.epoch)
      for (const [member, key] of Object.entries(rotation.keys)) {
        meta.sealedKeys[member] = { ...meta.sealedKeys[member], [String(rotation.epoch)]: key }
      }
      this.rekeyAll(open)
      await open.log.addJoinSnapshot(rotation.snapshot.uptoSeq, rotation.epoch, snapshot)
      // Sharing again without history never takes back history already given.
      fromSeq = Math.min(existing?.fromSeq ?? Number.MAX_SAFE_INTEGER, rotation.snapshot.uptoSeq + 1)
    }

    meta.members[account] = {
      role: request.role,
      fromSeq,
      addedAt: existing?.addedAt ?? Date.now(),
      title: request.title,
      acceptedInto: existing?.acceptedInto
    }
    delete meta.revoked[account]
    await open.log.saveMeta()
    this.notify(account, existing ? 'share-changed' : 'share-added', { docId: roomSubject(meta.room), owner, role: request.role })
  }

  /**
   * Takes what a member can read right now, for the fork their devices make
   * once the share ended. Everything up to the returned function runs without
   * an await, so it can sit between an epoch moving and the first wait: no
   * frame the member could read lands after it.
   */
  private keepForFork(open: OpenRoom, account: string, reason: ForkReason, now: number): () => Promise<void> {
    const meta = open.log.meta
    const folderMeta = meta.folder ? this.metas.get(folderRoom(meta.folder.id)) : undefined
    const access = this.access(meta, account)
    // Never added to a vault, so no device has anything to carry on.
    const accepted = meta.members[account]?.acceptedInto ?? folderMeta?.members[account]?.acceptedInto
    if (!accepted || !access || access === 'revoked') return async () => undefined
    const keys = { ...meta.sealedKeys[account] }
    // A note of a shared folder: the epochs it spent there open with the folder's keys.
    const folder: FolderKept | undefined =
      meta.folder && folderMeta?.members[account]
        ? { id: meta.folder.id, keys: { ...folderMeta.sealedKeys[account] }, epochs: this.tiesIn(meta, meta.folder.id) }
        : undefined
    const readable = (epoch: number): boolean => {
      if (typeof keys[String(epoch)] === 'string') return true
      const folderEpoch = folder?.epochs[String(epoch)]
      return folderEpoch !== undefined && typeof folder?.keys[String(folderEpoch)] === 'string'
    }
    const part = this.readablePart(open, { owner: false, write: false, fromSeq: access.fromSeq })
    const frames = part.frames.filter((frame) => readable(frame.epoch))
    const snapshot = part.snapshot && readable(part.snapshot.epoch) ? part.snapshot : null
    const epoch = meta.epoch
    const headSeq = open.log.headSeq
    const summary: ForkSummary = { docId: roomSubject(meta.room), owner: meta.owner, reason, endedAt: now }
    return async () => {
      const log = await this.logResponse(open, { snapshot, frames }, epoch, headSeq)
      await this.forks.put(account, summary, keys, log, folder)
    }
  }

  /** Ending a share never fails over its copy: the devices still hold theirs. */
  private async keepSafely(keep: () => Promise<void>, room: string, account: string): Promise<void> {
    try {
      await keep()
    } catch (error) {
      console.error(`[obsidian-connect] keeping ${room} for ${account} failed; their devices fork from what they hold`, error)
    }
  }

  async revoke(owner: string, request: RevokeRequest): Promise<void> {
    const open = await this.owned(owner, request.docId)
    const meta = open.log.meta
    const account = isAccountId(request.account) ? request.account : null
    if (!account || !meta.members[account]) throw new HubError(404, 'not a member')
    const rotation = request.rotation
    if (!rotation || rotation.epoch !== meta.epoch + 1) throw new HubError(409, 'the note moved to another epoch; try again')
    const remaining = Object.keys(meta.members).filter((name) => name !== account)
    for (const member of remaining) {
      if (typeof rotation.keys?.[member] !== 'string') throw new HubError(400, `the new key for ${member} is missing`)
    }
    this.checkFolderEpoch(meta, rotation.folderEpoch)

    const now = Date.now()
    // Still in the note's folder, the person keeps reading it there: nothing ends for them.
    const stays = this.inFolder(meta, account)
    const keep = stays ? async () => undefined : this.keepForFork(open, account, 'revoked', now)
    this.moveEpoch(meta, rotation.epoch)
    delete meta.members[account]
    delete meta.sealedKeys[account]
    if (!stays) meta.revoked[account] = now
    for (const member of remaining) {
      meta.sealedKeys[member] = { ...meta.sealedKeys[member], [String(rotation.epoch)]: rotation.keys[member] as string }
    }
    // What the member could read goes to disk before the revocation does: a
    // crash in between leaves them a member, never without their copy.
    await this.keepSafely(keep, meta.room, account)
    await open.log.saveMeta()

    for (const subscriber of Array.from(open.subscribers)) {
      if (subscriber.account === account && !stays) {
        subscriber.sendRevoked(meta.room, 'access was revoked')
        open.subscribers.delete(subscriber)
      } else {
        subscriber.sendRekey(meta.room, meta.epoch, this.tieOf(meta.room, meta.epoch))
      }
    }
    const docId = roomSubject(meta.room)
    if (stays) this.notify(account, 'share-changed', { docId, owner })
    else this.notify(account, 'share-removed', { docId, owner })
  }

  /** Whether someone reaches a note through its shared folder. */
  private inFolder(meta: RoomMeta, account: string): boolean {
    const viaFolder = this.folderAccess(meta, account)
    return viaFolder !== null && viaFolder !== 'revoked'
  }

  /**
   * A participant ends the share and keeps the note as one of their own. The
   * server keeps what they could read, as it would on a revocation, and tells
   * their other devices, which fold what they hold into the same new note.
   */
  async detachShare(account: string, docId: unknown): Promise<void> {
    const room = docRoomOf(docId)
    const subject = roomSubject(room)
    const open = await this.load(room)
    if (!open || !open.log.meta.members[account]) {
      // Ended already - by another device of theirs, or by the owner.
      if (await this.forks.has(account, subject)) return
      throw new HubError(404, 'not shared with you')
    }
    const meta = open.log.meta
    // In the note's folder too, it stays theirs there and nothing is forked.
    const stays = this.inFolder(meta, account)
    const keep = stays ? async () => undefined : this.keepForFork(open, account, 'detached', Date.now())
    delete meta.members[account]
    if (!stays) delete meta.sealedKeys[account]
    await this.keepSafely(keep, room, account)
    await open.log.saveMeta()
    this.memberLeft(meta)
    if (stays) return
    for (const subscriber of Array.from(open.subscribers)) {
      if (subscriber.account !== account) continue
      subscriber.sendRevoked(room, 'the share ended')
      open.subscribers.delete(subscriber)
    }
    this.notify(account, 'share-removed', { docId: subject, owner: meta.owner })
  }

  /**
   * Tells the owner someone left, so a note nobody else has any more stops
   * being treated as shared - carets and all - on the owner's devices.
   */
  private memberLeft(meta: RoomMeta): void {
    this.notify(meta.owner, 'share-changed', { docId: roomSubject(meta.room), owner: meta.owner })
  }

  async forksOf(account: string): Promise<ForkSummary[]> {
    return this.forks.pending(account)
  }

  async fork(account: string, docId: unknown): Promise<ForkResponse> {
    if (typeof docId !== 'string' || !isHexId(docId)) throw new HubError(400, 'not a document id')
    const fork = await this.forks.get(account, docId)
    if (!fork) throw new HubError(404, 'no share of this note ended for you')
    return fork
  }

  /** Returns where the note carries on - the first device's answer, if another one forked first. */
  async forkDone(account: string, docId: unknown, forkedTo: unknown): Promise<string> {
    if (typeof docId !== 'string' || !isHexId(docId)) throw new HubError(400, 'not a document id')
    if (typeof forkedTo !== 'string' || !isHexId(forkedTo)) throw new HubError(400, 'not a document id')
    const kept = await this.forks.done(account, docId, forkedTo)
    if (!kept) throw new HubError(404, 'no share of this note ended for you')
    return kept
  }

  async leave(account: string, docId: unknown): Promise<void> {
    const open = await this.require(docRoomOf(docId))
    const meta = open.log.meta
    if (meta.owner === account) throw new HubError(400, 'the owner cannot leave their own note')
    if (!meta.members[account]) return
    delete meta.members[account]
    const stays = this.inFolder(meta, account)
    if (!stays) delete meta.sealedKeys[account]
    await open.log.saveMeta()
    for (const subscriber of Array.from(open.subscribers)) {
      if (subscriber.account === account && !stays) open.subscribers.delete(subscriber)
    }
    this.memberLeft(meta)
  }

  async setRole(owner: string, request: RoleRequest): Promise<void> {
    const open = await this.owned(owner, request.docId)
    const account = isAccountId(request.account) ? request.account : null
    const member = account ? open.log.meta.members[account] : undefined
    if (!account || !member) throw new HubError(404, 'not a member')
    if (!ROLES.includes(request.role)) throw new HubError(400, 'the role is read or write')
    member.role = request.role
    await open.log.saveMeta()
    this.notify(account, 'share-changed', { docId: roomSubject(open.log.meta.room), owner, role: request.role })
  }

  async accept(account: string, docId: unknown, vaultId: unknown): Promise<void> {
    const open = await this.require(docRoomOf(docId))
    const member = open.log.meta.members[account]
    if (!member) throw new HubError(404, 'not shared with you')
    if (typeof vaultId !== 'string' || !isHexId(vaultId)) throw new HubError(400, 'not a vault id')
    member.acceptedInto = vaultId
    await open.log.saveMeta()
  }

  async incoming(account: string): Promise<IncomingShare[]> {
    await this.ready
    const shares: IncomingShare[] = []
    for (const meta of this.metas.values()) {
      const member = meta.members[account]
      // Folders are offered on their own: a device that knows no folders would take one for a note.
      if (!member || member.acceptedInto || roomKind(meta.room) !== 'doc') continue
      shares.push({
        docId: roomSubject(meta.room),
        owner: meta.owner,
        role: member.role,
        title: member.title,
        addedAt: member.addedAt
      })
    }
    return shares.sort((a, b) => a.addedAt - b.addedAt)
  }

  async members(account: string, docId: unknown): Promise<ShareMembersResponse> {
    const open = await this.require(docRoomOf(docId))
    const meta = open.log.meta
    if (!this.access(meta, account) || this.access(meta, account) === 'revoked') throw new HubError(403, 'no access')
    return {
      docId: roomSubject(meta.room),
      owner: meta.owner,
      epoch: meta.epoch,
      members: Object.entries(meta.members)
        .map(([name, member]) => ({ account: name, role: member.role, addedAt: member.addedAt }))
        .sort((a, b) => a.addedAt - b.addedAt)
    }
  }

  // --- shared folders --------------------------------------------------------------
  // A folder is a room of its own, and its members reach every note in it
  // (`folderAccess`). Moving the folder's epoch moves every note's along, each
  // new note epoch tied to the folder epoch its key derives from. Every change
  // happens before anything is awaited (invariant 16). `docs/PHASE7.md`.

  private folderOf(folderId: unknown): RoomMeta {
    const meta = typeof folderId === 'string' && isHexId(folderId) ? this.metas.get(folderRoom(folderId)) : undefined
    if (!meta) throw new HubError(404, 'no such folder')
    return meta
  }

  private async ownedFolder(owner: string, folderId: unknown): Promise<OpenRoom> {
    const meta = this.folderOf(folderId)
    if (meta.owner !== owner) throw new HubError(403, 'only the owner can do that')
    return this.require(meta.room)
  }

  /** The notes in a folder, as the server knows them now. */
  private notesIn(folderId: string): RoomMeta[] {
    return Array.from(this.metas.values()).filter((meta) => meta.folder?.id === folderId && roomKind(meta.room) === 'doc')
  }

  /** Every note of the folder loaded: what an operation moves or keeps must be read, not guessed. */
  private async loadNotes(folderId: string): Promise<OpenRoom[]> {
    const opened = await Promise.all(this.notesIn(folderId).map((meta) => this.load(meta.room)))
    return opened.filter((open): open is OpenRoom => open !== null)
  }

  /** Rooms loaded for one operation go again once nobody uses them. */
  private release(opens: OpenRoom[]): void {
    for (const open of opens) if (open.subscribers.size === 0) this.scheduleIdle(open.log.meta.room, open)
  }

  private saveMeta(meta: RoomMeta): Promise<void> {
    const open = this.rooms.get(meta.room)
    return open ? open.log.saveMeta() : saveMetaOf(this.options.dataDir, meta)
  }

  /** After access changed: whoever still has it moves to the new epoch, everyone else hears it ended. */
  private refreshSubscribers(meta: RoomMeta, reason: string): void {
    const open = this.rooms.get(meta.room)
    if (!open) return
    for (const subscriber of Array.from(open.subscribers)) {
      const access = this.access(meta, subscriber.account)
      if (!access || access === 'revoked') {
        subscriber.sendRevoked(meta.room, reason)
        open.subscribers.delete(subscriber)
      } else {
        subscriber.sendRekey(meta.room, meta.epoch, this.tieOf(meta.room, meta.epoch))
      }
    }
  }

  /**
   * Where someone joining now without history starts reading a room: a
   * snapshot in its current epoch, taken since the epoch began. 0 for a room
   * with nothing in it; null while there is none.
   */
  private startOf(meta: RoomMeta): number | null {
    if (this.headOf(meta) === 0) return 0
    const since = meta.epochSince ?? 0
    const found = meta.snapshots
      .filter((snapshot) => snapshot.epoch === meta.epoch && snapshot.uptoSeq >= since)
      .reduce((max, snapshot) => Math.max(max, snapshot.uptoSeq), -1)
    return found >= 0 ? found : null
  }

  /** The note's own members and their keys of its next epoch, checked before anything changes. */
  private checkNoteRotations(notes: RoomMeta[], rotations: Record<string, NoteRotation> | undefined): void {
    for (const meta of notes) {
      const members = Object.keys(meta.members)
      if (members.length === 0) continue
      const docId = roomSubject(meta.room)
      const rotation = rotations?.[docId]
      if (!rotation || rotation.epoch !== meta.epoch + 1) throw new HubError(409, `${docId} moved to another epoch; try again`)
      for (const member of members) {
        if (typeof rotation.keys?.[member] !== 'string') throw new HubError(400, `the new key of ${docId} for ${member} is missing`)
      }
    }
  }

  /** A note to its next epoch, with its own members' keys. */
  private moveNote(meta: RoomMeta, rotation: NoteRotation | undefined): void {
    this.moveEpoch(meta, meta.epoch + 1)
    for (const member of Object.keys(meta.members)) {
      const key = rotation?.keys[member]
      if (key) meta.sealedKeys[member] = { ...meta.sealedKeys[member], [String(meta.epoch)]: key }
    }
  }

  private checkFolderRotation(folder: RoomMeta, notes: RoomMeta[], rotation: FolderRotation | undefined, leaving?: string): FolderRotation {
    if (!rotation || rotation.epoch !== folder.epoch + 1) throw new HubError(409, 'the folder moved to another epoch; try again')
    for (const member of Object.keys(folder.members)) {
      if (member !== leaving && typeof rotation.keys?.[member] !== 'string') throw new HubError(400, `the new key for ${member} is missing`)
    }
    this.checkNoteRotations(notes, rotation.notes)
    return rotation
  }

  /** The folder to its next epoch, and every note in it along. */
  private applyFolderRotation(folder: RoomMeta, notes: RoomMeta[], rotation: FolderRotation): void {
    this.moveEpoch(folder, rotation.epoch)
    for (const member of Object.keys(folder.members)) {
      folder.sealedKeys[member] = { ...folder.sealedKeys[member], [String(rotation.epoch)]: rotation.keys[member] as string }
    }
    for (const meta of notes) this.moveNote(meta, rotation.notes?.[roomSubject(meta.room)])
  }

  /** Someone's membership of a folder ends; the notes they reach on their own stay theirs. */
  private dropMember(folder: RoomMeta, notes: RoomMeta[], account: string, now: number): void {
    delete folder.members[account]
    delete folder.sealedKeys[account]
    folder.revoked[account] = now
    for (const meta of notes) {
      if (meta.folder?.from) delete meta.folder.from[account]
      if (!meta.members[account]) delete meta.sealedKeys[account]
    }
  }

  /** What each leaving member could read of each note, taken before anything moves. */
  private keepsFor(notes: RoomMeta[], accounts: string[], reason: ForkReason, now: number): Array<{ room: string; account: string; keep: () => Promise<void> }> {
    const keeps: Array<{ room: string; account: string; keep: () => Promise<void> }> = []
    for (const meta of notes) {
      const open = this.rooms.get(meta.room)
      if (!open) continue
      for (const account of accounts) {
        // A note they have on its own as well stays theirs.
        if (meta.members[account]) continue
        keeps.push({ room: meta.room, account, keep: this.keepForFork(open, account, reason, now) })
      }
    }
    return keeps
  }

  private async finish(
    rooms: RoomMeta[],
    keeps: Array<{ room: string; account: string; keep: () => Promise<void> }>,
    reason: string
  ): Promise<void> {
    // What leaving members could read goes to disk before their access goes.
    for (const { room, account, keep } of keeps) await this.keepSafely(keep, room, account)
    await Promise.all(rooms.map((meta) => this.saveMeta(meta)))
    for (const meta of rooms) this.refreshSubscribers(meta, reason)
  }

  async folderState(account: string, folderId: unknown): Promise<FolderStateResponse> {
    const open = await this.require(this.folderOf(folderId).room)
    const meta = open.log.meta
    const access = this.access(meta, account)
    if (!access || access === 'revoked') throw new HubError(403, 'no access')
    const id = roomSubject(meta.room)
    const response: FolderStateResponse = {
      folderId: id,
      owner: meta.owner,
      epoch: meta.epoch,
      headSeq: open.log.headSeq,
      start: this.startOf(meta),
      members: Object.entries(meta.members)
        .map(([name, member]) => ({ account: name, role: member.role, addedAt: member.addedAt }))
        .sort((a, b) => a.addedAt - b.addedAt)
    }
    if (!access.owner) return response
    const opens = await this.loadNotes(id)
    response.notes = opens.map((note): FolderNoteState => {
      const noteMeta = note.log.meta
      return {
        docId: roomSubject(noteMeta.room),
        epoch: noteMeta.epoch,
        headSeq: note.log.headSeq,
        since: noteMeta.folder?.since ?? 0,
        start: this.startOf(noteMeta),
        members: Object.keys(noteMeta.members)
      }
    })
    this.release(opens)
    return response
  }

  /**
   * Shares the folder with someone, or again with new access. With history
   * they read every note from where it is in the folder; without, from a
   * starting point in each room's current epoch, which the owner's device
   * uploads after moving the folder to a new epoch (`rotateFolder`,
   * `startSnapshot`) - the person is added only once every room has one.
   */
  async shareFolder(owner: string, request: FolderShareRequest): Promise<void> {
    const folderOpen = await this.ownedFolder(owner, request.folderId)
    const folder = folderOpen.log.meta
    const id = roomSubject(folder.room)
    const account = await this.recipient(request.account, owner)
    if (!ROLES.includes(request.role)) throw new HubError(400, 'the role is read or write')
    if (typeof request.title !== 'string') throw new HubError(400, 'the title is missing')
    const opens = await this.loadNotes(id)
    try {
      const notes = this.notesIn(id)
      const keys = request.keys ?? {}
      const starts = new Map<string, number>()
      if (request.withHistory) {
        for (let epoch = 0; epoch <= folder.epoch; epoch += 1) {
          if (typeof keys[String(epoch)] !== 'string') throw new HubError(400, `the key of epoch ${epoch} is missing`)
        }
        for (const meta of notes) {
          if (meta.folder?.since !== 0) continue
          // The epochs before the note joined the folder, under keys the folder's do not open.
          const tied = Object.keys(this.tiesIn(meta, meta.folder.id)).map(Number)
          const first = tied.length > 0 ? Math.min(...tied) : 0
          const docId = roomSubject(meta.room)
          for (let epoch = 0; epoch < first; epoch += 1) {
            if (typeof request.noteKeys?.[docId]?.[String(epoch)] !== 'string') {
              throw new HubError(400, `the key of ${docId} in epoch ${epoch} is missing`)
            }
          }
        }
      } else {
        if (typeof keys[String(folder.epoch)] !== 'string') throw new HubError(400, `the key of epoch ${folder.epoch} is missing`)
        for (const meta of [folder, ...notes]) {
          const start = this.startOf(meta)
          if (start === null) throw new HubError(409, `${meta.room} has no starting point in its current epoch yet`)
          starts.set(meta.room, start)
        }
      }

      const after = (room: string): number => {
        const start = starts.get(room) ?? 0
        return start === 0 ? 0 : start + 1
      }
      const existing = folder.members[account]
      folder.sealedKeys[account] = { ...folder.sealedKeys[account], ...keys }
      const fromSeq = request.withHistory ? 0 : after(folder.room)
      folder.members[account] = {
        role: request.role,
        // Sharing again never takes back history already given.
        fromSeq: Math.min(existing?.fromSeq ?? Number.MAX_SAFE_INTEGER, fromSeq),
        addedAt: existing?.addedAt ?? Date.now(),
        title: request.title,
        acceptedInto: existing?.acceptedInto
      }
      delete folder.revoked[account]
      for (const meta of notes) {
        const place = meta.folder as RoomFolder
        if (request.withHistory) {
          if (place.from) delete place.from[account]
          const sealed = request.noteKeys?.[roomSubject(meta.room)]
          if (sealed) meta.sealedKeys[account] = { ...meta.sealedKeys[account], ...sealed }
        } else if (!existing || place.from?.[account] !== undefined) {
          place.from = { ...place.from, [account]: Math.min(place.from?.[account] ?? Number.MAX_SAFE_INTEGER, after(meta.room)) }
        }
      }
      await Promise.all([folder, ...notes].map((meta) => this.saveMeta(meta)))
      this.notify(account, existing ? 'folder-changed' : 'folder-added', { folderId: id, owner, role: request.role })
    } finally {
      this.release(opens)
    }
  }

  /** The folder to its next epoch, every note in it along - before sharing it without history. */
  async rotateFolder(owner: string, folderId: unknown, rotation: FolderRotation): Promise<void> {
    const folderOpen = await this.ownedFolder(owner, folderId)
    const folder = folderOpen.log.meta
    const id = roomSubject(folder.room)
    const opens = await this.loadNotes(id)
    try {
      const notes = this.notesIn(id)
      this.applyFolderRotation(folder, notes, this.checkFolderRotation(folder, notes, rotation))
      await this.finish([folder, ...notes], [], 'the folder moved to another epoch')
    } finally {
      this.release(opens)
    }
  }

  /** A starting point in a room's current epoch, for someone joining its folder without history. */
  async startSnapshot(owner: string, room: string, request: StartSnapshotRequest): Promise<void> {
    const kind = roomKind(room)
    if ((kind !== 'doc' && kind !== 'fld') || !isHexId(roomSubject(room))) throw new HubError(400, 'only notes and folders have starting points')
    const open = await this.require(room)
    const meta = open.log.meta
    if (meta.owner !== owner) throw new HubError(403, 'only the owner can do that')
    if (kind === 'doc' && !meta.folder) throw new HubError(400, 'the note is not in a shared folder')
    if (request.epoch !== meta.epoch) throw new HubError(409, 'encrypt it under the current epoch')
    const uptoSeq = request.uptoSeq
    if (!Number.isInteger(uptoSeq) || uptoSeq < 1 || uptoSeq < (meta.epochSince ?? 0) || uptoSeq > open.log.headSeq) {
      throw new HubError(409, 'the starting point does not fit the log; try again')
    }
    await open.log.addJoinSnapshot(uptoSeq, request.epoch, fromBase64(request.data, 'the snapshot'))
  }

  /**
   * A note of the owner's joins the folder. Its next epoch is tied to the
   * folder's, and while the folder is shared its history there starts at a
   * snapshot taken at the head - nobody reads what it said before it joined.
   */
  async joinNote(owner: string, folderId: unknown, request: FolderJoinRequest): Promise<void> {
    const folderOpen = await this.ownedFolder(owner, folderId)
    const folder = folderOpen.log.meta
    const id = roomSubject(folder.room)
    const open = await this.owned(owner, request.docId)
    const meta = open.log.meta
    if (meta.folder) {
      if (meta.folder.id === id) return
      throw new HubError(409, 'the note is in another folder')
    }
    if (request.epoch !== meta.epoch + 1) throw new HubError(409, 'the note moved to another epoch; try again')
    if (request.folderEpoch !== folder.epoch) throw new HubError(409, 'the folder moved to another epoch; try again')
    for (const member of Object.keys(meta.members)) {
      if (typeof request.keys?.[member] !== 'string') throw new HubError(400, `the new key for ${member} is missing`)
    }
    const shared = Object.keys(folder.members).length > 0
    const snapshot = request.snapshot
    if (snapshot && snapshot.uptoSeq !== open.log.headSeq) throw new HubError(409, 'the note changed meanwhile; try again')
    if (shared && !snapshot && open.log.headSeq > 0) throw new HubError(400, "the folder's members need a starting point")
    const data = snapshot ? fromBase64(snapshot.data, 'the snapshot') : null

    meta.folder = { id, since: shared && snapshot ? snapshot.uptoSeq + 1 : 0 }
    this.moveEpoch(meta, request.epoch)
    for (const member of Object.keys(meta.members)) {
      meta.sealedKeys[member] = { ...meta.sealedKeys[member], [String(request.epoch)]: request.keys[member] as string }
    }
    this.refreshSubscribers(meta, 'the note joined a shared folder')
    if (snapshot && data) await open.log.addJoinSnapshot(snapshot.uptoSeq, request.epoch, data)
    await open.log.saveMeta()
  }

  /** The owner takes a note out of the folder. Everyone who had it only through the folder keeps it as a fork. */
  async leaveNote(owner: string, folderId: unknown, request: FolderLeaveRequest): Promise<void> {
    const folder = this.folderOf(folderId)
    if (folder.owner !== owner) throw new HubError(403, 'only the owner can do that')
    const id = roomSubject(folder.room)
    const open = await this.owned(owner, request.docId)
    const meta = open.log.meta
    if (meta.folder?.id !== id) throw new HubError(404, 'the note is not in this folder')
    const rotation = request.rotation
    if (!rotation || rotation.epoch !== meta.epoch + 1) throw new HubError(409, 'the note moved to another epoch; try again')
    for (const member of Object.keys(meta.members)) {
      if (typeof rotation.keys?.[member] !== 'string') throw new HubError(400, `the new key for ${member} is missing`)
    }
    const now = Date.now()
    const leaving = Object.keys(folder.members).filter((account) => !meta.members[account])
    const keeps = this.keepsFor([meta], leaving, 'revoked', now)
    // Under the owner's own key again: the folder's members hold the folder's.
    delete meta.folder
    this.moveNote(meta, rotation)
    await this.finish([meta], keeps, 'the note left the shared folder')
    for (const account of leaving) this.notify(account, 'share-removed', { docId: roomSubject(meta.room), owner })
  }

  async revokeFolder(owner: string, folderId: unknown, request: FolderRevokeRequest): Promise<void> {
    const folderOpen = await this.ownedFolder(owner, folderId)
    const folder = folderOpen.log.meta
    const id = roomSubject(folder.room)
    const account = isAccountId(request.account) ? request.account : null
    if (!account || !folder.members[account]) throw new HubError(404, 'not a member')
    const opens = await this.loadNotes(id)
    try {
      const notes = this.notesIn(id)
      if (!folder.members[account]) throw new HubError(404, 'not a member')
      const rotation = this.checkFolderRotation(folder, notes, request.rotation, account)
      const now = Date.now()
      const keeps = this.keepsFor(notes, [account], 'revoked', now)
      this.dropMember(folder, notes, account, now)
      this.applyFolderRotation(folder, notes, rotation)
      await this.finish([folder, ...notes], keeps, 'access was revoked')
      this.notify(account, 'folder-removed', { folderId: id, owner })
    } finally {
      this.release(opens)
    }
  }

  async setFolderRole(owner: string, folderId: unknown, request: FolderRoleRequest): Promise<void> {
    const folderOpen = await this.ownedFolder(owner, folderId)
    const folder = folderOpen.log.meta
    const account = isAccountId(request.account) ? request.account : null
    const member = account ? folder.members[account] : undefined
    if (!account || !member) throw new HubError(404, 'not a member')
    if (!ROLES.includes(request.role)) throw new HubError(400, 'the role is read or write')
    member.role = request.role
    await folderOpen.log.saveMeta()
    this.notify(account, 'folder-changed', { folderId: roomSubject(folder.room), owner, role: request.role })
  }

  async acceptFolder(account: string, folderId: unknown, vaultId: unknown): Promise<void> {
    const folder = this.folderOf(folderId)
    const member = folder.members[account]
    if (!member) throw new HubError(404, 'not shared with you')
    if (typeof vaultId !== 'string' || !isHexId(vaultId)) throw new HubError(400, 'not a vault id')
    member.acceptedInto = vaultId
    await this.saveMeta(folder)
  }

  async incomingFolders(account: string): Promise<IncomingFolder[]> {
    await this.ready
    const folders: IncomingFolder[] = []
    for (const meta of this.metas.values()) {
      const member = meta.members[account]
      if (!member || member.acceptedInto || roomKind(meta.room) !== 'fld') continue
      folders.push({ folderId: roomSubject(meta.room), owner: meta.owner, role: member.role, title: member.title, addedAt: member.addedAt })
    }
    return folders.sort((a, b) => a.addedAt - b.addedAt)
  }

  /** A member keeps the whole folder as their own and leaves it; the server keeps what they read of each note. */
  async detachFolder(account: string, folderId: unknown): Promise<void> {
    const folder = this.folderOf(folderId)
    const id = roomSubject(folder.room)
    if (!folder.members[account]) {
      // Ended already - by another device of theirs, or by the owner.
      if (folder.revoked[account]) return
      throw new HubError(404, 'not shared with you')
    }
    const opens = await this.loadNotes(id)
    try {
      if (!folder.members[account]) return
      const notes = this.notesIn(id)
      const now = Date.now()
      const keeps = this.keepsFor(notes, [account], 'detached', now)
      this.dropMember(folder, notes, account, now)
      await this.finish([folder, ...notes], keeps, 'the share ended')
      this.notify(account, 'folder-removed', { folderId: id, owner: folder.owner })
      this.notify(folder.owner, 'folder-changed', { folderId: id, owner: folder.owner, left: account })
    } finally {
      this.release(opens)
    }
  }

  /** A member leaves the folder - deleted it - and keeps nothing of it. */
  async leaveFolder(account: string, folderId: unknown): Promise<void> {
    const folder = this.folderOf(folderId)
    if (folder.owner === account) throw new HubError(400, 'the owner cannot leave their own folder')
    if (!folder.members[account]) return
    const id = roomSubject(folder.room)
    const notes = this.notesIn(id)
    this.dropMember(folder, notes, account, Date.now())
    await this.finish([folder, ...notes], [], 'the share ended')
    this.notify(folder.owner, 'folder-changed', { folderId: id, owner: folder.owner, left: account })
  }

  /**
   * The owner ends the folder's share for everyone, who each keep the folder
   * as their own. Every note goes back under the owner's own key.
   */
  async endFolder(owner: string, folderId: unknown, request: FolderEndRequest): Promise<void> {
    const folderOpen = await this.ownedFolder(owner, folderId)
    const folder = folderOpen.log.meta
    const id = roomSubject(folder.room)
    const opens = await this.loadNotes(id)
    try {
      const notes = this.notesIn(id)
      this.checkNoteRotations(notes, request.notes)
      const now = Date.now()
      const members = Object.keys(folder.members)
      const keeps = this.keepsFor(notes, members, 'revoked', now)
      for (const account of members) this.dropMember(folder, notes, account, now)
      // Nobody gets the folder's next key: whatever is written into it from now on stays the owner's.
      this.moveEpoch(folder, folder.epoch + 1)
      for (const meta of notes) {
        delete meta.folder
        this.moveNote(meta, request.notes?.[roomSubject(meta.room)])
      }
      await this.finish([folder, ...notes], keeps, 'the share ended')
      for (const account of members) this.notify(account, 'folder-removed', { folderId: id, owner })
    } finally {
      this.release(opens)
    }
  }

  // --- keys and log --------------------------------------------------------------

  private async readable(account: string, room: string): Promise<{ open: OpenRoom; access: Access }> {
    if (!roomKind(room) || !isHexId(roomSubject(room))) throw new HubError(400, 'unknown room')
    const open = await this.require(room)
    const access = this.access(open.log.meta, account)
    if (access === 'revoked') throw new HubError(410, 'access was revoked')
    if (!access) throw new HubError(403, 'no access')
    return { open, access }
  }

  /**
   * Which blobs a shared note's attachment list names. Anyone who may write
   * to the note attaches blobs of their own; the blob's account and the
   * note's owner detach.
   */
  async attachBlobs(account: string, room: string, request: AttachBlobsRequest): Promise<void> {
    const kind = roomKind(room)
    if (kind !== 'doc' && kind !== 'fld') throw new HubError(400, 'only notes and shared folders carry attachments')
    const { open, access } = await this.readable(account, room)
    const toAttach = Array.isArray(request.attach) ? request.attach : []
    const toDetach = Array.isArray(request.detach) ? request.detach : []
    if (toAttach.length > 0 && !access.write) throw new HubError(403, 'read-only members attach nothing')
    const vaults = (await this.accounts.get(account))?.vaults ?? {}
    const key = (ref: unknown): string => {
      const { account: owner, vault, blob } = (ref ?? {}) as Partial<BlobRef>
      if (!isAccountId(owner) || typeof vault !== 'string' || !isHexId(vault) || typeof blob !== 'string' || !isHexId(blob)) {
        throw new HubError(400, 'not a blob reference')
      }
      return `${owner}/${vault}/${blob}`
    }
    // Everything checked before anything changes.
    const adding = toAttach.map((ref) => {
      const k = key(ref)
      if (ref.account !== account || !vaults[ref.vault]) throw new HubError(403, 'only blobs of your own are attached')
      return k
    })
    const removing = toDetach.map((ref) => {
      const k = key(ref)
      if (ref.account !== account && !access.owner) throw new HubError(403, "only the note's owner detaches someone else's blob")
      return k
    })
    const meta = open.log.meta
    const list = new Set(meta.attachments ?? [])
    for (const k of adding) {
      list.add(k)
      this.markAttached(k, room, true)
    }
    for (const k of removing) {
      list.delete(k)
      this.markAttached(k, room, false)
    }
    meta.attachments = Array.from(list)
    await open.log.saveMeta()
  }

  /** Whether `account` may read this blob through a note it can read, whose list names it. */
  async canReadBlob(account: string, room: string, ref: BlobRef): Promise<boolean> {
    try {
      const { open } = await this.readable(account, room)
      return (open.log.meta.attachments ?? []).includes(`${ref.account}/${ref.vault}/${ref.blob}`)
    } catch {
      return false
    }
  }

  async keys(account: string, room: string): Promise<KeysResponse> {
    const { open, access } = await this.readable(account, room)
    const meta = open.log.meta
    const response: KeysResponse = { room, epoch: meta.epoch, keys: access.owner ? {} : { ...meta.sealedKeys[account] } }
    if (meta.ties) response.ties = { ...meta.ties }
    return response
  }

  /** What someone with `access` may read: a starting snapshot and the frames after it. */
  private readablePart(open: OpenRoom, access: Access): { snapshot: SnapshotInfo | null; frames: Frame[] } {
    const meta = open.log.meta
    if (access.fromSeq - 1 > meta.compactedUpTo) {
      return {
        snapshot: meta.snapshots.find((candidate) => candidate.uptoSeq === access.fromSeq - 1) ?? null,
        frames: open.log.frames.filter((frame) => frame.seq >= access.fromSeq)
      }
    }
    return {
      snapshot:
        meta.compactedUpTo > 0 ? (meta.snapshots.find((candidate) => candidate.uptoSeq === meta.compactedUpTo) ?? null) : null,
      frames: open.log.frames.slice()
    }
  }

  private async logResponse(
    open: OpenRoom,
    part: { snapshot: SnapshotInfo | null; frames: Frame[] },
    epoch: number,
    headSeq: number
  ): Promise<LogResponse> {
    const snapshot = part.snapshot
    const snapshotData = snapshot ? await open.log.readSnapshot(snapshot) : null
    return {
      room: open.log.meta.room,
      epoch,
      headSeq,
      snapshot:
        snapshot && snapshotData
          ? { uptoSeq: snapshot.uptoSeq, ts: snapshot.ts, epoch: snapshot.epoch, data: toBase64(snapshotData) }
          : null,
      frames: part.frames.map((frame) => ({ seq: frame.seq, ts: frame.ts, epoch: frame.epoch, data: toBase64(frame.data) }))
    }
  }

  /**
   * Everything the caller may read, for the history view: a starting snapshot
   * and the frames after it. With `from`, only the frames from that seq on -
   * if its frame is still there to show the caller's log is this one.
   */
  async log(account: string, room: string, from?: number): Promise<LogResponse> {
    const { open, access } = await this.readable(account, room)
    const meta = open.log.meta
    if (from !== undefined && Number.isInteger(from) && from >= access.fromSeq && from > meta.compactedUpTo) {
      const start = open.log.frames.findIndex((frame) => frame.seq === from)
      if (start >= 0) {
        const response = await this.logResponse(open, { snapshot: null, frames: open.log.frames.slice(start) }, meta.epoch, open.log.headSeq)
        return { ...response, from }
      }
    }
    return this.logResponse(open, this.readablePart(open, access), meta.epoch, open.log.headSeq)
  }

  // --- backups -------------------------------------------------------------------

  /**
   * Whether a room is part of the account's vault: its index and settings, its
   * own notes, and the notes others shared into it. A backup key reads these
   * and nothing else.
   */
  private belongsTo(meta: RoomMeta, account: string, vault: string): boolean {
    const kind = roomKind(meta.room)
    if (kind === 'idx' || kind === 'set') return meta.owner === account && roomSubject(meta.room) === vault
    if ((meta.owner === account && meta.vaultId === vault) || meta.members[account]?.acceptedInto === vault) return true
    // A note of a folder someone shared into the vault.
    return meta.folder !== undefined && this.metas.get(folderRoom(meta.folder.id))?.members[account]?.acceptedInto === vault
  }

  async inVault(account: string, vault: string, room: string): Promise<boolean> {
    await this.ready
    const meta = this.metas.get(room)
    return meta !== undefined && this.belongsTo(meta, account, vault)
  }

  /**
   * Every room of the vault and a tag that changes with its log, so a backup
   * server asks only for the rooms that changed. From the metadata and the size
   * of the log on disk - no log is loaded for it.
   */
  async backupRooms(account: string, vault: string): Promise<BackupRoom[]> {
    await this.ready
    const rooms: BackupRoom[] = []
    for (const meta of Array.from(this.metas.values())) {
      if (!this.belongsTo(meta, account, vault)) continue
      let bytes = 0
      try {
        bytes = (await stat(join(roomDir(this.options.dataDir, meta), 'log.bin'))).size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const snapshotHead = meta.snapshots.reduce((max, snapshot) => Math.max(max, snapshot.uptoSeq), 0)
      const entry: BackupRoom = {
        room: meta.room,
        owner: meta.owner,
        epoch: meta.epoch,
        compactedUpTo: meta.compactedUpTo,
        tag: `${meta.epoch}.${meta.compactedUpTo}.${snapshotHead}.${bytes}`
      }
      if (meta.ties) entry.ties = { ...meta.ties }
      rooms.push(entry)
    }
    return rooms
  }

  /** The owner's compaction: frames up to `uptoSeq` are replaced by the uploaded state. */
  async snapshot(account: string, room: string, request: SnapshotRequest): Promise<void> {
    const { open, access } = await this.readable(account, room)
    const meta = open.log.meta
    // The owner's retention governs a shared note, and only the owner's client
    // may act on it; anyone else could shorten everybody's history.
    if (!access.owner) throw new HubError(403, 'only the owner compacts')
    if (request.epoch !== meta.epoch) throw new HubError(409, 'encrypt the snapshot under the current epoch')
    if (!Number.isInteger(request.uptoSeq) || request.uptoSeq <= meta.compactedUpTo || request.uptoSeq > open.log.headSeq) {
      throw new HubError(400, 'the snapshot does not fit the log')
    }
    await open.log.compact(request.uptoSeq, request.epoch, fromBase64(request.data, 'the snapshot'))
  }

  /**
   * The owner lets go of a note deleted longer ago than the history
   * retention. Refused while it is shared: the others keep what was shared
   * with them, and the owner deleting it only removed it from their vault. A
   * share that ended does not hold it up - what its participant could read
   * was copied to them when it ended.
   */
  async purge(account: string, room: string): Promise<void> {
    if (roomKind(room) !== 'doc' || !isHexId(roomSubject(room))) throw new HubError(400, 'only notes are purged')
    const open = await this.load(room)
    if (!open) throw new HubError(404, 'no such room')
    const meta = open.log.meta
    if (meta.owner !== account) throw new HubError(403, 'only the owner can do that')
    if (Object.keys(meta.members).length > 0) throw new HubError(409, 'the note is still shared')
    for (const subscriber of open.subscribers) subscriber.sendDenied(room, 'purged')
    open.subscribers.clear()
    if (open.idleTimer) clearTimeout(open.idleTimer)
    this.rooms.delete(room)
    this.metas.delete(room)
    this.forgetAttachments(meta)
    await open.log.remove()
    console.info(`[obsidian-connect] ${room} of ${account} purged, deleted longer ago than the retention`)
  }

  /** Fills a brand-new room with frames, oldest first - a detached note's history. */
  async importFrames(
    account: string,
    room: string,
    vaultId: string,
    frames: Array<{ epoch: number; data: string }>
  ): Promise<number> {
    if (roomKind(room) !== 'doc' || !isHexId(roomSubject(room))) throw new HubError(400, 'only notes can be imported')
    if (!(await this.accounts.get(account))?.vaults[vaultId]) throw new HubError(403, 'not your vault')
    const existing = await this.load(room)
    if (existing && (existing.log.meta.owner !== account || existing.log.headSeq > 0)) {
      throw new HubError(409, 'the room already exists')
    }
    const open = existing ?? (await this.claim(room, account, vaultId))
    if (open.log.meta.owner !== account) throw new HubError(409, 'the room already exists')
    for (const frame of frames) {
      if (frame.epoch !== 0) throw new HubError(400, 'a new room starts in epoch 0')
      await open.log.append(0, fromBase64(frame.data, 'a frame'))
    }
    return open.log.headSeq
  }

  /** The caller's rooms of one vault that hold frames older than `before`. */
  async compactable(account: string, vaultId: string, before: number): Promise<string[]> {
    await this.ready
    const rooms: string[] = []
    for (const meta of this.metas.values()) {
      if (meta.owner !== account || meta.vaultId !== vaultId) continue
      if (meta.oldestFrameTs !== null && meta.oldestFrameTs < before) rooms.push(meta.room)
    }
    return rooms
  }

  /**
   * The rooms of the vault that took a frame at or after `since`, by this
   * server's clock: planning a rollback reads only their history. The time of
   * a room's last frame is the loaded log's, or else when `log.bin` was last
   * written - never earlier than the truth, which is all that matters: a room
   * listed for nothing only costs a read; one left out would be planned wrong.
   * No time is written per frame for it.
   */
  async changedSince(account: string, vault: string, since: number): Promise<string[]> {
    await this.ready
    const rooms: string[] = []
    for (const meta of Array.from(this.metas.values())) {
      if (roomKind(meta.room) !== 'doc' || !this.belongsTo(meta, account, vault)) continue
      const loaded = this.rooms.get(meta.room)?.log.frames.at(-1)?.ts
      let at = loaded ?? 0
      if (loaded === undefined) {
        try {
          at = (await stat(join(roomDir(this.options.dataDir, meta), 'log.bin'))).mtimeMs
        } catch (error) {
          // No frames ever, or all folded into a snapshot that holds no change.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      if (at >= since) rooms.push(meta.room)
    }
    return rooms
  }

  // --- removed accounts ------------------------------------------------------------

  /**
   * Clears what removed accounts left behind: every note they shared ends as
   * if revoked, each participant keeping what they could read; their
   * memberships end; their folder goes. Then lets go of histories whose owner
   * has been gone for 90 days. Runs on start and every few minutes, so the
   * CLI only has to mark an account as removed.
   */
  sweep(now = Date.now()): Promise<void> {
    this.sweeping ??= this.runSweep(now).finally(() => {
      this.sweeping = null
    })
    return this.sweeping
  }

  private async runSweep(now: number): Promise<void> {
    await this.ready
    for (const account of Object.keys(await this.accounts.removed())) {
      try {
        await this.clearAccount(account, now)
        await this.accounts.settleRemoval(account)
        console.info(`[obsidian-connect] removed account ${account}: its shares ended and its data is deleted`)
      } catch (error) {
        console.error(`[obsidian-connect] clearing the removed account ${account} failed; trying again later`, error)
      }
    }
    const expired = await this.forks.expire(now)
    if (expired > 0) console.info(`[obsidian-connect] ${expired} kept share history(s) expired, 90 days after their owner's account went`)
  }

  private async clearAccount(account: string, now: number): Promise<void> {
    if (!isAccountId(account)) return
    this.gone.add(account)
    // Its own devices learn they are signed out, instead of being told every
    // note of theirs was revoked.
    this.disconnect(account)
    // Notes before folders: a note's participants through its folder are
    // found in the folder, which must still be there when the note closes.
    const metas = Array.from(this.metas.values())
    const folders = metas.filter((meta) => roomKind(meta.room) === 'fld')
    for (const meta of [...metas.filter((other) => roomKind(other.room) !== 'fld'), ...folders]) {
      if (meta.owner === account) {
        await this.closeOwnerless(meta, now)
      } else if (meta.members[account] || meta.sealedKeys[account] || meta.folder?.from?.[account] !== undefined) {
        delete meta.members[account]
        delete meta.sealedKeys[account]
        if (meta.folder?.from) delete meta.folder.from[account]
        await this.saveMeta(meta)
      }
    }
    await this.forks.ownerRemoved(account, now)
    await this.contacts.forget(account)
    await this.forks.flush()
    this.forks.forget(account)
    await rm(join(this.options.dataDir, 'users', account), { recursive: true, force: true })
  }

  /** A room whose owner's account was removed: its participants keep their part, then it goes. */
  private async closeOwnerless(meta: RoomMeta, now: number): Promise<void> {
    const isFolder = roomKind(meta.room) === 'fld'
    // A note's participants through its folder too; a folder's own room keeps
    // nothing - its members fork the notes, which they have where they lie.
    const folder = meta.folder ? this.metas.get(folderRoom(meta.folder.id)) : undefined
    const participants = Array.from(new Set([...Object.keys(meta.members), ...Object.keys(folder?.members ?? {})]))
    const open = await this.load(meta.room)
    if (open) {
      if (!isFolder) {
        for (const member of participants) {
          await this.keepSafely(this.keepForFork(open, member, 'owner-removed', now), meta.room, member)
        }
      }
      for (const subscriber of open.subscribers) subscriber.sendRevoked(meta.room, "the owner's account was removed")
      open.subscribers.clear()
      if (open.idleTimer) clearTimeout(open.idleTimer)
      await open.log.flush()
    }
    this.rooms.delete(meta.room)
    this.metas.delete(meta.room)
    this.forgetAttachments(meta)
    for (const member of participants) {
      if (isFolder) this.notify(member, 'folder-removed', { folderId: roomSubject(meta.room), owner: meta.owner })
      else this.notify(member, 'share-removed', { docId: roomSubject(meta.room), owner: meta.owner })
    }
  }

  async shutdown(): Promise<void> {
    for (const open of this.rooms.values()) {
      if (open.idleTimer) clearTimeout(open.idleTimer)
      await open.log.flush()
    }
    this.rooms.clear()
  }
}
