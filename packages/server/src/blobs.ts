import { open, readFile, readdir, rename, rm, stat, truncate, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BLOB_CHUNK_BYTES, BLOB_CHUNK_OVERHEAD, blobChunkCount, isHexId, type BlobInfo, type BlobListResponse } from '@mycel/shared'
import { appendDurable, ensureDir, syncDir, writeDurable } from './durable.js'

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
// Uploads under way were never counted nor cleared: any account filled the disk past its quota with uploads it never
// finished (audit 2, M7). They count now, at most so many at once per vault, and one untouched for a day goes.
const UPLOADS_MAX = 32
const UPLOAD_STALE_MS = 24 * 60 * 60 * 1000

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
  /** The last upload of it, the first included. */
  touchedAt?: number
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
  /**
   * How long after its last upload a blob survives being purged. A device
   * that uploads content the server already has names it in its index right
   * after; another device cleaning up at that moment would delete it under it.
   */
  purgeGraceMs: number
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

function blobIdOf(value: unknown): string {
  if (typeof value !== 'string' || !isHexId(value)) throw new BlobError(400, 'not a blob id')
  return value
}

export class BlobStore {
  private readonly queues = new Map<string, Promise<unknown>>()
  /** Bytes per account, counted once and kept up to date. */
  private readonly usage = new Map<string, Promise<number>>()
  /** Whether a shared note names a blob; such a blob is kept whatever its owner asks. */
  private attached: (account: string, vault: string, blob: string) => boolean = () => false
  /** What else an account stores - its rooms -, counted against the same quota. */
  private otherUsage: (account: string) => Promise<number> = async () => 0

  constructor(
    private readonly dataDir: string,
    readonly limits: BlobLimits
  ) {}

  /** Who knows which blobs shared notes name: the room hub. */
  protect(attached: (account: string, vault: string, blob: string) => boolean): void {
    this.attached = attached
  }

  /** What an account's rooms take, which the quota covers too: the room hub. */
  shareQuota(other: (account: string) => Promise<number>): void {
    this.otherUsage = other
  }

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
      if (done) {
        await writeDurable(join(dir, `${id}.json`), JSON.stringify({ ...done, touchedAt: Date.now() } satisfies BlobMeta))
        return { complete: true, count: done.count, received: done.count, size: done.size }
      }

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
        if ((await this.openUploads(uploads)) >= UPLOADS_MAX) throw new BlobError(429, 'too many uploads under way')
        await ensureDir(uploads)
        await writeFile(partPath, new Uint8Array(0))
        await writeDurable(metaPath, JSON.stringify({ count, startedAt: Date.now() } satisfies UploadMeta))
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
      if (this.limits.quotaBytes !== null && (await this.usageOf(account)) + (await this.otherUsage(account)) + size > this.limits.quotaBytes) {
        await this.dropUpload(uploads, id)
        throw new BlobError(507, 'the account has used up its storage')
      }

      // A crash in the middle of an append leaves a torn chunk; it goes.
      if (((await sizeOf(partPath)) ?? 0) !== stored) await truncate(partPath, stored)
      // On the disk before it is acknowledged: the device does not send an acknowledged chunk again.
      await appendDurable(partPath, data, false)
      if (!last) return { complete: false, count, received: index + 1, size }

