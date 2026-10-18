// The backup server, as the image runs it, and its operator's commands.
//
//   obsidian-connect-backup                     run: register at the sync server, back up on schedule and on request
//   obsidian-connect-backup invite [label]      a one-time invitation for one person to connect one vault
//   obsidian-connect-backup status              whether it reaches the sync server, and which invitations it answers
//   obsidian-connect-backup check               try the way to the sync server's relay from here, now, step by step
//   obsidian-connect-backup invites             the invitations not used yet
//   obsidian-connect-backup revoke <id>         withdraw an invitation
//   obsidian-connect-backup vaults              the vaults connected
//   obsidian-connect-backup disconnect <vault>  forget a vault: it is backed up no more
//
// Settings come from the environment; see docs/BACKUP.md.
import { rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { isHexId } from '@obsidian-connect/shared'
import pkg from '../package.json' with { type: 'json' }
import { backupRouteKeys } from '@obsidian-connect/shared/crypto'
import { writable } from './config.js'
import { Invites } from './invites.js'
import { log } from './log.js'
import { startBackupServer } from './server.js'
import { checkRelay } from './probe.js'
import { listVaults } from './service.js'
import { STATUS_EVERY_MS, readStatus, type ServerStatus } from './status.js'

const env = process.env
const dataDir = env.OBSIDIAN_CONNECT_BACKUP_DATA ?? '/data'

const USAGE = `usage:
  obsidian-connect-backup                     run the backup server
  obsidian-connect-backup invite [label]      a one-time invitation for one person to connect one vault (valid 7 days)
  obsidian-connect-backup status              whether it reaches the sync server, and which invitations it answers
  obsidian-connect-backup check               try the way to the sync server's relay from here, now, step by step
  obsidian-connect-backup invites             the invitations not used yet
  obsidian-connect-backup revoke <id>         withdraw an invitation
  obsidian-connect-backup vaults              the vaults connected: id, account, label, last backup
  obsidian-connect-backup disconnect <vault>  forget a vault - its repositories and trusted copy stay`

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

/** How long `invite` waits for the running backup server to take it up and register it. */
const INVITE_WAIT_MS = 20_000

/** Whether the running backup server reaches the sync server, as its status says. */
function describeStatus(status: ServerStatus | null): string[] {
  if (!status) return ['The backup server has not run with this data folder yet - is it started, with this folder mounted?']
  const lines = [`backup server ${status.version ?? '0.7.11 or older'} (this command: ${pkg.version})`, `sync server: ${status.server}`]
  const age = Date.now() - status.updatedAt
  if (age > 3 * STATUS_EVERY_MS) lines.push(`status from ${day(status.updatedAt)} - the backup server does not seem to run now`)
  if (status.connected) lines.push(`connected since ${day(status.since)}; the relay answers ${status.registered.length} route(s) for it`)
  else if (status.error) lines.push(`NOT connected since ${day(status.since)}: ${status.error}`)
  else lines.push('not connected: it connects only while it has an invitation or a vault to answer')
  return lines
}

/** What to try when the backup server runs on the same host as the sync server, or does not reach it. */
const SAME_HOST = [
  'On the same host as the sync server, a container often reaches neither its public address nor its LAN',
  'address. What works:',
  '  - both compose files in one folder (one compose project, one network): ws://obsidian-connect:1234',
  '  - or "network_mode: host" for the backup server in docker-compose.backup.yml: ws://127.0.0.1:1234',
  'ws://, not wss://, on the sync server\'s own port; wss:// is for an address with TLS in front of it.',
  'A reverse proxy must pass WebSocket upgrades on /relay. "obsidian-connect-backup check" tries it again.'
]

/** Why an invitation is not answered yet, and what to look at. */
function diagnose(status: ServerStatus | null): string[] {
  const lines = describeStatus(status)
  if (status && !status.connected && status.error) lines.push(...SAME_HOST)
  lines.push('obsidian-connect-backup status shows it again; the log has every attempt.')
  return lines
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  const invites = new Invites(dataDir)
  switch (command) {
    case 'invite': {
      const label = rest.join(' ')
      const { code, invite } = await invites.create(label)
      console.log(`Invitation${label ? ` for ${label}` : ''}, valid until ${day(invite.expiresAt)}, once:`)
      console.log(`  ${code}`)
      console.log('In Obsidian: Settings -> Obsidian Connect -> Backups -> Connect a backup server, with this invitation.')
      console.log('Whoever enters it connects a vault of theirs to this backup server; pass it on as you would a password.')
      // The running backup server takes it up from the data folder and registers it at the sync server; wait for that.
      const routeId = (await backupRouteKeys(Invites.secretOf(invite))).routeId
      const deadline = Date.now() + INVITE_WAIT_MS
      let status = await readStatus(dataDir)
      while (!status?.registered.includes(routeId) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        status = await readStatus(dataDir)
      }
      if (status?.registered.includes(routeId)) {
        console.log(`The backup server answers it at ${status.server} - it can be used now.`)
        return 0
      }
      console.log('')
      console.log('BUT: the backup server does not answer it at the sync server yet, so connecting with it fails now.')
      for (const line of diagnose(status)) console.log(`  ${line}`)
      return 0
    }
    case 'check': {
      // From this container, now, whatever the running backup server last saw.
      const server = env.OBSIDIAN_CONNECT_SERVER?.trim() ?? ''
      console.log(`backup server ${pkg.version}, sync server: ${server || '(OBSIDIAN_CONNECT_SERVER is not set)'}`)
      if (!server) return 1
      const checked = await checkRelay(server)
      for (const line of checked.lines) console.log(`  ${line}`)
      if (checked.ok) {
        console.log('The relay takes this backup server at that address. If "status" still says NOT connected, the running')
        console.log('backup server has another address or is older: docker compose up -d after changing .env or pulling.')
        return 0
      }
      for (const line of SAME_HOST) console.log(line)
      return 1
    }
    case 'status': {
      const status = await readStatus(dataDir)
      for (const line of describeStatus(status)) console.log(line)
      const open = await invites.open()
      console.log(`invitations waiting: ${open.length}`)
      for (const invite of open) {
        const routeId = status?.invites[invite.id]
        const answered = routeId !== undefined && status?.registered.includes(routeId) === true
        console.log(`  ${invite.id}  ${invite.label || '-'}  valid until ${day(invite.expiresAt)}  ${answered ? 'answered' : 'NOT answered'}`)
      }
      console.log(`vaults connected: ${(await listVaults(dataDir)).length}`)
      return 0
    }
    case 'invites': {
      const open = await invites.open()
      if (open.length === 0) console.log('no invitation waits')
      for (const invite of open) console.log(`${invite.id}  ${invite.label || '-'}  made ${day(invite.createdAt)}  valid until ${day(invite.expiresAt)}`)
      return 0
    }
    case 'revoke': {
      const id = rest[0] ?? ''
      const removed = await invites.remove(id)
      console.log(removed ? `invitation ${id} withdrawn` : `no invitation ${id}`)
      return removed ? 0 : 1
    }
    case 'vaults': {
      const vaults = await listVaults(dataDir)
      if (vaults.length === 0) console.log('no vault is connected')
      for (const vault of vaults) {
        const last = vault.lastRun ? `last backup ${day(vault.lastRun.at)} ${vault.lastRun.ok ? 'ok' : 'failed'}` : 'no backup yet'
        console.log(`${vault.vaultId}  account ${vault.accountId}  ${vault.label || '-'}  connected ${day(vault.pairedAt)}  ${last}`)
      }
      return 0
    }
    case 'disconnect': {
      const vaultId = rest[0] ?? ''
      if (!isHexId(vaultId)) {
        console.error('usage: obsidian-connect-backup disconnect <vaultId>   (see: obsidian-connect-backup vaults)')
        return 1
      }
      // The running backup server notices its folder gone within seconds.
      await rm(join(dataDir, 'vaults', vaultId), { recursive: true, force: true })
      console.log(`${vaultId} is disconnected: its keys and cache are gone, its repositories and trusted copy stay.`)
      return 0
    }
    case undefined:
    case 'run':
      break
    default:
      console.log(USAGE)
      return command === 'help' || command === '--help' ? 0 : 1
  }

  const server = env.OBSIDIAN_CONNECT_SERVER?.trim()
  if (!server) {
    console.error('OBSIDIAN_CONNECT_SERVER is not set: the sync server, e.g. wss://sync.example.com')
    return 1
  }
  if (!/^(wss?|https?):\/\/[^/\s]+/i.test(server)) {
    console.error(`OBSIDIAN_CONNECT_SERVER is "${server}": give it with its scheme, e.g. wss://sync.example.com or ws://192.168.1.10:1234`)
    return 1
  }
  // The image's entrypoint hands the folder over; started as another user, nobody did.
  const unwritable = await writable(dataDir)
  if (unwritable) {
    console.error(
      `${unwritable}. The image hands ${dataDir} to PUID:PGID by itself - unless it is started as another user ("user:" in compose): then give the folder to that user (chown -R <uid>:<gid> <folder>), or leave "user:" out.`
    )
    return 1
  }
  const running = await startBackupServer({
    server,
    dataDir,
    root: env.OBSIDIAN_CONNECT_BACKUP_ROOT ?? '/backup',
    workDir: env.OBSIDIAN_CONNECT_BACKUP_WORK ?? (process.platform === 'linux' ? '/run/obsidian-connect-backup' : join(tmpdir(), 'obsidian-connect-backup')),
    resticBinary: env.OBSIDIAN_CONNECT_RESTIC ?? 'restic',
    name: env.OBSIDIAN_CONNECT_BACKUP_NAME ?? hostname(),
    version: pkg.version
  })
  const vaults = running.service.pairings().length
  log.info(`backup server ${pkg.version} for ${server}, ${vaults} vault(s) connected`)
  if (vaults === 0) log.info('to connect a vault, make an invitation: obsidian-connect-backup invite <name>')
  await new Promise<void>((resolve) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => resolve())
  })
  log.info('stopping; waiting for a backup under way')
  await running.close()
  return 0
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    log.error('the backup server stopped', error)
    process.exit(1)
  }
)
