import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { API, PROTOCOL_VERSION, type DevTokenRequest, type LoginRequest } from '@crdt-sync/shared'
import type { ServerConfig } from './config.js'
import type { TokenService } from './auth.js'

export function createHttpApp(config: ServerConfig, tokens: TokenService): FastifyInstance {
  const app = Fastify({ logger: true })

  app.get(API.health, async () => ({
    ok: true,
    service: 'crdt-sync-server',
    protocol: PROTOCOL_VERSION
  }))

  app.post(API.devToken, async (request, reply) => {
    if (!config.devAllowAnonymous) {
      return reply.code(403).send({ error: 'development tokens are disabled' })
    }
    const body = (request.body ?? {}) as DevTokenRequest
    const name = (body.name ?? '').trim() || 'Dev user'
    return tokens.issueUserToken({ id: `dev:${randomUUID()}`, name })
  })

  app.post(API.login, async (request, reply) => {
    const body = (request.body ?? {}) as Partial<LoginRequest>
    const email = (body.email ?? '').trim()
    if (!email) {
      return reply.code(400).send({ error: 'email is required' })
    }
    const name = email.includes('@') ? (email.split('@')[0] ?? email) : email
    return tokens.issueUserToken({ id: `user:${email}`, name })
  })

  return app
}
