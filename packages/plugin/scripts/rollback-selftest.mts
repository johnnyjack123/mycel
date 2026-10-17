// Rolling a vault back to a moment, against real devices and a sync server in
// this process: the plan from the history, the gate before anything changes,
// the copy, the changes as every device follows them, a note shared with
// someone, one someone shares in, undoing a rollback, a folder alone, and a
// history compacted past the moment.
//
//   npm run test:rollback
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, delay, Device, eventually, failures, finish, useServer } from './harness.mjs'

const { loadConfig } = await import('../../server/src/config.js')
const { startServer } = await import('../../server/src/server.js')
const { IndexOutOfReach, Rollback, RollbackRefused } = await import('../src/sync/Rollback.js')
const { RoomHistory } = await import('../src/history/RoomHistory.js')
const { docRoom } = await import('@obsidian-connect/shared')

const root = mkdtempSync(join(tmpdir(), 'oc-rollback-selftest-'))
const run = Date.now().toString(36)
const server = await startServer(
  loadConfig({
    HOST: '127.0.0.1',
    PORT: '0',
    OBSIDIAN_CONNECT_DATA_DIR: join(root, 'server'),
    OBSIDIAN_CONNECT_REGISTRATION: 'open',
    OBSIDIAN_CONNECT_JWT_SECRET: 'rollback-selftest'
  }),
  { logger: false, paceMs: 0 }
)
useServer(`ws://127.0.0.1:${server.port}`)

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const same = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean => a !== undefined && b !== undefined && Buffer.from(a).equals(Buffer.from(b))
const photo = bytes('photo, as it was '.repeat(200))
const photoLater = bytes('photo, painted over '.repeat(200))
const alt = bytes('another picture '.repeat(150))
const moving = bytes('a picture that moves '.repeat(120))
const one = bytes('picture one '.repeat(90))
const two = bytes('picture two '.repeat(95))

const A1 = new Device(`anna${run}`, true, {
  'Welcome.md': 'hello\n',
  'Projects/Plan.md': 'the plan\n',
  'Projects/Old.md': 'old\n',
  'Keep/Untouched.md': 'untouched\n',
  'Ideas.md': 'ideas\n',
  'A.md': 'I am A\n',
  'B.md': 'I am B\n',
  'Bilder/Foto.png': photo,
  'Bilder/Alt.png': alt,
  'Bilder/Move.png': moving,
  'Bilder/One.png': one,
  'Bilder/Two.png': two
})
const A2 = new Device(`anna${run}`, false)
const B = new Device(`ben${run}`, true)
const devices = [A1, A2, B]
const ok = { label: 'NAS', ok: true }

/** The vault as one device has it, notes and files. */
function snapshot(device: Device): Map<string, string> {
  const found = new Map<string, string>()
  for (const path of device.vault.paths()) found.set(path, device.vault.text(path) ?? '')
  for (const path of device.vault.attachmentPaths()) found.set(path, Buffer.from(device.vault.bytes(path) ?? new Uint8Array()).toString('base64'))
  return found
}

function sameVault(a: Map<string, string>, b: Map<string, string>, prefix = ''): string[] {
  const differ: string[] = []
  for (const [path, content] of a) if (path.startsWith(prefix) && b.get(path) !== content) differ.push(path)
  for (const path of b.keys()) if (path.startsWith(prefix) && !a.has(path)) differ.push(`extra ${path}`)
  return differ
}

