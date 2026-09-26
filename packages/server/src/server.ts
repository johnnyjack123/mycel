import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { isHexId } from '@obsidian-connect/shared'
import { AccountStore } from './accounts.js'
import { TokenService } from './auth.js'
import type { ServerConfig } from './config.js'
import { createHttpApp } from './http.js'
import { RoomHub } from './rooms.js'
import { setupVaultConnection } from './wshub.js'

// The whole server behind one function, so a self-test can start one on a
// port of its own, stop it, and start it again on data it changed meanwhile -
// a server that lost data or was rolled back cannot be simulated otherwise.

export interface RunningServer {
  port: number
  close(): Promise<void>
}

export interface StartOptions {
  /** Request logging; off in self-tests, where it would bury the output. */
  logger?: boolean
}

const VAULT_PREFIX = '/vault/'

function reject(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

export async function startServer(config: ServerConfig, options: StartOptions = {}): Promise<RunningServer> {
  const tokens = new TokenService(config.jwtSecret, config.accessTokenTtlSeconds)
  const accounts = new AccountStore(config.dataDir, config.jwtSecret)
  const hub = new RoomHub({ dataDir: config.dataDir, logUpdates: config.logUpdates }, accounts)
  const app = createHttpApp(config, tokens, accounts, hub, { logger: options.logger ?? true })
  const wss = new WebSocketServer({ noServer: true })

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

  app.server.on('upgrade', (request, socket, head) => {
    void handleUpgrade(request, socket, head)
  })

  if (config.insecureSecret) {
    app.log.warn('OBSIDIAN_CONNECT_JWT_SECRET is not set; tokens use a built-in secret. Set it before exposing the server.')
  }
  await app.listen({ host: config.host, port: config.port })
  const port = (app.server.address() as AddressInfo).port
  app.log.info(`Obsidian Connect server is listening on ${config.host}:${port} (registration: ${config.registration})`)

  return {
    port,
    async close() {
      // Upgraded sockets are no longer the HTTP server's to wait for.
      for (const client of wss.clients) client.terminate()
      wss.close()
      await app.close()
      await hub.shutdown()
    }
  }
}
