import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  API,
  PROTOCOL_VERSION,
  type DevTokenRequest,
  type HistoryRestoreRequest,
  type LoginRequest
} from '@crdt-sync/shared'
import type { ServerConfig } from './config.js'
import type { TokenService } from './auth.js'
import type { RoomManager } from './rooms.js'

interface RoomParams {
  room: string
}

export function createHttpApp(
  config: ServerConfig,
  tokens: TokenService,
  rooms: RoomManager
): FastifyInstance {
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

  app.get(API.rooms, async () => ({ rooms: await rooms.summaries() }))

  app.get<{ Params: RoomParams }>(`${API.history}/:room/versions`, async (request) => {
    const room = request.params.room
    return { room, versions: await rooms.versions(room) }
  })

  app.get<{ Params: RoomParams }>(`${API.history}/:room/text`, async (request, reply) => {
    const room = request.params.room
    const raw = (request.query as { ts?: string }).ts
    const ts = Number.parseInt(raw ?? '', 10)
    if (!Number.isFinite(ts)) {
      return reply.code(400).send({ error: 'ts is required' })
    }
    return { room, ts, text: await rooms.textAt(room, ts) }
  })

  // Restoring edits the live document instead of replacing it, so the rollback
  // reaches connected clients through the normal sync path and is recorded as
  // a new version of its own.
  app.post<{ Params: RoomParams }>(`${API.history}/:room/restore`, async (request, reply) => {
    const room = request.params.room
    const body = (request.body ?? {}) as Partial<HistoryRestoreRequest>
    const ts = Number(body.ts)
    if (!Number.isFinite(ts)) {
      return reply.code(400).send({ error: 'ts is required' })
    }
    const chars = await rooms.restore(room, ts)
    return { room, ts, restored: true, chars }
  })

  return app
}
