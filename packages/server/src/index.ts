import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { isHexId } from '@obsidian-connect/shared'
import { AccountStore } from './accounts.js'
import { TokenService } from './auth.js'
import { loadConfig, loadEnvFile } from './config.js'
import { createHttpApp } from './http.js'
import { RoomHub } from './rooms.js'
import { setupVaultConnection } from './wshub.js'

const envFile = loadEnvFile()
const config = loadConfig()
const tokens = new TokenService(config.jwtSecret, config.accessTokenTtlSeconds)
const accounts = new AccountStore(config.dataDir, config.jwtSecret)
const hub = new RoomHub({ dataDir: config.dataDir, logUpdates: config.logUpdates }, accounts)
const app = createHttpApp(config, tokens, accounts, hub)

const wss = new WebSocketServer({ noServer: true })
const VAULT_PREFIX = '/vault/'

function reject(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

app.server.on('upgrade', (request, socket, head) => {
  void handleUpgrade(request, socket, head)
})

async function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (!url.pathname.startsWith(VAULT_PREFIX)) {
      reject(socket, '404 Not Found')
      return
    }
    const vaultId = decodeURIComponent(url.pathname.slice(VAULT_PREFIX.length))
    let username: string
    try {
      username = await tokens.verify(url.searchParams.get('token') ?? '')
    } catch {
      reject(socket, '401 Unauthorized')
      return
    }
    const account = await accounts.get(username)
    // A vault's connection carries its index; only its owner may open one.
    if (!isHexId(vaultId) || account?.status !== 'active' || !account.vaults[vaultId]) {
      app.log.warn({ vaultId, username, remote: request.socket.remoteAddress }, 'ws upgrade rejected')
      reject(socket, '403 Forbidden')
      return
    }
    app.log.info({ vaultId, username, remote: request.socket.remoteAddress }, 'ws upgrade accepted')
    wss.handleUpgrade(request, socket, head, (ws) => setupVaultConnection(ws, username, vaultId, hub))
  } catch (error) {
    app.log.error(error)
    socket.destroy()
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown()
  })
}

async function shutdown(): Promise<void> {
  await app.close()
  wss.close()
  await hub.shutdown()
  process.exit(0)
}

if (envFile) app.log.info(`settings from ${envFile}`)
if (config.insecureSecret) {
  app.log.warn('OBSIDIAN_CONNECT_JWT_SECRET is not set; tokens use a built-in secret. Set it before exposing the server.')
}
await app.listen({ host: config.host, port: config.port })
app.log.info(`Obsidian Connect server is listening on ${config.host}:${config.port} (registration: ${config.registration})`)
