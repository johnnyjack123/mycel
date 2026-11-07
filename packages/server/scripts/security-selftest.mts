// Attacks on a running server, over its real HTTP and WebSocket interfaces:
// what someone on the internet without an account can try, what a signed-in
// account can try against another one, and what a contact can try against the
// people they share with. Every check names the attack it stands for; a FAIL
// means the attack works again. In-process, on a port and a scratch directory
// of its own - never the user's server (CLAUDE.md, Gotchas).
//
//   npm run test:security -w @mycel/server
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT } from 'jose'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { MUX, WS_PROTOCOL, socketProtocols } from '@mycel/shared'
import { loadConfig, type ServerConfig } from '../src/config.js'
import { startServer, type RunningServer } from '../src/server.js'

const failures: string[] = []
function check(ok: boolean, label: string, detail?: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`)
  if (!ok) {
    failures.push(label)
    if (detail !== undefined) console.log('      got:', typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const b64 = (length: number): string => randomBytes(length).toString('base64')
const hexId = (): string => randomBytes(16).toString('hex')
const STRONG_SECRET = randomBytes(48).toString('base64')
const OLD_BUILT_IN_SECRET = 'dev-insecure-secret-change-me'

const root = mkdtempSync(join(tmpdir(), 'mycel-security-selftest-'))

function configFor(dir: string, env: Record<string, string> = {}): ServerConfig {
  return loadConfig({
    HOST: '127.0.0.1',
    PORT: '0',
    MYCEL_DATA_DIR: join(root, dir),
    MYCEL_REGISTRATION: 'open',
    MYCEL_JWT_SECRET: STRONG_SECRET,
    ...env
  })
}

async function serve(dir: string, env: Record<string, string> = {}, maxFailures = 10): Promise<{ server: RunningServer; base: string; ws: string }> {
  const server = await startServer(configFor(dir, env), { logger: false, paceMs: 0, maxFailures })
  return { server, base: `http://127.0.0.1:${server.port}`, ws: `ws://127.0.0.1:${server.port}` }
}

interface Answer {
  status: number
  body: Record<string, unknown>
}

async function call(base: string, method: string, path: string, options: { token?: string; body?: unknown; raw?: string | Uint8Array; headers?: Record<string, string> } = {}): Promise<Answer> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.token) headers.authorization = `Bearer ${options.token}`
  let body: string | Uint8Array | undefined
  if (options.raw !== undefined) {
    body = options.raw
    headers['content-type'] ??= 'application/json'
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body)
    headers['content-type'] = 'application/json'
  }
  try {
    const response = await fetch(`${base}${path}`, { method, headers, body })
    const text = await response.text()
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch {
      parsed = { text }
    }
    return { status: response.status, body: parsed }
  } catch (error) {
    // The server cut the request off - a body it refused to read, say.
    return { status: 0, body: { error: String(error) } }
  }
}

interface Account {
  id: string
  token: string
  loginKey: string
  vaultId: string
}

function keyMaterial(): Record<string, unknown> {
  return {
    loginKey: b64(32),
    kdfVersion: 1,
    publicKey: b64(65),
    wrappedPrivateKey: b64(64),
    wrappedAccountSecret: b64(48),
    signingPublicKey: b64(65),
    wrappedSigningKey: b64(64)
  }
}

async function register(base: string): Promise<Account> {
  const material = keyMaterial()
  const answer = await call(base, 'POST', '/auth/register', { body: material })
  if (answer.status !== 200) throw new Error(`registering failed: ${answer.status} ${JSON.stringify(answer.body)}`)
  const token = answer.body.token as string
  const id = (answer.body.account as { accountId: string }).accountId
  const vaultId = hexId()
  const vault = await call(base, 'POST', '/vaults', { token, body: { vaultId, sealedName: b64(32), wrappedKey: b64(48) } })
  if (vault.status !== 200) throw new Error(`making a vault failed: ${vault.status}`)
  return { id, token, loginKey: material.loginKey as string, vaultId }
}

