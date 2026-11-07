// Attacks on the plugin and the backup server by the people one shares with:
// paths that leave a shared folder, a folder naming someone's other notes, a
// link in a shared note that pulls out a file of the reader's vault, and a
// backup task that would run code on the backup server. A FAIL means the
// attack works again. The end-to-end part runs real devices against a server
// in this process, on a port and in a scratch directory of its own.
//
//   npm run test:security -w @mycel/plugin
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, delay, Device, eventually, failures, useServer } from './harness.mjs'

const { isFilePath, isNotePath, isVaultPath, vaultPathProblem, NOTE_ATTACHMENTS_FIELD } = await import('@mycel/shared')
const { gateApp, PathRefused } = await import('../src/guard.js')
const { envOf, locationProblem, repositoryOf } = await import('../../backup/src/config.js')
const { safePath } = await import('../../backup/src/layout.js')
const { loadConfig } = await import('../../server/src/config.js')
const { startServer } = await import('../../server/src/server.js')

// ===============================================================================
// 1. Paths: what may name a file of the vault.
// ===============================================================================
{
  for (const path of [
    '../outside.md',
    'Shared/X/../../Diary.md',
    'Shared/X/../../../../../../Users/someone/.bashrc',
    '/etc/passwd',
    'C:/Windows/win.ini',
    'c:relative.png',
    '..\\..\\escape.png',
    'Shared\\..\\..\\escape.png',
    '.obsidian/plugins/mycel/main.js',
    'Shared/.obsidian/community-plugins.json',
    '.trash/x.md',
    'Shared/.. /x.md',
    'Shared/... /x.md',
    'Shared//double.md',
    'Shared/./here.md',
    'trailing/',
    '',
    `with${String.fromCharCode(0)}nul.md`,
    `line${String.fromCharCode(10)}break.md`
  ]) {
    check(!isVaultPath(path), `${JSON.stringify(path)} is no path in a vault (${vaultPathProblem(path) ?? 'taken!'})`)
  }
  for (const path of ['Notes/Plan.md', 'Shared/X/Sub/Deep.md', 'Pictures/photo 2.png', 'a.b.c/d.e.md', 'Ünïcödé/日本語.md', 'Draft.']) {
    check(isVaultPath(path), `${JSON.stringify(path)} is a path in a vault`, vaultPathProblem(path))
  }
  check(isNotePath('X/a.md') && !isNotePath('X/a.png') && !isNotePath('../a.md'), 'a note is a vault path ending in .md')
  check(isFilePath('X/a.png') && !isFilePath('X/a.md') && !isFilePath('.obsidian/a.js'), 'a file is any other vault path')
}

