// Audit 2, finding: one relay message ends the sync server process.
//
// The relay forwards `String(frame.d)` (relay.ts, `fromDevice`/`fromBackup`) inside a WebSocket
// `message` listener without a try/catch, and the process has no `uncaughtException` handler. A
// `d` that is a JSON object with a `toString` that is no function makes `String()` throw; ws emits
// `message` synchronously from the socket's `data` event, so the throw is uncaught and Node exits.
// S1 (0.9.8) added `error` listeners - they do not catch a throw in the server's own listener.
//
// Needed: any account (anyone, with open registration) for the device end; the backup end needs
// no token at all. The server runs here as a child process on port 1237 with a scratch data
// folder, never the user's.
//
//   cd packages/server && npx tsx scripts/audit2/relay-crash.mts
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { socketProtocols } from '@mycel/shared'

const PORT = 1237
const here = dirname(fileURLToPath(import.meta.url))
const serverDir = join(here, '..', '..')
const tsx = join(serverDir, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
const data = mkdtempSync(join(tmpdir(), 'audit2-relay-crash-'))
const b64 = (length: number): string => randomBytes(length).toString('base64')
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const child = spawn(process.execPath, [tsx, 'src/index.ts'], {
  cwd: serverDir,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(PORT),
    MYCEL_DATA_DIR: data,
    MYCEL_REGISTRATION: 'open',
    MYCEL_JWT_SECRET: randomBytes(48).toString('base64')
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let output = ''
child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
let exited: number | null | undefined
child.on('exit', (code) => (exited = code))

function open(url: string, protocols?: string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url)
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error(`could not open ${url}`))
  })
}

function next(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.onmessage = (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>)
  })
}

let failed = false
try {
  const base = `http://127.0.0.1:${PORT}`
  for (let i = 0; i < 100; i += 1) {
    if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) break
    await delay(200)
  }
  // Any account: registration is open here.
  const registered = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      loginKey: b64(32),
      kdfVersion: 1,
      publicKey: b64(65),
      wrappedPrivateKey: b64(64),
      wrappedAccountSecret: b64(48),
      signingPublicKey: b64(65),
      wrappedSigningKey: b64(64)
    })
  }).then((r) => r.json() as Promise<{ token: string }>)

  // A backup server end - nobody needs an account for it - and the account's device end.
  const backup = await open(`ws://127.0.0.1:${PORT}/relay?role=backup`)
  const gotRoute = next(backup)
  backup.send(JSON.stringify({ t: 'register', token: b64(32) }))
  const { route } = await gotRoute
  const device = await open(`ws://127.0.0.1:${PORT}/relay`, socketProtocols(registered.token))
  const opened = next(device)
  device.send(JSON.stringify({ t: 'open', route, ref: 1 }))
  const { s } = await opened
  console.log(`session ${String(s)} open through the relay`)

  device.send(JSON.stringify({ t: 'data', s, d: { toString: 0 } }))
  await delay(2_000)
  const alive = await fetch(`${base}/health`).then((r) => r.ok, () => false)
  console.log(`server process exit code: ${String(exited)}; answers /health: ${alive}`)
  console.log(output.split('\n').filter((line) => /TypeError|Cannot convert/.test(line)).slice(0, 2).join('\n'))
  failed = !alive
  console.log(`${alive ? 'PASS' : 'FAIL'}: EXPECTED SAFE: one relay message leaves the server running (FAIL = finding reproduced)`)
} finally {
  if (exited === undefined) child.kill()
  await delay(500)
  rmSync(data, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
