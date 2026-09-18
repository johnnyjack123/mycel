import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { docs, setupWSConnection } from 'y-websocket/bin/utils'
import { loadConfig } from './config.js'
import { TokenService } from './auth.js'
import { createHttpApp } from './http.js'
import { authorizeRoom } from './authz.js'
import { DiskPersistence } from './rooms.js'

const config = loadConfig()
const tokens = new TokenService(config.jwtSecret, config.accessTokenTtlSeconds)
const app = createHttpApp(config, tokens)
const persistence = new DiskPersistence(config.dataDir)
persistence.install()

const wss = new WebSocketServer({ noServer: true })

app.get('/rooms', async () => ({
  rooms: Array.from(docs.entries()).map(([name, doc]) => ({
    name,
    connections: doc.conns.size,
    chars: doc.getText('content').length
  }))
}))

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
    const room = url.pathname.replace(/^\//, '')
    if (!room) {
      socket.destroy()
      return
    }
    const decision = await authorizeRoom(
      tokens,
      url.searchParams.get('token'),
      room,
      config.devAllowAnonymous
    )
    if (!decision) {
      app.log.warn({ room, remote: request.socket.remoteAddress }, 'ws upgrade rejected')
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    app.log.info({ room, remote: request.socket.remoteAddress }, 'ws upgrade accepted')
    await persistence.ensureLoaded(room)
    wss.handleUpgrade(request, socket, head, (ws) => {
      setupWSConnection(ws, request, { docName: room, gc: true })
    })
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
  process.exit(0)
}

await app.listen({ host: config.host, port: config.port })
app.log.info(`CRDT Sync server is listening on ${config.host}:${config.port}`)
