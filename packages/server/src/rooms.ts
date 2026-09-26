import {
  docRoom,
  isHexId,
  roomKind,
  roomSubject,
  type IncomingShare,
  type KeysResponse,
  type LogResponse,
  type NotifyKind,
  type RevokeRequest,
  type RoleRequest,
  type ShareMembersResponse,
  type ShareNotice,
  type ShareRequest,
  type ShareRole,
  type SnapshotRequest
} from '@obsidian-connect/shared'
import { normalizeUsername, type AccountStore } from './accounts.js'
import { RoomLog, loadAllMeta, type Frame, type RoomMeta, type SnapshotInfo } from './log.js'

// The server's side of an end-to-end encrypted vault: it keeps every room's
// frames in order, decides who may read and write, and fans frames out. It
// never holds a document - it could not read one.

/** A connection that wants a room's traffic. One socket may hold many rooms. */
export interface RoomClient {
  readonly username: string
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
  sendNotify(kind: NotifyKind, payload: ShareNotice): void
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
  private readonly ready: Promise<void>

  constructor(
    private readonly options: RoomHubOptions,
    private readonly accounts: AccountStore
  ) {
    this.ready = loadAllMeta(options.dataDir).then((metas) => {
      for (const meta of metas) this.metas.set(meta.room, meta)
    })
  }

  // --- rooms -------------------------------------------------------------------

