// The backup server, as the image runs it.
//
//   obsidian-connect-backup          run: register at the sync server, back up on schedule and on request
//   obsidian-connect-backup code     print the code devices connect with
//
// Settings come from the environment; see docs/BACKUP.md.
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import pkg from '../package.json' with { type: 'json' }
import { loadIdentity } from './identity.js'
import { log } from './log.js'
import { startBackupServer } from './server.js'

const env = process.env
const dataDir = env.OBSIDIAN_CONNECT_BACKUP_DATA ?? '/data'

async function main(command: string | undefined): Promise<number> {
  if (command === 'code') {
    const { identity } = await loadIdentity(dataDir)
    console.log(identity.code)
    return 0
  }
  if (command !== undefined && command !== 'run') {
    console.log('usage: obsidian-connect-backup [run | code]')
    return 1
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
  log.info(`backup server ${pkg.version} for ${server}`)
  if (running.createdCode) {
    log.info(`made this backup server's code - enter it in Obsidian, Settings -> Obsidian Connect -> Backups: ${running.code}`)
  } else {
    log.info('the code devices connect with: obsidian-connect-backup code')
  }
  await new Promise<void>((resolve) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => resolve())
  })
  log.info('stopping; waiting for a backup under way')
  await running.close()
  return 0
}

main(process.argv[2]).then(
  (code) => process.exit(code),
  (error: unknown) => {
    log.error('the backup server stopped', error)
    process.exit(1)
  }
)
