// A server that lost its data, one that was restored from a backup, and an
// account the admin removed, with real devices. The server runs in this
// process on a port and in a directory of its own, so the test can stop it,
// change its data and start it again - which no other test can.
//
//   npm run test:recovery
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, delay, Device, eventually, finish, useServer, VAULT } from './harness.mjs'

const { docRoom } = await import('@obsidian-connect/shared')
const { KeyRing } = await import('../src/account/KeyRing.js')
const { NoteHistory } = await import('../src/history/NoteHistory.js')
const { AccountStore } = await import('../../server/src/accounts.js')
const { loadConfig } = await import('../../server/src/config.js')
const { startServer } = await import('../../server/src/server.js')

const root = mkdtempSync(join(tmpdir(), 'oc-recovery-selftest-'))
let port = 0

async function serve(dataDir: string) {
  const server = await startServer(
    loadConfig({
      HOST: '127.0.0.1',
      PORT: String(port),
      OBSIDIAN_CONNECT_DATA_DIR: dataDir,
      OBSIDIAN_CONNECT_REGISTRATION: 'open',
      OBSIDIAN_CONNECT_JWT_SECRET: 'recovery-selftest',
      // Content uploaded seconds ago may go when the test empties the trash.
      OBSIDIAN_CONNECT_PURGE_GRACE_S: '0'
    }),
    // Removed accounts are cleared within moments, not minutes.
    { logger: false, sweepMs: 200 }
  )
  port = server.port
  useServer(`ws://127.0.0.1:${port}`)
  return server
}

const run = Date.now().toString(36)
const live = join(root, 'live')
let server = await serve(live)

const PHOTO = 'Pictures/Secret photo.png'
const photo = new TextEncoder().encode('attachment-secret-content '.repeat(200))
const samePhoto = (data: Uint8Array | undefined): boolean => data !== undefined && data.length === photo.length && data.every((byte, index) => byte === photo[index])
/** Complete blobs in an account's folder on the server. */
const blobsOnServer = (dataDir: string, account: string): string[] => {
  const files: string[] = []
  const users = join(dataDir, 'users', account)
  if (!existsSync(users)) return files
  for (const vault of readdirSync(users)) {
    const dir = join(users, vault, 'blobs')
    if (existsSync(dir)) files.push(...readdirSync(dir).filter((name) => name.endsWith('.json')))
  }
  return files
}

