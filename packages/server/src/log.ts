import { appendFile, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isHexId, roomKind, roomSubject, type ShareRole } from '@obsidian-connect/shared'

// One room on disk: `meta.json` with who may do what, `log.bin` with the
// frames, and `snap-<uptoSeq>.bin` for each snapshot still needed. The server
// cannot read any of it - frames and snapshots are ciphertext - so it keeps
// order and access, nothing else.
//
// Frame layout: [8B seq][8B ts][4B epoch][4B length][ciphertext].

export interface Frame {
  seq: number
  ts: number
  epoch: number
  data: Uint8Array
}

export interface SnapshotInfo {
  /** The state after every frame up to and including this seq. */
  uptoSeq: number
  ts: number
  epoch: number
  /** `compaction`: uploaded by the owner to replace old frames. `join`: a member's starting point. */
  kind: 'compaction' | 'join'
}

export interface Member {
  role: ShareRole
  /** The first frame this member may read; 0 means the whole history. */
  fromSeq: number
  addedAt: number
  /** The owner's name for the note, sealed to the member. */
  title: string
  /** The recipient's vault the share was accepted into. */
  acceptedInto?: string
}

export interface RoomMeta {
  room: string
  owner: string
  /** The owner's vault the room was created from. */
  vaultId: string
  createdAt: number
  epoch: number
  /** Frames up to here were folded into a compaction snapshot. */
  compactedUpTo: number
  /** Timestamp of the oldest frame still in the log, if any. */
  oldestFrameTs: number | null
  members: Record<string, Member>
  revoked: Record<string, number>
  /** account id -> epoch -> that epoch's key sealed to them. */
  sealedKeys: Record<string, Record<string, string>>
  snapshots: SnapshotInfo[]
  /**
   * Blobs the note's attachment list names, as `account/vault/blob`: whoever
   * may read the note may read these, and nobody may purge them meanwhile.
   */
  attachments?: string[]
  /** The head when the current epoch began; every frame after it is in that epoch. */
  epochSince?: number
  /** A note in a shared folder: the folder's members reach it through the folder. */
  folder?: RoomFolder
}

/** A note's place in a shared folder, as the server keeps it. */
export interface RoomFolder {
  id: string
  /** Where the folder's members start reading the note: 0 when it was born in the folder or joined with its history. */
  since: number
  /** Members who joined the folder without history start later: account -> their first seq. */
  from?: Record<string, number>
  /** The note's epochs that belong to the folder, each with the folder epoch its key derives from. */
  epochs: Record<string, number>
}

const HEADER_BYTES = 8 + 8 + 4 + 4

function encodeFrame(frame: Frame): Buffer {
  const header = Buffer.alloc(HEADER_BYTES)
  header.writeBigUInt64BE(BigInt(frame.seq), 0)
  header.writeBigUInt64BE(BigInt(frame.ts), 8)
  header.writeUInt32BE(frame.epoch, 16)
  header.writeUInt32BE(frame.data.length, 20)
  return Buffer.concat([header, Buffer.from(frame.data)])
}

function decodeFrames(buffer: Buffer): Frame[] {
  const frames: Frame[] = []
  let offset = 0
  while (offset + HEADER_BYTES <= buffer.length) {
    const seq = Number(buffer.readBigUInt64BE(offset))
    const ts = Number(buffer.readBigUInt64BE(offset + 8))
    const epoch = buffer.readUInt32BE(offset + 16)
    const length = buffer.readUInt32BE(offset + 20)
    const end = offset + HEADER_BYTES + length
    // A torn tail can only come from a crash mid-append. Every complete frame
    // before it stays readable.
    if (end > buffer.length) break
    frames.push({ seq, ts, epoch, data: new Uint8Array(buffer.subarray(offset + HEADER_BYTES, end)) })
    offset = end
  }
  return frames
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temp = `${path}.tmp`
  await writeFile(temp, data)
  await rename(temp, path)
}

const USERS = 'users'
const NOTES = 'notes'
const FOLDERS = 'folders'

/**
 * `users/<owner>/<vaultId>/{index,settings,notes/<docId>,folders/<folderId>}`:
 * everything an account owns under one folder, so removing an account removes
 * a folder and a person can find their own data by the ids the plugin shows. A
 * shared note lives with its owner only; everyone else's index merely points
 * at it.
 */
