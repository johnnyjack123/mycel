import { join } from 'node:path'
import { loadIdentity } from './identity.js'
import { log } from './log.js'
import { RelayLink } from './relay.js'
import { Restic } from './restic.js'
import { BackupService } from './service.js'
import { serveSession } from './sessions.js'

// The whole backup server behind one function, so a self-test can run one in
// its own process next to a sync server and devices.

export interface BackupServerOptions {
  /** The sync server, `ws(s)://host:port` as devices are given it. */
  server: string
  dataDir: string
  /** Local destinations lie below this folder. */
  root: string
  /** The RAM disk notes are laid out in during a run. */
  workDir: string
  resticBinary: string
  /** What devices are shown this backup server as. */
  name: string
  version: string
  /** How often due runs are looked for. */
  tickMs?: number
  now?: () => number
}

export interface RunningBackupServer {
  /** The code a device connects with. */
  code: string
  routeId: string
  /** Whether the code was made on this start. */
  createdCode: boolean
  service: BackupService
  /** Resolves once the sync server's relay took the registration. */
  registered: Promise<void>
  close(): Promise<void>
}

export async function startBackupServer(options: BackupServerOptions): Promise<RunningBackupServer> {
  const { identity, created } = await loadIdentity(options.dataDir)
  const restic = new Restic(options.resticBinary, join(options.dataDir, 'restic-cache'), 'obsidian-connect-backup')
  const service = await BackupService.open({
    server: options.server,
    dataDir: options.dataDir,
    root: options.root,
    workDir: options.workDir,
    restic,
    name: options.name,
    version: options.version,
    routeId: identity.keys.routeId,
    now: options.now
  })
  const relay = new RelayLink(options.server, identity, (session) => serveSession(session, { identity, service, restic, root: options.root }))
  relay.start()
  const ticker = setInterval(() => {
    void service.tick().catch((error: unknown) => log.warn('looking for due backups failed', error))
  }, options.tickMs ?? 60_000)
  ticker.unref?.()
  return {
    code: identity.code,
    routeId: identity.keys.routeId,
    createdCode: created,
    service,
    registered: relay.registered,
    async close() {
      clearInterval(ticker)
      relay.stop()
      await service.idle()
    }
  }
}
