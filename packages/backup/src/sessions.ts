import type { BackupConnected, BackupGrant, BackupTargetSetting } from '@obsidian-connect/shared'
import { SessionCipher, answerSession, sameMac, sessionProof, type Bytes, type SessionHello, type SessionKeys } from '@obsidian-connect/shared/crypto'
import { envOf, isRemote, localFolder, overlapping, writable } from './config.js'
import { log } from './log.js'
import type { IncomingSession } from './relay.js'
import type { Restic } from './restic.js'
import type { BackupService } from './service.js'

// A device's session with this backup server, through the relay. It opens in
// the clear with an ephemeral key; the answer proves this backup server knows
// the route's secret, the device's first sealed message proves the device
// does. From then on every message is sealed, in order. The route says what
// the session may do: on an invitation's, connect a vault - once; on a
// vault's pairing, everything about that vault and nothing about another.

/** What a route is: an open invitation, or a paired vault. */
export type Route =
  | { kind: 'invite'; inviteId: string; label: string; expiresAt: number; psk: Bytes }
  | { kind: 'vault'; vaultId: string; psk: Bytes }

export interface SessionDeps {
  /** The route a session was opened on; null when it is not answered (any more). */
  route: (routeId: string) => Route | null
  service: BackupService
  restic: Restic
  root: string
  now: () => number
  /** Resolves once the relay answers a vault's new pairing route, so the device can reach it right away. */
  paired: (routeId: string) => Promise<void>
  /** An invitation was used: it goes, and its route with it - which ends the session on it. */
  spend: (inviteId: string) => Promise<void>
}

/** Requests over a session, and what each one answers. */
export interface SessionRequest {
  id: number
  m: string
  p?: Record<string, unknown>
}

const FAILURE_WINDOW_MS = 60_000
const failures: number[] = []

/** Failed handshakes are answered more and more slowly: guessing a secret takes a request each. */
function penalty(now: number): number {
  while (failures.length > 0 && (failures[0] as number) < now - FAILURE_WINDOW_MS) failures.shift()
  return Math.min(5_000, failures.length * 250)
}

export function serveSession(session: IncomingSession, deps: SessionDeps): void {
  const route = deps.route(session.route)
  if (!route) {
    session.close('nothing answers this route any more')
    return
  }
  let keys: SessionKeys | null = null
  let cipher: SessionCipher | null = null
  let proven = false
  let spent = false
  let work: Promise<unknown> = Promise.resolve()
  let unsubscribe: (() => void) | null = null

  const fail = (reason: string): void => {
    failures.push(Date.now())
    session.close(reason)
  }

  const reply = async (message: unknown): Promise<void> => {
    if (!cipher) return
    session.send(JSON.stringify({ c: await cipher.seal(JSON.stringify(message)) }))
  }

  const handle = async (raw: string): Promise<void> => {
    let frame: { hello?: SessionHello; c?: string }
    try {
      frame = JSON.parse(raw) as { hello?: SessionHello; c?: string }
    } catch {
      fail('not a session message')
      return
    }
    if (!keys) {
      if (!frame.hello) {
        fail('a session starts with a hello')
        return
      }
      const wait = penalty(Date.now())
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      try {
        const answered = await answerSession(route.psk, frame.hello)
        keys = answered.keys
        cipher = new SessionCipher(keys, 'backup')
        session.send(JSON.stringify({ answer: answered.answer }))
      } catch {
        fail('not a session opening')
      }
      return
    }
    if (!cipher || typeof frame.c !== 'string') {
      fail('a sealed message was expected')
      return
    }
    let message: { proof?: string } & Partial<SessionRequest>
    try {
      message = JSON.parse(await cipher.open(frame.c)) as typeof message
    } catch {
      fail('a message did not open')
      return
    }
    if (!proven) {
      if (typeof message.proof !== 'string' || !sameMac(message.proof, await sessionProof(route.psk, 'plugin', keys.transcript))) {
        fail('the device could not prove it knows the secret')
        return
      }
      proven = true
      if (route.kind === 'vault') {
        unsubscribe = deps.service.onFinished((vaultId, report) => {
          if (vaultId === route.vaultId) void reply({ ev: 'finished', p: { vaultId, report } })
        })
      }
      await reply({ ok: true })
      return
    }
    if (typeof message.id !== 'number' || typeof message.m !== 'string') {
      fail('not a request')
      return
    }
    try {
      await reply({ id: message.id, r: await answer(message.m, message.p ?? {}) })
    } catch (error) {
      await reply({ id: message.id, e: error instanceof Error ? error.message : String(error) })
    }
    // Only after the answer: spending the invitation drops its route, and the relay ends this session with it.
    if (spent && route.kind === 'invite') await deps.spend(route.inviteId)
  }

  const answer = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const { service } = deps
    if (method === 'info') return service.info()
    if (route.kind === 'invite') {
      if (method !== 'connect') throw new Error('an invitation connects a vault, and does nothing else')
      if (spent) throw new Error('this invitation was used')
      if (route.expiresAt <= deps.now()) throw new Error('this invitation ran out; ask for a new one')
      const grant = params.grant as BackupGrant
      const connected = await service.connect(grant, route.label)
      spent = true
      await deps.paired(connected.pairing.routeId)
      const answer: BackupConnected = {
        vaultId: grant.vaultId,
        pairing: connected.pairing.secret,
        replaced: connected.replaced
      }
      return answer
    }
    const vaultId = route.vaultId
    if (!service.has(vaultId)) throw new Error('this backup server no longer has this vault')
    switch (method) {
      case 'status':
        return service.status(vaultId)
      case 'refresh':
        await service.refresh(vaultId)
        return service.status(vaultId)
      case 'run':
        void service.run(vaultId, { acceptShrink: params.acceptShrink === true }).catch(() => undefined)
        return service.status(vaultId)
      case 'check':
        return checkTarget(deps, vaultId, params.target as BackupTargetSetting)
      case 'rekey':
        await service.rekey(vaultId, params.grant as BackupGrant)
        return service.status(vaultId)
      case 'disconnect':
        await service.disconnect(vaultId)
        return { ok: true }
      default:
        throw new Error(`no such request: ${method}`)
    }
  }

  session.onData((raw) => {
    // In order: the cipher counts every message.
    work = work.then(() => handle(raw)).catch((error: unknown) => {
      log.warn('a session failed', error)
      session.close('failed')
    })
  })
  session.onClose(() => unsubscribe?.())
}

/** Whether a destination can be used: its folder, its repository and password - made when there is none yet. */
async function checkTarget(deps: SessionDeps, vaultId: string, target: BackupTargetSetting): Promise<{ ok: boolean; error?: string; created?: boolean }> {
  if (!target || typeof target.location !== 'string') return { ok: false, error: 'no destination given' }
  const others = deps.service.localPathsBesides(vaultId)
  let repository = target.location.trim()
  if (!isRemote(repository) || target.kind === 'trusted') {
    const folder = localFolder(repository, deps.root)
    if ('error' in folder) return { ok: false, error: folder.error }
    if (others.some((other) => overlapping(other, folder.path))) return { ok: false, error: 'another vault on this backup server uses this folder, or one around it' }
    const problem = await writable(folder.path)
    if (problem) return { ok: false, error: problem }
    repository = folder.path
  }
  if (target.kind === 'trusted') return { ok: true }
  if (typeof target.password !== 'string' || target.password === '') return { ok: false, error: 'the repository needs a password' }
  try {
    const opened = await deps.restic.ensureRepo({ repository, password: target.password, env: envOf(target.env) })
    return { ok: true, created: opened === 'created' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
