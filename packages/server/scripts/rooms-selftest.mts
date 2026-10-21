// The server's room layer and accounts, in-process against a scratch
// directory: no network, no port, nothing near the real data. Frames here are
// arbitrary bytes - the server treats them as opaque, which is the point.
//
//   npm run test:rooms
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT } from 'jose'
import { BLOB_CHUNK_BYTES, BLOB_CHUNK_OVERHEAD, CLOSE_SIGNED_OUT, type Notice, type NotifyKind } from '@obsidian-connect/shared'
import { AccountStore, sessionOf, type StoredAccount } from '../src/accounts.js'
import { TokenService } from '../src/auth.js'
import { BlobStore } from '../src/blobs.js'
import { ContactStore } from '../src/contacts.js'
import { loadConfig, loadEnvFile } from '../src/config.js'
import { createHttpApp } from '../src/http.js'
import { ForkStore } from '../src/forks.js'
import { AddressGuard, paced } from '../src/throttle.js'
import { totpCode } from '../src/totp.js'
import type { Frame } from '../src/log.js'
import { Relay } from '../src/relay.js'
import { HubError, RoomHub, type RoomClient } from '../src/rooms.js'

const failures: string[] = []
function check(ok: boolean, label: string, detail?: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`)
  if (!ok) {
    failures.push(label)
    if (detail !== undefined) console.log('      got:', JSON.stringify(detail))
  }
}

async function status(task: () => Promise<unknown>): Promise<number> {
  try {
    await task()
    return 200
  } catch (error) {
    return error instanceof HubError || (error as { status?: number }).status ? ((error as { status: number }).status ?? 500) : 500
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const b64 = (length: number): string => randomBytes(length).toString('base64')
const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text))
const text = (data: Uint8Array | string): string => (typeof data === 'string' ? data : Buffer.from(data).toString())
const hexId = (): string => randomBytes(16).toString('hex')

interface Message {
  type: string
  room?: string
  seq?: number
  epoch?: number
  ref?: number
  uptoSeq?: number
  headSeq?: number
  data?: string
  reason?: string
  kind?: string
  code?: number
}

class Client implements RoomClient {
  messages: Message[] = []

  constructor(
    readonly account: string,
    readonly vaultId: string
  ) {}

  sendFrame(room: string, frame: Frame): void {
    this.messages.push({ type: 'frame', room, seq: frame.seq, epoch: frame.epoch, data: text(frame.data) })
  }
  sendSnapshot(room: string, uptoSeq: number, epoch: number, data: Uint8Array): void {
    this.messages.push({ type: 'snapshot', room, uptoSeq, epoch, data: text(data) })
  }
  sendCaughtUp(room: string, headSeq: number, epoch: number): void {
    this.messages.push({ type: 'caughtUp', room, headSeq, epoch })
  }
  sendAck(room: string, ref: number, seq: number): void {
    this.messages.push({ type: 'ack', room, ref, seq })
  }
  sendAwareness(room: string, epoch: number, data: Uint8Array): void {
    this.messages.push({ type: 'awareness', room, epoch, data: text(data) })
  }
  sendRekey(room: string, epoch: number): void {
    this.messages.push({ type: 'rekey', room, epoch })
  }
  sendRevoked(room: string, reason: string): void {
    this.messages.push({ type: 'revoked', room, reason })
  }
  sendDenied(room: string, reason: string): void {
    this.messages.push({ type: 'denied', room, reason })
  }
  sendNotify(kind: NotifyKind, _payload: Notice): void {
    this.messages.push({ type: 'notify', kind })
  }
  close(code: number, reason: string): void {
    this.messages.push({ type: 'close', code, reason })
  }

  take(): Message[] {
    const taken = this.messages
    this.messages = []
    return taken
  }
}

const dataDir = mkdtempSync(join(tmpdir(), 'oc-rooms-selftest-'))

try {
  // --- .env ------------------------------------------------------------------
  // Written the way Windows PowerShell 5.1 writes UTF-8: byte order mark, CRLF.
  {
    const envFile = join(dataDir, 'probe.env')
    writeFileSync(envFile, `${String.fromCharCode(0xfeff)}OC_PROBE_FIRST=open\r\nOC_PROBE_SET=from-file\r\n`)
    process.env.OC_PROBE_SET = 'from-shell'
    check(loadEnvFile(envFile) === envFile, 'the .env is read')
    check(process.env.OC_PROBE_FIRST === 'open', 'including its first line, behind a byte order mark', process.env.OC_PROBE_FIRST)
    check(process.env.OC_PROBE_SET === 'from-shell', 'and what the shell set wins over it', process.env.OC_PROBE_SET)
    check(loadEnvFile(join(dataDir, 'missing.env')) === null, 'no .env is no error')
  }

  // --- guessing online ---------------------------------------------------------
  {
    const started = Date.now()
    await paced(async () => 1, 200)
    check(Date.now() - started >= 190, 'a sign-in answers only after its full time')
    const failedAt = Date.now()
    await paced(async () => Promise.reject(new Error('wrong')), 200).catch(() => undefined)
    check(Date.now() - failedAt >= 190, 'and a failed one takes just as long')
    const guard = new AddressGuard(3, 60_000, 60_000)
    guard.failed('192.0.2.1')
    guard.failed('192.0.2.1')
    check(!guard.blocked('192.0.2.1'), 'a few failures do not block')
    guard.failed('192.0.2.1')
    check(guard.blocked('192.0.2.1') && !guard.blocked('192.0.2.2'), 'repeated failures block that address, and only that one')
  }

  // --- accounts --------------------------------------------------------------
  // The server knows no names: accounts are random ids, found by the hash of a
  // login key the device derived from name and password together.
  const accounts = new AccountStore(dataDir)
  const keyMaterial = () => ({
    loginKey: b64(32),
    kdfVersion: 1,
    publicKey: b64(65),
    wrappedPrivateKey: b64(64),
    wrappedAccountSecret: b64(48)
  })

  const serverId = await accounts.serverId()
  check(
    /^[0-9a-f]{32}$/.test(serverId) && (await new AccountStore(dataDir).serverId()) === serverId,
    'the server has one random id, kept with its data'
  )

  const aliceKeys = keyMaterial()
  const aliceAccount = await accounts.register(aliceKeys, 'open')
  check(/^[0-9a-f]{32}$/.test(aliceAccount.accountId), 'open registration creates an account with a random id')
  check(
    (await status(() => accounts.register({ ...keyMaterial(), loginKey: aliceKeys.loginKey }, 'open'))) === 409,
    'the same name and password cannot make a second account'
  )
  check((await status(() => accounts.register(keyMaterial(), 'invite'))) === 403, 'without an invite, invite-only registration refuses')
  const code = await accounts.invite()
  check((await status(() => accounts.register({ ...keyMaterial(), invite: 'nope' }, 'invite'))) === 403, 'a wrong invite code is refused')
  const carolAccount = await accounts.register({ ...keyMaterial(), invite: code }, 'invite')
  check(/^[0-9a-f]{32}$/.test(carolAccount.accountId), 'an invite code creates an account')
  check((await status(() => accounts.register({ ...keyMaterial(), invite: code }, 'invite'))) === 403, 'and only one')
  const bobAccount = await accounts.register(keyMaterial(), 'open')
  const daveAccount = await accounts.register(keyMaterial(), 'open')

  check((await accounts.login(aliceKeys.loginKey))?.accountId === aliceAccount.accountId, 'the right login key finds the account')
  check((await accounts.login(b64(32))) === null, 'any other finds nothing')

  const alice = aliceAccount.accountId
  const bob = bobAccount.accountId
  const carol = carolAccount.accountId
  const dave = daveAccount.accountId

  const aliceVaultId = hexId()
  const firstKey = b64(48)
  const aliceVault = await accounts.addVault(alice, aliceVaultId, b64(32), firstKey)
  const again = await accounts.addVault(alice, aliceVaultId, b64(32), b64(48))
  check(again.vaultId === aliceVault.vaultId && again.wrappedKey === firstKey, 'a vault is created once; the second device gets its key')
  const bobVault = await accounts.addVault(bob, hexId(), b64(32), b64(48))
  const carolVault = await accounts.addVault(carol, hexId(), b64(32), b64(48))

  // A password change replaces the account's wrapped keys. A token alone - it
  // travels in the socket URL - must not be enough to do that.
  {
    const newLoginKey = b64(32)
    const change = (loginKey: string): Promise<unknown> =>
      accounts.changePassword(alice, { loginKey, newLoginKey, kdfVersion: 1, wrappedPrivateKey: b64(64), wrappedAccountSecret: b64(48) })
    check((await status(() => change(b64(32)))) === 403, 'a password change needs the current password')
    await change(aliceKeys.loginKey)
    check(
      (await accounts.login(newLoginKey))?.accountId === alice && (await accounts.login(aliceKeys.loginKey)) === null,
      'afterwards the new password logs in and the old one does not'
    )
  }

  // A recovery code alone finds its account and sets a new name and password;
  // using it spends it.
  {
    const record = (recoveryKey = b64(32)) => ({ recoveryKey, wrappedPrivateKey: b64(64), wrappedAccountSecret: b64(48) })
    const found = async (recoveryKey: string): Promise<string | undefined> => (await accounts.findByRecovery(recoveryKey))?.accountId
    const first = b64(32)
    const frankKeys = keyMaterial()
    const frank = (await accounts.register({ ...frankKeys, recovery: record(first) }, 'open')).accountId
    const frankNow = async (): Promise<StoredAccount> => (await accounts.get(frank)) as StoredAccount
    check((await found(first)) === frank, 'an account made with a recovery code is found by it alone')
    check(accounts.bundle(await frankNow()).recovery?.createdAt !== undefined, 'and its bundle says it has one')
    check((await found(b64(32))) === undefined, 'any other code finds nothing')
    check((await status(() => accounts.register({ ...keyMaterial(), recovery: record(first) }, 'open'))) === 409, 'nobody registers with a code in use')
    check(accounts.bundle((await accounts.get(bob)) as StoredAccount).recovery === null, 'an account without one says so')

    check((await status(() => accounts.setRecovery(frank, b64(32), record()))) === 403, 'making a new code needs the password, not only a token')
    const second = b64(32)
    await accounts.setRecovery(frank, frankKeys.loginKey, record(second))
    check((await found(first)) === undefined && (await found(second)) === frank, 'a new code replaces the old one at once')

    const ginaKeys = keyMaterial()
    await accounts.register(ginaKeys, 'open')
    const newLoginKey = b64(32)
    const third = b64(32)
    const commit = (recoveryKey: string, login = newLoginKey, next = third): Promise<StoredAccount | null> =>
      accounts.recover({ recoveryKey, newLoginKey: login, kdfVersion: 1, wrappedPrivateKey: b64(64), wrappedAccountSecret: b64(48), recovery: record(next) })
    const before = sessionOf(await frankNow())
    check((await commit(b64(32))) === null, 'an unknown code recovers nothing')
    check((await status(() => commit(second, ginaKeys.loginKey))) === 409, 'a name and password another account has are refused')
    check((await status(() => commit(second, newLoginKey, second))) === 409, 'the code cannot stay as it was: using it spends it')
    check((await found(second)) === frank && (await accounts.login(frankKeys.loginKey))?.accountId === frank, 'refusals change nothing')
    const recovered = await commit(second)
    check(
      recovered?.accountId === frank && (await accounts.login(newLoginKey))?.accountId === frank && (await accounts.login(frankKeys.loginKey)) === null,
      'the code sets a new password, and the old one no longer signs in'
    )
    check(sessionOf(await frankNow()) === before + 1, 'every device signed in so far is signed out')
    check((await found(second)) === undefined && (await found(third)) === frank, 'the code used is spent, the new one works')
    check((await status(() => accounts.setRecovery(frank, frankKeys.loginKey, null))) === 403, 'deleting the code needs the current password')
    await accounts.setRecovery(frank, newLoginKey, null)
    check((await found(third)) === undefined && accounts.bundle(await frankNow()).recovery === null, 'and leaves none')
  }

  // --- two-factor sign-in ----------------------------------------------------------
  {
    // RFC 6238, appendix B, SHA-1: the last six of its eight digits.
    const rfc = Buffer.from('12345678901234567890')
    const vectors: Array<[number, string]> = [
      [59, '287082'],
      [1_111_111_109, '081804'],
      [1_111_111_111, '050471'],
      [1_234_567_890, '005924'],
      [2_000_000_000, '279037'],
      [20_000_000_000, '353130']
    ]
    check(
      vectors.every(([seconds, code]) => totpCode(rfc, Math.floor(seconds / 30)) === code),
      "the server's codes match RFC 6238's test vectors",
      vectors.map(([seconds]) => totpCode(rfc, Math.floor(seconds / 30)))
    )

    const t0 = 1_800_000_000_000
    const secret = randomBytes(20)
    const codeAt = (ms: number, offset = 0): string => totpCode(secret, Math.floor(ms / 30_000) + offset)
    const henKeys = keyMaterial()
    const hen = (await accounts.register({ ...henKeys, recovery: { recoveryKey: b64(32), wrappedPrivateKey: b64(64), wrappedAccountSecret: b64(48) } }, 'open')).accountId
    const henNow = async (): Promise<StoredAccount> => (await accounts.get(hen)) as StoredAccount
    const enable = (loginKey: string, code: string, at = t0): Promise<unknown> => accounts.enableTotp(hen, loginKey, secret.toString('base64'), code, at)
    check((await status(() => enable(b64(32), codeAt(t0)))) === 403, 'turning it on needs the password, not only a token')
    check((await status(() => enable(henKeys.loginKey, codeAt(t0 + 120_000)))) === 403, 'and a code the app made from that secret, now')
    const before = sessionOf(await henNow())
    await enable(henKeys.loginKey, codeAt(t0))
    check(accounts.bundle(await henNow()).totp === true && sessionOf(await henNow()) === before + 1, 'then it is on, and every other device signed out')
    check((await status(() => enable(henKeys.loginKey, codeAt(t0, 1)))) === 409, 'turning it on twice is refused')
    check((await accounts.checkTotp(hen, codeAt(t0), t0)) === false, 'the code used to turn it on is spent')
    check((await accounts.checkTotp(hen, codeAt(t0 + 30_000), t0 + 30_000)) === true, "the next step's code signs in")
    check((await accounts.checkTotp(hen, codeAt(t0 + 30_000), t0 + 30_000)) === false, 'once: the same code again is refused')
    check((await accounts.checkTotp(hen, codeAt(t0 + 60_000, -1), t0 + 60_000)) === false, 'and so is any step before it')
    check((await accounts.checkTotp(hen, codeAt(t0 + 90_000, 1), t0 + 90_000)) === true, 'a clock a step ahead is allowed')
    check((await accounts.checkTotp(hen, codeAt(t0 + 300_000, 3), t0 + 300_000)) === false, 'three steps off is not')
    check((await accounts.checkTotp(bob, '123456', t0)) === null, 'an account without it has no code to check')
    check((await status(() => accounts.disableTotp(hen, b64(32)))) === 403, 'turning it off needs the password')
    await accounts.disableTotp(hen, henKeys.loginKey)
    check(accounts.bundle(await henNow()).totp === false, 'and nothing else - a lost phone is what it is for')

    await enable(henKeys.loginKey, codeAt(t0 + 600_000), t0 + 600_000)
    check((await accounts.turnOffTotp(hen)) && accounts.bundle(await henNow()).totp === false, 'the admin can turn it off')
    check(!(await accounts.turnOffTotp(hen)), 'and says when there was nothing to turn off')

    await enable(henKeys.loginKey, codeAt(t0 + 900_000), t0 + 900_000)
    let recoveryKey = b64(32)
    await accounts.setRecovery(hen, henKeys.loginKey, { recoveryKey, wrappedPrivateKey: b64(64), wrappedAccountSecret: b64(48) })
    const recoverHen = async (totpCode: string | undefined, at: number): Promise<StoredAccount | null> => {
      const next = b64(32)
      const account = await accounts.recover(
        {
          recoveryKey,
          newLoginKey: b64(32),
          kdfVersion: 1,
          wrappedPrivateKey: b64(64),
          wrappedAccountSecret: b64(48),
          recovery: { recoveryKey: next, wrappedPrivateKey: b64(64), wrappedAccountSecret: b64(48) },
          totpCode
        },
        at
      )
      recoveryKey = next
      return account
    }
    const t1 = t0 + 930_000
    const loginBefore = (await henNow()).loginHash
    check((await status(() => recoverHen(codeAt(t1, 5), t1))) === 401, 'a wrong code to keep two-factor sign-in through a recovery is refused')
    check(
      (await henNow()).loginHash === loginBefore && accounts.bundle(await henNow()).totp === true && (await accounts.findByRecovery(recoveryKey))?.accountId === hen,
      'and changes nothing: the recovery code is not spent'
    )
    const generation = sessionOf(await henNow())
    await recoverHen(codeAt(t1), t1)
    check(
      accounts.bundle(await henNow()).totp === true && (await henNow()).loginHash !== loginBefore && sessionOf(await henNow()) === generation + 1,
      'the right one recovers and keeps it, and still signs out every other device'
    )
    check((await accounts.checkTotp(hen, codeAt(t1), t1)) === false, 'that code is spent')
    check((await accounts.checkTotp(hen, codeAt(t1 + 30_000), t1 + 30_000)) === true, "and the same app's next one signs in")
    await recoverHen(undefined, t1 + 60_000)
    check(accounts.bundle(await henNow()).totp === false, 'without a code a recovery turns it off: a lost phone is a reason to use the code')
  }

  // --- contacts ----------------------------------------------------------------
  const contacts = new ContactStore(dataDir)
  {
    const secretKey = randomBytes(32)
    const redeemHash = createHash('sha256').update(secretKey).digest('hex')
    const codeId = hexId()
    await contacts.addCode(alice, codeId, redeemHash, Date.now() + 60_000)
    check((await contacts.codeOwner(codeId)) === alice, 'a code tells its holder whose it is')
    check(
      (await status(() => contacts.redeem(dave, codeId, randomBytes(32).toString('base64'), 'sealed'))) === 403,
      'a redemption without the right key is refused'
    )
    check((await status(() => contacts.redeem(alice, codeId, secretKey.toString('base64'), 'sealed'))) === 400, 'nobody redeems their own code')
    check((await contacts.redeem(dave, codeId, secretKey.toString('base64'), 'sealed-for-alice')) === alice, 'the right key redeems it')
    check(await contacts.connected(alice, dave), 'and the two are contacts')
    const inbox = await contacts.inbox(alice)
    check(inbox.length === 1 && inbox[0]?.from === dave && inbox[0].sealed === 'sealed-for-alice', "the creator finds the redeemer's message")
    check(
      (await status(() => contacts.redeem(bob, codeId, secretKey.toString('base64'), 'sealed'))) === 403,
      'a code works once'
    )
    check((await status(() => contacts.reply(alice, bob, codeId, 'sealed'))) === 403, 'the answer goes only to who redeemed it')
    await contacts.reply(alice, dave, codeId, 'sealed-for-dave')
    check((await contacts.inbox(dave))[0]?.sealed === 'sealed-for-dave', 'and reaches them')
    await contacts.done(alice, inbox.map((item) => item.id))
    check((await contacts.inbox(alice)).length === 0, 'handled messages are gone')

    const late = hexId()
    const lateKey = randomBytes(32)
    await contacts.addCode(alice, late, createHash('sha256').update(lateKey).digest('hex'), Date.now() + 60_000)
    check(
      (await status(() => contacts.redeem(bob, late, lateKey.toString('base64'), 'sealed', Date.now() + 8 * 24 * 60 * 60 * 1000))) === 403,
      'a code expires after at most seven days'
    )
    const taken = hexId()
    const takenKey = randomBytes(32)
    await contacts.addCode(alice, taken, createHash('sha256').update(takenKey).digest('hex'), Date.now() + 60_000)
    await contacts.revokeCode(bob, taken)
    check((await contacts.codeOwner(taken)) === alice, "nobody takes back someone else's code")
    await contacts.revokeCode(alice, taken)
    check(
      (await status(() => contacts.redeem(bob, taken, takenKey.toString('base64'), 'sealed'))) === 403,
      'a code its creator took back can no longer be redeemed'
    )
    check(await contacts.unpair(alice, dave), 'contacts can part')
    check(!(await contacts.connected(alice, dave)), 'and are no longer connected')
  }
  await contacts.pair(alice, bob)
  await contacts.pair(alice, carol)

  // --- blobs: the encrypted contents of attachments -------------------------------------
  {
    const CHUNK = BLOB_CHUNK_BYTES + BLOB_CHUNK_OVERHEAD
    const full = (fill: number): Uint8Array => new Uint8Array(CHUNK).fill(fill)
    const tail = new Uint8Array(BLOB_CHUNK_OVERHEAD + 10).fill(9)
    const vault = aliceVault.vaultId
    const store = new BlobStore(dataDir, { maxFileBytes: 3 * BLOB_CHUNK_BYTES, quotaBytes: null, purgeGraceMs: 0 })
    const id = hexId()

    check((await store.info(alice, vault, id)) === null, 'a blob nobody uploaded does not exist')
    check((await status(() => store.putChunk(alice, vault, id, 1, 3, full(1)))) === 409, 'an upload starts with its first chunk')
    await store.putChunk(alice, vault, id, 0, 3, full(1))
    const resent = await store.putChunk(alice, vault, id, 0, 3, full(1))
    check(resent.received === 1 && !resent.complete, 'a chunk sent twice is taken once', resent)
    check((await status(() => store.putChunk(alice, vault, id, 2, 3, tail))) === 409, 'chunks arrive in order')
    check((await status(() => store.putChunk(alice, vault, id, 1, 3, tail))) === 400, 'every chunk but the last is full')
    check((await store.have(alice, vault, [id])).length === 0, 'a blob does not exist before its last chunk')

    // The server restarts in the middle of an upload.
    const again = new BlobStore(dataDir, store.limits)
    check((await again.info(alice, vault, id))?.received === 1, 'an upload survives a restart and says how far it got')
    await again.putChunk(alice, vault, id, 1, 3, full(2))
    const done = await again.putChunk(alice, vault, id, 2, 3, tail)
    check(done.complete && done.size === 2 * CHUNK + tail.length, 'the last chunk completes it', done)
    check((await again.have(alice, vault, [id, hexId()])).join() === id, 'the server says which blobs it has')
    const middle = await again.readChunk(alice, vault, id, 1)
    check(middle.length === CHUNK && middle.every((byte) => byte === 2), 'and hands out each chunk as it was stored')
    check((await again.readChunk(alice, vault, id, 2)).length === tail.length, 'the last one shorter')
    check((await again.putChunk(alice, vault, id, 0, 3, full(7))).complete, 'uploading a blob it has is answered at once')
    check((await again.readChunk(alice, vault, id, 0)).every((byte) => byte === 1), 'and changes nothing')
    check(existsSync(join(dataDir, 'users', alice, vault, 'blobs', id)), "blobs live in their owner's vault folder")
    check((await status(() => again.putChunk(alice, vault, hexId(), 0, 4, full(1)))) === 413, 'a file over the limit is refused at its first chunk')

    const tight = new BlobStore(dataDir, { maxFileBytes: 3 * BLOB_CHUNK_BYTES, quotaBytes: 3 * CHUNK, purgeGraceMs: 0 })
    check((await status(() => tight.putChunk(alice, vault, hexId(), 0, 2, full(3)))) === 507, 'an account that used up its storage can add no more')
    check((await status(() => tight.putChunk(bob, bobVault.vaultId, hexId(), 0, 1, tail))) === 200, 'while another account still can')

    // Over HTTP: raw chunks, and nobody in someone else's store.
    const tokens = new TokenService('rooms-selftest', 3_600)
    const httpHub = new RoomHub({ dataDir }, accounts, contacts, new ForkStore(dataDir))
    const app = createHttpApp(loadConfig({}), tokens, accounts, httpHub, contacts, again, { logger: false, paceMs: 0 })
    const auth = async (account: string): Promise<Record<string, string>> => {
      const stored = (await accounts.get(account)) as StoredAccount
      return { authorization: `Bearer ${(await tokens.issue(account, sessionOf(stored))).token}` }
    }
    const octets = { 'content-type': 'application/octet-stream' }
    const small = hexId()
    const put = await app.inject({
      method: 'PUT',
      url: `/blobs/${alice}/${vault}/${small}/0?count=1`,
      headers: { ...(await auth(alice)), ...octets },
      payload: Buffer.from(tail)
    })
    check(put.statusCode === 200 && (put.json() as { complete?: boolean }).complete === true, 'a chunk travels raw over HTTP', put.body)
    const got = await app.inject({ method: 'GET', url: `/blobs/${alice}/${vault}/${small}/0`, headers: await auth(alice) })
    check(got.statusCode === 200 && got.rawPayload.equals(Buffer.from(tail)), 'and comes back the same way')
    const peek = await app.inject({ method: 'GET', url: `/blobs/${alice}/${vault}/${small}/0`, headers: await auth(bob) })
    check(peek.statusCode === 403, "nobody reads another account's store")
    const plant = await app.inject({
      method: 'PUT',
      url: `/blobs/${bob}/${vault}/${hexId()}/0?count=1`,
      headers: { ...(await auth(bob)), ...octets },
      payload: Buffer.from(tail)
    })
    check(plant.statusCode === 403, 'nor writes into a vault that is not theirs')
    const have = await app.inject({ method: 'POST', url: `/blobs/${alice}/${vault}/have`, headers: await auth(alice), payload: { ids: [small, id] } })
    check((have.json() as { have?: string[] }).have?.length === 2, 'asking for several blobs at once', have.body)
    const config = await app.inject({ method: 'GET', url: '/auth/config' })
    check((config.json() as { maxFileBytes?: number }).maxFileBytes === again.limits.maxFileBytes, 'the server tells devices how large a file may be')
    const purge = await app.inject({ method: 'POST', url: `/blobs/${alice}/${vault}/purge`, headers: await auth(alice), payload: { ids: [id, hexId()] } })
    check((purge.json() as { purged?: string[] }).purged?.join() === id, 'purging answers what went', purge.body)
    check(
      (await again.info(alice, vault, id)) === null && !existsSync(join(dataDir, 'users', alice, vault, 'blobs', id)),
      'and the blob is gone'
    )
    const usage = await app.inject({ method: 'GET', url: `/blobs/${alice}/usage`, headers: await auth(alice) })
    check(
      (usage.json() as { bytes?: number }).bytes === (await again.usageOf(alice)) && (await again.usageOf(alice)) === tail.length,
      'the server tells an account how much it stores',
      usage.body
    )
    check(
      (await app.inject({ method: 'GET', url: `/blobs/${alice}/usage`, headers: await auth(bob) })).statusCode === 403,
      "and nobody else how much another account stores"
    )

    // A device uploads content the server has, and names it a moment later;
    // another device cleaning up just then must not delete it underneath.
    const careful = new BlobStore(dataDir, { ...again.limits, purgeGraceMs: 60_000 })
    const reused = hexId()
    await careful.putChunk(alice, vault, reused, 0, 1, tail)
    const soon = await careful.purge(alice, vault, [reused])
    check(soon.purged.length === 0 && soon.kept.join() === reused, 'a blob uploaded a moment ago is kept when asked to go', soon)
    const later = await careful.purge(alice, vault, [reused], Date.now() + 61_000)
    check(later.purged.join() === reused, 'and goes once its grace has passed', later)
    const named = hexId()
    await again.putChunk(alice, vault, named, 0, 1, tail)
    again.protect((_account, _vault, blob) => blob === named)
    check((await again.purge(alice, vault, [named])).kept.join() === named, 'a blob a shared note names is kept when asked to go')
    again.protect(() => false)
    await careful.putChunk(alice, vault, reused, 0, 1, tail)
    await delay(20)
    await careful.putChunk(alice, vault, reused, 0, 1, tail)
    const record = JSON.parse(readFileSync(join(dataDir, 'users', alice, vault, 'blobs', `${reused}.json`), 'utf8')) as {
      createdAt: number
      touchedAt: number
    }
    check(record.touchedAt > record.createdAt, 'uploading a blob it has restarts its grace', record)

    // Signing out the other devices: a password change moves the account's
    // session generation, and every token from before stops working - one
    // that signed in with a stolen password included.
    {
      const erinKeys = keyMaterial()
      const erin = (await accounts.register(erinKeys, 'open')).accountId
      const legacy = await new SignJWT({ scope: 'user' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(erin)
        .setIssuer('obsidian-connect')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode('rooms-selftest'))
      check(
        (await app.inject({ method: 'GET', url: '/account', headers: { authorization: `Bearer ${legacy}` } })).statusCode === 200,
        'a token from before generations still works: updating the server signs nobody out'
      )
      const before = await auth(erin)
      const otherDevice = new Client(erin, hexId())
      const bystander = new Client(bob, hexId())
      httpHub.attach(otherDevice)
      httpHub.attach(bystander)
      const erinLogin = b64(32)
      const changed = await app.inject({
        method: 'POST',
        url: '/auth/password',
        headers: before,
        payload: { loginKey: erinKeys.loginKey, newLoginKey: erinLogin, kdfVersion: 1, wrappedPrivateKey: b64(64), wrappedAccountSecret: b64(48) }
      })
      check(changed.statusCode === 200, 'the password is changed', changed.body)
      check((await app.inject({ method: 'GET', url: '/account', headers: before })).statusCode === 401, 'afterwards the token from before is refused')
      check((await app.inject({ method: 'POST', url: '/auth/refresh', headers: before })).statusCode === 401, 'and cannot be refreshed')
      check(
        (await app.inject({ method: 'GET', url: '/account', headers: { authorization: `Bearer ${legacy}` } })).statusCode === 401,
        'nor can one from before generations'
      )
      const fresh = { authorization: `Bearer ${(changed.json() as { token: string }).token}` }
      check((await app.inject({ method: 'GET', url: '/account', headers: fresh })).statusCode === 200, 'the device that changed it carries on with its new token')
      const refreshed = await app.inject({ method: 'POST', url: '/auth/refresh', headers: fresh })
      const renewed = { authorization: `Bearer ${(refreshed.json() as { token: string }).token}` }
      check((await app.inject({ method: 'GET', url: '/account', headers: renewed })).statusCode === 200, 'and refreshing it stays in the new generation')
      check(
        otherDevice.take().some((message) => message.type === 'close' && message.code === CLOSE_SIGNED_OUT),
        "the account's open connections are closed as signed out"
      )
      check(!bystander.take().some((message) => message.type === 'close'), "and nobody else's")

      // The recovery over HTTP: the code alone, guarded like a sign-in.
      check(((config.json() as { features?: string[] }).features ?? []).includes('recovery'), 'the server says it takes recovery codes')
      const freshNow = async (): Promise<Record<string, string>> => auth(erin)
      const code = b64(32)
      const record = { recoveryKey: code, wrappedPrivateKey: b64(64), wrappedAccountSecret: b64(48) }
      const wrongPassword = await app.inject({ method: 'POST', url: '/account/recovery', headers: await freshNow(), payload: { loginKey: b64(32), recovery: record } })
      check(wrongPassword.statusCode === 403, 'a token alone does not make a recovery code', wrongPassword.body)
      const watching = new Client(erin, hexId())
      httpHub.attach(watching)
      bystander.take()
      const made = await app.inject({ method: 'POST', url: '/account/recovery', headers: await freshNow(), payload: { loginKey: erinLogin, recovery: record } })
      check(
        made.statusCode === 200 && typeof (made.json() as { recovery?: { createdAt?: number } }).recovery?.createdAt === 'number',
        'with the password it does, and the answer is the bundle with it',
        made.body
      )
      check(
        watching.take().some((message) => message.type === 'notify' && message.kind === 'account-changed'),
        "the account's devices are told, so they show it without a restart"
      )
      check(!bystander.take().some((message) => message.type === 'notify'), "and nobody else's")
      httpHub.detach(watching)
      const unknown = await app.inject({ method: 'POST', url: '/auth/recover', payload: { recoveryKey: b64(32) } })
      check(unknown.statusCode === 401 && (unknown.json() as { error?: string }).error === 'this recovery code is not known here', 'an unknown code is refused', unknown.body)
      const opened = await app.inject({ method: 'POST', url: '/auth/recover', payload: { recoveryKey: code } })
      check(
        opened.statusCode === 200 &&
          (opened.json() as { accountId?: string; wrappedPrivateKey?: string }).accountId === erin &&
          (opened.json() as { wrappedPrivateKey?: string }).wrappedPrivateKey === record.wrappedPrivateKey,
        'a known one answers with the second wrapping',
        opened.body
      )
      const stillOpen = new Client(erin, hexId())
      httpHub.attach(stillOpen)
      const recovered = await app.inject({
        method: 'POST',
        url: '/auth/recover/commit',
        payload: {
          recoveryKey: code,
          newLoginKey: b64(32),
          kdfVersion: 1,
          wrappedPrivateKey: b64(64),
          wrappedAccountSecret: b64(48),
          recovery: { recoveryKey: b64(32), wrappedPrivateKey: b64(64), wrappedAccountSecret: b64(48) }
        }
      })
      check(recovered.statusCode === 200, 'the recovery sets a new password', recovered.body)
      const after = { authorization: `Bearer ${(recovered.json() as { token: string }).token}` }
      check((await app.inject({ method: 'GET', url: '/account', headers: after })).statusCode === 200, 'and signs this device in')
      check((await app.inject({ method: 'GET', url: '/account', headers: renewed })).statusCode === 401, 'and every other device out')
      check(stillOpen.take().some((message) => message.type === 'close' && message.code === CLOSE_SIGNED_OUT), 'their connections closed')
      httpHub.detach(stillOpen)
      httpHub.detach(otherDevice)
      httpHub.detach(bystander)
    }

    // Two-factor sign-in over HTTP: two steps, a challenge only the second
    // accepts. An app of its own, with its own clock - and an address guard
    // that has not counted the failures above.
    {
      let clock = 1_900_000_000_000
      const app = createHttpApp(loadConfig({}), tokens, accounts, httpHub, contacts, again, { logger: false, paceMs: 0, now: () => clock })
      check(((config.json() as { features?: string[] }).features ?? []).includes('totp'), 'the server says it offers two-factor sign-in')
      const ivyKeys = keyMaterial()
      const ivy = (await accounts.register(ivyKeys, 'open')).accountId
      const secret = randomBytes(20)
      const code = (offset = 0): string => totpCode(secret, Math.floor(clock / 30_000) + offset)
      const elsewhere = new Client(ivy, hexId())
      httpHub.attach(elsewhere)
      const on = await app.inject({
        method: 'POST',
        url: '/account/totp',
        headers: await auth(ivy),
        payload: { loginKey: ivyKeys.loginKey, secret: secret.toString('base64'), code: code() }
      })
      check(on.statusCode === 200 && (on.json() as { account?: { totp?: boolean } }).account?.totp === true, 'turning it on answers with a session', on.body)
      check(elsewhere.take().some((message) => message.type === 'close' && message.code === CLOSE_SIGNED_OUT), 'and closes the other devices as signed out')
      httpHub.detach(elsewhere)

      const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { loginKey: ivyKeys.loginKey } })
      const asked = login.json() as { secondFactor?: string; challenge?: string; account?: unknown; token?: string }
      check(
        login.statusCode === 403 && asked.secondFactor === 'totp' && typeof asked.challenge === 'string' && !asked.account && !asked.token,
        'the right password then answers with a challenge - no keys, no token',
        login.body
      )
      const challenge = asked.challenge as string
      check(
        (await app.inject({ method: 'GET', url: '/account', headers: { authorization: `Bearer ${challenge}` } })).statusCode === 401,
        'the challenge opens nothing else'
      )
      const second = (body: Record<string, string>) => app.inject({ method: 'POST', url: '/auth/login/totp', payload: body })
      const wrong = await second({ challenge, code: code(5) })
      check(wrong.statusCode === 401 && (wrong.json() as { error?: string }).error === 'wrong code', 'a wrong code is refused', wrong.body)
      check((await second({ challenge: b64(32), code: code() })).statusCode === 401, 'and so is a made-up challenge')
      clock += 30_000
      const right = await second({ challenge, code: code() })
      const signedIn = { authorization: `Bearer ${(right.json() as { token?: string }).token ?? ''}` }
      check(right.statusCode === 200 && (await app.inject({ method: 'GET', url: '/account', headers: signedIn })).statusCode === 200, 'the right code signs in', right.body)
      check((await second({ challenge, code: code() })).statusCode === 401, 'once')

      for (let attempt = 0; attempt < 4; attempt += 1) await second({ challenge, code: code(7) })
      clock += 30_000
      const blocked = await second({ challenge, code: code() })
      check(blocked.statusCode === 429, 'five wrong codes block codes for that account, even the right one', blocked.body)

      const wrongPassword = await app.inject({ method: 'POST', url: '/account/totp/off', headers: signedIn, payload: { loginKey: b64(32) } })
      check(wrongPassword.statusCode === 403, 'turning it off with a wrong password is refused', wrongPassword.body)
      // While codes are blocked, too: the password alone does it.
      const watching = new Client(ivy, hexId())
      httpHub.attach(watching)
      const off = await app.inject({ method: 'POST', url: '/account/totp/off', headers: signedIn, payload: { loginKey: ivyKeys.loginKey } })
      check(off.statusCode === 200 && (off.json() as { totp?: boolean }).totp === false, 'turning it off with the password alone', off.body)
      check(
        watching.take().some((message) => message.type === 'notify' && message.kind === 'account-changed'),
        'and the devices still signed in are told, without being signed out'
      )
      httpHub.detach(watching)
      const plain = await app.inject({ method: 'POST', url: '/auth/login', payload: { loginKey: ivyKeys.loginKey } })
      check(plain.statusCode === 200 && typeof (plain.json() as { token?: string }).token === 'string', 'afterwards the password alone signs in again')
      await app.close()
    }

    // A recovery that keeps two-factor sign-in, over HTTP. An app of its own
    // again: its code guard has counted nothing yet.
    {
      let clock = 1_950_000_000_000
      const app = createHttpApp(loadConfig({}), tokens, accounts, httpHub, contacts, again, { logger: false, paceMs: 0, now: () => clock, maxFailures: 1_000 })
      const jackKeys = keyMaterial()
      const jack = (await accounts.register(jackKeys, 'open')).accountId
      const secret = randomBytes(20)
      const code = (offset = 0): string => totpCode(secret, Math.floor(clock / 30_000) + offset)
      await accounts.enableTotp(jack, jackKeys.loginKey, secret.toString('base64'), code(), clock)
      let recoveryKey = b64(32)
      await accounts.setRecovery(jack, jackKeys.loginKey, { recoveryKey, wrappedPrivateKey: b64(64), wrappedAccountSecret: b64(48) })
      const opened = await app.inject({ method: 'POST', url: '/auth/recover', payload: { recoveryKey } })
      check(opened.statusCode === 200 && (opened.json() as { totp?: boolean }).totp === true, 'the recovery says the account signs in with a second factor', opened.body)
      const newLoginKey = b64(32)
      const commit = async (totpCode?: string) => {
        const next = b64(32)
        const response = await app.inject({
          method: 'POST',
          url: '/auth/recover/commit',
          payload: {
            recoveryKey,
            newLoginKey,
            kdfVersion: 1,
            wrappedPrivateKey: b64(64),
            wrappedAccountSecret: b64(48),
            recovery: { recoveryKey: next, wrappedPrivateKey: b64(64), wrappedAccountSecret: b64(48) },
            totpCode
          }
        })
        if (response.statusCode === 200) recoveryKey = next
        return { status: response.statusCode, body: response.json() as { error?: string; totpWasOn?: boolean; account?: { totp?: boolean } } }
      }
      clock += 30_000
      const wrong = await commit(code(5))
      check(wrong.status === 401 && wrong.body.error === 'wrong code', 'a wrong code to keep it is refused', wrong.body)
      check((await accounts.login(jackKeys.loginKey))?.accountId === jack, 'and the password stays as it was')
      const kept = await commit(code())
      check(kept.status === 200 && kept.body.totpWasOn === false && kept.body.account?.totp === true, 'the right one recovers the account and keeps it', kept.body)
      const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { loginKey: newLoginKey } })
      const challenge = (login.json() as { challenge?: string }).challenge ?? ''
      check(login.statusCode === 403 && challenge !== '', 'the new password then asks for a code', login.body)
      clock += 30_000
      const second = await app.inject({ method: 'POST', url: '/auth/login/totp', payload: { challenge, code: code() } })
      check(second.statusCode === 200, 'and the app it had before signs in', second.body)

      for (let attempt = 0; attempt < 4; attempt += 1) await commit(code(7))
      clock += 30_000
      const blocked = await commit(code())
      check(
        blocked.status === 429 && blocked.body.error === 'too many wrong codes; try again later',
        'five wrong codes block keeping it, even with the right one',
        blocked.body
      )
      const off = await commit()
      check(off.status === 200 && off.body.totpWasOn === true && off.body.account?.totp === false, 'the recovery code still gets in then, and turns it off', off.body)
      await app.close()
    }
    await app.close()
    await httpHub.shutdown()
  }

  // --- rooms -------------------------------------------------------------------
  let hub = new RoomHub({ dataDir, idleCloseMs: 50 }, accounts, contacts, new ForkStore(dataDir))
  const a1 = new Client(alice, aliceVault.vaultId)
  const a2 = new Client(alice, aliceVault.vaultId)
  const bobDevice = new Client(bob, bobVault.vaultId)
  const carolDevice = new Client(carol, carolVault.vaultId)
  for (const client of [a1, a2, bobDevice, carolDevice]) hub.attach(client)

  // Vault ids follow from account and vault name, so anyone can compute one.
  // Claiming a vault's settings before its owner does would lock them out.
  await hub.subscribe(bobDevice, `set:${aliceVault.vaultId}`, 0)
  check(bobDevice.take()[0]?.type === 'denied', "nobody claims another account's vault rooms first")
  await hub.subscribe(a1, `set:${aliceVault.vaultId}`, 0)
  check(a1.take().some((m) => m.type === 'caughtUp'), 'and the owner still gets them')

  await hub.subscribe(a1, `idx:${aliceVault.vaultId}`, 0)
  check(a1.take().some((m) => m.type === 'caughtUp'), 'the owner subscribes to the vault index')
  await hub.subscribe(bobDevice, `idx:${aliceVault.vaultId}`, 0)
  check(bobDevice.take()[0]?.type === 'denied', "someone else's vault index is refused")

  const docId = hexId()
  const room = `doc:${docId}`
  await hub.subscribe(a1, room, 0)
  await hub.subscribe(a2, room, 0)
  check(a1.take().at(-1)?.type === 'caughtUp' && a2.take().at(-1)?.type === 'caughtUp', 'the first subscriber claims a note, a second device joins it')
  check(
    existsSync(join(dataDir, 'users', alice, aliceVault.vaultId, 'notes', docId, 'meta.json')),
    "the note is kept in its owner's folder, under the vault"
  )

  await hub.push(a1, room, 1, 0, bytes('f1'))
  const pushed = a1.take()
  check(pushed[0]?.type === 'ack' && pushed[0].seq === 1, 'a push is acknowledged with its seq', pushed)
  check(a2.take()[0]?.data === 'f1', 'and fanned out to the other device')

  await hub.push(a1, room, 2, 5, bytes('stale'))
  check(a1.take()[0]?.type === 'rekey', 'a push under another epoch is refused with the current one')

  await hub.subscribe(bobDevice, room, 0)
  check(bobDevice.take()[0]?.type === 'denied', 'nobody else can read a note that is not shared')
  {
    // A device subscribing to a note it does not own - one that was shared
    // with it - must not become its owner when the server lost it.
    const lost = `doc:${hexId()}`
    await hub.subscribe(bobDevice, lost, 0, false)
    const answer = bobDevice.take()[0]
    check(answer?.type === 'denied' && answer.reason === 'missing', 'a missing room is not created when the subscriber may not', answer)
    await hub.subscribe(a1, lost, 0, true)
    check(a1.take().at(-1)?.type === 'caughtUp', 'and stays free for the one who may')
  }

  // --- sharing with history ------------------------------------------------------
  check(
    (await status(() => hub.share(alice, { docId, account: dave, role: 'write', withHistory: true, keys: { '0': 'k0' }, title: 'title' }))) === 403,
    'a note is shared with contacts only'
  )
  await hub.share(alice, { docId, account: bob, role: 'write', withHistory: true, keys: { '0': 'k0' }, title: 'title' })
  check(bobDevice.take().some((m) => m.type === 'notify' && m.kind === 'share-added'), 'the recipient is told')
  await hub.subscribe(bobDevice, room, 0)
  const bobCatchUp = bobDevice.take()
  check(bobCatchUp[0]?.type === 'frame' && bobCatchUp[0].seq === 1, 'with history, the recipient gets every frame', bobCatchUp)
  check((await hub.keys(bob, room)).keys['0'] === 'k0', 'and the keys sealed to them')
  check(Object.keys((await hub.keys(alice, room)).keys).length === 0, 'the owner needs no sealed keys')
  await hub.push(bobDevice, room, 1, 0, bytes('from bob'))
  check(bobDevice.take()[0]?.type === 'ack' && a1.take()[0]?.data === 'from bob', 'a writer pushes, the owner receives')
  a2.take()

  // --- sharing without history ---------------------------------------------------
  check(
    (await status(() =>
      hub.share(alice, {
        docId,
        account: carol,
        role: 'read',
        withHistory: false,
        keys: {},
        title: 't',
        rotation: { epoch: 1, keys: { [carol]: 'c1', [bob]: 'b1' }, snapshot: { uptoSeq: 1, data: 'c25hcA==' } }
      })
    )) === 409,
    'a snapshot that is not at the head is refused'
  )
  check(
    (await status(() =>
      hub.share(alice, {
        docId,
        account: carol,
        role: 'read',
        withHistory: false,
        keys: {},
        title: 't',
        rotation: { epoch: 1, keys: { [carol]: 'c1' }, snapshot: { uptoSeq: 2, data: 'c25hcA==' } }
      })
    )) === 400,
    'so is a rotation that leaves an existing member without the new key'
  )
  await hub.share(alice, {
    docId,
    account: carol,
    role: 'read',
    withHistory: false,
    keys: {},
    title: 't',
    rotation: { epoch: 1, keys: { [carol]: 'c1', [bob]: 'b1' }, snapshot: { uptoSeq: 2, data: Buffer.from('snap').toString('base64') } }
  })
  check(
    [a1, a2, bobDevice].every((client) => client.take().some((m) => m.type === 'rekey' && m.epoch === 1)),
    'everyone subscribed moves to the new epoch'
  )
  carolDevice.take()
  await hub.subscribe(carolDevice, room, 0)
  const carolCatchUp = carolDevice.take()
  check(
    carolCatchUp[0]?.type === 'snapshot' && carolCatchUp[0].data === 'snap' && carolCatchUp.filter((m) => m.type === 'frame').length === 0,
    'without history, the recipient starts from the snapshot and sees no earlier frame',
    carolCatchUp
  )
  await hub.push(carolDevice, room, 1, 1, bytes('carol writes'))
  check(carolDevice.take()[0]?.reason === 'read-only', 'a reader cannot push')
  await hub.push(a1, room, 3, 0, bytes('old epoch'))
  check(a1.take()[0]?.type === 'rekey', 'the owner is held to the new epoch too')
  await hub.push(a1, room, 4, 1, bytes('f3'))
  check(a1.take()[0]?.seq === 3 && carolDevice.take()[0]?.data === 'f3', 'what comes after the share reaches the reader')

  check((await hub.incoming(carol)).length === 1, 'the share waits to be accepted')
  await hub.accept(carol, docId, carolVault.vaultId)
  check((await hub.incoming(carol)).length === 0, 'and is gone from the list once accepted')
  check((await hub.members(alice, docId)).members.length === 2, 'the owner sees who has access')
  check((await status(() => hub.members(dave, docId))) === 403, 'outsiders do not')

  // --- the files a shared note names ----------------------------------------------------
  {
    const bobBlob = { account: bob, vault: bobVault.vaultId, blob: hexId() }
    const aliceBlob = { account: alice, vault: aliceVault.vaultId, blob: hexId() }
    check(
      (await status(() => hub.attachBlobs(carol, room, { attach: [{ account: carol, vault: carolVault.vaultId, blob: hexId() }] }))) === 403,
      'a reader attaches nothing'
    )
    check((await status(() => hub.attachBlobs(bob, room, { attach: [aliceBlob] }))) === 403, "nobody attaches someone else's blob")
    await hub.attachBlobs(bob, room, { attach: [bobBlob] })
    await hub.attachBlobs(alice, room, { attach: [aliceBlob] })
    check(
      (await hub.canReadBlob(carol, room, bobBlob)) && (await hub.canReadBlob(bob, room, aliceBlob)),
      'whoever reads the note may read the blobs it names'
    )
    check(!(await hub.canReadBlob(dave, room, bobBlob)), 'nobody else')
    check(!(await hub.canReadBlob(carol, room, { ...bobBlob, blob: hexId() })), 'and no blob it does not name')
    check(hub.isAttached(bob, bobVault.vaultId, bobBlob.blob), 'a blob a note names is protected from purging')
    check((await status(() => hub.attachBlobs(carol, room, { detach: [bobBlob] }))) === 403, "a member does not detach another's blob")
    await hub.attachBlobs(alice, room, { detach: [bobBlob] })
    check(
      !hub.isAttached(bob, bobVault.vaultId, bobBlob.blob) && !(await hub.canReadBlob(carol, room, bobBlob)),
      'the owner detaches any; then nobody reads it through the note'
    )
  }

  // --- revoking ----------------------------------------------------------------------
  check(
    (await status(() => hub.revoke(alice, { docId, account: bob, rotation: { epoch: 2, keys: {} } }))) === 400,
    'a revoke must seal the new epoch for everyone who stays'
  )
  await hub.accept(bob, docId, bobVault.vaultId)
  bobDevice.take()
  await hub.revoke(alice, { docId, account: bob, rotation: { epoch: 2, keys: { [carol]: 'c2' } } })
  check(bobDevice.take().some((m) => m.type === 'revoked'), 'the revoked member is told')
  await hub.push(bobDevice, room, 2, 2, bytes('too late'))
  check(bobDevice.take()[0]?.type === 'denied', 'and can no longer push')
  await hub.subscribe(bobDevice, room, 3)
  check(bobDevice.take()[0]?.type === 'revoked', 'a later subscribe hears it too, instead of failing forever')
  check((await hub.keys(carol, room)).keys['2'] === 'c2', 'the remaining member holds the new epoch')

  await hub.push(a1, room, 5, 2, bytes('f4'))
  a1.take()

  // --- what a revoked member keeps ----------------------------------------------------
  {
    const pending = await hub.forksOf(bob)
    check(pending.length === 1 && pending[0]?.docId === docId && pending[0].reason === 'revoked', 'the revoked member has a fork waiting', pending)
    const kept = await hub.fork(bob, docId)
    check(
      kept.log?.frames.map((frame) => `${frame.seq}:${text(Buffer.from(frame.data, 'base64'))}`).join() === '1:f1,2:from bob,3:f3',
      'with every frame they could read, and nothing written after the revocation',
      kept.log?.frames.map((frame) => frame.seq)
    )
    check(kept.keys['0'] === 'k0' && kept.keys['1'] === 'b1' && !kept.keys['2'], 'and the keys they held')
    check((await status(() => hub.fork(carol, docId))) === 404, 'nobody else gets it')
    const target = hexId()
    check((await hub.forkDone(bob, docId, target)) === target, 'a device says where the note carries on')
    check((await hub.forkDone(bob, docId, hexId())) === target, 'and a second device is told the first one')
    const done = await hub.fork(bob, docId)
    check(done.log === null && done.forkedTo === target && Object.keys(done.keys).length === 0, 'afterwards the history is gone', done)
    check((await hub.forksOf(bob)).length === 0, 'and nothing waits any more')
    await hub.subscribe(bobDevice, room, 0, true)
    check(bobDevice.take()[0]?.type === 'revoked', 'the ended share still answers as ended')
  }
  const carolLog = await hub.log(carol, room)
  check(
    carolLog.snapshot?.uptoSeq === 2 && carolLog.frames.every((frame) => frame.seq >= 3),
    'history for a member without history starts at their snapshot',
    carolLog
  )
  const aliceLog = await hub.log(alice, room)
  check(aliceLog.snapshot === null && aliceLog.frames[0]?.seq === 1, 'the owner reads the whole log')

  // --- compaction ----------------------------------------------------------------------
  check(
    (await status(() => hub.snapshot(carol, room, { uptoSeq: 3, epoch: 2, data: 'eA==' }))) === 403,
    'only the owner compacts'
  )
  check(
    (await status(() => hub.snapshot(alice, room, { uptoSeq: 3, epoch: 1, data: 'eA==' }))) === 409,
    'a snapshot under an old epoch is refused'
  )
  await hub.snapshot(alice, room, { uptoSeq: 3, epoch: 2, data: Buffer.from('compact').toString('base64') })
  const a3 = new Client(alice, aliceVault.vaultId)
  await hub.subscribe(a3, room, 0)
  const compacted = a3.take()
  check(
    compacted[0]?.type === 'snapshot' && compacted[0].data === 'compact' && compacted.filter((m) => m.type === 'frame').map((m) => m.seq).join() === '4',
    'after compaction a new device gets the snapshot and the frames after it',
    compacted
  )
  carolDevice.take()
  await hub.subscribe(carolDevice, room, 0)
  check(carolDevice.take()[0]?.data === 'compact', "a member's superseded start snapshot gives way to the compaction")
  check(
    (await hub.compactable(alice, aliceVault.vaultId, Date.now() + 1_000)).includes(room),
    'rooms with old frames are offered to their owner'
  )
  check((await hub.compactable(carol, carolVault.vaultId, Date.now() + 1_000)).length === 0, 'never to anyone else')

  // --- restart ---------------------------------------------------------------------------
  await hub.shutdown()
  hub = new RoomHub({ dataDir, idleCloseMs: 50 }, accounts, contacts, new ForkStore(dataDir))
  const afterRestart = new Client(alice, aliceVault.vaultId)
  hub.attach(afterRestart)
  await hub.subscribe(afterRestart, room, 0)
  const restarted = afterRestart.take()
  check(
    restarted[0]?.data === 'compact' && restarted.at(-1)?.type === 'caughtUp' && restarted.at(-1)?.epoch === 2,
    'a restart keeps log, snapshot and epoch',
    restarted
  )
  check((await hub.members(alice, docId)).members.map((member) => member.account).join() === carol, 'and who has access')

  // --- import --------------------------------------------------------------------------------
  const copy = `doc:${hexId()}`
  const head = await hub.importFrames(carol, copy, carolVault.vaultId, [
    { epoch: 0, data: Buffer.from('x').toString('base64') },
    { epoch: 0, data: Buffer.from('y').toString('base64') }
  ])
  check(head === 2, 'a detached copy is filled with its history')
  check(
    (await status(() => hub.importFrames(carol, copy, carolVault.vaultId, [{ epoch: 0, data: 'eA==' }]))) === 409,
    'but only once'
  )

  // --- a participant detaching ------------------------------------------------------------
  {
    const carolAgain = new Client(carol, carolVault.vaultId)
    hub.attach(carolAgain)
    await hub.subscribe(carolAgain, room, 0)
    carolAgain.take()
    await hub.detachShare(carol, docId)
    const told = carolAgain.take()
    check(
      told.some((m) => m.type === 'revoked') && told.some((m) => m.type === 'notify' && m.kind === 'share-removed'),
      "a participant detaching ends the share on all of their devices",
      told
    )
    const kept = await hub.fork(carol, docId)
    check(
      kept.reason === 'detached' && text(Buffer.from(kept.log?.snapshot?.data ?? '', 'base64')) === 'compact' && kept.log?.frames.map((f) => f.seq).join() === '4',
      'and keeps what they read: from the compaction on, since that is where their history starts',
      kept
    )
    check((await hub.members(alice, docId)).members.length === 0, 'the owner sees them gone')
    check((await status(() => hub.detachShare(carol, docId))) === 200, 'a second device detaching too is no error')
  }

  // --- purging a deleted note ------------------------------------------------------------------
  {
    const owner = new Client(alice, aliceVault.vaultId)
    hub.attach(owner)
    const doc3 = hexId()
    const room3 = `doc:${doc3}`
    await hub.subscribe(owner, room3, 0)
    await hub.push(owner, room3, 1, 0, bytes('deleted text'))
    await hub.share(alice, { docId: doc3, account: bob, role: 'read', withHistory: true, keys: { '0': 'k' }, title: 't' })
    check((await status(() => hub.purge(bob, room3))) === 403, 'only the owner lets a note go')
    check((await status(() => hub.purge(alice, room3))) === 409, 'and not while it is shared: the others keep it')
    owner.take()
    await hub.leave(bob, doc3)
    check(owner.take().some((m) => m.type === 'notify' && m.kind === 'share-changed'), 'the owner hears that someone left')
    check((await status(() => hub.purge(alice, room3))) === 200, 'once nobody else has it, it goes')
    check((await status(() => hub.log(alice, room3))) === 404, 'the room is gone')
    check(!existsSync(join(dataDir, 'users', alice, aliceVault.vaultId, 'notes', doc3)), 'from disk too')
    check((await status(() => hub.purge(alice, room3))) === 404, 'and a second device asking finds nothing')
    check((await status(() => hub.purge(alice, `idx:${aliceVault.vaultId}`))) === 400, 'a vault index is never purged')
  }

  // --- removed accounts ----------------------------------------------------------------------
  {
    const ownerDevice = new Client(alice, aliceVault.vaultId)
    const bobAgain = new Client(bob, bobVault.vaultId)
    for (const client of [ownerDevice, bobAgain]) hub.attach(client)
    const doc2 = hexId()
    const room2 = `doc:${doc2}`
    await hub.subscribe(ownerDevice, room2, 0)
    await hub.push(ownerDevice, room2, 1, 0, bytes('shared text'))
    for (const account of [bob, carol]) {
      await hub.share(alice, { docId: doc2, account, role: 'write', withHistory: true, keys: { '0': `${account}-k0` }, title: 't' })
    }
    await hub.accept(bob, doc2, bobVault.vaultId)
    await hub.accept(carol, doc2, carolVault.vaultId)
    await hub.subscribe(bobAgain, room2, 0, false)
    ownerDevice.take()
    bobAgain.take()

    await accounts.remove(carol)
    check(existsSync(join(dataDir, 'users', carol)), 'removing an account only marks it: the server clears it')
    await hub.sweep()
    check(
      (await hub.members(alice, doc2)).members.map((member) => member.account).join() === bob,
      'a removed member leaves the notes shared with them'
    )
    check(!existsSync(join(dataDir, 'users', carol)), 'and their folder goes')
    check(!(await contacts.connected(alice, carol)), 'as do their contacts')

    const before = Date.now()
    await accounts.remove(alice)
    await hub.sweep(before)
    const told = bobAgain.take()
    check(told.some((m) => m.type === 'revoked') && told.some((m) => m.kind === 'share-removed'), "the owner's account going ends the share", told)
    const kept = await hub.fork(bob, doc2)
    check(
      kept.reason === 'owner-removed' && kept.log?.frames.map((frame) => text(Buffer.from(frame.data, 'base64'))).join() === 'shared text',
      'and the participant keeps what they could read',
      kept
    )
    check(!existsSync(join(dataDir, 'users', alice)), "the owner's folder goes at once, since nothing waits in it")
    check(Object.keys(await accounts.removed()).length === 0, 'the removal is settled')
    await hub.subscribe(bobAgain, room2, 0, true)
    check(bobAgain.take()[0]?.type === 'revoked', 'a participant subscribing later hears it ended, and claims nothing')
    ownerDevice.take()
    await hub.subscribe(ownerDevice, `doc:${hexId()}`, 0, true)
    check(ownerDevice.take()[0]?.type === 'denied', 'a connection of the removed account creates nothing any more')

    await hub.shutdown()
    hub = new RoomHub({ dataDir, idleCloseMs: 50 }, accounts, contacts, new ForkStore(dataDir))
    const afterRestart = new Client(bob, bobVault.vaultId)
    hub.attach(afterRestart)
    await hub.subscribe(afterRestart, room2, 0, false)
    check(afterRestart.take()[0]?.type === 'revoked', 'after a restart too')
    check((await hub.forksOf(bob)).some((fork) => fork.docId === doc2), 'and the fork still waits')

    const day = 24 * 60 * 60 * 1000
    await hub.sweep(before + 89 * day)
    check((await hub.fork(bob, doc2)).log !== null, 'the history waits 90 days for the participant')
    await hub.sweep(before + 91 * day)
    const expired = await hub.fork(bob, doc2)
    check(expired.log === null && expired.reason === 'owner-removed', 'then it goes, and the tombstone stays', expired)
    await hub.subscribe(afterRestart, room2, 0, true)
    check(afterRestart.take()[0]?.type === 'revoked', 'still answering the share as ended')
  }

  // --- backup keys: a backup server reads one vault -------------------------------------
  {
    const tokens = new TokenService('rooms-selftest', 3_600)
    const store = new BlobStore(dataDir, { maxFileBytes: 3 * BLOB_CHUNK_BYTES, quotaBytes: null, purgeGraceMs: 0 })
    const app = createHttpApp(loadConfig({}), tokens, accounts, hub, contacts, store, { logger: false, paceMs: 0, maxFailures: 1_000 })
    const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })
    const auth = async (account: string): Promise<Record<string, string>> => {
      const stored = (await accounts.get(account)) as StoredAccount
      return bearer((await tokens.issue(account, sessionOf(stored))).token)
    }
    const kimKeys = keyMaterial()
    const kim = (await accounts.register(kimKeys, 'open')).accountId
    const leo = (await accounts.register(keyMaterial(), 'open')).accountId
    await contacts.pair(kim, leo)
    const kimVault = (await accounts.addVault(kim, hexId(), b64(32), b64(48))).vaultId
    const kimOther = (await accounts.addVault(kim, hexId(), b64(32), b64(48))).vaultId
    const leoVault = (await accounts.addVault(leo, hexId(), b64(32), b64(48))).vaultId

    const kimDevice = new Client(kim, kimVault)
    const kimElsewhere = new Client(kim, kimOther)
    const leoDevice = new Client(leo, leoVault)
    for (const client of [kimDevice, kimElsewhere, leoDevice]) hub.attach(client)
    const note = hexId()
    const otherNote = hexId()
    const sharedIn = hexId()
    const sharedElsewhere = hexId()
    const leoOnly = hexId()
    for (const room of [`idx:${kimVault}`, `set:${kimVault}`, `doc:${note}`]) {
      await hub.subscribe(kimDevice, room, 0)
      await hub.push(kimDevice, room, 1, 0, bytes(`${room} 1`))
    }
    await hub.subscribe(kimElsewhere, `idx:${kimOther}`, 0)
    await hub.subscribe(kimElsewhere, `doc:${otherNote}`, 0)
    await hub.push(kimElsewhere, `doc:${otherNote}`, 1, 0, bytes('other vault'))
    for (const [docId, into] of [
      [sharedIn, kimVault],
      [sharedElsewhere, kimOther]
    ] as const) {
      await hub.subscribe(leoDevice, `doc:${docId}`, 0)
      await hub.push(leoDevice, `doc:${docId}`, 1, 0, bytes('from leo'))
      await hub.share(leo, { docId, account: kim, role: 'write', withHistory: true, keys: { '0': 'sealed-for-kim' }, title: 't' })
      await hub.accept(kim, docId, into)
    }
    await hub.subscribe(leoDevice, `doc:${leoOnly}`, 0)
    await hub.push(leoDevice, `doc:${leoOnly}`, 1, 0, bytes('not shared'))
    const tail = new Uint8Array(BLOB_CHUNK_OVERHEAD + 10).fill(4)
    const blob = hexId()
    const otherBlob = hexId()
    await store.putChunk(kim, kimVault, blob, 0, 1, tail)
    await store.putChunk(kim, kimOther, otherBlob, 0, 1, tail)
    for (const client of [kimDevice, kimElsewhere, leoDevice]) client.take()

    const make = (loginKey: string, vaultId: string, backupKey = b64(32), label = 'NAS') =>
      app.inject({ method: 'POST', url: '/account/backup-keys', headers: undefined, payload: { loginKey, vaultId, backupKey, label } })
    const makeAs = async (account: string, loginKey: string, vaultId: string, backupKey = b64(32), label = 'NAS') =>
      app.inject({ method: 'POST', url: '/account/backup-keys', headers: await auth(account), payload: { loginKey, vaultId, backupKey, label } })
    const signIn = (backupKey: string) => app.inject({ method: 'POST', url: '/auth/backup', payload: { backupKey } })

    check((await make(kimKeys.loginKey, kimVault)).statusCode === 401, 'a backup key is made by a signed-in device only')
    check((await makeAs(kim, b64(32), kimVault)).statusCode === 403, 'and with the current password, not a token alone')
    check((await makeAs(kim, kimKeys.loginKey, leoVault)).statusCode === 403, "never for someone else's vault")
    const backupKey = b64(32)
    const made = await makeAs(kim, kimKeys.loginKey, kimVault, backupKey, 'NAS in the cellar')
    const created = made.json() as { id?: string; account?: { backupKeys?: Array<{ id: string; vaultId: string; label: string }> } }
    check(
      made.statusCode === 200 &&
        created.account?.backupKeys?.length === 1 &&
        created.account.backupKeys[0]?.id === created.id &&
        created.account.backupKeys[0]?.vaultId === kimVault &&
        created.account.backupKeys[0]?.label === 'NAS in the cellar',
      'with the password it is made, and the bundle lists it with its vault and label',
      made.body
    )
    check(kimDevice.take().some((message) => message.type === 'notify' && message.kind === 'account-changed'), "the account's devices are told")
    const stored = JSON.stringify((await accounts.get(kim))?.backupKeys)
    check(!stored.includes(backupKey), 'the server keeps only its hash')

    const unknown = await signIn(b64(32))
    check(unknown.statusCode === 401 && (unknown.json() as { error?: string }).error === 'this backup key is not known here', 'an unknown backup key signs nothing in', unknown.body)
    const signedIn = await signIn(backupKey)
    const session = signedIn.json() as { token?: string; vaultId?: string; accountId?: string; keyId?: string }
    check(signedIn.statusCode === 200 && session.vaultId === kimVault && session.accountId === kim && session.keyId === created.id, 'the backup key signs a backup server in, for its vault', signedIn.body)
    const backup = bearer(session.token ?? '')
    check(
      typeof ((await accounts.get(kim))?.backupKeys?.[created.id ?? '']?.lastUsedAt) === 'number',
      'and the account sees when it was last used'
    )

    const listed = await app.inject({ method: 'GET', url: '/backup/rooms', headers: backup })
    const rooms = (listed.json() as { rooms?: Array<{ room: string; tag: string; owner: string }> }).rooms ?? []
    check(
      rooms.map((entry) => entry.room).sort().join() === [`idx:${kimVault}`, `set:${kimVault}`, `doc:${note}`, `doc:${sharedIn}`].sort().join(),
      "its token lists the vault's rooms: index, settings, its notes and the notes shared into it - nothing of another vault",
      rooms.map((entry) => entry.room)
    )
    check(rooms.find((entry) => entry.room === `doc:${sharedIn}`)?.owner === leo, 'with whose note each one is')
    check((await app.inject({ method: 'GET', url: '/backup/rooms', headers: await auth(kim) })).statusCode === 403, 'a device has no use for that list')

    const read = async (url: string): Promise<number> => (await app.inject({ method: 'GET', url, headers: backup })).statusCode
    check(
      (await read(`/log/doc:${note}`)) === 200 && (await read(`/log/idx:${kimVault}`)) === 200 && (await read(`/log/set:${kimVault}`)) === 200,
      "it reads the vault's own rooms"
    )
    const keys = await app.inject({ method: 'GET', url: `/keys/doc:${sharedIn}`, headers: backup })
    check(
      (await read(`/log/doc:${sharedIn}`)) === 200 && (keys.json() as { keys?: Record<string, string> }).keys?.['0'] === 'sealed-for-kim',
      'and a note shared into it, with the keys sealed to the account'
    )
    check(
      (await read(`/log/doc:${otherNote}`)) === 403 &&
        (await read(`/log/idx:${kimOther}`)) === 403 &&
        (await read(`/log/doc:${sharedElsewhere}`)) === 403 &&
        (await read(`/keys/doc:${sharedElsewhere}`)) === 403,
      "nothing of the account's other vault"
    )
    check((await read(`/log/doc:${leoOnly}`)) === 403, 'nor anything of anyone else')
    check(
      (await read(`/blobs/${kim}/${kimVault}/${blob}`)) === 200 && (await read(`/blobs/${kim}/${kimVault}/${blob}/0`)) === 200,
      "it reads the vault's files"
    )
    check((await read(`/blobs/${kim}/${kimOther}/${otherBlob}/0`)) === 403, "not the other vault's")

    const write = async (method: 'POST' | 'PUT', url: string, payload: unknown, extra: Record<string, string> = {}): Promise<number> =>
      (await app.inject({ method, url, headers: { ...backup, ...extra }, payload: payload as Record<string, unknown> })).statusCode
    check(
      (await write('POST', `/log/doc:${note}/snapshot`, { uptoSeq: 1, epoch: 0, data: 'eA==' })) === 401 &&
        (await write('POST', `/log/doc:${note}/purge`, {})) === 401 &&
        (await write('PUT', `/blobs/${kim}/${kimVault}/${hexId()}/0?count=1`, Buffer.from(tail), { 'content-type': 'application/octet-stream' })) === 401 &&
        (await write('POST', `/blobs/${kim}/${kimVault}/purge`, { ids: [blob] })) === 401 &&
        (await write('POST', '/shares/leave', { docId: sharedIn })) === 401 &&
        (await write('POST', '/account/backup-keys', { loginKey: kimKeys.loginKey, vaultId: kimVault, backupKey: b64(32), label: 'x' })) === 401 &&
        (await read('/account')) === 401,
      'every route that writes refuses it, and so does the account itself'
    )

    // Fetching only what changed.
    const tagOf = async (room: string): Promise<string | undefined> => {
      const answer = await app.inject({ method: 'GET', url: '/backup/rooms', headers: backup })
      return (answer.json() as { rooms: Array<{ room: string; tag: string }> }).rooms.find((entry) => entry.room === room)?.tag
    }
    const before = await tagOf(`doc:${note}`)
    const untouched = await tagOf(`doc:${sharedIn}`)
    await hub.push(kimDevice, `doc:${note}`, 2, 0, bytes('note 2'))
    await hub.push(kimDevice, `doc:${note}`, 3, 0, bytes('note 3'))
    kimDevice.take()
    check((await tagOf(`doc:${note}`)) !== before && (await tagOf(`doc:${sharedIn}`)) === untouched, 'a room that changed changes its tag, the others keep theirs')
    const logFrom = async (from: number) =>
      (await app.inject({ method: 'GET', url: `/log/doc:${note}?from=${from}`, headers: backup })).json() as {
        from?: number
        snapshot: { uptoSeq: number } | null
        frames: Array<{ seq: number }>
      }
    const partial = await logFrom(2)
    check(
      partial.from === 2 && partial.snapshot === null && partial.frames.map((frame) => frame.seq).join() === '2,3',
      'a log from a seq answers that frame and the ones after it',
      partial
    )
    const ahead = await logFrom(9)
    check(ahead.from === undefined && ahead.frames.map((frame) => frame.seq).join() === '1,2,3', 'a seq the log does not have gets the whole log', ahead)
    await hub.snapshot(kim, `doc:${note}`, { uptoSeq: 2, epoch: 0, data: Buffer.from('folded').toString('base64') })
    const folded = await logFrom(2)
    check(
      folded.from === undefined && folded.snapshot?.uptoSeq === 2 && folded.frames.map((frame) => frame.seq).join() === '3',
      'and so does one the compaction folded in: snapshot and frames',
      folded
    )
    check((await logFrom(3)).from === 3, 'a seq after the compaction is still answered on its own')

    // Ending a backup key.
    const deleted = await app.inject({ method: 'POST', url: '/account/backup-keys/delete', headers: await auth(kim), payload: { id: created.id } })
    check(deleted.statusCode === 200 && (deleted.json() as { backupKeys?: unknown[] }).backupKeys?.length === 0, 'a device deletes a backup key', deleted.body)
    check((await read('/backup/rooms')) === 401 && (await read(`/log/doc:${note}`)) === 401, 'its token stops at once')
    check((await signIn(backupKey)).statusCode === 401, 'and the key signs nothing in any more')

    const second = b64(32)
    await makeAs(kim, kimKeys.loginKey, kimVault, second)
    const secondToken = bearer((((await signIn(second)).json()) as { token: string }).token)
    const newLoginKey = b64(32)
    await accounts.changePassword(kim, { loginKey: kimKeys.loginKey, newLoginKey, kdfVersion: 1, wrappedPrivateKey: b64(64), wrappedAccountSecret: b64(48) })
    check(
      (await app.inject({ method: 'GET', url: '/backup/rooms', headers: secondToken })).statusCode === 401 &&
        (await signIn(second)).statusCode === 401 &&
        accounts.bundle((await accounts.get(kim)) as StoredAccount).backupKeys?.length === 0,
      'a password change ends every backup key, tokens handed out included'
    )

    const third = b64(32)
    await makeAs(kim, newLoginKey, kimVault, third)
    check((await signIn(third)).statusCode === 200, 'a new one works after it')
    const recoveryKey = b64(32)
    await accounts.setRecovery(kim, newLoginKey, { recoveryKey, wrappedPrivateKey: b64(64), wrappedAccountSecret: b64(48) })
    await accounts.recover({
      recoveryKey,
      newLoginKey: b64(32),
      kdfVersion: 1,
      wrappedPrivateKey: b64(64),
      wrappedAccountSecret: b64(48),
      recovery: { recoveryKey: b64(32), wrappedPrivateKey: b64(64), wrappedAccountSecret: b64(48) }
    })
    check((await signIn(third)).statusCode === 401, 'a recovery ends them too')

    const monaKeys = keyMaterial()
    const mona = (await accounts.register(monaKeys, 'open')).accountId
    const monaVault = (await accounts.addVault(mona, hexId(), b64(32), b64(48))).vaultId
    const monaKey = b64(32)
    await accounts.addBackupKey(mona, monaKeys.loginKey, monaVault, monaKey, 'x')
    check((await accounts.findBackupKey(monaKey))?.account.accountId === mona, 'a key is found by itself alone')
    await accounts.remove(mona)
    check((await accounts.findBackupKey(monaKey)) === null, 'and removing the account ends its keys')

    for (const client of [kimDevice, kimElsewhere, leoDevice]) hub.detach(client)
    await app.close()
  }

  // --- the relay between devices and backup servers ---------------------------------------
  {
    class FakeSocket extends EventEmitter {
      readonly OPEN = 1
      readyState = 1
      sent: Array<Record<string, unknown>> = []
      closedWith: { code?: number; reason?: string } | null = null
      send(data: string): void {
        this.sent.push(JSON.parse(data) as Record<string, unknown>)
      }
      close(code?: number, reason?: string): void {
        if (this.readyState !== 1) return
        this.readyState = 3
        this.closedWith = { code, reason }
        this.emit('close')
      }
      terminate(): void {
        this.close()
      }
      say(frame: unknown): void {
        this.emit('message', Buffer.from(JSON.stringify(frame)))
      }
      take(): Array<Record<string, unknown>> {
        return this.sent.splice(0)
      }
    }
    const relay = new Relay({ sessionsPerDevice: 2, backupsPerAddress: 2, routesPerBackup: 3, registerMs: 50 })
    const socket = (): FakeSocket => new FakeSocket()
    const as = (fake: FakeSocket): never => fake as never
    const routeOf = (raw: Buffer): string => createHash('sha256').update(raw).digest('hex')
    const token = randomBytes(32)
    const route = routeOf(token)
    const secondToken = randomBytes(32)
    const secondRoute = routeOf(secondToken)

    const backup = socket()
    relay.attachBackup(as(backup), '192.0.2.10')
    backup.say({ t: 'register', token: token.toString('base64') })
    check(backup.take()[0]?.route === route, 'a backup server registers under the hash of its token')
    backup.say({ t: 'register', token: secondToken.toString('base64') })
    check(backup.take()[0]?.route === secondRoute && relay.registered === 2, 'and one connection answers many routes - an invitation, every paired vault')
    const short = socket()
    relay.attachBackup(as(short), '192.0.2.13')
    short.say({ t: 'register', token: randomBytes(16).toString('base64') })
    check(short.closedWith?.code === 4400, 'a token too short to come from a secret is refused')

    const device = socket()
    relay.attachDevice(as(device), alice, '192.0.2.20')
    device.say({ t: 'open', route: routeOf(randomBytes(32)), ref: 1 })
    check(device.take()[0]?.error === 'the backup server is not connected', 'a route nobody registered opens nothing')
    device.say({ t: 'open', route, ref: 2 })
    const opened = device.take()[0]
    const session = opened?.s as number
    const incoming = backup.take()[0]
    check(
      opened?.t === 'opened' && opened.ref === 2 && incoming?.t === 'incoming' && incoming.s === session && incoming.route === route,
      'a device opens a session, and the backup server hears on which route'
    )
    device.say({ t: 'data', s: session, d: 'sealed for the backup server' })
    backup.say({ t: 'data', s: session, d: 'sealed for the device' })
    check(
      backup.take()[0]?.d === 'sealed for the backup server' && device.take()[0]?.d === 'sealed for the device',
      'frames go both ways as they are'
    )

    const viaSecond = socket()
    relay.attachDevice(as(viaSecond), bob, '192.0.2.21')
    viaSecond.say({ t: 'open', route: secondRoute, ref: 1 })
    const secondSession = viaSecond.take()[0]?.s as number
    check(backup.take()[0]?.route === secondRoute, 'the same connection answers the other route')
    backup.say({ t: 'unregister', route: secondRoute })
    check(
      viaSecond.take().some((frame) => frame.t === 'close' && frame.s === secondSession) && relay.registered === 1 && device.take().length === 0,
      "a route it gives up - an invitation spent, a vault let go - ends that route's sessions and no other"
    )
    backup.take()
    viaSecond.say({ t: 'open', route: secondRoute, ref: 2 })
    check(viaSecond.take().at(-1)?.error === 'the backup server is not connected', 'and opens nothing any more')

    const stranger = socket()
    relay.attachDevice(as(stranger), bob, '192.0.2.30')
    stranger.say({ t: 'data', s: session, d: 'injected' })
    const otherBackup = socket()
    relay.attachBackup(as(otherBackup), '192.0.2.11')
    otherBackup.say({ t: 'register', token: randomBytes(32).toString('base64') })
    otherBackup.take()
    otherBackup.say({ t: 'data', s: session, d: 'injected' })
    otherBackup.say({ t: 'unregister', route })
    check(backup.take().length === 0 && device.take().length === 0, "nobody writes into someone else's session, nor gives up someone else's route")

    const greedy = socket()
    relay.attachBackup(as(greedy), '192.0.2.14')
    for (let n = 0; n < 4; n += 1) greedy.say({ t: 'register', token: randomBytes(32).toString('base64') })
    check(greedy.take().length === 3 && greedy.closedWith?.code === 4429, 'a backup server registers only so many routes')

    device.say({ t: 'open', route, ref: 3 })
    device.say({ t: 'open', route, ref: 4 })
    check(device.take().at(-1)?.error === 'too many sessions', 'a device holds only so many sessions at once')
    backup.take()

    const again = socket()
    relay.attachBackup(as(again), '192.0.2.10')
    again.say({ t: 'register', token: token.toString('base64') })
    check(
      again.take()[0]?.route === route && backup.closedWith?.code === 4409 && device.take().some((frame) => frame.t === 'close' && frame.s === session),
      'the backup server connecting again takes its route over; the old connection, left without one, goes, and its sessions end'
    )

    const silent = socket()
    relay.attachBackup(as(silent), '192.0.2.12')
    await delay(80)
    check(silent.closedWith?.code === 4400, 'a backup server that does not register is let go')

    for (let n = 0; n < 2; n += 1) {
      const crowd = socket()
      relay.attachBackup(as(crowd), '192.0.2.99')
      crowd.say({ t: 'register', token: randomBytes(32).toString('base64') })
    }
    const third = socket()
    relay.attachBackup(as(third), '192.0.2.99')
    check(third.closedWith?.code === 4429, 'an address connects only so many backup servers')

    again.close()
    device.say({ t: 'open', route, ref: 5 })
    check(device.take().at(-1)?.error === 'the backup server is not connected', 'a backup server that went is no longer reachable')
    relay.close()

    // Pinged, every connection: behind a reverse proxy, a backup server waiting for devices
    // with nothing to say lost its connection every minute, and every route with it.
    {
      class PingedSocket extends FakeSocket {
        pings = 0
        answers = true
        ping(): void {
          this.pings += 1
          if (this.answers) queueMicrotask(() => this.emit('pong'))
        }
      }
      const pinging = new Relay({ pingMs: 20 })
      const waiting = new PingedSocket()
      pinging.attachBackup(waiting as never, '192.0.2.30')
      waiting.say({ t: 'register', token: randomBytes(32).toString('base64') })
      const asking = new PingedSocket()
      pinging.attachDevice(asking as never, alice, '192.0.2.31')
      await delay(90)
      check(
        waiting.pings >= 2 && asking.pings >= 2 && waiting.readyState === 1 && pinging.registered === 1,
        "the relay pings a backup server's connection and a device's, and keeps them while they answer"
      )
      waiting.answers = false
      await delay(90)
      check(waiting.readyState === 3 && pinging.registered === 0 && asking.readyState === 1, 'one that stops answering is let go, and its routes with it')
      pinging.close()
      asking.close()
    }
  }
  await hub.shutdown()
  await delay(10)
} catch (error) {
  check(false, 'the scenario ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