// ===============================================================================
// 2. The gate in front of every file the plugin touches.
// ===============================================================================
{
  const touched: string[] = []
  const record =
    (name: string) =>
    async (...args: unknown[]): Promise<string> => {
      const first = args[0] as { path?: string } | string
      touched.push(`${name}:${typeof first === 'string' ? first : first?.path}`)
      return 'done'
    }
  const adapter = Object.fromEntries(
    ['read', 'readBinary', 'exists', 'stat', 'list', 'write', 'writeBinary', 'append', 'process', 'mkdir', 'remove', 'rmdir', 'rename', 'copy', 'trashSystem'].map((name) => [name, record(`adapter.${name}`)])
  )
  const vault = {
    configDir: '.obsidian',
    adapter,
    ...Object.fromEntries(
      ['create', 'createBinary', 'createFolder', 'modify', 'modifyBinary', 'append', 'process', 'rename', 'copy', 'delete', 'trash', 'read', 'readBinary', 'cachedRead'].map((name) => [name, record(`vault.${name}`)])
    ),
    getName: () => 'vault'
  }
  const fileManager = { renameFile: record('fm.renameFile'), trashFile: record('fm.trashFile'), processFrontMatter: record('fm.processFrontMatter') }
  const app = gateApp({ vault, fileManager, workspace: {} } as never, '.obsidian/plugins/mycel') as unknown as {
    vault: typeof vault & { adapter: typeof adapter }
    fileManager: typeof fileManager
  }
  const refused = async (what: string, run: () => Promise<unknown>): Promise<void> => {
    const before = touched.length
    let error: unknown = null
    try {
      await run()
    } catch (caught) {
      error = caught
    }
    check(error instanceof PathRefused && touched.length === before, `the gate refuses ${what}`, String(error))
  }
  const allowed = async (what: string, run: () => Promise<unknown>): Promise<void> => {
    let error: unknown = null
    try {
      await run()
    } catch (caught) {
      error = caught
    }
    check(error === null, `the gate lets through ${what}`, String(error))
  }
  const file = (path: string): { path: string } => ({ path })

  await refused('writing another plugin', () => app.vault.adapter.write('.obsidian/plugins/other/main.js', 'x'))
  await refused("writing Obsidian's list of plugins", () => app.vault.adapter.write('.obsidian/community-plugins.json', '["evil"]'))
  await refused('climbing out of its own folder', () => app.vault.adapter.write('.obsidian/plugins/mycel/../other/main.js', 'x'))
  await refused('reading a file outside the vault', () => app.vault.adapter.read('../../../etc/passwd'))
  await refused('reading the configuration', () => app.vault.adapter.read('.obsidian/app.json'))
  await refused('an absolute path', () => app.vault.adapter.writeBinary('/tmp/x', new ArrayBuffer(1)))
  await refused('a path with backslashes', () => app.vault.adapter.write('Shared\\..\\..\\x.js', 'x'))
  await refused('creating a note outside a folder', () => app.vault.create('Shared/X/../../Diary.md', 'x'))
  await refused('creating a hidden file', () => app.vault.createBinary('Shared/.obsidian/plugins/x/main.js', new ArrayBuffer(1)))
  await refused('moving a file into the configuration', () => app.vault.rename(file('Shared/x.png'), '.obsidian/plugins/x/main.js'))
  await refused('moving with the file manager', () => app.fileManager.renameFile(file('Shared/x.md'), '../x.md'))
  await refused('a moved-out folder', () => app.vault.createFolder('Shared/X/..'))
  await refused('copying into another plugin', () => app.vault.adapter.copy('Notes/a.md', '.obsidian/plugins/x/a.md'))
  await allowed('a note of the vault', () => app.vault.create('Notes/Plan.md', 'x'))
  await allowed('a file of the vault', () => app.vault.createBinary('Shared/Attachments/photo.png', new ArrayBuffer(1)))
  await allowed('moving inside the vault', () => app.vault.rename(file('Shared/a.md'), 'Shared/b.md'))
  await allowed("the plugin's own data", () => app.vault.adapter.write('.obsidian/plugins/mycel/data.json', '{}'))
  await allowed("the plugin's own logs", () => app.vault.adapter.append('.obsidian/plugins/mycel/logs/2026-11-07.log', 'x'))
  await allowed("the plugin's folder itself", () => app.vault.adapter.exists('.obsidian/plugins/mycel'))
  check((app.vault as { configDir: string }).configDir === '.obsidian', 'and everything else of the vault reads as it is')
}

