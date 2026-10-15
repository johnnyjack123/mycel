// The backup server's run against real devices and a real restic: a sync
// server in this process, devices writing notes and files, a backup into
// local repositories, read back with restic and tar and compared with the
// vault. The server runs here so the test can restore an old copy of it.
//
//   npm run test:backup            (restic on the PATH, or OBSIDIAN_CONNECT_RESTIC naming it)
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import { check, delay, Device, eventually, failures, finish, useServer, VAULT } from './harness.mjs'

const { loadConfig } = await import('../../server/src/config.js')
const { startServer } = await import('../../server/src/server.js')
const { runBackup } = await import('../../backup/src/run.js')
const { Restic } = await import('../../backup/src/restic.js')
const { silence } = await import('../../backup/src/log.js')
const { safePath, vaultFolder, withSuffix } = await import('../../backup/src/layout.js')
const { TarWriter } = await import('../../backup/src/tar.js')
const { TarHasher } = await import('../../backup/src/tarcheck.js')
const { alignTrusted, TrustedRefused } = await import('../../backup/src/trusted.js')

type RunReport = Awaited<ReturnType<typeof runBackup>>

const RESTIC = process.env.OBSIDIAN_CONNECT_RESTIC ?? 'restic'
const probe = spawnSync(RESTIC, ['version'], { encoding: 'utf8' })
if (probe.status !== 0) {
  console.log(`FAIL: restic is needed: put it on the PATH or name it in OBSIDIAN_CONNECT_RESTIC (tried "${RESTIC}")`)
  process.exit(1)
}
console.log(`using ${probe.stdout.trim()}`)
silence(true)

const root = mkdtempSync(join(tmpdir(), 'oc-backup-selftest-'))
const run = Date.now().toString(36)
let port = 0

async function serve(dataDir: string) {
  const server = await startServer(
    loadConfig({
      HOST: '127.0.0.1',
      PORT: String(port),
      OBSIDIAN_CONNECT_DATA_DIR: dataDir,
      OBSIDIAN_CONNECT_REGISTRATION: 'open',
      OBSIDIAN_CONNECT_JWT_SECRET: 'backup-selftest'
    }),
    { logger: false, paceMs: 0 }
  )
  port = server.port
  useServer(`ws://127.0.0.1:${port}`)
  return server
}

const sha = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex')
const same = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean => a !== undefined && b !== undefined && Buffer.from(a).equals(Buffer.from(b))
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

/** restic on the command line, the way a person restores with it. */
function restic(repository: string, password: string, args: string[], cwd?: string): { status: number | null; stdout: Buffer; stderr: string } {
  const result = spawnSync(RESTIC, args, {
    cwd,
    env: { ...process.env, RESTIC_REPOSITORY: repository, RESTIC_PASSWORD: password, RESTIC_CACHE_DIR: join(root, 'restic-cache') },
    maxBuffer: 256 * 1024 * 1024
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr.toString('utf8') }
}

/** Every file below a folder, by its path relative to it with forward slashes. */
function filesBelow(dir: string): Map<string, Buffer> {
  const found = new Map<string, Buffer>()
  if (!existsSync(dir)) return found
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else found.set(relative(dir, path).split('\\').join('/'), readFileSync(path))
    }
  }
  walk(dir)
  return found
}

/** A plain tar - the system's - unpacking a stream this backup server wrote. */
function untar(archive: string, into: string): boolean {
  mkdirSync(into, { recursive: true })
  const windowsTar = 'C:\\Windows\\System32\\tar.exe'
  const tar = process.platform === 'win32' && existsSync(windowsTar) ? windowsTar : 'tar'
  // Relative paths: GNU tar takes `C:` for a remote host.
  const result = spawnSync(tar, ['-xf', relative(root, archive), '-C', relative(root, into)], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) console.log('      tar:', result.stderr)
  return result.status === 0
}

