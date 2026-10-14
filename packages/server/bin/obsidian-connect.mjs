#!/usr/bin/env node
// `obsidian-connect user add <name>` and friends. Runs the TypeScript CLI
// through tsx, the same way the server itself runs.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts')
// Resolved from here, not from the working directory `docker exec` happens to use.
const tsx = import.meta.resolve('tsx')
const result = spawnSync(process.execPath, ['--import', tsx, cli, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
