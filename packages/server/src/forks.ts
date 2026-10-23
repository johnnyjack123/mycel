import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isHexId, type ForkResponse, type ForkSummary, type LogResponse } from '@obsidian-connect/shared'

// What a participant could read of a note when its share ended, kept until
// one of their devices has made it a note of its own. It lives in the
// participant's folder, not the owner's: the owner's account can go at once,
// and what the participant was given stays theirs to pick up.
//
// The record outlives the data as a tombstone. A device that was offline when
// the share ended learns from it that the note is gone - instead of finding
// the room missing and waiting for it forever.

/** How long a share's history waits for its participant after the owner's account is gone. */
export const OWNER_REMOVED_HOLD_MS = 90 * 24 * 60 * 60 * 1000

/** A note of a shared folder: the folder keys the participant held, and which note epochs they open. */
export type FolderKept = NonNullable<ForkResponse['folder']>

interface ForkRecord extends ForkSummary {
  keys: Record<string, string>
  folder?: FolderKept
  /** When the owner's account was removed; the history is held 90 days from then. */
  ownerRemovedAt?: number
  forkedAt?: number
  forkedTo?: string
  /** Whether the history is still on disk. */
  held: boolean
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
  const temp = `${path}.tmp`
  await writeFile(temp, data)
  await rename(temp, path)
}

export class ForkStore {
  /** account -> docId -> record. The histories stay on disk until asked for. */
  private readonly records = new Map<string, Map<string, ForkRecord>>()
  private readonly ready: Promise<void>
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly dataDir: string) {
    this.ready = this.loadAll()
  }

  private dir(account: string): string {
    return join(this.dataDir, 'users', account, 'forks')
  }

  private recordFile(account: string, docId: string): string {
    return join(this.dir(account), `${docId}.json`)
  }

  private logFile(account: string, docId: string): string {
    return join(this.dir(account), `${docId}.log.json`)
  }

  private async loadAll(): Promise<void> {
    for (const account of await list(join(this.dataDir, 'users'))) {
      if (!isHexId(account)) continue
      for (const name of await list(this.dir(account))) {
        const match = /^([0-9a-f]{32})\.json$/.exec(name)
        if (!match) continue
        try {
          const record = JSON.parse(await readFile(join(this.dir(account), name), 'utf8')) as ForkRecord
          this.of(account).set(match[1] as string, record)
        } catch (error) {
          console.error(`[obsidian-connect] a fork record of ${account} could not be read`, error)
        }
      }
    }
  }

  private of(account: string): Map<string, ForkRecord> {
    let records = this.records.get(account)
    if (!records) {
      records = new Map()
      this.records.set(account, records)
    }
    return records
  }

  private queue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writes.then(task)
    this.writes = run.catch(() => undefined)
    return run
  }

  private saveRecord(account: string, record: ForkRecord): Promise<void> {
    return writeAtomic(this.recordFile(account, record.docId), JSON.stringify(record, null, 2))
  }

  /**
   * Keeps what the participant could read. A share that ends again - shared
   * anew and ended anew - replaces the earlier one: its history reaches at
   * least as far.
   */
  async put(account: string, summary: ForkSummary, keys: Record<string, string>, log: LogResponse, folder?: FolderKept): Promise<void> {
    await this.ready
    const record: ForkRecord = { ...summary, keys, held: true }
    if (folder) record.folder = folder
    await this.queue(async () => {
      await mkdir(this.dir(account), { recursive: true })
      // The history first: a record saying it is held must never point at nothing.
      await writeAtomic(this.logFile(account, summary.docId), JSON.stringify(log))
      await this.saveRecord(account, record)
      this.of(account).set(summary.docId, record)
    })
  }

  /** Whether a share of this note ended for this account - a tombstone, even once forked. */
  async has(account: string, docId: string): Promise<boolean> {
    await this.ready
    return this.records.get(account)?.has(docId) ?? false
  }

  async get(account: string, docId: string): Promise<ForkResponse | null> {
    await this.ready
    const record = this.records.get(account)?.get(docId)
    if (!record) return null
    let log: LogResponse | null = null
    if (record.held) {
      try {
        log = JSON.parse(await readFile(this.logFile(account, docId), 'utf8')) as LogResponse
      } catch (error) {
        console.error(`[obsidian-connect] the kept history of ${docId} could not be read`, error)
      }
    }
    const response: ForkResponse = {
      docId: record.docId,
      owner: record.owner,
      reason: record.reason,
      endedAt: record.endedAt,
      keys: record.held ? record.keys : {},
      log
    }
    if (record.forkedTo) response.forkedTo = record.forkedTo
    if (record.held && record.folder) response.folder = record.folder
    return response
  }

  /** Shares that ended and wait for one of the account's devices. */
  async pending(account: string): Promise<ForkSummary[]> {
    await this.ready
    const found: ForkSummary[] = []
    for (const record of this.records.get(account)?.values() ?? []) {
      if (!record.forkedTo) found.push({ docId: record.docId, owner: record.owner, reason: record.reason, endedAt: record.endedAt })
    }
    return found.sort((a, b) => a.endedAt - b.endedAt)
  }

  /**
   * A device has forked. The first one to say so decides where the note
   * carries on; the history is no longer needed. Returns that note's id.
   */
  async done(account: string, docId: string, forkedTo: string, now = Date.now()): Promise<string | null> {
    await this.ready
    return this.queue(async () => {
      const record = this.records.get(account)?.get(docId)
      if (!record) return null
      if (record.forkedTo) return record.forkedTo
      record.forkedTo = forkedTo
      record.forkedAt = now
      await this.drop(account, record)
      return forkedTo
    })
  }

  private async drop(account: string, record: ForkRecord): Promise<void> {
    record.held = false
    record.keys = {}
    delete record.folder
    await this.saveRecord(account, record)
    await unlink(this.logFile(account, record.docId)).catch(() => undefined)
  }

  /** The owner's account is gone: from now on, their notes wait 90 days for their participants. */
  async ownerRemoved(owner: string, now = Date.now()): Promise<void> {
    await this.ready
    await this.queue(async () => {
      for (const [account, records] of this.records) {
        for (const record of records.values()) {
          if (record.owner !== owner || record.ownerRemovedAt !== undefined) continue
          record.ownerRemovedAt = now
          await this.saveRecord(account, record)
        }
      }
    })
  }

  /** Histories whose owner has been gone longer than the hold. The tombstones stay. */
  async expire(now = Date.now()): Promise<number> {
    await this.ready
    return this.queue(async () => {
      let expired = 0
      for (const [account, records] of this.records) {
        for (const record of records.values()) {
          if (!record.held || record.ownerRemovedAt === undefined || now - record.ownerRemovedAt < OWNER_REMOVED_HOLD_MS) continue
          await this.drop(account, record)
          expired += 1
        }
      }
      return expired
    })
  }

  /** The account itself is gone; its folder goes with it. */
  forget(account: string): void {
    this.records.delete(account)
  }

  flush(): Promise<unknown> {
    return this.writes
  }
}