/** Makes two accounts contacts the way two devices do: a code, its redemption. */
async function pair(base: string, owner: Account, redeemer: Account): Promise<string> {
  const codeId = hexId()
  const redeemKey = randomBytes(32)
  const redeemHash = createHash('sha256').update(redeemKey).digest('hex')
  const made = await call(base, 'POST', '/contacts/codes', { token: owner.token, body: { codeId, redeemHash, expiresAt: Date.now() + 60_000 } })
  if (made.status !== 200) throw new Error(`making a code failed: ${made.status}`)
  const redeemed = await call(base, 'POST', '/contacts/redeem', { token: redeemer.token, body: { codeId, redeemKey: redeemKey.toString('base64'), sealed: b64(300) } })
  if (redeemed.status !== 200) throw new Error(`redeeming failed: ${redeemed.status}`)
  return codeId
}

// --- the vault socket ------------------------------------------------------------

interface Incoming {
  type: number
  room: string
  numbers: number[]
  text?: string
}

class Socket {
  readonly received: Incoming[] = []
  closed: { code: number; reason: string } | null = null
  private constructor(private readonly ws: WebSocket) {
    ws.binaryType = 'arraybuffer'
    ws.addEventListener('message', (event) => this.received.push(Socket.decode(new Uint8Array(event.data as ArrayBuffer))))
    ws.addEventListener('close', (event) => {
      this.closed = { code: event.code, reason: event.reason }
    })
  }

  /** The subprotocol the server answered with. */
  get protocol(): string {
    return this.ws.protocol
  }

  static open(url: string, protocols?: string[]): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, protocols)
      const socket = new Socket(ws)
      ws.addEventListener('open', () => resolve(socket), { once: true })
      ws.addEventListener('error', () => reject(new Error(`could not open ${url}`)), { once: true })
      ws.addEventListener('close', () => resolve(socket), { once: true })
    })
  }

  private static decode(data: Uint8Array): Incoming {
    const decoder = decoding.createDecoder(data)
    const type = decoding.readVarUint(decoder)
    if (type === MUX.notify || type === MUX.error) return { type, room: '', numbers: [], text: decoding.readVarString(decoder) }
    const room = decoding.readVarString(decoder)
    const numbers: number[] = []
    let text: string | undefined
    if (type === MUX.denied || type === MUX.revoked) text = decoding.readVarString(decoder)
    else if (type === MUX.frame) {
      numbers.push(decoding.readVarUint(decoder), decoding.readVarUint(decoder), decoding.readVarUint(decoder))
      text = Buffer.from(decoding.readVarUint8Array(decoder)).toString()
    } else {
      while (decoding.hasContent(decoder)) {
        try {
          numbers.push(decoding.readVarUint(decoder))
        } catch {
          break
        }
      }
    }
    return { type, room, numbers, text }
  }

  send(write: (encoder: encoding.Encoder) => void): void {
    const encoder = encoding.createEncoder()
    write(encoder)
    this.ws.send(encoding.toUint8Array(encoder))
  }

  subscribe(room: string, create = true, afterSeq = 0): void {
    this.send((encoder) => {
      encoding.writeVarUint(encoder, MUX.subscribe)
      encoding.writeVarString(encoder, room)
      encoding.writeVarUint(encoder, afterSeq)
      encoding.writeVarUint(encoder, create ? 1 : 0)
    })
  }

  push(room: string, ref: number, epoch: number, data: Uint8Array): void {
    this.send((encoder) => {
      encoding.writeVarUint(encoder, MUX.push)
      encoding.writeVarString(encoder, room)
      encoding.writeVarUint(encoder, ref)
      encoding.writeVarUint(encoder, epoch)
      encoding.writeVarUint8Array(encoder, data)
    })
  }

  next(type: number, room: string, timeoutMs = 3000): Promise<Incoming | null> {
    return this.nextOf([type], room, timeoutMs)
  }

  async nextOf(types: number[], room: string, timeoutMs = 3000): Promise<Incoming | null> {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      const found = this.received.findIndex((message) => types.includes(message.type) && message.room === room)
      if (found >= 0) return this.received.splice(found, 1)[0] as Incoming
      if (this.closed) return null
      await delay(10)
    }
    return null
  }

  /** The first answer to a subscribe: caught up, denied or revoked. */
  async answer(room: string, timeoutMs = 3000): Promise<Incoming | null> {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      const found = this.received.findIndex((message) => message.room === room && [MUX.caughtUp, MUX.denied, MUX.revoked].includes(message.type as 12))
      if (found >= 0) return this.received.splice(found, 1)[0] as Incoming
      if (this.closed) return null
      await delay(10)
    }
    return null
  }

  async whenClosed(timeoutMs = 3000): Promise<{ code: number; reason: string } | null> {
    const until = Date.now() + timeoutMs
    while (Date.now() < until && !this.closed) await delay(10)
    return this.closed
  }

  close(): void {
    this.ws.close()
  }
}

