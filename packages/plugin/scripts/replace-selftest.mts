// Replacing every key of an account (`docs/PHASE8.md`, S2) with real devices:
// two of the account's own and a contact who shares with it both ways. The
// server runs in this process, on a port and in a directory of its own, never
// near the user's.
//
//   npm run test:replace
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, delay, Device, eventually, finish, useServer } from './harness.mjs'

const { docRoom, frameAad } = await import('@obsidian-connect/shared')
const { contentHash, decrypt, fromBase64 } = await import('@obsidian-connect/shared/crypto')
const { KeyRing } = await import('../src/account/KeyRing.js')
const { NoteHistory } = await import('../src/history/NoteHistory.js')
const { Blobs } = await import('../src/sync/Blobs.js')
const { loadConfig } = await import('../../server/src/config.js')
const { startServer } = await import('../../server/src/server.js')

type Ring = InstanceType<typeof KeyRing>

const root = mkdtempSync(join(tmpdir(), 'oc-replace-selftest-'))
const server = await startServer(
  loadConfig({
    HOST: '127.0.0.1',
    PORT: '0',
    OBSIDIAN_CONNECT_DATA_DIR: root,
    OBSIDIAN_CONNECT_REGISTRATION: 'open',
    OBSIDIAN_CONNECT_JWT_SECRET: 'replace-selftest'
  }),
  { logger: false, paceMs: 0, maxFailures: 1_000 }
)
useServer(`ws://127.0.0.1:${server.port}`)

const binary = (seed: number, length = 5_000): Uint8Array => new Uint8Array(length).map((_byte, index) => (index * seed + 11) & 255)
const same = (a: Uint8Array | null | undefined, b: Uint8Array): boolean => Boolean(a) && Buffer.from(a as Uint8Array).equals(Buffer.from(b))

async function befriend(a: Device, b: Device): Promise<void> {
  const code = await (a.contacts as NonNullable<typeof a.contacts>).createCode()
  await b.contacts?.redeem(code)
  await eventually(async () => (await b.contacts?.processInbox()) !== undefined && (await a.contacts?.processInbox()) !== undefined)
}

/** Whether every frame of a note on the server opens under a key ring's keys for it. */
async function opensWith(device: Device, ring: Ring, docId: string): Promise<{ frames: number; opened: number }> {
  const room = docRoom(docId)
  const whole = await device.api.wholeLog(room)
  let opened = 0
  for (const frame of whole.frames) {
    const key = await ring.ownDocCrypto(docId).key(frame.epoch)
    if (!key) continue
    try {
      await decrypt(key, fromBase64(frame.data), frameAad(room, frame.epoch))
      opened += 1
    } catch {
      // Not under this ring's key.
    }
  }
  return { frames: whole.frames.length, opened }
}

