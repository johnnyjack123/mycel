import { loadConfig, loadEnvFile } from './config.js'
import { startServer } from './server.js'

const envFile = loadEnvFile()
const server = await startServer(loadConfig())
if (envFile) console.info(`[obsidian-connect] settings from ${envFile}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().finally(() => process.exit(0))
  })
}