const A1 = new Device(`anna${run}`, true, { 'One.md': 'first\n', 'Two.md': 'second\n', [PHOTO]: photo })
const A2 = new Device(`anna${run}`, false)
try {
  check(await A1.boot(), 'A1 creates the account')
  check(await A2.boot(), 'A2 signs in')
  check(await eventually(() => A2.vault.text('One.md') === 'first\n' && A2.vault.text('Two.md') === 'second\n'), 'A2 has both notes')
  check(await eventually(() => samePhoto(A2.vault.bytes(PHOTO))), 'and the attachment')
  // Changes spread over time, so the history has versions of its own.
  await delay(250)
  await A1.vault.userWrite('One.md', 'first\nmore\n')
  check(await eventually(() => A2.vault.text('One.md') === 'first\nmore\n'), 'an edit reaches A2')
  check(A1.asked === 0 && A2.asked === 0, 'nobody is asked while the server has what they saw')

  // What a compromised server has: every file it wrote, searched for what the
  // devices know in plain text.
  {
    const files: string[] = []
    // Every string in the server's JSON, decoded from base64 as well: that is
    // how anything would be carried there, and anyone reading it undoes it.
    const decodedStrings = (value: unknown): string[] => {
      if (typeof value === 'string') return [value, Buffer.from(value, 'base64').toString('latin1')]
      if (Array.isArray(value)) return value.flatMap(decodedStrings)
      if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, inner]) => [key, ...decodedStrings(inner)])
      return []
    }
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(path)
          continue
        }
        const raw = readFileSync(path)
        files.push(raw.toString('latin1'))
        if (entry.name.endsWith('.json')) files.push(...decodedStrings(JSON.parse(raw.toString('utf8'))))
      }
    }
    walk(live)
    const secrets = [`anna${run}`, VAULT, 'first', 'second', 'One.md', 'Two.md', 'Secret photo', 'Pictures', 'attachment-secret-content']
    const leaks = secrets.filter((secret) => files.some((file) => file.includes(secret)))
    check(
      files.length > 0 && blobsOnServer(live, A1.accountId).length === 1 && leaks.length === 0,
      'the server stores no name, vault name, note name, text, file name or file content',
      leaks
    )
  }

  // --- the server loses every note, keeps the accounts ---------------------------------
  await A2.shutdown()
  await server.close()
  const empty = join(root, 'empty')
  mkdirSync(empty, { recursive: true })
  // The accounts, and the server's id, which every account's salt includes.
  cpSync(join(live, 'accounts.json'), join(empty, 'accounts.json'))
  cpSync(join(live, 'server.json'), join(empty, 'server.json'))
  A1.recoveryAnswer = 'device'
  server = await serve(empty)
  check(await eventually(() => A1.asked === 1, 20_000), 'A1 notices the server has other data and asks', A1.asked)
  await A1.recovery?.settled()
  check(A1.vault.text('One.md') === 'first\nmore\n' && A1.vault.text('Two.md') === 'second\n', 'and its notes are untouched')
  check(samePhoto(A1.vault.bytes(PHOTO)), 'as is its attachment')
  check(
    await eventually(() => blobsOnServer(empty, A1.accountId).length === 1, 15_000),
    'which it uploads again by itself: the server had lost its content'
  )

  const A3 = new Device(`anna${run}`, false)
  try {
    check(await A3.boot(), 'a new device signs in after the loss')
    check(
      await eventually(() => A3.vault.text('One.md') === 'first\nmore\n' && A3.vault.text('Two.md') === 'second\n', 15_000),
      'and gets every note A1 uploaded again',
      A3.vault.paths().map((path) => [path, A3.vault.text(path)])
    )
    check(await eventually(() => samePhoto(A3.vault.bytes(PHOTO)), 15_000), 'and the attachment')
    const docId = A3.index?.docIdForPath('One.md') as string
    const history = new NoteHistory(A3.api, docRoom(docId), (A3.keys as InstanceType<typeof KeyRing>).ownDocCrypto(docId), 100)
    await history.load()
    const texts = history.versions().map((version) => history.textAt(version.seq))
    check(texts.includes('first\n') && texts[0] === 'first\nmore\n', 'with its history, in the order it was written', texts)
  } finally {
    await A3.shutdown()
  }

  check(await A2.boot(), 'A2 comes back after the loss')
  await delay(3_000)
  check(A2.asked === 0, 'and follows the answer A1 gave, without asking', A2.asked)
  check(await eventually(() => A2.vault.text('One.md') === 'first\nmore\n'), 'keeping its notes as they are')

  // --- the server is restored from an older backup -------------------------------------
  // A backup is taken with the server stopped; it starting again on the very
  // same data must raise no question.
  await server.close()
  const backup = join(root, 'backup')
  cpSync(empty, backup, { recursive: true })
  server = await serve(empty)
  await A1.vault.userWrite('One.md', 'first\nmore\nafter the backup\n')
  await A1.vault.userCreate('Three.md', 'written after the backup\n')
  check(
    await eventually(
      () => A2.vault.text('One.md') === 'first\nmore\nafter the backup\n' && A2.vault.text('Three.md') === 'written after the backup\n',
      20_000
    ),
    'what A1 writes after the backup reaches A2'
  )
  check(A1.asked === 1 && A2.asked === 0, 'a server that only restarted raises no question', { a1: A1.asked, a2: A2.asked })

  // A2 goes away having seen it; the server loses it again.
  await A2.shutdown()
  await server.close()
  rmSync(empty, { recursive: true, force: true })
  cpSync(backup, empty, { recursive: true })
  A1.recoveryAnswer = 'server'
  const backupsBefore = A1.vault.adapter.backups().length
  server = await serve(empty)
  check(await eventually(() => A1.asked === 2, 20_000), 'A1 notices the restored server and asks again', A1.asked)
  await A1.recovery?.settled()
  check(
    await eventually(() => A1.vault.text('One.md') === 'first\nmore\n'),
    "taking the server's copy rolls the note back",
    A1.vault.text('One.md')
  )
  check(A1.vault.adapter.backups().length > backupsBefore, "after backing up this device's newer text")
  check(A1.vault.text('Three.md') === 'written after the backup\n', 'a note the backup did not know stays')

  // The restored log grows past where A2 stood before A2 returns: its seq
  // numbers alone would look like frames it already has.
  let latest = 'first\nmore\n'
  for (let i = 1; i <= 6; i += 1) {
    latest = `${latest}again ${i}\n`
    await A1.vault.userWrite('One.md', latest)
    await delay(120)
  }
  check(
    await eventually(() => A1.socket?.isSettled(docRoom(A1.index?.docIdForPath('One.md') as string)) === true),
    'A1 writes on after the rollback'
  )

  const a2BackupsBefore = A2.vault.adapter.backups().length
  check(await A2.boot(), 'A2 comes back after the restore')
  check(await eventually(() => A2.vault.text('One.md') === latest, 15_000), 'its copy rolls back, to what A1 wrote since', A2.vault.text('One.md'))
  check(A2.asked === 0, 'following the answer A1 gave, without asking', A2.asked)
  check(A2.vault.adapter.backups().length > a2BackupsBefore, 'with a backup of what it had')
  check(A2.vault.text('Three.md') === 'written after the backup\n', 'and keeping the note the backup did not know')

  // --- the device that answers had written the newer text itself, a moment ago ---------
  // As a rule the merge backs up nothing this device wrote a moment before;
  // here that text is exactly what a rollback throws away.
  await server.close()
  const backup2 = join(root, 'backup2')
  cpSync(empty, backup2, { recursive: true })
  server = await serve(empty)
  const lastWords = `${latest}written just before the restore\n`
  await A1.vault.userWrite('One.md', lastWords)
  check(await eventually(() => A2.vault.text('One.md') === lastWords, 15_000), 'A2 receives a last edit')
  A1.recoveryAnswer = null
  A2.recoveryAnswer = 'server'
  const askedBefore = A2.asked
  await server.close()
  rmSync(empty, { recursive: true, force: true })
  cpSync(backup2, empty, { recursive: true })
  server = await serve(empty)
  check(await eventually(() => A2.asked === askedBefore + 1, 20_000), 'A2 is asked right away', A2.asked)
  await A2.recovery?.settled()
  check(await eventually(() => A2.vault.text('One.md') === latest), 'and rolls back', A2.vault.text('One.md'))
  const kept = await Promise.all(A2.vault.adapter.backups().map((path) => A2.vault.adapter.read(path)))
  check(kept.some((text) => text.includes('written just before the restore')), 'keeping the text it had just written itself in a backup')

  // --- the server lets go of content nothing needs any more ------------------------------
  {
    const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text.repeat(100))
    const same = (a: Uint8Array | undefined, b: Uint8Array): boolean => a !== undefined && a.length === b.length && a.every((byte, i) => byte === b[i])
    const SCAN = 'Pictures/scan.png'
    const OLD = 'Pictures/old.png'
    await A1.vault.userCreateBinary(SCAN, bytesOf('first scan '))
    check(await eventually(() => same(A2.vault.bytes(SCAN), bytesOf('first scan '))), 'A2 gets a scan')
    await A1.vault.userWriteBinary(SCAN, bytesOf('second scan '))
    check(await eventually(() => same(A2.vault.bytes(SCAN), bytesOf('second scan '))), 'and its second version')
    await A1.vault.userCreateBinary(OLD, bytesOf('soon deleted '))
    check(await eventually(() => same(A2.vault.bytes(OLD), bytesOf('soon deleted '))), 'and a picture')
    await A1.vault.trash(A1.vault.file(OLD))
    check(await eventually(() => A2.vault.bytes(OLD) === undefined), 'which A1 deletes')
    // A copy of the scan, deleted: its content is the scan's, which lives on.
    await A1.vault.userCreateBinary('Pictures/scan copy.png', bytesOf('second scan '))
    check(await eventually(() => same(A2.vault.bytes('Pictures/scan copy.png'), bytesOf('second scan '))), 'and a copy of the scan')
    await A1.vault.trash(A1.vault.file('Pictures/scan copy.png'))
    check(await eventually(() => A2.vault.bytes('Pictures/scan copy.png') === undefined), 'which A1 deletes too')
    const before = blobsOnServer(empty, A1.accountId).length

    A1.retentionDays = 1e-9
    await A1.trash?.purge()
    A1.retentionDays = 30
    check(
      blobsOnServer(empty, A1.accountId).length === before - 2,
      'past the retention the server lets go of the earlier version and the deleted file',
      { before, after: blobsOnServer(empty, A1.accountId).length }
    )
    check(
      await eventually(() => !A2.trash?.list().some((item) => item.path === OLD)),
      'no device offers the deleted file any more'
    )
    check(
      same(A1.vault.bytes(SCAN), bytesOf('second scan ')) && samePhoto(A1.vault.bytes(PHOTO)) && same(A2.vault.bytes(SCAN), bytesOf('second scan ')),
      'every file that lives is untouched'
    )
    check((await A1.attachments?.heal()) === 0, 'and the server still has all their content')
  }

  // --- the admin removes the account of someone who shared a note -------------------------
  // One device of the participant is there when it happens, the other away,
  // with an edit made meanwhile.
  const P1 = new Device(`piet${run}`, true)
  const P2 = new Device(`piet${run}`, false)
  try {
    check(await P1.boot(), 'someone else creates an account')
    check(await P2.boot(), 'with a second device')
    const code = await (A1.contacts as NonNullable<typeof A1.contacts>).createCode()
    await P1.contacts?.redeem(code)
    check(
      await eventually(() => A1.contacts?.isContact(P1.accountId) === true && P1.contacts?.isContact(A1.accountId) === true),
      'and becomes a contact of A'
    )
    await A1.vault.userCreate('Shared.md', 'from anna\n')
    check(await eventually(() => A1.docText('Shared.md') === 'from anna\n'), 'A writes a note')
    await delay(250)
    await A1.vault.userWrite('Shared.md', 'from anna\nand more\n')
    const sharedId = A1.index?.docIdForPath('Shared.md') as string
    check(await eventually(() => A1.socket?.isSettled(docRoom(sharedId)) === true), 'in two steps')
    await A1.sharing?.share(sharedId, P1.accountId, 'write', true)
    check(
      await eventually(() => P1.vault.text('Shared/Shared.md') === 'from anna\nand more\n' && P2.vault.text('Shared/Shared.md') === 'from anna\nand more\n'),
      'and shares it with both of P\'s devices'
    )
    await P2.shutdown()
    // Text replaced, not only added: without the last agreed text the two
    // versions could only be unioned, and the old words would stay in.
    const together = 'from anna\nand less, as P2 changed it while away\n'
    P2.vault.offlineWrite('Shared/Shared.md', together)
    // P1's own copy of the history is gone - pruned, say - so what the
    // server kept is all the history there is.
    await P1.locals.history.clear(docRoom(sharedId))

    await new AccountStore(empty).remove(A1.accountId)
    const carriedOn = (): string | undefined => {
      const id = P1.index?.docIdForPath('Shared/Shared.md')
      return id && id !== sharedId && P1.store?.entry(id)?.owner === undefined ? id : undefined
    }
    check(await eventually(() => Boolean(carriedOn()), 20_000), "when A's account is removed, P keeps the note as one of her own")
    check(P1.vault.text('Shared/Shared.md') === 'from anna\nand more\n', 'text and all')
    {
      const id = carriedOn() as string
      const history = new NoteHistory(P1.api, docRoom(id), (P1.keys as InstanceType<typeof KeyRing>).ownDocCrypto(id), 100)
      await history.load()
      const texts = history.versions().map((version) => history.textAt(version.seq))
      check(texts.includes('from anna\n') && texts[0] === 'from anna\nand more\n', 'with its whole history', texts)
    }
    check(!existsSync(join(empty, 'users', A1.accountId)), "and A's data is gone from the server")

    check(await P2.boot(), 'P2 comes back')
    check(
      await eventually(
        () =>
          P2.index?.docIdForPath('Shared/Shared.md') === carriedOn() &&
          P2.vault.text('Shared/Shared.md') === together &&
          P1.vault.text('Shared/Shared.md') === together,
        15_000
      ),
      'carries on in the same note, and what it wrote while away reaches P1',
      { p1: P1.vault.text('Shared/Shared.md'), p2: P2.vault.text('Shared/Shared.md') }
    )
  } finally {
    await P1.shutdown()
    await P2.shutdown()
  }
} catch (error) {
  check(false, 'the scenario ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  await A1.shutdown()
  await A2.shutdown()
  await server.close()
  rmSync(root, { recursive: true, force: true })
}

finish()