export function roomDir(dataDir: string, meta: Pick<RoomMeta, 'room' | 'owner' | 'vaultId'>): string {
  const vault = join(dataDir, USERS, meta.owner, meta.vaultId)
  const kind = roomKind(meta.room)
  if (kind === 'idx') return join(vault, 'index')
  if (kind === 'set') return join(vault, 'settings')
  if (kind === 'fld') return join(vault, FOLDERS, roomSubject(meta.room))
  return join(vault, NOTES, roomSubject(meta.room))
}

// One queue of writes per room directory, shared by an open room's log and by
// metadata saved while the room is not open - a folder's epoch moves every
// note in it, open or not - so two writes of one room never interleave.
const writeQueues = new Map<string, Promise<unknown>>()

function queueWrite<T>(dir: string, room: string, task: () => Promise<T>): Promise<T> {
  const run = (writeQueues.get(dir) ?? Promise.resolve()).then(task)
  const settled = run.catch((error) => {
    console.error(`[obsidian-connect] writing ${room} failed`, error)
  })
  writeQueues.set(dir, settled)
  void settled.then(() => {
    if (writeQueues.get(dir) === settled) writeQueues.delete(dir)
  })
  return run
}

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Every room's metadata, for questions that span rooms: incoming shares, compaction. */
export async function loadAllMeta(dataDir: string): Promise<RoomMeta[]> {
  const metas: RoomMeta[] = []
  const read = async (dir: string): Promise<void> => {
    const raw = await readOptional(join(dir, 'meta.json'))
    if (raw) metas.push(JSON.parse(raw.toString('utf8')) as RoomMeta)
  }
  for (const owner of await list(join(dataDir, USERS))) {
    if (!isHexId(owner)) continue
    // Next to the vaults sits `forks/`, which holds no rooms.
    for (const vault of await list(join(dataDir, USERS, owner))) {
      if (!isHexId(vault)) continue
      const base = join(dataDir, USERS, owner, vault)
      await read(join(base, 'index'))
      await read(join(base, 'settings'))
      for (const docId of await list(join(base, NOTES))) await read(join(base, NOTES, docId))
      for (const folderId of await list(join(base, FOLDERS))) await read(join(base, FOLDERS, folderId))
    }
  }
  return metas
}

/** Saves a room's metadata without opening its log. */
export function saveMetaOf(dataDir: string, meta: RoomMeta): Promise<void> {
  const dir = roomDir(dataDir, meta)
  const json = JSON.stringify(meta, null, 2)
  return queueWrite(dir, meta.room, async () => {
    await mkdir(dir, { recursive: true })
    await writeAtomic(join(dir, 'meta.json'), json)
  })
}

export class RoomLog {
  private constructor(
    private readonly dir: string,
    readonly meta: RoomMeta,
    /** In seq order. Only frames after `compactedUpTo`. */
    readonly frames: Frame[]
  ) {}

  static async load(dataDir: string, meta: RoomMeta): Promise<RoomLog> {
    const dir = roomDir(dataDir, meta)
    const raw = await readOptional(join(dir, 'log.bin'))
    const frames = raw ? decodeFrames(raw).filter((frame) => frame.seq > meta.compactedUpTo) : []
    return new RoomLog(dir, meta, frames)
  }

  static async create(dataDir: string, meta: RoomMeta): Promise<RoomLog> {
    const log = new RoomLog(roomDir(dataDir, meta), meta, [])
    await log.saveMeta()
    return log
  }

  get headSeq(): number {
    const last = this.frames[this.frames.length - 1]
    const snapshotHead = this.meta.snapshots.reduce((max, snapshot) => Math.max(max, snapshot.uptoSeq), 0)
    return Math.max(last?.seq ?? 0, this.meta.compactedUpTo, snapshotHead)
  }

  /** Serialized, so appends and rewrites never interleave on disk. */
  private queue<T>(task: () => Promise<T>): Promise<T> {
    return queueWrite(this.dir, this.meta.room, task)
  }

  saveMeta(): Promise<void> {
    const meta = JSON.stringify(this.meta, null, 2)
    return this.queue(async () => {
      await mkdir(this.dir, { recursive: true })
      await writeAtomic(join(this.dir, 'meta.json'), meta)
    })
  }