const run = Date.now().toString(36)
const NEXT = 'an entirely new horse, battery and staple'
const picture = binary(5)
const A1 = new Device(`anna${run}`, true, { 'Mine.md': 'mine\n', 'Shared.md': 'shared\n', 'pic.png': picture, 'Projects/Plan.md': 'plan\n' })
const A2 = new Device(`anna${run}`, false)
const C = new Device(`carl${run}`, true, { 'Hers.md': 'hers\n' })
const devices = [A1, A2, C]
try {
  check((await A1.boot()) && (await A2.boot()) && (await C.boot()), 'two devices of one account and a contact start')
  check(
    await eventually(() => A2.vault.text('Mine.md') === 'mine\n' && same(A2.vault.bytes('pic.png'), picture)),
    'the second device has the notes and the file'
  )
  await befriend(A1, C)
  const shared = A1.index?.docIdForPath('Shared.md') as string
  await A1.sharing?.share(shared, C.accountId, 'write', true)
  check(await eventually(() => C.vault.text('Shared/Shared.md') === 'shared\n'), 'C has the note A shared to write')
  await C.vault.userWrite('Shared/Shared.md', 'shared\nby carl\n')
  check(await eventually(() => A1.vault.text('Shared.md') === 'shared\nby carl\n'), 'and what C writes reaches A')
  const hers = C.index?.docIdForPath('Hers.md') as string
  await C.sharing?.share(hers, A1.accountId, 'read', true)
  check(
    await eventually(() => A1.vault.text('Shared/Hers.md') === 'hers\n' && A2.vault.text('Shared/Hers.md') === 'hers\n'),
    'A has the note C shared to read, on both devices'
  )
  await A1.vault.userWrite('Mine.md', 'mine\nsecond version\n')
  check(await eventually(() => A2.vault.text('Mine.md') === 'mine\nsecond version\n'), 'A2 follows an edit')
  await A1.folders?.share('Projects', C.accountId, 'write', true)
  check(await eventually(() => C.vault.text('Shared/Projects/Plan.md') === 'plan\n', 15_000), 'C has the folder A shared to write')

  // --- every key replaced ---------------------------------------------------------------
  const before = A1.keys as Ring
  const oldRecovery = A1.recoveryCode as string
  const mine = A1.index?.docIdForPath('Mine.md') as string
  const hash = await contentHash(picture)
  await A1.shutdown()
  await A1.replaceKeys(NEXT)
  check(await eventually(() => A2.signedOut === 1 && !A2.signedIn), 'A replaces every key, and its other device is signed out')
  check(
    await eventually(() => C.contacts?.isReplaced(A1.accountId) === true),
    "the contact's device hears of it, and takes nothing in A's name meanwhile"
  )
  check(!A1.replacing, 'the vaults are written anew, and the keys before let go of')
  check(await A1.boot(), 'A starts again under the new keys')
  check(A1.vault.text('Mine.md') === 'mine\nsecond version\n' && same(A1.vault.bytes('pic.png'), picture), 'its notes and files are as they were')
  const after = A1.keys as Ring
  const withBefore = await opensWith(A1, before, mine)
  const withAfter = await opensWith(A1, after, mine)
  check(
    withBefore.frames > 0 && withBefore.opened === 0 && withAfter.opened === withAfter.frames,
    'on the server, nothing of a note opens with the keys before, all of it with the new ones',
    { withBefore, withAfter }
  )
  const history = new NoteHistory(A1.api, docRoom(mine), after.ownDocCrypto(mine), 1)
  await history.load()
  check(
    history.versions().some((version) => history.textAt(version.seq) === 'mine\n') && history.unreadable === 0,
    'and its history reads as before, under the new keys'
  )
  check(!(await new Blobs(A1.api, before).has(hash)) && (await new Blobs(A1.api, after).has(hash)), "the file's content is on the server under the new key only")
  check(await new Device(`anna${run}`, false).boot().then(() => false, () => true), 'the password before signs nobody in')
  check(await new Device('', false).recover(oldRecovery, `anna${run}`, 'yet another horse, battery and staple').then(() => false, () => true), 'nor does the recovery code before')
  check(typeof A1.recoveryCode === 'string' && A1.recoveryCode !== oldRecovery, 'a new recovery code came with the keys')

  A2.password = NEXT
  check(await A2.boot(), 'A2 signs in with the new password')
  await A2.vault.userWrite('Mine.md', 'mine\nsecond version\nfrom A2\n')
  check(await eventually(() => A1.vault.text('Mine.md') === 'mine\nsecond version\nfrom A2\n'), 'and both devices sync as before')
  check(A1.asked === 0 && A2.asked === 0, 'nobody was asked whether the server lost data: the logs written anew are still theirs')

  // --- the contact, until confirming A again ----------------------------------------------
  await A1.vault.userWrite('Shared.md', 'shared\nby carl\nafter the replacement\n')
  await delay(1_500)
  check(C.vault.text('Shared/Shared.md') === 'shared\nby carl\n', "C takes nothing A writes under the new keys before confirming A again")
  const refused = await C.sharing?.share(hers, A1.accountId, 'write', true).then(
    () => 'shared',
    (error: Error) => error.message
  )
  check(refused?.includes('replaced their keys') === true, 'and seals nothing to A meanwhile', refused)

  await befriend(A1, C)
  await C.renewing
  check(C.contacts?.isReplaced(A1.accountId) === false, "a new friend code confirms A's new keys")
  check(
    await eventually(() => C.vault.text('Shared/Shared.md') === 'shared\nby carl\nafter the replacement\n', 15_000),
    "A's note opens for C again, with what A wrote meanwhile",
    C.vault.text('Shared/Shared.md')
  )
  await C.vault.userWrite('Hers.md', 'hers\nafter\n')
  check(
    await eventually(() => A1.vault.text('Shared/Hers.md') === 'hers\nafter\n' && A2.vault.text('Shared/Hers.md') === 'hers\nafter\n', 15_000),
    "C's note, sealed anew to A's new key, opens for A's devices again",
    { a1: A1.vault.text('Shared/Hers.md'), a2: A2.vault.text('Shared/Hers.md') }
  )
  await C.vault.userWrite('Shared/Shared.md', 'shared\nby carl\nafter the replacement\nand by carl again\n')
  check(
    await eventually(() => A1.vault.text('Shared.md') === 'shared\nby carl\nafter the replacement\nand by carl again\n'),
    "and C writes into A's note again, certified anew"
  )
  const theirs = new NoteHistory(C.api, docRoom(shared), (C.keys as Ring).sharedDocCrypto(shared, A1.accountId), 1)
  await theirs.load()
  check(
    theirs.versions().some((version) => theirs.textAt(version.seq) === 'shared\n'),
    "C reads the note's history from before, written anew"
  )
  await A1.vault.userWrite('Projects/Plan.md', 'plan\nafter the replacement\n')
  check(
    await eventually(() => C.vault.text('Shared/Projects/Plan.md') === 'plan\nafter the replacement\n', 15_000),
    "the shared folder, written anew and moved to a new epoch, opens for C as well",
    C.vault.text('Shared/Projects/Plan.md')
  )
  await C.vault.userWrite('Shared/Projects/Plan.md', 'plan\nafter the replacement\nand carl\n')
  check(
    await eventually(() => A1.vault.text('Projects/Plan.md') === 'plan\nafter the replacement\nand carl\n', 15_000),
    'and C writes in it again'
  )

  // --- a replacement that broke off right after the server took the keys -------------------
  const THIRD = 'a third horse, battery and staple'
  await A1.shutdown()
  await A1.replaceKeys(THIRD, false)
  check(A1.replacing, 'A replaces its keys again, and its device stops before writing the vaults anew')
  check(await eventually(() => A2.signedOut === 2 && !A2.signedIn), 'A2 is signed out again')
  A2.password = THIRD
  check(await A2.boot(), 'A2 signs in with the newest password, and writes the vaults anew itself')
  check(!A2.replacing, 'the replacement is done')
  const newest = A2.keys as Ring
  const byNewest = await opensWith(A2, newest, mine)
  check(byNewest.frames > 0 && byNewest.opened === byNewest.frames, 'everything opens with the newest keys', byNewest)
  check(await A1.boot(), 'A1, starting again, finds the replacement done')
  await A1.vault.userWrite('Mine.md', 'mine\nafter the second replacement\n')
  check(await eventually(() => A2.vault.text('Mine.md') === 'mine\nafter the second replacement\n'), 'and both sync as before')
} catch (error) {
  check(false, 'the scenario ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  for (const device of devices) await device.shutdown()
  await server.close()
  rmSync(root, { recursive: true, force: true })
}

finish()