  private access(meta: RoomMeta, username: string): Access | 'revoked' | null {
    if (meta.owner === username) return { owner: true, write: true, fromSeq: 0 }
    const member = meta.members[username]
    if (member) return { owner: false, write: member.role === 'write', fromSeq: member.fromSeq }
    if (meta.revoked[username]) return 'revoked'
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

  private notify(username: string, kind: NotifyKind, payload: ShareNotice): void {
    for (const client of this.clients) if (client.username === username) client.sendNotify(kind, payload)
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
    if (!loaded && !create) {
      client.sendDenied(room, 'missing')
      return
    }
    const open = loaded ?? (await this.claim(room, client.username, client.vaultId))
    const access = this.access(open.log.meta, client.username)
    if (access === 'revoked') {
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
    const access = this.access(open.log.meta, client.username)
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

  private async recipient(name: unknown, owner: string): Promise<string> {
    const username = normalizeUsername(name)
    const account = username ? await this.accounts.get(username) : undefined
    if (!username || account?.status !== 'active') throw new HubError(404, 'no such person')
    if (username === owner) throw new HubError(400, 'that is you')
    return username
  }

  private rekeyAll(open: OpenRoom): void {
    for (const subscriber of open.subscribers) subscriber.sendRekey(open.log.meta.room, open.log.meta.epoch)
  }

  async share(owner: string, request: ShareRequest): Promise<void> {
    const open = await this.owned(owner, request.docId)
    const meta = open.log.meta
    const username = await this.recipient(request.username, owner)
    if (!ROLES.includes(request.role)) throw new HubError(400, 'the role is read or write')
    if (typeof request.title !== 'string') throw new HubError(400, 'the title is missing')
    const existing = meta.members[username]
    let fromSeq: number

    if (request.withHistory) {
      for (let epoch = 0; epoch <= meta.epoch; epoch += 1) {
        if (typeof request.keys?.[String(epoch)] !== 'string') throw new HubError(400, `the key of epoch ${epoch} is missing`)
      }
      meta.sealedKeys[username] = { ...meta.sealedKeys[username], ...request.keys }
      fromSeq = 0
    } else {
      const rotation = request.rotation
      if (!rotation || rotation.epoch !== meta.epoch + 1) throw new HubError(409, 'the note moved to another epoch; try again')
      if (!rotation.snapshot || rotation.snapshot.uptoSeq !== open.log.headSeq) {
        throw new HubError(409, 'the note changed meanwhile; try again')
      }
      for (const member of [username, ...Object.keys(meta.members).filter((name) => name !== username)]) {
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

    meta.members[username] = {
      role: request.role,
      fromSeq,
      addedAt: existing?.addedAt ?? Date.now(),
      title: request.title,
      acceptedInto: existing?.acceptedInto
    }
    delete meta.revoked[username]
    await open.log.saveMeta()
    this.notify(username, existing ? 'share-changed' : 'share-added', { docId: roomSubject(meta.room), owner, role: request.role })
  }

  async revoke(owner: string, request: RevokeRequest): Promise<void> {
    const open = await this.owned(owner, request.docId)
    const meta = open.log.meta
    const username = normalizeUsername(request.username)
    if (!username || !meta.members[username]) throw new HubError(404, 'not a member')
    const rotation = request.rotation
    if (!rotation || rotation.epoch !== meta.epoch + 1) throw new HubError(409, 'the note moved to another epoch; try again')
    const remaining = Object.keys(meta.members).filter((name) => name !== username)
    for (const member of remaining) {
      if (typeof rotation.keys?.[member] !== 'string') throw new HubError(400, `the new key for ${member} is missing`)
    }

    meta.epoch = rotation.epoch
    delete meta.members[username]
    delete meta.sealedKeys[username]
    meta.revoked[username] = Date.now()
    for (const member of remaining) {
      meta.sealedKeys[member] = { ...meta.sealedKeys[member], [String(rotation.epoch)]: rotation.keys[member] as string }
    }
    await open.log.saveMeta()

    for (const subscriber of Array.from(open.subscribers)) {
      if (subscriber.username === username) {
        subscriber.sendRevoked(meta.room, 'access was revoked')
        open.subscribers.delete(subscriber)
      } else {
        subscriber.sendRekey(meta.room, meta.epoch)
      }
    }
    this.notify(username, 'share-removed', { docId: roomSubject(meta.room), owner })
  }

  async leave(username: string, docId: unknown): Promise<void> {
    const open = await this.require(docRoomOf(docId))
    const meta = open.log.meta
    if (meta.owner === username) throw new HubError(400, 'the owner cannot leave their own note')
    if (!meta.members[username]) return
    delete meta.members[username]
    delete meta.sealedKeys[username]
    await open.log.saveMeta()
    for (const subscriber of Array.from(open.subscribers)) {
      if (subscriber.username === username) open.subscribers.delete(subscriber)
    }
  }

  async setRole(owner: string, request: RoleRequest): Promise<void> {
    const open = await this.owned(owner, request.docId)
    const username = normalizeUsername(request.username)
    const member = username ? open.log.meta.members[username] : undefined
    if (!username || !member) throw new HubError(404, 'not a member')
    if (!ROLES.includes(request.role)) throw new HubError(400, 'the role is read or write')
    member.role = request.role
    await open.log.saveMeta()
    this.notify(username, 'share-changed', { docId: roomSubject(open.log.meta.room), owner, role: request.role })
  }

  async accept(username: string, docId: unknown, vaultId: unknown): Promise<void> {
    const open = await this.require(docRoomOf(docId))
    const member = open.log.meta.members[username]
    if (!member) throw new HubError(404, 'not shared with you')
    if (typeof vaultId !== 'string' || !isHexId(vaultId)) throw new HubError(400, 'not a vault id')
    member.acceptedInto = vaultId
    await open.log.saveMeta()
  }

  async incoming(username: string): Promise<IncomingShare[]> {
    await this.ready
    const shares: IncomingShare[] = []
    for (const meta of this.metas.values()) {
      const member = meta.members[username]
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

  async members(username: string, docId: unknown): Promise<ShareMembersResponse> {
    const open = await this.require(docRoomOf(docId))
    const meta = open.log.meta
    if (!this.access(meta, username) || this.access(meta, username) === 'revoked') throw new HubError(403, 'no access')
    return {
      docId: roomSubject(meta.room),
      owner: meta.owner,
      epoch: meta.epoch,
      members: Object.entries(meta.members)
        .map(([name, member]) => ({ username: name, role: member.role, addedAt: member.addedAt }))
        .sort((a, b) => a.addedAt - b.addedAt)
    }
  }

  // --- keys and log --------------------------------------------------------------

  private async readable(username: string, room: string): Promise<{ open: OpenRoom; access: Access }> {
    if (!roomKind(room) || !isHexId(roomSubject(room))) throw new HubError(400, 'unknown room')
    const open = await this.require(room)
    const access = this.access(open.log.meta, username)
    if (access === 'revoked') throw new HubError(410, 'access was revoked')
    if (!access) throw new HubError(403, 'no access')
    return { open, access }
  }

  async keys(username: string, room: string): Promise<KeysResponse> {
    const { open, access } = await this.readable(username, room)
    const meta = open.log.meta
    return { room, epoch: meta.epoch, keys: access.owner ? {} : { ...meta.sealedKeys[username] } }
  }

  /** Everything the caller may read, for the history view: a starting snapshot and the frames after it. */
  async log(username: string, room: string): Promise<LogResponse> {
    const { open, access } = await this.readable(username, room)
    const meta = open.log.meta
    let snapshot: SnapshotInfo | null = null
    let frames: Frame[]
    if (access.fromSeq - 1 > meta.compactedUpTo) {
      snapshot = meta.snapshots.find((candidate) => candidate.uptoSeq === access.fromSeq - 1) ?? null
      frames = open.log.frames.filter((frame) => frame.seq >= access.fromSeq)
    } else {
      snapshot =
        meta.compactedUpTo > 0
          ? (meta.snapshots.find((candidate) => candidate.uptoSeq === meta.compactedUpTo) ?? null)
          : null
      frames = open.log.frames.slice()
    }
    const snapshotData = snapshot ? await open.log.readSnapshot(snapshot) : null
    return {
      room,
      epoch: meta.epoch,
      headSeq: open.log.headSeq,
      snapshot:
        snapshot && snapshotData
          ? { uptoSeq: snapshot.uptoSeq, ts: snapshot.ts, epoch: snapshot.epoch, data: toBase64(snapshotData) }
          : null,
      frames: frames.map((frame) => ({ seq: frame.seq, ts: frame.ts, epoch: frame.epoch, data: toBase64(frame.data) }))
    }
  }

  /** The owner's compaction: frames up to `uptoSeq` are replaced by the uploaded state. */
  async snapshot(username: string, room: string, request: SnapshotRequest): Promise<void> {
    const { open, access } = await this.readable(username, room)
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

  /** Fills a brand-new room with frames, oldest first - a detached note's history. */
  async importFrames(
    username: string,
    room: string,
    vaultId: string,
    frames: Array<{ epoch: number; data: string }>
  ): Promise<number> {
    if (roomKind(room) !== 'doc' || !isHexId(roomSubject(room))) throw new HubError(400, 'only notes can be imported')
    const account = await this.accounts.get(username)
    if (!account?.vaults[vaultId]) throw new HubError(403, 'not your vault')
    const existing = await this.load(room)
    if (existing && (existing.log.meta.owner !== username || existing.log.headSeq > 0)) {
      throw new HubError(409, 'the room already exists')
    }
    const open = existing ?? (await this.claim(room, username, vaultId))
    if (open.log.meta.owner !== username) throw new HubError(409, 'the room already exists')
    for (const frame of frames) {
      if (frame.epoch !== 0) throw new HubError(400, 'a new room starts in epoch 0')
      await open.log.append(0, fromBase64(frame.data, 'a frame'))
    }
    return open.log.headSeq
  }

  /** The caller's rooms of one vault that hold frames older than `before`. */
  async compactable(username: string, vaultId: string, before: number): Promise<string[]> {
    await this.ready
    const rooms: string[] = []
    for (const meta of this.metas.values()) {
      if (meta.owner !== username || meta.vaultId !== vaultId) continue
      if (meta.oldestFrameTs !== null && meta.oldestFrameTs < before) rooms.push(meta.room)
    }
    return rooms
  }

  async shutdown(): Promise<void> {
    for (const open of this.rooms.values()) {
      if (open.idleTimer) clearTimeout(open.idleTimer)
      await open.log.flush()
    }
    this.rooms.clear()
  }
}