// --- the parts on their own --------------------------------------------------------
{
  check(safePath('../../etc/passwd') === '__/__/etc/passwd' && safePath('/abs//x/./y.md') === 'abs/x/y.md', 'a path never leaves its folder')
  check(vaultFolder('a/b') === 'a_b' && vaultFolder('..') === '_' && vaultFolder('  ') === '_', "a vault's name is one folder")
  check(withSuffix('a/b.md', ' (2)') === 'a/b (2).md' && withSuffix('a/.hidden', ' (2)') === 'a/.hidden (2)', 'a suffix goes before the extension')

  const long = `Bilder/${'Ein sehr langer Name mit Umlauten äöü, '.repeat(4)}Ende.png`
  const stream = new PassThrough()
  const parts: Buffer[] = []
  stream.on('data', (chunk: Buffer) => parts.push(chunk))
  const tar = new TarWriter(stream)
  const content = bytes('x'.repeat(1300))
  async function* once(data: Uint8Array): AsyncGenerator<Uint8Array> {
    yield data
  }
  await tar.file('short.txt', 5, Date.now(), once(bytes('hello')))
  await tar.file(long, content.length, Date.now(), once(content))
  await tar.end()
  stream.end()
  const archive = Buffer.concat(parts)
  const hasher = new TarHasher()
  hasher.write(archive.subarray(0, 700))
  hasher.write(archive.subarray(700))
  check(
    hasher.complete && hasher.hashes.get('short.txt') === sha('hello') && hasher.hashes.get(long) === sha(content),
    'the tar stream reads back, a long name with umlauts included',
    Array.from(hasher.hashes.keys())
  )
  const lying = new TarWriter(new PassThrough())
  check(
    (await lying.file('x', 10, 0, once(bytes('short'))).then(
      () => 'written',
      () => 'refused'
    )) === 'refused',
    'a file shorter than its header promised breaks the stream'
  )
  const archivePath = join(root, 'probe.tar')
  writeFileSync(archivePath, archive)
  check(untar(archivePath, join(root, 'probe')) && readFileSync(join(root, 'probe', ...long.split('/'))).equals(Buffer.from(content)), "and the system's tar unpacks it")

  const foreign = join(root, 'foreign')
  mkdirSync(foreign)
  writeFileSync(join(foreign, 'mine.txt'), 'not yours')
  const refused = await alignTrusted(foreign, 'v', [], new Set(), null as never, null as never).then(
    () => null,
    (error: unknown) => error
  )
  check(refused instanceof TrustedRefused && readFileSync(join(foreign, 'mine.txt'), 'utf8') === 'not yours', 'the trusted copy never takes over a folder someone else filled')
}

const PHOTO = 'Bilder/Foto.png'
const LONG = `Bilder/${'Ein Bild mit einem sehr langen Namen, '.repeat(3)}ä ö ü.png`
const photo = bytes('photo-bytes '.repeat(3000))
const longPhoto = bytes('long-photo '.repeat(500))
const board = bytes(JSON.stringify({ nodes: [{ id: '1', type: 'text', text: 'card' }], edges: [] }))
const DEEP = `Ünïcødé Ordner/${'Eine Notiz mit langem Namen '.repeat(4)}.md`

let server = await serve(join(root, 'server'))
const A1 = new Device(`anna${run}`, true, {
  'Welcome.md': 'hello\n',
  'Projects/Plan.md': 'the plan\n',
  [DEEP]: 'deep text\n',
  [PHOTO]: photo,
  [LONG]: longPhoto,
  'Board.canvas': board
})
const A2 = new Device(`anna${run}`, false)
const B = new Device(`ben${run}`, true)
const devices = [A1, A2, B]

const destinations = [
  { id: 'local', repository: join(root, 'repo-a'), password: 'password a', keep: { last: 50 } },
  { id: 'second', repository: join(root, 'repo-b'), password: 'password b' }
]
const trustedDir = join(root, 'trusted')
const options = {
  dataDir: join(root, 'backup-server'),
  workDir: join(root, 'ram'),
  restic: new Restic(RESTIC, join(root, 'restic-cache'), 'obsidian-connect-backup'),
  samples: 3
}
const folder = vaultFolder(VAULT)

/** Every note and file of a device's vault, as the backup should hold it below the vault's folder. */
function expectedVault(device: Device): Map<string, Buffer> {
  const expected = new Map<string, Buffer>()
  for (const path of device.vault.paths()) expected.set(`${folder}/${path}`, Buffer.from(device.vault.text(path) ?? '', 'utf8'))
  for (const path of device.vault.attachmentPaths()) expected.set(`${folder}/${path}`, Buffer.from(device.vault.bytes(path) ?? new Uint8Array()))
  return expected
}

