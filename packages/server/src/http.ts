import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import {
  API,
  PROTOCOL_VERSION,
  isHexId,
  type AcceptRequest,
  type AccountKeyResponse,
  type AuthConfigResponse,
  type CompactableResponse,
  type ContactCodeInfo,
  type ContactCodeRequest,
  type ContactReplyRequest,
  type ContactsResponse,
  type CreateVaultRequest,
  type InboxResponse,
  type RedeemRequest,
  type DocRequest,
  type ForkDoneRequest,
  type ForksResponse,
  type ImportRequest,
  type IncomingSharesResponse,
  type LoginRequest,
  type PasswordChangeRequest,
  type RefreshResponse,
  type RegisterRequest,
  type RevokeRequest,
  type RoleRequest,
  type SessionResponse,
  type ShareRequest,
  type SnapshotRequest
} from '@obsidian-connect/shared'
import { AccountError, isAccountId, type AccountStore } from './accounts.js'
import type { TokenService } from './auth.js'
import type { ServerConfig } from './config.js'
import type { ContactStore } from './contacts.js'
import { HubError, type RoomHub } from './rooms.js'
import { AddressGuard, paced } from './throttle.js'

interface RoomParams {
  room: string
}

interface AccountParams {
  accountId: string
}

interface DocParams {
  docId: string
}

// Snapshots and imported histories travel as base64 JSON.
const BODY_LIMIT = 64 * 1024 * 1024

export interface HttpOptions {
  logger?: boolean
  /** How long every sign-in and registration takes; shorter in self-tests. */
  paceMs?: number
}

