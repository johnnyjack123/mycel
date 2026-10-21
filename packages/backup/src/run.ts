import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BACKUP_GUARD_DEFAULT, type BackupGrant, type KeepPolicy } from '@obsidian-connect/shared'
import { Cache } from './cache.js'
import { bytesOf, chunksOf, hashOf, sizeOf } from './content.js'
import { fetchBlobs, fetchRooms } from './fetch.js'
import { VaultKeys } from './keys.js'
import { buildLayout, vaultFolder, type OutFile, type VaultLayout } from './layout.js'
import { log } from './log.js'
import type { Restic, ResticRepo } from './restic.js'
import { AccessEnded, SyncClient } from './sync.js'
import { TarHasher } from './tarcheck.js'
import { TarWriter } from './tar.js'
import { TrustedRefused, alignTrusted } from './trusted.js'

// One backup of one vault: fetch what changed into the encrypted cache, decide
// what the backup holds, decrypt it in memory, hand it to restic, check that
// it reads back, and then bring the trusted copy level.

export interface Destination {
  id: string
  repository: string
  password: string
  env?: Record<string, string>
  keep?: KeepPolicy
}

export interface JobConfig {
  destinations: Destination[]
  /** A folder for the decrypted copy of the newest version; null for none. */
  trusted: string | null
  /** The share of the notes, or of the files, in percent, that may vanish before the copy waits; 0: never. */
  trustedGuard?: number
}

export interface Job {
  /** Names the job's folder on the backup server; one per connected vault. */
  id: string
  grant: BackupGrant
  config: JobConfig
}

export interface DestinationReport {
  id: string
  ok: boolean
  notesSnapshot?: string
  filesSnapshot?: string
  /** No file changed since this destination's last files snapshot, so none was made. */
  filesUnchanged?: boolean
  /** `quick` every run; `deep` reads a part of the stored data and every file back. */
  checked?: 'quick' | 'deep'
  error?: string
}

export interface TrustedReport {
  ok: boolean
  /** Why the copy was left as it was. */
  held?: string
  /** The same in numbers, for a device to show. */
  shrunk?: Shrunk[]
  written?: number
  deleted?: number
  kept?: number
  error?: string
}

export interface RunReport {
  jobId: string
  vaultId: string
  startedAt: number
  finishedAt: number
  /** Every destination backed up and checked, and the trusted copy not failed. */
  ok: boolean
  /** Why nothing was backed up at all. */
  error?: string
  /** The backup key no longer opens the vault: a device has to connect it again. */
  accessEnded?: boolean
  notes: number
  files: number
  fetched: { rooms: number; blobs: number; bytes: number }
  /** Rooms whose log was another one than before - a sync server restored from a copy. */
  diverged: number
  problems: string[]
  destinations: DestinationReport[]
  trusted?: TrustedReport
}

export interface RunnerOptions {
  /** The backup server's data folder: `vaults/<job>/` holds the cache and the job's state. */
  dataDir: string
  /** The RAM disk the notes are laid out in during a run. */
  workDir: string
  restic: Restic
  now?: () => number
  /** Notes read back from each new snapshot and compared. */
  samples?: number
  /** How often the stored data is read in part, and every file of the files snapshot in full. */
  deepCheckMs?: number
  /** How often a destination is pruned after `forget`. */
  pruneMs?: number
  /** How often every room is fetched again, not only those whose tag changed. */
  verifyCacheMs?: number
  /** Fewer notes, or files, than this when the copy last followed: the guard does not count them. */
  vanishFloor?: number
}

export interface RunControl {
  /** The person confirmed that the vault lost that much on purpose; the trusted copy follows. */
  acceptShrink?: boolean
  /**
   * Forget no snapshot this time: the run a rollback asks for first, which
   * may read from an older backup right after - one this run's retention
   * would otherwise let go of. The next run forgets as usual.
   */
  keepAll?: boolean
}

interface DestinationState {
  filesDigest?: string
  filesSnapshot?: string
  deepCheckAt?: number
  pruneAt?: number
}

