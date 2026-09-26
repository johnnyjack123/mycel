import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import {
  API,
  PROTOCOL_VERSION,
  isHexId,
  type AcceptRequest,
  type AuthConfigResponse,
  type CompactableResponse,
  type CreateVaultRequest,
  type DocRequest,
  type ImportRequest,
  type IncomingSharesResponse,
  type LoginRequest,
  type PasswordChangeRequest,
  type PreloginRequest,
  type PreloginResponse,
  type RefreshResponse,
  type RegisterRequest,
  type RevokeRequest,
  type RoleRequest,
  type SessionResponse,
  type ShareRequest,
  type SnapshotRequest,
  type UserKeyResponse,
  type UsersResponse
} from '@obsidian-connect/shared'
import { AccountError, normalizeUsername, type AccountStore } from './accounts.js'
import type { TokenService } from './auth.js'
import type { ServerConfig } from './config.js'
import { HubError, type RoomHub } from './rooms.js'

interface RoomParams {
  room: string
}

interface NameParams {
  name: string
}

interface DocParams {
  docId: string
}

// Snapshots and imported histories travel as base64 JSON.
const BODY_LIMIT = 64 * 1024 * 1024

export function createHttpApp(
  config: ServerConfig,
  tokens: TokenService,
  accounts: AccountStore,
  hub: RoomHub,
  options: { logger?: boolean } = {}
): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: BODY_LIMIT })

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AccountError || error instanceof HubError) {
      return reply.code(error.status).send({ error: error.message })
    }
    app.log.error(error)
    const { statusCode, message } = error as { statusCode?: number; message?: string }
    const status = statusCode ?? 500
    return reply.code(status).send({ error: status === 500 ? 'internal error' : (message ?? 'error') })
  })

  /** The account behind the bearer token, or a 401 already sent. */
  async function user(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const header = request.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    try {
      const username = await tokens.verify(token)
      const account = await accounts.get(username)
      if (account?.status === 'active') return username
    } catch {
      // falls through to 401
    }
    await reply.code(401).send({ error: 'sign in again' })
    return null
  }

  async function session(username: string): Promise<SessionResponse> {
    const account = await accounts.get(username)
    if (!account) throw new AccountError(401, 'unknown account')
    const issued = await tokens.issue(username)
    return { token: issued.token, expiresIn: issued.expiresIn, account: accounts.bundle(account) }
  }

  app.get(API.health, async () => ({ ok: true, service: 'obsidian-connect-server', protocol: PROTOCOL_VERSION }))

  // --- accounts ------------------------------------------------------------------

  app.get(API.config, async (): Promise<AuthConfigResponse> => ({
    registration: config.registration,
    protocol: PROTOCOL_VERSION
  }))

  app.post(API.prelogin, async (request): Promise<PreloginResponse> => {
    const body = (request.body ?? {}) as Partial<PreloginRequest>
    return { kdf: await accounts.kdfFor(String(body.username ?? '')) }
  })

  app.post(API.register, async (request): Promise<SessionResponse> => {
    const account = await accounts.register(request.body as RegisterRequest, config.registration)
    return session(account.username)
  })

  app.post(API.login, async (request, reply) => {
    const body = (request.body ?? {}) as Partial<LoginRequest>
    const account = await accounts.verify(String(body.username ?? ''), body.authKey)
    if (!account) return reply.code(401).send({ error: 'wrong name or password' })
    return session(account.username)
  })

  app.post(API.refresh, async (request, reply): Promise<RefreshResponse | undefined> => {
    const username = await user(request, reply)
    if (!username) return undefined
    return tokens.issue(username)
  })

  app.post(API.password, async (request, reply) => {
    const username = await user(request, reply)
    if (!username) return undefined
    await accounts.changePassword(username, request.body as PasswordChangeRequest)
    return session(username)
  })

  app.get(API.account, async (request, reply) => {
    const username = await user(request, reply)
    if (!username) return undefined
    const account = await accounts.get(username)
    if (!account) return reply.code(401).send({ error: 'sign in again' })
    return accounts.bundle(account)
  })

  app.post(API.vaults, async (request, reply) => {
    const username = await user(request, reply)
    if (!username) return undefined
    const body = (request.body ?? {}) as Partial<CreateVaultRequest>
    return accounts.addVault(username, body.name, body.wrappedKey)
  })

  app.get(API.users, async (request, reply): Promise<UsersResponse | undefined> => {
    const username = await user(request, reply)
    if (!username) return undefined
    return { users: (await accounts.activeUsernames()).filter((name) => name !== username) }
  })

  app.get<{ Params: NameParams }>(`${API.users}/:name/key`, async (request, reply) => {
    const username = await user(request, reply)
    if (!username) return undefined
    const name = normalizeUsername(request.params.name)
    const account = name ? await accounts.get(name) : undefined
    if (!account || account.status !== 'active' || !account.publicKey) {
      return reply.code(404).send({ error: 'no such person' })
    }
    const response: UserKeyResponse = { username: account.username, publicKey: account.publicKey }
    return response
  })

  // --- sharing -------------------------------------------------------------------

  app.post(API.shares, async (request, reply) => {
    const username = await user(request, reply)
    if (!username) return undefined
    await hub.share(username, request.body as ShareRequest)
    return { ok: true }
  })

  app.get(`${API.shares}/incoming`, async (request, reply): Promise<IncomingSharesResponse | undefined> => {
    const username = await user(request, reply)
    if (!username) return undefined
    return { shares: await hub.incoming(username) }
  })

  app.get<{ Params: DocParams }>(`${API.shares}/:docId`, async (request, reply) => {
    const username = await user(request, reply)
    if (!username) return undefined
    return hub.members(username, request.params.docId)
  })

  app.post(`${API.shares}/revoke`, async (request, reply) => {
    const username = await user(request, reply)
    if (!username) return undefined
    await hub.revoke(username, request.body as RevokeRequest)
    return { ok: true }
  })

  app.post(`${API.shares}/leave`, async (request, reply) => {
    const username = await user(request, reply)
    if (!username) return undefined
    await hub.leave(username, ((request.body ?? {}) as Partial<DocRequest>).docId)
    return { ok: true }
  })

  app.post(`${API.shares}/role`, async (request, reply) => {
    const username = await user(request, reply)
    if (!username) return undefined
    await hub.setRole(username, request.body as RoleRequest)
    return { ok: true }
  })

  app.post(`${API.shares}/accept`, async (request, reply) => {
    const username = await user(request, reply)
    if (!username) return undefined
    const body = (request.body ?? {}) as Partial<AcceptRequest>
    await hub.accept(username, body.docId, body.vaultId)
    return { ok: true }
  })

  // --- keys and log --------------------------------------------------------------

  app.get<{ Params: RoomParams }>(`${API.keys}/:room`, async (request, reply) => {
    const username = await user(request, reply)
    if (!username) return undefined
    return hub.keys(username, request.params.room)
  })

  app.get<{ Params: RoomParams }>(`${API.log}/:room`, async (request, reply) => {
    const username = await user(request, reply)
    if (!username) return undefined
    return hub.log(username, request.params.room)
  })

  app.post<{ Params: RoomParams }>(`${API.log}/:room/snapshot`, async (request, reply) => {
    const username = await user(request, reply)
    if (!username) return undefined
    await hub.snapshot(username, request.params.room, request.body as SnapshotRequest)
    return { ok: true }
  })

  app.post<{ Params: RoomParams; Querystring: { vaultId?: string } }>(
    `${API.log}/:room/import`,
    async (request, reply) => {
      const username = await user(request, reply)
      if (!username) return undefined
      const vaultId = request.query.vaultId ?? ''
      if (!isHexId(vaultId)) return reply.code(400).send({ error: 'not a vault id' })
      const body = (request.body ?? {}) as Partial<ImportRequest>
      const headSeq = await hub.importFrames(username, request.params.room, vaultId, body.frames ?? [])
      return { headSeq }
    }
  )

  app.get<{ Querystring: { vaultId?: string; before?: string } }>(API.compactable, async (request, reply) => {
    const username = await user(request, reply)
    if (!username) return undefined
    const before = Number(request.query.before)
    if (!Number.isFinite(before)) return reply.code(400).send({ error: 'before is required' })
    const response: CompactableResponse = {
      rooms: await hub.compactable(username, request.query.vaultId ?? '', before)
    }
    return response
  })

  return app
}
