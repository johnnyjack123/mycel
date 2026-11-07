import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig, loadEnvFile } from './config.js'
import { startServer } from './server.js'

/**
 * Whether the server can write its data folder - a file written and removed.
 * A bind-mounted folder Docker made belongs to root while the image runs as
 * user 1000; the server then failed on the first request, and a device only
 * heard that it "answers, but not as expected".
 */
async function writable(folder: string): Promise<string | null> {
  try {
    await mkdir(folder, { recursive: true })
    const probe = join(folder, `.mycel-probe-${process.pid}`)
    await writeFile(probe, '')
    await rm(probe, { force: true })
    return null
  } catch (error) {
    return `cannot write into ${folder}: ${error instanceof Error ? error.message : String(error)}`
  }
}

// What the server writes - accounts.json holds every TOTP secret and login hash -
// is its own user's alone, on a bind-mounted folder other users of the host see too.
process.umask(0o077)
const envFile = loadEnvFile()
const config = loadConfig()
const unwritable = await writable(config.dataDir)
if (unwritable) {
  console.error(
    `[mycel] ${unwritable}. The image hands its data folder to PUID:PGID by itself - unless it is started as another user ("user:" in compose): then give the folder to that user (chown -R <uid>:<gid> <folder>), or leave "user:" out.`
  )
  process.exit(1)
}
const server = await startServer(config)
if (envFile) console.info(`[mycel] settings from ${envFile}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().finally(() => process.exit(0))
  })
}
