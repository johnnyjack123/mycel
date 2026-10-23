// Sharing a folder (docs/PHASE7.md): its owner with two devices, someone who
// may write with two, someone who may only read - all against a running
// server, end-to-end encrypted, with the fake vault of test:vault.
//
//   PORT=1235 OBSIDIAN_CONNECT_REGISTRATION=open OBSIDIAN_CONNECT_DATA_DIR=<scratch> npm run start:server
//   npm run test:folders -- ws://localhost:1235
import { check, delay, Device, eventually, failures, useServer } from './harness.mjs'

const { docRoom } = await import('@obsidian-connect/shared')
const { KeyRing } = await import('../src/account/KeyRing.js')
const { NoteHistory } = await import('../src/history/NoteHistory.js')

const serverUrl = process.argv[2] ?? process.env.OBSIDIAN_CONNECT_URL ?? 'ws://localhost:1234'
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
    const history = new NoteHistory(P1.api, docRoom(docId), (P1.keys as InstanceType<typeof KeyRing>).sharedDocCrypto(docId), 150)
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
    const history = new NoteHistory(Q.api, docRoom(docId), (Q.keys as InstanceType<typeof KeyRing>).sharedDocCrypto(docId), 150)
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

  await P1.vault.rename(P1.vault.file('Shared/X/Plan.md'), 'Shared/X/Sub/Plan.md')
  check(
    await eventually(() => O1.vault.text('Projects/X/Sub/Plan.md') === 'plan\nfrom pia\n' && !O1.vault.text('Projects/X/Plan.md')),
    "a writer's rename inside the folder is the owner's too",
    O1.vault.paths()
  )
  check(await eventually(() => Q.vault.text('Shared/X/Sub/Plan.md') !== undefined && !Q.vault.text('Shared/X/Plan.md')), "and the reader's", Q.vault.paths())

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

  await P1.vault.rename(P1.vault.file('Shared/X/Sub/fromPia.png'), 'Shared/X/Sub/byPia.png')
  check(
    await eventually(
      () => same(O1.vault.bytes('Projects/X/Sub/byPia.png'), binary(7)) && !O1.vault.bytes('Projects/X/Sub/fromPia.png') && same(Q.vault.bytes('Shared/X/Sub/byPia.png'), binary(7))
    ),
    "a writer's rename of a file inside the folder is everyone's",
    O1.vault.attachmentPaths()
  )

  await P1.vault.trash(P1.vault.file('Shared/X/Sub/byPia.png'))
  check(
    await eventually(() => !O1.vault.bytes('Projects/X/Sub/byPia.png') && !Q.vault.bytes('Shared/X/Sub/byPia.png')),
    "a writer's delete of a file is a delete for everyone",
    O1.vault.attachmentPaths()
  )
  const fileNews = P1.folderNews.find((news) => news.kind === 'deleted' && (news.names as string[]).includes('byPia.png'))
  check(fileNews !== undefined, 'and they are told', P1.folderNews)
  await fileNews?.undo?.()
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
  await P1.vault.trash(P1.vault.file('Shared/X/photo.png'))
  check(await eventually(() => !O1.vault.bytes('Projects/X/photo.png')), "the owner's copy goes with a writer's delete")
  {
    const trashed = O1.attachments?.deletedFiles(0).find((file) => file.path === 'Projects/X/photo.png')
    check(trashed !== undefined, "and lies in the owner's trash")
    if (trashed) await O1.attachments?.restoreDeleted(trashed.fileId)
  }
  check(
    await eventually(() => same(P1.vault.bytes('Shared/X/photo.png'), binary(4)) && same(Q.vault.bytes('Shared/X/photo.png'), binary(4)), 15_000),
    'a file brought back from the trash is back for everyone in the folder',
    P1.vault.attachmentPaths()
  )
  await delay(1_200)
  check(same(O1.vault.bytes('Projects/X/photo.png'), binary(4)), 'and the folder does not delete it again')

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
  await P1.vault.createFolder('Elsewhere')
  await P1.vault.rename(P1.vault.file('Shared/X/New.md'), 'Elsewhere/New.md')
  await delay(800)
  check(O1.vault.text('Projects/Y/New.md') === 'from the owner\n', "a member moving a note out of their copy changes nothing for anyone else")
  await O1.vault.userWrite('Projects/Y/New.md', 'from the owner\nmore\n')
  check(await eventually(() => P1.vault.text('Elsewhere/New.md') === 'from the owner\nmore\n'), 'it stays shared where they put it')
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
  await deletedNews?.undo?.()
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

  // --- a note shared on its own as well, and revoking ------------------------------------------
  {
    const renamedId = O1.index?.docIdForPath('Projects/Y/Renamed.md') as string
    await O1.sharing?.share(renamedId, Q.accountId, 'read', true)
    await delay(800)
    check(Q.vault.text('Shared/X/Renamed.md') !== undefined && !Q.vault.text('Shared/Renamed.md'), 'a note shared on its own with someone who has it through the folder stays where it is')
    const folderId = folderOf(O1, 'Projects/Y/Renamed.md') as string
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
} catch (error) {
  check(false, 'the scenario ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  for (const device of devices) await device.shutdown()
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
