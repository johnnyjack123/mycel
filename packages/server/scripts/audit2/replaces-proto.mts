// Audit 2, finding: any account that deleted one of its vaults sets a property on
// `Object.prototype` of the whole server process with `POST /vaults {replaces: "__proto__"}`.
// `addVault` looks the value up as `account.deletedVaults?.[replaces]` - `__proto__` of a plain
// object is `Object.prototype` - and writes `replacedBy` into it. From then on `restoreRefusal`
// finds `replacedBy` on every deleted vault of every account: none can be restored, by its owner
// or the admin, until the server restarts, and every bundle says so. Fastify's poisoning guard
// checks a body's keys, not its values.
//
//   cd packages/server && npx tsx scripts/audit2/replaces-proto.mts
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../src/config.js'
import { startServer } from '../../src/server.js'

const root = mkdtempSync(join(tmpdir(), 'audit2-replaces-proto-'))
const server = await startServer(
  loadConfig({ HOST: '127.0.0.1', PORT: '0', MYCEL_DATA_DIR: root, MYCEL_REGISTRATION: 'open', MYCEL_JWT_SECRET: randomBytes(48).toString('base64') }),
  { logger: false, paceMs: 0, maxFailures: 1_000 }
)
const base = `http://127.0.0.1:${server.port}`
const b64 = (length: number): string => randomBytes(length).toString('base64')
const hexId = (): string => randomBytes(16).toString('hex')

async function call(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await response.text()
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

async function account(): Promise<{ token: string; loginKey: string; vaultId: string }> {
  const loginKey = b64(32)
  const made = await call('POST', '/auth/register', null, {
    loginKey,
    kdfVersion: 1,
    publicKey: b64(65),
    wrappedPrivateKey: b64(64),
    wrappedAccountSecret: b64(48),
    signingPublicKey: b64(65),
    wrappedSigningKey: b64(64)
  })
  const token = made.body.token as string
  const vaultId = hexId()
  await call('POST', '/vaults', token, { vaultId, sealedName: b64(32), wrappedKey: b64(48) })
  return { token, loginKey, vaultId }
}

let failed = false
try {
  // Someone else deletes a vault of theirs and means to take it back within the week.
  const victim = await account()
  const deleted = await call('POST', `/vaults/${victim.vaultId}/delete`, victim.token, { loginKey: victim.loginKey })
  console.log(`the victim deletes a vault: ${deleted.status}`)

  // The attacker: an ordinary account that deleted a vault of its own.
  const attacker = await account()
  await call('POST', `/vaults/${attacker.vaultId}/delete`, attacker.token, { loginKey: attacker.loginKey })
  const answer = await call('POST', '/vaults', attacker.token, { vaultId: hexId(), sealedName: b64(32), wrappedKey: b64(48), replaces: '__proto__' })
  console.log(`POST /vaults with replaces "__proto__": ${answer.status}`)
  const polluted = ({} as Record<string, unknown>).replacedBy
  console.log(`Object.prototype.replacedBy in the server process: ${JSON.stringify(polluted)}`)

  const restore = await call('POST', `/vaults/${victim.vaultId}/restore`, victim.token, { loginKey: victim.loginKey })
  console.log(`the victim restores their vault: ${restore.status} ${JSON.stringify(restore.body)}`)
  failed = polluted !== undefined || restore.status !== 200
  console.log(`${failed ? 'FAIL' : 'PASS'}: EXPECTED SAFE: a value sent by one account changes nothing of anyone else's (FAIL = finding reproduced)`)
} finally {
  delete (Object.prototype as Record<string, unknown>).replacedBy
  await server.close()
  rmSync(root, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
