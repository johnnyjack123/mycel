import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import proxyAddr from '@fastify/proxy-addr'
import { WebSocketServer, type WebSocket } from 'ws'
import { CLOSE_SIGNED_OUT, isHexId } from '@mycel/shared'
import { AccountStore, sessionOf } from './accounts.js'
import { TokenService, type TokenSession } from './auth.js'
import { BlobStore } from './blobs.js'
import { ContactStore } from './contacts.js'
import { createDurable, ensureDir, takeServerLock } from './durable.js'
import { ForkStore } from './forks.js'
import { MIN_JWT_SECRET_LENGTH, type ServerConfig } from './config.js'
import { createHttpApp } from './http.js'
import { Relay } from './relay.js'
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
  /** How long every sign-in and registration takes. */
  paceMs?: number
  /** How often removed accounts are cleared. */
  sweepMs?: number
  /** The clock codes from an authenticator app are checked against. */
  now?: () => number
  /** Failed sign-ins an address may have within 15 minutes. */
  maxFailures?: number
  /** How often `server.lock` is kept fresh, and when it counts as left behind. */
  serverLock?: { beatMs: number; staleMs: number }
}

const VAULT_PREFIX = '/vault/'
const RELAY_PATH = '/relay'
const RELAY_MAX_BYTES = 1024 * 1024
/**
 * The largest message on a vault socket - a frame, with its few bytes around.
 * Far above any note's change (a whole note pasted in, a seed of a large
 * one); the default of `ws`, 100 MiB, let any account store frames of that
 * size, each held in memory whenever its room is open.
 */
export const VAULT_MAX_BYTES = 32 * 1024 * 1024
const SWEEP_MS = 5 * 60 * 1000
const SECRET_FILE = 'jwt-secret'

