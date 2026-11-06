import { createHash } from 'node:crypto'
import type { BackupListedEntry, BackupSnapshotRef } from '@mycel/shared'
import type { Restic, ResticRepo } from './restic.js'
import type { Destination } from './run.js'
import { TarReader } from './tarcheck.js'

// A vault read back out of its own backups, for a device rolling back further
// than the history on the sync server reaches. It only reads: restic dumps a
// snapshot's folder or its files stream as a tar, and the parts asked for go
// to the device inside the session, in pieces.

/** A piece of content on its way: at most this much, so a sealed frame stays well below the relay's limit. */
const PIECE_BYTES = 192 * 1024

function repoOf(destination: Destination): ResticRepo {
  return { repository: destination.repository, password: destination.password, env: destination.env }
}

/** The path of a tar entry inside the vault's folder; null for anything else. */
function inside(entryPath: string, folder: string): string | null {
  const path = entryPath.replace(/^\/+/, '')
  return path.startsWith(`${folder}/`) && path.length > folder.length + 1 ? path.slice(folder.length + 1) : null
}

/**
 * The newest backup of this vault at or before `at`, over its repositories:
 * a notes snapshot, and the files snapshot that was the newest then. A
 * repository that cannot be read now is passed over; another may do.
 */
export async function snapshotAt(
  restic: Restic,
  destinations: readonly Destination[],
  vaultId: string,
  folder: string,
  at: number
): Promise<BackupSnapshotRef | null> {
  let best: BackupSnapshotRef | null = null
  const newest = (snapshots: Array<{ id: string; time: string; paths: string[] }>, belongs: (path: string) => boolean): { id: string; time: number } | null =>
    snapshots
      .filter((snapshot) => snapshot.paths.some(belongs))
      .map((snapshot) => ({ id: snapshot.id, time: Date.parse(snapshot.time) }))
      .filter((snapshot) => Number.isFinite(snapshot.time) && snapshot.time <= at)
      .sort((a, b) => b.time - a.time)[0] ?? null
  for (const destination of destinations) {
    try {
      const repo = repoOf(destination)
      // A remote repository may hold more than one vault: a notes snapshot names
      // the vault's own folder on the RAM disk, a files snapshot its stream.
      const notes = newest(await restic.snapshots(repo, 'notes'), (path) => path.split(/[\\/]/).includes(vaultId))
      if (!notes) continue
      const files = newest(await restic.snapshots(repo, 'files'), (path) => path.replace(/^.*[\\/]/, '') === `${folder} files.tar`)
      if (!best || notes.time > best.notes.time) best = { destination: destination.id, folder, notes, files }
    } catch {
      // the next repository
    }
  }
  return best
}

/**
 * When this vault's notes were backed up, over its repositories, oldest first -
 * the Time Machine's ticks further back than the history. Each leads to its
 * backup through `snapshotAt`.
 */
export async function snapshotTimes(restic: Restic, destinations: readonly Destination[], vaultId: string): Promise<number[]> {
  const times = new Set<number>()
  for (const destination of destinations) {
    try {
      for (const snapshot of await restic.snapshots(repoOf(destination), 'notes')) {
        const time = Date.parse(snapshot.time)
        if (Number.isFinite(time) && snapshot.paths.some((path) => path.split(/[\\/]/).includes(vaultId))) times.add(time)
      }
    } catch {
      // the next repository
    }
  }
  return Array.from(times).sort((a, b) => a - b)
}

/** Every note and file a backup holds, by its path in the vault, with its size and SHA-256. */
export async function listBackup(restic: Restic, destination: Destination, ref: BackupSnapshotRef): Promise<BackupListedEntry[]> {
  const entries = new Map<string, BackupListedEntry>()
  const collect = (part: BackupListedEntry['part']): TarReader =>
    new TarReader((entry) => {
      const path = inside(entry.path, ref.folder)
      if (!path) return null
      const hash = createHash('sha256')
      return (chunk) => {
        if (chunk) hash.update(chunk)
        else entries.set(path, { path, size: entry.size, hash: hash.digest('hex'), part })
      }
    })
  const repo = repoOf(destination)
  const notes = collect('notes')
  await restic.dumpTo(repo, ref.notes.id, `/${ref.folder}`, (chunk) => notes.write(chunk))
  if (ref.files) {
    const files = collect('files')
    await restic.dumpTo(repo, ref.files.id, `/${ref.folder} files.tar`, (chunk) => files.write(chunk))
  }
  return Array.from(entries.values()).sort((a, b) => (a.path < b.path ? -1 : 1))
}

/**
 * Hands the content of these paths over, piece by piece; `null` ends a file.
 * The notes snapshot first, the files stream only for what it did not hold.
 * Resolves with how many were found.
 */
export async function readBackup(
  restic: Restic,
  destination: Destination,
  ref: BackupSnapshotRef,
  paths: readonly string[],
  send: (path: string, piece: Buffer | null) => Promise<void>
): Promise<number> {
  const wanted = new Set(paths)
  let found = 0
  const reader = (): TarReader =>
    new TarReader((entry) => {
      const path = inside(entry.path, ref.folder)
      if (!path || !wanted.has(path)) return null
      wanted.delete(path)
      found += 1
      return async (chunk) => {
        if (!chunk) {
          await send(path, null)
          return
        }
        for (let offset = 0; offset < chunk.length; offset += PIECE_BYTES) await send(path, chunk.subarray(offset, offset + PIECE_BYTES))
      }
    })
  const repo = repoOf(destination)
  const notes = reader()
  await restic.dumpTo(repo, ref.notes.id, `/${ref.folder}`, (chunk) => notes.write(chunk))
  if (wanted.size > 0 && ref.files) {
    const files = reader()
    await restic.dumpTo(repo, ref.files.id, `/${ref.folder} files.tar`, (chunk) => files.write(chunk))
  }
  return found
}
