import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep, isAbsolute } from 'node:path'
import {
  BACKUP_SCHEDULE_KEY,
  BACKUP_TARGET_KEY,
  SETTINGS_FIELD,
  backupGuard,
  backupSettingsText,
  settingsRoom,
  type BackupScheduleSetting,
  type BackupTargetSetting,
  type KeepPolicy
} from '@obsidian-connect/shared'
import type { VaultKeys } from './keys.js'
import type { Destination, JobConfig } from './run.js'
import { SyncError, type SyncClient } from './sync.js'

// What a vault's owner set for this backup server, read from the vault's
// account-wide settings document - encrypted, synced to every device, read
// here with the backup key - and checked against what the backup server may
// do: local paths only below its backup folder, and never into another
// vault's destination.

export interface VaultConfig {
  config: JobConfig
  /** 0: only when started by hand. */
  everyHours: number
  /** Settings this backup server cannot use, and why. */
  problems: string[]
  /** The local folders the destinations use, absolute. */
  localPaths: string[]
  /** The ids of the targets taken. */
  accepted: string[]
  /** The ids of every target for this backup server, taken or not. */
  seen: string[]
  /** Of what was read for this route, for the devices to tell it read their newest settings. */
  digest: string
}

const KEEP_RULES = ['last', 'hourly', 'daily', 'weekly', 'monthly', 'yearly'] as const

/** restic's own name for a local repository, or a Windows drive - everything else with a scheme is remote. */
export function isRemote(location: string): boolean {
  if (/^local:/i.test(location) || /^[a-z]:[\\/]/i.test(location)) return false
  return /^[a-z][a-z0-9+.-]*:/i.test(location)
}

/** The absolute folder a local location means, or why it may not be used. */
export function localFolder(location: string, root: string): { path: string } | { error: string } {
  const plain = location.replace(/^local:/i, '').trim()
  if (plain === '') return { error: 'no folder given' }
  const absolute = resolve(root, plain)
  const below = relative(resolve(root), absolute)
  if (below === '' || below.startsWith('..') || isAbsolute(below)) return { error: `${location} is not a folder below ${root}` }
  return { path: absolute }
}

/** Whether two folders are one, or one lies inside the other. */
export function overlapping(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`)
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

export function envOf(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const env: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    // A variable that would point restic elsewhere is the backup server's to set.
    if (/^[A-Z_][A-Z0-9_]*$/i.test(key) && typeof entry === 'string' && !/^RESTIC_(REPOSITORY|PASSWORD|CACHE_DIR)/i.test(key)) env[key] = entry
  }
  return Object.keys(env).length > 0 ? env : undefined
}

/**
 * The settings for this backup server from the vault's settings map.
 * `elsewhere`: local folders other vaults' destinations use here.
 */
export function readConfig(settings: ReadonlyMap<string, unknown>, routeId: string, root: string, elsewhere: readonly string[]): VaultConfig {
  const result: VaultConfig = {
    config: { destinations: [], trusted: null },
    everyHours: 0,
    problems: [],
    localPaths: [],
    accepted: [],
    seen: [],
    digest: createHash('sha256').update(backupSettingsText(settings, routeId)).digest('hex')
  }
  const schedule = settings.get(`${BACKUP_SCHEDULE_KEY}${routeId}`) as Partial<BackupScheduleSetting> | undefined
  if (schedule && typeof schedule.everyHours === 'number' && Number.isFinite(schedule.everyHours) && schedule.everyHours > 0) {
    result.everyHours = Math.max(1, Math.round(schedule.everyHours))
  }

  const targets: BackupTargetSetting[] = []
  for (const [key, value] of settings) {
    if (!key.startsWith(BACKUP_TARGET_KEY) || !value || typeof value !== 'object') continue
    const target = value as Partial<BackupTargetSetting>
    if (target.server !== routeId || typeof target.id !== 'string' || typeof target.location !== 'string') continue
    targets.push(target as BackupTargetSetting)
  }
  targets.sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0) || (a.id < b.id ? -1 : 1))
  result.seen = targets.map((target) => target.id)

  const claim = (target: BackupTargetSetting, path: string): boolean => {
    if (elsewhere.some((other) => overlapping(other, path))) {
      result.problems.push(`${target.location}: another vault on this backup server uses this folder, or one around it`)
      return false
    }
    if (result.localPaths.some((own) => overlapping(own, path))) {
      result.problems.push(`${target.location}: lies in or around another destination of this vault`)
      return false
    }
    result.localPaths.push(path)
    return true
  }

  for (const target of targets) {
    if (target.kind === 'trusted') {
      if (result.config.trusted) {
        result.problems.push(`${target.location}: only one trusted copy per backup server`)
        continue
      }
      const folder = localFolder(target.location, root)
      if ('error' in folder) {
        result.problems.push(folder.error)
        continue
      }
      if (claim(target, folder.path)) {
        result.config.trusted = folder.path
        result.config.trustedGuard = backupGuard(target.guard)
        result.accepted.push(target.id)
      }
      continue
    }
    if (target.kind !== 'restic') continue
    if (typeof target.password !== 'string' || target.password === '') {
      result.problems.push(`${target.location}: the repository needs a password`)
      continue
    }
    let repository = target.location.trim()
    if (!isRemote(repository)) {
      const folder = localFolder(repository, root)
      if ('error' in folder) {
        result.problems.push(folder.error)
        continue
      }
      if (!claim(target, folder.path)) continue
      repository = folder.path
    }
    const destination: Destination = { id: target.id, repository, password: target.password }
    const env = envOf(target.env)
    if (env) destination.env = env
    const keep = keepOf(target.keep)
    if (keep) destination.keep = keep
    result.config.destinations.push(destination)
    result.accepted.push(target.id)
  }
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
    const probe = join(folder, `.obsidian-connect-probe-${process.pid}`)
    await writeFile(probe, '')
    await rm(probe, { force: true })
    return null
  } catch (error) {
    return `cannot write into ${folder}: ${error instanceof Error ? error.message : String(error)}`
  }
}
