import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BACKUP_TASK_KEY,
  SETTINGS_FIELD,
  backupGuard,
  backupSettingsText,
  scheduleHours,
  settingsRoom,
  type BackupAt,
  type BackupTaskSetting,
  type KeepPolicy
} from '@mycel/shared'
import type { VaultKeys } from './keys.js'
import type { Destination, JobConfig } from './run.js'
import { atOf, knownZone } from './schedule.js'
import { SyncError, type SyncClient } from './sync.js'

// What a vault's owner set for this backup server - its backup task, read
// from the vault's account-wide settings document: encrypted, synced to every
// device, read here with the backup key. The folders are this backup
// server's to pick, never the settings': a repository on it lies in its
// folder for encrypted vaults under the vault's id, the decrypted copy in its
// folder for decrypted vaults under the account's name and the vault's.

export interface VaultConfig {
  config: JobConfig
  /** About how many hours lie between two backups; 0: only when started by hand. */
  everyHours: number
  /** At a time of day instead of every so many hours. */
  at: BackupAt | null
  /** It found the task, and can carry it out. */
  ready: boolean
  /** What in the task this backup server cannot use, and why. */
  problems: string[]
  /** Of what was read for this route, for the devices to tell it read their newest settings. */
  digest: string
}

/** This backup server's folders for one vault, absolute. */
export interface VaultFolders {
  /** The repository, when the task keeps it on the backup server. */
  encrypted: string
  /** The decrypted copy. */
  decrypted: string
}

const KEEP_RULES = ['last', 'hourly', 'daily', 'weekly', 'monthly', 'yearly'] as const

/** restic's own name for a local repository, or a Windows drive - everything else with a scheme is remote. */
export function isRemote(location: string): boolean {
  if (/^local:/i.test(location) || /^[a-z]:[\\/]/i.test(location)) return false
  return /^[a-z][a-z0-9+.-]*:/i.test(location)
}

function keepOf(value: unknown): KeepPolicy | undefined {
  if (!value || typeof value !== 'object') return undefined
  const keep: KeepPolicy = {}
  for (const rule of KEEP_RULES) {
    const count = (value as Record<string, unknown>)[rule]
    if (typeof count === 'number' && Number.isInteger(count) && count > 0) keep[rule] = count
  }
  return Object.keys(keep).length > 0 ? keep : undefined
}

/**
 * The credentials a cloud location may need, and nothing else. Every variable
 * a task named went into restic's environment before - and restic's, rclone's
 * and ssh's: `LD_PRELOAD` with a library the person's own decrypted copy put on
 * this disk, `RCLONE_CONFIG` or `AWS_SHARED_CREDENTIALS_FILE` naming a file of
 * theirs that runs a command, `SSH_ASKPASS`. Any person paired here could run
 * code on the backup server, and read every other vault on it.
 */
const CREDENTIALS = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_DEFAULT_REGION',
  'AWS_REGION',
  'B2_ACCOUNT_ID',
  'B2_ACCOUNT_KEY',
  'AZURE_ACCOUNT_NAME',
  'AZURE_ACCOUNT_KEY',
  'AZURE_ACCOUNT_SAS',
  'AZURE_ENDPOINT_SUFFIX',
  'GOOGLE_PROJECT_ID',
  'GOOGLE_ACCESS_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'RESTIC_REST_USERNAME',
  'RESTIC_REST_PASSWORD',
  'RESTIC_COMPRESSION',
  'RESTIC_PACK_SIZE'
])
/** OpenStack Swift's credentials, by their prefixes. */
const SWIFT = /^(OS|ST)_[A-Z0-9_]+$/

function hasControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function envOf(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const env: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string' || hasControl(entry)) continue
    if (CREDENTIALS.has(key) || (SWIFT.test(key) && !/(COMMAND|PROGRAM|EXEC)/.test(key))) env[key] = entry
  }
  return Object.keys(env).length > 0 ? env : undefined
}

/**
 * Why restic must not be handed a location, or null. restic hands the host of
 * an `sftp:` location to ssh and the remote of an `rclone:` one to rclone as
 * arguments of their own: one starting with `-` is an option to them -
 * `-oProxyCommand=…` runs a command.
 */
