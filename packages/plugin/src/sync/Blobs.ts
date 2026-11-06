import { blobChunkCount, type BlobListResponse, type SharedAttachment } from '@mycel/shared'
import {
  aesKey,
  blobChunk,
  concat,
  contentHash,
  decryptBlobChunk,
  encryptBlobChunk,
  fromBase64,
  type Bytes
} from '@mycel/shared/crypto'
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
      if (known?.complete) {
        if (await this.touch(blobId)) return
        if (restart >= RESTARTS) throw new Error(`the server kept losing ${blobId} while it was uploaded`)
        continue
      }
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
    const source = { account: this.keys.accountId, vault: this.keys.vaultId, blob: blobId }
    return this.fetch(source, await this.keys.blobKey(blobId), hash, undefined, progress)
  }

  /**
   * Content from someone else's store, through a shared note whose list names
   * it and gives its key. Checked against the hash the list gives: the key
   * only proves whoever holds it made the blob, not that it is this content.
   */
  async downloadFrom(source: SharedAttachment, room: string): Promise<Bytes> {
    const key = await aesKey(fromBase64(source.key))
    return this.fetch({ account: source.account, vault: source.vault, blob: source.blob }, key, source.hash, room)
  }

  private async fetch(
    source: { account: string; vault: string; blob: string },
    key: CryptoKey,
    hash: string,
    room?: string,
    progress?: (bytes: number) => void
  ): Promise<Bytes> {
    let known: { complete: boolean; count: number } | null
    try {
      known = await this.api.blobInfo(source.account, source.vault, source.blob, room)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) throw new BlobMissing(hash)
      throw error
    }
    if (!known.complete) throw new BlobMissing(hash)
    const parts: Bytes[] = []
    for (let index = 0; index < known.count; index += 1) {
      const chunk = await this.api.blobChunk(source.account, source.vault, source.blob, index, room)
      parts.push(await decryptBlobChunk(key, chunk, source.blob, index, known.count))
      progress?.(chunk.length)
    }
    const data = concat(...parts)
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

  /**
   * Lets the server delete these contents. Answers the hashes it kept for
   * now - uploaded again a moment ago; every other one is gone.
   */
  async purge(hashes: string[]): Promise<Set<string>> {
    const byId = new Map<string, string>()
    for (const hash of new Set(hashes)) byId.set(await this.keys.blobId(hash), hash)
    const kept = await this.purgeIds(Array.from(byId.keys()))
    return new Set(Array.from(kept, (id) => byId.get(id) as string))
  }

  /** `purge` by the blobs' names, for content no hash of this vault's names any more. Answers the ids kept. */
  async purgeIds(ids: string[], replacing?: string): Promise<Set<string>> {
    const kept = new Set<string>()
    for (let start = 0; start < ids.length; start += HAVE_BATCH) {
      const answer = await this.api.purgeBlobs(this.keys.accountId, this.keys.vaultId, ids.slice(start, start + HAVE_BATCH), replacing)
      for (const id of answer.kept) kept.add(id)
    }
    return kept
  }

  /** The name a content has in this vault's store. */
  idOf(hash: string): Promise<string> {
    return this.keys.blobId(hash)
  }

  /** Everything in this vault's store on the server, with when each was last touched. */
  list(): Promise<BlobListResponse> {
    return this.api.listBlobs(this.keys.accountId, this.keys.vaultId)
  }

  /**
   * Whether the server has this content, for content about to be named: if so
   * its grace starts again, so no device cleaning up deletes it under the new
   * name. False when it is not there - a purge may have taken it a moment ago -
   * and it has to be uploaded first.
   */
  async keep(hash: string): Promise<boolean> {
    return this.touch(await this.keys.blobId(hash))
  }

  private async touch(blobId: string): Promise<boolean> {
    const { touched } = await this.api.touchBlobs(this.keys.accountId, this.keys.vaultId, [blobId])
    return touched.includes(blobId)
  }
}
