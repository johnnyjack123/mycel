import { createHash } from 'node:crypto'
import { folderRoom, roomKind, type BackupRoom, type FolderTie, type LogResponse } from '@mycel/shared'
import { lastFrame, type Cache, type CachedBlob, type CachedRoom } from './cache.js'
import type { VaultKeys } from './keys.js'
import { SyncError, type SyncClient } from './sync.js'

// Bringing the cache level with the sync server, fetching only what changed.
// A seq alone does not say the log is the same one (invariant 19): every
// partial fetch asks for the frame the cache ends with again and compares it.

export interface RoomsFetched {
  /** Rooms the sync server lists for the vault. */
  listed: number
  /** Rooms that changed and were fetched. */
  fetched: number
  /** Rooms whose log was another one than the cache had - a sync server restored from a copy. */
  diverged: string[]
  /** Rooms kept from the cache because the sync server no longer gives them out. */
  held: string[]
}

const PARALLEL = 8

/** Runs `task` over `items`, at most `limit` at once; the first failure fails it all. */
export async function pool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next] as T
      next += 1
      await task(item)
    }
  })
  await Promise.all(workers)
}

interface RoomKeys {
  sealed: Record<string, string>
  ties?: Record<string, FolderTie>
  folderKeys?: Record<string, Record<string, string>>
}

function fromLog(entry: BackupRoom, log: LogResponse, keys: RoomKeys): CachedRoom {
  return {
    room: entry.room,
    owner: entry.owner,
    tag: entry.tag,
    epoch: log.epoch,
    headSeq: log.headSeq,
    snapshot: log.snapshot,
    frames: log.frames,
    ...keys
  }
}

/** Whether what the cache knows of the room's folder epochs is what the sync server says. */
function sameTies(cached: CachedRoom, entry: BackupRoom): boolean {
  return JSON.stringify(cached.ties ?? {}) === JSON.stringify(entry.ties ?? {})
}

/**
 * Fetches every room whose tag changed - all of them with `verifyAll`, which
 * also catches a log replaced by one of the same length. A room the sync server
 * stops listing, or refuses, is kept from the cache and marked held.
 */
export async function fetchRooms(client: SyncClient, cache: Cache, accountId: string, verifyAll: boolean): Promise<RoomsFetched> {
  // A shared folder's own room says where its notes are; the vault index says
  // that for this vault, and the folder's keys are asked for with its notes.
  // A room's name becomes a file of the cache: only names as rooms have them (audit 2, L8: `doc:../../x`).
  const listed = (await client.rooms()).rooms.filter((entry) => roomKind(entry.room) !== 'fld' && /^(?:doc|idx|set):[0-9a-f]{32}$/.test(entry.room))
  const result: RoomsFetched = { listed: listed.length, fetched: 0, diverged: [], held: [] }
  const seen = new Set(listed.map((entry) => entry.room))

  await pool(listed, PARALLEL, async (entry) => {
    const cached = await cache.room(entry.room)
    if (cached && !cached.held && cached.tag === entry.tag && sameTies(cached, entry) && !verifyAll) return
    try {
      const next = await fetchRoom(client, entry, cached, accountId, result)
      await cache.saveRoom(next)
      result.fetched += 1
    } catch (error) {
      // Refused: a share that ended between the listing and the fetch.
      if (!(error instanceof SyncError) || (error.status !== 403 && error.status !== 410)) throw error
      if (cached) {
        await cache.saveRoom({ ...cached, held: true })
        result.held.push(entry.room)
      }
    }
  })

  for (const room of await cache.rooms()) {
    if (seen.has(room)) continue
    const cached = await cache.room(room)
    if (!cached) continue
    if (!cached.held) await cache.saveRoom({ ...cached, held: true })
    result.held.push(room)
  }
  return result
}

