// The Time Machine's second round (docs/TIMEMACHINE.md), against real devices
// and a sync server in this process: the past written into one device's files
// while its sync is stopped and the vault locked on the others, put back byte
// for byte with its times - after a crash too, before the sync starts -; the
// lock against the account's other devices and for a rollback; a note's past
// in its own editor; a synced file's modification time; the notices kept for
// the notification center.
//
//   npm run test:timemachine
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, delay, Device, eventually, failures, finish, PLUGIN_DIR, useServer } from './harness.mjs'

const { loadConfig } = await import('../../server/src/config.js')
const { startServer } = await import('../../server/src/server.js')
const { TimeMachineSession } = await import('../src/history/TimeMachine.js')
const { PastFiles, PastFilesClosed } = await import('../src/history/PastFiles.js')
const { barScale } = await import('../src/history/Strip.js')
const { pastEditorExtension } = await import('../src/history/pastEditor.js')
const { LockSeal, VaultLockedError, lockNonce, takeVaultLock } = await import('../src/sync/VaultLock.js')
const { Blobs } = await import('../src/sync/Blobs.js')
const { Notice, notices } = await import('../src/notices.js')
const { FakeAdapter, FakeVault } = await import('./stubs/fake-vault.js')
const { EditorState } = await import('@codemirror/state')
const { EditorView } = await import('@codemirror/view')

type Session = Awaited<ReturnType<typeof TimeMachineSession.load>>
type Scope = Session['scope']

const root = mkdtempSync(join(tmpdir(), 'oc-timemachine-selftest-'))
const run = Date.now().toString(36)
const server = await startServer(
  loadConfig({
    HOST: '127.0.0.1',
    PORT: '0',
    MYCEL_DATA_DIR: join(root, 'server'),
    MYCEL_REGISTRATION: 'open',
    MYCEL_JWT_SECRET: 'timemachine-selftest-secret-of-32-characters'
  }),
  { logger: false, paceMs: 0 }
)
useServer(`ws://127.0.0.1:${server.port}`)

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const same = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean => a !== undefined && b !== undefined && Buffer.from(a).equals(Buffer.from(b))
const photo = bytes('photo, as it was '.repeat(200))
const photoLater = bytes('photo, painted over '.repeat(200))
const later = bytes('a picture that came later '.repeat(50))

const A1 = new Device(`anna${run}`, true, {
  'Welcome.md': 'hello\n',
  'Projects/Plan.md': 'the plan\n',
  'Projects/Old.md': 'old\n',
  'Keep/Untouched.md': 'untouched\n',
  'Bilder/Foto.png': photo
})
const A2 = new Device(`anna${run}`, false)
const devices = [A1, A2]

/** Every file of a device, its content and its modification time. */
function snapshot(device: Device): Map<string, string> {
  const found = new Map<string, string>()
  for (const file of device.vault.getFiles()) {
    const data = device.vault.bytes(file.path) ?? bytes(device.vault.text(file.path) ?? '')
    found.set(file.path, `${Buffer.from(data).toString('base64')}@${file.stat.mtime}`)
  }
  return found
}

function differences(a: Map<string, string>, b: Map<string, string>): string[] {
  const differ: string[] = []
  for (const [path, value] of a) if (b.get(path) !== value) differ.push(path)
  for (const path of b.keys()) if (!a.has(path)) differ.push(`extra ${path}`)
  return differ
}

/** What the Time Machine takes from the running sync before it stops it, as main.ts's `prepareTimeMachine`. */
function prepare(device: Device) {
  const store = device.store as NonNullable<Device['store']>
  const keys = device.keys as NonNullable<Device['keys']>
  const attachments = device.attachments as NonNullable<Device['attachments']>
  const notes = store.allEntries()
  const owners = new Map(notes.map(({ docId, entry }) => [docId, entry.owner]))
  const blobs = new Blobs(device.api, keys)
  return {
    vaultId: keys.vaultId,
    seal: new LockSeal(keys.settingsCrypto(), keys.vaultId),
    now: { notes, files: attachments.allEntries(), isExcluded: () => false, folderOwner: () => null, readOnly: () => false },
    source: {
      api: device.api,
      vaultId: keys.vaultId,
      indexCrypto: keys.indexCrypto(),
      noteCrypto: (docId: string) => keys.noteCrypto(docId, { owned: !owners.get(docId), folder: true, owner: owners.get(docId) ?? null }),
      download: (hash: string) => blobs.download(hash),
      backups: null
    }
  }
}

