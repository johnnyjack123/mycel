import { readFile, readdir, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isHexId, roomKind, roomSubject, type FolderTie, type ShareRole } from '@obsidian-connect/shared'
import { appendDurable, ensureDir, truncateDurable, writeDurable } from './durable.js'

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
  /**
   * The note's epochs spent in a shared folder, each with the folder and the
   * folder epoch its key derives from. Kept after the note left the folder:
   * its owner still reads those epochs.
   */
  ties?: Record<string, FolderTie>
}

/** A note's place in a shared folder, as the server keeps it. */
export interface RoomFolder {
  id: string
  /** Where the folder's members start reading the note: 0 when it was born in the folder or joined with its history. */
  since: number
  /** Members who joined the folder without history start later: account -> their first seq. */
  from?: Record<string, number>
}

const HEADER_BYTES = 8 + 8 + 4 + 4
// Far above anything a socket carries: a length beyond it is garbage, not a frame.
const MAX_FRAME_BYTES = 256 * 1024 * 1024

function encodeFrame(frame: Frame): Buffer {
  const header = Buffer.alloc(HEADER_BYTES)
  header.writeBigUInt64BE(BigInt(frame.seq), 0)
  header.writeBigUInt64BE(BigInt(frame.ts), 8)
  header.writeUInt32BE(frame.epoch, 16)
  header.writeUInt32BE(frame.data.length, 20)
  return Buffer.concat([header, Buffer.from(frame.data)])
}

/**
 * The whole frames at the start of a log, and how many bytes they take. Frames
 * follow one another seq by seq; whatever does not - a frame torn by a crash
 * mid-append, the garbage a power cut leaves at the end of a file - ends the
 * log there.
 */
export function decodeFrames(buffer: Buffer): { frames: Frame[]; bytes: number } {
  const frames: Frame[] = []
  let offset = 0
  while (offset + HEADER_BYTES <= buffer.length) {
    const seq = Number(buffer.readBigUInt64BE(offset))
    const ts = Number(buffer.readBigUInt64BE(offset + 8))
    const epoch = buffer.readUInt32BE(offset + 16)
    const length = buffer.readUInt32BE(offset + 20)
    const end = offset + HEADER_BYTES + length
    if (length > MAX_FRAME_BYTES || end > buffer.length || seq < 1 || !Number.isSafeInteger(seq)) break
    const previous = frames[frames.length - 1]
    // Before 0.9.1 a push during a compaction was written twice; the second copy is the same frame.
    if (previous && seq === previous.seq) {
      offset = end
      continue
    }
    if (previous && seq !== previous.seq + 1) break
    frames.push({ seq, ts, epoch, data: new Uint8Array(buffer.subarray(offset + HEADER_BYTES, end)) })
    offset = end
  }
  return { frames, bytes: offset }
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
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

/** Every room's queued writes, open or not - what shutting down waits for. */
export async function flushAllWrites(): Promise<void> {
  while (writeQueues.size > 0) await Promise.all(Array.from(writeQueues.values()))
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
    await ensureDir(dir)
    await writeDurable(join(dir, 'meta.json'), json)
  })
}

/**
 * The last seq of a room that is not loaded: its last whole frame on disk, or
 * the snapshots and compaction beyond it. Read from the frames' headers.
 */
export async function headSeqOf(dataDir: string, meta: RoomMeta): Promise<number> {
  const raw = await readOptional(join(roomDir(dataDir, meta), 'log.bin'))
  let last = 0
  let offset = 0
  while (raw && offset + HEADER_BYTES <= raw.length) {
    const end = offset + HEADER_BYTES + raw.readUInt32BE(offset + 20)
    if (end > raw.length) break
    last = Number(raw.readBigUInt64BE(offset))
    offset = end
  }
  const snapshotHead = meta.snapshots.reduce((max, snapshot) => Math.max(max, snapshot.uptoSeq), 0)
  return Math.max(last, meta.compactedUpTo, snapshotHead)
}

