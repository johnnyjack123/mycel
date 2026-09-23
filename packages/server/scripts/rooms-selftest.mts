// The server's room layer and accounts, in-process against a scratch
// directory: no network, no port, nothing near the real data. Frames here are
// arbitrary bytes - the server treats them as opaque, which is the point.
//
//   npm run test:rooms
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotifyKind, ShareNotice } from '@obsidian-connect/shared'
import { AccountStore } from '../src/accounts.js'
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
    readonly username: string,
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
  sendNotify(kind: NotifyKind, _payload: ShareNotice): void {
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
  // --- accounts --------------------------------------------------------------
  const accounts = new AccountStore(dataDir, 'test-secret')
  const kdf = { algorithm: 'argon2id' as const, salt: b64(16), memoryKiB: 19_456, iterations: 2, parallelism: 1 }
  const keyMaterial = (): { authKey: string; publicKey: string; wrappedPrivateKey: string } => ({
    authKey: b64(32),
    publicKey: b64(65),
    wrappedPrivateKey: b64(64)
  })

  const aliceKeys = keyMaterial()
  await accounts.register({ username: 'Alice', kdf, ...aliceKeys }, 'open')
  check((await accounts.get('alice'))?.status === 'active', 'open registration creates an account, name lowercased')
  check(
    (await status(() => accounts.register({ username: 'alice', kdf, ...keyMaterial() }, 'open'))) === 409,
    'a taken name cannot be registered again'
  )
  check(
    (await status(() => accounts.register({ username: 'carol', kdf, ...keyMaterial() }, 'invite'))) === 403,
    'without an invite, invite-only registration refuses'
  )
  const code = await accounts.invite('carol')
  check(
    (await status(() => accounts.register({ username: 'carol', invite: 'nope', kdf, ...keyMaterial() }, 'invite'))) === 403,
    'a wrong invite code is refused'
  )
  await accounts.register({ username: 'carol', invite: code, kdf, ...keyMaterial() }, 'invite')
  check((await accounts.get('carol'))?.status === 'active', 'the invite code claims the account')
  await accounts.invite('dave')
  check(
    (await status(() => accounts.register({ username: 'dave', kdf, ...keyMaterial() }, 'open'))) === 403,
    'an invited name needs its code even when registration is open'
  )
  await accounts.register({ username: 'bob', kdf, ...keyMaterial() }, 'open')

  check((await accounts.verify('alice', aliceKeys.authKey))?.username === 'alice', 'the right key logs in')
  check((await accounts.verify('alice', b64(32))) === null, 'a wrong key does not')
  const unknown = await accounts.kdfFor('nobody')
  check(
    unknown.salt === (await accounts.kdfFor('nobody')).salt && unknown.salt !== (await accounts.kdfFor('someone')).salt,
    'unknown names get a stable salt of their own, so asking reveals nothing'
  )

  const firstKey = b64(48)
  const aliceVault = await accounts.addVault('alice', 'Notes', firstKey)
  const again = await accounts.addVault('alice', 'Notes', b64(48))
  check(again.vaultId === aliceVault.vaultId && again.wrappedKey === firstKey, 'a vault is created once; the second device gets its key')
  const bobVault = await accounts.addVault('bob', 'Notes', b64(48))
  check(bobVault.vaultId !== aliceVault.vaultId, 'vault ids differ per account')
  const carolVault = await accounts.addVault('carol', 'Mine', b64(48))

  // A password change replaces every wrapped key of the account. A token alone
  // - it travels in the socket URL - must not be enough to do that.
  {
    const newAuthKey = b64(32)
    const change = (authKey: string, vaults: Record<string, string>): Promise<unknown> =>
      accounts.changePassword('alice', { authKey, kdf: { ...kdf, salt: b64(16) }, newAuthKey, wrappedPrivateKey: b64(64), vaults })
    check(
      (await status(() => change(b64(32), { [aliceVault.vaultId]: b64(48) }))) === 403,
      'a password change needs the current password'
    )
    check((await status(() => change(aliceKeys.authKey, {}))) === 400, 'and every vault, or one would be locked for good')
    await change(aliceKeys.authKey, { [aliceVault.vaultId]: b64(48) })
    check(
      (await accounts.verify('alice', newAuthKey)) !== null && (await accounts.verify('alice', aliceKeys.authKey)) === null,
      'afterwards the new password logs in and the old one does not'
    )
  }

  // --- rooms -------------------------------------------------------------------
  let hub = new RoomHub({ dataDir, idleCloseMs: 50 }, accounts)
  const a1 = new Client('alice', aliceVault.vaultId)
  const a2 = new Client('alice', aliceVault.vaultId)
  const bob = new Client('bob', bobVault.vaultId)
  const carol = new Client('carol', carolVault.vaultId)
  for (const client of [a1, a2, bob, carol]) hub.attach(client)

  // Vault ids follow from account and vault name, so anyone can compute one.
  // Claiming a vault's settings before its owner does would lock them out.
  await hub.subscribe(bob, `set:${aliceVault.vaultId}`, 0)
  check(bob.take()[0]?.type === 'denied', "nobody claims another account's vault rooms first")
  await hub.subscribe(a1, `set:${aliceVault.vaultId}`, 0)
  check(a1.take().some((m) => m.type === 'caughtUp'), 'and the owner still gets them')

  await hub.subscribe(a1, `idx:${aliceVault.vaultId}`, 0)
  check(a1.take().some((m) => m.type === 'caughtUp'), 'the owner subscribes to the vault index')
  await hub.subscribe(bob, `idx:${aliceVault.vaultId}`, 0)
  check(bob.take()[0]?.type === 'denied', "someone else's vault index is refused")

  const docId = hexId()
  const room = `doc:${docId}`
  await hub.subscribe(a1, room, 0)
  await hub.subscribe(a2, room, 0)
  check(a1.take().at(-1)?.type === 'caughtUp' && a2.take().at(-1)?.type === 'caughtUp', 'the first subscriber claims a note, a second device joins it')

  await hub.push(a1, room, 1, 0, bytes('f1'))
  const pushed = a1.take()
  check(pushed[0]?.type === 'ack' && pushed[0].seq === 1, 'a push is acknowledged with its seq', pushed)
  check(a2.take()[0]?.data === 'f1', 'and fanned out to the other device')

  await hub.push(a1, room, 2, 5, bytes('stale'))
  check(a1.take()[0]?.type === 'rekey', 'a push under another epoch is refused with the current one')

  await hub.subscribe(bob, room, 0)
  check(bob.take()[0]?.type === 'denied', 'nobody else can read a note that is not shared')

  // --- sharing with history ------------------------------------------------------
  await hub.share('alice', { docId, username: 'bob', role: 'write', withHistory: true, keys: { '0': 'k0' }, title: 'title' })
  check(bob.take().some((m) => m.type === 'notify' && m.kind === 'share-added'), 'the recipient is told')
  await hub.subscribe(bob, room, 0)
  const bobCatchUp = bob.take()
  check(bobCatchUp[0]?.type === 'frame' && bobCatchUp[0].seq === 1, 'with history, the recipient gets every frame', bobCatchUp)
  check((await hub.keys('bob', room)).keys['0'] === 'k0', 'and the keys sealed to them')
  check(Object.keys((await hub.keys('alice', room)).keys).length === 0, 'the owner needs no sealed keys')
  await hub.push(bob, room, 1, 0, bytes('from bob'))
  check(bob.take()[0]?.type === 'ack' && a1.take()[0]?.data === 'from bob', 'a writer pushes, the owner receives')
  a2.take()

  // --- sharing without history ---------------------------------------------------
  check(
    (await status(() =>
      hub.share('alice', {
        docId,
        username: 'carol',
        role: 'read',
        withHistory: false,
        keys: {},
        title: 't',
        rotation: { epoch: 1, keys: { carol: 'c1', bob: 'b1' }, snapshot: { uptoSeq: 1, data: 'c25hcA==' } }
      })
    )) === 409,
    'a snapshot that is not at the head is refused'
  )
  check(
    (await status(() =>
      hub.share('alice', {
        docId,
        username: 'carol',
        role: 'read',
        withHistory: false,
        keys: {},
        title: 't',
        rotation: { epoch: 1, keys: { carol: 'c1' }, snapshot: { uptoSeq: 2, data: 'c25hcA==' } }
      })
    )) === 400,
    'so is a rotation that leaves an existing member without the new key'
  )
  await hub.share('alice', {
    docId,
    username: 'carol',
    role: 'read',
    withHistory: false,
    keys: {},
    title: 't',
    rotation: { epoch: 1, keys: { carol: 'c1', bob: 'b1' }, snapshot: { uptoSeq: 2, data: Buffer.from('snap').toString('base64') } }
  })
  check(
    [a1, a2, bob].every((client) => client.take().some((m) => m.type === 'rekey' && m.epoch === 1)),
    'everyone subscribed moves to the new epoch'
  )
  carol.take()
  await hub.subscribe(carol, room, 0)
  const carolCatchUp = carol.take()
  check(
    carolCatchUp[0]?.type === 'snapshot' && carolCatchUp[0].data === 'snap' && carolCatchUp.filter((m) => m.type === 'frame').length === 0,
    'without history, the recipient starts from the snapshot and sees no earlier frame',
    carolCatchUp
  )
  await hub.push(carol, room, 1, 1, bytes('carol writes'))
  check(carol.take()[0]?.reason === 'read-only', 'a reader cannot push')
  await hub.push(a1, room, 3, 0, bytes('old epoch'))
  check(a1.take()[0]?.type === 'rekey', 'the owner is held to the new epoch too')
  await hub.push(a1, room, 4, 1, bytes('f3'))
  check(a1.take()[0]?.seq === 3 && carol.take()[0]?.data === 'f3', 'what comes after the share reaches the reader')

  check((await hub.incoming('carol')).length === 1, 'the share waits to be accepted')
  await hub.accept('carol', docId, carolVault.vaultId)
  check((await hub.incoming('carol')).length === 0, 'and is gone from the list once accepted')
  check((await hub.members('alice', docId)).members.length === 2, 'the owner sees who has access')
  check((await status(() => hub.members('dave', docId))) === 403, 'outsiders do not')

  // --- revoking ----------------------------------------------------------------------
  check(
    (await status(() => hub.revoke('alice', { docId, username: 'bob', rotation: { epoch: 2, keys: {} } }))) === 400,
    'a revoke must seal the new epoch for everyone who stays'
  )
  bob.take()
  await hub.revoke('alice', { docId, username: 'bob', rotation: { epoch: 2, keys: { carol: 'c2' } } })
  check(bob.take().some((m) => m.type === 'revoked'), 'the revoked member is told')
  await hub.push(bob, room, 2, 2, bytes('too late'))
  check(bob.take()[0]?.type === 'denied', 'and can no longer push')
  await hub.subscribe(bob, room, 3)
  check(bob.take()[0]?.type === 'revoked', 'a later subscribe hears it too, instead of failing forever')
  check((await hub.keys('carol', room)).keys['2'] === 'c2', 'the remaining member holds the new epoch')

  await hub.push(a1, room, 5, 2, bytes('f4'))
  a1.take()
  const carolLog = await hub.log('carol', room)
  check(
    carolLog.snapshot?.uptoSeq === 2 && carolLog.frames.every((frame) => frame.seq >= 3),
    'history for a member without history starts at their snapshot',
    carolLog
  )
  const aliceLog = await hub.log('alice', room)
  check(aliceLog.snapshot === null && aliceLog.frames[0]?.seq === 1, 'the owner reads the whole log')

  // --- compaction ----------------------------------------------------------------------
  check(
    (await status(() => hub.snapshot('carol', room, { uptoSeq: 3, epoch: 2, data: 'eA==' }))) === 403,
    'only the owner compacts'
  )
  check(
    (await status(() => hub.snapshot('alice', room, { uptoSeq: 3, epoch: 1, data: 'eA==' }))) === 409,
    'a snapshot under an old epoch is refused'
  )
  await hub.snapshot('alice', room, { uptoSeq: 3, epoch: 2, data: Buffer.from('compact').toString('base64') })
  const a3 = new Client('alice', aliceVault.vaultId)
  await hub.subscribe(a3, room, 0)
  const compacted = a3.take()
  check(
    compacted[0]?.type === 'snapshot' && compacted[0].data === 'compact' && compacted.filter((m) => m.type === 'frame').map((m) => m.seq).join() === '4',
    'after compaction a new device gets the snapshot and the frames after it',
    compacted
  )
  carol.take()
  await hub.subscribe(carol, room, 0)
  check(carol.take()[0]?.data === 'compact', "a member's superseded start snapshot gives way to the compaction")
  check(
    (await hub.compactable('alice', aliceVault.vaultId, Date.now() + 1_000)).includes(room),
    'rooms with old frames are offered to their owner'
  )
  check((await hub.compactable('carol', carolVault.vaultId, Date.now() + 1_000)).length === 0, 'never to anyone else')

  // --- restart ---------------------------------------------------------------------------
  await hub.shutdown()
  hub = new RoomHub({ dataDir, idleCloseMs: 50 }, accounts)
  const afterRestart = new Client('alice', aliceVault.vaultId)
  hub.attach(afterRestart)
  await hub.subscribe(afterRestart, room, 0)
  const restarted = afterRestart.take()
  check(
    restarted[0]?.data === 'compact' && restarted.at(-1)?.type === 'caughtUp' && restarted.at(-1)?.epoch === 2,
    'a restart keeps log, snapshot and epoch',
    restarted
  )
  check((await hub.members('alice', docId)).members.map((member) => member.username).join() === 'carol', 'and who has access')

  // --- import --------------------------------------------------------------------------------
  const copy = `doc:${hexId()}`
  const head = await hub.importFrames('carol', copy, carolVault.vaultId, [
    { epoch: 0, data: Buffer.from('x').toString('base64') },
    { epoch: 0, data: Buffer.from('y').toString('base64') }
  ])
  check(head === 2, 'a detached copy is filled with its history')
  check(
    (await status(() => hub.importFrames('carol', copy, carolVault.vaultId, [{ epoch: 0, data: 'eA==' }]))) === 409,
    'but only once'
  )
  await hub.shutdown()
  await delay(10)
} catch (error) {
  check(false, 'the scenario ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
