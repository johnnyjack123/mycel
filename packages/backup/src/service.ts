import { mkdir, readFile, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isHexId, type BackupGrant, type BackupRunStatus, type BackupServerInfo, type BackupVaultStatus } from '@obsidian-connect/shared'
import { fetchSettings, readConfig, type VaultConfig } from './config.js'
import { VaultKeys } from './keys.js'
import { log } from './log.js'
import type { Restic } from './restic.js'
import { runBackup, type RunControl, type RunReport } from './run.js'
import { AccessEnded, SyncClient } from './sync.js'

// The vaults connected to this backup server, their settings, their runs and
// their schedule. One run at a time over all vaults: each lays its notes out
// in memory, and two at once would double what that takes.

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
  /** The backup server's route id: its settings are the entries naming it. */
  routeId: string
  now?: () => number
  /** Runs kept per vault for its status. */
  keepRuns?: number
}

interface Vault {
  grant: BackupGrant
  config: VaultConfig | null
  /** When the settings were last read. */
  configAt: number
  running: boolean
  runs: RunReport[]
  connectedAt: number
}

const HOUR_MS = 60 * 60 * 1000

function vaultDir(dataDir: string, vaultId: string): string {
  return join(dataDir, 'vaults', vaultId)
}

async function writeJson(path: string, value: unknown, mode?: number): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2), mode === undefined ? undefined : { mode })
  await rename(`${path}.tmp`, path)
}

function statusOf(report: RunReport): BackupRunStatus {
  const { startedAt, finishedAt, ok, error, accessEnded, notes, files, problems, destinations, trusted } = report
  return { startedAt, finishedAt, ok, error, accessEnded, notes, files, problems, destinations, trusted }
}

export class BackupService {
  private readonly vaults = new Map<string, Vault>()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly waiting = new Map<string, Promise<RunReport>>()
  private readonly listeners = new Set<(vaultId: string, report: RunReport) => void>()

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
        const runs = await readFile(join(dir, vaultId, 'runs.json'), 'utf8').then(
          (raw) => JSON.parse(raw) as RunReport[],
          () => []
        )
        const connectedAt = runs.at(-1)?.startedAt ?? Date.now()
        service.vaults.set(vaultId, { grant, config: null, configAt: 0, running: false, runs, connectedAt })
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

  has(vaultId: string): boolean {
    return this.vaults.has(vaultId)
  }

  grant(vaultId: string): BackupGrant | null {
    return this.vaults.get(vaultId)?.grant ?? null
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

  /**
   * A vault handed over by one of its devices. It is checked first: the
   * backup key has to open the vault on the sync server this backup server
   * talks to. Connecting a vault that is connected already replaces its key -
   * what a device does after a password change ended the old one.
   */
  async connect(grant: BackupGrant): Promise<void> {
    if (!isHexId(grant.vaultId) || !isHexId(grant.accountId) || typeof grant.backupKey !== 'string') throw new Error('not a grant')
    await VaultKeys.open(grant)
    const client = new SyncClient(this.options.server, grant.backupKey)
    let session
    try {
      session = await client.signIn()
    } catch (error) {
      if (error instanceof AccessEnded) throw new Error('the backup key does not open a vault on the sync server this backup server uses')
      throw error
    }
    if (session.vaultId !== grant.vaultId || session.accountId !== grant.accountId) throw new Error('the backup key belongs to another vault')
    const dir = vaultDir(this.options.dataDir, grant.vaultId)
    await mkdir(dir, { recursive: true })
    await writeJson(join(dir, 'grant.json'), grant, 0o600)
    const existing = this.vaults.get(grant.vaultId)
    if (existing) existing.grant = grant
    else this.vaults.set(grant.vaultId, { grant, config: null, configAt: 0, running: false, runs: [], connectedAt: this.now })
    log.info(`vault ${grant.vaultId} connected`)
    await this.refresh(grant.vaultId)
  }

  /** Forgets a vault: its keys, its cache, its runs. Its repositories and trusted copy stay where they are. */
  async disconnect(vaultId: string): Promise<void> {
    this.vaults.delete(vaultId)
    await rm(vaultDir(this.options.dataDir, vaultId), { recursive: true, force: true })
    log.info(`vault ${vaultId} disconnected`)
  }

  /** The local folders every other vault's destinations use here. */
  localPathsBesides(vaultId: string): string[] {
    return Array.from(this.vaults.entries())
      .filter(([id]) => id !== vaultId)
      .flatMap(([, other]) => other.config?.localPaths ?? [])
  }

  /** Reads the vault's settings again. */
  async refresh(vaultId: string): Promise<VaultConfig> {
    const vault = this.vaults.get(vaultId)
    if (!vault) throw new Error('that vault is not connected here')
    const keys = await VaultKeys.open(vault.grant)
    const settings = await fetchSettings(new SyncClient(this.options.server, vault.grant.backupKey), keys)
    vault.config = readConfig(settings, this.options.routeId, this.options.root, this.localPathsBesides(vaultId))
    vault.configAt = this.now
    return vault.config
  }

  status(vaultId: string): BackupVaultStatus {
    const vault = this.vaults.get(vaultId)
    if (!vault) throw new Error('that vault is not connected here')
    return {
      vaultId,
      running: vault.running || this.waiting.has(vaultId),
      nextRunAt: this.nextRunAt(vault),
      targets: vault.config?.accepted ?? [],
      seen: vault.config?.seen ?? [],
      everyHours: vault.config?.everyHours ?? 0,
      problems: vault.config?.problems ?? [],
      runs: vault.runs.map(statusOf).reverse()
    }
  }

  private nextRunAt(vault: Vault): number | null {
    const hours = vault.config?.everyHours ?? 0
    if (hours <= 0) return null
    return (vault.runs.at(-1)?.startedAt ?? vault.connectedAt) + hours * HOUR_MS
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
    if (!vault) throw new Error('that vault is not connected here')
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
