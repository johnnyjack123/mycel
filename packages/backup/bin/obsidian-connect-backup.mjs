#!/usr/bin/env node
// `obsidian-connect-backup [run | invite | invites | revoke | vaults | disconnect]`. Runs the TypeScript entry through
// tsx, the same way the image starts it.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts')
// Resolved from here, not from the working directory `docker exec` happens to use.
const tsx = import.meta.resolve('tsx')
const result = spawnSync(process.execPath, ['--import', tsx, entry, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