/**
 * When each frame of a room arrived, read from `log.bin` without its content
 * and without loading the room. Frames a snapshot folded in are left out.
 */
export async function frameTimesOf(dataDir: string, meta: RoomMeta): Promise<Array<{ seq: number; ts: number }>> {
  const raw = await readOptional(join(roomDir(dataDir, meta), 'log.bin'))
  const times: Array<{ seq: number; ts: number }> = []
  let offset = 0
  while (raw && offset + HEADER_BYTES <= raw.length) {
    const seq = Number(raw.readBigUInt64BE(offset))
    const ts = Number(raw.readBigUInt64BE(offset + 8))
    const end = offset + HEADER_BYTES + raw.readUInt32BE(offset + 20)
    // A frame still being appended.
    if (end > raw.length) break
    if (seq > meta.compactedUpTo) times.push({ seq, ts })
    offset = end
  }
  return times
}

export class RoomLog {
  /** Frames handed to `append` and not on the disk yet. */
  private pending = 0
  /** A write failed and could not be undone: the bytes after `bytes` are not to be trusted. */
  private damaged = false

  private constructor(
    private readonly dir: string,
    readonly meta: RoomMeta,
    /** In seq order. Only frames after `compactedUpTo`, and only once they are on the disk. */
    readonly frames: Frame[],
    /** How long `log.bin` is: its whole frames, nothing after them. */
    private bytes: number
  ) {}

  private get logFile(): string {
    return join(this.dir, 'log.bin')
  }

  /**
   * Reads the log, and cuts off whatever follows its last whole frame: a frame
   * torn by a crash stayed in the file, and the next one appended behind it
   * was read through the torn one's length - garbage from there on.
   */
  static async load(dataDir: string, meta: RoomMeta): Promise<RoomLog> {
    const dir = roomDir(dataDir, meta)
    const file = join(dir, 'log.bin')
    // A room let go a moment ago may still be writing: read what it wrote, not
    // what was there before - or the next frame here takes a seq it already used.
    while (writeQueues.has(dir)) await writeQueues.get(dir)
    const raw = await readOptional(file)
    const { frames, bytes } = raw ? decodeFrames(raw) : { frames: [], bytes: 0 }
    if (raw && bytes < raw.length) {
      console.warn(`[obsidian-connect] ${meta.room}: ${raw.length - bytes} byte(s) at the end of its log are no whole frame; cut off`)
      await truncateDurable(file, bytes)
    }
    return new RoomLog(
      dir,
      meta,
      frames.filter((frame) => frame.seq > meta.compactedUpTo),
      bytes
    )
  }

  static async create(dataDir: string, meta: RoomMeta): Promise<RoomLog> {
    const log = new RoomLog(roomDir(dataDir, meta), meta, [], 0)
    await log.saveMeta()
    return log
  }

  /** The last seq whose frame is on the disk - or folded into a snapshot. What a reader is given. */
  get writtenSeq(): number {
    const last = this.frames[this.frames.length - 1]
    const snapshotHead = this.meta.snapshots.reduce((max, snapshot) => Math.max(max, snapshot.uptoSeq), 0)
    return Math.max(last?.seq ?? 0, this.meta.compactedUpTo, snapshotHead)
  }

  /**
   * The head counting frames still being written: what a starting point, a
   * compaction or an epoch has to reach. A frame under the old epoch landing
   * after a new one began could not be read by whoever starts there.
   */
  get headSeq(): number {
    return this.writtenSeq + this.pending
  }

  /** Nothing being written: the room can be let go without losing what is under way. */
  get idle(): boolean {
    return this.pending === 0 && !writeQueues.has(this.dir)
  }

  /** Serialized, so appends and rewrites never interleave on disk. */
  private queue<T>(task: () => Promise<T>): Promise<T> {
    return queueWrite(this.dir, this.meta.room, task)
  }

