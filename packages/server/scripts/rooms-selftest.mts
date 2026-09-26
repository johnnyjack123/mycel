// The server's room layer and accounts, in-process against a scratch
// directory: no network, no port, nothing near the real data. Frames here are
// arbitrary bytes - the server treats them as opaque, which is the point.
//
//   npm run test:rooms
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Notice, NotifyKind } from '@obsidian-connect/shared'
import { AccountStore } from '../src/accounts.js'
import { ContactStore } from '../src/contacts.js'
import { loadEnvFile } from '../src/config.js'
import { ForkStore } from '../src/forks.js'
import { AddressGuard, paced } from '../src/throttle.js'
import type { Frame } from '../src/log.js'
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
    check(await contacts.unpair(alice, dave), 'contacts can part')
    check(!(await contacts.connected(alice, dave)), 'and are no longer connected')
  }
  await contacts.pair(alice, bob)
  await contacts.pair(alice, carol)

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
  await hub.shutdown()
  await delay(10)
} catch (error) {
  check(false, 'the scenario ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
