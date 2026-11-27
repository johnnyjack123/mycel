// Audit 2, finding: wrong two-factor codes sent at once are all checked. `POST /auth/login/totp`
// asks `codeGuard.blocked()` before `await accounts.checkTotp()` and counts the failure only
// after it; `paced` delays an answer, it does not serialize. Five wrong codes block the account -
// but a burst of hundreds sent together is evaluated in full, and a right code inside the burst
// signs in. The address guard (`guarded`) has the same order. With the password (which is what
// 2FA is there for), 10,000 codes per burst and one burst per block period find a valid code
// within about a day.
//
//   cd packages/server && npx tsx scripts/audit2/totp-burst.mts
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../src/config.js'
import { startServer } from '../../src/server.js'
import { totpCode, totpStep } from '../../src/totp.js'

const root = mkdtempSync(join(tmpdir(), 'audit2-totp-burst-'))
// The address guard out of the way, to show the per-account code guard alone; it is checked the same way.
const server = await startServer(
  loadConfig({ HOST: '127.0.0.1', PORT: '0', MYCEL_DATA_DIR: root, MYCEL_REGISTRATION: 'open', MYCEL_JWT_SECRET: randomBytes(48).toString('base64') }),
  { logger: false, paceMs: 0, maxFailures: 100_000 }
)
const base = `http://127.0.0.1:${server.port}`
const b64 = (length: number): string => randomBytes(length).toString('base64')

async function call(path: string, body: unknown, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  })
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> }
}

let failed = false
try {
  const loginKey = b64(32)
  const made = await call('/auth/register', {
    loginKey,
    kdfVersion: 1,
    publicKey: b64(65),
    wrappedPrivateKey: b64(64),
    wrappedAccountSecret: b64(48),
    signingPublicKey: b64(65),
    wrappedSigningKey: b64(64)
  })
  const secret = randomBytes(20)
  const on = await call('/account/totp', { loginKey, secret: secret.toString('base64'), code: totpCode(secret, totpStep(Date.now())) }, made.body.token as string)
  console.log(`two-factor sign-in turned on: ${on.status}`)
  await new Promise((resolve) => setTimeout(resolve, 31_000)) // the next step: the code used to turn it on is spent
  const login = await call('/auth/login', { loginKey })
  const challenge = login.body.challenge as string
  console.log(`password right, a code asked for: ${login.status}`)

  const right = totpCode(secret, totpStep(Date.now()))
  const wrong = (i: number): string => {
    const code = String((Number(right) + 1 + i) % 1_000_000).padStart(6, '0')
    return code === right ? '999999' : code
  }
  const burst = Array.from({ length: 100 }, (_, i) => (i === 80 ? right : wrong(i)))
  const answers = await Promise.all(burst.map((code) => call("/auth/login/totp", { challenge, code }).catch(() => ({ status: 0, body: {} }))))
  const checked = answers.filter((answer, i) => i !== 80 && answer.status === 401).length
  const blocked = answers.filter((answer) => answer.status === 429).length
  const signedIn = answers[80]?.status === 200 && typeof answers[80]?.body.token === 'string'
  console.log(`of 99 wrong codes sent together: ${checked} checked and refused, ${blocked} blocked; the right one at #80 signed in: ${signedIn}`)
  failed = checked > 5 || signedIn
  console.log(`${failed ? 'FAIL' : 'PASS'}: EXPECTED SAFE: no more than 5 wrong codes are ever checked before the account is blocked (FAIL = finding reproduced)`)
} finally {
  await server.close()
  rmSync(root, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
