// Sharing a folder (docs/PHASE7.md): its owner with two devices, someone who
// may write with two, someone who may only read - all against a running
// server, end-to-end encrypted, with the fake vault of test:vault.
//
//   PORT=1235 MYCEL_REGISTRATION=open MYCEL_DATA_DIR=<scratch> npm run start:server
//   npm run test:folders -- ws://localhost:1235
import { check, delay, Device, eventually, failures, useServer } from './harness.mjs'

// Imported after the harness set up the DOM.
const { Notice } = await import('obsidian')

const { docRoom } = await import('@mycel/shared')
const { KeyRing } = await import('../src/account/KeyRing.js')
const { NoteHistory } = await import('../src/history/NoteHistory.js')
const { UnknownMembersError } = await import('../src/share/Sharing.js')

const serverUrl = process.argv[2] ?? process.env.MYCEL_URL ?? 'ws://localhost:1234'
useServer(serverUrl)
const run = Date.now().toString(36)
const olga = `olga${run}`
const pia = `pia${run}`
const quinn = `quinn${run}`
console.log(`server=${serverUrl} accounts=${olga},${pia},${quinn}`)

const binary = (seed: number, length = 3_000): Uint8Array => new Uint8Array(length).map((_byte, index) => (index * seed + 11) & 255)
const same = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean =>
  a !== undefined && b !== undefined && a.length === b.length && a.every((byte, index) => byte === b[index])
/** Where a device holds these bytes, below a folder. */
const holding = (device: Device, folder: string, data: Uint8Array): string | undefined =>
  device.vault.attachmentPaths().find((path) => path.startsWith(`${folder}/`) && same(device.vault.bytes(path), data))

/**
 * Makes one method of a device's socket or api wait first, for the calls `only`
 * picks: the order a slower machine - CI's - came to now and then, made certain.
 * Returns what makes it quick again.
 */
function slowed(target: object | null, method: string, ms: number, only: (...args: never[]) => boolean = () => true): () => void {
  const holder = target as Record<string, unknown>
  const original = holder[method] as (...args: unknown[]) => Promise<unknown>
  holder[method] = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    if ((only as (...args: unknown[]) => boolean)(...args)) await delay(ms)
    return original.apply(this, args)
  }
  return () => {
    delete holder[method]
  }
}

/** Watches a file moving on some devices: which of them, once moved, had it at the old place again. */
function watchMove(devices: Record<string, Device>, from: string, to: string): { stop(): string[] } {
  const moved = new Set<string>()
  const back = new Set<string>()
  const has = (device: Device, path: string): boolean => device.vault.getAbstractFileByPath(path) !== null
  const timer = setInterval(() => {
    for (const [name, device] of Object.entries(devices)) {
      if (has(device, to) && !has(device, from)) moved.add(name)
      else if (moved.has(name) && has(device, from)) back.add(name)
    }
  }, 15)
  return {
    stop: () => {
      clearInterval(timer)
      return Array.from(back)
    }
  }
}

async function befriend(a: Device, b: Device): Promise<void> {
  const code = await (a.contacts as NonNullable<typeof a.contacts>).createCode()
  await b.contacts?.redeem(code)
  await eventually(() => a.contacts?.name(b.accountId) !== undefined && b.contacts?.name(a.accountId) !== undefined)
}

const O1 = new Device(olga, true, {
  'Projects/X/Plan.md': 'a draft nobody else should see\n',
  'Projects/X/Sub/Deep.md': 'deep\n',
  'Projects/Other.md': 'other\n',
  'Projects/Second.md': 'second\n',
  'Projects/X/pic.png': binary(3),
  'Projects/photo.png': binary(4)
})
const O2 = new Device(olga, false)
const P1 = new Device(pia, true)
const P2 = new Device(pia, false)
const Q = new Device(quinn, true)
const devices = [O1, O2, P1, P2, Q]

const folderOf = (device: Device, path: string): string | undefined => {
  const docId = device.index?.docIdForPath(path)
  return docId ? device.index?.entry(docId)?.folder : undefined
}

