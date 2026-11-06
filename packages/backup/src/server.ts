import { join } from 'node:path'
import { backupRouteKeys, fromBase64, toBase64 } from '@mycel/shared/crypto'
import { Invites } from './invites.js'
import { log } from './log.js'
import { RelayLink } from './relay.js'
import { Restic } from './restic.js'
import { BackupService } from './service.js'
import { serveSession, type Route } from './sessions.js'
import { STATUS_EVERY_MS, writeStatus } from './status.js'

// The whole backup server behind one function, so a self-test can run one in
// its own process next to a sync server and devices.

export interface BackupServerOptions {
  /** The sync server, `ws(s)://host:port` as devices are given it. */
  server: string
  dataDir: string
  /** The repositories kept on the backup server, one folder per vault. */
  encryptedRoot: string
  /** The decrypted copies, `<account name>/<vault name>`. */
  decryptedRoot: string
  /** The RAM disk notes are laid out in during a run. */
  workDir: string
  resticBinary: string
  /** What devices are shown this backup server as. */
  name: string
  version: string
  /** How often due runs are looked for. */
  tickMs?: number
  /** How often the data folder is looked at for invitations made, or vaults disconnected, on the command line. */
  watchMs?: number
  now?: () => number
}

export interface RunningBackupServer {
  service: BackupService
  /** An invitation, as the command line makes one; resolves once the relay answers its route. */
  invite(label: string): Promise<string>
  /** Resolves once the relay answers this route. */
  whenRegistered(routeId: string): Promise<void>
  close(): Promise<void>
}

const REGISTER_WAIT_MS = 10_000

export async function startBackupServer(options: BackupServerOptions): Promise<RunningBackupServer> {
  const restic = new Restic(options.resticBinary, join(options.dataDir, 'restic-cache'), 'mycel-backup')
  const invites = new Invites(options.dataDir)
  const service = await BackupService.open({
    server: options.server,
    dataDir: options.dataDir,
    encryptedRoot: options.encryptedRoot,
    decryptedRoot: options.decryptedRoot,
    workDir: options.workDir,
    restic,
    name: options.name,
    version: options.version,
    now: options.now
  })

  // Route id -> what it answers, with the handshake's key; and the tokens the relay registers them by.
  let routes = new Map<string, Route>()
  let inviteRoutes: Record<string, string> = {}
  const updateRoutes = async (): Promise<void> => {
    const next = new Map<string, Route>()
    const tokens = new Map<string, string>()
    const opened: Record<string, string> = {}
    for (const invite of await invites.open(options.now?.())) {
      const keys = await backupRouteKeys(Invites.secretOf(invite))
      next.set(keys.routeId, { kind: 'invite', inviteId: invite.id, label: invite.label, expiresAt: invite.expiresAt, psk: keys.psk })
      tokens.set(keys.routeId, toBase64(keys.routeToken))
      opened[invite.id] = keys.routeId
    }
    for (const { vaultId, pairing } of service.pairings()) {
      const keys = await backupRouteKeys(fromBase64(pairing.secret))
      next.set(keys.routeId, { kind: 'vault', vaultId, psk: keys.psk })
      tokens.set(keys.routeId, toBase64(keys.routeToken))
    }
    routes = next
    inviteRoutes = opened
    relay.setRoutes(tokens)
    saveStatus()
  }
  // For the command line: whether the sync server is reached, and what the relay answers.
  let writing: Promise<void> = Promise.resolve()
  const saveStatus = (): void => {
    writing = writing
      .then(async () => {
        const state = relay.state()
        await writeStatus(options.dataDir, {
          version: options.version,
          server: options.server,
          updatedAt: Date.now(),
          connected: state.connected,
          error: state.error,
          since: state.since,
          registered: state.registered,
          invites: inviteRoutes,
          vaults: service.pairings().length
        })
      })
      .catch((error: unknown) => log.warn('writing the status for the command line failed', error))
  }
  let updating: Promise<void> = Promise.resolve()
  const refreshRoutes = (): Promise<void> => {
    updating = updating.then(updateRoutes).catch((error: unknown) => log.warn('updating the routes failed', error))
    return updating
  }

  const relay = new RelayLink(options.server, (session) =>
    serveSession(session, {
      route: (routeId) => routes.get(routeId) ?? null,
      service,
      now: options.now ?? Date.now,
      paired: async (routeId) => {
        await refreshRoutes()
        // Not forever: a sync server that went away meanwhile is the device's to find out.
        await Promise.race([relay.whenRegistered(routeId), new Promise((resolve) => setTimeout(resolve, REGISTER_WAIT_MS).unref?.())])
      },
      spend: async (inviteId) => {
        await invites.remove(inviteId)
        await refreshRoutes()
      }
    })
  )
  service.onRoutesChanged(() => void refreshRoutes())
  relay.onState(saveStatus)
  relay.start()
  await refreshRoutes()

  // Not unref'd: between two attempts to reach the sync server nothing else
  // keeps the process alive, and it ended quietly a second after starting.
  const ticker = setInterval(() => {
    void service.tick().catch((error: unknown) => log.warn('looking for due backups failed', error))
    // An invitation that ran out stops being answered; the status says it runs.
    void refreshRoutes()
  }, Math.min(options.tickMs ?? STATUS_EVERY_MS, STATUS_EVERY_MS))
  // The command line writes invitations and disconnects vaults in the data folder.
  let invitesAt = await invites.changedAt()
  const watcher = setInterval(() => {
    void (async () => {
      const changed = await invites.changedAt()
      if (changed !== invitesAt) {
        invitesAt = changed
        await refreshRoutes()
      }
      await service.reload()
    })().catch((error: unknown) => log.warn('looking at the data folder failed', error))
  }, options.watchMs ?? 3_000)
  watcher.unref?.()

  return {
    service,
    async invite(label) {
      const { code, invite } = await invites.create(label, options.now?.())
      await refreshRoutes()
      await relay.whenRegistered((await backupRouteKeys(Invites.secretOf(invite))).routeId)
      return code
    },
    whenRegistered: (routeId) => relay.whenRegistered(routeId),
    async close() {
      clearInterval(ticker)
      clearInterval(watcher)
      relay.stop()
      await service.idle()
      await writing
    }
  }
}
