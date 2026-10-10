import { blobChunkCount } from '@obsidian-connect/shared'
import { blobChunk, concat, contentHash, decryptBlobChunk, encryptBlobChunk, type Bytes } from '@obsidian-connect/shared/crypto'
import { ApiError, type ConnectApi } from '../account/api.js'

// Moves the content of attachments to and from this vault's store on the
// server, encrypted chunk by chunk. A blob is named after its content, so an
// upload the server already has costs one question, and one cut short goes on
// where it stopped.

/** What naming and encrypting a blob of this vault takes; the key ring in the plugin. */
export interface BlobKeys {
  readonly accountId: string
  readonly vaultId: string
  blobId(hash: string): Promise<string>
  blobKey(blobId: string): Promise<CryptoKey>
}

/** The server does not have this content (any more). */
export class BlobMissing extends Error {
  constructor(readonly hash: string) {
    super(`the server has no blob for ${hash.slice(0, 12)}`)
  }
}

// Two devices uploading the same file meet on the server; the one that loses
// a chunk's race asks where the upload stands and goes on from there.
const RESTARTS = 3
const HAVE_BATCH = 500

export class Blobs {
  constructor(
    private readonly api: ConnectApi,
    private readonly keys: BlobKeys
  ) {}

  private async info(blobId: string): Promise<{ complete: boolean; count: number; received: number } | null> {
    try {
      return await this.api.blobInfo(this.keys.accountId, this.keys.vaultId, blobId)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null
      throw error
    }
  }

  /** Resolves once the server holds the whole blob - not a moment before. */
  async upload(data: Uint8Array, hash: string, progress?: (bytes: number) => void): Promise<void> {
    const blobId = await this.keys.blobId(hash)
    const count = blobChunkCount(data.length)
    const key = await this.keys.blobKey(blobId)
    for (let restart = 0; ; restart += 1) {
      const known = await this.info(blobId)
      if (known?.complete) return
      let index = known && known.count === count ? known.received : 0
      try {
        while (index < count) {
          const chunk = await encryptBlobChunk(key, blobChunk(data, index), blobId, index, count)
          const answer = await this.api.putBlobChunk(this.keys.accountId, this.keys.vaultId, blobId, index, count, chunk)
          progress?.(chunk.length)
          if (answer.complete) return
          index = answer.received
        }
        if ((await this.info(blobId))?.complete) return
        throw new Error(`the server did not complete the upload of ${blobId}`)
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 409) || restart >= RESTARTS) throw error
      }
    }
  }

  /** The content, checked against its hash. Throws `BlobMissing` if the server has none. */
  async download(hash: string, progress?: (bytes: number) => void): Promise<Bytes> {
    const blobId = await this.keys.blobId(hash)
    const known = await this.info(blobId)
    if (!known?.complete) throw new BlobMissing(hash)
    const key = await this.keys.blobKey(blobId)
    const parts: Bytes[] = []
    for (let index = 0; index < known.count; index += 1) {
      const chunk = await this.api.blobChunk(this.keys.accountId, this.keys.vaultId, blobId, index)
      parts.push(await decryptBlobChunk(key, chunk, blobId, index, known.count))
      progress?.(chunk.length)
    }
    const data = concat(...parts)
    // The key already proves the vault made it; this proves it is the right one.
    if ((await contentHash(data)) !== hash) throw new Error(`a blob did not match its content hash ${hash.slice(0, 12)}`)
    return data
  }

  async has(hash: string): Promise<boolean> {
    return (await this.missing([hash])).length === 0
  }

  /** Which of these contents the server lacks. */
  async missing(hashes: string[]): Promise<string[]> {
    const byId = new Map<string, string>()
    for (const hash of new Set(hashes)) byId.set(await this.keys.blobId(hash), hash)
    const ids = Array.from(byId.keys())
    const present = new Set<string>()
    for (let start = 0; start < ids.length; start += HAVE_BATCH) {
      const { have } = await this.api.haveBlobs(this.keys.accountId, this.keys.vaultId, ids.slice(start, start + HAVE_BATCH))
      for (const id of have) present.add(id)
    }
    return ids.filter((id) => !present.has(id)).map((id) => byId.get(id) as string)
  }

  /** Lets the server delete these contents. Answers the hashes that went. */
  async purge(hashes: string[]): Promise<string[]> {
    const byId = new Map<string, string>()
    for (const hash of new Set(hashes)) byId.set(await this.keys.blobId(hash), hash)
    const { purged } = await this.api.purgeBlobs(this.keys.accountId, this.keys.vaultId, Array.from(byId.keys()))
    return purged.map((id) => byId.get(id)).filter((hash): hash is string => Boolean(hash))
  }
}