try {
  for (const device of devices) check(await device.boot(), `${device.username}'s device starts`)
  await befriend(O1, P1)
  await befriend(O1, Q)
  check(
    await eventually(() => O2.vault.text('Projects/X/Plan.md') !== undefined && same(O2.vault.bytes('Projects/X/pic.png'), binary(3)), 15_000),
    "the owner's second device has the vault"
  )

  // --- sharing a folder ------------------------------------------------------------
  await O1.vault.userWrite('Projects/X/Plan.md', 'plan\n')
  check(await eventually(() => O1.docText('Projects/X/Plan.md') === 'plan\n'), 'the owner writes the plan')
  // Files its notes link outside it go along, as the share dialog has it by default.
  await O1.folders?.share('Projects/X', P1.accountId, 'write', true, undefined, true)
  check(
    await eventually(() => P1.vault.text('Shared/X/Plan.md') === 'plan\n' && P1.vault.text('Shared/X/Sub/Deep.md') === 'deep\n'),
    'the folder lands in the share folder of the one it is shared with, subfolders included',
    P1.vault.paths()
  )
  check(P1.vault.paths().join(',') === 'Shared/X/Plan.md,Shared/X/Sub/Deep.md', 'and nothing outside it', P1.vault.paths())
  check(await eventually(() => P2.vault.text('Shared/X/Plan.md') === 'plan\n'), 'their second device gets it from their index')
  check(
    await eventually(() => folderOf(O2, 'Projects/X/Plan.md') !== undefined),
    "the owner's other device knows the notes are in a shared folder"
  )
  {
    const docId = P1.index?.docIdForPath('Shared/X/Plan.md') as string
    const history = new NoteHistory(P1.api, docRoom(docId), (P1.keys as InstanceType<typeof KeyRing>).sharedDocCrypto(docId, O1.accountId), 150)
    await history.load()
    check(
      history.versions().some((version) => history.textAt(version.seq).includes('draft')),
      'shared with history, the member reads what a note said before'
    )
  }

  await O1.folders?.share('Projects/X', Q.accountId, 'read', false)
  check(await eventually(() => Q.vault.text('Shared/X/Plan.md') === 'plan\n'), 'shared without history with a reader')
  {
    const docId = Q.index?.docIdForPath('Shared/X/Plan.md') as string
    const history = new NoteHistory(Q.api, docRoom(docId), (Q.keys as InstanceType<typeof KeyRing>).sharedDocCrypto(docId, O1.accountId), 150)
    await history.load()
    const texts = history.versions().map((version) => history.textAt(version.seq))
    check(texts.length > 0 && texts.every((text) => !text.includes('draft')), 'without history, nothing from before', texts)
  }
  check(
    O1.askedMoveIn.length === 0 && O2.askedMoveIn.length === 0,
    'what lay in the folder when it was shared is never asked about as moved in, on any device of the owner',
    { o1: O1.askedMoveIn, o2: O2.askedMoveIn }
  )

  // --- new notes -------------------------------------------------------------------
  await O2.vault.userCreate('Projects/X/New.md', 'from the owner\n')
  check(
    await eventually(() => P1.vault.text('Shared/X/New.md') === 'from the owner\n' && Q.vault.text('Shared/X/New.md') === 'from the owner\n'),
    "a note the owner adds on any device reaches everyone",
    P1.vault.paths()
  )
  await P1.vault.userCreate('Shared/X/FromPia.md', 'from pia\n')
  check(
    await eventually(() => O1.vault.text('Projects/X/FromPia.md') === 'from pia\n' && Q.vault.text('Shared/X/FromPia.md') === 'from pia\n'),
    'a note a writer adds reaches the owner and everyone else',
    O1.vault.paths()
  )
  {
    const docId = P1.index?.docIdForPath('Shared/X/FromPia.md') as string
    check((await P1.api.members(docId)).owner === O1.accountId, "and belongs to the folder's owner")
    check(O1.index?.docIdForPath('Projects/X/FromPia.md') === docId, 'under the same id everywhere')
  }
  check(await eventually(() => P2.vault.text('Shared/X/FromPia.md') === 'from pia\n'), "the writer's other device has it too")

  await Q.vault.userCreate('Shared/X/QuinnsOwn.md', 'mine\n')
  await delay(1_200)
  check(!O1.vault.text('Projects/X/QuinnsOwn.md'), "a reader's new note does not go into the folder")
  check(Q.folderNews.some((news) => news.kind === 'stays-yours'), 'and the reader is told it stays theirs', Q.folderNews)

  // --- editing and renaming inside -------------------------------------------------
  await P1.vault.userWrite('Shared/X/Plan.md', 'plan\nfrom pia\n')
  check(
    await eventually(() => O1.vault.text('Projects/X/Plan.md') === 'plan\nfrom pia\n' && Q.vault.text('Shared/X/Plan.md') === 'plan\nfrom pia\n'),
    "a writer's edit reaches everyone"
  )
  await Q.vault.userWrite('Shared/X/Plan.md', 'quinn tries\n')
  await delay(800)
  check(O1.vault.text('Projects/X/Plan.md') === 'plan\nfrom pia\n', "a reader's edit does not")

  {
    // The writer's other device gets the folder's frames late, so where the note lies
    // in the folder now - which the writer's device recorded in the vault index too -
    // reaches it first. Decided against the older folder document, that moved the note
    // back on every device of the writer (a race seen in CI).
    const planId = P2.index?.docIdForPath('Shared/X/Plan.md') as string
    const quick = slowed(P2.socket, 'applyFrame', 2_000, (registration: { room: string }) => registration.room.startsWith('fld:'))
    const watch = watchMove({ P1, P2 }, 'Shared/X/Plan.md', 'Shared/X/Sub/Plan.md')
    await P1.vault.rename(P1.vault.file('Shared/X/Plan.md'), 'Shared/X/Sub/Plan.md')
    check(
      await eventually(() => P2.index?.entry(planId)?.folderPath === 'Sub/Plan.md'),
      "the writer's other device hears where the note lies in the folder before the folder says so"
    )
    // A change of the vault index brings the folder's pass, as main.ts has it.
    P2.folders?.scheduleAll()
    check(
      await eventually(() => O1.vault.text('Projects/X/Sub/Plan.md') === 'plan\nfrom pia\n' && !O1.vault.text('Projects/X/Plan.md')),
      "a writer's rename inside the folder is the owner's too",
      O1.vault.paths()
    )
    check(await eventually(() => Q.vault.text('Shared/X/Sub/Plan.md') !== undefined && !Q.vault.text('Shared/X/Plan.md')), "and the reader's", Q.vault.paths())
    await delay(2_500)
    quick()
    await delay(600)
    const back = watch.stop()
    check(
      back.length === 0 && P1.vault.text('Shared/X/Sub/Plan.md') !== undefined && P2.vault.text('Shared/X/Sub/Plan.md') !== undefined,
      "and it never goes back on the writer's devices",
      { back, p1: P1.vault.paths(), p2: P2.vault.paths() }
    )
  }

  // --- files in the folder --------------------------------------------------------------
  check(
    await eventually(
      () => [P1, P2, Q].every((device) => same(device.vault.bytes('Shared/X/pic.png'), binary(3))),
      15_000
    ),
    'a file in the folder reaches everyone in it, on every device',
    { pia: P1.vault.attachmentPaths(), quinn: Q.vault.attachmentPaths() }
  )

  await P1.vault.userCreateBinary('Shared/X/Sub/fromPia.png', binary(7))
  check(
    await eventually(
      () =>
        same(O1.vault.bytes('Projects/X/Sub/fromPia.png'), binary(7)) &&
        same(O2.vault.bytes('Projects/X/Sub/fromPia.png'), binary(7)) &&
        same(Q.vault.bytes('Shared/X/Sub/fromPia.png'), binary(7)),
      15_000
    ),
    'a file a writer adds reaches the owner and everyone else',
    O1.vault.attachmentPaths()
  )

  await O1.vault.userWriteBinary('Projects/X/pic.png', binary(9))
  check(
    await eventually(() => [P1, P2, Q].every((device) => same(device.vault.bytes('Shared/X/pic.png'), binary(9))), 15_000),
    "the owner's new version of a file reaches everyone"
  )
  await Q.vault.userWriteBinary('Shared/X/pic.png', binary(10))
  await delay(1_200)
  check(same(O1.vault.bytes('Projects/X/pic.png'), binary(9)) && same(P1.vault.bytes('Shared/X/pic.png'), binary(9)), "a reader's version does not")

  // Changed by the owner while the writer, away, changed it too: both versions stay, for everyone.
  await P1.shutdown()
  await O1.vault.userWriteBinary('Projects/X/pic.png', binary(11))
  check(await eventually(() => same(P2.vault.bytes('Shared/X/pic.png'), binary(11)), 15_000), "the writer's other device takes the owner's version")
  P1.vault.offlineWriteBinary('Shared/X/pic.png', binary(12))
  check(await P1.boot(), "the writer's device comes back with a version of its own")
  check(
    await eventually(
      () =>
        same(P1.vault.bytes('Shared/X/pic.png'), binary(11)) &&
        holding(P1, 'Shared/X', binary(12)) !== undefined &&
        same(O1.vault.bytes('Projects/X/pic.png'), binary(11)) &&
        holding(O1, 'Projects/X', binary(12)) !== undefined,
      15_000
    ),
    "changed on both sides, the file keeps the owner's version and the writer's goes next to it - in the folder",
    { pia: P1.vault.attachmentPaths(), olga: O1.vault.attachmentPaths() }
  )
  check(
    await eventually(() => same(Q.vault.bytes('Shared/X/pic.png'), binary(11)) && holding(Q, 'Shared/X', binary(10)) !== undefined, 15_000),
    "the reader's own version is kept next to the folder's, theirs alone",
    Q.vault.attachmentPaths()
  )
  check(holding(O1, 'Projects/X', binary(10)) === undefined, 'and never reaches the owner')

  // Again with both of the writer's devices away, and the writer's slow to upload its
  // version as it comes back: the folder's pass found the file unchanged here while
  // that upload was under way, and taking the owner's version after it counted the
  // writer's as replaced knowingly - overwritten, and kept nowhere but in the file's
  // versions (a race seen in CI).
  await P1.shutdown()
  await P2.shutdown()
  await O1.vault.userWriteBinary('Projects/X/pic.png', binary(13))
  check(await eventually(() => same(Q.vault.bytes('Shared/X/pic.png'), binary(13)), 15_000), "the owner's next version reaches the reader")
  P1.vault.offlineWriteBinary('Shared/X/pic.png', binary(14))
  {
    const quick = slowed(P1.api, 'putBlobChunk', 1_500)
    check(await P1.boot(), "the writer's device comes back, slow to upload")
    check(
      await eventually(
        () => same(P1.vault.bytes('Shared/X/pic.png'), binary(13)) && holding(P1, 'Shared/X', binary(14)) !== undefined && holding(O1, 'Projects/X', binary(14)) !== undefined,
        20_000
      ),
      "both versions stay, for everyone: the owner's in the file, the writer's next to it",
      { pia: P1.vault.attachmentPaths(), olga: O1.vault.attachmentPaths() }
    )
    quick()
  }
  check(await P2.boot(), "the writer's other device comes back")

  {
    // The same for a file: where it lies in the folder - the writer's vault's base for
    // it - reaches the writer's other device before the folder's frame does.
    const link = P2.attachments?.fileAt('Shared/X/Sub/fromPia.png')?.entry.folder
    const quick = slowed(P2.socket, 'applyFrame', 2_000, (registration: { room: string }) => registration.room.startsWith('fld:'))
    const watch = watchMove({ P1, P2 }, 'Shared/X/Sub/fromPia.png', 'Shared/X/Sub/byPia.png')
    await P1.vault.rename(P1.vault.file('Shared/X/Sub/fromPia.png'), 'Shared/X/Sub/byPia.png')
    check(
      await eventually(() => link !== undefined && P2.attachments?.folderBase(link.id, link.file)?.path === 'Sub/byPia.png'),
      "the writer's other device hears where the file lies in the folder before the folder says so"
    )
    P2.folders?.scheduleAll()
    check(
      await eventually(
        () => same(O1.vault.bytes('Projects/X/Sub/byPia.png'), binary(7)) && !O1.vault.bytes('Projects/X/Sub/fromPia.png') && same(Q.vault.bytes('Shared/X/Sub/byPia.png'), binary(7))
      ),
      "a writer's rename of a file inside the folder is everyone's",
      O1.vault.attachmentPaths()
    )
    await delay(2_500)
    quick()
    await delay(600)
    const back = watch.stop()
    check(
      back.length === 0 && same(P1.vault.bytes('Shared/X/Sub/byPia.png'), binary(7)) && same(P2.vault.bytes('Shared/X/Sub/byPia.png'), binary(7)),
      "and it never goes back on the writer's devices",
      { back, p1: P1.vault.attachmentPaths(), p2: P2.vault.attachmentPaths() }
    )
  }

  await P1.vault.trash(P1.vault.file('Shared/X/Sub/byPia.png'))
  check(
    await eventually(() => !O1.vault.bytes('Projects/X/Sub/byPia.png') && !Q.vault.bytes('Shared/X/Sub/byPia.png')),
    "a writer's delete of a file is a delete for everyone",
    O1.vault.attachmentPaths()
  )
  const fileNews = P1.folderNews.find((news) => news.kind === 'deleted' && (news.names as string[]).includes('byPia.png'))
  check(fileNews !== undefined, 'and they are told', P1.folderNews)
  if (fileNews) await P1.folders?.undoDeleted(fileNews.batch as never)
  check(
    await eventually(
      () => same(O1.vault.bytes('Projects/X/Sub/byPia.png'), binary(7)) && same(Q.vault.bytes('Shared/X/Sub/byPia.png'), binary(7)) && same(P1.vault.bytes('Shared/X/Sub/byPia.png'), binary(7)),
      15_000
    ),
    'undoing brings the file back for everyone',
    { olga: O1.vault.attachmentPaths(), pia: P1.vault.attachmentPaths() }
  )

  await Q.vault.trash(Q.vault.file('Shared/X/Sub/byPia.png'))
  await delay(1_200)
  check(same(O1.vault.bytes('Projects/X/Sub/byPia.png'), binary(7)) && same(P1.vault.bytes('Shared/X/Sub/byPia.png'), binary(7)), "a reader's delete of a file is theirs alone")
  check(!Q.vault.bytes('Shared/X/Sub/byPia.png'), 'and it stays away for them')

  await O1.vault.rename(O1.vault.file('Projects/photo.png'), 'Projects/X/photo.png')
  check(
    await eventually(() => same(P1.vault.bytes('Shared/X/photo.png'), binary(4)), 15_000),
    'an existing file the owner moves in is shared once they said so',
    P1.vault.attachmentPaths()
  )
  check(O1.askedMoveIn.includes('Projects/X/photo.png'), 'and they were asked', O1.askedMoveIn)

  // Deleted for everyone, then brought back from the owner's own trash: back for everyone, and it stays.
  // The owner's other device is slow to carry the delete out, and trashes its file only after
  // the owner brought it back: it took its own trashing for a delete made there, for everyone
  // (a race seen in CI).
  {
    const quick = slowed(O2.api, 'touchBlobs', 1_500)
    await P1.vault.trash(P1.vault.file('Shared/X/photo.png'))
    check(await eventually(() => !O1.vault.bytes('Projects/X/photo.png')), "the owner's copy goes with a writer's delete")
    const trashed = O1.attachments?.deletedFiles(0).find((file) => file.path === 'Projects/X/photo.png')
    check(trashed !== undefined, "and lies in the owner's trash")
    if (trashed) await O1.attachments?.restoreDeleted(trashed.fileId)
    check(
      await eventually(() => same(P1.vault.bytes('Shared/X/photo.png'), binary(4)) && same(Q.vault.bytes('Shared/X/photo.png'), binary(4)), 15_000),
      'a file brought back from the trash is back for everyone in the folder',
      P1.vault.attachmentPaths()
    )
    await delay(2_500)
    quick()
    check(
      same(O1.vault.bytes('Projects/X/photo.png'), binary(4)) && same(P1.vault.bytes('Shared/X/photo.png'), binary(4)),
      'and the folder does not delete it again'
    )
    check(await eventually(() => same(O2.vault.bytes('Projects/X/photo.png'), binary(4))), "nor does the owner's other device keep it away")
  }

  // A file outside the folder that one of its notes embeds lands in the share folder's Attachments.
  await O1.vault.userCreateBinary('Assets/logo.png', binary(5))
  check(await eventually(() => O1.attachments?.fileAt('Assets/logo.png') !== null), 'the owner has a file outside the folder')
  await O1.vault.userCreate('Projects/X/Gallery.md', '![[logo.png]]\n')
  check(
    await eventually(() => same(P1.vault.bytes('Shared/Attachments/logo.png'), binary(5)) && same(Q.vault.bytes('Shared/Attachments/logo.png'), binary(5)), 15_000),
    'a file outside the folder its notes embed goes along, into the share folder',
    P1.vault.attachmentPaths()
  )
  check(!P1.vault.bytes('Shared/Attachments/pic.png'), 'while a file inside the folder never comes in twice', P1.vault.attachmentPaths())

  // --- the folder renamed by its owner --------------------------------------------------
  await O1.vault.renameFolder('Projects/X', 'Projects/Y')
  check(await eventually(() => O2.vault.text('Projects/Y/New.md') === 'from the owner\n'), "the owner's other device follows the folder's rename")
  await delay(800)
  check(P1.vault.text('Shared/X/New.md') === 'from the owner\n', 'nobody else sees it moved: their copy is theirs to name')
  await P1.vault.userCreate('Shared/X/AfterRename.md', 'still shared\n')
  check(await eventually(() => O1.vault.text('Projects/Y/AfterRename.md') === 'still shared\n'), 'and it stays shared', O1.vault.paths())

  // --- a member moving a note out of their copy ------------------------------------------
  // Both have it open in an editor while it moves.
  const olgas = O1.open('Projects/Y/New.md')
  const pias = P1.open('Shared/X/New.md')
  check(await eventually(() => O1.editors.boundCount() >= 1 && P1.editors.boundCount() >= 1), 'both have the note open in an editor')
  await P1.vault.createFolder('Elsewhere')
  await P1.vault.rename(P1.vault.file('Shared/X/New.md'), 'Elsewhere/New.md')
  await delay(800)
  check(O1.vault.text('Projects/Y/New.md') === 'from the owner\n', "a member moving a note out of their copy changes nothing for anyone else")
  await O1.vault.userWrite('Projects/Y/New.md', 'from the owner\nmore\n')
  check(await eventually(() => P1.vault.text('Elsewhere/New.md') === 'from the owner\nmore\n'), 'it stays shared where they put it')
  {
    // And the two still see each other's carets in it.
    const caretOf = (view: typeof olgas): { at: number; name: string } | null => {
      const caret = view.view.dom.querySelector('.mycel-remote-caret')
      return caret ? { at: view.view.posAtDOM(caret), name: caret.querySelector('.mycel-remote-caret-label')?.textContent ?? '' } : null
    }
    olgas.view.dispatch({ selection: { anchor: 4 } })
    pias.view.dispatch({ selection: { anchor: 9 } })
    check(
      await eventually(() => caretOf(pias)?.at === 4 && caretOf(olgas)?.at === 9),
      "in a note a member moved out of their copy, both see where the other's caret is",
      { onPia: caretOf(pias), onOlga: caretOf(olgas) }
    )
    pias.type('!', 9)
    pias.view.dispatch({ selection: { anchor: 10 } })
    check(await eventually(() => olgas.text().includes('from the !owner') && caretOf(olgas)?.at === 10), 'and follow it as they type', caretOf(olgas))
    O1.close(olgas)
    P1.close(pias)
    await O1.vault.userWrite('Projects/Y/New.md', 'from the owner\nmore\n')
    check(await eventually(() => P1.vault.text('Elsewhere/New.md') === 'from the owner\nmore\n'), 'the note as it was')
  }
  await O1.vault.rename(O1.vault.file('Projects/Y/New.md'), 'Projects/Y/Renamed.md')
  check(await eventually(() => Q.vault.text('Shared/X/Renamed.md') !== undefined), 'the rename reaches whoever follows the folder')
  await delay(600)
  check(P1.vault.text('Elsewhere/New.md') !== undefined && !P1.vault.text('Shared/X/Renamed.md'), "but no longer moves the note that was put elsewhere", P1.vault.paths())

  // --- deleting ---------------------------------------------------------------------------
  await P1.vault.trash(P1.vault.file('Shared/X/FromPia.md'))
  check(
    await eventually(() => !O1.vault.text('Projects/Y/FromPia.md') && !Q.vault.text('Shared/X/FromPia.md')),
    "a writer's delete is a delete for everyone",
    O1.vault.paths()
  )
  const deletedNews = P1.folderNews.find((news) => news.kind === 'deleted' && (news.names as string[]).includes('FromPia'))
  check(deletedNews !== undefined && (deletedNews.people as string[]).length === 2, 'and they are told who loses it', deletedNews)
  if (deletedNews) await P1.folders?.undoDeleted(deletedNews.batch as never)
  check(
    await eventually(() => O1.vault.text('Projects/Y/FromPia.md') === 'from pia\n' && P1.vault.text('Shared/X/FromPia.md') === 'from pia\n'),
    'undoing brings it back for everyone',
    O1.vault.paths()
  )

  await Q.vault.trash(Q.vault.file('Shared/X/Sub/Deep.md'))
  await delay(1_200)
  check(O1.vault.text('Projects/Y/Sub/Deep.md') === 'deep\n' && P1.vault.text('Shared/X/Sub/Deep.md') === 'deep\n', "a reader's delete is theirs alone")
  check(!Q.vault.text('Shared/X/Sub/Deep.md'), 'and the note stays away for them')

  // A delete the device never got to weigh - it stopped first - is undone, not
  // taken for everyone: the note comes back.
  await P1.vault.trash(P1.vault.file('Shared/X/AfterRename.md'))
  await P1.shutdown()
  check(await P1.boot(), "the writer's device starts again")
  check(
    await eventually(() => P1.vault.text('Shared/X/AfterRename.md') === 'still shared\n'),
    'a delete never decided on comes back',
    P1.vault.paths()
  )
  check(O1.vault.text('Projects/Y/AfterRename.md') === 'still shared\n', 'and never reached anyone')

  // --- moving in and out ---------------------------------------------------------------------
  // Every device of the owner asks; this one leaves the window open until the other answered.
  O2.moveInAnswer = null
  await O1.vault.rename(O1.vault.file('Projects/Other.md'), 'Projects/Y/Other.md')
  check(
    await eventually(() => P1.vault.text('Shared/X/Other.md') === 'other\n' && Q.vault.text('Shared/X/Other.md') === 'other\n'),
    'an existing note the owner moves in is shared once they said so',
    P1.vault.paths()
  )
  check(O1.askedMoveIn.includes('Projects/Y/Other.md'), 'and they were asked')
  check(await eventually(() => O2.askedMoveIn.length === 0 || folderOf(O2, 'Projects/Y/Other.md') !== undefined), "the owner's other device follows")

  O1.moveInAnswer = 'back'
  await O1.vault.rename(O1.vault.file('Projects/Second.md'), 'Projects/Y/Second.md')
  check(
    await eventually(() => O1.vault.text('Projects/Second.md') === 'second\n' && !O1.vault.text('Projects/Y/Second.md')),
    "a note moved in by mistake goes back where it was when they say so",
    O1.vault.paths()
  )
  await delay(600)
  check(!P1.vault.text('Shared/X/Second.md'), 'and nobody ever saw it')
  O1.moveInAnswer = 'share'

  // Asked at once - not once the move's events settled -, naming who sees it and the files going along.
  {
    await O1.vault.userCreate('Projects/Linked.md', 'with a picture ![[logo.png]]\n')
    check(await eventually(() => O1.docText('Projects/Linked.md') === 'with a picture ![[logo.png]]\n'), 'the owner has a note embedding a file outside the folder')
    const movedAt = Date.now()
    await O1.vault.rename(O1.vault.file('Projects/Linked.md'), 'Projects/Y/Linked.md')
    check(await eventually(() => O1.moveInQuestions.some((question) => question.path === 'Projects/Y/Linked.md')), 'moved in, it is asked about')
    const question = O1.moveInQuestions.find((question) => question.path === 'Projects/Y/Linked.md')
    check((question?.at ?? Infinity) - movedAt < 250, 'at once, not after the move settled', (question?.at ?? Infinity) - movedAt)
    check(question?.files.join() === 'Assets/logo.png', 'naming the file outside the folder that goes along with it', question?.files)
    check(question?.people.length === 2 && !question.people.some((name) => /more/.test(name)), 'and everyone the folder is shared with, by name', question?.people)
    check(await eventually(() => P1.vault.text('Shared/X/Linked.md') !== undefined), 'shared, it reaches the others')
  }

  // The notes it links to, and theirs, go along when asked for (E8): shared on
  // their own with everyone in the folder, each with their access there, and
  // staying where they are.
  {
    await O1.vault.userCreate('Notes/Deeper.md', 'deeper\n')
    await O1.vault.userCreate('Notes/Ref.md', 'ref, see [[Notes/Deeper]]\n')
    await O1.vault.userCreate('Projects/Hub.md', 'hub: [[Notes/Ref]] and [[Projects/Y/Other]]\n')
    check(
      await eventually(() => O1.docText('Projects/Hub.md') !== undefined && O1.docText('Notes/Ref.md') !== undefined && O1.docText('Notes/Deeper.md') !== undefined),
      'the owner has a note linking to notes outside the folder'
    )
    O1.moveInWithLinked = true
    await O1.vault.rename(O1.vault.file('Projects/Hub.md'), 'Projects/Y/Hub.md')
    check(await eventually(() => O1.moveInQuestions.some((question) => question.path === 'Projects/Y/Hub.md')), 'moved in, it is asked about')
    const question = O1.moveInQuestions.find((question) => question.path === 'Projects/Y/Hub.md')
    check(
      question?.linked.join() === 'Notes/Ref.md,Notes/Deeper.md',
      'listing the notes outside the folder it links to, and the notes those link to - not those inside',
      question?.linked
    )
    check(
      await eventually(() => P1.vault.text('Shared/Notes/Ref.md') === 'ref, see [[Notes/Deeper]]\n' && Q.vault.text('Shared/Notes/Deeper.md') === 'deeper\n'),
      'they reach everyone in the folder, in their share folder at the path of the link',
      [P1.vault.paths(), Q.vault.paths()]
    )
    const roleOf = (device: Device, path: string): string | undefined => device.index?.entry(device.index?.docIdForPath(path) ?? '')?.role
    check(roleOf(P1, 'Shared/Notes/Ref.md') === 'write' && roleOf(Q, 'Shared/Notes/Ref.md') === 'read', 'each with the access they have in the folder')
    check(O1.vault.text('Notes/Ref.md') !== undefined && !folderOf(O1, 'Notes/Ref.md'), 'and they stay where they are, outside the folder')
    check(
      await eventually(() => O1.folderNews.some((news) => news.kind === 'linked' && news.shared === 2)),
      'the owner is told',
      O1.folderNews.slice(-2)
    )
    O1.moveInWithLinked = false
  }

  await O1.vault.rename(O1.vault.file('Projects/Y/Sub/Plan.md'), 'Projects/Plan.md')
  check(
    await eventually(() => {
      const docId = P1.index?.docIdForPath('Shared/X/Sub/Plan.md')
      return docId !== undefined && !P1.index?.entry(docId)?.owner
    }),
    'a note the owner moves out stays with everyone else, as their own',
    P1.vault.paths()
  )
  check(O1.folderNews.some((news) => news.kind === 'moved-out'), 'and the owner is told')
  await O1.vault.userWrite('Projects/Plan.md', 'the owner alone\n')
  await delay(800)
  check(P1.vault.text('Shared/X/Sub/Plan.md') === 'plan\nfrom pia\n', 'what the owner writes after does not reach them', P1.vault.text('Shared/X/Sub/Plan.md'))

  // A writer moving a note of their own in copies it into the folder: the owner's from then on.
  await P1.vault.userCreate('Notes/PiaOwn.md', 'pia private\n')
  check(await eventually(() => P2.vault.text('Notes/PiaOwn.md') === 'pia private\n'), "the writer's own note is on both their devices")
  await P1.vault.rename(P1.vault.file('Notes/PiaOwn.md'), 'Shared/X/PiaOwn.md')
  check(await eventually(() => O1.vault.text('Projects/Y/PiaOwn.md') === 'pia private\n'), 'a note a writer moves in is copied into the folder', O1.vault.paths())
  {
    const docId = P1.index?.docIdForPath('Shared/X/PiaOwn.md') as string
    check(docId !== undefined && P1.index?.entry(docId)?.owner === O1.accountId, "and belongs to the folder's owner")
  }
  check(
    await eventually(() => P2.vault.text('Shared/X/PiaOwn.md') === 'pia private\n' && !P2.vault.text('Notes/PiaOwn.md')),
    "the writer's other device follows into the copy",
    P2.vault.paths()
  )
  // A writer's linked notes go to the owner, to edit, and to whoever else is a contact of theirs.
  {
    await P1.vault.userCreate('Notes/PiaRef.md', 'pia ref\n')
    await P1.vault.userCreate('Notes/PiaHub.md', 'see [[Notes/PiaRef]]\n')
    check(await eventually(() => P1.docText('Notes/PiaHub.md') !== undefined && P1.docText('Notes/PiaRef.md') !== undefined), 'the writer has a note linking to another')
    P1.moveInWithLinked = true
    await P1.vault.rename(P1.vault.file('Notes/PiaHub.md'), 'Shared/X/PiaHub.md')
    check(await eventually(() => O1.vault.text('Projects/Y/PiaHub.md') === 'see [[Notes/PiaRef]]\n'), 'it is copied into the folder')
    const question = P1.moveInQuestions.find((question) => question.path === 'Shared/X/PiaHub.md')
    check(question?.linked.join() === 'Notes/PiaRef.md' && question.strangers === 1, 'the window says who of the folder is not a contact of theirs', question)
    check(await eventually(() => O1.vault.text('Shared/Notes/PiaRef.md') === 'pia ref\n'), 'the note it links to reaches the owner', O1.vault.paths())
    const refId = O1.index?.docIdForPath('Shared/Notes/PiaRef.md') ?? ''
    check(O1.index?.entry(refId)?.owner === P1.accountId && O1.index?.entry(refId)?.role === 'write', 'shared to edit, and still the writer\'s')
    await delay(600)
    check(!Q.vault.text('Shared/Notes/PiaRef.md'), 'but not someone the writer has no contact with')
    P1.moveInWithLinked = false
  }

  // --- a note shared on its own as well, and revoking ------------------------------------------
  {
    const renamedId = O1.index?.docIdForPath('Projects/Y/Renamed.md') as string
    await O1.sharing?.share(renamedId, Q.accountId, 'read', true)
    await delay(800)
    check(Q.vault.text('Shared/X/Renamed.md') !== undefined && !Q.vault.text('Shared/Renamed.md'), 'a note shared on its own with someone who has it through the folder stays where it is')
    const folderId = folderOf(O1, 'Projects/Y/Renamed.md') as string
    const noteEnds = (): number => Notice.shown.filter((notice) => notice.startsWith('The share of "')).length
    const noteEndsBefore = noteEnds()
    const folderEndsBefore = Q.folderNews.filter((news) => news.kind === 'ended').length

    // A member who is no contact - one the server made up, or a contact removed whose
    // shares did not all end - is never sealed a key: the rotation does not happen (0.9.0).
    {
      const settings = O1.settings as NonNullable<typeof O1.settings>
      const piaContact = settings.contact(P1.accountId)
      settings.setContact(P1.accountId, null)
      const before = await O1.api.folderState(folderId)
      const refused = await O1.folders?.revoke(folderId, Q.accountId).then(
        () => null,
        (error: unknown) => error
      )
      check(
        refused instanceof UnknownMembersError && refused.accounts.join() === P1.accountId && refused.place.kind === 'folder',
        'a rotation for a folder whose member is no contact stops before anything is sealed',
        refused
      )
      const after = await O1.api.folderState(folderId)
      check(
        after.epoch === before.epoch && after.members.some((member) => member.account === Q.accountId),
        'and nothing moved: the folder keeps its key, the revocation waits',
        { before: before.epoch, after: after.epoch }
      )
      check(
        O1.unknownMembers.some((asked) => asked.accounts.join() === P1.accountId && asked.place.kind === 'folder'),
        'the owner is told, over everything',
        O1.unknownMembers
      )
      settings.setContact(P1.accountId, piaContact)
    }

    await O1.folders?.revoke(folderId, Q.accountId)
    check(
      await eventually(() => {
        const docId = Q.index?.docIdForPath('Shared/X/FromPia.md')
        return docId !== undefined && !Q.index?.entry(docId)?.owner
      }),
      "revoked from the folder, the reader keeps its notes as their own",
      Q.vault.paths()
    )
    check(Q.index?.entry(renamedId)?.owner === O1.accountId, 'except a note shared with them on its own, which stays shared')
    await delay(500)
    const folderEnds = Q.folderNews.filter((news) => news.kind === 'ended').slice(folderEndsBefore)
    check(
      folderEnds.length === 1 && Number(folderEnds[0]?.kept) > 0 && noteEnds() === noteEndsBefore,
      'the reader is told once, for the folder - not again for each of its notes',
      { folderEnds, notices: Notice.shown.slice(-4) }
    )
    await O1.vault.userWrite('Projects/Y/Renamed.md', 'still reaches quinn\n')
    await O1.vault.userWrite('Projects/Y/FromPia.md', 'no longer reaches quinn\n')
    check(await eventually(() => Q.vault.text('Shared/X/Renamed.md') === 'still reaches quinn\n'), 'that one goes on')
    check(await eventually(() => P1.vault.text('Shared/X/FromPia.md') === 'no longer reaches quinn\n'), 'the others go on for everyone still in the folder')
    check(Q.vault.text('Shared/X/FromPia.md') === 'from pia\n', 'but not for whoever was revoked', Q.vault.text('Shared/X/FromPia.md'))
  }

  // --- the folder moved without an event for itself, then deleted ---------------------------------
  await O1.vault.renameFolder('Projects/Y', 'Archive/Z', { folderEvent: false })
  await P1.vault.userCreate('Shared/X/AfterMove.md', 'after the move\n')
  check(
    await eventually(() => O1.vault.text('Archive/Z/AfterMove.md') === 'after the move\n'),
    "a folder moved whose own event never came is found where its notes went - and stays shared",
    O1.vault.paths()
  )
  check(P1.index?.entry(P1.index?.docIdForPath('Shared/X/FromPia.md') as string)?.owner === O1.accountId, 'nothing was taken for moving out')

  await O1.vault.trashFolder('Archive/Z')
  check(
    await eventually(() => {
      const docId = P1.index?.docIdForPath('Shared/X/FromPia.md')
      return docId !== undefined && !P1.index?.entry(docId)?.owner && P1.vault.text('Shared/X/FromPia.md') !== undefined
    }),
    'the owner deleting the folder ends its share: everyone keeps it as their own',
    P1.vault.paths()
  )
  check(
    await eventually(() => P2.vault.text('Shared/X/PiaOwn.md') === 'pia private\n'),
    "on every device of theirs",
    P2.vault.paths()
  )
  check(await eventually(() => !O2.vault.text('Archive/Z/AfterMove.md')), "the owner's notes go to the trash on their devices")

  // --- a member deleting their copy, and the folder shared with them again ------------------------
  {
    await O1.vault.userCreate('Team/A.md', 'note a\n')
    await O1.vault.userCreate('Team/B.md', 'note b\n')
    check(await eventually(() => O1.docText('Team/A.md') === 'note a\n' && O1.docText('Team/B.md') === 'note b\n'), 'the owner has a folder of two notes')
    await O1.folders?.share('Team', P1.accountId, 'write', false)
    check(
      await eventually(() => P1.vault.text('Shared/Team/A.md') === 'note a\n' && P2.vault.text('Shared/Team/B.md') === 'note b\n', 15_000),
      'shared without history, it reaches both devices of the member'
    )
    const leftBefore = O1.folderNews.filter((news) => news.kind === 'left').length
    const pEndsBefore = [P1.folderNews.length, P2.folderNews.length]
    await P1.vault.trashFolder('Shared/Team')
    check(
      await eventually(() => O1.folderNews.filter((news) => news.kind === 'left').length > leftBefore, 15_000),
      'the member deletes their copy, and the owner is told they left',
      O1.folderNews.slice(-3)
    )
    check(await eventually(() => !P2.vault.text('Shared/Team/A.md')), "and it goes from the member's other device")
    await delay(500)
    const pEnds = [P1.folderNews.slice(pEndsBefore[0]), P2.folderNews.slice(pEndsBefore[1])].map((news) => news.filter((item) => item.kind === 'ended'))
    check(
      pEnds[0]?.length === 0 && pEnds[1]?.every((news) => news.kept === 0) === true,
      'the device that deleted it says nothing of an end, and none says a copy was kept',
      pEnds
    )
    check(!P1.vault.text('Shared/Team/A.md') && !P2.vault.text('Shared/Team/B.md'), 'nor does one come back', [P1.vault.paths(), P2.vault.paths()])
    const asked = (): number[] => [O1.asked, O2.asked, P1.asked, P2.asked]
    const askedBefore = asked().join()
    await O1.folders?.share('Team', P1.accountId, 'write', false)
    check(
      await eventually(() => P1.vault.text('Shared/Team/A.md') === 'note a\n' && P2.vault.text('Shared/Team/B.md') === 'note b\n', 20_000),
      'shared with them again, the folder comes back',
      P1.vault.paths()
    )
    await delay(1_500)
    check(asked().join() === askedBefore, 'and no device takes the server for one that lost data', { before: askedBefore, after: asked() })
    await O1.vault.userWrite('Team/A.md', 'note a\nagain\n')
    check(await eventually(() => P1.vault.text('Shared/Team/A.md') === 'note a\nagain\n'), 'what the owner writes reaches them again')
  }
} catch (error) {
  check(false, 'the scenario ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  for (const device of devices) await device.shutdown()
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
