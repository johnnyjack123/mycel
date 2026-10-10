import { mkdir, open, readFile, readdir, rename, rm, stat, truncate, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BLOB_CHUNK_BYTES, BLOB_CHUNK_OVERHEAD, blobChunkCount, isHexId, type BlobInfo } from '@obsidian-connect/shared'

// The encrypted contents of a vault's files. The server cannot read them: it
// keeps them, says whether it has them, and lets go of them when their owner
// says so.
//
//   users/<account>/<vault>/blobs/<blobId>          the chunks, end to end
//   users/<account>/<vault>/blobs/<blobId>.json     size and chunk count, written last
//   users/<account>/<vault>/blobs/.upload/<blobId>  an upload under way, whole chunks only
//
// The `.json` is what makes a blob exist. It is written after the chunks are
// in place and removed before they go, so the server never claims a blob it
// cannot hand out - a device relies on that before it names the blob anywhere.

const CHUNK_CIPHER = BLOB_CHUNK_BYTES + BLOB_CHUNK_OVERHEAD
const UPLOADS = '.upload'

export class BlobError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

interface BlobMeta {
  size: number
  count: number
  createdAt: number
}

interface UploadMeta {
  count: number
  startedAt: number
}

export interface BlobLimits {
  /** Plaintext bytes of the largest file taken. */
  maxFileBytes: number
  /** Ciphertext bytes an account may keep in all; null for no limit. */
  quotaBytes: number | null
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function writeAtomic(path: string, data: string): Promise<void> {
  await writeFile(`${path}.tmp`, data)
  await rename(`${path}.tmp`, path)
}

function blobIdOf(value: unknown): string {
  if (typeof value !== 'string' || !isHexId(value)) throw new BlobError(400, 'not a blob id')
  return value
}

export class BlobStore {
  private readonly queues = new Map<string, Promise<unknown>>()
  /** Bytes per account, counted once and kept up to date. */
  private readonly usage = new Map<string, Promise<number>>()

  constructor(
    private readonly dataDir: string,
    readonly limits: BlobLimits
  ) {}

  private dir(account: string, vault: string): string {
    return join(this.dataDir, 'users', account, vault, 'blobs')
  }