async function fetchRoom(
  client: SyncClient,
  entry: BackupRoom,
  cached: CachedRoom | null,
  accountId: string,
  result: RoomsFetched
): Promise<CachedRoom> {
  let sealed = cached?.sealed ?? {}
  if (entry.owner !== accountId) sealed = { ...sealed, ...(await client.keys(entry.room)).keys }
  const keys: RoomKeys = { sealed }
  if (entry.ties) {
    keys.ties = entry.ties
    // Someone else's folder: its keys arrive sealed to the account, from the folder's room.
    if (entry.owner !== accountId) {
      const folderKeys: Record<string, Record<string, string>> = { ...cached?.folderKeys }
      for (const folder of new Set(Object.values(entry.ties).map((tie) => tie.folder))) {
        try {
          folderKeys[folder] = { ...folderKeys[folder], ...(await client.keys(folderRoom(folder))).keys }
        } catch (error) {
          // Left the folder, and the note stayed on its own: its own sealed keys go on.
          if (!(error instanceof SyncError) || (error.status !== 403 && error.status !== 410 && error.status !== 404)) throw error
        }
      }
      keys.folderKeys = folderKeys
    }
  }

  const last = cached ? lastFrame(cached) : null
  if (cached && last) {
    const partial = await client.log(entry.room, last.seq)
    if (partial.from === last.seq && partial.frames[0]?.data === last.data) {
      return {
        ...cached,
        owner: entry.owner,
        tag: entry.tag,
        epoch: partial.epoch,
        headSeq: partial.headSeq,
        frames: [...cached.frames, ...partial.frames.slice(1)],
        ...keys,
        held: false
      }
    }
    // The frame is there but another one: this log is not the one the cache
    // followed. Without it, the frame was compacted - the whole log came back.
    if (partial.from !== undefined) {
      result.diverged.push(entry.room)
      return fromLog(entry, await client.log(entry.room), keys)
    }
    // Compacted only if a snapshot reaches the frame the cache followed (invariant 19): short of it - an empty log, say -
    // the log is another one, and taken quietly it emptied the note in every backup the retention kept (audit 2, M6).
    if (!partial.snapshot || partial.snapshot.uptoSeq < last.seq) result.diverged.push(entry.room)
    return fromLog(entry, partial, keys)
  }
  return fromLog(entry, await client.log(entry.room), keys)
}

/** A chunk that does not decrypt: changed on the sync server's disk, or not this blob's. */
class DamagedBlob extends Error {}

export interface BlobsFetched {
  fetched: number
  bytes: number
  /** Content hashes the vault names that the sync server does not have. */
  missing: string[]
  /** Content hashes whose blob did not decrypt to that content. */
  damaged: string[]
}

/**
 * Fetches every blob the run needs that the cache lacks, checking each against
 * the content hash the index gives: the key proves only who made a blob, not
 * that it holds this content. Drops cached blobs nothing needs any more.
 */
export async function fetchBlobs(
  client: SyncClient,
  cache: Cache,
  keys: VaultKeys,
  needed: ReadonlyMap<string, string>
): Promise<BlobsFetched> {
  const { accountId, vaultId } = keys.grant
  const result: BlobsFetched = { fetched: 0, bytes: 0, missing: [], damaged: [] }
  await pool(Array.from(needed), 4, async ([blobId, hash]) => {
    if (await cache.blob(blobId)) return
    const info = await client.blobInfo(accountId, vaultId, blobId)
    if (!info) {
      result.missing.push(hash)
      return
    }
    // Hashed as it arrives: a file of a hundred megabytes is never whole in memory.
    const digest = createHash('sha256')
    let record: CachedBlob
    try {
      record = await cache.putBlob(blobId, info.count, async (index) => {
        const chunk = await client.blobChunk(accountId, vaultId, blobId, index)
        try {
          digest.update(await keys.decryptChunk(blobId, chunk, index, info.count))
        } catch {
          throw new DamagedBlob()
        }
        return chunk
      })
    } catch (error) {
      if (!(error instanceof DamagedBlob)) throw error
      result.damaged.push(hash)
      return
    }
    if (digest.digest('hex') !== hash) {
      await cache.deleteBlob(blobId)
      result.damaged.push(hash)
      return
    }
    result.fetched += 1
    result.bytes += record.size
  })
  for (const blobId of await cache.blobs()) {
    if (!needed.has(blobId)) await cache.deleteBlob(blobId)
  }
  return result
}
