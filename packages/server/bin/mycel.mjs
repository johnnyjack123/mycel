#!/usr/bin/env node
// `mycel user add <name>` and friends. Runs the TypeScript CLI
// through tsx, the same way the server itself runs.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts')
// Resolved from here, not from the working directory `docker exec` happens to use.
const tsx = import.meta.resolve('tsx')
// `docker exec` runs as root, past the image's entrypoint. What the CLI writes
// - accounts.json - would then be root's, and the server, running as
// PUID:PGID, could no longer write it: so it runs as that user too.
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0
const user = asRoot ? { uid: Number(process.env.PUID ?? 1000), gid: Number(process.env.PGID ?? 1000), env: { ...process.env, HOME: '/tmp' } } : {}
const result = spawnSync(process.execPath, ['--import', tsx, cli, ...process.argv.slice(2)], { stdio: 'inherit', ...user })
process.exit(result.status ?? 1)
