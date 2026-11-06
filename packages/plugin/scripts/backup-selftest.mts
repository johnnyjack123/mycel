// The backup server's run against real devices and a real restic: a sync
// server in this process, devices writing notes and files, a backup into
// local repositories, read back with restic and tar and compared with the
// vault. The server runs here so the test can restore an old copy of it.
//
//   npm run test:backup            (restic on the PATH, or MYCEL_RESTIC naming it)
import { execFile, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { check, delay, Device, eventually, failures, finish, useServer, VAULT } from './harness.mjs'

const { loadConfig } = await import('../../server/src/config.js')
const { startServer } = await import('../../server/src/server.js')
const { followedAt, guardReference, runBackup, vanished } = await import('../../backup/src/run.js')
const { readConfig } = await import('../../backup/src/config.js')
const { atOf, nextAt } = await import('../../backup/src/schedule.js')
const { Restic } = await import('../../backup/src/restic.js')
const { silence } = await import('../../backup/src/log.js')
const { safePath, vaultFolder, withSuffix } = await import('../../backup/src/layout.js')
const { TarWriter } = await import('../../backup/src/tar.js')
const { TarHasher } = await import('../../backup/src/tarcheck.js')
const { alignTrusted, copyPath, TrustedRefused } = await import('../../backup/src/trusted.js')
const { startBackupServer } = await import('../../backup/src/server.js')
const { Invites } = await import('../../backup/src/invites.js')
const { readStatus } = await import('../../backup/src/status.js')
/** The operator's command, as the image has it. */
const BACKUP_BIN = fileURLToPath(new URL('../../backup/bin/mycel-backup.mjs', import.meta.url))
const { listVaults } = await import('../../backup/src/service.js')
const { backupRouteKeys, encodeBackupInvite, fromBase64, newBackupSecret, openSession } = await import('@mycel/shared/crypto')
const { backupSettingsText, docRoom, scheduleHours } = await import('@mycel/shared')
type BackupConnected = import('@mycel/shared').BackupConnected

type RunReport = Awaited<ReturnType<typeof runBackup>>

const RESTIC = process.env.MYCEL_RESTIC ?? 'restic'
const probe = spawnSync(RESTIC, ['version'], { encoding: 'utf8' })
if (probe.status !== 0) {
  console.log(`FAIL: restic is needed: put it on the PATH or name it in MYCEL_RESTIC (tried "${RESTIC}")`)
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
      MYCEL_DATA_DIR: dataDir,
      MYCEL_REGISTRATION: 'open',
      MYCEL_JWT_SECRET: 'backup-selftest',
      // A clean-up purges at once: a rollback has to find content only a backup still has.
      MYCEL_PURGE_GRACE_S: '0'
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
  await hasher.write(archive.subarray(0, 700))
  await hasher.write(archive.subarray(700))
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
  const refused = await alignTrusted(foreign, 'v', 'Vault', [], new Set(), null as never, null as never).then(
    () => null,
    (error: unknown) => error
  )
  check(refused instanceof TrustedRefused && readFileSync(join(foreign, 'mine.txt'), 'utf8') === 'not yours', 'the trusted copy never takes over a folder someone else filled')
  check(
    copyPath('V/a/b.md', 'V') === 'a/b.md' && copyPath('V (trash)/a.md', 'V') === '.mycel/trash/a.md' && copyPath('V settings.json', 'V') === '.mycel/settings.json',
    'the decrypted copy holds the vault at its top - it opens as a vault -, its trash and settings in a hidden folder'
  )

  // The trusted copy's guard: notes and files counted apart, against a limit of the vault's own.
  {
    const before = { notes: 50, files: 1000 }
    check(vanished(before, { notes: 24, files: 1000 }, 50, 10)?.includes('24 notes (50 at most') === true, 'more than half the notes gone holds the copy')
    check(vanished(before, { notes: 0, files: 1000 }, 50, 10) !== null, 'also when the files, a thousand of them, are all still there')
    check(vanished(before, { notes: 50, files: 400 }, 50, 10)?.includes('400 files') === true, 'and so do more than half the files')
    check(vanished(before, { notes: 25, files: 500 }, 50, 10) === null, 'exactly half is not more than half')
    check(vanished(before, { notes: 44, files: 1000 }, 10, 10) !== null && vanished(before, { notes: 46, files: 1000 }, 10, 10) === null, 'a limit of 10 % holds it from more than 10 % on')
    check(vanished(before, { notes: 4, files: 1000 }, 90, 10) !== null && vanished(before, { notes: 6, files: 1000 }, 90, 10) === null, 'a limit of 90 % from more than 90 %')
    check(vanished(before, { notes: 0, files: 0 }, 0, 10) === null, 'a guard turned off never holds it')
    check(vanished({ notes: 9 }, { notes: 0, files: 0 }, 50, 10) === null, 'too few to tell anything are not counted')
    check(vanished({ notes: 50 }, { notes: 50, files: 0 }, 50, 10) === null, 'nor files counted before there was a count of them')

    // Measured by the most within the week before the newest run it followed, not by that run alone.
    const DAY = 24 * 60 * 60 * 1000
    const runs = [
      { at: 0, notes: 100, files: 40 },
      { at: DAY, notes: 70, files: 40 }
    ]
    check(guardReference(runs).notes === 100 && guardReference(runs).files === 40, 'the reference is the most notes and files of the week')
    check(vanished(guardReference(runs), { notes: 45, files: 40 }, 50, 10) !== null, 'so a shrink split over two runs is held as a whole')
    check(guardReference([...runs, { at: 9 * DAY, notes: 70, files: 40 }]).notes === 70, 'counts older than a week before the newest fall out')
    const followed = followedAt(runs, { at: 2 * DAY, notes: 60, files: 40 }, false)
    check(followed.length === 3 && followedAt(followed, { at: 3 * DAY, notes: 20, files: 40 }, true).length === 1, 'a confirmation starts the counts afresh')
    check(followedAt(runs, { at: 8 * DAY + 1, notes: 70, files: 40 }, false).every((entry) => entry.at > DAY), 'and following a week later lets the older ones go')

    const config = (guard: unknown): number | undefined =>
      readConfig(new Map([['backupTask:r', { server: 'r', where: 'local', password: 'p', decrypted: true, guard, everyHours: 24, createdAt: 1 }]]), 'r', {
        encrypted: 'e',
        decrypted: 'd'
      }).config.trustedGuard
    check(
      config(undefined) === 50 && config(0) === 0 && config(5) === 10 && config(95) === 90 && config(33.4) === 33 && config('x') === 50,
      'the guard as set in the settings: 50 unless set, 0 for off, else within 10 and 90'
    )
  }

  // A backup task, and the folders the backup server picks - never the settings.
  {
    const folders = { encrypted: join(root, 'encrypted', 'v'), decrypted: join(root, 'decrypted', 'anna', 'Vault') }
    const task = { server: 'r', where: 'local', password: 'p', keep: { last: 2 }, everyHours: 6, decrypted: false, createdAt: 1 }
    const local = readConfig(new Map([['backupTask:r', task]]), 'r', folders)
    check(
      local.ready && local.everyHours === 6 && local.config.destinations[0]?.repository === folders.encrypted && local.config.destinations[0]?.keep?.last === 2 && local.config.trusted === null,
      'a task keeping the repository on the backup server puts it in its folder for the vault; no copy unless asked for',
      local
    )
    const copy = readConfig(new Map([['backupTask:r', { ...task, decrypted: true }]]), 'r', folders)
    check(copy.config.trusted === folders.decrypted && copy.config.destinations.length === 1, 'a decrypted copy goes into its folder, next to the repository')
    const cloud = readConfig(new Map([['backupTask:r', { ...task, where: 'cloud', location: 's3:host/bucket', env: { AWS_ACCESS_KEY_ID: 'a', RESTIC_PASSWORD: 'no' } }]]), 'r', folders)
    const destination = cloud.config.destinations[0]
    check(
      cloud.ready && destination?.repository === 's3:host/bucket' && destination.id.startsWith('cloud-') && destination.env?.AWS_ACCESS_KEY_ID === 'a' && destination.env.RESTIC_PASSWORD === undefined,
      "a cloud repository at its location, with its credentials - never one pointing restic's own variables elsewhere",
      cloud
    )
    const escape = readConfig(new Map([['backupTask:r', { ...task, where: 'cloud', location: '../outside' }]]), 'r', folders)
    check(!escape.ready && escape.problems.some((problem) => problem.includes('not a cloud location')), 'a path given as a cloud location is refused, and said why', escape.problems)
    const bare = readConfig(new Map([['backupTask:r', { ...task, password: '' }]]), 'r', folders)
    check(!bare.ready && bare.problems.includes('the repository needs a password'), 'a repository without a password too')
    const other = readConfig(new Map([['backupTask:another', { ...task, server: 'another' }]]), 'r', folders)
    check(!other.ready && other.problems.length === 0 && other.config.destinations.length === 0, "another backup server's task is not this one's")
  }

  // Whether a backup server read a device's newest settings: the same text on both ends.
  {
    const task = { server: 'r', where: 'local', password: 'p', keep: { last: 1, daily: 2 }, everyHours: 24, decrypted: true, createdAt: 1 }
    const read = new Map<string, unknown>([
      ['backupTask:r', task],
      ['backupTask:another', { ...task, server: 'another backup server' }],
      ['historyRetentionDays', 30]
    ])
    const reordered = new Map<string, unknown>([['backupTask:r', { createdAt: 1, decrypted: true, everyHours: 24, keep: { daily: 2, last: 1 }, password: 'p', where: 'local', server: 'r' }]])
    check(backupSettingsText(read, 'r') === backupSettingsText(reordered, 'r'), "the same settings read the same, in any order, without other routes' or other settings")
    const longer = new Map(read).set('backupTask:r', { ...task, keep: { last: 2, daily: 2 } })
    check(backupSettingsText(read, 'r') !== backupSettingsText(longer, 'r'), 'a retention changed reads differently')
    check(readConfig(read, 'r', { encrypted: 'e', decrypted: 'd' }).digest === sha(backupSettingsText(read, 'r')), 'and the backup server reports the hash of what it read')
  }

  // A backup at a time of day, by the clock of the device that set it.
  {
    const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 16)
    const at = (text: string): number => Date.parse(`${text}:00Z`)
    check(iso(nextAt({ minutes: 180, zone: 'UTC' }, at('2026-10-18T10:00'))) === '2026-10-19T03:00', 'at three in UTC: the next night')
    check(iso(nextAt({ minutes: 180, zone: 'UTC' }, at('2026-10-18T02:59'))) === '2026-10-18T03:00', 'still the same night just before')
    check(iso(nextAt({ minutes: 180, zone: 'UTC' }, at('2026-10-18T03:00'))) === '2026-10-19T03:00', 'and the next one right at it')
    check(iso(nextAt({ minutes: 180, zone: 'Europe/Berlin' }, at('2026-10-18T10:00'))) === '2026-10-19T01:00', 'at three in Berlin in summer time: one o\'clock UTC')
    check(
      iso(nextAt({ minutes: 180, zone: 'Europe/Berlin' }, at('2026-10-24T12:00'))) === '2026-10-25T02:00',
      'the night the clocks go back: three by the new clock, two UTC'
    )
    check(
      iso(nextAt({ minutes: 150, zone: 'Europe/Berlin' }, at('2026-03-28T12:00'))) === '2026-03-29T01:30',
      'half past two, which the clocks skip when summer time begins: an hour later'
    )
    check(
      iso(nextAt({ minutes: 180, weekdays: [0], zone: 'Europe/Berlin' }, at('2026-10-19T00:00'))) === '2026-10-25T02:00',
      'weekly on Sunday at three: the coming Sunday'
    )
    check(
      iso(nextAt({ minutes: 1380, zone: 'America/New_York' }, at('2026-10-18T10:00'))) === '2026-10-19T03:00',
      'at eleven in the evening in New York: three UTC the next day'
    )
    check(iso(nextAt({ minutes: 180, zone: 'Not/AZone' }, at('2026-10-18T10:00'))) === '2026-10-19T03:00', 'a zone not known counts as UTC')
    check(
      atOf({ minutes: 1440, zone: 'UTC' }) === null && atOf({ minutes: 60 }) === null && atOf({ minutes: 60, weekdays: [9], zone: 'UTC' })?.weekdays === undefined,
      'a time out of range, or without a zone, is no schedule; a weekday out of range is every day'
    )
    const task = { server: 'r', where: 'local', password: 'p', everyHours: 0, decrypted: false, createdAt: 1 }
    const weekly = readConfig(new Map([['backupTask:r', { ...task, at: { minutes: 180, weekdays: [0], zone: 'Europe/Berlin' } }]]), 'r', { encrypted: 'e', decrypted: 'd' })
    check(
      weekly.ready && weekly.at?.weekdays?.join() === '0' && weekly.everyHours === 168 && weekly.problems.length === 0,
      'the backup server reads a weekly time, and counts it as a week',
      weekly
    )

    // Several days, as the day buttons set them.
    const workdays = { minutes: 180, weekdays: [1, 2, 3, 4, 5], zone: 'Europe/Berlin' }
    check(
      iso(nextAt(workdays, at('2026-10-23T10:00'))) === '2026-10-26T02:00',
      'on workdays at three: from a Friday morning, the Monday - by the winter clock, the clocks having gone back on Sunday'
    )
    check(iso(nextAt(workdays, at('2026-10-21T00:30'))) === '2026-10-21T01:00', 'and on a Wednesday the same night')
    check(
      atOf({ minutes: 60, weekdays: [5, 1, 9, 1], zone: 'UTC' })?.weekdays?.join() === '1,5' && atOf({ minutes: 60, weekdays: [0, 1, 2, 3, 4, 5, 6], zone: 'UTC' })?.weekdays === undefined,
      'days are taken sorted, once each, without one out of range; all seven are every day'
    )
    check(
      scheduleHours({ everyHours: 0, at: workdays }) === 72 &&
        scheduleHours({ everyHours: 0, at: { minutes: 0, weekdays: [3], zone: 'UTC' } }) === 168 &&
        scheduleHours({ everyHours: 0, at: { minutes: 0, zone: 'UTC' } }) === 24,
      'the longest gap between two days is what a backup may be late by: three days over a weekend, a week for one day, a day for every day'
    )
    const unknown = readConfig(new Map([['backupTask:r', { ...task, at: { minutes: 180, zone: 'Not/AZone' } }]]), 'r', { encrypted: 'e', decrypted: 'd' })
    check(unknown.ready && unknown.problems.some((problem) => problem.includes('goes by UTC')), 'a zone it does not know it says so, and backs up all the same', unknown.problems)
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
  restic: new Restic(RESTIC, join(root, 'restic-cache'), 'mycel-backup'),
  samples: 3
}
const folder = vaultFolder(VAULT)

/** The runner's options with every call of restic noted in `calls`, by the method that made it. */
function counting(calls: string[]): typeof options {
  const restic = new Proxy(options.restic, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls.push(String(key))
        return (value as (...args: unknown[]) => unknown).apply(target, args)
      }
    }
  })
  return { ...options, restic }
}

