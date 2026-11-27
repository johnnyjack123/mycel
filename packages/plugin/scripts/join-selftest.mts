// A device meeting a vault on the server for the first time (0.9.19, `sync/Joining.ts`):
// what the comparison finds - upload, download, the same, another state, another vault -,
// the copy of the whole vault made first, "Not now" touching nothing, "Take the server's
// version" leaving this vault as the server has it without deleting anything for anyone,
// merging as before, a choice carried on after a restart, a device that synced before
// never asked, and overwriting the server with this vault (0.9.33). The server runs in this process, on a port and in a directory of its own.
//
//   npm run test:join
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, delay, Device, eventually, finish, PLUGIN_DIR, useServer } from './harness.mjs'

const { loadConfig } = await import('../../server/src/config.js')
const { startServer } = await import('../../server/src/server.js')
const { BackupStore } = await import('../src/sync/BackupStore.js')
const { gateApp } = await import('../src/guard.js')
const { reviewMarkCss } = await import('../src/history/ReviewMarks.js')
const { ReviewStore, versionNames } = await import('../src/sync/Reviews.js')
const { AccountSettings } = await import('../src/sync/AccountSettings.js')
const { FakeAdapter } = await import('./stubs/fake-vault.js')
const Y = await import('yjs')

const root = mkdtempSync(join(tmpdir(), 'oc-join-selftest-'))
const server = await startServer(
  loadConfig({
    HOST: '127.0.0.1',
    PORT: '0',
    MYCEL_DATA_DIR: root,
    MYCEL_REGISTRATION: 'open',
    MYCEL_JWT_SECRET: 'join-selftest-secret-of-32-characters!'
  }),
  { logger: false, paceMs: 0 }
)
useServer(`ws://127.0.0.1:${server.port}`)

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)
const same = (a: Uint8Array | undefined, b: Uint8Array): boolean => a !== undefined && a.length === b.length && a.every((value, i) => value === b[i])

/** What the copy made before connecting holds, by vault path. */
function copied(device: Device): Map<string, Uint8Array> {
  const found = new Map<string, Uint8Array>()
  const copy = new RegExp(`^${PLUGIN_DIR.replace(/[./]/g, '\\$&')}/backups/\\d{4}-\\d{2}-\\d{2}/\\d{6} before connecting(?: \\(\\d+\\))?/(.+)$`)
  for (const [path, data] of device.vault.adapter.binaries) {
    const match = copy.exec(path)
    if (match?.[1]) found.set(match[1], data)
  }
  return found
}

const text = (data: Uint8Array | undefined): string | undefined => (data ? new TextDecoder().decode(data) : undefined)