try {
  for (const device of devices) check(await device.boot(), `${device.username} starts`)
  const code = await (A1.contacts as NonNullable<typeof A1.contacts>).createCode()
  await B.contacts?.redeem(code)
  check(await eventually(() => B.contacts?.name(A1.accountId) !== undefined && A1.contacts?.name(B.accountId) !== undefined), 'A and B are contacts')
  await B.vault.userCreate('From Ben.md', 'written by ben\n')
  check(await eventually(() => B.docText('From Ben.md') === 'written by ben\n'), 'B writes a note')
  await B.sharing?.share(B.index?.docIdForPath('From Ben.md') as string, A1.accountId, 'write', true)
  check(await eventually(() => A1.vault.text('Shared/From Ben.md') === 'written by ben\n', 15_000), "B's note is shared into A's vault")
  await A1.sharing?.share(A1.index?.docIdForPath('Projects/Plan.md') as string, B.accountId, 'write', true)
  check(await eventually(() => B.vault.text('Shared/Plan.md') === 'the plan\n', 15_000), "and A's plan into B's")
  check(
    await eventually(() => A2.vault.text('Welcome.md') === 'hello\n' && same(A2.vault.bytes('Bilder/Move.png'), moving) && A2.vault.text('Shared/From Ben.md') === 'written by ben\n', 15_000),
    "A's second device has the whole vault"
  )
  await delay(100)
  const before = snapshot(A1)
  const T = Date.now()
  await delay(100)

  // --- what happens after the moment ----------------------------------------------------------
  await A1.vault.userWrite('Welcome.md', 'hello, changed\n')
  await A1.vault.userCreate('New.md', 'a new note\n')
  await A1.vault.trash(A1.vault.file('Projects/Old.md'))
  await A1.vault.userWrite('Projects/Plan.md', 'the plan, changed\n')
  await A1.vault.createFolder('Archive')
  await A1.vault.rename(A1.vault.file('Ideas.md'), 'Archive/Ideas.md')
  await A1.vault.rename(A1.vault.file('A.md'), 'swap.md')
  await A1.vault.rename(A1.vault.file('B.md'), 'A.md')
  await A1.vault.rename(A1.vault.file('swap.md'), 'B.md')
  await A1.vault.userWriteBinary('Bilder/Foto.png', photoLater)
  await A1.vault.trash(A1.vault.file('Bilder/Alt.png'))
  await A1.vault.userCreateBinary('Bilder/New.png', bytes('came later '.repeat(80)))
  await A1.vault.createFolder('Other')
  await A1.vault.rename(A1.vault.file('Bilder/Move.png'), 'Other/Move.png')
  await A1.vault.rename(A1.vault.file('Bilder/One.png'), 'Bilder/swap.png')
  await A1.vault.rename(A1.vault.file('Bilder/Two.png'), 'Bilder/One.png')
  await A1.vault.rename(A1.vault.file('Bilder/swap.png'), 'Bilder/Two.png')
  await B.vault.userWrite('From Ben.md', 'written by ben, and more\n')
  const afterChanges = (device: Device): boolean =>
    device.vault.text('Welcome.md') === 'hello, changed\n' &&
    device.vault.text('New.md') === 'a new note\n' &&
    device.vault.text('Projects/Old.md') === undefined &&
    device.vault.text('Archive/Ideas.md') === 'ideas\n' &&
    device.vault.text('A.md') === 'I am B\n' &&
    same(device.vault.bytes('Bilder/Foto.png'), photoLater) &&
    device.vault.bytes('Bilder/Alt.png') === undefined &&
    device.vault.bytes('Bilder/New.png') !== undefined &&
    same(device.vault.bytes('Other/Move.png'), moving) &&
    same(device.vault.bytes('Bilder/One.png'), two) &&
    same(device.vault.bytes('Bilder/Two.png'), one) &&
    device.vault.text('Shared/From Ben.md') === 'written by ben, and more\n'
  check(await eventually(() => afterChanges(A1) && afterChanges(A2), 20_000), 'A changes notes and files - edits, a new one, a deleted one, renames, swaps - and both devices agree, the swaps included')
  check(await eventually(() => B.vault.text('Shared/Plan.md') === 'the plan, changed\n', 15_000), 'B sees the change of the shared plan')
  await delay(500)
  const changed = snapshot(A1)

  // --- the plan ---------------------------------------------------------------------------------
  const rollback = A1.rollback
  const progress: Array<[number, number]> = []
  const plan = await rollback.plan(T, '', (done, of) => progress.push([done, of]))
  const note = (path: string): (typeof plan.notes)[number] | undefined => plan.notes.find((entry) => entry.pathThen === path || entry.pathNow === path)
  const file = (path: string): (typeof plan.files)[number] | undefined => plan.files.find((entry) => entry.pathThen === path || entry.pathNow === path)
  check(note('Welcome.md')?.text === true && note('Welcome.md')?.textThen === 'hello\n', 'the plan gives a note its text then')
  check(note('New.md')?.trash === true, 'trashes a note that did not exist then')
  check(note('Projects/Old.md')?.revive === true, 'brings back one deleted since')
  check(note('Ideas.md')?.move === true && note('Ideas.md')?.pathNow === 'Archive/Ideas.md', 'moves back one renamed since')
  check(note('A.md')?.move === true && note('B.md')?.move === true, 'and two that swapped names')
  check(note('Projects/Plan.md')?.shared === true && note('Projects/Plan.md')?.text === true, 'names a note shared with others among them')
  check(!note('Keep/Untouched.md') && !plan.notes.some((entry) => entry.pathNow?.startsWith('Shared/')), 'leaves out what did not change, and what someone else shares in')
  check(plan.foreignKept >= 1 && plan.outOfReach.length === 0, 'counts what others share as left alone; nothing is out of reach', { foreignKept: plan.foreignKept, outOfReach: plan.outOfReach })
  check(file('Bilder/Foto.png')?.content === true, 'gives a file its content then')
  check(file('Bilder/Alt.png')?.revive === true && file('Bilder/New.png')?.trash === true, 'brings back a file deleted since and trashes one that came later')
  check(file('Bilder/Move.png')?.move === true && file('Bilder/One.png')?.move === true, 'and moves back one that moved, and two that swapped')
  check(progress.length > 1 && progress.at(-1)?.[0] === progress.at(-1)?.[1], 'and says how far reading the history got')
  check(snapshot(A1).size === changed.size && sameVault(changed, snapshot(A1)).length === 0, 'planning changes nothing')

  // --- the gate -------------------------------------------------------------------------------------
  const refused = await rollback.apply(plan, { backups: [{ label: 'NAS', ok: false, error: 'the disk is full' }] }).then(
    () => null,
    (error: unknown) => error
  )
  check(refused instanceof RollbackRefused && /NAS/.test((refused as Error).message), 'a backup that failed stops the rollback', refused)
  check(sameVault(changed, snapshot(A1)).length === 0 && A1.settings?.rollbacks().length === 0, 'before anything changes or is recorded')
  const servers = { servers: () => [{ routeId: 'r', label: 'NAS' }], backUpFresh: async () => ({ ok: true }) }
  const backups = await rollback.backUpFirst(servers)
  check(backups.length === 1 && backups[0]?.ok === true, 'a fresh backup on every backup server comes first')

  // --- rolling back -----------------------------------------------------------------------------------
  const steps: string[] = []
  const outcome = await rollback.apply(plan, { backups }, (message) => steps.push(message))
  check(outcome.problems.length === 0 && outcome.record.state === 'done', 'the rollback goes through', outcome.problems)
  const asBefore = (device: Device): string[] => sameVault(before, snapshot(device)).filter((path) => !path.includes('Shared/From Ben.md') && !path.startsWith('extra Archive') && !path.startsWith('extra Other'))
  check(await eventually(() => asBefore(A1).length === 0, 15_000), 'the vault is as it was then - notes, names, files', asBefore(A1))
  check(A1.vault.text('Shared/From Ben.md') === 'written by ben, and more\n', "what someone else shares in stays as it is now")
  check(await eventually(() => asBefore(A2).length === 0 && A2.vault.text('Shared/From Ben.md') === 'written by ben, and more\n', 20_000), 'the other device follows', asBefore(A2))
  check(await eventually(() => B.vault.text('Shared/Plan.md') === 'the plan\n', 15_000), 'and so does the person the plan is shared with')
  check(await eventually(() => B.vault.text('From Ben.md') === 'written by ben, and more\n'), "and B's own note is untouched")
  {
    const copied = A1.vault.adapter
    const dir = outcome.copy
    check(
      copied.files.get(`${dir}/Welcome.md`) === 'hello, changed\n' &&
        copied.files.get(`${dir}/New.md`) === 'a new note\n' &&
        same(copied.binaries.get(`${dir}/Bilder/Foto.png`), photoLater) &&
        copied.files.get(`${dir}/rollback.json`)?.includes('"to"') === true,
      'the copy in the plugin folder holds what changed and what went, as it was before',
      Array.from(copied.files.keys()).filter((key) => key.startsWith(dir))
    )
  }
  check(A1.trash?.list().some((item) => item.path === 'New.md') === true, 'the note that came later is in the trash, restorable')
  check(await eventually(() => A2.settings?.rollbacks()[0]?.state === 'done'), 'and every device sees the rollback recorded')
  check(steps.some((step) => step.startsWith('Copying')) && steps.some((step) => step.startsWith('Changing')), 'it says what it is doing')

  // --- undoing it ----------------------------------------------------------------------------------------
  await delay(300)
  const record = A1.settings?.rollbacks()[0] as NonNullable<ReturnType<NonNullable<typeof A1.settings>['rollbacks']>[number]>
  const undoPlan = await A1.rollback.plan(record.startedAt - 1)
  const undone = await A1.rollback.apply(undoPlan, { backups })
  const asChanged = (device: Device): string[] =>
    sameVault(changed, snapshot(device)).filter((path) => !path.startsWith('extra Projects/Old (') && !path.includes('Shared/From Ben.md'))
  check(undone.problems.length === 0, 'undoing the rollback goes through', undone.problems)
  check(await eventually(() => asChanged(A1).length === 0, 15_000), 'and the vault is as it was before the rollback', asChanged(A1))
  check(await eventually(() => asChanged(A2).length === 0, 20_000), 'on every device', asChanged(A2))

  // --- a folder alone ---------------------------------------------------------------------------------------
  await delay(100)
  const T2 = Date.now()
  await delay(100)
  await A1.vault.userWrite('Projects/Plan.md', 'the plan, changed again\n')
  await A1.vault.userCreate('Projects/Later.md', 'later\n')
  await A1.vault.userWrite('Welcome.md', 'hello, outside the folder\n')
  check(await eventually(() => A2.vault.text('Projects/Later.md') === 'later\n' && A2.vault.text('Welcome.md') === 'hello, outside the folder\n', 15_000), 'A changes notes in a folder and outside it')
  await delay(300)
  const folderPlan = await A1.rollback.plan(T2, 'Projects')
  check(
    folderPlan.notes.every((entry) => (entry.pathNow ?? entry.pathThen ?? '').startsWith('Projects/')) && folderPlan.notes.length === 2,
    'rolling back a folder plans only what lies in it',
    folderPlan.notes.map((entry) => entry.pathNow)
  )
  await A1.rollback.apply(folderPlan, { backups: [ok] })
  check(
    await eventually(() => A1.vault.text('Projects/Plan.md') === 'the plan, changed\n' && A1.vault.text('Projects/Later.md') === undefined),
    'its notes go back'
  )
  check(A1.vault.text('Welcome.md') === 'hello, outside the folder\n', 'and nothing outside it changes')

  // --- a history compacted past the moment ----------------------------------------------------------------------
  await delay(300)
  const T3 = Date.now()
  await delay(100)
  await A1.vault.userWrite('Keep/Untouched.md', 'touched at last\n')
  check(await eventually(() => A2.vault.text('Keep/Untouched.md') === 'touched at last\n'), 'A edits one more note')
  await delay(300)
  const untouched = A1.index?.docIdForPath('Keep/Untouched.md') as string
  const compactor = A1.compactor as unknown as { compact(room: string, cutoff: number): Promise<boolean> }
  const compactingAt = Date.now()
  check(await compactor.compact(docRoom(untouched), Date.now() + 1_000), "the owner's device compacts that note's history")
  const history = await RoomHistory.load(A1.api, docRoom(untouched), (A1.keys as NonNullable<typeof A1.keys>).ownDocCrypto(untouched))
  // The edit came 300 ms before the compaction.
  check(history.reach > T3 && history.reach < compactingAt - 200, "the snapshot carries the time of the newest change it holds, not when it was made", { reach: history.reach, T3, compactingAt })
  const partly = await A1.rollback.plan(T3)
  check(partly.outOfReach.some((entry) => entry.path === 'Keep/Untouched.md'), 'a rollback to before it finds that note out of reach', partly.outOfReach)
  const notWithout = await A1.rollback.apply(partly, { backups: [ok] }).then(
    () => null,
    (error: unknown) => error
  )
  check(notWithout instanceof RollbackRefused, 'and goes on only when the person agrees to leave it as it is')
  const without = await A1.rollback.apply(partly, { backups: [ok], withoutOutOfReach: true })
  check(without.problems.length === 0 && A1.vault.text('Keep/Untouched.md') === 'touched at last\n', 'then it leaves that note alone')

  await A1.vault.userCreate('Newest.md', 'the newest\n')
  check(await eventually(() => A2.vault.text('Newest.md') === 'the newest\n'), 'and adds a note, which changes the index')
  await delay(300)
  const everything = A1.compactor as unknown as { run(): Promise<number> }
  A1.retentionDays = 1e-9
  check((await everything.run()) > 0, 'the whole history compacted')
  const outOfReach = await A1.rollback.plan(T3).then(
    () => null,
    (error: unknown) => error
  )
  check(outOfReach instanceof IndexOutOfReach && (outOfReach as InstanceType<typeof IndexOutOfReach>).reach > T3, 'a moment before the index history says how far it reaches instead', outOfReach)
} catch (error) {
  check(false, 'the scenario ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  for (const device of devices) await device.shutdown().catch(() => undefined)
  await server.close().catch(() => undefined)
  await delay(100)
  if (failures.length === 0) rmSync(root, { recursive: true, force: true })
  else console.log(`kept for a look: ${root}`)
}

finish()