  /** One write at a time per blob: two devices uploading the same file meet here. */
  private serial<T>(key: string, task: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(key) ?? Promise.resolve()).then(task)
    const tail = run.catch(() => undefined)
    this.queues.set(key, tail)
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    })
    return run
  }

  private meta(account: string, vault: string, blobId: string): Promise<BlobMeta | null> {
    return readJson<BlobMeta>(join(this.dir(account, vault), `${blobId}.json`))
  }

  /** Whole chunks of an upload under way, or null if there is none. */
  private async upload(account: string, vault: string, blobId: string): Promise<{ count: number; received: number } | null> {
    const dir = join(this.dir(account, vault), UPLOADS)
    const meta = await readJson<UploadMeta>(join(dir, `${blobId}.json`))
    if (!meta) return null
    const size = (await sizeOf(join(dir, blobId))) ?? 0
    return { count: meta.count, received: Math.floor(size / CHUNK_CIPHER) }
  }

  async info(account: string, vault: string, blobId: string): Promise<BlobInfo | null> {
    const id = blobIdOf(blobId)
    const meta = await this.meta(account, vault, id)
    if (meta) return { complete: true, count: meta.count, received: meta.count, size: meta.size }
    const pending = await this.upload(account, vault, id)
    if (pending) return { complete: false, count: pending.count, received: pending.received, size: pending.received * CHUNK_CIPHER }
    return null
  }

  async have(account: string, vault: string, ids: unknown): Promise<string[]> {
    if (!Array.isArray(ids)) throw new BlobError(400, 'ids must be a list')
    const found: string[] = []
    for (const id of ids) {
      if (typeof id === 'string' && isHexId(id) && (await this.meta(account, vault, id))) found.push(id)
    }
    return found
  }

  /**
   * Takes chunk `index` of `count`. Chunks arrive in order; one the server
   * already has is acknowledged again, so a device resending after a lost
   * answer does no harm. The last chunk completes the blob.
   */
  putChunk(account: string, vault: string, blobId: string, index: number, count: number, data: Uint8Array): Promise<BlobInfo> {
    const id = blobIdOf(blobId)
    const maxChunks = blobChunkCount(this.limits.maxFileBytes)
    if (!Number.isInteger(count) || count < 1) throw new BlobError(400, 'count must be a positive whole number')
    if (count > maxChunks) throw new BlobError(413, `files are limited to ${this.limits.maxFileBytes} bytes`)
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new BlobError(400, 'no such chunk')
    const last = index === count - 1
    if (last ? data.length < BLOB_CHUNK_OVERHEAD || data.length > CHUNK_CIPHER : data.length !== CHUNK_CIPHER) {
      throw new BlobError(400, 'a chunk has the wrong size')
    }

    return this.serial(`${account}/${vault}/${id}`, async () => {
      const dir = this.dir(account, vault)
      const done = await this.meta(account, vault, id)
      if (done) return { complete: true, count: done.count, received: done.count, size: done.size }

      const uploads = join(dir, UPLOADS)
      const partPath = join(uploads, id)
      const metaPath = join(uploads, `${id}.json`)
      let pending = await this.upload(account, vault, id)
      if (pending && pending.count !== count) {
        // Another file under the same name cannot happen - the name is its
        // content - so this is an upload started over with other chunking.
        if (index !== 0) throw new BlobError(409, 'the upload has to start over')
        pending = null
      }
      if (!pending) {
        if (index !== 0) throw new BlobError(409, 'the upload has to start over')
        await mkdir(uploads, { recursive: true })
        await writeFile(partPath, new Uint8Array(0))
        await writeAtomic(metaPath, JSON.stringify({ count, startedAt: Date.now() } satisfies UploadMeta))
        pending = { count, received: 0 }
      }
      if (index < pending.received) return { complete: false, count, received: pending.received, size: pending.received * CHUNK_CIPHER }
      if (index > pending.received) throw new BlobError(409, `expected chunk ${pending.received}`)

      const stored = pending.received * CHUNK_CIPHER
      const size = stored + data.length
      if (last && size - count * BLOB_CHUNK_OVERHEAD > this.limits.maxFileBytes) {
        await this.dropUpload(uploads, id)
        throw new BlobError(413, `files are limited to ${this.limits.maxFileBytes} bytes`)
      }
      if (this.limits.quotaBytes !== null && (await this.usageOf(account)) + size > this.limits.quotaBytes) {
        await this.dropUpload(uploads, id)
        throw new BlobError(507, 'the account has used up its storage')
      }

      // A crash in the middle of an append leaves a torn chunk; it goes.
      if (((await sizeOf(partPath)) ?? 0) !== stored) await truncate(partPath, stored)
      const handle = await open(partPath, 'a')
      try {
        await handle.write(data)
      } finally {
        await handle.close()
      }
      if (!last) return { complete: false, count, received: index + 1, size }

      await rename(partPath, join(dir, id))
      await writeAtomic(join(dir, `${id}.json`), JSON.stringify({ size, count, createdAt: Date.now() } satisfies BlobMeta))
      await unlink(metaPath).catch(() => undefined)
      await this.addUsage(account, size)
      return { complete: true, count, received: count, size }
    })
  }

  private async dropUpload(uploads: string, id: string): Promise<void> {
    await unlink(join(uploads, `${id}.json`)).catch(() => undefined)
    await unlink(join(uploads, id)).catch(() => undefined)
  }

  async readChunk(account: string, vault: string, blobId: string, index: number): Promise<Buffer> {
    const id = blobIdOf(blobId)
    const meta = await this.meta(account, vault, id)
    if (!meta) throw new BlobError(404, 'no such blob')
    if (!Number.isInteger(index) || index < 0 || index >= meta.count) throw new BlobError(400, 'no such chunk')
    const offset = index * CHUNK_CIPHER
    const length = Math.min(CHUNK_CIPHER, meta.size - offset)
    const handle = await open(join(this.dir(account, vault), id), 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      if (bytesRead !== length) throw new BlobError(500, 'the blob is damaged')
      return buffer
    } finally {
      await handle.close()
    }
  }

  /** Lets go of these blobs. Answers which ones went. */
  async purge(account: string, vault: string, ids: unknown): Promise<string[]> {
    if (!Array.isArray(ids)) throw new BlobError(400, 'ids must be a list')
    const purged: string[] = []
    for (const value of ids) {
      if (typeof value !== 'string' || !isHexId(value)) continue
      const gone = await this.serial(`${account}/${vault}/${value}`, async () => {
        const dir = this.dir(account, vault)
        const meta = await this.meta(account, vault, value)
        await this.dropUpload(join(dir, UPLOADS), value)
        if (!meta) return false
        // The record first: from then on the blob does not exist for anyone.
        await unlink(join(dir, `${value}.json`))
        await rm(join(dir, value), { force: true })
        await this.addUsage(account, -meta.size)
        return true
      })
      if (gone) purged.push(value)
    }
    return purged
  }

  /** Ciphertext bytes the account keeps, over all its vaults. */
  usageOf(account: string): Promise<number> {
    let known = this.usage.get(account)
    if (!known) {
      known = this.count(account)
      this.usage.set(account, known)
      known.catch(() => this.usage.delete(account))
    }
    return known
  }

  private async count(account: string): Promise<number> {
    let total = 0
    for (const vault of await list(join(this.dataDir, 'users', account))) {
      if (!isHexId(vault)) continue
      for (const name of await list(this.dir(account, vault))) {
        if (!name.endsWith('.json')) continue
        const meta = await readJson<BlobMeta>(join(this.dir(account, vault), name))
        total += meta?.size ?? 0
      }
    }
    return total
  }

  /** Only a count already made is adjusted; one made later sees the files themselves. */
  private async addUsage(account: string, bytes: number): Promise<void> {
    const known = this.usage.get(account)
    if (known) this.usage.set(account, known.then((before) => Math.max(0, before + bytes)))
  }

  /** The account's folder went; its count with it. */
  forget(account: string): void {
    this.usage.delete(account)
  }
}
