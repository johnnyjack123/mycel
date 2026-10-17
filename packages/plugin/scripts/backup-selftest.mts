// The backup server's run against real devices and a real restic: a sync
// server in this process, devices writing notes and files, a backup into
// local repositories, read back with restic and tar and compared with the
// vault. The server runs here so the test can restore an old copy of it.
//
//   npm run test:backup            (restic on the PATH, or OBSIDIAN_CONNECT_RESTIC naming it)
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import { check, delay, Device, eventually, failures, finish, useServer, VAULT } from './harness.mjs'

const { loadConfig } = await import('../../server/src/config.js')
const { startServer } = await import('../../server/src/server.js')
const { runBackup, vanished } = await import('../../backup/src/run.js')
const { readConfig } = await import('../../backup/src/config.js')
const { Restic } = await import('../../backup/src/restic.js')
const { silence } = await import('../../backup/src/log.js')
const { safePath, vaultFolder, withSuffix } = await import('../../backup/src/layout.js')
const { TarWriter } = await import('../../backup/src/tar.js')
const { TarHasher } = await import('../../backup/src/tarcheck.js')
const { alignTrusted, TrustedRefused } = await import('../../backup/src/trusted.js')
const { startBackupServer } = await import('../../backup/src/server.js')
const { Invites } = await import('../../backup/src/invites.js')
const { listVaults } = await import('../../backup/src/service.js')
const { backupRouteKeys, encodeBackupInvite, fromBase64, newBackupSecret, openSession } = await import('@obsidian-connect/shared/crypto')
const { backupSettingsText } = await import('@obsidian-connect/shared')
type BackupConnected = import('@obsidian-connect/shared').BackupConnected

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

  // The trusted copy's guard: notes and files counted apart, against a limit of the vault's own.
  {
    const before = { notes: 50, files: 1000 }
    check(vanished(before, { notes: 24, files: 1000 }, 50, 10)?.includes('24 notes (50 when') === true, 'more than half the notes gone holds the copy')
    check(vanished(before, { notes: 0, files: 1000 }, 50, 10) !== null, 'also when the files, a thousand of them, are all still there')
    check(vanished(before, { notes: 50, files: 400 }, 50, 10)?.includes('400 files') === true, 'and so do more than half the files')
    check(vanished(before, { notes: 25, files: 500 }, 50, 10) === null, 'exactly half is not more than half')
    check(vanished(before, { notes: 44, files: 1000 }, 10, 10) !== null && vanished(before, { notes: 46, files: 1000 }, 10, 10) === null, 'a limit of 10 % holds it from more than 10 % on')
    check(vanished(before, { notes: 4, files: 1000 }, 90, 10) !== null && vanished(before, { notes: 6, files: 1000 }, 90, 10) === null, 'a limit of 90 % from more than 90 %')
    check(vanished(before, { notes: 0, files: 0 }, 0, 10) === null, 'a guard turned off never holds it')
    check(vanished({ notes: 9 }, { notes: 0, files: 0 }, 50, 10) === null, 'too few to tell anything are not counted')
    check(vanished({ notes: 50 }, { notes: 50, files: 0 }, 50, 10) === null, 'nor files counted before there was a count of them')

    const config = (guard: unknown): number | undefined =>
      readConfig(new Map([['backupTarget:t', { id: 't', server: 'r', kind: 'trusted', location: 'copy', guard, addedAt: 1 }]]), 'r', root, []).config.trustedGuard
    check(
      config(undefined) === 50 && config(0) === 0 && config(5) === 10 && config(95) === 90 && config(33.4) === 33 && config('x') === 50,
      'the guard as set in the settings: 50 unless set, 0 for off, else within 10 and 90'
    )
  }

  // Whether a backup server read a device's newest settings: the same text on both ends.
  {
    const target = { id: 'x', server: 'r', kind: 'restic', location: 'l', password: 'p', keep: { last: 1, daily: 2 }, addedAt: 1 }
    const read = new Map<string, unknown>([
      ['backupTarget:x', target],
      ['backupSchedule:r', { server: 'r', everyHours: 24 }],
      ['backupTarget:y', { ...target, id: 'y', server: 'another backup server' }],
      ['historyRetentionDays', 30]
    ])
    const reordered = new Map<string, unknown>([
      ['backupSchedule:r', { everyHours: 24, server: 'r' }],
      ['backupTarget:x', { addedAt: 1, keep: { daily: 2, last: 1 }, password: 'p', location: 'l', kind: 'restic', server: 'r', id: 'x' }]
    ])
    check(backupSettingsText(read, 'r') === backupSettingsText(reordered, 'r'), "the same settings read the same, in any order, without other routes' or other settings")
    const longer = new Map(read).set('backupTarget:x', { ...target, keep: { last: 2, daily: 2 } })
    check(backupSettingsText(read, 'r') !== backupSettingsText(longer, 'r'), 'a retention changed, with every id as it was, reads differently')
    check(readConfig(read, 'r', root, []).digest === sha(backupSettingsText(read, 'r')), 'and the backup server reports the hash of what it read')
  }
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