/** The Time Machine opened on a device as `TimeMachineControl` does: the past read, the vault locked, the sync stopped, the journal open. */
async function open(device: Device, scope: Scope, marks: Array<{ at: number; label: string }> = []) {
  const prepared = prepare(device)
  const session = await TimeMachineSession.load(scope, prepared.source, prepared.now, {
    vault: device.vault as never,
    choice: 'change',
    includeBackups: false,
    fileLimit: Number.POSITIVE_INFINITY,
    marks
  })
  const sealed = await prepared.seal.seal({ what: 'the test', device: device.username, nonce: lockNonce(), scope })
  device.ownLocks.add(sealed)
  const lock = await takeVaultLock(device.api, prepared.vaultId, 'preview', sealed, () => undefined)
  await device.shutdown({ keepViews: true })
  const files = await PastFiles.begin(device.vault as never, device.pluginAdapter as never, PLUGIN_DIR, { scope, lockId: lock.id, vaultId: prepared.vaultId })
  session.attach(files)
  // What main.ts does with the vault's events while the Time Machine runs.
  const listen = (file: unknown): void => files.noteEvent((file as { path: string }).path)
  const refs = ['modify', 'create', 'delete'].map((name) => device.vault.on(name, listen))
  return { session, files, lock, sealed, prepared, stop: () => refs.forEach((ref) => device.vault.offref(ref)) }
}

/** The moment after the last change before `at` - and before any after it. */
function placeBefore(session: Session, at: number): number {
  let place = -1
  session.positions.forEach((position, i) => {
    if (position.tick && position.tick.last < at) place = i
  })
  return place
}

