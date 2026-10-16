// The backup server, as the image runs it, and its operator's commands.
//
//   obsidian-connect-backup                     run: register at the sync server, back up on schedule and on request
//   obsidian-connect-backup invite [label]      a one-time invitation for one person to connect one vault
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
import { Invites } from './invites.js'
import { log } from './log.js'
import { startBackupServer } from './server.js'
import { listVaults } from './service.js'

const env = process.env
const dataDir = env.OBSIDIAN_CONNECT_BACKUP_DATA ?? '/data'

const USAGE = `usage:
  obsidian-connect-backup                     run the backup server
  obsidian-connect-backup invite [label]      a one-time invitation for one person to connect one vault (valid 7 days)
  obsidian-connect-backup invites             the invitations not used yet
  obsidian-connect-backup revoke <id>         withdraw an invitation
  obsidian-connect-backup vaults              the vaults connected: id, account, label, last backup
  obsidian-connect-backup disconnect <vault>  forget a vault - its repositories and trusted copy stay`

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  const invites = new Invites(dataDir)
  switch (command) {
    case 'invite': {
      const label = rest.join(' ')
      const { code, invite } = await invites.create(label)
      console.log(`Invitation${label ? ` for ${label}` : ''}, valid until ${day(invite.expiresAt)}, once:`)
      console.log(`  ${code}`)
      console.log('In Obsidian: Settings -> Obsidian Connect -> Backup servers -> Connect a backup server, with this invitation.')
      console.log('Whoever enters it connects a vault of theirs to this backup server; pass it on as you would a password.')
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

  const server = env.OBSIDIAN_CONNECT_SERVER
  if (!server) {
    console.error('OBSIDIAN_CONNECT_SERVER is not set: the sync server, e.g. wss://sync.example.com')
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
