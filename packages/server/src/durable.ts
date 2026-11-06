import { link, mkdir, open, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Writes that survive a power cut. A write the server answered for - a frame it
// acknowledged, an account it registered - is on the disk, not in the
// operating system's cache: a Pi's SD card keeps a write in that cache for
// seconds, and an acknowledged frame lost there was already dropped from the
// device's outbox.

/**
 * Makes a file's name in its folder durable: a created or renamed file is in
 * its folder only once the folder is synced. Windows cannot open a folder to
 * sync it, and needs nothing of the kind.
 */
export async function syncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(dir, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Creates a folder and whatever above it is missing, each one's name made durable in its parent. */
export async function ensureDir(dir: string): Promise<void> {
  const created = await mkdir(dir, { recursive: true })
  if (created === undefined || process.platform === 'win32') return
  const made: string[] = []
  for (let current = dir; ; current = dirname(current)) {
    made.push(current)
    if (current === created || dirname(current) === current) break
  }
  for (const folder of made.reverse()) await syncDir(dirname(folder))
}

let temps = 0

/**
 * Replaces a file whole: the new content synced under another name, then
 * renamed over the old one, then the folder synced. A crash leaves the old
 * file or the new one, never a part of either.
 */
export async function writeDurable(path: string, data: string | Uint8Array): Promise<void> {
  temps += 1
  const temp = `${path}.${process.pid}.${temps}.tmp`
  try {
    const handle = await open(temp, 'w')
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
  await syncDir(dirname(path))
}

/**
 * Creates a file that must not exist yet, whole or not at all - `server.json`,
 * which every account's salt depends on: written in place, a crash left a file
 * that never parsed again. False when it existed.
 */
export async function createDurable(path: string, data: string | Uint8Array): Promise<boolean> {
  temps += 1
  const temp = `${path}.${process.pid}.${temps}.tmp`
  const handle = await open(temp, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    // A hard link fails when the name exists - an exclusive rename.
    await link(temp, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    await unlink(temp).catch(() => undefined)
  }
  await syncDir(dirname(path))
  return true
}

/** Appends to a file and returns once it is on the disk. `created`: the file is new, so its folder is synced too. */
export async function appendDurable(path: string, data: Uint8Array, created: boolean): Promise<void> {
  const handle = await open(path, 'a')
  try {
    await handle.appendFile(data)
    await handle.datasync()
  } finally {
    await handle.close()
  }
  if (created) await syncDir(dirname(path))
}

/** Cuts a file back to `length` bytes, durably. */
export async function truncateDurable(path: string, length: number): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    await handle.truncate(length)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export interface FileLockOptions {
  /** A lock untouched for this long belongs to a holder that crashed. */
  staleMs?: number
  /** How long to wait for another holder before giving up. */
  waitMs?: number
}

const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 10_000
const LOCK_POLL_MS = 25

/**
 * Runs `task` holding a lock file shared by every process on this data folder -
 * the server and the admin CLI both change `accounts.json`; each read it,
 * changed it and wrote it back, and one change could undo the other's. Taken by
 * creating the file exclusively; one older than `staleMs` is a crashed
 * holder's and is taken over. By age, not by process id: in a container the
 * id after a restart is the same small number.
 */
export async function withFileLock<T>(path: string, task: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const staleMs = options.staleMs ?? LOCK_STALE_MS
  const deadline = Date.now() + (options.waitMs ?? LOCK_WAIT_MS)
  for (;;) {
    try {
      await writeFile(path, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const age = await stat(path).then(
      (found) => Date.now() - found.mtimeMs,
      () => null
    )
    if (age !== null && age > staleMs) {
      console.warn(`[mycel] ${path} was left by a process that stopped; taken over`)
      await unlink(path).catch(() => undefined)
      continue
    }
    if (Date.now() > deadline) throw new Error(`${path} is held by another process`)
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
  }
  try {
    return await task()
  } finally {
    await unlink(path).catch(() => undefined)
  }
}

const SERVER_LOCK_BEAT_MS = 10_000
const SERVER_LOCK_STALE_MS = 30_000

export interface ServerLock {
  release(): Promise<void>
}

/**
 * The one server on a data folder: `server.lock`, kept fresh every ten
 * seconds. Two servers on one folder would each write rooms the other holds
 * in memory. A lock nobody kept fresh for half a minute was left by a server
 * that stopped without letting go - a container killed and started again -
 * and is waited out and taken over; one kept fresh means another server runs,
 * and this one does not start.
 */
export async function takeServerLock(dataDir: string, beatMs = SERVER_LOCK_BEAT_MS, staleMs = SERVER_LOCK_STALE_MS): Promise<ServerLock> {
  const path = join(dataDir, 'server.lock')
  const deadline = Date.now() + staleMs + beatMs
  for (;;) {
    try {
      await writeFile(path, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const age = await stat(path).then(
      (found) => Date.now() - found.mtimeMs,
      () => null
    )
    if (age !== null && age > staleMs) {
      console.warn(`[mycel] ${path} was left by a server that stopped; taken over`)
      await unlink(path).catch(() => undefined)
      continue
    }
    if (Date.now() > deadline) {
      throw new Error(`another server runs on ${dataDir} (${path} is kept fresh); stop it first`)
    }
    if (age !== null) console.info(`[mycel] ${path} exists; waiting to see whether its server still runs`)
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, staleMs)))
  }
  const beat = setInterval(() => {
    const now = new Date()
    void utimes(path, now, now).catch((error: unknown) => console.error(`[mycel] keeping ${path} fresh failed`, error))
  }, beatMs)
  beat.unref()
  return {
    async release() {
      clearInterval(beat)
      await unlink(path).catch(() => undefined)
    }
  }
}