try {
  // --- the notices, kept for the notification center ----------------------------------------
  {
    const adapter = new FakeAdapter()
    await notices.attach(adapter as never, 'plugin/notices.json')
    notices.clear()
    new Notice('Projects/Plan.md: syncing failed, see the log')
    new Notice('Shared a note with Ben.')
    const kept = notices.list()
    check(
      kept.length === 2 && kept[0]?.text === 'Shared a note with Ben.' && kept[1]?.kind === 'error' && kept[1]?.path === 'Projects/Plan.md' && kept[0]?.kind === 'info',
      'every notice is kept for the notification center, the newest first, a failure as one, with the note it names',
      kept
    )
    check(notices.unseen() === 2, 'and counted as not seen')
    notices.markSeen()
    check(notices.unseen() === 0, 'until the center was looked at')
    notices.detach()
    const stored = JSON.parse(adapter.files.get('plugin/notices.json') ?? '{}') as { entries?: unknown[] }
    check(stored.entries?.length === 2, 'they stay on the device, in the plugin folder', stored)
    notices.clear()

    // A notice with a button: Obsidian takes the fragment's nodes, and 0.8.13 kept nothing of it.
    await notices.attach(adapter as never, 'plugin/notices.json')
    const undone: unknown[] = []
    const unhandle = notices.handle('test-undo', async (data) => {
      undone.push(data)
    })
    const fragment = document.createDocumentFragment()
    fragment.append(document.createTextNode('"Plan" was deleted for everyone in "Projects" (Ben). '))
    const button = document.createElement('button')
    button.textContent = 'Undo'
    fragment.append(button)
    const notice = new Notice(fragment, 15_000, { label: 'Undo', kind: 'test-undo', data: { folderId: 'f' } })
    const entry = notices.list()[0]
    check(
      notice.entry === entry && entry?.text === '"Plan" was deleted for everyone in "Projects" (Ben).' && entry.action?.label === 'Undo' && notices.canAct(entry),
      'a notice with a button is kept too, its button with it',
      entry
    )
    await notices.act(entry as NonNullable<typeof entry>)
    await notices.act(entry as NonNullable<typeof entry>)
    check(undone.length === 1 && (undone[0] as { folderId: string }).folderId === 'f' && !notices.canAct(entry as NonNullable<typeof entry>), 'pressed from the center it does what the notice did, once', undone)
    notices.detach()
    const again = JSON.parse(adapter.files.get('plugin/notices.json') ?? '{}') as { entries?: Array<{ action?: { done?: boolean } }> }
    check(again.entries?.at(-1)?.action?.done === true, 'and stays done after a restart', again)
    unhandle()
    notices.clear()

    // *Undo…* of a rollback opens the Time Machine: it stays on offer after it was pressed (0.8.16).
    const opened: unknown[] = []
    const unhandleOpen = notices.handle('test-open', async (data) => {
      opened.push(data)
    })
    const rolled = new Notice('The vault is back to then.', 10_000, { label: 'Undo…', kind: 'test-open', data: 'r1', again: true })
    await notices.act(rolled.entry as NonNullable<typeof rolled.entry>)
    await notices.act(rolled.entry as NonNullable<typeof rolled.entry>)
    check(opened.length === 2 && notices.canAct(rolled.entry as NonNullable<typeof rolled.entry>), "a button that opens something is offered again after it was pressed", opened)
    unhandleOpen()
    notices.clear()
  }
  {
    const { rollbackMarks, recordScope } = await import('../src/history/TimeMachine.js')
    const record = (id: string, folder: string, kind?: 'note') => ({ id, startedAt: 1_000, to: 500, folder, state: 'done' as const, notes: 1, files: 0, ...(kind ? { kind } : {}) })
    const records = [record('v', ''), record('f', 'Projects'), record('s', 'Projects/Sub'), record('n', 'Projects/Plan.md', 'note')]
    const marks = (scope: Parameters<typeof rollbackMarks>[1]) => rollbackMarks(records, scope).map((mark) => mark.label.split(' ')[2])
    check(
      marks({ kind: 'vault' }).length === 1 &&
        rollbackMarks(records, { kind: 'folder', path: 'Projects' }).length === 1 &&
        rollbackMarks(records, { kind: 'note', path: 'Projects/Plan.md' }).length === 1 &&
        rollbackMarks(records, { kind: 'folder', path: 'Other' }).length === 0,
      "a timeline marks only the rollbacks of exactly its own place - the vault's not a folder's, which shown in the vault restored all of it (0.8.16)",
      { vault: marks({ kind: 'vault' }) }
    )
    check(
      marks({ kind: 'note', path: 'Projects/Plan.md' })[0] === 'restore' &&
        marks({ kind: 'vault' })[0] === 'rollback' &&
        rollbackMarks(records, { kind: 'vault' })[0]?.at === 999,
      'a note restored is marked as a restore, the moment just before it began'
    )
    const scopes = records.map(recordScope)
    check(
      scopes[0]?.kind === 'vault' && scopes[1]?.kind === 'folder' && scopes[3]?.kind === 'note' && (scopes[3] as { path: string }).path === 'Projects/Plan.md',
      "*Undo…* opens the Time Machine of what a rollback took back",
      scopes
    )
  }
  {
    // A note locked by another device says so in a bar at its editor's top, with the way to lift the lock (0.8.16).
    let banner: { text: string; unlock: (() => void) | null } | null = { text: 'Read-only while the Time Machine on a computer shows the past of the note Plan.', unlock: null }
    let unlocked = 0
    banner.unlock = () => (unlocked += 1)
    const listeners = new Set<() => void>()
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'the plan\n',
        extensions: [
          EditorState.readOnly.of(false),
          EditorView.editable.of(true),
          pastEditorExtension(
            {
              pastOf: async () => null,
              lockedWhy: () => (banner ? 'locked' : null),
              banner: () => banner,
              onChange: (listener) => {
                listeners.add(listener)
                return () => listeners.delete(listener)
              }
            },
            () => ({ path: 'Projects/Plan.md' })
          )
        ]
      })
    })
    check(
      await eventually(() => view.state.readOnly && parent.querySelector('.mycel-lock-banner-text')?.textContent === banner?.text),
      'a locked note shows why at the top of its editor',
      parent.innerHTML.slice(0, 400)
    )
    const panel = parent.querySelector('.mycel-lock-banner')
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'arrived from elsewhere\n' } })
    check(parent.querySelector('.mycel-lock-banner') === panel, 'and keeps that bar while the note changes under it, rather than drawing it again')
    parent.querySelector<HTMLButtonElement>('.mycel-lock-banner button')?.click()
    check(unlocked === 1, 'its Unlock… opens the window that lifts the lock')
    banner = null
    for (const listener of listeners) listener()
    check(
      await eventually(() => !view.state.readOnly && parent.querySelector('.mycel-lock-banner') === null),
      'once the lock ends, the bar goes and the note can be edited again'
    )
    view.destroy()
    parent.remove()
  }
  {
    const { inLockScope } = await import('../src/sync/VaultLock.js')
    const { dimRule } = await import('../src/history/ExplorerGuard.js')
    check(
      inLockScope({ kind: 'folder', path: 'Projects' }, 'Projects/Plan.md') &&
        !inLockScope({ kind: 'folder', path: 'Projects' }, 'Projects2/Plan.md') &&
        inLockScope({ kind: 'note', path: 'Welcome.md' }, 'Welcome.md') &&
        !inLockScope({ kind: 'note', path: 'Welcome.md' }, 'Other.md') &&
        inLockScope({ kind: 'vault' }, 'Anything/at all.md'),
      'a lock covers its folder, its note or the vault - and nothing beside them'
    )
    const rule = dimRule({ kind: 'folder', path: 'A "quoted"/B' })
    check(
      rule.includes(':not([data-path^="A \\"quoted\\"/B/"])') && rule.includes(':not([data-path="A \\"quoted\\""])') && dimRule({ kind: 'vault' }) === '',
      'the explorer greys what lies outside a folder, the way to it excepted, by the paths its entries carry',
      rule
    )
  }
  check(barScale(0) > barScale(40) && barScale(40) > barScale(80) && barScale(80) > 1 && barScale(200) === 1, "the timeline's bars grow towards the pointer, falling off as a wave", [
    barScale(0),
    barScale(40),
    barScale(80),
    barScale(200)
  ])

  // --- Windows holding the copies a moment: leaving the past goes all the same (0.9.27) ---------------
  {
    const DIR = 'plugin'
    type Plain = InstanceType<typeof FakeAdapter>
    type Vault = InstanceType<typeof FakeVault>
    const refusal = (syscall: string, path: string): Error => Object.assign(new Error(`EPERM: operation not permitted, ${syscall} '${path}'`), { code: 'EPERM' })
    /**
     * The plugin folder as Windows answered while something held the copies: `rmdir` and `remove`
     * refused so many times. With `slow.on`, reading a copy takes a second.
     */
    const holding = (plain: Plain, refuse: { rmdir: number; remove: number }, events: string[] = [], slow = { on: false }): Plain =>
      new Proxy(plain, {
        get(target, name, receiver) {
          if (name === 'rmdir') {
            return async (path: string) => {
              events.push('rmdir')
              if (refuse.rmdir > 0) {
                refuse.rmdir -= 1
                throw refusal('rmdir', `${path}/copies`)
              }
              return target.rmdir(path)
            }
          }
          if (name === 'remove') {
            return async (path: string) => {
              if (refuse.remove > 0) {
                refuse.remove -= 1
                throw refusal('unlink', path)
              }
              return target.remove(path)
            }
          }
          if (name === 'readBinary') {
            return async (path: string) => {
              const data = await target.readBinary(path)
              if (slow.on && path.includes('/copies/')) {
                await delay(1_000)
                events.push('read')
              }
              return data
            }
          }
          const value = Reflect.get(target, name, receiver) as unknown
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
        }
      })
    const vaultNow = (): Vault => new FakeVault({ 'Note.md': 'now\n', 'Later.md': 'later\n' })
    const showPast = async (vault: Vault, adapter: Plain) => {
      const files = await PastFiles.begin(vault as never, adapter as never, DIR, { scope: null, lockId: null, vaultId: null })
      await files.show('Note.md', 'the past\n')
      await files.show('Later.md', null)
      return files
    }
    const isNow = (vault: Vault): boolean => vault.text('Note.md') === 'now\n' && vault.text('Later.md') === 'later\n'
    const copies = (plain: Plain): string[] => Array.from(plain.binaries.keys()).filter((key) => key.includes('/timemachine/copies/'))

    {
      const vault = vaultNow()
      const plain = new FakeAdapter()
      const refuse = { rmdir: 2, remove: 0 }
      const events: string[] = []
      const slow = { on: false }
      const adapter = holding(plain, refuse, events, slow)
      const files = await showPast(vault, adapter)
      check(vault.text('Note.md') === 'the past\n' && vault.text('Later.md') === undefined, 'the past lies in the files', vault.text('Note.md'))
      const report = await files.restore()
      // An editor's marks still reading what the note says now as the copies go.
      slow.on = true
      const reading = files.originalBytes('Note.md')
      await files.finish()
      check(report.failed.length === 0 && isNow(vault), 'every file goes back', report)
      check((await reading) !== undefined && events[0] === 'read' && events[1] === 'rmdir', 'a copy still being read is waited for before the copies go', events)
      check(
        refuse.rmdir === 0 && !(await plain.exists(`${DIR}/timemachine`)) && !(await PastFiles.pending(adapter as never, DIR)),
        'Windows refusing to remove the copies for a moment (EPERM): tried again, and journal and copies go'
      )
    }
    {
      const vault = vaultNow()
      const plain = new FakeAdapter()
      const refuse = { rmdir: 99, remove: 0 }
      const adapter = holding(plain, refuse)
      const files = await showPast(vault, adapter)
      const report = await files.restore()
      const left = await files.finish().then(
        () => null,
        (error: unknown) => error
      )
      check(
        report.failed.length === 0 && left === null && isNow(vault) && !(await PastFiles.pending(adapter as never, DIR)),
        'refusing for good: leaving the past goes all the same, the journal gone - in 0.9.26 it failed with every file back, and the rollback never ran',
        left
      )
      check((await files.originalBytes('Note.md')) === undefined, 'and what a note says now is read from the vault from then on, never from a copy')
      const leftOver = copies(plain)
      check(leftOver.length > 0, 'the copies stay for now', leftOver)
      refuse.rmdir = 0
      const again = await showPast(vault, adapter)
      check(
        leftOver.every((key) => !plain.binaries.has(key)) && copies(plain).length > 0 && copies(plain).every((key) => key.split('/').pop()?.startsWith(`${again.start.at}-`) === true),
        'the next Time Machine clears what was left first, its own copies named apart',
        copies(plain)
      )
      await PastFiles.clearLeftovers(adapter as never, DIR)
      check((await PastFiles.pending(adapter as never, DIR)) && copies(plain).length > 0, 'and leftovers are never cleared while a journal waits')
      const back = await again.restore()
      await again.finish()
      check(back.failed.length === 0 && isNow(vault) && !(await plain.exists(`${DIR}/timemachine`)), 'that one goes back and away too')
    }
    {
      const vault = vaultNow()
      const plain = new FakeAdapter()
      const refuse = { rmdir: 0, remove: 99 }
      const adapter = holding(plain, refuse)
      const files = await showPast(vault, adapter)
      await files.restore()
      const failed = await files.finish().then(
        () => null,
        (error: unknown) => error
      )
      check(
        failed instanceof Error && (await PastFiles.pending(adapter as never, DIR)) && copies(plain).length > 0,
        'a journal that cannot go: leaving says so, and journal and copies stay for Abort or the next start',
        failed
      )
      refuse.remove = 0
      const resumed = await PastFiles.resume(vault as never, adapter as never, DIR)
      const report = await resumed?.restore()
      await resumed?.finish()
      check(report?.failed.length === 0 && isNow(vault) && !(await PastFiles.pending(adapter as never, DIR)), 'and the next try finishes it', report)
    }
  }

  for (const device of devices) check(await device.boot(), `${device.username} starts`)
  check(
    await eventually(() => A2.vault.text('Welcome.md') === 'hello\n' && same(A2.vault.bytes('Bilder/Foto.png'), photo), 15_000),
    "A's second device has the whole vault"
  )
  // The server says when notes were edited only to the minute, rounded down: the moment lies just before a
  // minute begins, and the changes after it in that minute - so none of them is rounded down to before it.
  let wait = 60_000 - (Date.now() % 60_000) - 2_000
  if (wait < 0) wait += 60_000
  await delay(wait)
  const T = Date.now()
  await delay(2_500)

  // --- a synced file carries the time its change was made ------------------------------------
  const typedFrom = Date.now()
  await A1.vault.userWrite('Welcome.md', 'hello, changed\n')
  const typedUntil = Date.now()
  check(await eventually(() => A2.vault.text('Welcome.md') === 'hello, changed\n'), 'A changes a note')
  const arrivedAt = A2.vault.file('Welcome.md').stat.mtime
  check(
    arrivedAt >= typedFrom && arrivedAt <= typedUntil + 1_000,
    "on the other device its file carries the time the change was made, not the time it arrived - a plugin stamping notes sees no edit there",
    { arrivedAt, typedFrom, typedUntil }
  )

  // --- what happens after the moment ------------------------------------------------------------
  await A1.vault.userCreate('New.md', 'a new note\n')
  await A1.vault.trash(A1.vault.file('Projects/Old.md'))
  await A1.vault.createFolder('Archive')
  await A1.vault.rename(A1.vault.file('Projects/Plan.md'), 'Archive/Plan.md')
  await A1.vault.userWriteBinary('Bilder/Foto.png', photoLater)
  await A1.vault.userCreateBinary('Bilder/New.png', later)
  const settled = (device: Device): boolean =>
    device.vault.text('New.md') === 'a new note\n' &&
    device.vault.text('Projects/Old.md') === undefined &&
    device.vault.text('Archive/Plan.md') === 'the plan\n' &&
    same(device.vault.bytes('Bilder/Foto.png'), photoLater) &&
    same(device.vault.bytes('Bilder/New.png'), later)
  check(await eventually(() => settled(A2), 20_000), 'A adds, deletes, moves and changes notes and files, and the other device follows')
  await delay(500)
  const now1 = snapshot(A1)
  const now2 = snapshot(A2)

  // --- the vault's past in the files ---------------------------------------------------------------
  {
    const opened = await open(A1, { kind: 'vault' })
    const { session, files } = opened
    check(await eventually(() => A2.socket?.isLocked === true), "the vault is locked on the account's other device")
    const place = placeBefore(session, T)
    check(place >= 0 && session.positions.at(-1)?.tick === null, 'the timeline has a moment before the changes, and now at its end', session.positions)
    await session.moveTo(place)
    const vault = A1.vault
    check(vault.text('Welcome.md') === 'hello\n', 'the note says what it said then, in its own file')
    check(vault.text('New.md') === undefined && vault.bytes('Bilder/New.png') === undefined, 'what came later is gone from the vault')
    check(vault.text('Projects/Old.md') === 'old\n', 'what was deleted since is back, with its text')
    check(vault.text('Projects/Plan.md') === 'the plan\n' && vault.text('Archive/Plan.md') === undefined && !vault.hasFolder('Archive'), 'what moved is where it was, and a folder that came later is gone')
    check(same(vault.bytes('Bilder/Foto.png'), photo), 'a picture shows its content then')
    check(vault.file('Welcome.md').stat.mtime < T, 'and a note its modification time then', vault.file('Welcome.md').stat.mtime)
    const item = (path: string) => session.items.find((entry) => entry.pathThen === path || entry.pathNow === path)
    check(
      item('Projects/Old.md')?.back === true &&
        item('New.md')?.goes === true &&
        item('Projects/Plan.md')?.moved === true &&
        item('Welcome.md')?.changed === true &&
        item('Keep/Untouched.md')?.changed === false &&
        item('Bilder/Foto.png')?.changed === true,
      'the overview says what differs from now, the texts compared',
      session.items
    )
    check(session.showsPast('Welcome.md') && (await session.nowTextOf('Welcome.md')) === 'hello, changed\n', 'an editor of the note learns it is read-only, and what it says now')

    // Meanwhile on the other device.
    await A2.vault.userWrite('Keep/Untouched.md', 'written while locked\n')
    await delay(1_500)
    const note = A2.vault.file('Keep/Untouched.md')
    check(A2.store?.noteState(note) === 'unsent', 'what the other device writes meanwhile waits there: the server takes nothing from it')
    // Someone writes over a past file here - a plugin, the user in another app.
    await vault.userWrite('Welcome.md', 'stamped by a plugin\n')
    const otherLock = await takeVaultLock(A2.api, opened.prepared.vaultId, 'preview', 'eA==', () => undefined).then(
      () => null,
      (error: unknown) => error
    )
    check(
      otherLock instanceof VaultLockedError &&
        otherLock.lock?.kind === 'preview' &&
        (await opened.prepared.seal.open(otherLock.lock.sealed))?.what === 'the test',
      'another device cannot lock it too, and reads who holds it and why'
    )

    const report = await session.restore()
    opened.stop()
    check(report.failed.length === 0 && report.aside.includes('Welcome.md'), 'back to now: every file goes back, and what was written over the past is kept aside', report)
    check(
      report.asideDir !== null && report.asideDir.startsWith(`${PLUGIN_DIR}/`) && vault.adapter.binaries.get(`${report.asideDir}/Welcome.md`) !== undefined,
      'in the plugin folder, behind the gate',
      Array.from(vault.adapter.binaries.keys()).filter((key) => key.includes('aside'))
    )
    check(differences(now1, snapshot(A1)).length === 0, 'every file is as it was, byte for byte, with its times', differences(now1, snapshot(A1)))
    await files.finish()
    check(!(await PastFiles.pending(vault.adapter as never, PLUGIN_DIR)), 'and the journal is gone')
    await opened.lock.release()
    A1.ownLocks.delete(opened.sealed)
    check(await eventually(() => A2.socket?.isLocked === false), 'the lock ends on the other device too')
    check(await A1.boot(), 'the sync starts again')
    check(await eventually(() => A1.vault.text('Keep/Untouched.md') === 'written while locked\n', 15_000), 'and what the other device wrote meanwhile arrives')
    await delay(1_500)
    check(differences(now2, snapshot(A2)).filter((path) => path !== 'Keep/Untouched.md').length === 0, 'nothing of the past ever reached the other device', differences(now2, snapshot(A2)))
  }

  // --- a crash while a note shows its past ----------------------------------------------------------
  {
    const before = snapshot(A1)
    const opened = await open(A1, { kind: 'note', path: 'Welcome.md' })
    const place = placeBefore(opened.session, T)
    await opened.session.moveTo(place)
    check(A1.vault.text('Welcome.md') === 'hello\n', "a note's Time Machine shows its past in the note's own file")
    // Its editor: read-only, the changes against now marked in it.
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: A1.vault.text('Welcome.md') ?? '',
        extensions: [
          // What Obsidian's own editor says, before any plugin's: both facets take the first value given.
          EditorState.readOnly.of(false),
          EditorView.editable.of(true),
          pastEditorExtension(
            {
              pastOf: async (path) => (opened.session.showsPast(path) ? { now: (await opened.session.nowTextOf(path)) ?? null, marks: true } : null),
              lockedWhy: () => null,
              onChange: () => () => undefined
            },
            () => ({ path: 'Welcome.md' })
          )
        ]
      })
    })
    check(
      await eventually(() => view.state.readOnly && parent.querySelector('.mycel-tm-now-lines')?.textContent === 'hello, changed' && parent.querySelector('.mycel-tm-then-line') !== null),
      'its editor is read-only and marks what it said then and what it says now',
      parent.innerHTML
    )
    check(
      view.contentDOM.getAttribute('contenteditable') === 'false',
      "read-only even with Obsidian's editor saying otherwise first - the note could be typed into in 0.8.13",
      view.contentDOM.outerHTML.slice(0, 200)
    )
    {
      const text = view.state.doc.toString()
      view.dispatch({ changes: { from: 0, insert: 'typed ' }, userEvent: 'input.type' })
      view.dispatch({ changes: { from: 0, to: 2 }, userEvent: 'delete.backward' })
      check(view.state.doc.toString() === text, 'what is typed into it, or deleted, does not get in')
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: `${text}reloaded\n` } })
      check(view.state.doc.toString() === `${text}reloaded\n`, 'while Obsidian loading the file again does')
    }
    view.destroy()
    opened.stop()
    // Obsidian closes here: nothing is put back, the journal stays.
    check(await PastFiles.pending(A1.pluginAdapter as never, PLUGIN_DIR), 'a journal waits after a crash')
    const refused = await PastFiles.begin(A1.vault as never, A1.pluginAdapter as never, PLUGIN_DIR, { scope: null, lockId: null, vaultId: null }).then(
      () => null,
      (error: unknown) => error
    )
    check(refused instanceof Error, 'and no other Time Machine opens over it')
    // The next start: before the sync, the past goes back.
    const resumed = await PastFiles.resume(A1.vault as never, A1.pluginAdapter as never, PLUGIN_DIR)
    const report = await resumed?.restore()
    await resumed?.finish()
    if (resumed?.start.lockId && resumed.start.vaultId) await A1.api.releaseVaultLock(resumed.start.vaultId, resumed.start.lockId)
    A1.ownLocks.delete(opened.sealed)
    check(
      report?.failed.length === 0 && differences(before, snapshot(A1)).length === 0,
      'the next start puts every file back from the journal before the sync starts',
      differences(before, snapshot(A1))
    )
    check(await eventually(() => A2.socket?.isLocked === false), 'the lock it held is let go')
    check(await A1.boot(), 'then the sync starts')
    await delay(2_000)
    check(A2.vault.text('Welcome.md') === 'hello, changed\n' && A1.vault.text('Welcome.md') === 'hello, changed\n', 'and the past it showed is no edit anywhere')
  }

  // --- a folder's past --------------------------------------------------------------------------------
  {
    const before = snapshot(A1)
    // An earlier rollback's moment, as the overview offers it: a place of its own on the strip.
    const opened = await open(A1, { kind: 'folder', path: 'Projects' }, [{ at: T, label: 'before the rollback of then' }])
    check(
      opened.session.positions.some((position) => position.at === T && position.mark === 'before the rollback of then'),
      "the moment before an earlier rollback is a place on the strip, whatever the ticks (0.8.15)",
      opened.session.positions.map((position) => [position.at - T, position.mark ?? null])
    )
    const purpose = await opened.prepared.seal.open(opened.sealed)
    check(purpose?.scope?.kind === 'folder' && purpose.scope.path === 'Projects', 'the lock tells the other devices what it covers, sealed', purpose)
    check(await opened.session.moveToMark(T), 'and choosing it there shows it')
    check(
      A1.vault.text('Projects/Old.md') === 'old\n' && A1.vault.text('Projects/Plan.md') === 'the plan\n' && A1.vault.text('Welcome.md') === 'hello, changed\n' && A1.vault.text('New.md') === 'a new note\n',
      'a folder shows its past, and nothing outside it changes',
      {
        files: ['Projects/Old.md', 'Projects/Plan.md', 'Welcome.md', 'New.md'].map((path) => [path, A1.vault.text(path)]),
        place: opened.session.place,
        positions: opened.session.positions.map((position) => [position.at - T, position.tick?.last === undefined ? null : position.tick.last - T])
      }
    )
    await opened.session.moveTo(opened.session.positions.length - 1)
    check(A1.vault.text('Projects/Old.md') === undefined && A1.vault.text('Projects/Plan.md') === undefined, 'moved to now, it shows now')
    const report = await opened.session.restore()
    opened.stop()
    await opened.files.finish()
    await opened.lock.release()
    A1.ownLocks.delete(opened.sealed)
    check(report.failed.length === 0 && differences(before, snapshot(A1)).length === 0, 'and goes back as it was', differences(before, snapshot(A1)))
    check(await A1.boot(), 'the sync starts again')
  }

  // --- Abort while the past is still being read from the server (0.9.21) --------------------------------
  {
    const before = snapshot(A1)
    const opened = await open(A1, { kind: 'vault' })
    const { session, prepared } = opened
    // Every read from the server waits until let go - as one that never answers.
    const held: Array<() => void> = []
    const hold = <T,>(read: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => held.push(() => void read().then(resolve, reject)))
    const api = prepared.source.api
    const download = prepared.source.download
    Object.assign(prepared.source, {
      api: { log: (room: string) => hold(() => api.log(room)), frameTimes: (vaultId: string, since?: number) => api.frameTimes(vaultId, since) },
      download: (hash: string) => hold(() => download(hash))
    })
    void session.moveTo(placeBefore(session, T))
    check(
      await eventually(() => held.length > 0 && A1.vault.text('New.md') === undefined),
      'a moment is shown while its contents are still being read from the server',
      { held: held.length }
    )
    const report = await Promise.race([session.restore(), delay(5_000).then(() => null)])
    check(
      report !== null && report.failed.length === 0 && differences(before, snapshot(A1)).length === 0,
      'Abort puts every file back at once, never waiting for a read the server does not answer - that held the bar greyed out and the vault locked everywhere',
      report === null ? 'still waiting after 5 s' : differences(before, snapshot(A1))
    )
    check(
      await opened.files.show('Welcome.md', 'the past, late\n').then(
        () => false,
        (error: unknown) => error instanceof PastFilesClosed
      ),
      'once the files go back, no past is written into them'
    )
    for (const go of held.splice(0)) go()
    await delay(1_500)
    check(differences(before, snapshot(A1)).length === 0, 'and a read that answers after that writes nothing', differences(before, snapshot(A1)))
    opened.stop()
    await opened.files.finish()
    await opened.lock.release()
    A1.ownLocks.delete(opened.sealed)
    check(await A1.boot(), 'the sync starts again')
  }

  // --- a restore leaves the past under the lock: the others write again once it arrived (0.8.15) ---------
  {
    const opened = await open(A1, { kind: 'note', path: 'Welcome.md' })
    await opened.session.moveTo(placeBefore(opened.session, T))
    const docId = opened.session.noteId as string
    const then = await opened.session.noteTextAt('Welcome.md')
    check(then === 'hello\n' && (await eventually(() => A2.socket?.isLocked === true)), 'a note shows its past, the other device locked', then)
    // What TimeMachineControl.restoreVersion reads while the past is still shown.
    const base = (await opened.session.nowTextOf('Welcome.md')) ?? null
    // What TimeMachineControl.leaveLocked does: every file back, then the sync, writing under the lock.
    const report = await opened.session.restore()
    opened.stop()
    await opened.files.finish()
    A1.heldLockId = opened.lock.id
    check(report.failed.length === 0 && (await A1.boot()), 'the files are back and the sync runs, the lock still held')
    await A2.vault.userCreate('While restoring.md', 'written meanwhile\n')
    const store = A1.store as NonNullable<Device['store']>
    check((await store.restoreFromPast(docId, then as string, base)) === 'restored', 'with nothing written in it since the lock, the note becomes exactly that version')
    check(await store.whenSent(docId, 15_000), 'the restore reaches the server under the lock its Time Machine took')
    check(await eventually(() => A2.vault.text('Welcome.md') === 'hello\n', 15_000), 'and the other device follows it')
    check(A2.socket?.isLocked === true && A1.vault.text('While restoring.md') === undefined, 'while what that one writes still waits')
    A1.heldLockId = null
    A1.socket?.holdLock(null)
    await opened.lock.release()
    A1.ownLocks.delete(opened.sealed)
    check(await eventually(() => A1.vault.text('While restoring.md') === 'written meanwhile\n', 15_000), 'and goes out once the lock is let go')
    check(A1.vault.text('Welcome.md') === 'hello\n' && A2.vault.text('Welcome.md') === 'hello\n', 'the restore stays as it was')
  }

  // --- the lock lifted on another device, written there meanwhile: the restore keeps it (0.8.16) -------------
  {
    await delay(300)
    const T5 = Date.now()
    await delay(300)
    await A1.vault.userWrite('Welcome.md', 'hello, once more\n')
    check(await eventually(() => A2.vault.text('Welcome.md') === 'hello, once more\n', 15_000), 'A changes the note again')
    await delay(300)
    const opened = await open(A1, { kind: 'note', path: 'Welcome.md' })
    await opened.session.moveTo(placeBefore(opened.session, T5))
    const docId = opened.session.noteId as string
    const then = await opened.session.noteTextAt('Welcome.md')
    const base = (await opened.session.nowTextOf('Welcome.md')) ?? null
    check(then === 'hello\n' && base === 'hello, once more\n' && (await eventually(() => A2.socket?.isLocked === true)), 'its past is shown, the other device locked', { then, base })
    // The other device lifts the lock and writes into the note.
    await A2.api.breakVaultLock(opened.prepared.vaultId)
    check(await eventually(() => A2.socket?.isLocked === false), 'the other device lifts the lock')
    await A2.vault.userWrite('Welcome.md', 'hello, once more\nwritten after the lock was lifted\n')
    const report = await opened.session.restore()
    opened.stop()
    await opened.files.finish()
    A1.ownLocks.delete(opened.sealed)
    check(report.failed.length === 0 && (await A1.boot()), 'the restoring device leaves the past and syncs')
    const store = A1.store as NonNullable<Device['store']>
    check(
      await eventually(async () => (await store.currentText(docId))?.includes('written after the lock was lifted') === true, 15_000),
      'what the other device wrote arrives first'
    )
    const outcome = await store.restoreFromPast(docId, then as string, base)
    check(
      outcome === 'merged' && (await store.currentText(docId)) === 'hello\nwritten after the lock was lifted\n',
      'the restore takes back what the note said when the lock was taken and keeps what was written after it',
      { outcome, text: await store.currentText(docId) }
    )
    check(
      await eventually(() => A2.vault.text('Welcome.md') === 'hello\nwritten after the lock was lifted\n', 15_000),
      'on the other device too',
      A2.vault.text('Welcome.md')
    )
    await opened.lock.release()
  }

  // --- a rollback locks the other devices, its own writes go through ------------------------------------
  {
    check(await eventually(() => A2.socket?.isLocked === false), 'nothing is locked')
    const lock = await A1.lockForRollback()
    check(await eventually(() => A2.socket?.isLocked === true), 'a rollback locks the other device')
    await A1.vault.userWrite('Keep/Untouched.md', 'the rollback writes\n')
    check(await eventually(() => A2.vault.text('Keep/Untouched.md') === 'the rollback writes\n', 15_000), 'the device holding the lock writes, and the other one follows')
    await A2.vault.userCreate('During.md', 'meanwhile\n')
    await delay(1_500)
    check(A1.vault.text('During.md') === undefined, 'what the other one writes waits')
    await lock.release()
    check(await eventually(() => A1.vault.text('During.md') === 'meanwhile\n', 15_000), 'and arrives once the rollback is done')
  }

  // --- a lock lifted while a device was away: it learns so when it comes back (0.8.16) -------------------
  {
    check(await eventually(() => A2.socket?.isLocked === false), 'nothing is locked')
    const lock = await A1.lockForRollback()
    check(await eventually(() => A2.socket?.isLocked === true), 'the other device is locked')
    // The connection drops, and stays away long enough for the lock to end meanwhile: its notice reaches nobody there.
    const socket = A2.socket as unknown as { ws: WebSocket | null; retries: number }
    socket.retries = 2
    socket.ws?.close()
    check(await eventually(() => A2.socket?.connected === false), 'the other device goes offline')
    await lock.release()
    check(A2.socket?.connected === false, 'the lock ends while it is away')
    check(await eventually(() => A2.socket?.connected === true, 15_000), 'it comes back')
    check(
      await eventually(() => A2.socket?.isLocked === false, 10_000),
      'and asks whether the vault is still locked: it is not, so what it writes goes out again - in 0.8.15 it kept waiting'
    )
    await A2.vault.userCreate('After.md', 'after coming back\n')
    check(await eventually(() => A1.vault.text('After.md') === 'after coming back\n', 15_000), 'and arrives')
  }
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
