import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { loadConfig } from './config.js'
import { TokenService } from './auth.js'
import { createHttpApp } from './http.js'
import { authorizeRoom } from './authz.js'
import { RoomManager } from './rooms.js'
import { setupSingleRoomConnection, setupVaultConnection } from './wshub.js'

const config = loadConfig()
const tokens = new TokenService(config.jwtSecret, config.accessTokenTtlSeconds)
const rooms = new RoomManager({
  dataDir: config.dataDir,
  historyRetentionDays: config.historyRetentionDays
})
const app = createHttpApp(config, tokens, rooms)

const wss = new WebSocketServer({ noServer: true })

const VAULT_PREFIX = '/vault/'
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000

app.server.on('upgrade', (request, socket, head) => {
  void handleUpgrade(request, socket, head)
})

async function handleUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const token = url.searchParams.get('token')

    // One socket per vault carries every note; the single-room endpoint stays
    // for the relay self-test and any plain y-websocket client.
    const vaultId = url.pathname.startsWith(VAULT_PREFIX)
      ? decodeURIComponent(url.pathname.slice(VAULT_PREFIX.length))
      : null

    const room = vaultId ? `vault:${vaultId}` : url.pathname.replace(/^\//, '')
    if (!room || (vaultId !== null && vaultId.length === 0)) {
      socket.destroy()
      return
    }

    const decision = await authorizeRoom(tokens, token, room, config.devAllowAnonymous)
    if (!decision) {
      app.log.warn({ room, remote: request.socket.remoteAddress }, 'ws upgrade rejected')
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    app.log.info(
      { room, vault: vaultId ?? undefined, remote: request.socket.remoteAddress },
      'ws upgrade accepted'
    )
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (vaultId) setupVaultConnection(ws, vaultId, rooms)
      else setupSingleRoomConnection(ws, room, rooms)
    })
  } catch (error) {
    app.log.error(error)
    socket.destroy()
  }
}

const pruneTimer = setInterval(() => {
  void rooms
    .pruneAll()
    .then((count) => {
      if (count > 0) app.log.info({ rooms: count }, 'history pruned')
    })
    .catch((error) => app.log.error(error))
}, PRUNE_INTERVAL_MS)
pruneTimer.unref?.()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown()
  })
}

async function shutdown(): Promise<void> {
  clearInterval(pruneTimer)
  await app.close()
  wss.close()
  await rooms.shutdown()
  process.exit(0)
}

await app.listen({ host: config.host, port: config.port })
app.log.info(`CRDT Sync server is listening on ${config.host}:${config.port}`)