export function createHttpApp(
  config: ServerConfig,
  tokens: TokenService,
  accounts: AccountStore,
  hub: RoomHub,
  contacts: ContactStore,
  options: HttpOptions = {}
): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: BODY_LIMIT })
  const guard = new AddressGuard()

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
      const accountId = await tokens.verify(token)
      if (await accounts.get(accountId)) return accountId
    } catch {
      // falls through to 401
    }
    await reply.code(401).send({ error: 'sign in again' })
    return null
  }

  async function session(accountId: string): Promise<SessionResponse> {
    const account = await accounts.get(accountId)
    if (!account) throw new AccountError(401, 'unknown account')
    const issued = await tokens.issue(accountId)
    return { token: issued.token, expiresIn: issued.expiresIn, account: accounts.bundle(account) }
  }

  /**
   * Sign-in, registration and password change: always the same time, and an
   * address that keeps failing is turned away before anything is looked at.
   */
  async function guarded<T>(request: FastifyRequest, reply: FastifyReply, task: () => Promise<T | null>): Promise<T | undefined> {
    const address = request.ip
    return paced(async () => {
      if (guard.blocked(address)) {
        await reply.code(429).send({ error: 'too many attempts; try again later' })
        return undefined
      }
      try {
        const result = await task()
        if (result === null) {
          guard.failed(address)
          await reply.code(401).send({ error: 'wrong name or password' })
          return undefined
        }
        return result
      } catch (error) {
        if (error instanceof AccountError && error.status >= 400 && error.status < 500) guard.failed(address)
        throw error
      }
    }, options.paceMs)
  }

  app.get(API.health, async () => ({ ok: true, service: 'obsidian-connect-server', protocol: PROTOCOL_VERSION }))

  // --- accounts ------------------------------------------------------------------

  app.get(API.config, async (): Promise<AuthConfigResponse> => ({
    registration: config.registration,
    protocol: PROTOCOL_VERSION,
    serverId: await accounts.serverId()
  }))

  app.post(API.register, async (request, reply) =>
    guarded(request, reply, async (): Promise<SessionResponse> => {
      const account = await accounts.register(request.body as RegisterRequest, config.registration)
      return session(account.accountId)
    })
  )

  app.post(API.login, async (request, reply) =>
    guarded(request, reply, async (): Promise<SessionResponse | null> => {
      const account = await accounts.login(((request.body ?? {}) as Partial<LoginRequest>).loginKey)
      return account ? session(account.accountId) : null
    })
  )

  app.post(API.refresh, async (request, reply): Promise<RefreshResponse | undefined> => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return tokens.issue(accountId)
  })

  app.post(API.password, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return guarded(request, reply, async () => {
      await accounts.changePassword(accountId, request.body as PasswordChangeRequest)
      return session(accountId)
    })
  })

  app.get(API.account, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const account = await accounts.get(accountId)
    if (!account) return reply.code(401).send({ error: 'sign in again' })
    return accounts.bundle(account)
  })

  app.post(API.vaults, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const body = (request.body ?? {}) as Partial<CreateVaultRequest>
    return accounts.addVault(accountId, body.vaultId, body.sealedName, body.wrappedKey)
  })

  app.get<{ Params: AccountParams }>(`${API.accounts}/:accountId/key`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const wanted = request.params.accountId
    const account = isAccountId(wanted) ? await accounts.get(wanted) : undefined
    if (!account) return reply.code(404).send({ error: 'no such account' })
    const response: AccountKeyResponse = { accountId: account.accountId, publicKey: account.publicKey }
    return response
  })

  // --- contacts ------------------------------------------------------------------

  app.post(`${API.contacts}/codes`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const body = (request.body ?? {}) as Partial<ContactCodeRequest>
    await contacts.addCode(accountId, body.codeId, body.redeemHash, body.expiresAt)
    return { ok: true }
  })

  app.get<{ Params: { codeId: string } }>(`${API.contacts}/codes/:codeId`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const owner = await contacts.codeOwner(request.params.codeId)
    const account = owner ? await accounts.get(owner) : undefined
    if (!account) return reply.code(404).send({ error: 'this code is not valid (any more)' })
    const info: ContactCodeInfo = { owner: account.accountId, publicKey: account.publicKey }
    return info
  })

  app.post(`${API.contacts}/redeem`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const body = (request.body ?? {}) as Partial<RedeemRequest>
    const owner = await contacts.redeem(accountId, body.codeId, body.redeemKey, body.sealed)
    hub.notify(owner, 'contact', { account: accountId })
    return { owner }
  })

  app.post(`${API.contacts}/reply`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const body = (request.body ?? {}) as Partial<ContactReplyRequest>
    await contacts.reply(accountId, body.to, body.codeId, body.sealed)
    hub.notify(body.to as string, 'contact', { account: accountId })
    return { ok: true }
  })

  app.get(`${API.contacts}/inbox`, async (request, reply): Promise<InboxResponse | undefined> => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return { items: await contacts.inbox(accountId) }
  })

  app.post(`${API.contacts}/inbox/done`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await contacts.done(accountId, ((request.body ?? {}) as { ids?: unknown }).ids)
    return { ok: true }
  })

  app.get(API.contacts, async (request, reply): Promise<ContactsResponse | undefined> => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return { contacts: await contacts.contactsOf(accountId) }
  })

  app.post(`${API.contacts}/remove`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const other = ((request.body ?? {}) as { account?: unknown }).account
    if (!isAccountId(other)) return reply.code(400).send({ error: 'not an account id' })
    if (await contacts.unpair(accountId, other)) hub.notify(other, 'contact-removed', { account: accountId })
    return { ok: true }
  })

  // --- sharing -------------------------------------------------------------------

  app.post(API.shares, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await hub.share(accountId, request.body as ShareRequest)
    return { ok: true }
  })

  app.get(`${API.shares}/incoming`, async (request, reply): Promise<IncomingSharesResponse | undefined> => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return { shares: await hub.incoming(accountId) }
  })

  app.get<{ Params: DocParams }>(`${API.shares}/:docId`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return hub.members(accountId, request.params.docId)
  })

  app.post(`${API.shares}/revoke`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await hub.revoke(accountId, request.body as RevokeRequest)
    return { ok: true }
  })

  app.post(`${API.shares}/leave`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await hub.leave(accountId, ((request.body ?? {}) as Partial<DocRequest>).docId)
    return { ok: true }
  })

  app.post(`${API.shares}/detach`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await hub.detachShare(accountId, ((request.body ?? {}) as Partial<DocRequest>).docId)
    return { ok: true }
  })

  // --- shares that ended -----------------------------------------------------------

  app.get(API.forks, async (request, reply): Promise<ForksResponse | undefined> => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return { forks: await hub.forksOf(accountId) }
  })

  app.get<{ Params: DocParams }>(`${API.forks}/:docId`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return hub.fork(accountId, request.params.docId)
  })

  app.post<{ Params: DocParams }>(`${API.forks}/:docId/done`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const body = (request.body ?? {}) as Partial<ForkDoneRequest>
    return { forkedTo: await hub.forkDone(accountId, request.params.docId, body.forkedTo) }
  })

  app.post(`${API.shares}/role`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await hub.setRole(accountId, request.body as RoleRequest)
    return { ok: true }
  })

  app.post(`${API.shares}/accept`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const body = (request.body ?? {}) as Partial<AcceptRequest>
    await hub.accept(accountId, body.docId, body.vaultId)
    return { ok: true }
  })

  // --- keys and log --------------------------------------------------------------

  app.get<{ Params: RoomParams }>(`${API.keys}/:room`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return hub.keys(accountId, request.params.room)
  })

  app.get<{ Params: RoomParams }>(`${API.log}/:room`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return hub.log(accountId, request.params.room)
  })

  app.post<{ Params: RoomParams }>(`${API.log}/:room/snapshot`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await hub.snapshot(accountId, request.params.room, request.body as SnapshotRequest)
    return { ok: true }
  })

  app.post<{ Params: RoomParams; Querystring: { vaultId?: string } }>(
    `${API.log}/:room/import`,
    async (request, reply) => {
      const accountId = await user(request, reply)
      if (!accountId) return undefined
      const vaultId = request.query.vaultId ?? ''
      if (!isHexId(vaultId)) return reply.code(400).send({ error: 'not a vault id' })
      const body = (request.body ?? {}) as Partial<ImportRequest>
      const headSeq = await hub.importFrames(accountId, request.params.room, vaultId, body.frames ?? [])
      return { headSeq }
    }
  )

  app.get<{ Querystring: { vaultId?: string; before?: string } }>(API.compactable, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const before = Number(request.query.before)
    if (!Number.isFinite(before)) return reply.code(400).send({ error: 'before is required' })
    const response: CompactableResponse = {
      rooms: await hub.compactable(accountId, request.query.vaultId ?? '', before)
    }
    return response
  })

  return app
}
