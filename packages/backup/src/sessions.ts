import type { BackupGrant, BackupTargetSetting } from '@obsidian-connect/shared'
import {
  SessionCipher,
  answerSession,
  fromBase64,
  sameMac,
  sessionProof,
  vaultControlProof,
  type SessionHello,
  type SessionKeys
} from '@obsidian-connect/shared/crypto'
import { envOf, isRemote, localFolder, overlapping, writable } from './config.js'
import type { Identity } from './identity.js'
import { log } from './log.js'
import type { IncomingSession } from './relay.js'
import type { Restic } from './restic.js'
import type { BackupService } from './service.js'

// A device's session with this backup server, through the relay. It opens in
// the clear with an ephemeral key; the answer proves this backup server knows
// the code, the device's first sealed message proves the device does. From
// then on every message is sealed, in order. Knowing the code lets a device
// connect vaults of its own; everything about a connected vault also needs
// that vault's key, proved for this session.

export interface SessionDeps {
  identity: Identity
  service: BackupService
  restic: Restic
  root: string
}

/** Requests over a session, and what each one answers. */
export interface SessionRequest {
  id: number
  m: string
  p?: Record<string, unknown>
}

const FAILURE_WINDOW_MS = 60_000
const failures: number[] = []

/** Failed handshakes are answered more and more slowly: guessing a code takes a request each. */
function penalty(now: number): number {
  while (failures.length > 0 && (failures[0] as number) < now - FAILURE_WINDOW_MS) failures.shift()
  return Math.min(5_000, failures.length * 250)
}

export function serveSession(session: IncomingSession, deps: SessionDeps): void {
  let keys: SessionKeys | null = null
  let cipher: SessionCipher | null = null
  let proven = false
  const vaults = new Set<string>()
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
        const answered = await answerSession(deps.identity.keys.psk, frame.hello)
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
      if (typeof message.proof !== 'string' || !sameMac(message.proof, await sessionProof(deps.identity.keys.psk, 'plugin', keys.transcript))) {
        fail('the device could not prove it knows the code')
        return
      }
      proven = true
      unsubscribe = deps.service.onFinished((vaultId, report) => {
        if (vaults.has(vaultId)) void reply({ ev: 'finished', p: { vaultId, report } })
      })
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
  }

  /** The vault a request is about, once the device has shown it holds that vault's key. */
  const owned = (params: Record<string, unknown>): string => {
    const vaultId = params.vaultId
    if (typeof vaultId !== 'string' || !vaults.has(vaultId)) throw new Error('not a vault this device has shown it owns')
    if (!deps.service.has(vaultId)) throw new Error('that vault is not connected here')
    return vaultId
  }

  const answer = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const { service } = deps
    switch (method) {
      case 'info':
        return service.info()
      case 'connect': {
        const grant = params.grant as BackupGrant
        await service.connect(grant)
        vaults.add(grant.vaultId)
        return { vaultId: grant.vaultId }
      }
      case 'authorize': {
        const vaultId = params.vaultId
        const grant = typeof vaultId === 'string' ? service.grant(vaultId) : null
        const proof = params.proof
        if (!grant || typeof proof !== 'string' || !keys) throw new Error('that vault is not connected here')
        if (!sameMac(proof, await vaultControlProof(fromBase64(grant.vaultKey), grant.vaultId, keys.transcript))) {
          throw new Error('that is not your vault')
        }
        vaults.add(grant.vaultId)
        return service.status(grant.vaultId)
      }
      case 'status':
        return service.status(owned(params))
      case 'refresh': {
        const vaultId = owned(params)
        await service.refresh(vaultId)
        return service.status(vaultId)
      }
      case 'run': {
        const vaultId = owned(params)
        void service.run(vaultId, { acceptShrink: params.acceptShrink === true }).catch(() => undefined)
        return service.status(vaultId)
      }
      case 'check':
        return checkTarget(deps, owned(params), params.target as BackupTargetSetting)
      case 'disconnect': {
        const vaultId = owned(params)
        await service.disconnect(vaultId)
        vaults.delete(vaultId)
        return { ok: true }
      }
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