/** The notes snapshot restored and the files stream unpacked into one folder, as a person would restore. */
function restore(report: RunReport, destination: (typeof destinations)[number], name: string): Map<string, Buffer> {
  const target = join(root, name)
  const own = report.destinations.find((entry) => entry.id === destination.id)
  const restored = restic(destination.repository, destination.password, ['restore', own?.notesSnapshot ?? 'none', '--target', target])
  if (restored.status !== 0) console.log('      restore:', restored.stderr)
  const archive = join(root, `${name}.tar`)
  const dumped = restic(destination.repository, destination.password, ['dump', own?.filesSnapshot ?? 'none', `/${folder} files.tar`])
  writeFileSync(archive, dumped.stdout)
  untar(archive, target)
  return filesBelow(target)
}

function sameFiles(actual: Map<string, Buffer>, expected: Map<string, Buffer>, prefix: string): { missing: string[]; differ: string[] } {
  const missing: string[] = []
  const differ: string[] = []
  for (const [path, data] of expected) {
    const got = actual.get(path)
    if (!got) missing.push(path)
    else if (!got.equals(data)) differ.push(path)
  }
  for (const path of actual.keys()) if (path.startsWith(prefix) && !expected.has(path)) differ.push(`extra ${path}`)
  return { missing, differ }
}

const job = (grant: Awaited<ReturnType<Device['makeBackupGrant']>>) => ({
  id: 'job-a',
  grant,
  config: { destinations, trusted: trustedDir }
})

