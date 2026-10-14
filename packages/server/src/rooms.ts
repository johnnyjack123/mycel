import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CLOSE_SIGNED_OUT,
  docRoom,
  isHexId,
  roomKind,
  roomSubject,
  type AttachBlobsRequest,
  type BlobRef,
  type ForkReason,
  type ForkResponse,
  type ForkSummary,
  type IncomingShare,
  type KeysResponse,
  type LogResponse,
  type NotifyKind,
  type RevokeRequest,
  type RoleRequest,
  type ShareMembersResponse,
  type Notice,
  type ShareRequest,
  type ShareRole,
  type SnapshotRequest
} from '@obsidian-connect/shared'
import { isAccountId, type AccountStore } from './accounts.js'
import type { ContactStore } from './contacts.js'
import type { ForkStore } from './forks.js'
import { RoomLog, loadAllMeta, type Frame, type RoomMeta, type SnapshotInfo } from './log.js'

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
  sendCaughtUp(room: string, headSeq: number, epoch: number): void
  sendAck(room: string, ref: number, seq: number): void
  sendAwareness(room: string, epoch: number, data: Uint8Array): void
  sendRekey(room: string, epoch: number): void
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

  private access(meta: RoomMeta, account: string): Access | 'revoked' | null {
    if (meta.owner === account) return { owner: true, write: true, fromSeq: 0 }
    const member = meta.members[account]
    if (member) return { owner: false, write: member.role === 'write', fromSeq: member.fromSeq }
    if (meta.revoked[account]) return 'revoked'
    return null
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
  private claim(room: string, owner: string, vaultId: string): Promise<OpenRoom> {
    const open = this.rooms.get(room)
    if (open) return Promise.resolve(open)
    const pending = this.opening.get(room)
    if (pending) return pending.then((result) => result ?? this.claim(room, owner, vaultId))
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
  }

  /**
   * `create`: a missing room is created, owned by the caller. A device asks
   * for that only for its own notes - after a server lost a note someone else
   * owns, claiming it would take it from them.
   */
  async subscribe(client: RoomClient, room: string, afterSeq: number, create = true): Promise<void> {
    const kind = roomKind(room)
    const subject = roomSubject(room)
    if (!kind || !isHexId(subject)) {
      client.sendDenied(room, 'unknown room')
      return
    }
    // The index and settings of a vault only ever travel over that vault's own
    // connection, which the upgrade already checked belongs to this account.
    if (kind !== 'doc' && subject !== client.vaultId) {
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
    const open = loaded ?? (await this.claim(room, client.account, client.vaultId))
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
      client.sendCaughtUp(room, open.log.headSeq, open.log.meta.epoch)
      open.subscribers.add(client)
      if (open.idleTimer) clearTimeout(open.idleTimer)
      open.idleTimer = null
      return
    }
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
      client.sendRekey(room, open.log.meta.epoch)
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
    for (const subscriber of open.subscribers) subscriber.sendRekey(open.log.meta.room, open.log.meta.epoch)
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
      const snapshot = fromBase64(rotation.snapshot.data, 'the snapshot')
      // Before anything is awaited: from here on a push under the old epoch is
      // refused, so nothing lands after the snapshot that the recipient
      // could not decrypt.
      meta.epoch = rotation.epoch
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
    const member = meta.members[account]
    // Never added to a vault, so no device has anything to carry on.
    if (!member?.acceptedInto) return async () => undefined
    const keys = { ...meta.sealedKeys[account] }
    const readable = (epoch: number): boolean => typeof keys[String(epoch)] === 'string'
    const part = this.readablePart(open, { owner: false, write: false, fromSeq: member.fromSeq })
    const frames = part.frames.filter((frame) => readable(frame.epoch))
    const snapshot = part.snapshot && readable(part.snapshot.epoch) ? part.snapshot : null
    const epoch = meta.epoch
    const headSeq = open.log.headSeq
    const summary: ForkSummary = { docId: roomSubject(meta.room), owner: meta.owner, reason, endedAt: now }
    return async () => {
      const log = await this.logResponse(open, { snapshot, frames }, epoch, headSeq)
      await this.forks.put(account, summary, keys, log)
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

    const now = Date.now()
    const keep = this.keepForFork(open, account, 'revoked', now)
    meta.epoch = rotation.epoch
    delete meta.members[account]
    delete meta.sealedKeys[account]
    meta.revoked[account] = now
    for (const member of remaining) {
      meta.sealedKeys[member] = { ...meta.sealedKeys[member], [String(rotation.epoch)]: rotation.keys[member] as string }
    }
    // What the member could read goes to disk before the revocation does: a
    // crash in between leaves them a member, never without their copy.
    await this.keepSafely(keep, meta.room, account)
    await open.log.saveMeta()

    for (const subscriber of Array.from(open.subscribers)) {
      if (subscriber.account === account) {
        subscriber.sendRevoked(meta.room, 'access was revoked')
        open.subscribers.delete(subscriber)
      } else {
        subscriber.sendRekey(meta.room, meta.epoch)
      }
    }
    this.notify(account, 'share-removed', { docId: roomSubject(meta.room), owner })
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
    const keep = this.keepForFork(open, account, 'detached', Date.now())
    delete meta.members[account]
    delete meta.sealedKeys[account]
    await this.keepSafely(keep, room, account)
    await open.log.saveMeta()
    for (const subscriber of Array.from(open.subscribers)) {
      if (subscriber.account !== account) continue
      subscriber.sendRevoked(room, 'the share ended')
      open.subscribers.delete(subscriber)
    }
    this.notify(account, 'share-removed', { docId: subject, owner: meta.owner })
    this.memberLeft(meta)
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
    delete meta.sealedKeys[account]
    await open.log.saveMeta()
    for (const subscriber of Array.from(open.subscribers)) {
      if (subscriber.account === account) open.subscribers.delete(subscriber)
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
      if (!member || member.acceptedInto) continue
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
    if (roomKind(room) !== 'doc') throw new HubError(400, 'only notes carry attachments')
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
    return { room, epoch: meta.epoch, keys: access.owner ? {} : { ...meta.sealedKeys[account] } }
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

  /** Everything the caller may read, for the history view: a starting snapshot and the frames after it. */
  async log(account: string, room: string): Promise<LogResponse> {
    const { open, access } = await this.readable(account, room)
    return this.logResponse(open, this.readablePart(open, access), open.log.meta.epoch, open.log.headSeq)
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
    for (const meta of Array.from(this.metas.values())) {
      if (meta.owner === account) {
        await this.closeOwnerless(meta, now)
      } else if (meta.members[account] || meta.sealedKeys[account]) {
        const open = await this.load(meta.room)
        delete meta.members[account]
        delete meta.sealedKeys[account]
        await open?.log.saveMeta()
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
    const open = await this.load(meta.room)
    if (open) {
      for (const member of Object.keys(meta.members)) {
        await this.keepSafely(this.keepForFork(open, member, 'owner-removed', now), meta.room, member)
      }
      for (const subscriber of open.subscribers) subscriber.sendRevoked(meta.room, "the owner's account was removed")
      open.subscribers.clear()
      if (open.idleTimer) clearTimeout(open.idleTimer)
      await open.log.flush()
    }
    this.rooms.delete(meta.room)
    this.metas.delete(meta.room)
    this.forgetAttachments(meta)
    for (const member of Object.keys(meta.members)) {
      this.notify(member, 'share-removed', { docId: roomSubject(meta.room), owner: meta.owner })
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
