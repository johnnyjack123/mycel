import { access, mkdir, readFile, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isHexId,
  type BackupGrant,
  type BackupListedEntry,
  type BackupRunStatus,
  type BackupServerInfo,
  type BackupSnapshotRef,
  type BackupVaultStatus
} from '@obsidian-connect/shared'
import { backupRouteKeys, newBackupSecret, toBase64 } from '@obsidian-connect/shared/crypto'
import { fetchSettings, readConfig, type VaultConfig } from './config.js'
import { VaultKeys } from './keys.js'
import { log } from './log.js'
import type { Restic } from './restic.js'
import { vaultFolder } from './layout.js'
import { listBackup, readBackup, snapshotAt } from './restore.js'
import { runBackup, type Destination, type RunControl, type RunReport } from './run.js'
import { AccessEnded, SyncClient } from './sync.js'

// The vaults paired with this backup server, their settings, their runs and
// their schedule. One run at a time over all vaults: each lays its notes out
// in memory, and two at once would double what that takes.
//
//   vaults/<vaultId>/pairing.json   the vault's secret with this backup server, and whose vault it is
//   vaults/<vaultId>/grant.json     the backup key and the vault's keys, from a device
//   vaults/<vaultId>/runs.json      the last runs, for the devices' status

export interface ServiceOptions {
  /** The sync server this backup server registers at and reads from. */
  server: string
  dataDir: string
  /** The folder local destinations lie below. */
  root: string
  /** The RAM disk. */
  workDir: string
  restic: Restic
  name: string
  version: string
  now?: () => number
  /** Runs kept per vault for its status. */
  keepRuns?: number
}

/** A vault's own way to this backup server: its secret, its route, the account it belongs to. */
export interface Pairing {
  /** Base64. */
  secret: string
  routeId: string
  accountId: string
  /** What the operator called the invitation it came with. */
  label: string
  pairedAt: number
}

interface Vault {
  grant: BackupGrant
  pairing: Pairing
  config: VaultConfig | null
  /** When the settings were last read. */
  configAt: number
  running: boolean
  runs: RunReport[]
}

const HOUR_MS = 60 * 60 * 1000

function vaultDir(dataDir: string, vaultId: string): string {
  return join(dataDir, 'vaults', vaultId)
}

async function writeJson(path: string, value: unknown, mode?: number): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2), mode === undefined ? undefined : { mode })
  await rename(`${path}.tmp`, path)
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}

function statusOf(report: RunReport): BackupRunStatus {
  const { startedAt, finishedAt, ok, error, accessEnded, notes, files, problems, destinations, trusted } = report
  return { startedAt, finishedAt, ok, error, accessEnded, notes, files, problems, destinations, trusted }
}

/** One paired vault, as the operator's `vaults` command lists it. */
export interface PairedVault {
  vaultId: string
  vaultName: string
  accountId: string
  label: string
  pairedAt: number
  lastRun: { at: number; ok: boolean } | null
}

/** What the operator sees of every paired vault, read straight from the data folder. */
export async function listVaults(dataDir: string): Promise<PairedVault[]> {
  const found: PairedVault[] = []
  let names: string[] = []
  try {
    names = await readdir(join(dataDir, 'vaults'))
  } catch {
    return found
  }
  for (const vaultId of names.filter(isHexId)) {
    try {
      const dir = vaultDir(dataDir, vaultId)
      const pairing = JSON.parse(await readFile(join(dir, 'pairing.json'), 'utf8')) as Pairing
      const grant = JSON.parse(await readFile(join(dir, 'grant.json'), 'utf8')) as BackupGrant
      const runs = await readFile(join(dir, 'runs.json'), 'utf8').then(
        (raw) => JSON.parse(raw) as RunReport[],
        () => []
      )
      const last = runs.at(-1)
      found.push({
        vaultId,
        vaultName: grant.vaultName,
        accountId: pairing.accountId,
        label: pairing.label,
        pairedAt: pairing.pairedAt,
        lastRun: last ? { at: last.startedAt, ok: last.ok } : null
      })
    } catch {
      // half written, or from before pairings: not a vault to list
    }
  }
  return found
}

export class BackupService {
  private readonly vaults = new Map<string, Vault>()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly waiting = new Map<string, Promise<RunReport>>()
  private readonly listeners = new Set<(vaultId: string, report: RunReport) => void>()
  private readonly routeListeners = new Set<() => void>()
  private readonly listings = new Map<string, BackupListedEntry[]>()

  private constructor(private readonly options: ServiceOptions) {}