export function locationProblem(location: string): string | null {
  if (hasControl(location)) return 'it holds a control character'
  if (/\s/.test(location)) return 'it holds a space'
  const rest = location.replace(/^[a-z][a-z0-9+.-]*:/i, '').replace(/^\/\//, '')
  if (rest.startsWith('-')) return 'it starts with "-"'
  const at = rest.indexOf('@')
  if (at >= 0 && rest.slice(at + 1).startsWith('-')) return 'its host starts with "-"'
  return null
}

/**
 * The repository a task names - this backup server's folder for the vault, or
 * the cloud location -, under an id that changes with it: what a run keeps
 * per repository must not carry over to another one.
 */
export function repositoryOf(task: Partial<BackupTaskSetting>, folders: VaultFolders): Destination | { error: string } {
  if (typeof task.password !== 'string' || task.password === '') return { error: 'the repository needs a password' }
  if (task.where === 'local') return { id: 'local', repository: folders.encrypted, password: task.password }
  if (task.where !== 'cloud') return { error: 'the task says neither "local" nor "cloud" for the repository' }
  const location = typeof task.location === 'string' ? task.location.trim() : ''
  if (!isRemote(location)) return { error: `"${location}" is not a cloud location: one restic reaches, such as s3:…, b2:…, rest:… or sftp:…` }
  const problem = locationProblem(location)
  if (problem) return { error: `"${location}" is not taken: ${problem}` }
  const destination: Destination = {
    id: `cloud-${createHash('sha256').update(location).digest('hex').slice(0, 12)}`,
    repository: location,
    password: task.password
  }
  const env = envOf(task.env)
  if (env) destination.env = env
  return destination
}

/** The vault's backup task for this backup server, from the vault's settings map. */
export function readConfig(settings: ReadonlyMap<string, unknown>, routeId: string, folders: VaultFolders): VaultConfig {
  const result: VaultConfig = {
    config: { destinations: [], trusted: null },
    everyHours: 0,
    at: null,
    ready: false,
    problems: [],
    digest: createHash('sha256').update(backupSettingsText(settings, routeId)).digest('hex')
  }
  const value = settings.get(`${BACKUP_TASK_KEY}${routeId}`)
  if (!value || typeof value !== 'object') return result
  const task = value as Partial<BackupTaskSetting>
  if (task.server !== routeId) return result
  if (typeof task.everyHours === 'number' && Number.isFinite(task.everyHours) && task.everyHours > 0) {
    result.everyHours = Math.max(1, Math.round(task.everyHours))
  }
  const at = atOf(task.at)
  if (at) {
    if (!knownZone(at.zone)) result.problems.push(`the time zone ${at.zone} is not known on the backup server, so it goes by UTC`)
    result.at = at
    result.everyHours = scheduleHours({ everyHours: result.everyHours, at })
  }
  const destination = repositoryOf(task, folders)
  if ('error' in destination) {
    result.problems.push(destination.error)
    return result
  }
  const keep = keepOf(task.keep)
  if (keep) destination.keep = keep
  result.config.destinations.push(destination)
  if (task.decrypted === true) {
    result.config.trusted = folders.decrypted
    result.config.trustedGuard = backupGuard(task.guard)
  }
  result.ready = true
  return result
}

/** The vault's settings document, fetched and decrypted, as a plain map. */
export async function fetchSettings(client: SyncClient, keys: VaultKeys): Promise<Map<string, unknown>> {
  const room = settingsRoom(keys.grant.vaultId)
  let log: Awaited<ReturnType<SyncClient['log']>>
  try {
    log = await client.log(room)
  } catch (error) {
    // No device of the account stored a setting yet: a room the vault does not have.
    if (error instanceof SyncError && (error.status === 404 || error.status === 403)) return new Map()
    throw error
  }
  const replayed = await keys.replay({
    room,
    owner: keys.grant.accountId,
    tag: '',
    epoch: log.epoch,
    headSeq: log.headSeq,
    snapshot: log.snapshot,
    frames: log.frames,
    sealed: {}
  })
  try {
    return new Map(replayed.doc.getMap<unknown>(SETTINGS_FIELD).entries())
  } finally {
    replayed.doc.destroy()
  }
}

/** Whether the backup server can write into a folder: made if missing, a file written and removed. */
export async function writable(folder: string): Promise<string | null> {
  try {
    await mkdir(folder, { recursive: true })
    const probe = join(folder, `.mycel-probe-${process.pid}`)
    await writeFile(probe, '')
    await rm(probe, { force: true })
    return null
  } catch (error) {
    return `cannot write into ${folder}: ${error instanceof Error ? error.message : String(error)}`
  }
}