const links: Array<{ close(): void }> = []
const stops: Array<() => Promise<void>> = []

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

  // --- most of the files vanishing, and a guard turned off ------------------------------------------
  for (let n = 0; n < 12; n += 1) await A1.vault.userCreateBinary(`Bulk/${n}.png`, bytes(`bulk picture ${n} `.repeat(50)))
  check(await eventually(() => A2.vault.bytes('Bulk/11.png') !== undefined, 20_000), 'A adds twelve pictures')
  const pictures = await runBackup(job(grant), options)
  check(pictures.ok && existsSync(join(trustedDir, folder, 'Bulk', '11.png')), 'they are in the trusted copy')
  for (let n = 0; n < 12; n += 1) await A1.vault.trash(A1.vault.file(`Bulk/${n}.png`))
  check(await eventually(() => A2.vault.bytes('Bulk/11.png') === undefined, 20_000), 'and deletes them again')
  const fewerFiles = await runBackup(job(grant), options)
  check(
    fewerFiles.ok && fewerFiles.trusted?.held?.includes('files') === true && !fewerFiles.trusted.held.includes('notes') && existsSync(join(trustedDir, folder, 'Bulk', '11.png')),
    'with most of the files gone and every note there, the trusted copy waits too - and says it is the files',
    fewerFiles.trusted
  )
  const unguarded = await runBackup({ ...job(grant), config: { ...job(grant).config, trustedGuard: 0 } }, options)
  check(unguarded.ok && unguarded.trusted?.held === undefined && !existsSync(join(trustedDir, folder, 'Bulk', '11.png')), 'with its guard turned off, it follows at once', unguarded.trusted)

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

  // --- a backup server of its own, reached through the relay -------------------------------------
  let clock = Date.now()
  const DAY_MS = 24 * 60 * 60 * 1000
  const backupRoot = join(root, 'backup-root')
  const backupData = join(root, 'backup-server-2')
  const backupServer = await startBackupServer({
    server: `ws://127.0.0.1:${port}`,
    dataDir: backupData,
    root: backupRoot,
    workDir: join(root, 'ram-2'),
    resticBinary: RESTIC,
    name: 'test backup server',
    version: 'test',
    tickMs: 100,
    watchMs: 100,
    now: () => clock
  })
  stops.push(() => backupServer.close())
  const refusal = (task: Promise<unknown>): Promise<string> =>
    task.then(
      () => 'accepted',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    )
  const NOT_CONNECTED = 'the backup server is not connected'
  type Status = { targets: string[]; problems: string[]; running: boolean; nextRunAt: number | null; runs: Array<{ ok: boolean; error?: string; accessEnded?: boolean }> }

  // The operator's invitations.
  {
    const late = await backupServer.invite('late')
    check(/^([0-9A-HJKMNP-TV-Z]{5}-){5}[0-9A-HJKMNP-TV-Z]{5}$/.test(late), 'the operator makes an invitation, written like a recovery code', late)
    check((await refusal(A3.openInviteSession('ABCDE-FGHJK'))).includes('not an invitation'), 'a typo in it is caught on the device')
    check((await refusal(A3.openInviteSession(await encodeBackupInvite(newBackupSecret())))) === NOT_CONNECTED, 'an invitation nobody made reaches nothing')
    clock += 8 * DAY_MS
    check(await eventually(async () => (await refusal(A3.openInviteSession(late, 2_000))) === NOT_CONNECTED, 10_000), 'one older than a week reaches nothing either')

    // What the command line does: it writes the data folder, and the running backup server takes it up.
    const made = await new Invites(backupData).create('from the command line', clock)
    const reached = await eventually(async () => {
      const session = await A3.openInviteSession(made.code, 2_000).catch(() => null)
      session?.close()
      return session !== null
    }, 10_000)
    check(reached, 'an invitation made on the command line is answered within moments')
    await new Invites(backupData).remove(made.invite.id)
    check(await eventually(async () => (await refusal(A3.openInviteSession(made.code, 2_000))) === NOT_CONNECTED, 10_000), 'and one withdrawn there reaches nothing')
  }

  const invitation = await backupServer.invite('for anna')
  const link = await A3.openInviteSession(invitation)
  links.push(link)
  const info = await link.call<{ name: string; restic: string }>('info')
  check(info.name === 'test backup server' && info.restic.startsWith('restic'), 'with an invitation a device reaches the backup server through the relay', info)
  check((await refusal(link.call('status'))).includes('connects a vault, and does nothing else'), 'and can do nothing on it but connect a vault')
  const relayGrant = await A3.makeBackupGrant('over the relay')
  const vaultId = relayGrant.vaultId
  const connected = await link.call<BackupConnected>('connect', { grant: relayGrant })
  check(
    connected.vaultId === vaultId && typeof connected.pairing === 'string' && connected.replaced === null,
    'it connects its vault, handing the grant over the session, and gets a pairing of its own back'
  )
  check(await eventually(() => !link.open, 10_000), 'that spends the invitation, and its session ends')
  check((await refusal(A3.openInviteSession(invitation, 5_000))) === NOT_CONNECTED, 'it opens nothing a second time')
  {
    const listed = await listVaults(backupData)
    check(
      listed.length === 1 && listed[0]?.vaultId === vaultId && listed[0].accountId === A3.accountId && listed[0].label === 'for anna',
      'the operator sees the vault, whose account it is and the invitation it came with',
      listed
    )
  }

  const pairing = connected.pairing
  const routeId = (await backupRouteKeys(fromBase64(pairing))).routeId
  const paired = await A3.openPairingSession(pairing)
  links.push(paired)
  const settings = A3.settings as NonNullable<typeof A3.settings>
  settings.setBackupServer(routeId, { routeId, pairing, label: 'test', keyId: relayGrant.keyId, addedAt: clock })
  settings.setBackupTarget('repo', { id: 'repo', server: routeId, kind: 'restic', location: 'vault-a/repo', password: 'relay password', keep: { last: 10 }, addedAt: 1 })
  settings.setBackupTarget('copy', { id: 'copy', server: routeId, kind: 'trusted', location: 'vault-a/copy', addedAt: 2 })
  settings.setBackupTarget('escape', { id: 'escape', server: routeId, kind: 'restic', location: '../outside', password: 'x', addedAt: 3 })
  settings.setBackupSchedule(routeId, { server: routeId, everyHours: 24 })
  check(
    await eventually(async () => (await paired.call<Status>('refresh')).targets.join() === 'repo,copy', 15_000),
    "over the vault's pairing, the settings made on the device reach the backup server"
  )
  const configured = await paired.call<Status>('status')
  check(configured.problems.some((problem) => problem.includes('../outside')), 'a folder outside its backup folder is refused, and said why', configured.problems)

  const finished = new Promise<{ report: { ok: boolean } }>((resolve) => {
    paired.onEvent((event) => {
      if (event.ev === 'finished') resolve(event.p as { report: { ok: boolean } })
    })
  })
  await paired.call('run')
  const relayed = await Promise.race([finished, delay(120_000).then(() => null)])
  check(relayed?.report.ok === true, 'a backup started from the device runs, and the device hears how it went', relayed)
  {
    const snapshots = restic(join(backupRoot, 'vault-a', 'repo'), 'relay password', ['snapshots', '--json'])
    const list = JSON.parse(snapshots.stdout.toString('utf8') || '[]') as unknown[]
    check(list.length === 2, 'its repository lies below the backup folder, with the notes and the files snapshot', snapshots.stderr)
    check(
      readFileSync(join(backupRoot, 'vault-a', 'copy', folder, 'Welcome.md'), 'utf8') === 'restored, take 6\n',
      'and the trusted copy too'
    )
  }

  // Whoever knows only the route - the sync server itself - gets an answer, and no further.
  {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/relay?token=${encodeURIComponent(B.accessToken)}`)
    const frames: Array<Record<string, unknown>> = []
    socket.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data)) as Record<string, unknown>))
    await new Promise((resolve) => socket.addEventListener('open', resolve))
    socket.send(JSON.stringify({ t: 'open', route: routeId, ref: 7 }))
    await eventually(() => frames.some((frame) => frame.t === 'opened'))
    const session = frames.find((frame) => frame.t === 'opened')?.s as number
    const { hello } = await openSession()
    socket.send(JSON.stringify({ t: 'data', s: session, d: JSON.stringify({ hello }) }))
    await eventually(() => frames.some((frame) => frame.t === 'data'))
    socket.send(JSON.stringify({ t: 'data', s: session, d: JSON.stringify({ c: Buffer.from(randomBytes(64)).toString('base64') }) }))
    check(
      await eventually(() => frames.some((frame) => frame.t === 'close' && frame.s === session)),
      "someone who knows the vault's route but not its pairing is turned away at the first sealed message",
      frames
    )
    socket.close()
  }

  // Another account with an invitation of its own: its own vault, never anyone else's.
  let benVault = ''
  {
    const benInvite = await backupServer.invite('for ben')
    const foreign = await B.openInviteSession(benInvite)
    links.push(foreign)
    const benGrant = await B.makeBackupGrant('ben')
    benVault = benGrant.vaultId
    check(
      (await refusal(foreign.call('connect', { grant: { ...benGrant, vaultId, accountId: A3.accountId } }))) !== 'accepted',
      "a grant made out for someone else's vault does not connect it"
    )
    const benConnected = await foreign.call<BackupConnected>('connect', { grant: benGrant })
    check(benConnected.vaultId === benVault && benConnected.replaced === null, 'the invitation is still good for their own')
    const benPaired = await B.openPairingSession(benConnected.pairing)
    links.push(benPaired)
    check(
      (await refusal(benPaired.call('rekey', { grant: relayGrant }))) === 'that grant is not for this vault',
      "a pairing reaches its vault only: not even another vault's own grant takes it over"
    )
    check((await paired.call<Status>('status')).runs[0]?.ok === true, "and A's vault carries on as it was")
    const benRoute = (await backupRouteKeys(fromBase64(benConnected.pairing))).routeId
    const benSettings = B.settings as NonNullable<typeof B.settings>
    benSettings.setBackupServer(benRoute, { routeId: benRoute, pairing: benConnected.pairing, label: 'ben', keyId: benGrant.keyId, addedAt: clock })
    benSettings.setBackupTarget('intrude', { id: 'intrude', server: benRoute, kind: 'restic', location: 'vault-a/repo/inside', password: 'x', addedAt: 1 })
    check(
      await eventually(async () => (await benPaired.call<Status>('refresh')).problems.some((problem) => problem.includes('another vault')), 15_000),
      "nor can it put its vault into another vault's folder"
    )
    const checked = await benPaired.call<{ ok: boolean; created?: boolean; error?: string }>('check', {
      target: { kind: 'restic', location: 'vault-b/repo', password: 'ben password' }
    })
    check(checked.ok && checked.created === true, 'a destination is checked before it is saved - the repository made where there is none', checked)
    const wrong = await benPaired.call<{ ok: boolean; error?: string }>('check', {
      target: { kind: 'restic', location: 'vault-b/repo', password: 'not it' }
    })
    check(!wrong.ok && wrong.error === 'the repository password is wrong', 'and a wrong password said as such', wrong)

    // The operator disconnects it on the command line: its folder goes, and the running backup server lets go.
    rmSync(join(backupData, 'vaults', benVault), { recursive: true, force: true })
    check(
      await eventually(async () => !backupServer.service.has(benVault) && (await refusal(B.openPairingSession(benConnected.pairing, 2_000))) === NOT_CONNECTED, 10_000),
      'a vault the operator disconnects is let go, and its pairing reaches nothing'
    )
    check(backupServer.service.has(vaultId), 'the other vaults carry on')
  }

  // The schedule.
  {
    const before = (await paired.call<Status>('status')).runs.length
    clock += 25 * 60 * 60 * 1000
    check(
      await eventually(async () => {
        const now = await paired.call<Status>('status')
        return now.runs.length > before && !now.running
      }, 120_000),
      'a day later the schedule starts a run on its own'
    )
  }

  await paired.call('disconnect')
  check(
    !backupServer.service.has(vaultId) && !existsSync(join(backupData, 'vaults', vaultId)) && (await refusal(A3.openPairingSession(pairing, 5_000))) === NOT_CONNECTED,
    'disconnecting forgets the vault and its keys, and its pairing reaches nothing any more'
  )
  check(existsSync(join(backupRoot, 'vault-a', 'repo', 'config')) && existsSync(join(backupRoot, 'vault-a', 'copy', folder)), 'and leaves its repository and copy where they are')

  // --- what the settings screen does: connecting, destinations, the schedule, a password change -----
  {
    // What the session test above put into the settings goes first.
    for (const target of settings.backupTargets(routeId)) settings.setBackupTarget(target.id, null)
    settings.setBackupSchedule(routeId, null)
    settings.setBackupServer(routeId, null)
    const backups = A3.backups
    const connectedHere = await backups.connect(await backupServer.invite('settings'), A3.password, '')
    const uiRoute = connectedHere.routeId
    check(
      connectedHere.label === 'test backup server' && backups.servers().length === 1 && settings.backupSchedule(uiRoute)?.everyHours === 24,
      'connected from the settings, it is called what it calls itself and backs up daily unless told otherwise'
    )
    const made = await backups.addTarget(uiRoute, { kind: 'restic', location: 'ui/repo', password: 'ui password' })
    check(made.created, 'a repository added in the settings is checked and made')
    await backups.addTarget(uiRoute, { kind: 'trusted', location: 'ui/copy' })
    const outside = await refusal(backups.addTarget(uiRoute, { kind: 'restic', location: '../escape', password: 'x' }))
    check(outside.includes('not a folder below') && settings.backupTargets(uiRoute).length === 2, 'one outside the backup folder is refused before it is saved', outside)
    await backups.setSchedule(uiRoute, 6)
    const view = backups.view(uiRoute)
    check(
      view?.status?.everyHours === 6 && view.status.targets.length === 2,
      'the backup server has the destinations and the schedule by the time the settings say so',
      view?.status
    )
    await backups.runNow(uiRoute)
    check(await eventually(async () => (await backups.ask(uiRoute))?.status?.runs[0]?.ok === true, 120_000), 'a backup started from the settings runs')
    check((await backups.problems()).length === 0, 'and nothing calls for a notice')

    // A password change ends the key; the pairing stands, and the device that made it hands out a new key over it.
    const newPassword = 'a much newer password 4711'
    await A3.changePassword(newPassword)
    await backups.runNow(uiRoute)
    check(
      await eventually(async () => (await backups.ask(uiRoute))?.status?.runs[0]?.accessEnded === true, 120_000),
      'after a password change the backup server reads nothing with its old key'
    )
    check((await backups.problems()).some((problem) => problem.includes('failed')), 'and the device is told')
    check((await backups.reconnectAll(newPassword)) === 1, 'the device that changed the password gives it a new key, without a new invitation')
    await backups.runNow(uiRoute)
    check(await eventually(async () => (await backups.ask(uiRoute))?.status?.runs[0]?.ok === true, 120_000), 'and it backs up again')

    // Connected again with a new invitation: a new pairing, the destinations carry on.
    const again = await backups.connect(await backupServer.invite('again'), newPassword, '')
    check(
      again.routeId !== uiRoute && backups.servers().length === 1 && settings.backupTargets(again.routeId).length === 2 && settings.backupTargets(uiRoute).length === 0,
      'the same vault connected again gets a new pairing, and its destinations and schedule move along',
      backups.servers()
    )
    check((await refusal(A3.openPairingSession(connectedHere.pairing, 5_000))) === NOT_CONNECTED, 'the old pairing reaches nothing')
    {
      const status = (await backups.ask(again.routeId))?.status
      check(status?.everyHours === 6 && status.targets.length === 2, 'and the backup server reads the settings under the new one', status)
    }

    // A destination changed afterwards: how long its backups are kept, the copy's guard.
    {
      const repo = settings.backupTargets(again.routeId).find((target) => target.kind === 'restic') as NonNullable<ReturnType<typeof settings.backupTargets>[number]>
      const copy = settings.backupTargets(again.routeId).find((target) => target.kind === 'trusted') as NonNullable<ReturnType<typeof settings.backupTargets>[number]>
      const repository = join(backupRoot, 'ui', 'repo')
      const count = (): number => (JSON.parse(restic(repository, 'ui password', ['snapshots', '--json']).stdout.toString('utf8') || '[]') as unknown[]).length
      check(count() > 2, 'the repository holds several backups by now', count())
      await backups.updateTarget(again.routeId, repo.id, { keep: { last: 1 } })
      await backups.updateTarget(again.routeId, copy.id, { guard: 0 })
      const changed = settings.backupTargets(again.routeId)
      check(
        changed.find((target) => target.id === repo.id)?.keep?.last === 1 &&
          changed.find((target) => target.id === repo.id)?.password === 'ui password' &&
          changed.find((target) => target.id === copy.id)?.guard === 0,
        'a destination keeps its location and password when its retention or guard changes'
      )
      const runsBefore = (await backups.ask(again.routeId))?.status?.runs.length ?? 0
      await backups.runNow(again.routeId)
      check(
        await eventually(async () => {
          const status = (await backups.ask(again.routeId))?.status
          return (status?.runs.length ?? 0) > runsBefore && status?.running === false && status.runs[0]?.ok === true
        }, 120_000),
        'and backs up as before'
      )
      check(count() === 2, "the next backup keeps only what the new retention says - the newest notes and files snapshot", count())
    }

    // Every device of the account sees it, and may start or disconnect it.
    const A4 = new Device(`anna${run}`, false)
    A4.password = newPassword
    devices.push(A4)
    check(await A4.boot(), 'another device of the account signs in')
    check(await eventually(() => A4.backups.servers().length === 1, 15_000), 'and finds the backup server in the settings')
    check((await A4.backups.ask(again.routeId))?.status?.runs[0]?.ok === true, "and its state, through the vault's pairing")
    await A4.backups.disconnect(again.routeId)
    check(A4.backups.servers().length === 0 && A4.settings?.backupTargets(again.routeId).length === 0, 'disconnecting on any device takes it out of the settings')
    check(!backupServer.service.has(vaultId), 'and the backup server forgets the vault')
  }
} catch (error) {
  check(false, 'the scenario ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  for (const link of links) link.close()
  for (const stop of stops) await stop().catch(() => undefined)
  for (const device of devices) await device.shutdown().catch(() => undefined)
  await server.close().catch(() => undefined)
  await delay(100)
  if (failures.length === 0) rmSync(root, { recursive: true, force: true })
  else console.log(`kept for a look: ${root}`)
}

finish()