const run = Date.now().toString(36)
const name = `jo${run}`
const PIC = bytes(1, 2, 3, 4)
const OLD_PIC = bytes(9, 9, 9)
const devices: Device[] = []
try {
  // --- backups never over one another --------------------------------------------
  {
    const adapter = new FakeAdapter()
    const gated = (gateApp({ vault: { adapter } } as never, PLUGIN_DIR) as unknown as { vault: { adapter: typeof adapter } }).vault.adapter
    const backups = new BackupStore(gated as never, PLUGIN_DIR)
    const when = new Date()
    const first = await backups.write('Note.md', 'local', 'one', when)
    const second = await backups.write('Note.md', 'local', 'two', when)
    check(first !== second && adapter.files.get(first) === 'one' && adapter.files.get(second) === 'two', 'two backups of one note in the same second each keep a file', [first, second])
    check((await backups.list()).length === 2, 'and both are listed')
    // Behind the gate, in the plugin's folder inside `.obsidian`: walking the folders from the top
    // of the vault asked about `.obsidian` itself, was refused, and no device could connect (0.9.20).
    const folder = await backups
      .copyVault(['Deep/er/Note.md'], async () => new TextEncoder().encode('kept').buffer as ArrayBuffer, undefined, when)
      .catch((error: unknown) => `refused: ${error instanceof Error ? error.message : String(error)}`)
    check(folder.startsWith(`${PLUGIN_DIR}/backups/`) && adapter.binaries.has(`${folder}/Deep/er/Note.md`), 'a copy of the vault is made in the plugin folder, behind the gate', folder)
  }

  // --- the first device: the server is empty --------------------------------------
  const A1 = new Device(name, true, {
    'One.md': 'first\n',
    'Two.md': 'second\nline added later\n',
    'Old.md': 'only the first device kept this\n',
    'pic.png': PIC
  })
  devices.push(A1)
  check(await A1.boot(), 'the first device starts')
  check(A1.joinPlans.length === 1 && A1.joinPlans[0]?.kind === 'upload', 'it was told the server is empty and its vault goes up', A1.joinPlans.map((plan) => plan.kind))
  const upload = A1.joinPlans[0]
  check(upload?.notes.onlyHere.length === 3 && upload.files.onlyHere.length === 1 && upload.backup.files === 4, 'with its three notes and one file, all copied first', upload && { notes: upload.notes, files: upload.files, backup: upload.backup })
  const firstCopy = copied(A1)
  check(
    firstCopy.size === 4 && text(firstCopy.get('Two.md')) === 'second\nline added later\n' && same(firstCopy.get('pic.png'), PIC),
    'the copy holds every file of the vault, byte for byte',
    Array.from(firstCopy.keys())
  )
  const firstResult = A1.joinResults[0]
  check(firstResult?.ok === true && firstResult.choice === 'merge' && typeof firstResult.backup === 'string', 'and the window was told where the copy is', firstResult)
  check(await eventually(() => A1.store?.trackedCount() === 3 && (A1.attachmentIndex?.live().length ?? 0) === 1), 'everything is in the index')
  // Taken in, not yet sent: a device after it found the server's index empty, now and then.
  check(await (A1.store?.whenAllSent(15_000) ?? false), 'and went up')

  // --- a restart is no first meeting ----------------------------------------------
  await A1.shutdown()
  check(await A1.boot(), 'the first device starts again')
  check(A1.joinPlans.length === 1, 'and is not asked again')
  // A device that synced before 0.9.19 has no record, only what it agreed on.
  await A1.shutdown()
  A1.vault.adapter.files.delete(`${PLUGIN_DIR}/joined.json`)
  check(await A1.boot(), 'a device that synced before without a record starts')
  check(A1.joinPlans.length === 1, 'and is not asked either: what it agreed on before says it knows the vault')

  // --- an empty vault: everything comes down --------------------------------------
  const A2 = new Device(name, false)
  devices.push(A2)
  check(await A2.boot(), 'an empty device starts')
  check(A2.joinPlans[0]?.kind === 'download', 'it was told everything comes from the server', A2.joinPlans.map((plan) => plan.kind))
  check(A2.joinResults[0]?.ok === true && (A2.joinResults[0] as { backup: string | null }).backup === null, 'nothing to copy in an empty vault')
  check(await eventually(() => A2.vault.text('One.md') === 'first\n' && same(A2.vault.bytes('pic.png'), PIC)), 'and it has the notes and the file')
  await A2.shutdown()

  // --- the same state: nothing to choose but connecting -----------------------------
  const A3 = new Device(name, false, { 'One.md': 'first\n', 'Two.md': 'second\nline added later\n', 'pic.png': PIC })
  devices.push(A3)
  check(await A3.boot(), 'a device with a copy of the same vault starts')
  const sameplan = A3.joinPlans[0]
  check(sameplan?.kind === 'same' && sameplan.notes.same.length === 2 && sameplan.files.same.length === 1, 'it was told every note and file it has, the server has alike', sameplan && { kind: sameplan.kind, notes: sameplan.notes, files: sameplan.files })
  check(sameplan?.notes.onlyThere.join() === 'Old.md', 'and that one note comes down', sameplan?.notes.onlyThere)
  check(await eventually(() => A3.vault.text('Old.md') === 'only the first device kept this\n'), 'it comes down')
  await delay(500)
  check(A3.vault.text('One.md') === 'first\n' && A3.vault.text('Two.md') === 'second\nline added later\n' && A3.reviews.length === 0, 'and nothing was merged or doubled')
  await A3.shutdown()

  // --- an older state: "Not now" touches nothing ----------------------------------------
  const olderFiles = {
    'One.md': 'first\n',
    'Two.md': 'second\nan old line deleted since\n',
    'Gone.md': 'deleted on the other devices long ago\n',
    'pic.png': OLD_PIC,
    'extra.png': bytes(7, 7)
  }
  const A4 = new Device(name, false, olderFiles)
  devices.push(A4)
  A4.joinAnswer = 'later'
  check(!(await A4.boot()) && A4.lastStart === 'waiting', 'a device with an older state asked, and "Not now" chosen: it does not start', A4.lastStart)
  const older = A4.joinPlans[0]
  check(older?.kind === 'related', 'it was told this is another state of the same vault', older?.kind)
  check(
    older?.notes.same.join() === 'One.md' &&
      older.notes.different.join() === 'Two.md' &&
      older.notes.onlyHere.join() === 'Gone.md' &&
      older.notes.onlyThere.join() === 'Old.md' &&
      older.files.different.join() === 'pic.png' &&
      older.files.onlyHere.join() === 'extra.png',
    'path by path: the same, different, only here, only on the server - notes and files',
    older && { notes: older.notes, files: older.files }
  )
  check(
    older?.merges.both.join() === 'Two.md' && older.merges.server.length === 0 && older.merges.here.length === 0,
    'and the note that differs has text of its own on both sides: merging keeps both, worth a look',
    older?.merges
  )
  await delay(800)
  check(
    A4.vault.text('Two.md') === olderFiles['Two.md'] && A4.vault.text('Gone.md') === olderFiles['Gone.md'] && same(A4.vault.bytes('pic.png'), OLD_PIC) && !A4.vault.text('Old.md'),
    'nothing of the vault was changed while it waits - not even by the notes read to compare'
  )
  check(copied(A4).size === 0 && A4.reviews.length === 0, 'no copy made, nothing merged')
  check(!(await eventually(() => A1.vault.text('Gone.md') !== undefined, 800)), 'and nothing of it reached the server')

  // --- "Take the server's version" ---------------------------------------------------
  A4.joinAnswer = 'server'
  check(await A4.joinAgain(), 'asked again, the server\'s version taken: it starts')
  check(A4.joinPlans.length === 2, 'after comparing once more')
  const taken = A4.joinResults.at(-1)
  check(taken?.ok === true && taken.choice === 'server' && taken.taken === 2 && taken.trashed === 2 && taken.notTaken.length === 0, 'two taken from the server, two only it had to the trash', taken)
  check(
    await eventually(
      () =>
        A4.vault.text('Two.md') === 'second\nline added later\n' &&
        same(A4.vault.bytes('pic.png'), PIC) &&
        A4.vault.text('Gone.md') === undefined &&
        A4.vault.bytes('extra.png') === undefined &&
        A4.vault.text('Old.md') === 'only the first device kept this\n'
    ),
    'the vault is as the server has it',
    A4.vault.paths()
  )
  const olderCopy = copied(A4)
  check(
    text(olderCopy.get('Two.md')) === olderFiles['Two.md'] &&
      text(olderCopy.get('Gone.md')) === olderFiles['Gone.md'] &&
      same(olderCopy.get('pic.png'), OLD_PIC) &&
      same(olderCopy.get('extra.png'), bytes(7, 7)),
    'and everything it had before is in the copy',
    Array.from(olderCopy.keys())
  )
  await delay(800)
  check(A4.reviews.length === 0 && !A4.vault.paths().some((path) => path.includes('conflict')), 'nothing merged, no file kept twice')
  check(
    A1.vault.text('Two.md') === 'second\nline added later\n' &&
      A1.vault.text('Gone.md') === undefined &&
      A1.vault.bytes('extra.png') === undefined &&
      same(A1.vault.bytes('pic.png'), PIC) &&
      A1.index?.live().length === 3 &&
      A1.index.deleted().length === 0 &&
      A1.attachmentIndex?.deleted().length === 0,
    'the other device saw nothing: no delete, no old text, nothing of the older state',
    { paths: A1.vault.paths(), deleted: A1.index?.deleted().length }
  )
  await A4.vault.userWrite('Two.md', 'second\nline added later\nwritten on the fourth device\n')
  check(await eventually(() => A1.vault.text('Two.md') === 'second\nline added later\nwritten on the fourth device\n'), 'and it syncs as any device from then on')
  await A4.shutdown()

  // --- a choice carried on after a restart ---------------------------------------------
  const vaultId = A1.keys?.vaultId ?? ''
  const A5 = new Device(name, false, { 'Two.md': 'an old text\n', 'Leftover.md': 'only here\n' })
  devices.push(A5)
  // As a device leaves it that stopped after the copy, while carrying out "the server's version".
  A5.vault.adapter.files.set(`${PLUGIN_DIR}/joined.json`, JSON.stringify({ [vaultId]: { at: Date.now(), choice: 'server', done: false, backup: `${PLUGIN_DIR}/backups/x` } }))
  check(await A5.boot(), 'a device that stopped while carrying out its choice starts')
  check(A5.joinPlans.length === 0, 'without being asked again')
  const resumed = A5.joinResults[0]
  check(resumed?.ok === true && resumed.resumed && resumed.choice === 'server' && resumed.taken === 1 && resumed.trashed === 1, 'it carried the choice on', resumed)
  check(
    await eventually(() => A5.vault.text('Two.md') === 'second\nline added later\nwritten on the fourth device\n' && A5.vault.text('Leftover.md') === undefined),
    'and its vault is as the server has it'
  )
  check(!(await eventually(() => A1.vault.text('Leftover.md') !== undefined, 800)), 'nothing of it reached the server')
  await A5.shutdown()

  // --- merging, as every device did before ----------------------------------------------
  const A6 = new Device(name, false, { 'One.md': 'first\nmerged in\n', 'Two.md': 'second\n', 'Mine.md': 'new on this device\n' })
  A6.deviceName = 'the sixth device'
  devices.push(A6)
  check(await A6.boot(), 'a device that merges starts')
  const merging = A6.joinPlans[0]
  check(merging?.kind === 'related', 'it was asked', merging?.kind)
  check(
    merging?.merges.here.join() === 'One.md' && merging.merges.server.join() === 'Two.md' && merging.merges.both.length === 0,
    "and told before choosing what merging makes of each note that differs: one holds all of the server's text, the server's holds all of the other",
    merging?.merges
  )
  check(await eventually(() => A1.vault.text('Mine.md') === 'new on this device\n'), 'what only it had went up')
  check(
    await eventually(
      () => A6.vault.text('One.md') === 'first\nmerged in\n' && A6.vault.text('Two.md') === 'second\nline added later\nwritten on the fourth device\n'
    ),
    'merged, each note became the longer version, as the window said',
    { one: A6.vault.text('One.md'), two: A6.vault.text('Two.md') }
  )
  check(
    await eventually(() => ['One.md', 'Two.md'].every((path) => A6.reviews.some((review) => review.path === path && review.kind === 'no-base'))),
    'and both are listed to look at',
    A6.reviews.map((review) => review.path)
  )
  const merged = A6.joinResults.at(-1)
  check(merged?.ok === true && merged.merging === 2, 'the window was told how many notes are merged and marked', merged)
  // Every device of the account shows them, and any of them can put them together (0.9.29).
  const elsewhere = (): Array<{ path: string; deviceId?: string; id: string }> => A1.sync?.reviews?.pending() ?? []
  check(
    await eventually(() => ['One.md', 'Two.md'].every((path) => elsewhere().some((review) => review.path === path && review.deviceId === A6.deviceId))),
    'another device of the account shows the notes to look at too, made on the device where they met',
    elsewhere()
  )
  // And the Time Machine marks the moments before (0.9.29): the device joining, and each merge.
  const marked = (): Array<{ kind: string; path?: string; choice?: string; device: string }> => A1.sync?.accountSettings?.events() ?? []
  check(
    await eventually(
      () =>
        marked().some((event) => event.kind === 'joined' && event.choice === 'merge' && event.device === A6.deviceName) &&
        ['One.md', 'Two.md'].every((path) => marked().some((event) => event.kind === 'merged' && event.path === path))
    ),
    'every device of the account has the marks: the device joining, merging both, and each note merged',
    marked()
  )
  const doneElsewhere = elsewhere().find((review) => review.path === 'One.md')
  if (doneElsewhere) await A1.sync?.reviews?.remove(doneElsewhere.id)
  check(
    await eventually(() => !(A6.sync?.reviews?.pending() ?? []).some((review) => review.path === 'One.md') && (A6.sync?.reviews?.pending() ?? []).some((review) => review.path === 'Two.md')),
    '"Done" on another device takes it off the list here too',
    A6.sync?.reviews?.pending().map((review) => review.path)
  )
  const marks = reviewMarkCss(['One.md', 'Deep/er/Note "q".md'])
  check(
    marks.includes('.nav-file-title[data-path="One.md"]') &&
      marks.includes('.nav-file-title[data-path="Deep/er/Note \\"q\\".md"]') &&
      marks.includes('.nav-folder-title[data-path="Deep"]') &&
      marks.includes('.nav-folder-title[data-path="Deep/er"]') &&
      !marks.includes('data-path=""'),
    'each note to look at is marked in the explorer by its path, and every folder above it',
    marks
  )
  {
    const reviews = new ReviewStore(new FakeAdapter() as never, PLUGIN_DIR)
    let told = 0
    reviews.onChange(() => (told += 1))
    const one = await reviews.add({ docId: 'd1', path: 'One.md', at: 1, kind: 'no-base', mine: 'a\n', theirs: 'b\n', merged: 'b\na\n' })
    await reviews.add({ docId: 'd2', path: 'Two.md', at: 2, kind: 'no-base', mine: 'a\n', theirs: 'b\n', merged: 'b\na\n' })
    const before = told
    await reviews.remove(one.id)
    check(
      reviews.pending().map((review) => review.path).join() === 'Two.md' && !reviews.pendingFor('d1') && told === before + 1,
      '"Done" takes a note off the list, and says so: its mark and "Compare versions" go with it',
      reviews.pending()
    )
  }
  {
    // Reviews in the account's settings, on two devices whose settings meet as the sync makes them (0.9.29).
    const here = new AccountSettings()
    const there = new AccountSettings()
    const meet = (): void => {
      Y.applyUpdate(there.doc, Y.encodeStateAsUpdate(here.doc), 'socket')
      Y.applyUpdate(here.doc, Y.encodeStateAsUpdate(there.doc), 'socket')
    }
    // Made before 0.9.29: in this device's plugin folder only.
    const folder = new FakeAdapter()
    const old = new ReviewStore(folder as never, PLUGIN_DIR)
    await old.add({ docId: 'd0', path: 'Old.md', at: 1, kind: 'no-base', mine: 'a\n', theirs: 'b\n', merged: 'b\na\n' })
    const mine = new ReviewStore(folder as never, PLUGIN_DIR, here, { id: 'aaaa1111', name: 'PC' })
    const theirs = new ReviewStore(new FakeAdapter() as never, PLUGIN_DIR, there, { id: 'bbbb2222', name: 'Laptop' })
    let told = 0
    theirs.onChange(() => (told += 1))
    await mine.list()
    const localLeft = Array.from(folder.files.keys()).filter((key) => key.includes('/reviews/'))
    meet()
    const moved = theirs.pending().find((review) => review.path === 'Old.md')
    check(
      localLeft.length === 0 && moved?.device === 'PC' && moved.deviceId === 'aaaa1111' && told > 0,
      'a review made before 0.9.29 moves into the settings, made on the device it lay on, and the other device is told',
      { localLeft, moved }
    )
    const fromHere = await mine.add({ docId: 'd1', path: 'One.md', at: 2, kind: 'conflict', mine: 'here\n', theirs: 'there\n', merged: 'here\nthere\n' })
    const fromThere = await theirs.add({ docId: 'd1', path: 'One.md', at: 3, kind: 'conflict', mine: 'laptop\n', theirs: 'there\n', merged: 'laptop\nthere\n' })
    meet()
    check(
      fromHere.id !== fromThere.id && mine.pending().filter((review) => review.docId === 'd1').length === 2,
      "the same note merged on two devices keeps each device's own version, side by side",
      mine.pending()
    )
    const again = await mine.add({ docId: 'd1', path: 'One.md', at: 4, kind: 'conflict', mine: 'later\n', theirs: 'there\n', merged: 'later\nthere\n' })
    check(
      again.id === fromHere.id && again.mine === 'here\n',
      "a later merge on the same device takes its earlier one's place, keeping that device's text from before either",
      again
    )
    check(
      versionNames(fromThere, 'aaaa1111').mine === 'On Laptop' && versionNames(fromHere, 'aaaa1111').mine === 'This device',
      '"This device" only where the versions met; elsewhere the device that had them is named',
      versionNames(fromThere, 'aaaa1111')
    )
    // Put together on the other device while this one merged the note again: the newer merge is news, and stays.
    await theirs.remove(fromHere.id)
    meet()
    check(mine.has(fromHere.id) && theirs.has(fromHere.id), 'a review put together on one device while another merged the note anew stays, with the newer merge', mine.pending())
    await theirs.remove(fromHere.id)
    meet()
    check(!mine.has(fromHere.id) && mine.has(fromThere.id), 'put together on one device, it is gone on the other - and only that one', mine.pending())
    const huge = 'x'.repeat(1_100_000)
    const large = await mine.add({ docId: 'd9', path: 'Huge.md', at: 5, kind: 'no-base', mine: huge, theirs: huge, merged: huge })
    meet()
    check(
      mine.has(large.id) && !theirs.has(large.id) && Array.from(folder.files.keys()).some((key) => key.endsWith(`${large.id}.json`)),
      'one too large for every device stays on the device where it was made, as all did before',
      theirs.pending().map((review) => review.path)
    )
    mine.stop()
    theirs.stop()
    here.destroy()
    there.destroy()
  }
  check(copied(A6).size === 3, 'after a copy of its vault')
  await A6.shutdown()

  // --- a note shown in an editor while the device joins (0.9.31) -------------------------------
  // Merged by the editor's binding instead of the file's reconcile: one that only took the longer
  // version there was never listed to look at.
  await A1.vault.userCreate('Open.md','kept open\nwritten on the first device\n')
  check(await eventually(() => A1.store?.noteState(A1.vault.file('Open.md')) === 'synced'), 'a note written on the first device reached the server')
  const A8 = new Device(name, false, { 'Open.md': 'kept open\n' })
  devices.push(A8)
  const shown = A8.open('Open.md')
  check(await A8.boot(), 'a device showing a note in an editor while it joins starts')
  check(A8.joinPlans[0]?.merges.server.join() === 'Open.md', "it was told the server's version holds all of its own", A8.joinPlans[0]?.merges)
  check(
    await eventually(() => shown.text() === 'kept open\nwritten on the first device\n'),
    'the editor took the longer version',
    shown.text()
  )
  check(
    await eventually(() => A8.reviews.some((review) => review.path === 'Open.md' && review.kind === 'no-base' && review.mine === 'kept open\n')),
    'and the note is listed to look at, as one merged in its file is',
    A8.reviews.map((review) => review.path)
  )
  A8.close(shown)
  await A8.shutdown()

  // --- Disconnect this vault (0.9.30) ----------------------------------------------------------
  {
    const vaultId = A1.keys?.vaultId as string
    const notes = (): string =>
      A1.vault
        .paths()
        .filter((path) => path.endsWith('.md'))
        .sort()
        .map((path) => `${path}=${A1.vault.text(path)}`)
        .join('|')
    const plugin = A1.pluginAdapter
    const exists = (path: string): Promise<boolean> => plugin.exists(`${PLUGIN_DIR}/${path}`)
    // What a device gathers: a safety copy, a note to compare too large for the account's settings, a copy of the Time Machine.
    const gathered = async (): Promise<void> => {
      for (const dir of ['backups', 'backups/2026-11-26', 'rollbacks', 'reviews', 'timemachine', 'timemachine/copies']) await plugin.mkdir(`${PLUGIN_DIR}/${dir}`)
      await plugin.write(`${PLUGIN_DIR}/backups/2026-11-26/Plan.md`, 'a copy\n')
      await plugin.write(`${PLUGIN_DIR}/rollbacks/before.json`, '{}')
      await plugin.write(`${PLUGIN_DIR}/reviews/large.json`, '{}')
      await plugin.write(`${PLUGIN_DIR}/timemachine/copies/1-1`, 'past')
    }
    check(await eventually(async () => (await A1.sync?.notYetSent(1_000)) === null), 'with everything sent, nothing is said to be missing')
    const before = notes()
    const asked = A1.joinPlans.length
    await gathered()
    await A1.shutdown()
    await A1.disconnect(vaultId)
    check(!A1.signedIn, 'disconnecting signs out')
    check(
      !A1.locals.has(`mycel/${vaultId}/idx`) && !(await exists('joined.json')) && !(await exists('state.json')),
      'its databases, what it agreed on and how it met the vault are gone',
      before
    )
    check(
      !(await exists('backups/2026-11-26/Plan.md')) && !(await exists('rollbacks/before.json')) && !(await exists('reviews/large.json')) && !(await exists('timemachine/copies/1-1')),
      'and so are the safety copies, the notes to compare kept here alone and the copies of the Time Machine'
    )
    check(notes() === before, 'the notes of the vault are not touched', { before, after: notes() })
    A1.joinAnswer = 'merge'
    check(await A1.boot(), 'signed in again, it starts')
    check(A1.joinPlans.length === asked + 1, 'and meets the vault as a new device: compared, and asked', A1.joinPlans.at(-1)?.kind)
    check(
      await eventually(() => notes() === before && !A1.vault.paths().some((path) => path.includes('conflict'))),
      'merging what it has with the server makes nothing twice: every note as before',
      { before, after: notes() }
    )

    // Kept on request; and a journal of the Time Machine keeps its copies whatever is chosen - they put the files back.
    await gathered()
    await plugin.write(`${PLUGIN_DIR}/timemachine/journal.jsonl`, '{"t":"start"}\n')
    await A1.shutdown()
    await A1.disconnect(vaultId, true)
    check(
      (await exists('backups/2026-11-26/Plan.md')) && (await exists('rollbacks/before.json')) && !(await exists('state.json')),
      'asked to, it keeps the safety copies and forgets the rest'
    )
    check((await exists('timemachine/copies/1-1')) && (await exists('timemachine/journal.jsonl')), 'and never the copies a journal of the Time Machine still needs')
    await plugin.remove(`${PLUGIN_DIR}/timemachine/journal.jsonl`)
    A1.joinAnswer = 'merge'
    check(await A1.boot(), 'and signed in again, it syncs once more')
  }
  {
    // The local history lets go of its database when the sync stops, and when someone deletes it: left open, it held
    // deleting it up - resetting a device waited twenty seconds and failed half done (0.9.29).
    const { indexedDB: fakeIndexedDb, IDBKeyRange: fakeKeyRange } = await import('fake-indexeddb')
    const globals = globalThis as unknown as Record<string, unknown>
    const madeWindow = globals.window === undefined
    if (madeWindow) globals.window = { setTimeout, clearTimeout }
    const win = globals.window as Record<string, unknown>
    const saved = { indexedDB: globals.indexedDB, IDBKeyRange: globals.IDBKeyRange, windowIndexedDB: win.indexedDB }
    globals.indexedDB = fakeIndexedDb
    globals.IDBKeyRange = fakeKeyRange
    win.indexedDB = fakeIndexedDb
    try {
      const { indexedDbHistory } = await import('../src/sync/History.js')
      const { deleteLocalStores } = await import('../src/sync/LocalStores.js')
      const names = async (): Promise<string[]> => (await fakeIndexedDb.databases()).map((each) => each.name ?? '').sort()
      const entry = { authorTs: 1, update: bytes(1, 2, 3) }
      const closedOne = indexedDbHistory('v-closed')
      closedOne.add('doc:a', entry)
      check(await eventually(async () => (await closedOne.entries('doc:a')).length === 1), 'the local history keeps a change')
      closedOne.close?.()
      let started = Date.now()
      check((await deleteLocalStores('v-closed')) === 1 && Date.now() - started < 2_000, 'closed with the sync, its database is deleted at once', Date.now() - started)
      const openOne = indexedDbHistory('v-open')
      openOne.add('doc:a', entry)
      check(await eventually(async () => (await openOne.entries('doc:a')).length === 1), 'another keeps one too, and stays open')
      started = Date.now()
      check((await deleteLocalStores('v-open')) === 1 && Date.now() - started < 2_000, 'still open, it lets go when its database is deleted', Date.now() - started)
      check(!(await names()).some((each) => each.startsWith('mycel-history/')), 'and neither is left', await names())
    } finally {
      globals.indexedDB = saved.indexedDB
      globals.IDBKeyRange = saved.IDBKeyRange
      win.indexedDB = saved.windowIndexedDB
      if (madeWindow) delete globals.window
    }
  }
  {
    // One Obsidian vault per vault of the server and computer (0.9.29): the claims they all see.
    const { VaultClaims, memoryClaimStorage } = await import('../src/sync/VaultClaims.js')
    const shared = memoryClaimStorage()
    const work = new VaultClaims(shared, { id: 'obsidian-a', name: 'Work' })
    const copy = new VaultClaims(shared, { id: 'obsidian-b', name: 'Work copy' })
    check(work.claim('v1') === null && work.mine('v1'), 'the first Obsidian vault to sync it holds it')
    const refused = copy.claim('v1')
    check(refused?.name === 'Work' && !copy.mine('v1') && work.mine('v1'), 'another on the same computer is told which one holds it, and takes nothing', refused)
    check(copy.claim('v2') === null && work.mine('v2') === false, 'another vault of the server is free for it')
    copy.take('v1')
    check(copy.mine('v1') && !work.mine('v1') && work.holder('v1')?.name === 'Work copy', 'taken over when asked, and the first one hears it no longer holds it')
    work.claim('v3')
    check(copy.held().join() === 'v1,v2' && work.held().join() === 'v3', 'each knows the vaults of the server it holds - whose databases are its own to clear', { copy: copy.held(), work: work.held() })
    work.release('v1')
    check(copy.mine('v1') && copy.holder('v1') !== null, 'disconnected, it lets go only of its own claims')
    copy.release('v1')
    check(copy.holder('v1') === null && work.claim('v1') === null, 'and another Obsidian vault here may then sync it unasked')
  }

  // --- another vault ----------------------------------------------------------------------
  const A7 = new Device(name, false, { 'Recipes/Bread.md': 'flour\n', 'Recipes/Soup.md': 'water\n', 'Recipes/Cake.md': 'sugar\n' })
  devices.push(A7)
  A7.joinAnswer = 'later'
  check(!(await A7.boot()), 'a device with another vault waits')
  check(A7.joinPlans[0]?.kind === 'unrelated', 'it was told the two have almost nothing in common', A7.joinPlans[0]?.kind)
  await A7.shutdown()

  // --- overwriting the server with this vault (0.9.33) ---------------------------------------
  {
    const { contentHash } = await import('@mycel/shared/crypto')
    const NEW_PIC = bytes(5, 5, 5)
    check(await eventually(async () => (await A1.sync?.notYetSent(1_000)) === null), 'the first device has sent everything')
    const before = { one: A1.vault.text('One.md'), two: A1.vault.text('Two.md') ?? '' }
    const A9 = new Device(name, false, { 'One.md': 'the ninth device wrote this\n', 'Two.md': before.two, 'pic.png': NEW_PIC, 'Ninth.md': 'only on the ninth device\n' })
    devices.push(A9)
    A9.joinAnswer = 'here'
    check(await A9.boot(), 'a device overwriting the server with its vault starts')
    const plan = A9.joinPlans[0]
    check(
      plan?.kind === 'related' && plan.notes.different.join() === 'One.md' && plan.files.different.join() === 'pic.png' && plan.notes.onlyHere.join() === 'Ninth.md',
      'it was told what differs, and what only it has',
      plan && { kind: plan.kind, notes: plan.notes, files: plan.files }
    )
    const gone = [...(plan?.notes.onlyThere ?? []), ...(plan?.files.onlyThere ?? [])]
    const result = A9.joinResults.at(-1)
    check(
      result?.ok === true && result.choice === 'here' && result.taken === 2 && gone.length > 0 && result.trashed === gone.length && result.notTaken.length === 0,
      'the note and the file that differ go up in its version, and what only the server had is deleted there',
      { result, gone }
    )
    check(
      await eventually(
        () =>
          A1.vault.text('One.md') === 'the ninth device wrote this\n' &&
          same(A1.vault.bytes('pic.png'), NEW_PIC) &&
          A1.vault.text('Ninth.md') === 'only on the ninth device\n' &&
          gone.every((path) => !A1.vault.paths().includes(path))
      ),
      "the other device follows: this vault's versions, what only it had, and what only the server had gone",
      A1.vault.paths()
    )
    check(A1.vault.text('Two.md') === before.two && !A1.vault.paths().some((path) => path.includes('conflict')), 'what was alike stays, nothing kept twice')
    const notesGone = gone.filter((path) => path.endsWith('.md'))
    check(
      notesGone.every((path) => A1.index?.deleted().some(({ entry }) => entry.path === path)),
      'the notes deleted on the server are in the trash, to restore',
      A1.index?.deleted().map(({ entry }) => entry.path)
    )
    const picId = A1.attachmentIndex?.idForPath('pic.png')
    const picEntry = picId ? A1.attachmentIndex?.entry(picId) : undefined
    check(picEntry?.prev === (await contentHash(PIC)), "the file's new version names the server's as the one it replaced, which stays among the versions", picEntry)
    await delay(500)
    check(
      A9.vault.text('One.md') === 'the ninth device wrote this\n' &&
        same(A9.vault.bytes('pic.png'), NEW_PIC) &&
        A9.reviews.length === 0 &&
        !A9.vault.paths().some((path) => path.includes('conflict') || gone.includes(path)),
      'its own vault stays as it was: nothing merged, nothing kept twice, nothing of the server pulled down',
      A9.vault.paths()
    )
    const remoteCopy = [...A9.vault.adapter.files].find(([path]) => path.startsWith(`${PLUGIN_DIR}/backups/`) && path.endsWith('.remote.md') && path.includes('One'))
    check(remoteCopy?.[1] === before.one, "the server's text of what it overwrote is backed up on the device first", remoteCopy?.[0])
    check(
      await eventually(() => (A1.sync?.accountSettings?.events() ?? []).some((event) => event.kind === 'joined' && event.choice === 'here')),
      'and the Time Machine marks the moment before, to go back to'
    )
    await A9.shutdown()
  }
} catch (error) {
  check(false, 'the self-test ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  for (const device of devices) await device.shutdown().catch(() => undefined)
  await server.close()
  rmSync(root, { recursive: true, force: true })
}
finish()