  private writeMeta(): Promise<void> {
    return writeDurable(join(this.dir, 'meta.json'), JSON.stringify(this.meta, null, 2))
  }

  saveMeta(): Promise<void> {
    const meta = JSON.stringify(this.meta, null, 2)
    return this.queue(async () => {
      await ensureDir(this.dir)
      await writeDurable(join(this.dir, 'meta.json'), meta)
    })
  }

  /**
   * Stores a frame and resolves once it is on the disk - only then is it
   * acknowledged, and only then can anyone read it: a frame read before a
   * crash took it away came back under the same seq with other content.
   */
  async append(epoch: number, data: Uint8Array, ts = Date.now()): Promise<Frame> {
    const [frame] = await this.appendAll(epoch, [data], ts)
    return frame as Frame
  }

  /** Several frames at once, with one sync - a detached note's history. */
  appendAll(epoch: number, datas: Uint8Array[], ts = Date.now()): Promise<Frame[]> {
    this.pending += datas.length
    return this.queue(async () => {
      try {
        // Numbered as they are written: a write that failed leaves no gap.
        const first = this.writtenSeq + 1
        const frames = datas.map((data, index): Frame => ({ seq: first + index, ts, epoch, data }))
        const encoded = Buffer.concat(frames.map(encodeFrame))
        await ensureDir(this.dir)
        if (this.damaged) await this.repair()
        try {
          await appendDurable(this.logFile, encoded, this.bytes === 0)
        } catch (error) {
          await this.repair().catch(() => {
            this.damaged = true
          })
          throw error
        }
        this.bytes += encoded.length
        this.frames.push(...frames)
        if (this.meta.oldestFrameTs === null) {
          this.meta.oldestFrameTs = ts
          await this.writeMeta()
        }
        return frames
      } finally {
        this.pending -= datas.length
      }
    })
  }

  /** Cuts the log back to its whole frames after a write that failed partway. */
  private async repair(): Promise<void> {
    await truncateDurable(this.logFile, this.bytes)
    this.damaged = false
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
      await ensureDir(this.dir)
      await writeDurable(this.snapshotFile(uptoSeq), data)
      this.meta.snapshots = this.meta.snapshots.filter((snapshot) => snapshot.uptoSeq !== uptoSeq)
      this.meta.snapshots.push({ uptoSeq, ts: Date.now(), epoch, kind: 'join' })
      await this.writeMeta()
    })
  }

  /**
   * Replaces every frame up to `uptoSeq` with the owner's snapshot of that
   * state, a member's join snapshot surviving while its point lies after this
   * one. In the order a crash anywhere between survives: the snapshot, then
   * the metadata naming it - loading drops the frames it folded in from then
   * on -, then the log without them. Written from the frames on the disk: the
   * appends queued before it are, and no later one is yet.
   */
  compact(uptoSeq: number, epoch: number, data: Uint8Array): Promise<void> {
    return this.queue(async () => {
      await ensureDir(this.dir)
      await writeDurable(this.snapshotFile(uptoSeq), data)

      const kept = this.frames.filter((frame) => frame.seq > uptoSeq)
      const superseded = this.meta.snapshots.filter((snapshot) => snapshot.uptoSeq < uptoSeq)
      this.meta.snapshots = this.meta.snapshots.filter((snapshot) => snapshot.uptoSeq > uptoSeq)
      this.meta.snapshots.push({ uptoSeq, ts: Date.now(), epoch, kind: 'compaction' })
      this.meta.compactedUpTo = uptoSeq
      this.meta.oldestFrameTs = kept[0]?.ts ?? null
      await this.writeMeta()

      const log = Buffer.concat(kept.map(encodeFrame))
      await writeDurable(this.logFile, log)
      this.bytes = log.length
      this.damaged = false
      this.frames.splice(0, this.frames.length, ...kept)

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
