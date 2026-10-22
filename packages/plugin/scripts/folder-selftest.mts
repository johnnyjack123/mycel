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

async function befriend(a: Device, b: Device): Promise<void> {
  const code = await (a.contacts as NonNullable<typeof a.contacts>).createCode()
  await b.contacts?.redeem(code)
  await eventually(() => a.contacts?.name(b.accountId) !== undefined && b.contacts?.name(a.accountId) !== undefined)
}

const O1 = new Device(olga, true, {
  'Projects/X/Plan.md': 'a draft nobody else should see\n',
  'Projects/X/Sub/Deep.md': 'deep\n',
  'Projects/Other.md': 'other\n',
  'Projects/Second.md': 'second\n'
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
  check(await eventually(() => O2.vault.text('Projects/X/Plan.md') !== undefined), "the owner's second device has the vault")

  // --- sharing a folder ------------------------------------------------------------
  await O1.vault.userWrite('Projects/X/Plan.md', 'plan\n')
  check(await eventually(() => O1.docText('Projects/X/Plan.md') === 'plan\n'), 'the owner writes the plan')
  await O1.folders?.share('Projects/X', P1.accountId, 'write', true)
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
  const deletedNews = P1.folderNews.find((news) => news.kind === 'deleted')
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
} catch (error) {
  check(false, 'the scenario ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  for (const device of devices) await device.shutdown()
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