  static async open(options: ServiceOptions): Promise<BackupService> {
    const service = new BackupService(options)
    const dir = join(options.dataDir, 'vaults')
    let names: string[] = []
    try {
      names = await readdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const vaultId of names.filter(isHexId)) {
      try {
        const grant = JSON.parse(await readFile(join(dir, vaultId, 'grant.json'), 'utf8')) as BackupGrant
        const pairing = JSON.parse(await readFile(join(dir, vaultId, 'pairing.json'), 'utf8')) as Pairing
        const runs = await readFile(join(dir, vaultId, 'runs.json'), 'utf8').then(
          (raw) => JSON.parse(raw) as RunReport[],
          () => []
        )
        service.vaults.set(vaultId, { grant, pairing, config: null, configAt: 0, running: false, runs })
      } catch (error) {
        log.warn(`vault ${vaultId} could not be loaded`, error)
      }
    }
    return service
  }

  private get now(): number {
    return (this.options.now ?? Date.now)()
  }

  /** Every run that finished, for the sessions that wait for it. */
  onFinished(listener: (vaultId: string, report: RunReport) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** A vault was paired or let go: the routes to answer changed. */
  onRoutesChanged(listener: () => void): () => void {
    this.routeListeners.add(listener)
    return () => this.routeListeners.delete(listener)
  }

  private routesChanged(): void {
    for (const listener of this.routeListeners) listener()
  }

  has(vaultId: string): boolean {
    return this.vaults.has(vaultId)
  }

  /** Every paired vault's route and secret. */
  pairings(): Array<{ vaultId: string; pairing: Pairing }> {
    return Array.from(this.vaults, ([vaultId, vault]) => ({ vaultId, pairing: vault.pairing }))
  }

  async info(): Promise<BackupServerInfo> {
    let free: number | undefined
    try {
      const stats = await statfs(this.options.root)
      free = stats.bavail * stats.bsize
    } catch {
      // not every system says
    }
    let restic = ''
    try {
      restic = await this.options.restic.version()
    } catch (error) {
      restic = `not usable: ${error instanceof Error ? error.message : String(error)}`
    }
    return { name: this.options.name, version: this.options.version, restic, root: this.options.root, free }
  }

  /** The backup key has to open the vault on the sync server this backup server talks to. */
  private async check(grant: BackupGrant): Promise<void> {
    if (!isHexId(grant.vaultId) || !isHexId(grant.accountId) || typeof grant.backupKey !== 'string') throw new Error('not a grant')
    await VaultKeys.open(grant)
    let session
    try {
      session = await new SyncClient(this.options.server, grant.backupKey).signIn()
    } catch (error) {
      if (error instanceof AccessEnded) throw new Error('the backup key does not open a vault on the sync server this backup server uses')
      throw error
    }
    if (session.vaultId !== grant.vaultId || session.accountId !== grant.accountId) throw new Error('the backup key belongs to another vault')
  }

  /**
   * Pairs a vault handed over with an invitation: a secret of its own from now
   * on, and the account it belongs to. A vault paired already is never taken
   * over by another account; its own account pairing it again replaces the
   * pairing, whose route is answered here: `replaced`.
   */
  async connect(grant: BackupGrant, label: string): Promise<{ pairing: Pairing; replaced: string | null }> {
    await this.check(grant)
    const existing = this.vaults.get(grant.vaultId)
    if (existing && existing.pairing.accountId !== grant.accountId) throw new Error('this vault is paired here with another account')
    const replaced = existing?.pairing.routeId ?? null
    const secret = newBackupSecret()
    const pairing: Pairing = {
      secret: toBase64(secret),
      routeId: (await backupRouteKeys(secret)).routeId,
      accountId: grant.accountId,
      label,
      pairedAt: this.now
    }
    const dir = vaultDir(this.options.dataDir, grant.vaultId)
    await mkdir(dir, { recursive: true })
    await writeJson(join(dir, 'grant.json'), grant, 0o600)
    await writeJson(join(dir, 'pairing.json'), pairing, 0o600)
    if (existing) {
      existing.grant = grant
      existing.pairing = pairing
      // Its settings were read under the old pairing's route; the device moves them to the new one.
      existing.config = null
      existing.configAt = 0
    } else {
      this.vaults.set(grant.vaultId, { grant, pairing, config: null, configAt: 0, running: false, runs: [] })
    }
    log.info(`vault ${grant.vaultId} paired${label ? ` (${label})` : ''}`)
    this.routesChanged()
    return { pairing, replaced }
  }

  /** A new backup key for a paired vault: a password change ended the one before. */
  async rekey(vaultId: string, grant: BackupGrant): Promise<void> {
    const vault = this.vaults.get(vaultId)
    if (!vault) throw new Error('this backup server no longer has this vault')
    if (grant.vaultId !== vaultId || grant.accountId !== vault.pairing.accountId) throw new Error('that grant is not for this vault')
    await this.check(grant)
    await writeJson(join(vaultDir(this.options.dataDir, vaultId), 'grant.json'), grant, 0o600)
    vault.grant = grant
    log.info(`vault ${vaultId} got a new backup key`)
  }

  /**
   * Forgets a vault: its keys, its cache, its runs. Its repositories and
   * trusted copy stay where they are. `announce`: drop its route now - a
   * session on that route answers first and announces it after
   * (`announceRoutes`), since the relay ends the session with its route.
   */
  async disconnect(vaultId: string, announce = true): Promise<void> {
    this.vaults.delete(vaultId)
    await rm(vaultDir(this.options.dataDir, vaultId), { recursive: true, force: true })
    log.info(`vault ${vaultId} disconnected`)
    if (announce) this.routesChanged()
  }

  /** The routes to answer changed, said by whoever held it back. */
  announceRoutes(): void {
    this.routesChanged()
  }

  /**
   * Lets go of vaults the operator disconnected on the command line, which
   * takes their folder: they are not answered any more.
   */
  async reload(): Promise<void> {
    let changed = false
    for (const vaultId of Array.from(this.vaults.keys())) {
      const dir = vaultDir(this.options.dataDir, vaultId)
      if ((await exists(join(dir, 'pairing.json'))) && (await exists(join(dir, 'grant.json')))) continue
      if (this.vaults.get(vaultId)?.running) continue
      this.vaults.delete(vaultId)
      // A run that was under way may have written its cache again meanwhile; it goes too.
      await rm(dir, { recursive: true, force: true })
      log.info(`vault ${vaultId} was disconnected on the command line`)
      changed = true
    }
    if (changed) this.routesChanged()
  }

  // --- a rollback reading from the backups ------------------------------------------

  /** The repositories a vault backs up into, and its folder in them; the settings are read when not known yet. */
  private async repositories(vaultId: string): Promise<{ destinations: Destination[]; folder: string }> {
    const vault = this.vaults.get(vaultId)
    if (!vault) throw new Error('this backup server no longer has this vault')
    const config = vault.config ?? (await this.refresh(vaultId))
    return { destinations: config.config.destinations, folder: vaultFolder(vault.grant.vaultName) }
  }

  /** The repository a device names for a backup - one of this vault's, never anyone else's. */
  private async repository(vaultId: string, ref: BackupSnapshotRef): Promise<{ destination: Destination; ref: BackupSnapshotRef }> {
    const { destinations, folder } = await this.repositories(vaultId)
    const destination = destinations.find((candidate) => candidate.id === ref?.destination)
    if (!destination || typeof ref.notes?.id !== 'string') throw new Error('that is not a backup of this vault')
    // The folder is this backup server's to know, whatever the device sent.
    return { destination, ref: { ...ref, folder } }
  }

  /** The newest backup of the vault at or before `at`, over its repositories. */
  async backupAt(vaultId: string, at: number): Promise<BackupSnapshotRef | null> {
    const { destinations, folder } = await this.repositories(vaultId)
    return snapshotAt(this.options.restic, destinations, vaultId, folder, at)
  }

  /** What a backup holds; kept a while, since a rollback asks again right after. */
  async listBackup(vaultId: string, ref: BackupSnapshotRef): Promise<BackupListedEntry[]> {
    const found = await this.repository(vaultId, ref)
    const key = `${vaultId}:${found.destination.id}:${found.ref.notes.id}:${found.ref.files?.id ?? ''}`
    const known = this.listings.get(key)
    if (known) return known
    const listed = await listBackup(this.options.restic, found.destination, found.ref)
    this.listings.set(key, listed)
    for (const old of Array.from(this.listings.keys()).slice(0, Math.max(0, this.listings.size - 4))) this.listings.delete(old)
    return listed
  }

  /** Hands the content of these paths of a backup over, piece by piece. */
  async readBackup(vaultId: string, ref: BackupSnapshotRef, paths: string[], send: (path: string, piece: Buffer | null) => Promise<void>): Promise<number> {
    const found = await this.repository(vaultId, ref)
    log.info(`vault ${vaultId}: ${paths.length} note(s) or file(s) read back from a backup for a rollback`)
    return readBackup(this.options.restic, found.destination, found.ref, paths, send)
  }

  /** The local folders every other vault's destinations use here. */
  localPathsBesides(vaultId: string): string[] {
    return Array.from(this.vaults.entries())
      .filter(([id]) => id !== vaultId)
      .flatMap(([, other]) => other.config?.localPaths ?? [])
  }

  /** Reads the vault's settings again: the entries naming its pairing's route. */
  async refresh(vaultId: string): Promise<VaultConfig> {
    const vault = this.vaults.get(vaultId)
    if (!vault) throw new Error('this backup server no longer has this vault')
    const keys = await VaultKeys.open(vault.grant)
    const settings = await fetchSettings(new SyncClient(this.options.server, vault.grant.backupKey), keys)
    vault.config = readConfig(settings, vault.pairing.routeId, this.options.root, this.localPathsBesides(vaultId))
    vault.configAt = this.now
    return vault.config
  }

  status(vaultId: string): BackupVaultStatus {
    const vault = this.vaults.get(vaultId)
    if (!vault) throw new Error('this backup server no longer has this vault')
    return {
      vaultId,
      running: vault.running || this.waiting.has(vaultId),
      nextRunAt: this.nextRunAt(vault),
      targets: vault.config?.accepted ?? [],
      seen: vault.config?.seen ?? [],
      everyHours: vault.config?.everyHours ?? 0,
      settingsDigest: vault.config?.digest ?? '',
      problems: vault.config?.problems ?? [],
      runs: vault.runs.map(statusOf).reverse()
    }
  }

  private nextRunAt(vault: Vault): number | null {
    const hours = vault.config?.everyHours ?? 0
    if (hours <= 0) return null
    return (vault.runs.at(-1)?.startedAt ?? vault.pairing.pairedAt) + hours * HOUR_MS
  }

  /** Queues a run; a vault already waiting is not queued twice. */
  run(vaultId: string, control: RunControl = {}): Promise<RunReport> {
    const pending = this.waiting.get(vaultId)
    if (pending) return pending
    const queued = this.queue.then(() => this.runNow(vaultId, control))
    this.waiting.set(vaultId, queued)
    this.queue = queued.catch(() => undefined)
    void queued.finally(() => this.waiting.delete(vaultId)).catch(() => undefined)
    return queued
  }

  private async runNow(vaultId: string, control: RunControl): Promise<RunReport> {
    const vault = this.vaults.get(vaultId)
    if (!vault) throw new Error('this backup server no longer has this vault')
    vault.running = true
    let report: RunReport
    try {
      let config: VaultConfig | null = null
      try {
        config = await this.refresh(vaultId)
      } catch (error) {
        // Without the settings, the last ones known are the best guess; with none, nothing runs.
        config = vault.config
        if (!config) throw error
      }
      if (config.config.destinations.length === 0 && !config.config.trusted) throw new Error('no destination is set for this backup server')
      report = await runBackup(
        { id: vaultId, grant: { ...vault.grant, server: this.options.server }, config: config.config },
        { dataDir: this.options.dataDir, workDir: this.options.workDir, restic: this.options.restic, now: this.options.now },
        control
      )
    } catch (error) {
      const at = this.now
      report = {
        jobId: vaultId,
        vaultId,
        startedAt: at,
        finishedAt: at,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        notes: 0,
        files: 0,
        fetched: { rooms: 0, blobs: 0, bytes: 0 },
        diverged: 0,
        problems: [],
        destinations: []
      }
    } finally {
      vault.running = false
    }
    vault.runs.push(report)
    vault.runs.splice(0, Math.max(0, vault.runs.length - (this.options.keepRuns ?? 20)))
    if (this.vaults.get(vaultId) === vault) await writeJson(join(vaultDir(this.options.dataDir, vaultId), 'runs.json'), vault.runs)
    for (const listener of this.listeners) listener(vaultId, report)
    return report
  }

  /**
   * Starts every run that is due. The settings are read again first, at most
   * once an hour per vault, so a schedule changed on a device takes hold.
   */
  async tick(): Promise<void> {
    await this.reload()
    for (const [vaultId, vault] of this.vaults) {
      if (vault.running || this.waiting.has(vaultId)) continue
      if (!vault.config || this.now - vault.configAt >= HOUR_MS) {
        await this.refresh(vaultId).catch((error: unknown) => log.warn(`reading the settings of ${vaultId} failed`, error))
      }
      const next = this.nextRunAt(vault)
      if (next !== null && next <= this.now) void this.run(vaultId).catch(() => undefined)
    }
  }

  /** Waits for the runs under way. */
  async idle(): Promise<void> {
    await this.queue
  }
}