/** What the vault held at a run the trusted copy followed. */
export interface Counted {
  at: number
  notes: number
  /** Absent in a count from before files were counted. */
  files?: number
}

interface JobState {
  /**
   * The counts at the runs the trusted copy followed, within a week before
   * the newest - the guard measures by the most of them. Only a confirmation
   * starts it afresh.
   */
  followed?: Counted[]
  /** Before 0.7.18: the counts at the one run the copy last followed. */
  liveNotes?: number
  liveFiles?: number
  verifiedCacheAt?: number
  destinations: Record<string, DestinationState>
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const COUNTS_KEPT = 500
const TAG = 'obsidian-connect'

async function readState(path: string): Promise<JobState> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as JobState
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { destinations: {} }
    throw error
  }
}

async function writeState(path: string, state: JobState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(`${path}.tmp`, JSON.stringify(state, null, 2))
  await rename(`${path}.tmp`, path)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Changes whenever a file of the stream would: its paths and contents. */
function filesDigest(files: readonly OutFile[]): string {
  const digest = createHash('sha256')
  for (const file of files) digest.update(`${file.path}\0${hashOf(file)}\0${file.mtime}\n`)
  return digest.digest('hex')
}

/**
 * What the guard measures by: the most notes, and the most files, of the runs
 * the copy followed within the week before the newest of them. Measured by
 * the last run alone, a shrink split over two runs went through - deletions
 * still on their way to the sync server during the first, or a cleanup with
 * a scheduled run in its middle -, each half below the limit.
 */
export function guardReference(followed: readonly Counted[]): { notes?: number; files?: number } {
  const newest = followed.at(-1)?.at
  if (newest === undefined) return {}
  const recent = followed.filter((entry) => entry.at >= newest - WEEK_MS)
  const files = recent.flatMap((entry) => (entry.files === undefined ? [] : [entry.files]))
  return { notes: Math.max(...recent.map((entry) => entry.notes)), files: files.length > 0 ? Math.max(...files) : undefined }
}

/** The counts once the copy followed at `now`: within the week before, or - confirmed - only these. */
export function followedAt(followed: readonly Counted[], now: Counted, confirmed: boolean): Counted[] {
  if (confirmed) return [now]
  return [...followed.filter((entry) => entry.at >= now.at - WEEK_MS), now].slice(-COUNTS_KEPT)
}

/** A kind of which more vanished than the guard lets through: how many there are, and the most there were. */
export interface Shrunk {
  what: 'notes' | 'files'
  now: number
  before: number
}

/**
 * What vanished beyond the guard: more than `guard` percent of the notes, or
 * of the files, against `before` (`guardReference`). Counted apart - a vault
 * of a thousand pictures losing all of its fifty notes is the case to catch.
 * A count below `floor` then is too small to tell anything.
 */
export function shrunk(before: { notes?: number; files?: number }, now: { notes: number; files: number }, guard: number, floor: number): Shrunk[] {
  if (guard <= 0) return []
  const lost: Shrunk[] = []
  const count = (was: number | undefined, is: number, what: Shrunk['what']): void => {
    if (was === undefined || was < floor) return
    if (is < was * (1 - guard / 100)) lost.push({ what, now: is, before: was })
  }
  count(before.notes, now.notes, 'notes')
  count(before.files, now.files, 'files')
  return lost
}

/** Why the trusted copy should wait, in words, or null. */
export function vanished(
  before: { notes?: number; files?: number },
  now: { notes: number; files: number },
  guard: number,
  floor: number
): string | null {
  const lost = shrunk(before, now, guard, floor)
  if (lost.length === 0) return null
  const told = lost.map((kind) => `${kind.now} ${kind.what} (${kind.before} at most in the week before)`)
  return `the vault has ${told.join(' and ')}; the trusted copy waits until that is confirmed`
}

/** Lays the notes out below `root`, each file with the time it last changed. */
async function writeNotes(root: string, folder: string, files: readonly OutFile[], cache: Cache, keys: VaultKeys): Promise<void> {
  await rm(root, { recursive: true, force: true })
  await mkdir(join(root, folder), { recursive: true })
  for (const file of files) {
    const target = join(root, ...file.path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, await bytesOf(file, cache, keys))
    const seconds = file.mtime / 1000
    await utimes(target, seconds, seconds)
  }
}

/** The top-level names of the folder restic reads: the vault, its trash, its settings. */
function topLevel(folder: string, files: readonly OutFile[]): string[] {
  const names = new Set([folder])
  for (const file of files) names.add(file.path.split('/')[0] as string)
  return Array.from(names).sort()
}

export async function runBackup(job: Job, options: RunnerOptions, control: RunControl = {}): Promise<RunReport> {
  const now = options.now ?? Date.now
  const { grant } = job
  const jobDir = join(options.dataDir, 'vaults', job.id)
  const statePath = join(jobDir, 'state.json')
  const workRoot = join(options.workDir, job.id)
  const report: RunReport = {
    jobId: job.id,
    vaultId: grant.vaultId,
    startedAt: now(),
    finishedAt: 0,
    ok: false,
    notes: 0,
    files: 0,
    fetched: { rooms: 0, blobs: 0, bytes: 0 },
    diverged: 0,
    problems: [],
    destinations: []
  }
  const state = await readState(statePath)
  const cache = new Cache(join(jobDir, 'cache'))

  let layout: VaultLayout
  let keys: VaultKeys
  try {
    keys = await VaultKeys.open(grant)
    const client = new SyncClient(grant.server, grant.backupKey)
    await client.signIn()
    const verifyAll = now() - (state.verifiedCacheAt ?? 0) >= (options.verifyCacheMs ?? WEEK_MS)
    const rooms = await fetchRooms(client, cache, grant.accountId, verifyAll)
    if (verifyAll) state.verifiedCacheAt = now()
    report.fetched.rooms = rooms.fetched
    report.diverged = rooms.diverged.length
    if (rooms.diverged.length > 0) {
      report.problems.push(`${rooms.diverged.length} note(s) had another history on the sync server than before; it was restored from a copy, or rolled back`)
    }
    layout = await buildLayout(cache, keys, now())
    for (const room of await cache.rooms()) {
      if (!layout.rooms.has(room)) await cache.deleteRoom(room)
    }
    const blobs = await fetchBlobs(client, cache, keys, layout.blobs)
    report.fetched.blobs = blobs.fetched
    report.fetched.bytes = blobs.bytes
    const unavailable = new Set([...blobs.missing, ...blobs.damaged])
    if (unavailable.size > 0) {
      layout.files = layout.files.filter((file) => {
        if (file.content.kind !== 'blob' || !unavailable.has(file.content.hash)) return true
        layout.incomplete.add(file.path)
        return false
      })
      if (blobs.missing.length > 0) layout.problems.push(`${blobs.missing.length} file(s) the sync server does not have`)
      if (blobs.damaged.length > 0) layout.problems.push(`${blobs.damaged.length} file(s) whose content on the sync server is damaged`)
    }
    report.problems.push(...layout.problems)
  } catch (error) {
    report.error = error instanceof AccessEnded ? 'the backup key no longer opens the vault; connect the backup server again' : message(error)
    report.accessEnded = error instanceof AccessEnded
    report.finishedAt = now()
    log.error(`backup of ${grant.vaultId}: nothing backed up`, error)
    await writeState(statePath, state)
    return report
  }

  const folder = vaultFolder(grant.vaultName)
  const notes = layout.files.filter((file) => file.part === 'notes')
  const streamed = layout.files.filter((file) => file.part === 'files').sort((a, b) => (a.path < b.path ? -1 : 1))
  report.notes = notes.length
  report.files = streamed.length
  const digest = filesDigest(streamed)

  try {
    await writeNotes(workRoot, folder, notes, cache, keys)
    for (const destination of job.config.destinations) {
      report.destinations.push(await backUpTo(destination, workRoot, folder, notes, streamed, digest, state, cache, keys, options, now, control))
    }
  } catch (error) {
    report.error = message(error)
    log.error(`backup of ${grant.vaultId} failed`, error)
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }

  const live = { notes: layout.liveNotes, files: layout.liveFiles }
  const counted: Counted = { at: now(), ...live }
  // A count kept by 0.7.17 or older goes on as the first of the list.
  state.followed ??= state.liveNotes === undefined ? [] : [{ at: counted.at, notes: state.liveNotes, files: state.liveFiles }]
  delete state.liveNotes
  delete state.liveFiles
  if (job.config.trusted) {
    const guard = job.config.trustedGuard ?? BACKUP_GUARD_DEFAULT
    const reference = guardReference(state.followed)
    const lost = control.acceptShrink ? [] : shrunk(reference, live, guard, options.vanishFloor ?? 10)
    const held = lost.length > 0 ? vanished(reference, live, guard, options.vanishFloor ?? 10) : null
    // Following with the guard off takes whatever vanished, as a confirmation does.
    const confirmed = control.acceptShrink === true || guard <= 0
    if (!report.destinations.some((destination) => destination.ok)) {
      // Never ahead of the repository: what the copy deletes is in a snapshot first.
      report.trusted = { ok: false, error: 'left as it was, since the repository did not take this backup' }
    } else if (held) {
      // Nothing is counted while it waits: the counts it waits against stay, however long.
      report.trusted = { ok: true, held, shrunk: lost }
      log.warn(`backup of ${grant.vaultId}: trusted copy held, ${held}`)
    } else {
      try {
        const aligned = await alignTrusted(job.config.trusted, grant.vaultId, folder, layout.files, layout.incomplete, cache, keys)
        report.trusted = { ok: true, ...aligned }
        state.followed = followedAt(state.followed, counted, confirmed)
      } catch (error) {
        report.trusted = { ok: false, error: message(error) }
        if (!(error instanceof TrustedRefused)) log.error(`backup of ${grant.vaultId}: trusted copy failed`, error)
      }
    }
  } else {
    state.followed = followedAt(state.followed, counted, false)
  }

  report.ok = !report.error && report.destinations.every((destination) => destination.ok) && report.trusted?.ok !== false
  report.finishedAt = now()
  await writeState(statePath, state)
  log.info(
    `backup of ${grant.vaultId}: ${report.ok ? 'done' : 'failed'} - ${report.notes} notes, ${report.files} files, ` +
      `${report.fetched.rooms} rooms and ${report.fetched.blobs} files fetched, ${report.problems.length} problem(s)`
  )
  return report
}

async function backUpTo(
  destination: Destination,
  workRoot: string,
  folder: string,
  notes: readonly OutFile[],
  streamed: readonly OutFile[],
  digest: string,
  state: JobState,
  cache: Cache,
  keys: VaultKeys,
  options: RunnerOptions,
  now: () => number,
  control: RunControl
): Promise<DestinationReport> {
  const restic = options.restic
  const repo: ResticRepo = { repository: destination.repository, password: destination.password, env: destination.env }
  const known = (state.destinations[destination.id] ??= {})
  const result: DestinationReport = { id: destination.id, ok: false }
  try {
    await restic.ensureRepo(repo)
    const notesSummary = await restic.backupFolder(repo, workRoot, topLevel(folder, notes), [TAG, 'notes'])
    result.notesSnapshot = notesSummary.snapshotId

    const tarName = `${folder} files.tar`
    let streamedBytes: number | null = null
    const existing = known.filesSnapshot && known.filesDigest === digest ? await restic.snapshots(repo, 'files') : []
    if (known.filesSnapshot && existing.some((snapshot) => snapshot.id === known.filesSnapshot)) {
      result.filesUnchanged = true
      result.filesSnapshot = known.filesSnapshot
    } else {
      const filesSummary = await restic.backupStream(repo, tarName, [TAG, 'files'], async (stdin) => {
        const tar = new TarWriter(stdin)
        for (const file of streamed) await tar.file(file.path, sizeOf(file), file.mtime, chunksOf(file, cache, keys))
        await tar.end()
        streamedBytes = tar.bytes
      })
      result.filesSnapshot = filesSummary.snapshotId
      known.filesSnapshot = filesSummary.snapshotId
      known.filesDigest = digest
    }

    if (destination.keep && !control.keepAll) {
      await restic.forget(repo, destination.keep)
      if (now() - (known.pruneAt ?? 0) >= (options.pruneMs ?? WEEK_MS)) {
        await restic.prune(repo)
        known.pruneAt = now()
      }
    }

    const deep = now() - (known.deepCheckAt ?? 0) >= (options.deepCheckMs ?? WEEK_MS)
    await checkBackup(repo, result.notesSnapshot, result.filesSnapshot, tarName, notes, streamed, streamedBytes, deep, cache, keys, options)
    if (deep) known.deepCheckAt = now()
    result.checked = deep ? 'deep' : 'quick'
    result.ok = true
  } catch (error) {
    result.error = message(error)
    log.error(`backup to ${destination.id} failed`, error)
  }
  return result
}

/**
 * Reads the new snapshots back: restic's own check of the repository, every
 * note's path and size in the listing, a few notes compared byte for byte -
 * and, in a deep check, a part of the stored data and every file of the files
 * snapshot by its hash.
 */
async function checkBackup(
  repo: ResticRepo,
  notesSnapshot: string,
  filesSnapshot: string,
  tarName: string,
  notes: readonly OutFile[],
  streamed: readonly OutFile[],
  streamedBytes: number | null,
  deep: boolean,
  cache: Cache,
  keys: VaultKeys,
  options: RunnerOptions
): Promise<void> {
  const restic = options.restic
  await restic.check(repo, deep ? '5%' : undefined)

  const listed = await restic.ls(repo, notesSnapshot)
  const sizes = new Map<string, number>()
  for (const entry of listed) if (entry.type === 'file') sizes.set(entry.path.replace(/^\/+/, ''), entry.size ?? -1)
  const missing = notes.filter((file) => sizes.get(file.path) !== sizeOf(file))
  if (missing.length > 0) throw new Error(`the notes snapshot lacks ${missing.length} file(s) or has them at another size`)
  if (sizes.size !== notes.length) throw new Error(`the notes snapshot holds ${sizes.size} files, not ${notes.length}`)

  // The newest notes, which are the ones most likely to have changed.
  const sample = [...notes].sort((a, b) => b.mtime - a.mtime).slice(0, options.samples ?? 3)
  for (const file of sample) {
    const back = await restic.dump(repo, notesSnapshot, `/${file.path}`)
    if (!back.equals(await bytesOf(file, cache, keys))) throw new Error('a note read back from the snapshot differs from what was backed up')
  }

  const files = (await restic.ls(repo, filesSnapshot)).filter((entry) => entry.type === 'file')
  const tar = files.find((entry) => entry.path.replace(/^\/+/, '') === tarName)
  if (!tar) throw new Error('the files snapshot holds no stream')
  if (streamedBytes !== null && tar.size !== streamedBytes) throw new Error('the files snapshot is not as long as the stream that went in')

  if (deep) {
    const hasher = new TarHasher()
    await restic.dumpTo(repo, filesSnapshot, `/${tarName}`, async (chunk) => hasher.write(chunk))
    if (!hasher.complete) throw new Error('the files snapshot ends in the middle of a file')
    // An older files snapshot is used only while the files are as they were
    // then, so it is held against this run's files too.
    const wrong = streamed.filter((file) => hasher.hashes.get(file.path) !== hashOf(file))
    if (wrong.length > 0 || hasher.hashes.size !== streamed.length) {
      throw new Error(`${wrong.length} file(s) of the files snapshot do not read back as they went in`)
    }
  }
}