/**
 * An upgrade by hand: then `bytes` as they are, or - for null - the connection
 * reset at once, while the server is still checking it.
 */
function rawUpgrade(port: number, path: string, bytes: Buffer | null): Promise<void> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`
      )
      if (bytes === null) {
        socket.resetAndDestroy()
        resolve()
        return
      }
      socket.once('data', () => {
        socket.write(bytes)
        setTimeout(() => {
          socket.destroy()
          resolve()
        }, 100)
      })
    })
    socket.on('error', () => resolve())
    socket.setTimeout(3000, () => {
      socket.destroy()
      resolve()
    })
  })
}

/** A vault socket as a device opens it: the token among the subprotocols, out of the URL. */
const openVault = (ws: string, account: Account, vaultId = account.vaultId): Promise<Socket> =>
  Socket.open(`${ws}/vault/${vaultId}`, socketProtocols(account.token))

/** A note of `owner`'s own with one frame in it. */
async function noteOf(ws: string, owner: Account): Promise<{ docId: string; room: string; socket: Socket }> {
  const docId = hexId()
  const room = `doc:${docId}`
  const socket = await openVault(ws, owner)
  socket.subscribe(room)
  const ready = await socket.answer(room)
  if (ready?.type !== MUX.caughtUp) throw new Error(`creating ${room} failed: ${JSON.stringify(ready)}`)
  socket.push(room, 1, 0, new TextEncoder().encode('secret ciphertext of the owner'))
  const ack = await socket.next(MUX.ack, room)
  if (!ack) throw new Error('the first frame was not acknowledged')
  return { docId, room, socket }
}

const servers: RunningServer[] = []

try {
  // ===============================================================================
  // 1. Tokens: nobody signs one but the server, and nobody can guess its key.
  // ===============================================================================
  {
    // Before 0.9.8 a server started without MYCEL_JWT_SECRET signed with a
    // secret written in this file's sources: anyone could make a token for
    // any account id they learned (a contact's, a share's member list).
    const config = loadConfig({ HOST: '127.0.0.1', PORT: '0', MYCEL_DATA_DIR: join(root, 'no-secret'), MYCEL_REGISTRATION: 'open' })
    check(config.jwtSecret !== OLD_BUILT_IN_SECRET, 'no built-in token secret is used when none is set', config.jwtSecret)
    let first: RunningServer | null = null
    try {
      first = await startServer(config, { logger: false, paceMs: 0 })
    } catch (error) {
      check(false, 'a server without MYCEL_JWT_SECRET starts with a secret of its own', String(error))
    }
    if (first) {
      const base = `http://127.0.0.1:${first.port}`
      const victim = await register(base)
      const forged = await new SignJWT({ scope: 'user', gen: 0 })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(victim.id)
        .setIssuer('mycel')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(OLD_BUILT_IN_SECRET))
      check((await call(base, 'GET', '/account', { token: forged })).status === 401, 'a token signed with the old built-in secret is refused')
      await first.close()
      const again = await startServer(config, { logger: false, paceMs: 0 })
      servers.push(again)
      check(
        (await call(`http://127.0.0.1:${again.port}`, 'GET', '/account', { token: victim.token })).status === 200,
        'the secret it made is kept: its tokens hold over a restart'
      )
      if (process.platform !== 'win32') {
        const mode = statSync(join(root, 'no-secret', 'jwt-secret')).mode & 0o777
        check((mode & 0o077) === 0, 'and only the server user can read it', mode.toString(8))
      }
    }

    // A short secret falls to an offline search: every account holds a token
    // signed with it, which is all such a search needs.
    let refused = false
    try {
      const weak = await startServer(configFor('weak-secret', { MYCEL_JWT_SECRET: 'mysecret' }), { logger: false, paceMs: 0 })
      servers.push(weak)
    } catch {
      refused = true
    }
    check(refused, 'a token secret shorter than 32 characters is refused at start')
  }

  const { server, base, ws } = await serve('main', { MYCEL_TRUST_PROXY: '127.0.0.1' })
  servers.push(server)
  const alice = await register(base)
  const bob = await register(base)
  const mallory = await register(base)

  {
    const sign = (claims: Record<string, unknown>, secret = STRONG_SECRET, expires = '1h'): Promise<string> =>
      new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setSubject(alice.id).setIssuer('mycel').setIssuedAt().setExpirationTime(expires).sign(new TextEncoder().encode(secret))
    check((await call(base, 'GET', '/account', { token: await sign({ scope: 'user', gen: 0 }, randomBytes(48).toString('base64')) })).status === 401, 'a token signed with another key is refused')
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ scope: 'user', gen: 0, sub: alice.id, iss: 'mycel', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.`
    check((await call(base, 'GET', '/account', { token: unsigned })).status === 401, 'an unsigned token ("alg": "none") is refused')
    check((await call(base, 'GET', '/account', { token: await sign({ scope: '2fa', gen: 0 }) })).status === 401, "a sign-in's second-step challenge is no session")
    check((await call(base, 'GET', '/account', { token: await sign({ scope: 'backup', gen: 0, vault: alice.vaultId, kid: 'x' }) })).status === 401, "a backup server's token is no device's session")
    check((await call(base, 'GET', '/account', { token: await sign({ scope: 'user', gen: 7 }) })).status === 401, 'a token of another session generation is refused')
    check((await call(base, 'GET', '/account', { token: await sign({ scope: 'user', gen: 0 }, STRONG_SECRET, '-1s') })).status === 401, 'an expired token is refused')
  }

  // ===============================================================================
  // 2. Requests from nobody in particular: they cost the server next to nothing.
  // ===============================================================================
  {
    // A body is read before the route looks at the token - 64 MiB of JSON from
    // anyone, as often as they like, was parsed in full first.
    const unparsable = `{"data":"${'x'.repeat(8 * 1024 * 1024)}`
    const answer = await call(base, 'POST', `/log/doc:${hexId()}/snapshot`, { raw: unparsable })
    check(answer.status === 401, 'a request without a token is turned away before its body is read', answer)
    const chunk = await call(base, 'PUT', `/blobs/${alice.id}/${alice.vaultId}/${hexId()}/0?count=1`, {
      raw: new Uint8Array(4 * 1024 * 1024),
      headers: { 'content-type': 'application/octet-stream' }
    })
    check(chunk.status === 401, 'and so is a file chunk', chunk)
    const big = await call(base, 'POST', '/auth/login', { raw: JSON.stringify({ loginKey: 'x'.repeat(2 * 1024 * 1024) }) })
    check(big.status === 413 || big.status === 0, 'signing in takes no body of megabytes', big)
    const polluted = await call(base, 'POST', '/auth/login', { raw: '{"loginKey":"x","__proto__":{"admin":true}}' })
    check(polluted.status === 400, 'a body that sets __proto__ is refused', polluted)

    // A WebSocket message too large or malformed is an error on that socket;
    // unheard, it ended the server - and the relay takes backup servers
    // without any token.
    const alive = async (): Promise<boolean> => (await call(base, 'GET', '/health')).status === 200
    const backup = await Socket.open(`${ws}/relay?role=backup`)
    backup.send((encoder) => encoding.writeUint8Array(encoder, new Uint8Array(2 * 1024 * 1024)))
    await backup.whenClosed()
    check(await alive(), 'a message too large on the relay, from nobody, leaves the server running')
    const refused = await Socket.open(`${ws}/vault/${hexId()}?token=nothing`)
    refused.send((encoder) => encoding.writeUint8Array(encoder, new Uint8Array(40 * 1024 * 1024)))
    await refused.whenClosed()
    check(await alive(), 'and so does one on a vault socket with no valid token')
    for (const [what, bytes] of [
      ['a frame with reserved bits', [0xf1, 0x80, 0, 0, 0, 0]],
      ['a frame of an unknown kind', [0x83, 0x80, 0, 0, 0, 0]],
      ['an unmasked frame', [0x82, 0x01, 0x00]]
    ] as const) {
      await rawUpgrade(server.port, '/relay?role=backup', Buffer.from(bytes))
      check(await alive(), `${what} on the relay leaves the server running`)
    }
    // A client resetting its connection while the server still checks its token.
    for (let attempt = 0; attempt < 30; attempt += 1) await rawUpgrade(server.port, `/vault/${hexId()}?token=x`, null)
    check(await alive(), 'connections reset in the middle of their upgrade leave the server running')
  }

  // ===============================================================================
  // 3. Guessing passwords: per address, and the address is the client's.
  // ===============================================================================
  {
    // Behind a reverse proxy every request came from the proxy's address: ten
    // wrong passwords from anyone locked everybody out for 15 minutes.
    const login = (from: string): Promise<Answer> =>
      call(base, 'POST', '/auth/login', { body: { loginKey: b64(32) }, headers: { 'x-forwarded-for': from } })
    for (let attempt = 0; attempt < 10; attempt += 1) await login('198.51.100.7')
    check((await login('198.51.100.7')).status === 429, 'ten wrong passwords block the address they came from')
    const other = await login('203.0.113.9')
    check(other.status === 401, 'and nobody else behind the same proxy', other)

    // Without a proxy named, the header is anyone's to write: it must not
    // open a way around the block.
    const direct = await serve('direct')
    servers.push(direct.server)
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await call(direct.base, 'POST', '/auth/login', { body: { loginKey: b64(32) }, headers: { 'x-forwarded-for': `192.0.2.${attempt}` } })
    }
    const spoofed = await call(direct.base, 'POST', '/auth/login', { body: { loginKey: b64(32) }, headers: { 'x-forwarded-for': '192.0.2.200' } })
    check(spoofed.status === 429, 'an X-Forwarded-For nobody vouches for does not lift a block', spoofed)
  }

  // ===============================================================================
  // 4. One account against another.
  // ===============================================================================
  const alicesNote = await noteOf(ws, alice)
  {
    const { docId, room } = alicesNote
    for (const [path, what] of [
      [`/log/${room}`, "someone else's note's frames"],
      [`/keys/${room}`, "someone else's note's keys"],
      [`/shares/${docId}`, "someone else's note's members"],
      [`/log/${room}/whole`, "someone else's note, whole"],
      [`/keys/${room}/sealed`, "who holds someone else's keys"],
      [`/log/idx:${alice.vaultId}`, "someone else's vault index"],
      [`/vaults/${alice.vaultId}/lock`, "someone else's vault lock"],
      [`/vaults/${alice.vaultId}/rooms`, "someone else's vault's rooms"],
      [`/blobs/${alice.id}/${alice.vaultId}/list`, "someone else's file list"],
      [`/blobs/${alice.id}/usage`, "someone else's storage"]
    ] as const) {
      const answer = await call(base, 'GET', path, { token: mallory.token })
      check(answer.status === 403 || answer.status === 404, `nobody reads ${what}`, answer)
    }
    for (const [path, body, what] of [
      [`/log/${room}/snapshot`, { uptoSeq: 1, epoch: 0, data: b64(32) }, "compacts someone else's note"],
      [`/log/${room}/purge`, {}, "purges someone else's note"],
      [`/log/${room}/rewrite`, { replacement: hexId(), lockId: hexId(), headSeq: 1, epoch: 0, frames: [], snapshots: [], keys: {} }, "rewrites someone else's note"],
      [`/log/${room}/start`, { uptoSeq: 1, epoch: 0, data: b64(32) }, "plants a starting point in someone else's note"],
      [`/log/${room}/import`, { frames: [{ epoch: 0, data: b64(16) }] }, "imports into someone else's note"],
      [`/shares`, { docId, account: mallory.id, role: 'write', withHistory: true, keys: { '0': b64(100) }, title: b64(20) }, "shares someone else's note"],
      [`/shares/revoke`, { docId, account: bob.id, rotation: { epoch: 1, keys: {} } }, "revokes in someone else's note"],
      [`/shares/rotate`, { docId, rotation: { epoch: 1, keys: {} } }, "moves someone else's note to a new epoch"],
      [`/shares/role`, { docId, account: mallory.id, role: 'write' }, "gives itself a role in someone else's note"],
      [`/shares/accept`, { docId, vaultId: mallory.vaultId }, "accepts a note never shared with it"],
      [`/keys/${room}/reseal`, { keys: { [mallory.id]: { '0': b64(100) } } }, "seals itself a key of someone else's note"],
      [`/vaults/${alice.vaultId}/lock`, { kind: 'rollback', sealed: b64(32) }, "locks someone else's vault"],
      [`/vaults/${alice.vaultId}/lock/break`, {}, "lifts someone else's vault lock"],
      [`/blobs/${alice.id}/${alice.vaultId}/purge`, { ids: [hexId()] }, "deletes someone else's files"],
      [`/blobs/${alice.id}/${alice.vaultId}/have`, { ids: [hexId()] }, "asks which files someone else has"]
    ] as const) {
      const answer = await call(base, 'POST', path, { token: mallory.token, body })
      check(answer.status >= 400 && answer.status < 500 && answer.status !== 413, `nobody ${what}`, answer)
    }
    const put = await call(base, 'PUT', `/blobs/${alice.id}/${alice.vaultId}/${hexId()}/0?count=1`, {
      token: mallory.token,
      raw: new Uint8Array(100),
      headers: { 'content-type': 'application/octet-stream' }
    })
    check(put.status === 403, "nobody uploads into someone else's file store", put)
    const attach = await call(base, 'POST', `/log/doc:${hexId()}/attachments`, {
      token: mallory.token,
      body: { attach: [{ account: alice.id, vault: alice.vaultId, blob: hexId() }] }
    })
    check(attach.status >= 400, "nobody names someone else's file in a note to read it", attach)

    // A vault id learned - from a backup server, a device's log - must not let
    // another account open a socket of that id and claim the vault's index
    // room before its owner's first device did.
    const claimed = await call(base, 'POST', '/vaults', { token: mallory.token, body: { vaultId: alice.vaultId, sealedName: b64(32), wrappedKey: b64(48) } })
    check(claimed.status === 409, "nobody registers someone else's vault id as its own", claimed)
    const foreign = await openVault(ws, mallory, alice.vaultId).catch(() => null)
    if (foreign) {
      foreign.subscribe(`idx:${alice.vaultId}`)
      const index = await foreign.answer(`idx:${alice.vaultId}`)
      check(index?.type !== MUX.caughtUp, "someone else's vault index stays closed", index)
      foreign.close()
    } else {
      check(true, "someone else's vault index stays closed")
    }
    const socket = await openVault(ws, mallory)
    socket.subscribe(`idx:${alice.vaultId}`)
    const index = await socket.answer(`idx:${alice.vaultId}`)
    check(index?.type === MUX.denied, "nor does a vault's socket carry another vault's index", index)
    socket.subscribe(room, false)
    const note = await socket.answer(room)
    check(note?.type === MUX.denied, "and someone else's note too", note)
    socket.push(room, 9, 0, new TextEncoder().encode('forged'))
    const pushed = await socket.next(MUX.denied, room)
    check(pushed !== null, "nobody writes into someone else's note", pushed)
    socket.close()

    const stranger = await Socket.open(`${ws}/vault/${alice.vaultId}?token=${encodeURIComponent('not-a-token')}`)
    const closed = await stranger.whenClosed()
    check(closed?.code === 4401, 'a vault socket without a valid token is closed as signed out', closed)
    const forged = await Socket.open(`${ws}/vault/${alice.vaultId}`, socketProtocols('not-a-token'))
    const forgedClosed = await forged.whenClosed()
    check(forgedClosed?.code === 4401, 'and so is one naming an invalid token as its subprotocol', forgedClosed)

    // A reverse proxy writes every URL into its access log: a token in the URL
    // (until 0.9.9) signed in as its account for whoever reads that log.
    const own = await openVault(ws, alice)
    own.subscribe(`idx:${alice.vaultId}`)
    const caught = await own.answer(`idx:${alice.vaultId}`)
    check(caught?.type === MUX.caughtUp && own.protocol === WS_PROTOCOL, 'a device signs in with its token among the subprotocols, not in the URL', { caught, protocol: own.protocol })
    own.close()
    const relay = await Socket.open(`${ws}/relay`, socketProtocols(alice.token))
    await delay(200)
    check(relay.closed === null && relay.protocol === WS_PROTOCOL, "and the relay takes a device's token the same way", relay.closed)
    relay.close()
  }

  // ===============================================================================
  // 5. Names on the disk: every id that becomes a path is checked.
  // ===============================================================================
  {
    for (const path of [
      `/blobs/${alice.id}/${alice.vaultId}/..%2F..%2F..%2Faccounts.json`,
      `/blobs/${alice.id}/${alice.vaultId}/..%2F..%2F..%2Faccounts/0`,
      `/blobs/..%2F..%2F/${alice.vaultId}/${hexId()}?room=${encodeURIComponent(alicesNote.room)}`,
      `/log/doc:..%2F..%2Faccounts.json`,
      `/keys/..%2F..%2F..%2Faccounts.json`,
      `/forks/..%2F..%2Faccounts`,
      `/folders/..%2F..%2Faccounts`
    ]) {
      const answer = await call(base, 'GET', path, { token: alice.token })
      check(answer.status >= 400 && answer.status < 500 && !JSON.stringify(answer.body).includes('loginHash'), `no file outside the store through ${path}`, answer)
    }
    const socket = await openVault(ws, alice)
    for (const room of ['doc:../../accounts', 'doc:', 'idx:../x', 'fld:%2e%2e', 'nonsense']) {
      socket.subscribe(room)
      const answer = await socket.answer(room)
      check(answer?.type === MUX.denied, `no room named ${room}`, answer)
    }
    socket.close()
  }

  // ===============================================================================
  // 6. Contacts and shares: what a contact sends is bounded.
  // ===============================================================================
  {
    // Every code made rewrote contacts.json whole; nothing limited how many.
    let limited = false
    for (let index = 0; index < 60; index += 1) {
      const answer = await call(base, 'POST', '/contacts/codes', {
        token: mallory.token,
        body: { codeId: hexId(), redeemHash: randomBytes(32).toString('hex'), expiresAt: Date.now() + 60_000 }
      })
      if (answer.status !== 200) {
        limited = answer.status === 429 || answer.status === 409
        break
      }
    }
    check(limited, 'nobody makes friend codes without end')

    // A code's creator could answer its redemption again and again, 64 MiB at
    // a time: contacts.json grew past what the server can read back, and
    // contacts and shares stopped working for everyone.
    const codeId = await pair(base, bob, mallory).catch(() => null)
    if (codeId === null) {
      // Mallory's codes are used up; Bob makes this one.
      check(false, 'pairing for the next checks failed')
    } else {
      const huge = await call(base, 'POST', '/contacts/reply', { token: bob.token, body: { to: mallory.id, codeId, sealed: 'A'.repeat(1024 * 1024) } })
      check(huge.status >= 400 && huge.status < 500, 'an answer to a friend code is no megabyte', huge)
      for (let index = 0; index < 5; index += 1) {
        await call(base, 'POST', '/contacts/reply', { token: bob.token, body: { to: mallory.id, codeId, sealed: b64(300) } })
      }
      const inbox = await call(base, 'GET', '/contacts/inbox', { token: mallory.token })
      const replies = ((inbox.body.items as Array<{ codeId: string }>) ?? []).filter((item) => item.codeId === codeId)
      check(replies.length <= 1, "answering a redemption again replaces the answer, it does not pile up", replies.length)

      const codeForHuge = hexId()
      const redeemKey = randomBytes(32)
      await call(base, 'POST', '/contacts/codes', {
        token: alice.token,
        body: { codeId: codeForHuge, redeemHash: createHash('sha256').update(redeemKey).digest('hex'), expiresAt: Date.now() + 60_000 }
      })
      const redeemed = await call(base, 'POST', '/contacts/redeem', {
        token: mallory.token,
        body: { codeId: codeForHuge, redeemKey: redeemKey.toString('base64'), sealed: 'A'.repeat(1024 * 1024) }
      })
      check(redeemed.status >= 400 && redeemed.status < 500, 'a redemption carries no megabyte', redeemed)
    }

    // Bob shares a note with Mallory; Mallory is the contact who misbehaves.
    await pair(base, alice, bob).catch(() => undefined)
    const bobsNote = await noteOf(ws, bob)
    const share = (overrides: Record<string, unknown>): Promise<Answer> =>
      call(base, 'POST', '/shares', {
        token: bob.token,
        body: { docId: bobsNote.docId, account: mallory.id, role: 'read', withHistory: true, keys: { '0': b64(200) }, title: b64(60), ...overrides }
      })
    const hugeTitle = await share({ title: 'A'.repeat(1024 * 1024) })
    check(hugeTitle.status === 400 || hugeTitle.status === 413, "a share's title is no megabyte - it lands in every list of incoming shares", hugeTitle)
    const hugeKey = await share({ keys: { '0': 'A'.repeat(1024 * 1024) } })
    check(hugeKey.status === 400 || hugeKey.status === 413, 'a sealed key is no megabyte', hugeKey)
    const extraKeys = await share({ keys: Object.fromEntries(Array.from({ length: 5000 }, (_, epoch) => [String(epoch), b64(200)])) })
    check(extraKeys.status === 400, 'a share seals no keys of epochs the note never had', extraKeys)
    check((await share({})).status === 200, 'an ordinary share goes through')

    // Mallory can read Bob's note; writing into it is refused.
    const socket = await openVault(ws, mallory)
    socket.subscribe(bobsNote.room, false)
    const ready = await socket.answer(bobsNote.room)
    check(ready?.type === MUX.caughtUp, 'the reader reads the note it was given', ready)
    socket.push(bobsNote.room, 1, 0, new TextEncoder().encode('a reader writing'))
    const refused = await socket.next(MUX.denied, bobsNote.room)
    check(refused?.text === 'read-only', 'a reader writes nothing into it', refused)
    socket.close()

    // A writer may attach blobs of its own to a note; never without end - the
    // note's metadata is rewritten whole on every change.
    await share({ role: 'write' })
    const many = Array.from({ length: 5000 }, () => ({ account: mallory.id, vault: mallory.vaultId, blob: hexId() }))
    const attached = await call(base, 'POST', `/log/${bobsNote.room}/attachments`, { token: mallory.token, body: { attach: many } })
    check(attached.status === 400 || attached.status === 413, "a writer cannot pile thousands of attachments onto someone's note", attached)
  }

  // ===============================================================================
  // 7. Frames: a frame of hundreds of megabytes is no frame.
  // ===============================================================================
  {
    const socket = await openVault(ws, alice)
    socket.subscribe(alicesNote.room)
    await socket.answer(alicesNote.room)
    socket.push(alicesNote.room, 2, 0, new Uint8Array(40 * 1024 * 1024))
    const closed = await socket.whenClosed(10_000)
    check(closed?.code === 1009, 'a frame of 40 MiB ends the connection instead of being stored', closed)
    const log = await call(base, 'GET', `/log/${alicesNote.room}`, { token: alice.token })
    const frames = (log.body.frames as unknown[] | undefined) ?? []
    check(frames.length === 1, 'and nothing of it is in the log', frames.length)
  }

  // ===============================================================================
  // 8. Storage: the quota covers the rooms an account makes, not only its files.
  // ===============================================================================
  {
    // MYCEL_QUOTA_MB covered attachments alone: with open registration a
    // stranger filled the disk with notes, or with empty rooms by the million.
    const limited = await serve('quota', { MYCEL_QUOTA_MB: '1' })
    servers.push(limited.server)
    const filler = await register(limited.base)
    const socket = await openVault(limited.ws, filler)
    const room = `doc:${hexId()}`
    socket.subscribe(room)
    await socket.answer(room)
    let acked = 0
    let full: Incoming | null = null
    for (let ref = 1; ref <= 12 && !full; ref += 1) {
      socket.push(room, ref, 0, new Uint8Array(200 * 1024))
      const answer = await socket.nextOf([MUX.ack, MUX.full], room)
      if (answer?.type === MUX.ack) acked += 1
      else full = answer
    }
    check(full !== null && acked >= 3 && acked <= 5, 'frames past the quota are refused as full, and kept by the device', { acked, full })
    // Filled up to the last few kilobytes: no room for another room either.
    for (let ref = 100; ref < 400; ref += 1) {
      socket.push(room, ref, 0, new Uint8Array(2 * 1024))
      if ((await socket.nextOf([MUX.ack, MUX.full], room))?.type !== MUX.ack) break
    }
    const another = `doc:${hexId()}`
    socket.subscribe(another)
    const refused = await socket.answer(another)
    check(refused?.type === MUX.denied && refused.text === 'full', 'and so is a new room', refused)
    const usage = await call(limited.base, 'GET', `/blobs/${filler.id}/usage`, { token: filler.token })
    check(typeof usage.body.roomBytes === 'number' && (usage.body.roomBytes as number) > 600 * 1024, 'the account sees what its rooms take', usage.body)
    socket.close()
  }

  alicesNote.socket.close()
} catch (error) {
  console.error(error)
  failures.push(`the test itself failed: ${String(error)}`)
} finally {
  for (const running of servers) await running.close().catch(() => undefined)
  rmSync(root, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed:`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log('\nevery attack tried here was refused')
process.exit(0)
