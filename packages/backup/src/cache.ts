import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BLOB_CHUNK_BYTES, BLOB_CHUNK_OVERHEAD, type LogFrame, type LogSnapshot } from '@obsidian-connect/shared'

// What the backup server keeps of a vault between runs: the ciphertext, as
// the sync server has it. Without it every run would download every
// attachment again - restic needs the whole vault each time - and with it a
// run fetches only what changed. Nothing here is readable without the keys.
//
//   rooms/<kind>_<id>.json   a room's log: a starting snapshot, the frames after it, sealed keys
//   blobs/<blobId>           a blob's chunks end to end, as the sync server stores them
//   blobs/<blobId>.json      its chunk count and size, written last

export interface CachedRoom {
  room: string
  owner: string
  /** The sync server's tag when this was fetched; another tag means the log changed. */
  tag: string
  epoch: number
  headSeq: number
  snapshot: LogSnapshot | null
  frames: LogFrame[]
  /** Epoch -> that epoch's key sealed to the account, for notes others own. */
  sealed: Record<string, string>
  /**
   * The sync server no longer lists the room for this vault - a share that
   * ended, or a note purged. Kept as it was until the index stops naming it.
   */
  held?: boolean
}

export interface CachedBlob {
  count: number
  size: number
}

const CHUNK_CIPHER = BLOB_CHUNK_BYTES + BLOB_CHUNK_OVERHEAD

function roomFile(room: string): string {
  return `${room.replace(':', '_')}.json`
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await writeFile(`${path}.tmp`, data)
  await rename(`${path}.tmp`, path)
}

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** The seq and data of the last frame the cache has, or null when it holds a snapshot at most. */
export function lastFrame(cached: CachedRoom): LogFrame | null {
  return cached.frames[cached.frames.length - 1] ?? null
}

export class Cache {
  private readonly roomsDir: string
  private readonly blobsDir: string

  constructor(root: string) {
    this.roomsDir = join(root, 'rooms')
    this.blobsDir = join(root, 'blobs')
  }

  async room(room: string): Promise<CachedRoom | null> {
    try {
      return JSON.parse(await readFile(join(this.roomsDir, roomFile(room)), 'utf8')) as CachedRoom
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async saveRoom(cached: CachedRoom): Promise<void> {
    await mkdir(this.roomsDir, { recursive: true })
    await writeAtomic(join(this.roomsDir, roomFile(cached.room)), JSON.stringify(cached))
  }

  async deleteRoom(room: string): Promise<void> {
    await rm(join(this.roomsDir, roomFile(room)), { force: true })
  }

  /** Every room the cache holds, by name. */
  async rooms(): Promise<string[]> {
    return (await list(this.roomsDir))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length).replace('_', ':'))
  }

  async blob(blobId: string): Promise<CachedBlob | null> {
    try {
      return JSON.parse(await readFile(join(this.blobsDir, `${blobId}.json`), 'utf8')) as CachedBlob
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async blobs(): Promise<string[]> {
    return (await list(this.blobsDir)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length))
  }

  /**
   * Stores a blob chunk by chunk as `fetch` hands them out, in order. The
   * record comes last: a blob without one was cut short and is fetched again.
   */
  async putBlob(blobId: string, count: number, fetchChunk: (index: number) => Promise<Uint8Array>): Promise<CachedBlob> {
    await mkdir(this.blobsDir, { recursive: true })
    const part = join(this.blobsDir, `${blobId}.part`)
    const handle = await open(part, 'w')
    let size = 0
    try {
      for (let index = 0; index < count; index += 1) {
        const chunk = await fetchChunk(index)
        await handle.write(chunk)
        size += chunk.length
      }
    } finally {
      await handle.close()
    }
    await rename(part, join(this.blobsDir, blobId))
    const record: CachedBlob = { count, size }
    await writeAtomic(join(this.blobsDir, `${blobId}.json`), JSON.stringify(record))
    return record
  }

  /** One encrypted chunk, as the sync server handed it out. */
  async blobChunk(blobId: string, index: number, record: CachedBlob): Promise<Uint8Array> {
    const offset = index * CHUNK_CIPHER
    const length = Math.min(CHUNK_CIPHER, record.size - offset)
    const handle = await open(join(this.blobsDir, blobId), 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      if (bytesRead !== length) throw new Error(`the cached blob ${blobId} is damaged`)
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    } finally {
      await handle.close()
    }
  }

  async deleteBlob(blobId: string): Promise<void> {
    await rm(join(this.blobsDir, `${blobId}.json`), { force: true })
    await rm(join(this.blobsDir, blobId), { force: true })
  }
}
