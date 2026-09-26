// A server that lost its data, and one that was restored from a backup, with
// real devices. The server runs in this process on a port and in a directory
// of its own, so the test can stop it, change its data and start it again -
// which no other test can.
//
//   npm run test:recovery
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, delay, Device, eventually, finish, useServer, VAULT } from './harness.mjs'

const { docRoom } = await import('@obsidian-connect/shared')
const { KeyRing } = await import('../src/account/KeyRing.js')
const { NoteHistory } = await import('../src/history/NoteHistory.js')
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
      OBSIDIAN_CONNECT_JWT_SECRET: 'recovery-selftest'
    }),
    { logger: false }
  )
  port = server.port
  useServer(`ws://127.0.0.1:${port}`)
  return server
}

const run = Date.now().toString(36)
const live = join(root, 'live')
let server = await serve(live)

const A1 = new Device(`anna${run}`, true, { 'One.md': 'first\n', 'Two.md': 'second\n' })
const A2 = new Device(`anna${run}`, false)
try {
  check(await A1.boot(), 'A1 creates the account')
  check(await A2.boot(), 'A2 signs in')
  check(await eventually(() => A2.vault.text('One.md') === 'first\n' && A2.vault.text('Two.md') === 'second\n'), 'A2 has both notes')
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
    const secrets = [`anna${run}`, VAULT, 'first', 'second', 'One.md', 'Two.md']
    const leaks = secrets.filter((secret) => files.some((file) => file.includes(secret)))
    check(files.length > 0 && leaks.length === 0, 'the server stores no name, vault name, note name or text', leaks)
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

  const A3 = new Device(`anna${run}`, false)
  try {
    check(await A3.boot(), 'a new device signs in after the loss')
    check(
      await eventually(() => A3.vault.text('One.md') === 'first\nmore\n' && A3.vault.text('Two.md') === 'second\n', 15_000),
      'and gets every note A1 uploaded again',
      A3.vault.paths().map((path) => [path, A3.vault.text(path)])
    )
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
} catch (error) {
  check(false, 'the scenario ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  await A1.shutdown()
  await A2.shutdown()
  await server.close()
  rmSync(root, { recursive: true, force: true })
}

finish()