// ===============================================================================
// 3. The backup server: a task names credentials, never a way to run code.
// ===============================================================================
{
  const env = envOf({
    AWS_ACCESS_KEY_ID: 'id',
    AWS_SECRET_ACCESS_KEY: 'secret',
    B2_ACCOUNT_KEY: 'b2',
    OS_PASSWORD: 'swift',
    LD_PRELOAD: '/data/decrypted/x/vault/evil.so',
    LD_LIBRARY_PATH: '/data',
    PATH: '/data/decrypted/x/vault',
    RCLONE_CONFIG: '/data/decrypted/x/vault/rclone.conf',
    RCLONE_SFTP_SSH: 'sh -c id',
    AWS_SHARED_CREDENTIALS_FILE: '/data/decrypted/x/vault/credentials',
    AWS_CONFIG_FILE: '/data/decrypted/x/vault/config',
    AWS_PROFILE: 'evil',
    GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES: '1',
    RESTIC_PASSWORD_COMMAND: 'sh -c id',
    RESTIC_REPOSITORY: '/etc',
    SSH_ASKPASS: '/bin/sh',
    SSH_ASKPASS_REQUIRE: 'force',
    OS_AUTH_COMMAND: 'x',
    HOME: '/data',
    NODE_OPTIONS: '--require /data/x.js'
  })
  check(
    JSON.stringify(Object.keys(env ?? {}).sort()) === JSON.stringify(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'B2_ACCOUNT_KEY', 'OS_PASSWORD']),
    "a backup task's environment holds credentials, nothing that loads, runs or points elsewhere",
    Object.keys(env ?? {})
  )
  for (const location of [
    'sftp:-oProxyCommand=sh${IFS}-c${IFS}id:/repo',
    'sftp:user@-oProxyCommand=id:/repo',
    'sftp://-oProxyCommand=id/repo',
    'rclone:--config=/data/decrypted/x/rclone.conf',
    'rclone:remote:path --rc',
    `s3:https://example.com/bucket${String.fromCharCode(10)}`
  ]) {
    check(locationProblem(location) !== null, `the backup server does not hand restic ${JSON.stringify(location)}`)
  }
  for (const location of ['s3:https://s3.example.com/bucket/vault', 'b2:bucket:vault', 'sftp:backup@nas.local:/srv/restic', 'rest:https://user:pass@host:8000/', 'rclone:pcloud:vault']) {
    check(locationProblem(location) === null, `it takes ${location}`, locationProblem(location))
  }
  const folders = { encrypted: '/encrypted/v', decrypted: '/decrypted/v' }
  const injected = repositoryOf({ where: 'cloud', location: 'sftp:-oProxyCommand=id:/x', password: 'p' }, folders)
  check('error' in injected, 'a task with such a location is not run at all', injected)
  for (const [path, expected] of [
    ['..\\..\\..\\etc\\cron.d\\x', '__/__/__/etc/cron.d/x'],
    ['a/.. /b.md', 'a/__/b.md'],
    ['a/../../b.md', 'a/__/__/b.md']
  ] as const) {
    check(safePath(path) === expected, `a backup writes ${JSON.stringify(path)} below its folder, as ${expected}`, safePath(path))
  }
}

// ===============================================================================
// 4. End to end: a contact who shares with you, and one you share with.
// ===============================================================================
const root = mkdtempSync(join(tmpdir(), 'mycel-plugin-security-'))
const serve = (port: number): ReturnType<typeof startServer> =>
  startServer(
    loadConfig({
      HOST: '127.0.0.1',
      PORT: String(port),
      MYCEL_DATA_DIR: join(root, 'server'),
      MYCEL_REGISTRATION: 'open',
      MYCEL_JWT_SECRET: 'plugin-security-selftest-secret-0123456789'
    }),
    { logger: false, paceMs: 0, maxFailures: 1000 }
  )
let server = await serve(0)
const port = server.port
useServer(`ws://127.0.0.1:${port}`)

/** Where the server keeps a note's metadata - to play a server that moves it back. */
function noteMetaFile(owner: string, docId: string): string | null {
  const vaults = join(root, 'server', 'users', owner)
  for (const vault of existsSync(vaults) ? readdirSync(vaults) : []) {
    const file = join(vaults, vault, 'notes', docId, 'meta.json')
    if (existsSync(file)) return file
  }
  return null
}
const run = Date.now().toString(36)
const binary = (seed: number, length = 2_000): Uint8Array => new Uint8Array(length).map((_byte, index) => (index * seed + 7) & 255)

// Mallory shares a folder with Victor and may write in Victor's note: Mallory is the attacker.
const mallory = new Device(`mallory${run}`, true, { 'Trap/Bait.md': 'bait\n', 'Trap/pic.png': binary(5) })
const victor = new Device(`victor${run}`, true, {
  'Private/Diary.md': 'my diary\n',
  'Private/passport.pdf': binary(9),
  'Notes/Shared with M.md': 'notes for mallory\n'
})
const outside = (device: Device): string[] => device.vault.paths().concat(device.vault.attachmentPaths()).filter((path) => !isVaultPath(path))