  /** Assigns the next seq and stores the frame. Resolves once it is on disk. */
  append(epoch: number, data: Uint8Array, ts = Date.now()): Promise<Frame> {
    const frame: Frame = { seq: this.headSeq + 1, ts, epoch, data }
    this.frames.push(frame)
    const first = this.meta.oldestFrameTs === null
    if (first) this.meta.oldestFrameTs = ts
    return this.queue(async () => {
      await mkdir(this.dir, { recursive: true })
      await appendFile(join(this.dir, 'log.bin'), encodeFrame(frame))
      if (first) await writeAtomic(join(this.dir, 'meta.json'), JSON.stringify(this.meta, null, 2))
      return frame
    })
  }

  private snapshotFile(uptoSeq: number): string {
    return join(this.dir, `snap-${uptoSeq}.bin`)
  }

  readSnapshot(info: SnapshotInfo): Promise<Buffer | null> {
    return readOptional(this.snapshotFile(info.uptoSeq))
  }

  /** A member's starting point: the note at `uptoSeq`, under the epoch they start in. */
  addJoinSnapshot(uptoSeq: number, epoch: number, data: Uint8Array): Promise<void> {
    return this.queue(async () => {
      await mkdir(this.dir, { recursive: true })
      await writeAtomic(this.snapshotFile(uptoSeq), data)
      this.meta.snapshots = this.meta.snapshots.filter((snapshot) => snapshot.uptoSeq !== uptoSeq)
      this.meta.snapshots.push({ uptoSeq, ts: Date.now(), epoch, kind: 'join' })
      await writeAtomic(join(this.dir, 'meta.json'), JSON.stringify(this.meta, null, 2))
    })
  }

  /**
   * Replaces every frame up to `uptoSeq` with the owner's snapshot of that
   * state. The frames are only dropped once the snapshot is on disk, and a
   * member's join snapshot survives while its point lies after this one.
   */
  compact(uptoSeq: number, epoch: number, data: Uint8Array): Promise<void> {
    return this.queue(async () => {
      await mkdir(this.dir, { recursive: true })
      await writeAtomic(this.snapshotFile(uptoSeq), data)

      const kept = this.frames.filter((frame) => frame.seq > uptoSeq)
      await writeAtomic(join(this.dir, 'log.bin'), Buffer.concat(kept.map(encodeFrame)))
      this.frames.splice(0, this.frames.length, ...kept)

      const superseded = this.meta.snapshots.filter((snapshot) => snapshot.uptoSeq < uptoSeq)
      this.meta.snapshots = this.meta.snapshots.filter((snapshot) => snapshot.uptoSeq > uptoSeq)
      this.meta.snapshots.push({ uptoSeq, ts: Date.now(), epoch, kind: 'compaction' })
      this.meta.compactedUpTo = uptoSeq
      this.meta.oldestFrameTs = kept[0]?.ts ?? null
      await writeAtomic(join(this.dir, 'meta.json'), JSON.stringify(this.meta, null, 2))

      for (const snapshot of superseded) {
        await unlink(this.snapshotFile(snapshot.uptoSeq)).catch(() => undefined)
      }
    })
  }

  /**
   * What someone who may read from `fromSeq` and already has everything up to
   * `afterSeq` needs: a snapshot when frames they lack are gone or lie before
   * their start, then the frames after it.
   */
  catchUp(fromSeq: number, afterSeq: number): { snapshot: SnapshotInfo | null; frames: Frame[] } {
    if (afterSeq >= Math.max(this.meta.compactedUpTo, fromSeq - 1)) {
      return { snapshot: null, frames: this.frames.filter((frame) => frame.seq > afterSeq && frame.seq >= fromSeq) }
    }
    const readable = this.meta.snapshots
      .filter((snapshot) => snapshot.uptoSeq >= fromSeq - 1)
      .sort((a, b) => b.uptoSeq - a.uptoSeq)
    const snapshot = readable[0] ?? null
    const after = snapshot ? snapshot.uptoSeq : Math.max(afterSeq, fromSeq - 1)
    return { snapshot, frames: this.frames.filter((frame) => frame.seq > after && frame.seq >= fromSeq) }
  }

  flush(): Promise<unknown> {
    return writeQueues.get(this.dir) ?? Promise.resolve()
  }

  /** Deletes the room from disk, once everything queued has been written. */
  remove(): Promise<void> {
    return this.queue(() => rm(this.dir, { recursive: true, force: true }))
  }
}