function reject(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

/**
 * The secret tokens are signed with: the one configured, or one this server
 * made for itself on its first start and keeps next to its data, readable by
 * its own user only.
 */
async function tokenSecret(config: ServerConfig): Promise<{ secret: string; made: boolean }> {
  if (config.jwtSecret !== null) {
    if (config.jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
      throw new Error(
        `MYCEL_JWT_SECRET is ${config.jwtSecret.length} characters long; it needs at least ${MIN_JWT_SECRET_LENGTH} - anyone with an account could otherwise find it from their own token and sign one for any account. Make one with: openssl rand -base64 48`
      )
    }
    return { secret: config.jwtSecret, made: false }
  }
  const file = join(config.dataDir, SECRET_FILE)
  let made = false
  try {
    await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    made = await createDurable(file, randomBytes(48).toString('base64'), 0o600)
  }
  const secret = (await readFile(file, 'utf8')).trim()
  // Never replaced on its own: that would sign every device out, and a damaged
  // file is something to look at.
  if (secret.length < MIN_JWT_SECRET_LENGTH) throw new Error(`${file} holds no usable token secret; delete it to make a new one (every device signs in again)`)
  return { secret, made }
}

/** Where a connection comes from: behind a proxy named in MYCEL_TRUST_PROXY, the client it forwarded. */
function clientAddress(request: IncomingMessage, trust: ((address: string, hop: number) => boolean) | null): string {
  if (!trust) return request.socket.remoteAddress ?? ''
  return proxyAddr(request, trust)
}

export async function startServer(config: ServerConfig, options: StartOptions = {}): Promise<RunningServer> {
  await ensureDir(config.dataDir)
  const serverLock = await takeServerLock(config.dataDir, options.serverLock?.beatMs, options.serverLock?.staleMs)
  let secret: { secret: string; made: boolean }
  try {
    secret = await tokenSecret(config)
  } catch (error) {
    await serverLock.release()
    throw error
  }
  const trust = config.trustProxy ? proxyAddr.compile(config.trustProxy) : null
  const tokens = new TokenService(secret.secret, config.accessTokenTtlSeconds)
  const accounts = new AccountStore(config.dataDir)
  const contacts = new ContactStore(config.dataDir)
  const forks = new ForkStore(config.dataDir)
  const hub = new RoomHub({ dataDir: config.dataDir, logUpdates: config.logUpdates }, accounts, contacts, forks)
  const blobs = new BlobStore(config.dataDir, {
    maxFileBytes: config.maxFileBytes,
    quotaBytes: config.quotaBytes,
    purgeGraceMs: config.purgeGraceMs
  })
  blobs.protect((account, vault, blob) => hub.isAttached(account, vault, blob))
  const app = createHttpApp(config, tokens, accounts, hub, contacts, blobs, {
    trustProxy: config.trustProxy ?? undefined,
    logger: options.logger ?? true,
    paceMs: options.paceMs,
    now: options.now,
    maxFailures: options.maxFailures
  })
  // The CLI only marks an account as removed; its shares end and its folder
  // goes here, where the rooms are.
  const sweep = (): void => {
    void hub.sweep().catch((error: unknown) => app.log.error(error))
  }
  const sweeper = setInterval(sweep, options.sweepMs ?? SWEEP_MS)
  sweeper.unref()
  const wss = new WebSocketServer({ noServer: true, maxPayload: VAULT_MAX_BYTES })
  // A session's frames are small - keys, settings, a status, a backup read back in
  // pieces of 192 KiB - so a large one is a mistake or worse.
  const relayWss = new WebSocketServer({ noServer: true, maxPayload: RELAY_MAX_BYTES })
  const relay = new Relay()
  hub.onDisconnect((account) => relay.signOut(account))

  /**
   * A message too large or malformed is an `error` on its WebSocket, which then
   * closes it (1009, 1002). Unheard, that error ended the whole server - from
   * anyone: the relay takes backup servers without a token, and a refused
   * token is answered over an upgraded socket too.
   */
  function heard(ws: WebSocket): WebSocket {
    ws.on('error', (error: Error) => app.log.debug({ error: error.message }, 'a websocket closed after a protocol error'))
    return ws
  }

  async function handleRelay(url: URL, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    // Behind a proxy every backup server came from the proxy: sixteen connections
    // from anyone kept everyone else's backup servers out.
    const address = clientAddress(request, trust)
    if (url.searchParams.get('role') === 'backup') {
      relayWss.handleUpgrade(request, socket, head, (ws) => relay.attachBackup(heard(ws), address))
      return
    }
    let session: TokenSession | null = null
    try {
      session = await tokens.verify(url.searchParams.get('token') ?? '')
    } catch {
      // answered below
    }
    const account = session ? await accounts.get(session.accountId) : undefined
    if (!session || !account || sessionOf(account) !== session.gen) {
      relayWss.handleUpgrade(request, socket, head, (ws) => heard(ws).close(CLOSE_SIGNED_OUT, 'signed out'))
      return
    }
    const accountId = session.accountId
    relayWss.handleUpgrade(request, socket, head, (ws) => relay.attachDevice(heard(ws), accountId, address))
  }

  async function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      if (url.pathname === RELAY_PATH) {
        await handleRelay(url, request, socket, head)
        return
      }
      if (!url.pathname.startsWith(VAULT_PREFIX)) {
        reject(socket, '404 Not Found')
        return
      }
      const vaultId = decodeURIComponent(url.pathname.slice(VAULT_PREFIX.length))
      let session: TokenSession | null = null
      try {
        session = await tokens.verify(url.searchParams.get('token') ?? '')
      } catch {
        // answered below
      }
      const account = session ? await accounts.get(session.accountId) : undefined
      if (!session || !account || sessionOf(account) !== session.gen) {
        // A refused upgrade looks like "unreachable" to a browser WebSocket,
        // which then retries forever; a close code it can read.
        wss.handleUpgrade(request, socket, head, (ws) => heard(ws).close(CLOSE_SIGNED_OUT, 'signed out'))
        return
      }
      const accountId = session.accountId
      // A vault's connection carries its index; only its owner may open one.
      if (!isHexId(vaultId) || !account.vaults[vaultId]) {
        app.log.warn({ vaultId, accountId }, 'ws upgrade rejected')
        reject(socket, '403 Forbidden')
        return
      }
      app.log.info({ vaultId, accountId }, 'ws upgrade accepted')
      wss.handleUpgrade(request, socket, head, (ws) => setupVaultConnection(heard(ws), accountId, vaultId, hub))
    } catch (error) {
      app.log.error(error)
      socket.destroy()
    }
  }

  app.server.on('upgrade', (request, socket, head) => {
    // Node takes its own error listener off a socket it hands over for an
    // upgrade; a client resetting it while its token was being checked ended
    // the server.
    socket.on('error', () => socket.destroy())
    void handleUpgrade(request, socket, head)
  })

  if (secret.made) app.log.info(`MYCEL_JWT_SECRET is not set; a token secret was made and kept in ${join(config.dataDir, SECRET_FILE)}`)
  // The rooms and the vault locks kept over the restart, before anyone asks.
  await hub.started()
  try {
    await app.listen({ host: config.host, port: config.port })
  } catch (error) {
    await serverLock.release()
    throw error
  }
  const port = (app.server.address() as AddressInfo).port
  app.log.info(`Mycel server is listening on ${config.host}:${port} (registration: ${config.registration})`)
  sweep()

  return {
    port,
    async close() {
      clearInterval(sweeper)
      // Upgraded sockets are no longer the HTTP server's to wait for.
      for (const client of wss.clients) client.terminate()
      for (const client of relayWss.clients) client.terminate()
      wss.close()
      relay.close()
      relayWss.close()
      await app.close()
      await hub.shutdown()
      await serverLock.release()
    }
  }
}