      await rename(partPath, join(dir, id))
      await syncDir(dir)
      const now = Date.now()
      await writeDurable(join(dir, `${id}.json`), JSON.stringify({ size, count, createdAt: now, touchedAt: now } satisfies BlobMeta))
      await unlink(metaPath).catch(() => undefined)
      await this.addUsage(account, size)
      return { complete: true, count, received: count, size }
    })
  }

  /** Uploads under way in a folder, those untouched for a day let go of first. */
  private async openUploads(uploads: string): Promise<number> {
    let open = 0
    for (const name of await list(uploads)) {
      const id = name.slice(0, -'.json'.length)
      if (!name.endsWith('.json') || !isHexId(id)) continue
      const touchedAt = await this.uploadTouched(uploads, id)
      if (touchedAt === null || Date.now() - touchedAt > UPLOAD_STALE_MS) await this.dropUpload(uploads, id)
      else open += 1
    }
    return open
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

  /**
   * Every blob of the store and every upload under way, with when each was
   * last touched - so its owner can find content no device names (a crash
   * between upload and index entry), and leave alone what is being uploaded.
   */
  async list(account: string, vault: string): Promise<BlobListResponse> {
    const dir = this.dir(account, vault)
    const blobs: BlobListResponse['blobs'] = []
    for (const name of await list(dir)) {
      const id = name.slice(0, -'.json'.length)
      if (!name.endsWith('.json') || !isHexId(id)) continue
      const meta = await readJson<BlobMeta>(join(dir, name))
      if (meta) blobs.push({ id, size: meta.size, touchedAt: meta.touchedAt ?? meta.createdAt })
    }
    const uploads: BlobListResponse['uploads'] = []
    for (const name of await list(join(dir, UPLOADS))) {
      const id = name.slice(0, -'.json'.length)
      if (!name.endsWith('.json') || !isHexId(id)) continue
      const touchedAt = await this.uploadTouched(join(dir, UPLOADS), id)
      if (touchedAt !== null) uploads.push({ id, touchedAt })
    }
    return { blobs, uploads }
  }

  /** When an upload under way last took a chunk - its start, before the first. */
  private async uploadTouched(uploads: string, id: string): Promise<number | null> {
    const meta = await readJson<UploadMeta>(join(uploads, `${id}.json`))
    if (!meta) return null
    try {
      return Math.max(meta.startedAt, (await stat(join(uploads, id))).mtimeMs)
    } catch {
      return meta.startedAt
    }
  }

  /**
   * Starts the grace of blobs again, as an upload of them would: a device that
   * finds its content here names it next. Answers the ones that are there -
   * one a purge took first has to be uploaded again before anything names it.
   */
  async touch(account: string, vault: string, ids: unknown, now = Date.now()): Promise<string[]> {
    if (!Array.isArray(ids)) throw new BlobError(400, 'ids must be a list')
    const touched: string[] = []
    for (const value of ids) {
      if (typeof value !== 'string' || !isHexId(value)) continue
      const there = await this.serial(`${account}/${vault}/${value}`, async () => {
        const meta = await this.meta(account, vault, value)
        if (!meta) return false
        await writeDurable(join(this.dir(account, vault), `${value}.json`), JSON.stringify({ ...meta, touchedAt: now } satisfies BlobMeta))
        return true
      })
      if (there) touched.push(value)
    }
    return touched
  }

  /**
   * Lets go of these blobs, except those uploaded within the grace period.
   * Answers which went and which were kept; any other was not there.
   */
  /**
   * `withoutGrace`: the account's keys are being replaced - every other device
   * is signed out, so nothing is on its way in under the keys before, and
   * nothing under them may stay.
   */
  async purge(account: string, vault: string, ids: unknown, now = Date.now(), withoutGrace = false): Promise<{ purged: string[]; kept: string[] }> {
    if (!Array.isArray(ids)) throw new BlobError(400, 'ids must be a list')
    const grace = withoutGrace ? 0 : this.limits.purgeGraceMs
    const purged: string[] = []
    const kept: string[] = []
    for (const value of ids) {
      if (typeof value !== 'string' || !isHexId(value)) continue
      const outcome = await this.serial(`${account}/${vault}/${value}`, async () => {
        const dir = this.dir(account, vault)
        const meta = await this.meta(account, vault, value)
        if (!meta) {
          // An upload under way is another device's file on its way in.
          const uploads = join(dir, UPLOADS)
          const touchedAt = await this.uploadTouched(uploads, value)
          if (touchedAt !== null && now - touchedAt < grace) return 'kept'
          await this.dropUpload(uploads, value)
          return 'absent'
        }
        if (now - (meta.touchedAt ?? meta.createdAt) < grace) return 'kept'
        // Someone else may still fetch it through a note shared with them.
        if (this.attached(account, vault, value)) return 'kept'
        // The record first: from then on the blob does not exist for anyone.
        await unlink(join(dir, `${value}.json`))
        await rm(join(dir, value), { force: true })
        await this.addUsage(account, -meta.size)
        return 'purged'
      })
      if (outcome === 'purged') purged.push(value)
      else if (outcome === 'kept') kept.push(value)
    }
    return { purged, kept }
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
      for (const name of await list(join(this.dir(account, vault), UPLOADS))) {
        if (isHexId(name)) total += (await sizeOf(join(this.dir(account, vault), UPLOADS, name))) ?? 0
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
