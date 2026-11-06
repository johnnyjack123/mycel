#!/usr/bin/env node
// `mycel-backup [run | invite | status | check | invites | revoke | vaults | disconnect]`.
// Runs the TypeScript entry through tsx, the same way the image starts it.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts')
// Resolved from here, not from the working directory `docker exec` happens to use.
const tsx = import.meta.resolve('tsx')
// `docker exec` runs as root, past the image's entrypoint. An invitation
// written as root could not be read by the running backup server, which runs
// as PUID:PGID - so the command runs as that user too.
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0
const user = asRoot ? { uid: Number(process.env.PUID ?? 1000), gid: Number(process.env.PGID ?? 1000), env: { ...process.env, HOME: '/tmp' } } : {}
const result = spawnSync(process.execPath, ['--import', tsx, entry, ...process.argv.slice(2)], { stdio: 'inherit', ...user })
process.exit(result.status ?? 1)
