import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CONTENT_FIELD, type HistoryVersion } from '@obsidian-connect/shared'
import { Y } from './yjs.js'

// Every room is stored as a base snapshot plus an append-only log of the raw
// Yjs updates that followed it. Replaying the log to a point in time
// reconstructs the document as it was then, which is what makes per-note
// rollback possible at all - a single overwritten state file cannot.
//
// Frame layout: [8 bytes BE timestamp][4 bytes BE length][update].
const TIMESTAMP_BYTES = 8
const LENGTH_BYTES = 4
const HEADER_BYTES = TIMESTAMP_BYTES + LENGTH_BYTES

const SNAPSHOT_FILE = 'snapshot.bin'
const LOG_FILE = 'log.bin'

interface Frame {
  ts: number
  update: Uint8Array
}

function encodeFrame(ts: number, update: Uint8Array): Buffer {
  const header = Buffer.alloc(HEADER_BYTES)
  header.writeBigUInt64BE(BigInt(ts), 0)
  header.writeUInt32BE(update.length, TIMESTAMP_BYTES)
  return Buffer.concat([header, Buffer.from(update)])
}

function decodeFrames(buffer: Buffer): Frame[] {
  const frames: Frame[] = []
  let offset = 0
  while (offset + HEADER_BYTES <= buffer.length) {
    const ts = Number(buffer.readBigUInt64BE(offset))
    const length = buffer.readUInt32BE(offset + TIMESTAMP_BYTES)
    const end = offset + HEADER_BYTES + length
    // A torn tail can only happen if the process died mid-append. Stopping
    // here keeps every complete frame before it readable.
    if (end > buffer.length) break
    frames.push({ ts, update: new Uint8Array(buffer.subarray(offset + HEADER_BYTES, end)) })
    offset = end
  }
  return frames
}

export class HistoryStore {
  private writes: Promise<void> = Promise.resolve()
  private ensured = false

  constructor(private readonly dir: string) {}

  private async ensureDir(): Promise<void> {
    if (this.ensured) return
    await mkdir(this.dir, { recursive: true })
    this.ensured = true
  }

  private async readSnapshot(): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(join(this.dir, SNAPSHOT_FILE)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return null
    }
  }

  private async readFrames(): Promise<Frame[]> {
    try {
      return decodeFrames(await readFile(join(this.dir, LOG_FILE)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return []
    }
  }

  /** Brings a freshly created document up to the stored state. */
  async load(doc: Y.Doc): Promise<void> {
    const snapshot = await this.readSnapshot()
    const frames = await this.readFrames()
    doc.transact(() => {
      if (snapshot) Y.applyUpdate(doc, snapshot, 'history')
      for (const frame of frames) Y.applyUpdate(doc, frame.update, 'history')
    }, 'history')
  }

  /** Appends one update. Serialized so concurrent edits cannot interleave. */
  append(update: Uint8Array, ts = Date.now()): Promise<void> {
    this.writes = this.writes
      .then(async () => {
        await this.ensureDir()
        await appendFile(join(this.dir, LOG_FILE), encodeFrame(ts, update))
      })
      .catch((error) => {
        console.error(`[obsidian-connect] appending history in ${this.dir} failed`, error)
      })
    return this.writes
  }

  async versions(): Promise<HistoryVersion[]> {
    return (await this.readFrames()).map((frame) => ({ ts: frame.ts, bytes: frame.update.length }))
  }

  /** The document as it stood at `ts`, replayed from the snapshot forward. */
  async textAt(ts: number): Promise<string> {
    const snapshot = await this.readSnapshot()
    const frames = await this.readFrames()
    const doc = new Y.Doc()
    try {
      doc.transact(() => {
        if (snapshot) Y.applyUpdate(doc, snapshot, 'history')
        for (const frame of frames) {
          if (frame.ts > ts) break
          Y.applyUpdate(doc, frame.update, 'history')
        }
      }, 'history')
      return doc.getText(CONTENT_FIELD).toString()
    } finally {
      doc.destroy()
    }
  }

  /**
   * Folds everything older than the cutoff into the snapshot and keeps the
   * newer frames. This is the retention policy: old states stop being
   * individually restorable, but no content is lost - the snapshot still
   * contains it.
   */
  async prune(retentionDays: number): Promise<boolean> {
    if (retentionDays <= 0) return false
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    const frames = await this.readFrames()
    const stale = frames.filter((frame) => frame.ts <= cutoff)
    if (stale.length === 0) return false

    const snapshot = await this.readSnapshot()
    const doc = new Y.Doc()
    try {
      doc.transact(() => {
        if (snapshot) Y.applyUpdate(doc, snapshot, 'history')
        for (const frame of stale) Y.applyUpdate(doc, frame.update, 'history')
      }, 'history')
      await this.writeSnapshot(Y.encodeStateAsUpdate(doc))
    } finally {
      doc.destroy()
    }

    const kept = frames.filter((frame) => frame.ts > cutoff)
    const buffer = Buffer.concat(kept.map((frame) => encodeFrame(frame.ts, frame.update)))
    const target = join(this.dir, LOG_FILE)
    const temp = `${target}.tmp`
    await writeFile(temp, buffer)
    await rename(temp, target)
    return true
  }

  /** Replaces the base snapshot atomically. */
  async writeSnapshot(update: Uint8Array): Promise<void> {
    await this.ensureDir()
    const target = join(this.dir, SNAPSHOT_FILE)
    const temp = `${target}.tmp`
    await writeFile(temp, Buffer.from(update))
    await rename(temp, target)
  }

  /** Collapses the log into the snapshot without dropping any content. */
  async compact(doc: Y.Doc): Promise<void> {
    this.writes = this.writes
      .then(async () => {
        await this.writeSnapshot(Y.encodeStateAsUpdate(doc))
        await rm(join(this.dir, LOG_FILE), { force: true })
      })
      .catch((error) => {
        console.error(`[obsidian-connect] compacting history in ${this.dir} failed`, error)
      })
    await this.writes
  }

  async logBytes(): Promise<number> {
    try {
      return (await stat(join(this.dir, LOG_FILE))).size
    } catch {
      return 0
    }
  }

  /** Waits for every queued append, so a shutdown does not lose the tail. */
  async flush(): Promise<void> {
    await this.writes
  }
}