try {
  check(await mallory.boot(), "the attacker's device starts")
  check(await victor.boot(), "the victim's device starts")
  const code = await (mallory.contacts as NonNullable<typeof mallory.contacts>).createCode()
  await victor.contacts?.redeem(code)
  check(
    await eventually(() => mallory.contacts?.isContact(victor.accountId) === true && victor.contacts?.isContact(mallory.accountId) === true, 15_000),
    'the two are contacts'
  )

  // --- a folder whose document names paths outside it ---------------------------
  await mallory.folders?.share('Trap', victor.accountId, 'write', true)
  const folderId = mallory.index?.liveFolders().find(({ folder }) => folder.path === 'Trap')?.folderId as string
  check(
    await eventually(() => victor.vault.text('Shared/Trap/Bait.md') === 'bait\n', 15_000),
    'the victim has the shared folder',
    victor.vault.paths()
  )
  const document = mallory.folders?.documentOf(folderId)
  const baitId = mallory.index?.docIdForPath('Trap/Bait.md') as string
  const picId = document?.allFiles()[0]?.fileId
  check(document !== undefined && picId !== undefined, "the attacker holds the folder's document")
  if (document && picId) {
    const notes = document.doc.getMap<Record<string, unknown>>('notes')
    const files = document.doc.getMap<Record<string, unknown>>('files')
    const pic = files.get(picId) as Record<string, unknown>
    document.doc.transact(() => {
      notes.set(baitId, { path: '../../Private/Diary.md', updatedAt: Date.now(), by: mallory.accountId })
      notes.set('0123456789abcdef0123456789abcdef', { path: '../../../../../../escaped.md', updatedAt: Date.now(), by: mallory.accountId })
      files.set(picId, { ...pic, path: '../../.obsidian/plugins/mycel/main.js', updatedAt: Date.now() })
      files.set('fedcba9876543210fedcba9876543210', { ...pic, path: '.obsidian/community-plugins.json', updatedAt: Date.now() })
      files.set('00112233445566778899aabbccddeeff', { ...pic, path: 'Sub\\..\\..\\..\\escape.png', updatedAt: Date.now() })
    }, 'folder')
    await delay(3_000)
    await victor.folders?.settled()
    check(outside(victor).length === 0, "no path of the folder's document reaches the victim's vault outside the folder", outside(victor))
    check(victor.vault.text('Private/Diary.md') === 'my diary\n', "the victim's own note at that place is untouched")
    check(victor.vault.text('Shared/Trap/Bait.md') === 'bait\n', 'the note renamed out of the folder stays where it was')
    check(
      !victor.vault.attachmentPaths().some((path) => path.includes('main.js') || path.includes('community-plugins')),
      'no file of the folder lands as a plugin',
      victor.vault.attachmentPaths()
    )
  }

  // --- a link in a shared note that pulls out a file -----------------------------
  const sharedId = victor.index?.docIdForPath('Notes/Shared with M.md') as string
  await victor.sharing?.share(sharedId, mallory.accountId, 'write', true, true)
  check(
    await eventually(() => mallory.vault.text('Shared/Shared with M.md') === 'notes for mallory\n', 15_000),
    'the victim shares a note with the attacker, who may write in it - and knows its id',
    mallory.vault.paths()
  )
  const view = mallory.open('Shared/Shared with M.md')
  view.type('\n![[passport.pdf]]\n')
  check(await eventually(() => (victor.vault.text('Notes/Shared with M.md') ?? '').includes('passport.pdf'), 15_000), "the attacker's link reaches the victim")
  // Longer than any device waits for the one that typed a link to name its file.
  await delay(5_000)
  const handle = await victor.store?.handle(sharedId)
  const listed = handle ? Array.from(handle.doc.getMap(NOTE_ATTACHMENTS_FIELD).keys()) : []
  check(!listed.includes('passport.pdf'), "a link someone else typed does not share the victim's file of that name", listed)
  check(!mallory.vault.attachmentPaths().some((path) => path.endsWith('passport.pdf')), 'and the attacker never gets it', mallory.vault.attachmentPaths())
  mallory.close(view)

  // --- a folder naming one of the victim's own notes ---------------------------
  if (document) {
    document.doc.transact(() => document.doc.getMap('notes').set(sharedId, { path: 'Taken.md', updatedAt: Date.now(), by: mallory.accountId }), 'folder')
    await delay(2_000)
    await victor.folders?.settled()
    const entry = victor.index?.entry(sharedId)
    check(entry !== undefined && entry.owner === undefined && entry.folder === undefined, "naming the victim's own note in a folder does not hand it to the folder's owner", entry)
    document.doc.transact(() => document.doc.getMap('notes').set(sharedId, { path: 'Taken.md', updatedAt: Date.now(), deletedAt: Date.now(), by: mallory.accountId }), 'folder')
    await delay(2_000)
    await victor.folders?.settled()
    check(
      victor.index?.entry(sharedId)?.deletedAt === undefined && (victor.vault.text('Notes/Shared with M.md') ?? '').startsWith('notes for mallory\n'),
      'nor does deleting it there delete it',
      victor.index?.entry(sharedId)
    )
  }

  // --- a server that moves a note back to an epoch the revoked person holds -------
  {
    const room = `doc:${sharedId}`
    await victor.sharing?.revoke(sharedId, mallory.accountId)
    const revokedAt = (await victor.api.log(room)).epoch
    check(await eventually(() => victor.socket?.epochOf(room) === revokedAt, 10_000), 'the victim revokes the attacker; the note moves to an epoch the attacker never gets', revokedAt)
    // The attacker's copy goes on as their own, a fork, before the server goes down under it.
    await eventually(() => {
      const forked = mallory.index?.docIdForPath('Shared/Shared with M.md')
      return forked !== undefined && forked !== sharedId
    }, 15_000)
    await delay(1_000)
    // The server, working with the attacker, takes the note back to the epoch before.
    await server.close()
    const metaFile = noteMetaFile(victor.accountId, sharedId)
    check(metaFile !== null, "the note's metadata is on the server's disk")
    if (metaFile) {
      const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as { epoch: number }
      writeFileSync(metaFile, JSON.stringify({ ...meta, epoch: revokedAt - 1 }, null, 2))
    }
    server = await serve(port)
    const headBefore = (await eventually(async () => (await victor.api.log(room).catch(() => null)) !== null, 10_000)) ? (await victor.api.log(room)).headSeq : 0
    const view = victor.open('Notes/Shared with M.md')
    view.type('\nwritten after the revocation\n')
    check(
      await eventually(async () => (await victor.api.log(room)).headSeq > headBefore, 20_000),
      'what the victim writes still reaches the server',
      (await victor.api.log(room)).headSeq
    )
    const after = await victor.api.log(room)
    const newer = after.frames.filter((frame) => frame.seq > headBefore)
    check(
      newer.length > 0 && newer.every((frame) => frame.epoch > revokedAt) && after.epoch > revokedAt,
      'but never under the earlier epoch the server went back to: the victim moves the note past it first',
      { revokedAt, epoch: after.epoch, frames: newer.map((frame) => frame.epoch) }
    )
    victor.close(view)
  }
} catch (error) {
  console.error(error)
  failures.push(`the test itself failed: ${String(error)}`)
} finally {
  for (const device of [mallory, victor]) await device.shutdown().catch(() => undefined)
  await server.close().catch(() => undefined)
  rmSync(root, { recursive: true, force: true })
}

console.log(failures.length === 0 ? '\nevery attack tried here was refused' : `\n${failures.length} check(s) failed:\n${failures.map((failure) => `  - ${failure}`).join('\n')}`)
process.exit(failures.length === 0 ? 0 : 1)