/** Every note and file of a device's vault, as the backup should hold it below the vault's folder - the decrypted copy at its top (`prefix` ''). */
function expectedVault(device: Device, prefix = `${folder}/`): Map<string, Buffer> {
  const expected = new Map<string, Buffer>()
  for (const path of device.vault.paths()) expected.set(`${prefix}${path}`, Buffer.from(device.vault.text(path) ?? '', 'utf8'))
  for (const path of device.vault.attachmentPaths()) expected.set(`${prefix}${path}`, Buffer.from(device.vault.bytes(path) ?? new Uint8Array()))
  return expected
}

/** The vault in a decrypted copy: everything but its hidden folder and its list of what it wrote. */
function vaultInCopy(dir: string): Map<string, Buffer> {
  return new Map(Array.from(filesBelow(dir)).filter(([path]) => !path.startsWith('.mycel')))
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
  // Shared folders: A's own, whose notes' keys come from its folder key, and
  // one of B's in A's vault, whose folder key is sealed to A.
  await A1.folders?.share('Projects', B.accountId, 'write', true)
  await A1.vault.userCreate('Projects/In the folder.md', 'written in the folder\n')
  await B.vault.userCreate('Ben Folder/Note.md', 'in bens folder\n')
  check(await eventually(() => B.docText('Ben Folder/Note.md') === 'in bens folder\n'), 'B has a folder of its own')
  await B.folders?.share('Ben Folder', A1.accountId, 'read', false)
  check(
    await eventually(() => A2.vault.text('Shared/Ben Folder/Note.md') === 'in bens folder\n' && A2.vault.text('Projects/In the folder.md') === 'written in the folder\n', 15_000),
    "A shares a folder, and B's folder is shared into A's vault"
  )
  // Every device done following the folders, so the runs below see a vault at rest.
  await delay(2_500)
  for (const device of devices) await device.folders?.settled()
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
    const { missing, differ } = sameFiles(vaultInCopy(trustedDir), expectedVault(A1, ''), '')
    check(missing.length === 0 && differ.length === 0, 'the trusted copy holds the vault', { missing, differ })
    check(readFileSync(join(trustedDir, '.mycel', 'settings.json'), 'utf8').includes('historyRetentionDays'), 'and its settings beside it')
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
  const secondCalls: string[] = []
  const second = await runBackup(job(grant), counting(secondCalls))
  check(second.ok && second.fetched.rooms === 0 && second.fetched.blobs === 0, 'a run with nothing changed fetches nothing', second.fetched)
  check(
    secondCalls.length === 0 &&
      second.destinations.every((entry, i) => entry.unchanged === true && entry.notesSnapshot === first.destinations[i]?.notesSnapshot && entry.filesSnapshot === first.destinations[i]?.filesSnapshot),
    'and does not start restic at all: the last snapshots hold the vault as it is (0.8.15)',
    { secondCalls, destinations: second.destinations }
  )
  check(second.trusted?.written === 0 && second.trusted.deleted === 0, 'and writes nothing into the trusted copy', second.trusted)
  {
    const dueCalls: string[] = []
    const due = await runBackup(job(grant), { ...counting(dueCalls), checkMs: 0 })
    check(
      due.ok && dueCalls.includes('check') && due.destinations.every((entry) => entry.unchanged !== true && entry.checked === 'quick'),
      "once the day's check of the repository is due, a run with nothing changed backs up and checks it",
      { dueCalls, destinations: due.destinations }
    )
  }

  // --- a note changes, one is added ---------------------------------------------------
  await A1.vault.userWrite('Welcome.md', 'hello again\n')
  await A1.vault.userCreate('New.md', 'a new note\n')
  check(await eventually(() => A2.vault.text('Welcome.md') === 'hello again\n' && A2.vault.text('New.md') === 'a new note\n'), 'A edits a note and adds one')
  const thirdCalls: string[] = []
  const third = await runBackup(job(grant), counting(thirdCalls))
  check(third.ok && third.fetched.rooms > 0 && third.fetched.rooms <= 4, 'only the rooms that changed are fetched', third.fetched)
  check(
    thirdCalls.includes('backupFolder') && thirdCalls.includes('ls') && !thirdCalls.includes('check') && third.destinations.every((entry) => entry.unchanged !== true),
    'a change is backed up and its snapshot read back; the whole repository is checked once a day, not every run',
    thirdCalls
  )
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
  check(readFileSync(join(trustedDir, 'Welcome.md'), 'utf8') === 'hello again\n', 'and has the edit')

  // --- a file is added -----------------------------------------------------------------
  const added = bytes('another picture '.repeat(100))
  await A1.vault.userCreateBinary('Bilder/Neu.png', added)
  check(await eventually(() => same(A2.vault.bytes('Bilder/Neu.png'), added)), 'A adds a picture')
  const fourth = await runBackup(job(grant), options)
  check(fourth.ok && fourth.destinations.every((entry) => entry.filesUnchanged !== true && entry.filesSnapshot), 'a new file makes a new files snapshot', fourth.destinations)
  {
    const dumped = restic(destinations[1].repository, destinations[1].password, ['dump', fourth.destinations[1]?.filesSnapshot ?? '', `/${folder} files.tar`])
    const hasher = new TarHasher()
    await hasher.write(dumped.stdout)
    check(hasher.hashes.get(`${folder}/Bilder/Neu.png`) === sha(added) && hasher.hashes.get(`${folder}/${PHOTO}`) === sha(photo), 'with the new picture and the old ones in it')
  }

  // --- a note is deleted -----------------------------------------------------------------
  await A1.vault.trash(A1.vault.file('Projects/Plan.md'))
  check(await eventually(() => A2.vault.text('Projects/Plan.md') === undefined), 'A deletes a note')
  {
    // The repository does not take this run: the copy must not delete what no snapshot holds yet.
    const broken = await runBackup({ ...job(grant), config: { destinations: [{ ...destinations[0], password: 'not it' }], trusted: trustedDir } }, options)
    check(
      !broken.ok && broken.trusted?.ok === false && broken.trusted.error?.includes('repository did not take') === true && existsSync(join(trustedDir, 'Projects', 'Plan.md')),
      'a run the repository does not take leaves the decrypted copy as it was',
      broken.trusted
    )
  }
  const fifth = await runBackup(job(grant), options)
  {
    const restored = restore(fifth, destinations[0], 'restore-5')
    check(
      fifth.ok && !restored.has(`${folder}/Projects/Plan.md`) && restored.get(`${folder} (trash)/Projects/Plan.md`)?.toString('utf8') === 'the plan\n',
      'a deleted note leaves the vault and is in the trash of the backup',
      Array.from(restored.keys())
    )
    check(
      !existsSync(join(trustedDir, 'Projects', 'Plan.md')) && readFileSync(join(trustedDir, '.mycel', 'trash', 'Projects', 'Plan.md'), 'utf8') === 'the plan\n',
      'and the trusted copy follows, the note in its trash'
    )
  }

  // --- shared folders over time --------------------------------------------------------------
  // What B writes into A's folder, a note B adds to its own folder later, a note A takes out
  // of its folder and goes on writing, both shares ending: each change read with the key of
  // its moment - a note's own, its folder's at one epoch or the next, or the fork's.
  {
    const backedUp = async (label: string, name: string): Promise<void> => {
      await delay(1_000)
      for (const device of devices) await device.folders?.settled()
      const report = await runBackup(job(grant), options)
      const unreadable = report.problems.filter((problem) => problem.includes('could not be decrypted'))
      const restored = restore(report, destinations[0], name)
      const { missing, differ } = sameFiles(restored, expectedVault(A1), `${folder}/`)
      check(report.ok && unreadable.length === 0 && missing.length === 0 && differ.length === 0, label, { ok: report.ok, unreadable, missing, differ })
      const copy = sameFiles(vaultInCopy(trustedDir), expectedVault(A1, ''), '')
      check(copy.missing.length === 0 && copy.differ.length === 0, `${label} - and so does the trusted copy`, copy)
    }

    await B.vault.userWrite('Shared/Projects/In the folder.md', 'written in the folder\nand by ben\n')
    await B.vault.userCreate('Shared/Projects/From Ben.md', 'ben wrote this in annas folder\n')
    const benPicture = bytes('a picture ben put into the folder '.repeat(80))
    await B.vault.userCreateBinary('Shared/Projects/ben.png', benPicture)
    await B.vault.userCreate('Ben Folder/Later.md', 'added to bens folder later\n')
    check(
      await eventually(
        () =>
          A1.vault.text('Projects/In the folder.md') === 'written in the folder\nand by ben\n' &&
          A1.vault.text('Projects/From Ben.md') === 'ben wrote this in annas folder\n' &&
          same(A1.vault.bytes('Projects/ben.png'), benPicture) &&
          A1.vault.text('Shared/Ben Folder/Later.md') === 'added to bens folder later\n',
        20_000
      ),
      "B writes into A's folder, adds a note and a picture there, and a note to its own folder",
      A1.vault.paths()
    )
    await backedUp("the backup holds what B added to A's folder and to its own - every change readable", 'restore-folders-1')

    await A1.vault.rename(A1.vault.file('Projects/In the folder.md'), 'Moved out.md')
    await delay(800)
    await A1.vault.userWrite('Moved out.md', 'written in the folder\nand by ben\nand after it left\n')
    check(await eventually(() => A2.vault.text('Moved out.md') === 'written in the folder\nand by ben\nand after it left\n'), 'A takes a note out of its folder and writes on')
    await backedUp("a note taken out of the folder: its folder epochs and its own after them, all read", 'restore-folders-2')

    const projects = A1.folders?.folderAt('Projects')
    check(projects !== null && projects !== undefined, "A's folder is shared")
    if (projects) await A1.folders?.revoke(projects.folderId, B.accountId)
    await A1.vault.userWrite('Projects/From Ben.md', 'ben wrote this in annas folder\nanna, after ben left\n')
    check(
      await eventually(() => {
        const docId = B.index?.docIdForPath('Shared/Projects/From Ben.md')
        return docId !== undefined && !B.index?.entry(docId)?.owner && A2.vault.text('Projects/From Ben.md') === 'ben wrote this in annas folder\nanna, after ben left\n'
      }, 20_000),
      'A revokes B: B keeps the notes, A writes on under the next key'
    )
    await backedUp('after the revocation, the folder notes are read under the next key', 'restore-folders-3')

    const bens = B.folders?.folderAt('Ben Folder')
    if (bens) await B.folders?.revoke(bens.folderId, A1.accountId)
    check(
      await eventually(() => {
        const docId = A1.index?.docIdForPath('Shared/Ben Folder/Later.md')
        return docId !== undefined && !A1.index?.entry(docId)?.owner && A2.vault.text('Shared/Ben Folder/Later.md') === 'added to bens folder later\n'
      }, 20_000),
      "B ends its folder for A: A keeps its notes as its own",
      A1.vault.paths()
    )
    await backedUp("B's folder, forked into A's vault, is backed up as A's own notes", 'restore-folders-4')
  }

  // --- a stream that breaks off ------------------------------------------------------------
  {
    const repo = { repository: destinations[0].repository, password: destinations[0].password }
    const before = (await options.restic.snapshots(repo, 'files')).length
    const broken = await options.restic
      .backupStream(repo, 'broken.tar', ['mycel', 'files'], async (stdin) => {
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
  check(baseline.ok && existsSync(join(trustedDir, 'Bulk', '15.md')), 'they are backed up and in the trusted copy')
  for (let n = 0; n < 16; n += 1) await A1.vault.trash(A1.vault.file(`Bulk/${n}.md`))
  check(await eventually(() => A2.vault.text('Bulk/15.md') === undefined, 15_000), 'and deletes them again')
  const shrunk = await runBackup(job(grant), options)
  check(
    shrunk.ok && typeof shrunk.trusted?.held === 'string' && existsSync(join(trustedDir, 'Bulk', '15.md')),
    'with most of the vault gone, restic backs up but the trusted copy waits',
    shrunk.trusted
  )
  const confirmed = await runBackup(job(grant), options, { acceptShrink: true })
  check(confirmed.ok && !existsSync(join(trustedDir, 'Bulk', '15.md')) && confirmed.trusted?.held === undefined, 'once confirmed, it follows', confirmed.trusted)

  // --- more than half the vault vanishing over two runs, each below the limit ------------------
  // As the user had it: notes deleted, a backup started at once while the deletions were still
  // on their way, then another. Measured by the run before alone, both halves went through.
  {
    for (let n = 0; n < 20; n += 1) await A1.vault.userCreate(`Step/${n}.md`, `step ${n}\n`)
    check(await eventually(() => A2.vault.text('Step/19.md') === 'step 19\n', 15_000), 'A adds twenty notes')
    const before = await runBackup(job(grant), options)
    // The live notes, as the guard counts them - a run's own count has the trash and the settings in it.
    const all = A1.vault.paths().length
    check(before.ok && before.trusted?.held === undefined && existsSync(join(trustedDir, 'Step', '19.md')), 'they are in the trusted copy', { notes: all })
    // A third of the notes go, then as many again - each step less than half of what the run before had.
    const first = Math.floor(all / 3)
    for (let n = 0; n < first; n += 1) await A1.vault.trash(A1.vault.file(`Step/${n}.md`))
    check(await eventually(() => A2.vault.text(`Step/${first - 1}.md`) === undefined, 15_000), `A deletes ${first} of ${all} notes`)
    const partly = await runBackup(job(grant), options)
    const between = A1.vault.paths().length
    check(partly.ok && partly.trusted?.held === undefined && !existsSync(join(trustedDir, 'Step', '0.md')), 'less than half gone: the copy follows', partly.trusted)
    const second = Math.min(20 - first, Math.floor(between / 2) - 1)
    for (let n = first; n < first + second; n += 1) await A1.vault.trash(A1.vault.file(`Step/${n}.md`))
    check(await eventually(() => A2.vault.text(`Step/${first + second - 1}.md`) === undefined, 15_000), `and ${second} more - less than half of what the run before had`)
    const rest = await runBackup(job(grant), options)
    const left = A1.vault.paths().length
    check(
      left < all / 2 && left >= between / 2 && typeof rest.trusted?.held === 'string' && existsSync(join(trustedDir, 'Step', `${first}.md`)),
      'but more than half of what the week had: the copy waits',
      { all, between, left, trusted: rest.trusted }
    )
    const accepted = await runBackup(job(grant), options, { acceptShrink: true })
    check(accepted.trusted?.held === undefined && !existsSync(join(trustedDir, 'Step', `${first}.md`)), 'confirmed, it follows')
    const after = await runBackup(job(grant), options)
    check(after.trusted?.held === undefined, 'and measures from there on')
  }

  // --- most of the files vanishing, and a guard turned off ------------------------------------------
  for (let n = 0; n < 12; n += 1) await A1.vault.userCreateBinary(`Bulk/${n}.png`, bytes(`bulk picture ${n} `.repeat(50)))
  check(await eventually(() => A2.vault.bytes('Bulk/11.png') !== undefined, 20_000), 'A adds twelve pictures')
  const pictures = await runBackup(job(grant), options)
  check(pictures.ok && existsSync(join(trustedDir, 'Bulk', '11.png')), 'they are in the trusted copy')
  for (let n = 0; n < 12; n += 1) await A1.vault.trash(A1.vault.file(`Bulk/${n}.png`))
  check(await eventually(() => A2.vault.bytes('Bulk/11.png') === undefined, 20_000), 'and deletes them again')
  const fewerFiles = await runBackup(job(grant), options)
  check(
    fewerFiles.ok && fewerFiles.trusted?.held?.includes('files') === true && !fewerFiles.trusted.held.includes('notes') && existsSync(join(trustedDir, 'Bulk', '11.png')),
    'with most of the files gone and every note there, the trusted copy waits too - and says it is the files',
    fewerFiles.trusted
  )
  const unguarded = await runBackup({ ...job(grant), config: { ...job(grant).config, trustedGuard: 0 } }, options)
  check(unguarded.ok && unguarded.trusted?.held === undefined && !existsSync(join(trustedDir, 'Bulk', '11.png')), 'with its guard turned off, it follows at once', unguarded.trusted)

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
  check(readFileSync(join(trustedDir, 'Welcome.md'), 'utf8') === 'restored, take 6\n', 'and the trusted copy stays as it was')

  // --- a backup server of its own, reached through the relay -------------------------------------
  let clock = Date.now()
  const DAY_MS = 24 * 60 * 60 * 1000
  const encryptedRoot = join(root, 'backup-encrypted')
  const decryptedRoot = join(root, 'backup-decrypted')
  const backupData = join(root, 'backup-server-2')
  const backupServer = await startBackupServer({
    server: `ws://127.0.0.1:${port}`,
    dataDir: backupData,
    encryptedRoot,
    decryptedRoot,
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
  // What the device says when nothing answers an invitation: where to look, not the relay's words.
  const NO_INVITATION = 'No backup server answers this invitation'
  type Status = {
    ready: boolean
    folders: { encrypted: string; decrypted: string }
    everyHours: number
    problems: string[]
    running: boolean
    nextRunAt: number | null
    runs: Array<{ ok: boolean; error?: string; accessEnded?: boolean }>
  }

  // The operator's invitations.
  {
    const late = await backupServer.invite('late')
    check(/^([0-9A-HJKMNP-TV-Z]{5}-){5}[0-9A-HJKMNP-TV-Z]{5}$/.test(late), 'the operator makes an invitation, written like a recovery code', late)
    check((await refusal(A3.openInviteSession('ABCDE-FGHJK'))).includes('not an invitation'), 'a typo in it is caught on the device')
    check((await refusal(A3.openInviteSession(await encodeBackupInvite(newBackupSecret())))).startsWith(NO_INVITATION), 'an invitation nobody made reaches nothing')

    // What the operator sees: the status the running backup server writes, through the commands themselves.
    check(
      await eventually(async () => {
        const status = await readStatus(backupData)
        return status?.connected === true && Object.values(status.invites).some((route) => status.registered.includes(route))
      }),
      'the running backup server writes for the command line that it reaches the sync server and answers the invitation',
      await readStatus(backupData)
    )
    // Not spawnSync: the backup server runs in this process, and has to take the invitation up meanwhile.
    const operator = (args: string[], dataDir = backupData, server?: string): Promise<string> =>
      new Promise((resolve) => {
        const env = { ...process.env, MYCEL_BACKUP_DATA: dataDir, ...(server ? { MYCEL_SERVER: server } : {}) }
        execFile(process.execPath, [BACKUP_BIN, ...args], { env, encoding: 'utf8', timeout: 60_000 }, (_error, stdout, stderr) => resolve(`${stdout}${stderr}`))
      })
    const invited = await operator(['invite', 'from', 'the', 'shell'])
    check(invited.includes('The backup server answers it at') && !invited.includes('BUT'), '"invite" waits until the running backup server answers it, and says so', invited)
    const shown = await operator(['status'])
    check(/connected since/.test(shown) && /from the shell .* answered/.test(shown) && !shown.includes('NOT answered'), '"status" shows the connection and every invitation answered', shown)
    {
      // One that cannot reach the sync server says so, and why - where the device only heard "not connected".
      const lonely = join(root, 'backup-unreachable')
      // A port nothing listens on - not 9, which fetch refuses outright as a "bad port".
      const closedPort = await new Promise<number>((resolve) => {
        const probe = createServer()
        probe.listen(0, '127.0.0.1', () => {
          const { port: free } = probe.address() as { port: number }
          probe.close(() => resolve(free))
        })
      })
      const unreachable = await startBackupServer({
        server: `ws://127.0.0.1:${closedPort}`,
        dataDir: lonely,
        encryptedRoot: join(root, 'unreachable-encrypted'),
        decryptedRoot: join(root, 'unreachable-decrypted'),
        workDir: join(root, 'ram-unreachable'),
        resticBinary: RESTIC,
        name: 'unreachable',
        version: 'test',
        tickMs: 100,
        watchMs: 100
      })
      stops.push(() => unreachable.close())
      await new Invites(lonely).create('nobody answers')
      check(
        await eventually(async () => {
          const status = await readStatus(lonely)
          return status?.connected === false && typeof status.error === 'string' && status.error.length > 0
        }, 10_000),
        'a backup server that cannot reach the sync server writes so, and why',
        await readStatus(lonely)
      )
      const stuck = await operator(['status'], lonely)
      check(stuck.includes('NOT connected') && stuck.includes('NOT answered') && stuck.includes('backup server test'), '"status" tells the operator, and which version runs', stuck)
      check(
        await eventually(async () => (await readStatus(lonely))?.error?.includes('nothing listens at that address') === true, 15_000),
        'and says plainly why, from asking over HTTP - the explanation staying beside every new attempt',
        await readStatus(lonely)
      )
      const tried = await operator(['check'], lonely, `ws://127.0.0.1:${closedPort}`)
      check(tried.includes('ECONNREFUSED') && tried.includes('network_mode: host'), '"check" tries the way from here, says where it ends and what works on one host', tried)
      const works = await operator(['check'], lonely, `ws://127.0.0.1:${port}`)
      check(works.includes('opened - the relay takes this backup server'), 'and with the right address, that the relay takes it', works)

      // A reverse proxy that refuses this backup server - by address, by user agent - while devices get through.
      const proxy = createHttpServer((_request, response) => {
        response.writeHead(403, { server: 'openresty' })
        response.end('forbidden')
      })
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
      const proxyPort = (proxy.address() as { port: number }).port
      try {
        const refused = await operator(['check'], lonely, `ws://localhost:${proxyPort}`)
        check(
          refused.includes('DNS: localhost -> ') && refused.includes('answered by "openresty"') && refused.includes('something in front of it refuses this backup server'),
          '"check" shows the address the name resolves to here, who answered, and that a proxy in front refuses it',
          refused
        )
      } finally {
        proxy.close()
      }

      // wss:// on the sync server's own port, which has no TLS: what the user's Pi had, seen as "closed (1006)" alone.
      const tls = join(root, 'backup-wss')
      const wrongScheme = await startBackupServer({
        server: `wss://127.0.0.1:${port}`,
        dataDir: tls,
        encryptedRoot: join(root, 'wss-encrypted'),
        decryptedRoot: join(root, 'wss-decrypted'),
        workDir: join(root, 'ram-wss'),
        resticBinary: RESTIC,
        name: 'wss',
        version: 'test',
        tickMs: 100,
        watchMs: 100
      })
      stops.push(() => wrongScheme.close())
      await new Invites(tls).create('wrong scheme')
      check(
        await eventually(async () => (await readStatus(tls))?.error?.includes(`use ws://127.0.0.1:${port} instead of wss://`) === true, 15_000),
        'one given wss:// for a port without TLS asks the sync server over HTTP, and says to use ws://',
        await readStatus(tls)
      )
    }
    clock += 8 * DAY_MS
    check(await eventually(async () => (await refusal(A3.openInviteSession(late, 2_000))).startsWith(NO_INVITATION), 10_000), 'one older than a week reaches nothing either')

    // What the command line does: it writes the data folder, and the running backup server takes it up.
    const made = await new Invites(backupData).create('from the command line', clock)
    const reached = await eventually(async () => {
      const session = await A3.openInviteSession(made.code, 2_000).catch(() => null)
      session?.close()
      return session !== null
    }, 10_000)
    check(reached, 'an invitation made on the command line is answered within moments')
    await new Invites(backupData).remove(made.invite.id)
    check(await eventually(async () => (await refusal(A3.openInviteSession(made.code, 2_000))).startsWith(NO_INVITATION), 10_000), 'and one withdrawn there reaches nothing')
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
  check((await refusal(A3.openInviteSession(invitation, 5_000))).startsWith(NO_INVITATION), 'it opens nothing a second time')
  const annaCopy = `${A3.username}/${folder}`
  {
    const listed = await listVaults(backupData)
    check(
      listed.length === 1 &&
        listed[0]?.vaultId === vaultId &&
        listed[0].accountId === A3.accountId &&
        listed[0].accountName === A3.username &&
        listed[0].vaultName === VAULT &&
        listed[0].label === 'for anna' &&
        listed[0].decryptedFolder === annaCopy,
      "the operator sees the vault, whose account and which vault it is, the invitation it came with - and its copy's folder by the account's name and the vault's",
      listed
    )
  }

  const pairing = connected.pairing
  const routeId = (await backupRouteKeys(fromBase64(pairing))).routeId
  const paired = await A3.openPairingSession(pairing)
  links.push(paired)
  const settings = A3.settings as NonNullable<typeof A3.settings>
  settings.setBackupServer(routeId, { routeId, pairing, label: 'test', keyId: relayGrant.keyId, addedAt: clock })
  const relayTask = { server: routeId, where: 'local' as const, password: 'relay password', keep: { last: 10 }, everyHours: 24, decrypted: true, createdAt: 1 }
  settings.setBackupTask(routeId, { ...relayTask, where: 'cloud', location: '../outside' })
  check(
    await eventually(async () => {
      const status = await paired.call<Status>('refresh')
      return !status.ready && status.problems.some((problem) => problem.includes('not a cloud location'))
    }, 15_000),
    "over the vault's pairing, the task set on the device reaches the backup server - a path given as a cloud refused, and said why"
  )
  settings.setBackupTask(routeId, relayTask)
  const configured = await eventually(async () => (await paired.call<Status>('refresh')).ready, 15_000)
  const folders = (await paired.call<Status>('status')).folders
  check(
    configured && folders.encrypted === `encrypted/${vaultId}` && folders.decrypted === `decrypted/${annaCopy}`,
    'the task as it should be is taken, and the backup server names its folders for the vault',
    folders
  )

  const finished = new Promise<{ report: { ok: boolean } }>((resolve) => {
    paired.onEvent((event) => {
      if (event.ev === 'finished') resolve(event.p as { report: { ok: boolean } })
    })
  })
  await paired.call('run')
  const relayed = await Promise.race([finished, delay(120_000).then(() => null)])
  check(relayed?.report.ok === true, 'a backup started from the device runs, and the device hears how it went', relayed)
  {
    const snapshots = restic(join(encryptedRoot, vaultId), 'relay password', ['snapshots', '--json'])
    const list = JSON.parse(snapshots.stdout.toString('utf8') || '[]') as unknown[]
    check(list.length === 2, "its repository lies in the folder for encrypted vaults, under the vault's id, with the notes and the files snapshot", snapshots.stderr)
    check(
      readFileSync(join(decryptedRoot, A3.username, folder, 'Welcome.md'), 'utf8') === 'restored, take 6\n',
      "and the decrypted copy in the folder for decrypted vaults, under the account's name and the vault's"
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
    // Named like A: names are not unique, and the folder of A's copy must not become B's.
    const benConnected = await foreign.call<BackupConnected>('connect', { grant: { ...benGrant, accountName: A3.username } })
    check(benConnected.vaultId === benVault && benConnected.replaced === null, 'the invitation is still good for their own')
    const benCopy = `${A3.username} (${B.accountId.slice(0, 8)})/${folder}`
    check(
      (await listVaults(backupData)).find((vault) => vault.vaultId === benVault)?.decryptedFolder === benCopy,
      "another account of the same name, with a vault of the same name, gets its copy's folder with its account's id added",
      await listVaults(backupData)
    )
    const benPaired = await B.openPairingSession(benConnected.pairing)
    links.push(benPaired)
    check(
      (await refusal(benPaired.call('rekey', { grant: relayGrant }))) === 'that grant is not for this vault',
      "a pairing reaches its vault only: not even another vault's own grant takes it over"
    )
    check((await paired.call<Status>('status')).runs[0]?.ok === true, "and A's vault carries on as it was")
    const benTask = { where: 'local', password: 'ben password', decrypted: false }
    const checked = await benPaired.call<{ ok: boolean; created?: boolean; error?: string }>('check', { task: benTask })
    check(
      checked.ok && checked.created === true && existsSync(join(encryptedRoot, benVault, 'config')),
      "a task is checked before it is saved - the repository made in the vault's own folder",
      checked
    )
    const wrong = await benPaired.call<{ ok: boolean; error?: string }>('check', { task: { ...benTask, password: 'not it' } })
    check(
      !wrong.ok && wrong.error?.includes(`a repository from before lies in encrypted/${benVault} under another password`) === true,
      'and one with another password than the repository already there is told so',
      wrong
    )
    mkdirSync(join(decryptedRoot, ...benCopy.split('/')), { recursive: true })
    writeFileSync(join(decryptedRoot, ...benCopy.split('/'), 'not a copy.txt'), 'somebody put this here')
    const filled = await benPaired.call<{ ok: boolean; error?: string }>('check', { task: { ...benTask, decrypted: true } })
    check(!filled.ok && filled.error?.includes('holds something else already') === true, "a decrypted copy is refused a folder somebody else filled", filled)

    // The operator disconnects it on the command line: its folder goes, and the running backup server lets go.
    rmSync(join(backupData, 'vaults', benVault), { recursive: true, force: true })
    check(
      await eventually(async () => !backupServer.service.has(benVault) && (await refusal(B.openPairingSession(benConnected.pairing, 2_000))) === NOT_CONNECTED, 10_000),
      'a vault the operator disconnects is let go, and its pairing reaches nothing'
    )
    check(backupServer.service.has(vaultId), 'the other vaults carry on')
  }

  // The schedule - waiting for a quiet vault before a run that is due.
  {
    const MINUTE = 60 * 1000
    type Waiting = Status & { waitingUntil: number | null }
    const status = (): Promise<Waiting> => paired.call<Waiting>('status')
    const write = async (text: string): Promise<boolean> => {
      if (A3.vault.text('Busy.md') === undefined) await A3.vault.userCreate('Busy.md', text)
      else await A3.vault.userWrite('Busy.md', text)
      return eventually(() => A3.docText('Busy.md') === text && A3.store?.noteState(A3.vault.file('Busy.md') as never) === 'synced', 15_000)
    }
    const before = (await status()).runs.length
    clock += 25 * 60 * MINUTE
    check(
      await eventually(async () => (await status()).waitingUntil !== null, 15_000),
      'a day later a run is due - and first waits for the vault to be quiet',
      await status()
    )
    check(await write('someone is writing\n'), 'meanwhile someone writes in the vault')
    clock += 5 * MINUTE + 1_000
    await delay(1_500)
    {
      const now = await status()
      check(now.runs.length === before && now.waitingUntil !== null && !now.running, 'so after five minutes the run still waits', now)
    }
    clock += 5 * MINUTE + 1_000
    check(
      await eventually(async () => {
        const now = await status()
        return now.runs.length > before && !now.running && now.waitingUntil === null
      }, 120_000),
      'five quiet minutes later it runs'
    )

    // Someone writing all the time holds it off for an hour at most.
    const later = (await status()).runs.length
    clock += 25 * 60 * MINUTE
    check(await eventually(async () => (await status()).waitingUntil !== null, 15_000), 'the next day it waits again')
    check(await write('and writes on\n'), 'while someone writes')
    clock += 61 * MINUTE
    check(
      await eventually(async () => {
        const now = await status()
        return now.runs.length > later && !now.running
      }, 120_000),
      'after an hour it runs whatever goes on in the vault'
    )
  }

  await paired.call('disconnect')
  check(
    !backupServer.service.has(vaultId) && !existsSync(join(backupData, 'vaults', vaultId)) && (await refusal(A3.openPairingSession(pairing, 5_000))) === NOT_CONNECTED,
    'disconnecting forgets the vault and its keys, and its pairing reaches nothing any more'
  )
  check(
    existsSync(join(encryptedRoot, vaultId, 'config')) && existsSync(join(decryptedRoot, A3.username, folder, 'Welcome.md')),
    'and leaves its repository and copy where they are'
  )

  // --- what the settings screen does: connecting, the backup task, the schedule, a password change -----
  {
    // What the session test above put into the settings goes first.
    settings.setBackupTask(routeId, null)
    settings.setBackupServer(routeId, null)
    const backups = A3.backups
    const connectedHere = await backups.connect(await backupServer.invite('settings'), A3.password, '')
    const uiRoute = connectedHere.routeId
    check(
      connectedHere.label === 'test backup server' && backups.servers().length === 1 && backups.view(uiRoute)?.task === null,
      'connected from the settings, it is called what it calls itself - and backs up nothing before it has a task'
    )
    // The vault was paired here before: its repository is there, under the password it had.
    const otherPassword = await refusal(backups.setTask(uiRoute, { where: 'local', password: 'ui password', decrypted: true }))
    check(
      otherPassword.includes('a repository from before lies in encrypted/') && settings.backupTask(uiRoute) === null,
      'a task with another password than the repository from before is refused before it is saved, and said why',
      otherPassword
    )
    const made = await backups.setTask(uiRoute, { where: 'local', password: 'relay password', decrypted: true })
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    check(
      !made.created && settings.backupTask(uiRoute)?.at?.minutes === 180 && settings.backupTask(uiRoute)?.at?.zone === zone,
      "with its password the repository from before is taken up again; it backs up every night at three, by this device's clock, unless told otherwise"
    )
    {
      const next = backups.view(uiRoute)?.status?.nextRunAt ?? 0
      const shown = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(next))
      check(next > clock && shown === '03:00', `and the backup server's next run is at three by that clock (${zone})`, { next: new Date(next).toISOString(), shown })
    }
    const outside = await refusal(backups.setTask(uiRoute, { where: 'cloud', location: '../escape', password: 'x', decrypted: false }))
    check(outside.includes('not a cloud location') && settings.backupTask(uiRoute)?.where === 'local', 'a path given as a cloud is refused before it is saved', outside)
    await backups.setSchedule(uiRoute, 6)
    const view = backups.view(uiRoute)
    check(
      view?.status?.everyHours === 6 && view.status.ready && view.task?.everyHours === 6,
      'the backup server has the task and the schedule by the time the settings say so',
      view?.status
    )
    await backups.runNow(uiRoute)
    check(await eventually(async () => (await backups.ask(uiRoute))?.status?.runs[0]?.ok === true, 120_000), 'a backup started from the settings runs')
    check((await backups.problems()).length === 0, 'and nothing calls for a notice')

    // A password change ends the key; the pairing stands, and the device that made it hands out a new key over it.
    const newPassword = 'a much newer password 4711'
    // A session opened before: the relay checked its token only when it connected.
    const before = await A3.openPairingSession(connectedHere.pairing)
    await A3.changePassword(newPassword)
    check(await eventually(() => !before.open), 'a password change ends the relay sessions the devices held too')
    // As main.ts does before it reaches the backup servers again: new sessions, with the new token.
    backups.closeSessions()
    await backups.runNow(uiRoute)
    check(
      await eventually(async () => (await backups.ask(uiRoute))?.status?.runs[0]?.accessEnded === true, 120_000),
      'after a password change the backup server reads nothing with its old key'
    )
    check((await backups.problems()).some((problem) => problem.includes('failed')), 'and the device is told')
    check((await backups.reconnectAll(newPassword)) === 1, 'the device that changed the password gives it a new key, without a new invitation')
    await backups.runNow(uiRoute)
    check(await eventually(async () => (await backups.ask(uiRoute))?.status?.runs[0]?.ok === true, 120_000), 'and it backs up again')

    // Connected again with a new invitation: a new pairing, the task carries on.
    const again = await backups.connect(await backupServer.invite('again'), newPassword, '')
    check(
      again.routeId !== uiRoute && backups.servers().length === 1 && settings.backupTask(again.routeId)?.decrypted === true && settings.backupTask(uiRoute) === null,
      'the same vault connected again gets a new pairing, and its task moves along',
      backups.servers()
    )
    check((await refusal(A3.openPairingSession(connectedHere.pairing, 5_000))) === NOT_CONNECTED, 'the old pairing reaches nothing')
    {
      const status = (await backups.ask(again.routeId))?.status
      check(status?.everyHours === 6 && status.ready && status.folders.decrypted === `decrypted/${annaCopy}`, 'and the backup server reads it under the new one, its folders as they were', status)
    }

    // A copy the guard holds, as the settings ask about it: what vanished, "not now", letting it follow.
    {
      for (let n = 0; n < 20; n += 1) await A3.vault.userCreate(`Held/${n}.md`, `held ${n}\n`)
      check(
        await eventually(() => A3.store?.noteState(A3.vault.file('Held/19.md') as never) === 'synced', 20_000),
        'A writes twenty notes more'
      )
      check((await backups.backUpFresh(again.routeId, { pollMs: 200 })).ok && backups.heldCopy(again.routeId) === null, 'they are backed up, and the copy follows')
      for (let n = 0; n < 20; n += 1) await A3.vault.trash(A3.vault.file(`Held/${n}.md`))
      // However the deletions reach the backup server - at once, or over two runs - the copy ends up waiting.
      let tries = 0
      while (backups.heldCopy(again.routeId) === null && tries < 6) {
        tries += 1
        await delay(500)
        await backups.backUpFresh(again.routeId, { pollMs: 200 })
      }
      const held = backups.heldCopy(again.routeId)
      const notes = held?.run.trusted?.shrunk?.find((kind) => kind.what === 'notes')
      check(
        held !== null && notes !== undefined && notes.now < notes.before / 2 && existsSync(join(decryptedRoot, A3.username, folder, 'Held', '19.md')),
        'A deletes them: the copy waits, and the device knows what vanished, in numbers',
        held?.run.trusted
      )
      if (held) {
        backups.dismissHold(held.key)
        check(backups.holdDismissed(held.key) && !backups.holdDismissed(`${held.key} and another`), '"not now" is remembered for that hold, and only for it')
        const following = backups.followCopy(again.routeId)
        check(backups.following(again.routeId) && backups.heldCopy(again.routeId) === null, 'while the copy is let follow, nothing asks about it')
        const followed = await following
        check(
          followed.ok && followed.run?.trusted?.held === undefined && (followed.run?.trusted?.deleted ?? 0) > 0 && !backups.following(again.routeId) && backups.heldCopy(again.routeId) === null,
          'letting it follow is waited for to the end, and says what it removed',
          followed
        )
        check(!existsSync(join(decryptedRoot, A3.username, folder, 'Held', '19.md')), 'and the copy has followed the vault')
      }
    }

    // The task changed afterwards: how long its backups are kept, the copy's guard.
    {
      const repository = join(encryptedRoot, vaultId)
      const count = (): number => (JSON.parse(restic(repository, 'relay password', ['snapshots', '--json']).stdout.toString('utf8') || '[]') as unknown[]).length
      check(count() > 2, 'the repository holds several backups by now', count())
      await backups.updateTask(again.routeId, { keep: { last: 1 } })
      await backups.updateTask(again.routeId, { guard: 0 })
      const changed = settings.backupTask(again.routeId)
      check(
        changed?.keep?.last === 1 && changed.password === 'relay password' && changed.where === 'local' && changed.guard === 0 && changed.decrypted,
        'the task keeps its repository and password when its retention or guard changes'
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

    // What a rollback asks for first.
    {
      const runsBefore = (await backups.ask(again.routeId))?.status?.runs.length ?? 0
      const fresh = await backups.backUpFresh(again.routeId, { pollMs: 200 })
      const runsAfter = (await backups.ask(again.routeId))?.status?.runs.length ?? 0
      check(fresh.ok && runsAfter > runsBefore, 'a fresh backup for a rollback is started and waited for until it is checked', { fresh, runsBefore, runsAfter })
    }

    // --- rolling back further than the history reaches: from that backup --------------------------
    {
      const vaultNow = (): Map<string, string> => {
        const found = new Map<string, string>()
        for (const path of A3.vault.paths()) found.set(path, A3.vault.text(path) ?? '')
        for (const path of A3.vault.attachmentPaths()) found.set(path, Buffer.from(A3.vault.bytes(path) ?? new Uint8Array()).toString('base64'))
        return found
      }
      await delay(500)
      const atBackup = vaultNow()
      const TB = Date.now()
      await delay(1_100)
      const photoAfter = bytes('painted over after the backup '.repeat(150))
      await A3.vault.userWrite('Welcome.md', 'after the backup\n')
      await A3.vault.userCreate('After backup.md', 'came after the backup\n')
      await A3.vault.trash(A3.vault.file('New.md'))
      await A3.vault.userWriteBinary(PHOTO, photoAfter)
      check(
        await eventually(async () => A3.docText('Welcome.md') === 'after the backup\n' && A3.attachments?.fileState(A3.vault.file(PHOTO)) === 'synced', 15_000),
        'A edits, adds, deletes and paints over a picture after the backup'
      )
      await delay(500)
      // The history compacted past the backup, and the picture's earlier content gone from the sync server.
      A3.retentionDays = 1e-9
      check(((await (A3.compactor as NonNullable<typeof A3.compactor>).run()) ?? 0) > 0, "the vault's whole history is compacted past the backup")
      await delay(50)
      await A3.attachments?.cleanUp(1e-9)
      const plan = await A3.rollback.plan(TB)
      const note = (path: string): (typeof plan.notes)[number] | undefined => plan.notes.find((entry) => entry.pathThen === path || entry.pathNow === path)
      check(plan.byPath && plan.backup?.routeId === again.routeId, 'with the history out of reach, the plan comes from the backup, by name', { byPath: plan.byPath, backup: plan.backup })
      check(note('Welcome.md')?.text === true && note('Welcome.md')?.textThen === atBackup.get('Welcome.md'), "a note gets its text from the backup")
      check(note('After backup.md')?.trash === true && note('New.md')?.revive === true, 'one that came later goes to the trash, one deleted since comes back from the trash')
      check(plan.files.find((file) => file.pathThen === PHOTO)?.fromBackup === true, "and a picture whose content the sync server no longer has is read from the backup")
      check(plan.foreignKept >= 1 && !plan.notes.some((entry) => (entry.pathThen ?? entry.pathNow ?? '').startsWith('Shared/')), 'a note someone else shares in stays as it is')
      const backed = await A3.rollback.backUpFirst(A3.backups)
      check(backed.every((result) => result.ok), 'every backup server backs up first')
      const outcome = await A3.rollback.apply(plan, { backups: backed })
      check(outcome.problems.length === 0 && outcome.record.state === 'done', 'the rollback from the backup goes through', outcome.problems)
      const differ = (): string[] => {
        const now = vaultNow()
        const found: string[] = []
        for (const [path, content] of atBackup) if (now.get(path) !== content) found.push(path)
        for (const path of now.keys()) if (!atBackup.has(path)) found.push(`extra ${path}`)
        return found
      }
      check(await eventually(() => differ().length === 0, 20_000), 'the vault is as the backup has it - notes and files', differ())
      const repository = join(encryptedRoot, vaultId)
      const notesSnapshots = (JSON.parse(restic(repository, 'relay password', ['snapshots', '--json', '--tag', 'notes']).stdout.toString('utf8') || '[]') as unknown[]).length
      check(notesSnapshots >= 2, "the backup made first forgot nothing, so the one rolled back from was still there", notesSnapshots)
      // The Time Machine's ticks further back than the history.
      const times = await backups.backupTimes(again.routeId)
      const newest = times.length > 0 ? await backups.backupAt(again.routeId, times.at(-1) as number) : null
      check(
        times.length === notesSnapshots && times.every((time, i) => i === 0 || time > (times[i - 1] as number)) && newest?.notes.time === times.at(-1),
        'the backup server says when the vault was backed up, oldest first, and each time leads to its backup',
        { times, notesSnapshots, newest }
      )
    }

    // --- one note the history no longer reaches, the rest from the history ---------------------------
    {
      check((await backups.backUpFresh(again.routeId, { pollMs: 200, keepAll: true })).ok, 'another backup')
      await delay(500)
      const welcomeThen = A3.vault.text('Welcome.md')
      const newThen = A3.vault.text('New.md')
      const T2 = Date.now()
      await delay(1_100)
      await A3.vault.userWrite('Welcome.md', 'once more after the backup\n')
      await A3.vault.userWrite('New.md', 'changed after the backup too\n')
      check(
        await eventually(() => A3.docText('Welcome.md') === 'once more after the backup\n' && A3.docText('New.md') === 'changed after the backup too\n', 15_000),
        'A edits two notes after it'
      )
      await delay(500)
      const welcome = A3.index?.docIdForPath('Welcome.md') as string
      const compactor = A3.compactor as unknown as { compact(room: string, cutoff: number): Promise<boolean> }
      check(await compactor.compact(docRoom(welcome), Date.now() + 1_000), "and one of them has its history compacted past the backup")
      const plan = await A3.rollback.plan(T2)
      const note = (path: string): (typeof plan.notes)[number] | undefined => plan.notes.find((entry) => entry.pathThen === path)
      check(
        !plan.byPath && plan.backup !== null && plan.outOfReach.length === 0 && note('Welcome.md')?.fromBackup === true && note('Welcome.md')?.textThen === welcomeThen,
        'the plan takes that note from the backup',
        { byPath: plan.byPath, outOfReach: plan.outOfReach, welcome: note('Welcome.md') }
      )
      check(note('New.md')?.text === true && note('New.md')?.fromBackup === undefined && note('New.md')?.textThen === newThen, 'and the other from the history')
      const outcome = await A3.rollback.apply(plan, { backups: [{ label: 'test', ok: true }] })
      check(
        outcome.problems.length === 0 && (await eventually(() => A3.vault.text('Welcome.md') === welcomeThen && A3.vault.text('New.md') === newThen)),
        'both go back',
        outcome.problems
      )
      const ref = plan.backup?.ref as NonNullable<typeof plan.backup>['ref']
      const elsewhere = await refusal(backups.backupListing(again.routeId, { ...ref, destination: 'not-one-of-them' }))
      check(elsewhere.includes('not a backup of this vault'), 'a backup server reads back only from the repositories of the vault the session belongs to', elsewhere)
    }

    // Every device of the account sees it, and may start or disconnect it.
    const A4 = new Device(`anna${run}`, false)
    A4.password = newPassword
    devices.push(A4)
    check(await A4.boot(), 'another device of the account signs in')
    check(await eventually(() => A4.backups.servers().length === 1, 15_000), 'and finds the backup server in the settings')
    check((await A4.backups.ask(again.routeId))?.status?.runs[0]?.ok === true, "and its state, through the vault's pairing")

    // A vault has one backup server: connecting another replaces the one it had.
    const secondData = join(root, 'backup-server-3')
    const second = await startBackupServer({
      server: `ws://127.0.0.1:${port}`,
      dataDir: secondData,
      encryptedRoot: join(root, 'second-encrypted'),
      decryptedRoot: join(root, 'second-decrypted'),
      workDir: join(root, 'ram-3'),
      resticBinary: RESTIC,
      name: 'second backup server',
      version: 'test',
      tickMs: 100,
      watchMs: 100,
      now: () => clock
    })
    stops.push(() => second.close())
    const replacing = await A4.backups.connect(await second.invite('replacing'), newPassword, '')
    check(
      A4.backups.servers().length === 1 && A4.backups.servers()[0]?.routeId === replacing.routeId && A4.settings?.backupTask(again.routeId) === null,
      'connecting a second backup server leaves the vault with that one alone',
      A4.backups.servers()
    )
    check(
      !backupServer.service.has(vaultId) && second.service.has(vaultId) && A4.backups.view(replacing.routeId)?.task === null,
      'the first is told to forget the vault, and the new one waits for a task of its own'
    )
    check(existsSync(join(encryptedRoot, vaultId, 'config')), "the first one's backups stay where they are")
    await A4.backups.disconnect(replacing.routeId)
    check(A4.backups.servers().length === 0 && A4.settings?.backupTask(replacing.routeId) === null, 'disconnecting on any device takes it out of the settings')
    check(!second.service.has(vaultId), 'and the backup server forgets the vault')
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