try {
  for (const device of devices) check(await device.boot(), `${device.username} starts`)
  A1.settings?.set({ historyRetentionDays: 30 })
  const code = await (A1.contacts as NonNullable<typeof A1.contacts>).createCode()
  await B.contacts?.redeem(code)
  check(await eventually(() => B.contacts?.name(A1.accountId) !== undefined && A1.contacts?.name(B.accountId) !== undefined), 'A and B are contacts')
  await B.vault.userCreate('From Ben.md', 'written by ben\n')
  check(await eventually(() => B.docText('From Ben.md') === 'written by ben\n'), 'B has a note')
  await B.sharing?.share(B.index?.docIdForPath('From Ben.md') as string, A1.accountId, 'write', true)
  check(await eventually(() => A2.vault.text('Shared/From Ben.md') === 'written by ben\n', 15_000), "B's note is shared into A's vault")
  check(
    await eventually(() => A2.vault.text('Welcome.md') === 'hello\n' && A2.vault.text(DEEP) === 'deep text\n' && same(A2.vault.bytes(LONG), longPhoto) && same(A2.vault.bytes('Board.canvas'), board), 15_000),
    'the server has the whole vault'
  )

  const grant = await A1.makeBackupGrant('test backup server')
  check(grant.vaultName === VAULT && grant.backupKey.length > 0 && grant.server.startsWith('ws://'), 'a device grants a backup server its vault')

  // --- the first run ---------------------------------------------------------------
  const first = await runBackup(job(grant), options)
  check(first.ok && first.destinations.every((entry) => entry.ok), 'the first backup goes into both destinations and checks out', first)
  check(first.destinations.every((entry) => entry.checked === 'deep'), 'the first check of a destination reads it back in full')
  for (const destination of destinations) {
    const restored = restore(first, destination, `restore-1-${destination.id}`)
    const { missing, differ } = sameFiles(restored, expectedVault(A1), `${folder}/`)
    check(missing.length === 0 && differ.length === 0, `restored with restic and tar from ${destination.id}, the vault is all there - notes, files, canvas, shared note`, { missing, differ })
    const settings = restored.get(`${folder} settings.json`)?.toString('utf8') ?? ''
    check(settings.includes('historyRetentionDays') && !settings.includes('contact:') && !settings.includes('code:'), 'with the settings, without contacts and codes', settings)
  }
  {
    const { missing, differ } = sameFiles(filesBelow(trustedDir), expectedVault(A1), `${folder}/`)
    check(missing.length === 0 && differ.length === 0, 'the trusted copy holds the vault', { missing, differ })
  }
  {
    // The backup server's disk: the cache and the state - nothing readable.
    const leaked: string[] = []
    for (const [path, data] of filesBelow(options.dataDir)) {
      const text = data.toString('latin1')
      for (const secret of ['hello', 'the plan', 'deep text', 'written by ben', 'photo-bytes', 'card']) if (text.includes(secret)) leaked.push(`${path}: ${secret}`)
    }
    check(leaked.length === 0, "the backup server's own disk holds no plaintext", leaked)
    check(!existsSync(join(options.workDir, 'job-a')), 'and the RAM disk is empty again after the run')
  }

  // --- nothing changed ---------------------------------------------------------------
  const second = await runBackup(job(grant), options)
  check(second.ok && second.fetched.rooms === 0 && second.fetched.blobs === 0, 'a run with nothing changed fetches nothing', second.fetched)
  check(second.destinations.every((entry) => entry.filesUnchanged === true && entry.checked === 'quick'), 'and makes no new files snapshot', second.destinations)
  check(second.trusted?.written === 0 && second.trusted.deleted === 0, 'and writes nothing into the trusted copy', second.trusted)

  // --- a note changes, one is added ---------------------------------------------------
  await A1.vault.userWrite('Welcome.md', 'hello again\n')
  await A1.vault.userCreate('New.md', 'a new note\n')
  check(await eventually(() => A2.vault.text('Welcome.md') === 'hello again\n' && A2.vault.text('New.md') === 'a new note\n'), 'A edits a note and adds one')
  const third = await runBackup(job(grant), options)
  check(third.ok && third.fetched.rooms > 0 && third.fetched.rooms <= 4, 'only the rooms that changed are fetched', third.fetched)
  {
    const diff = restic(destinations[0].repository, destinations[0].password, ['diff', first.destinations[0]?.notesSnapshot ?? '', third.destinations[0]?.notesSnapshot ?? ''])
    const changed = diff.stdout
      .toString('utf8')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => /^[+\-M]\s/.test(line) && !line.endsWith('/'))
      .map((line) => line.replace(/\s+/, ' '))
      .sort()
    check(
      changed.join('|') === [`+ /${folder}/New.md`, `M /${folder}/Welcome.md`].sort().join('|'),
      'restic diff between two backups names exactly the notes that changed',
      changed
    )
  }
  check(third.destinations.every((entry) => entry.filesUnchanged === true), 'no file changed, so no files snapshot')
  check(third.trusted?.written === 2, 'the trusted copy writes the two notes and nothing else', third.trusted)
  check(readFileSync(join(trustedDir, folder, 'Welcome.md'), 'utf8') === 'hello again\n', 'and has the edit')

  // --- a file is added -----------------------------------------------------------------
  const added = bytes('another picture '.repeat(100))
  await A1.vault.userCreateBinary('Bilder/Neu.png', added)
  check(await eventually(() => same(A2.vault.bytes('Bilder/Neu.png'), added)), 'A adds a picture')
  const fourth = await runBackup(job(grant), options)
  check(fourth.ok && fourth.destinations.every((entry) => entry.filesUnchanged !== true && entry.filesSnapshot), 'a new file makes a new files snapshot', fourth.destinations)
  {
    const dumped = restic(destinations[1].repository, destinations[1].password, ['dump', fourth.destinations[1]?.filesSnapshot ?? '', `/${folder} files.tar`])
    const hasher = new TarHasher()
    hasher.write(dumped.stdout)
    check(hasher.hashes.get(`${folder}/Bilder/Neu.png`) === sha(added) && hasher.hashes.get(`${folder}/${PHOTO}`) === sha(photo), 'with the new picture and the old ones in it')
  }

  // --- a note is deleted -----------------------------------------------------------------
  await A1.vault.trash(A1.vault.file('Projects/Plan.md'))
  check(await eventually(() => A2.vault.text('Projects/Plan.md') === undefined), 'A deletes a note')
  const fifth = await runBackup(job(grant), options)
  {
    const restored = restore(fifth, destinations[0], 'restore-5')
    check(
      fifth.ok && !restored.has(`${folder}/Projects/Plan.md`) && restored.get(`${folder} (trash)/Projects/Plan.md`)?.toString('utf8') === 'the plan\n',
      'a deleted note leaves the vault and is in the trash of the backup',
      Array.from(restored.keys())
    )
    check(
      !existsSync(join(trustedDir, folder, 'Projects', 'Plan.md')) && readFileSync(join(trustedDir, `${folder} (trash)`, 'Projects', 'Plan.md'), 'utf8') === 'the plan\n',
      'and the trusted copy follows'
    )
  }

  // --- a stream that breaks off ------------------------------------------------------------
  {
    const repo = { repository: destinations[0].repository, password: destinations[0].password }
    const before = (await options.restic.snapshots(repo, 'files')).length
    const broken = await options.restic
      .backupStream(repo, 'broken.tar', ['obsidian-connect', 'files'], async (stdin) => {
        stdin.write(Buffer.alloc(100_000, 1))
        await delay(200)
        throw new Error('the producer failed')
      })
      .then(
        () => 'stored',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
    check(broken === 'the producer failed', 'a stream whose producer fails fails the backup', broken)
    check((await options.restic.snapshots(repo, 'files')).length === before, 'and leaves no snapshot behind - not a backup cut short')
  }

  // --- half the vault vanishing ---------------------------------------------------------------
  for (let n = 0; n < 16; n += 1) await A1.vault.userCreate(`Bulk/${n}.md`, `bulk ${n}\n`)
  check(await eventually(() => A2.vault.text('Bulk/15.md') === 'bulk 15\n', 15_000), 'A adds sixteen notes')
  const baseline = await runBackup(job(grant), options)
  check(baseline.ok && existsSync(join(trustedDir, folder, 'Bulk', '15.md')), 'they are backed up and in the trusted copy')
  for (let n = 0; n < 16; n += 1) await A1.vault.trash(A1.vault.file(`Bulk/${n}.md`))
  check(await eventually(() => A2.vault.text('Bulk/15.md') === undefined, 15_000), 'and deletes them again')
  const shrunk = await runBackup(job(grant), options)
  check(
    shrunk.ok && typeof shrunk.trusted?.held === 'string' && existsSync(join(trustedDir, folder, 'Bulk', '15.md')),
    'with most of the vault gone, restic backs up but the trusted copy waits',
    shrunk.trusted
  )
  const confirmed = await runBackup(job(grant), options, { acceptShrink: true })
  check(confirmed.ok && !existsSync(join(trustedDir, folder, 'Bulk', '15.md')) && confirmed.trusted?.held === undefined, 'once confirmed, it follows', confirmed.trusted)

  // --- a sync server restored from an old copy ---------------------------------------------------
  await server.close()
  const copy = join(root, 'server-copy')
  cpSync(join(root, 'server'), copy, { recursive: true })
  server = await serve(join(root, 'server'))
  for (let n = 1; n <= 3; n += 1) await A1.vault.userWrite('Welcome.md', `hello, take ${n}\n`)
  check(await eventually(() => A2.vault.text('Welcome.md') === 'hello, take 3\n'), 'A edits a note three times more')
  const beforeRestore = await runBackup(job(grant), options)
  check(beforeRestore.ok, 'and that is backed up')
  await A1.shutdown()
  await A2.shutdown()
  await server.close()
  rmSync(join(root, 'server'), { recursive: true, force: true })
  cpSync(copy, join(root, 'server'), { recursive: true })
  server = await serve(join(root, 'server'))
  // This process's HTTP pool still holds connections to the server that went
  // away; the first request on one is reset. The devices' client has no retry.
  await eventually(() => fetch(`http://127.0.0.1:${port}/health`).then((response) => response.ok, () => false))
  const A3 = new Device(`anna${run}`, false)
  devices.push(A3)
  check(await A3.boot(), 'the sync server is restored from the copy, and a new device of A signs in')
  check(await eventually(() => A3.vault.text('Welcome.md') === 'hello again\n'), 'it has the note as the copy had it')
  for (let n = 1; n <= 6; n += 1) {
    await A3.vault.userWrite('Welcome.md', `restored, take ${n}\n`)
    await delay(150)
  }
  check(await eventually(() => A3.docText('Welcome.md') === 'restored, take 6\n'), 'and writes to it, past where the backup had it')
  await delay(500)
  const afterRestore = await runBackup(job(grant), options)
  {
    const restored = restore(afterRestore, destinations[0], 'restore-after')
    check(afterRestore.ok && afterRestore.diverged >= 1, "the backup notices the note's history is another one", { ok: afterRestore.ok, diverged: afterRestore.diverged, problems: afterRestore.problems })
    check(restored.get(`${folder}/Welcome.md`)?.toString('utf8') === 'restored, take 6\n', "and backs up the sync server's note, not a mix of both", restored.get(`${folder}/Welcome.md`)?.toString('utf8'))
  }

  // --- the backup key taken away -------------------------------------------------------------------
  await A3.deleteBackupKey(grant.keyId)
  const ended = await runBackup(job(grant), options)
  check(!ended.ok && ended.accessEnded === true && ended.destinations.length === 0, 'with its key deleted the backup server reads nothing, and says to connect it again', ended)
  check(readFileSync(join(trustedDir, folder, 'Welcome.md'), 'utf8') === 'restored, take 6\n', 'and the trusted copy stays as it was')
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
