// Three devices of one person, and a second person, against a running server,
// end-to-end encrypted. Everything real except Obsidian itself: accounts and
// keys, the DocStore, the editor binding in real CodeMirror editors, the
// socket, the server. The vault and the Markdown view are fakes that save and
// reload the way Obsidian does, because that interplay is what doubled text
// before.
//
//   PORT=1235 MYCEL_REGISTRATION=open MYCEL_DATA_DIR=<scratch> npm run start:server
//   npm run test:vault -- ws://localhost:1235
import { check, delay, Device, eventually, failures, slowed, useServer } from './harness.mjs'

// Imported after the harness set up the DOM; CodeMirror reads it at module scope.
const { Notice } = await import('obsidian')
const { BLOB_CHUNK_BYTES, MUX, docRoom, frameAad, indexRoom } = await import('@mycel/shared')
const { aesKey, contentHash, encrypt, epochKeyContext, packSignedFrame, randomBytes, seal } = await import('@mycel/shared/crypto')
const Y = await import('yjs')
const encoding = await import('lib0/encoding')
const { KeyRing } = await import('../src/account/KeyRing.js')
const { NoteHistory } = await import('../src/history/NoteHistory.js')
const { landingTitle, linkedNotes } = await import('../src/share/LinkedNotes.js')

const serverUrl = process.argv[2] ?? process.env.MYCEL_URL ?? 'ws://localhost:1234'
useServer(serverUrl)
const run = Date.now().toString(36)

const alice = `alice${run}`
const carol = `carol${run}`
console.log(`server=${serverUrl} accounts=${alice},${carol}`)

/** Bytes standing in for an image or a PDF; a different seed, a different file. */
const binary = (seed: number, length = 3_000): Uint8Array => new Uint8Array(length).map((_byte, index) => (index * seed + 11) & 255)
const same = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean =>
  a !== undefined && b !== undefined && a.length === b.length && a.every((byte, index) => byte === b[index])

/**
 * Holds back what a device pushes into rooms whose name starts with
 * `prefix`, until released - the moment two devices change something before
 * either has seen the other's change.
 */
const PUSH = 3
function holdPushes(device: Device, prefix: string): () => void {
  const ws = (device.socket as unknown as { ws: { send(data: Uint8Array): void; close(): void } }).ws
  const send = ws.send.bind(ws)
  ws.send = (data: Uint8Array) => {
    // [type][varString room]...: room names are short enough for a one-byte length.
    const room = new TextDecoder().decode(data.subarray(2, 2 + (data[1] ?? 0)))
    if (data[0] !== PUSH || !room.startsWith(prefix)) send(data)
  }
  return () => {
    ws.send = send
    // The outbox goes out again on the new connection.
    ws.close()
  }
}

const logo = binary(3)
const A = new Device(alice, true, {
  'Welcome.md': 'Hello from A\n',
  'Projects/Plan.md': 'step 1\nstep 2\n',
  'Assets/logo.png': logo
})
const B = new Device(alice, false)

try {
  // --- a second device pulls the vault ---------------------------------------
  check(await A.boot(), 'A creates the account and starts')
  check(await B.boot(), 'B signs in to the same account with an empty vault')
  check(
    await eventually(() => B.vault.paths().join(',') === 'Projects/Plan.md,Welcome.md'),
    'B creates every note it only knows from the index, folders included',
    B.vault.paths()
  )
  // A's own start may still be sending when B asks: the file can appear a
  // moment before its text does.
  check(await eventually(() => B.vault.text('Welcome.md') === 'Hello from A\n'), 'with the right content', B.vault.text('Welcome.md'))

  {
    const docId = A.index?.docIdForPath('Welcome.md') as string
    const log = await A.api.log(docRoom(docId))
    const stored = log.frames.map((frame) => Buffer.from(frame.data, 'base64').toString('latin1')).join('')
    check(log.frames.length > 0 && !stored.includes('Hello from A'), 'the server stores the note encrypted')
  }

  // --- live, without editors -------------------------------------------------
  await A.vault.userCreate('Ideas.md', 'an idea\n')
  check(
    await eventually(() => B.vault.text('Ideas.md') === 'an idea\n'),
    'a note created on A appears on B',
    B.vault.text('Ideas.md')
  )

  await A.vault.userWrite('Welcome.md', 'Hello from A\nsecond line\n')
  check(
    await eventually(() => B.vault.text('Welcome.md') === 'Hello from A\nsecond line\n'),
    'an edit saved on A reaches the file on B',
    B.vault.text('Welcome.md')
  )

  await A.vault.createFolder('Archive')
  await A.vault.rename(A.vault.file('Projects/Plan.md'), 'Archive/Plan.md')
  check(
    await eventually(() => B.vault.text('Archive/Plan.md') === 'step 1\nstep 2\n' && !B.vault.text('Projects/Plan.md')),
    'a rename on A becomes a rename on B, into a folder B did not have',
    B.vault.paths()
  )

  // Obsidian rewrites the links to a renamed note. Those edits are the
  // renaming device's and travel with the linking notes; the other device
  // rewriting them as well inserted every link twice whenever both did so
  // before seeing the other's - a slow phone and a fast desktop, say. Holding
  // back both devices' note changes until then makes that moment certain.
  {
    const linking = 'see [[Target]] and [[Target]]\n'
    await A.vault.userCreate('Target.md', 'the target\n')
    await A.vault.userCreate('Linker.md', linking)
    check(
      await eventually(() => B.vault.text('Linker.md') === linking && B.vault.text('Target.md') === 'the target\n'),
      'B has a note and one linking to it'
    )
    const releaseA = holdPushes(A, 'doc:')
    const releaseB = holdPushes(B, 'doc:')
    await A.fileManager.renameFile(A.vault.file('Target.md'), 'Renamed.md')
    check(await eventually(() => B.vault.text('Renamed.md') === 'the target\n'), 'B applies the rename')
    // Time for B to rewrite the links too, if it does.
    await delay(800)
    releaseA()
    releaseB()
    const synced = (device: typeof A): boolean => device.store?.noteState(device.vault.file('Linker.md')) === 'synced'
    check(await eventually(() => synced(A) && synced(B), 15_000), 'both devices send what they held back')
    // Each one's changes reach the other, and the files follow.
    await delay(1_000)
    const relinked = 'see [[Renamed]] and [[Renamed]]\n'
    const linkers = (): Record<string, string | undefined> => ({
      a: A.vault.text('Linker.md'),
      b: B.vault.text('Linker.md'),
      aDoc: A.docText('Linker.md'),
      bDoc: B.docText('Linker.md')
    })
    check(
      [A.vault.text('Linker.md'), B.vault.text('Linker.md'), A.docText('Linker.md'), B.docText('Linker.md')].every((text) => text === relinked),
      'renaming a linked note rewrites each link once, on both devices',
      linkers()
    )
  }

  // --- attachments ---------------------------------------------------------------
  {
    const fileIdOf = (device: Device, path: string): string => device.attachmentIndex?.idForPath(path) ?? ''
    check(await eventually(() => same(B.vault.bytes('Assets/logo.png'), logo)), 'an attachment that was there before the plugin reaches the other device')

    // More than one chunk, so it travels in pieces.
    const photo = binary(7, BLOB_CHUNK_BYTES + 5_000)
    await A.vault.userCreateBinary('Assets/photo.jpg', photo)
    check(await eventually(() => same(B.vault.bytes('Assets/photo.jpg'), photo), 15_000), 'a new attachment larger than one chunk reaches B')

    const edited = binary(9, 4_000)
    await A.vault.userWriteBinary('Assets/photo.jpg', edited)
    check(await eventually(() => same(B.vault.bytes('Assets/photo.jpg'), edited)), 'a changed attachment reaches B')
    {
      const versions = A.attachmentIndex?.versions(fileIdOf(A, 'Assets/photo.jpg')) ?? []
      check(versions.some((version) => version.size === photo.length), 'and what it replaced is recorded as an earlier version', versions)
    }

    await A.vault.createFolder('Holiday')
    await A.vault.rename(A.vault.file('Assets/photo.jpg'), 'Holiday/photo.jpg')
    check(
      await eventually(() => same(B.vault.bytes('Holiday/photo.jpg'), edited) && !B.vault.bytes('Assets/photo.jpg')),
      'a rename on A is a rename on B, into a folder B did not have',
      B.vault.attachmentPaths()
    )

    await A.vault.trash(A.vault.file('Holiday/photo.jpg'))
    check(await eventually(() => B.vault.bytes('Holiday/photo.jpg') === undefined), 'a delete on A removes the file on B')
    await delay(600)
    check(A.vault.bytes('Holiday/photo.jpg') === undefined, 'and it does not come back')

    // Both change the same file while B is away.
    await B.shutdown()
    const fromA = binary(13)
    const fromB = binary(17)
    await A.vault.userWriteBinary('Assets/logo.png', fromA)
    B.vault.offlineWriteBinary('Assets/logo.png', fromB)
    await delay(600)
    check(await B.boot(), 'B comes back after both devices changed the same attachment')
    const copyOf = (device: Device): string | undefined =>
      device.vault.attachmentPaths().find((path) => /^Assets\/logo \(conflict \d{4}-\d{2}-\d{2} \d{4}\)\.png$/.test(path))
    check(
      await eventually(() => {
        const onA = copyOf(A)
        const onB = copyOf(B)
        return Boolean(onA && onB) && same(A.vault.bytes(onA as string), fromB) && same(B.vault.bytes(onB as string), fromB)
      }),
      "B's version is kept as a second file, on both devices",
      { a: A.vault.attachmentPaths(), b: B.vault.attachmentPaths() }
    )
    check(same(A.vault.bytes('Assets/logo.png'), fromA) && same(B.vault.bytes('Assets/logo.png'), fromA), "and the file itself is A's, on both")
    check(Notice.shown.some((notice) => notice.includes('Both are kept')), 'B says so')

    // Deleted on A while B changed it.
    await B.shutdown()
    await A.vault.trash(A.vault.file('Assets/logo.png'))
    const kept = binary(19)
    B.vault.offlineWriteBinary('Assets/logo.png', kept)
    await delay(600)
    check(await B.boot(), 'B comes back after A deleted an attachment B changed')
    check(
      await eventually(() => same(A.vault.bytes('Assets/logo.png'), kept) && same(B.vault.bytes('Assets/logo.png'), kept)),
      'the change wins over the delete and comes back to A'
    )

    // Two devices writing the same file at once, neither seeing the other's
    // entry. One entry replaces the other whole; the device whose write is
    // gone must keep its version rather than take the other one for news.
    await A.vault.userCreateBinary('Assets/race.bin', binary(21))
    check(await eventually(() => same(B.vault.bytes('Assets/race.bin'), binary(21))), 'B has a file')
    await delay(300)
    const releaseA = holdPushes(A, 'idx:')
    const releaseB = holdPushes(B, 'idx:')
    const raceA = binary(23)
    const raceB = binary(29)
    await A.vault.userWriteBinary('Assets/race.bin', raceA)
    await B.vault.userWriteBinary('Assets/race.bin', raceB)
    // Both have uploaded and written their entry, unseen by the other.
    await eventually(async () => {
      const id = fileIdOf(A, 'Assets/race.bin')
      return A.attachmentIndex?.entry(id)?.hash === (await contentHash(raceA)) && B.attachmentIndex?.entry(id)?.hash === (await contentHash(raceB))
    })
    releaseA()
    releaseB()
    const contents = (device: Device): Uint8Array[] =>
      device.vault
        .attachmentPaths()
        .filter((path) => path.startsWith('Assets/race'))
        .map((path) => device.vault.bytes(path) as Uint8Array)
    const both = (device: Device): boolean =>
      contents(device).length === 2 && contents(device).some((data) => same(data, raceA)) && contents(device).some((data) => same(data, raceB))
    check(
      await eventually(() => both(A) && both(B), 15_000),
      'two writes racing keep both versions, on both devices',
      { a: A.vault.attachmentPaths(), b: B.vault.attachmentPaths() }
    )

    // --- a canvas, saved the way Obsidian saves one -------------------------------
    {
      const BOARD = 'Boards/plan.canvas'
      const canvas = (...texts: string[]): Uint8Array =>
        new TextEncoder().encode(
          JSON.stringify(
            { nodes: texts.map((text, i) => ({ id: `n${i}`, type: 'text', text, x: i * 300, y: 0, width: 250, height: 60 })), edges: [] },
            null,
            '\t'
          )
        )
      const copies = (device: Device): string[] => device.vault.attachmentPaths().filter((path) => path.startsWith('Boards/plan (conflict'))
      await A.vault.userCreateBinary(BOARD, canvas())
      check(await eventually(() => same(B.vault.bytes(BOARD), canvas())), 'B has a new canvas')

      // A card is created and named right away: the canvas saves its name
      // while the version with the empty card is still being uploaded.
      const put = A.api.putBlobChunk.bind(A.api)
      let naming = true
      A.api.putBlobChunk = async (...args: Parameters<typeof put>) => {
        if (naming) {
          naming = false
          await A.vault.userWriteBinary(BOARD, canvas('Ideas'))
        }
        return put(...args)
      }
      await A.vault.userWriteBinary(BOARD, canvas(''))
      check(
        await eventually(() => same(B.vault.bytes(BOARD), canvas('Ideas'))),
        "a canvas saved again during an upload reaches B with the card's name",
        new TextDecoder().decode(B.vault.bytes(BOARD))
      )
      A.api.putBlobChunk = put

      // Obsidian giving the file a new mtime, its content the same.
      B.vault.touch(BOARD)
      await A.vault.userWriteBinary(BOARD, canvas('Ideas', 'Plans'))
      check(
        await eventually(() => same(B.vault.bytes(BOARD), canvas('Ideas', 'Plans'))),
        "a file whose mtime moved but not its content still takes another device's version"
      )

      // B adds a card while away, A changes the canvas meanwhile. While B
      // fetches A's version to keep both, B's canvas saves the card's name.
      await B.shutdown()
      B.vault.offlineWriteBinary(BOARD, canvas('Ideas', 'Plans', ''))
      const fromA = canvas('Ideas', 'Plans', 'From A')
      await A.vault.userWriteBinary(BOARD, fromA)
      await delay(600)
      const named = canvas('Ideas', 'Plans', 'Named while away')
      const chunk = B.api.blobChunk.bind(B.api)
      let saving = true
      B.api.blobChunk = async (...args: Parameters<typeof chunk>) => {
        if (saving) {
          saving = false
          await B.vault.userWriteBinary(BOARD, named)
        }
        return chunk(...args)
      }
      check(await B.boot(), 'B comes back after both changed the canvas')
      check(
        await eventually(() =>
          [A, B].every((device) => same(device.vault.bytes(BOARD), fromA) && copies(device).some((path) => same(device.vault.bytes(path), named)))
        ),
        'what B saved while fetching the other version is in the conflict copy, not lost',
        { a: copies(A).map((path) => new TextDecoder().decode(A.vault.bytes(path))), b: copies(B).map((path) => new TextDecoder().decode(B.vault.bytes(path))) }
      )
      B.api.blobChunk = chunk
      await delay(800)

      // The canvas is open on B. A's next version is written into it, and
      // the view saves what it still held - over A's version, which nobody saw.
      B.openFiles.add(BOARD)
      const held = canvas('Ideas', 'Plans', 'From A', 'held by the view')
      let viewSaves = true
      const view = B.vault.on('modify', (file) => {
        if (!viewSaves || (file as { path: string }).path !== BOARD) return
        viewSaves = false
        setTimeout(() => void B.vault.userWriteBinary(BOARD, held), 300)
      })
      const again = canvas('Ideas', 'Plans', 'From A', 'A again')
      await A.vault.userWriteBinary(BOARD, again)
      check(
        await eventually(() =>
          [A, B].every((device) => same(device.vault.bytes(BOARD), held) && copies(device).some((path) => same(device.vault.bytes(path), again)))
        ),
        "a view saving over another device's version keeps that version as a second file",
        { a: A.vault.attachmentPaths(), b: B.vault.attachmentPaths() }
      )
      B.vault.offref(view)
      B.openFiles.delete(BOARD)
    }

    // A change no event reported: the regular comparison finds it.
    await A.vault.userCreateBinary('Assets/quiet.bin', binary(37))
    check(await eventually(() => same(B.vault.bytes('Assets/quiet.bin'), binary(37))), 'B has a file')
    await delay(300)
    B.vault.offlineWriteBinary('Assets/quiet.bin', binary(41))
    check(await eventually(() => same(A.vault.bytes('Assets/quiet.bin'), binary(41))), 'a change that raised no event is found and sent all the same')

    // --- earlier versions and the trash, for files ---------------------------------
    {
      const PIC = 'Assets/versions.png'
      const first = binary(43, 3_100)
      const second = binary(47, 3_200)
      await A.vault.userCreateBinary(PIC, first)
      check(await eventually(() => same(B.vault.bytes(PIC), first)), 'B has a picture')
      await A.vault.userWriteBinary(PIC, second)
      check(await eventually(() => same(B.vault.bytes(PIC), second)), 'A changes it, B follows')
      const firstHash = await contentHash(first)
      const secondHash = await contentHash(second)
      const listed = (device: Device): string[] => (device.attachments?.versionsOf(device.vault.file(PIC)) ?? []).map((version) => version.hash)
      check(
        await eventually(() => listed(A).join() === firstHash && listed(B).join() === firstHash),
        'the picture lists what it replaced as an earlier version, on both devices',
        { a: listed(A), b: listed(B) }
      )

      await B.attachments?.restoreVersion(B.vault.file(PIC), firstHash)
      check(
        await eventually(() => same(A.vault.bytes(PIC), first) && same(B.vault.bytes(PIC), first)),
        'restoring the earlier version on B brings it back everywhere'
      )
      check(await eventually(() => listed(A).includes(secondHash)), 'and the version it replaced is kept in turn', listed(A))

      const later = B.attachments?.versionsOf(B.vault.file(PIC)).find((version) => version.hash === secondHash)
      const copy = later ? await B.attachments?.saveVersionCopy(B.vault.file(PIC), later) : undefined
      check(
        Boolean(copy) && (await eventually(() => same(A.vault.bytes(copy?.path ?? ''), second))),
        'an earlier version saved as a copy is a file of its own, everywhere',
        copy?.path
      )

      await A.vault.trash(A.vault.file(PIC))
      check(await eventually(() => B.vault.bytes(PIC) === undefined), 'A deletes the picture, B follows')
      const inTrash = await eventually(() => Boolean(B.trash?.list().some((item) => item.kind === 'file' && item.path === PIC)))
      check(inTrash, 'it waits in the trash on the other device too', B.trash?.list().map((item) => item.path))
      // An old version of a note embedding it shows it from the trash.
      const target = B.attachments?.embedTarget('versions.png')
      check(target?.deleted === true && target.path === PIC && target.hash === firstHash, 'a link to it finds it in the trash', target)
      const item = B.trash?.list().find((candidate) => candidate.kind === 'file' && candidate.path === PIC)
      const back = item ? await B.trash?.restore(item) : null
      check(
        back?.path === PIC && (await eventually(() => same(A.vault.bytes(PIC), first) && same(B.vault.bytes(PIC), first))),
        'restoring it brings it back, on every device',
        back?.path
      )
      check(!B.trash?.list().some((candidate) => candidate.path === PIC), 'and it leaves the trash')
    }

    // A note renamed into another kind of file is a file from then on.
    await A.vault.userCreate('Draft.md', 'plain text after all\n')
    check(await eventually(() => B.vault.text('Draft.md') === 'plain text after all\n'), 'B has a note')
    await A.vault.rename(A.vault.file('Draft.md'), 'Draft.txt')
    check(
      await eventually(() => B.vault.bytes('Draft.txt') !== undefined && B.vault.text('Draft.md') === undefined),
      'renamed to .txt, it reaches B as a file and the note goes',
      B.vault.attachmentPaths()
    )
    await delay(800)
    check(A.vault.text('Draft.md') === undefined && B.vault.text('Draft.md') === undefined, 'and the note does not come back next to it')

    // A phone with a download limit.
    B.setDownloadLimit(1_000)
    const scan = binary(31, 5_000)
    await A.vault.userCreateBinary('Papers/scan.pdf', scan)
    await A.vault.userCreate('Reading.md', 'see ![[scan.pdf]]\n')
    check(await eventually(() => B.vault.text('Reading.md') === 'see ![[scan.pdf]]\n'), 'B gets a note that embeds a large file')
    await delay(800)
    check(B.vault.bytes('Papers/scan.pdf') === undefined, 'the file over its download limit stays on the server')
    {
      const target = B.attachments?.embedTarget('scan.pdf')
      check(target?.deleted === false && target.path === 'Papers/scan.pdf', 'a link to it finds it there', target)
    }
    const fetched = await B.attachments?.fetchFor(B.vault.file('Reading.md'))
    check(fetched === 1 && same(B.vault.bytes('Papers/scan.pdf'), scan), 'until the note that embeds it is opened', fetched)
    B.setDownloadLimit(null)
  }

  const backupsBeforeDelete = B.vault.adapter.backups().length
  await A.vault.trash(A.vault.file('Ideas.md'))
  check(await eventually(() => B.vault.text('Ideas.md') === undefined), 'a delete on A removes the note on B')
  check(B.vault.adapter.backups().length > backupsBeforeDelete, 'and B keeps a backup of it')

  // --- live editors on both devices ------------------------------------------
  const aView = A.open('Welcome.md')
  const bView = B.open('Welcome.md')
  check(
    await eventually(() => A.editors.boundCount() === 1 && B.editors.boundCount() === 1),
    'both editors bind once the note is settled'
  )

  const backupsBeforeTyping = A.vault.adapter.backups().length + B.vault.adapter.backups().length
  const noticesBeforeTyping = Notice.shown.length

  // "tt" was all it took to flood a note with t's.
  aView.type('t')
  await delay(30)
  aView.type('t')
  check(
    await eventually(() => bView.text() === 'Hello from A\nsecond line\ntt'),
    'two quick keystrokes on A arrive on B exactly once',
    bView.text()
  )

  // Both typing in bursts, with Obsidian saving in the pauses while the other
  // side is still typing: every save lags the document by a few characters.
  const aTyped: string[] = []
  const bTyped: string[] = []
  for (let burst = 0; burst < 6; burst += 1) {
    for (let i = 0; i < 5; i += 1) {
      const a = String.fromCharCode(97 + ((burst * 5 + i) % 26))
      aView.type(a)
      aTyped.push(a)
      const b = String.fromCharCode(65 + ((burst * 5 + i) % 26))
      bView.type(b, 0)
      bTyped.push(b)
      await delay(12)
    }
    await delay(160)
  }
  const expectedLength = 'Hello from A\nsecond line\ntt'.length + aTyped.length + bTyped.length
  check(
    await eventually(() => aView.text() === bView.text() && aView.text().length === expectedLength),
    'concurrent typing on both devices converges without losing or doubling a character',
    { a: aView.text(), b: bView.text(), expectedLength }
  )
  check(
    aView.text().startsWith(bTyped.slice().reverse().join('')) && aView.text().endsWith(`tt${aTyped.join('')}`),
    'and each side kept its own typing in order',
    aView.text()
  )
  await delay(600)
  check(
    A.vault.text('Welcome.md') === aView.text() && B.vault.text('Welcome.md') === bView.text(),
    'Obsidian saved the same text to disk on both devices',
    { a: A.vault.text('Welcome.md'), b: B.vault.text('Welcome.md') }
  )
  check(!aView.text().includes('<<<<<<<'), 'no conflict markers from racing saves')
  check(
    A.vault.adapter.backups().length + B.vault.adapter.backups().length === backupsBeforeTyping,
    'typing produced no merge backups',
    A.vault.adapter.backups().concat(B.vault.adapter.backups())
  )
  check(Notice.shown.length === noticesBeforeTyping, 'and no merge notices', Notice.shown.slice(noticesBeforeTyping))

  // A save that lags the editor must not be merged back in: the editor is the
  // only writer, and merging its own older copy duplicated whatever was typed
  // since. The dangerous shape: newer than the last agreement, older than the
  // document. A three-way merge sees both sides change the same line.
  check(await eventually(() => B.vault.text('Welcome.md') === bView.text()), 'B saved before the next edit')
  await delay(200)
  bView.type('!')
  const halfway = bView.text()
  bView.type('?')
  await bView.saveStale(halfway)
  await delay(500)
  check(
    B.docText('Welcome.md') === `${halfway}?` && aView.text() === `${halfway}?` && bView.text() === `${halfway}?`,
    'a stale save of a bound editor is not merged into the document',
    { doc: B.docText('Welcome.md'), editor: bView.text(), expected: `${halfway}?` }
  )
  check(await eventually(() => B.vault.text('Welcome.md') === bView.text()), 'and the next save puts the file right')

  // Editors binding again while someone types. What Obsidian last saved
  // lags the document then: B took that file - and the text its editor had
  // when it let go - for edits made on B, merged them against an older base
  // and wrapped both in conflict markers, on a device nobody typed on. And
  // A wrote the file under its own editor while binding again, so Obsidian
  // reloaded it and dropped what was typed in between.
  {
    await A.vault.userCreate('Typing.md', 'hellotet\n')
    check(await eventually(() => B.vault.text('Typing.md') === 'hellotet\n'), 'B has a note to watch A typing in')
    const aTyping = A.open('Typing.md', 300)
    const bTyping = B.open('Typing.md', 700)
    check(await eventually(() => A.editors.boundCount() === 2 && B.editors.boundCount() === 2), 'both editors bind it')
    const backupsBefore = A.vault.adapter.backups().length + B.vault.adapter.backups().length
    const reviewsBefore = A.reviews.length + B.reviews.length
    const docId = A.index?.docIdForPath('Typing.md') as string
    const typed = 'tesrwarhhddddddjjjjjjjlllddddddddsdfsafdsfasdfw4r'
    for (let i = 0; i < typed.length; i += 1) {
      aTyping.type(typed[i] as string)
      await delay(40 + ((i * 37) % 90))
      // Sharing or unsharing the note binds every editor of it again.
      if (i % 7 === 6 && i < 28) {
        A.store?.share(docId, !A.store.isShared(docId))
        A.editors.refresh()
      }
      // And B's editor letting go and binding again on its own.
      if (i % 9 === 8) {
        B.editors.unbindAll()
        B.editors.refresh()
      }
    }
    const expected = `hellotet\n${typed}`
    check(
      await eventually(() => aTyping.text() === expected && bTyping.text() === expected),
      'every keystroke typed while editors bound again arrives, once, in order',
      { a: aTyping.text(), b: bTyping.text() }
    )
    check(
      await eventually(() => A.vault.text('Typing.md') === expected && B.vault.text('Typing.md') === expected),
      'and both files end up with it',
      { a: A.vault.text('Typing.md'), b: B.vault.text('Typing.md') }
    )
    check(
      A.reviews.length + B.reviews.length === reviewsBefore &&
        A.vault.adapter.backups().length + B.vault.adapter.backups().length === backupsBefore,
      'with no merge, no review and no backup on either device',
      { reviews: A.reviews.slice(reviewsBefore).concat(B.reviews), backups: B.vault.adapter.backups() }
    )
    check(!A.store?.isShared(docId), 'the note is unshared again')
    A.close(aTyping)
    B.close(bTyping)
  }

  // Sync restarting under open editors - signing out and in, a changed setting -
  // while someone types. The new store settled the note against what Obsidian
  // had last saved and wrote the file; Obsidian reloaded the editor, and what
  // was typed since that save was gone. And the saves of the editor bound
  // before the restart looked like edits made here.
  {
    await A.vault.userCreate('Restart.md', 'start\n')
    check(await eventually(() => B.vault.text('Restart.md') === 'start\n'), 'B has a note to restart under')
    const aRestart = A.open('Restart.md', 300)
    const bRestart = B.open('Restart.md', 700)
    check(await eventually(() => A.editors.boundCount() === 2 && B.editors.boundCount() === 2), 'both editors bind it')
    const backups = (): number => A.vault.adapter.backups().length + B.vault.adapter.backups().length
    const reviews = (): number => A.reviews.length + B.reviews.length
    const restartB = async (): Promise<void> => {
      await B.shutdown({ keepViews: true })
      check(await B.boot(), "B's sync starts again under its open editors")
    }

    // Only A types while B restarts: B's editor holds nothing new.
    const backupsBefore = backups()
    const reviewsBefore = reviews()
    const fromA = 'abcdefghijklmnopqrst'
    let restarted: Promise<void> | null = null
    for (let i = 0; i < fromA.length; i += 1) {
      aRestart.type(fromA[i] as string)
      await delay(60)
      if (i === 4) restarted = restartB()
    }
    await restarted
    const first = `start\n${fromA}`
    check(
      await eventually(() => aRestart.text() === first && bRestart.text() === first && B.vault.text('Restart.md') === first),
      'a restart of sync under an open editor misses nothing typed elsewhere',
      { a: aRestart.text(), b: bRestart.text(), file: B.vault.text('Restart.md') }
    )
    check(backups() === backupsBefore && reviews() === reviewsBefore, 'and takes nothing of the editor for an edit: no backup, no review', {
      backups: B.vault.adapter.backups(),
      reviews: B.reviews.slice(reviewsBefore)
    })

    // Both type while B restarts: B's keystrokes in between reach only its editor.
    const reviewsBoth = reviews()
    const fromB = 'ABCDEFGHIJKLMNOPQRST'
    const moreA = 'uvwxyz0123456789'
    restarted = null
    const aTypes = (async (): Promise<void> => {
      for (const key of moreA) {
        aRestart.type(key)
        await delay(70)
      }
    })()
    for (let i = 0; i < fromB.length; i += 1) {
      bRestart.type(fromB[i] as string, i)
      await delay(60)
      if (i === 3) restarted = restartB()
    }
    await aTypes
    await restarted
    const both = `${fromB}start\n${fromA}${moreA}`
    check(
      await eventually(() => aRestart.text() === both && bRestart.text() === both, 15_000),
      'what is typed while sync restarts stays, every keystroke once, on both devices',
      { a: aRestart.text(), b: bRestart.text() }
    )
    check(
      await eventually(() => A.vault.text('Restart.md') === both && B.vault.text('Restart.md') === both),
      'and both files end up with it',
      { a: A.vault.text('Restart.md'), b: B.vault.text('Restart.md') }
    )
    check(reviews() === reviewsBoth, 'merged without anything to review', B.reviews.slice(reviewsBoth))
    A.close(aRestart)
    B.close(bRestart)
  }

  // A change with several parts in one transaction. Mapping its delta onto
  // the editor used to shift every later part by the length of the earlier
  // insertions. At the start of lines, so a misplaced second part still lands
  // inside the text - silently wrong instead of out of range and caught.
  A.close(aView)
  await delay(300)
  const lines = bView.text().split('\n')
  const reshaped = [`>> ${lines[0]}`, lines[1], `>> ${lines[2]}`].join('\n')
  await A.vault.userWrite('Welcome.md', reshaped)
  check(
    await eventually(() => bView.text() === reshaped),
    'a change in two places arrives in the editor in the right places',
    { editor: bView.text(), expected: reshaped }
  )
  check(B.docText('Welcome.md') === bView.text(), 'and the editor still matches its document')

  // Opening another note in the same leaf rebuilds the editor state.
  bView.showFile(B.vault.file('Archive/Plan.md'))
  check(
    await eventually(() => B.editors.boundCount() === 1 && B.docText('Archive/Plan.md') === bView.text()),
    'switching notes in a leaf rebinds to the new note'
  )
  check(B.docText('Welcome.md') === reshaped, 'without carrying the other note into the old document')
  bView.type('\nstep 3')
  check(
    await eventually(() => A.vault.text('Archive/Plan.md') === 'step 1\nstep 2\n\nstep 3'),
    'and typing there reaches the other device',
    A.vault.text('Archive/Plan.md')
  )

  // --- offline ----------------------------------------------------------------
  const plan = 'step 1\nstep 2\n\nstep 3'
  await B.shutdown()
  await A.vault.userWrite('Archive/Plan.md', `STEP 1\nstep 2\n\nstep 3`)
  B.vault.offlineWrite('Archive/Plan.md', `step 1\nstep 2\n\nstep 3\nstep 4 (offline)`)
  check(await B.boot(), 'B comes back after both sides edited the same note')
  const merged = 'STEP 1\nstep 2\n\nstep 3\nstep 4 (offline)'
  check(
    await eventually(() => B.vault.text('Archive/Plan.md') === merged && A.vault.text('Archive/Plan.md') === merged),
    'both offline edits survive, on both devices',
    { a: A.vault.text('Archive/Plan.md'), b: B.vault.text('Archive/Plan.md'), before: plan }
  )

  await B.shutdown()
  await A.vault.userCreate('Scratch.md', 'temporary\n')
  await delay(600)
  check(await B.boot(), 'B restarts, unlocking with what it kept')
  check(await eventually(() => B.vault.text('Scratch.md') === 'temporary\n'), 'B has Scratch.md')
  await B.shutdown()
  await A.vault.trash(A.vault.file('Scratch.md'))
  await delay(600)
  check(await B.boot(), 'B restarts after A deleted a note it has not changed')
  await delay(1_000)
  check(B.vault.text('Scratch.md') === undefined, 'B applies the delete instead of bringing the note back')
  check(A.vault.text('Scratch.md') === undefined, 'and A does not get it back either')

  await B.shutdown()
  await A.vault.trash(A.vault.file('Welcome.md'))
  B.vault.offlineWrite('Welcome.md', `${reshaped}\nwritten on B while offline`)
  await delay(600)
  check(await B.boot(), 'B restarts after A deleted a note B changed')
  check(
    await eventually(() => A.vault.text('Welcome.md') === `${reshaped}\nwritten on B while offline`),
    'the change wins over the delete and comes back to A',
    A.vault.text('Welcome.md')
  )
  check(B.vault.text('Welcome.md') === `${reshaped}\nwritten on B while offline`, 'and B keeps it')

  // --- an editor that was open before sync started ----------------------------
  await B.shutdown()
  const early = B.open('Archive/Plan.md')
  early.type('\ntyped before sync started')
  await delay(300)
  check(await B.boot(), 'B starts with the note already open and edited')
  const expectedEarly = `${merged}\ntyped before sync started`
  check(
    await eventually(() => A.vault.text('Archive/Plan.md') === expectedEarly && early.text() === expectedEarly),
    'what was typed before sync started arrives once, and the editor gains nothing twice',
    { a: A.vault.text('Archive/Plan.md'), editor: early.text() }
  )
  check(await eventually(() => B.editors.boundCount() === 1), 'and the editor binds')

  // --- deleting and re-creating ------------------------------------------------
  // Obsidian names every new note "Untitled" and the user renames it, so a
  // note's id usually comes from a path it no longer has.
  await A.vault.userCreate('Untitled.md', 'doomed text\n')
  await delay(300)
  await A.vault.rename(A.vault.file('Untitled.md'), 'Doomed.md')
  check(await eventually(() => B.vault.text('Doomed.md') === 'doomed text\n'), 'B has Doomed.md')

  // Deleted on one device while it is open on the other. The open editor
  // re-acquired the note from its now deleted file and registered it again,
  // so it came back - empty - on both devices.
  const doomedView = A.open('Doomed.md')
  check(await eventually(() => A.editors.boundCount() === 1), 'A has Doomed.md open')
  await B.vault.trash(B.vault.file('Doomed.md'))
  check(await eventually(() => A.vault.text('Doomed.md') === undefined), 'the delete reaches the device showing the note')
  await delay(1_500)
  check(
    A.vault.text('Doomed.md') === undefined && B.vault.text('Doomed.md') === undefined,
    'and the note does not come back, on either device',
    { a: A.vault.text('Doomed.md'), b: B.vault.text('Doomed.md') }
  )
  A.close(doomedView)

  // A new note at a path an earlier note was created under must be a new
  // document, not that one.
  await A.vault.userCreate('Untitled.md', 'first note\n')
  await delay(300)
  await A.vault.rename(A.vault.file('Untitled.md'), 'First.md')
  await A.vault.userCreate('Untitled.md', '')
  check(
    await eventually(() => B.vault.text('Untitled.md') === '' && B.vault.text('First.md') === 'first note\n'),
    'a second "Untitled" note syncs on its own, next to the renamed first one',
    { untitled: B.vault.text('Untitled.md'), first: B.vault.text('First.md') }
  )

  await A.vault.userCreate('Gone.md', 'content of a note that was deleted\n')
  check(await eventually(() => B.vault.text('Gone.md') !== undefined), 'B has Gone.md')
  await A.vault.trash(A.vault.file('Gone.md'))
  check(await eventually(() => B.vault.text('Gone.md') === undefined), 'Gone.md is deleted on B')
  await A.vault.userCreate('Gone.md', 'a new note\n')
  await delay(1_500)
  check(
    A.vault.text('Gone.md') === 'a new note\n' && B.vault.text('Gone.md') === 'a new note\n',
    'a new note under a deleted name does not inherit the deleted text',
    { a: A.vault.text('Gone.md'), b: B.vault.text('Gone.md') }
  )

  // --- the trash -----------------------------------------------------------------
  {
    const trashed = (device: typeof A): string[] => (device.trash?.list() ?? []).map((note) => note.path)
    check(
      trashed(A).includes('Doomed.md') && trashed(A).includes('Gone.md') && trashed(B).includes('Gone.md'),
      'deleted notes wait in the trash, on every device, whoever deleted them',
      { a: trashed(A), b: trashed(B) }
    )
    // The old Gone.md, whose name a new note has taken since.
    const oldGone = B.trash?.list().find((item) => item.kind === 'note' && item.path === 'Gone.md')
    const restored = oldGone ? await B.trash?.restore(oldGone) : null
    check(restored?.path === 'Gone (restored).md', 'a deleted note comes back next to the one that took its name', restored?.path)
    check(
      await eventually(
        () =>
          A.vault.text('Gone (restored).md') === 'content of a note that was deleted\n' &&
          B.vault.text('Gone (restored).md') === 'content of a note that was deleted\n' &&
          A.vault.text('Gone.md') === 'a new note\n'
      ),
      'with its text, on every device, leaving the new one alone',
      { a: A.vault.paths(), b: B.vault.paths() }
    )
    check(!trashed(A).includes('Gone.md'), 'and leaves the trash')

    // Brought back at once, while the other device is still carrying the delete
    // out - slow to keep its copy: that device trashed its file only after the
    // note was back, and took its own trashing for a delete made there.
    {
      await A.vault.userCreate('Back.md', 'back at once\n')
      check(await eventually(() => B.vault.text('Back.md') === 'back at once\n'), 'B has Back.md')
      let keeping = false
      const quick = slowed((B.store as unknown as { backups: object }).backups, 'write', 1_500, (path: string) => {
        keeping ||= path === 'Back.md'
        return path === 'Back.md'
      })
      await A.vault.trash(A.vault.file('Back.md'))
      check(await eventually(() => keeping), 'B starts carrying the delete out')
      const deleted = A.trash?.list().find((note) => note.kind === 'note' && note.path === 'Back.md')
      const back = deleted ? await A.trash?.restore(deleted) : null
      check(back?.path === 'Back.md', 'a note brought back the moment it was deleted', back?.path)
      await delay(3_000)
      quick()
      check(
        await eventually(() => A.vault.text('Back.md') === 'back at once\n' && B.vault.text('Back.md') === 'back at once\n'),
        'stays back, on every device',
        { a: A.vault.text('Back.md'), b: B.vault.text('Back.md') }
      )
    }

    // Past the retention, the server lets go of what is still in the trash.
    const doomedId = A.trash?.list().find((item) => item.kind === 'note' && item.path === 'Doomed.md')?.id as string
    A.retentionDays = 1e-9
    const purged = (await A.trash?.purge()) ?? 0
    A.retentionDays = 30
    check(purged > 0, 'after the retention the trash is emptied', purged)
    check(
      (await A.api.log(docRoom(doomedId)).then(
        () => 'still there',
        (error: { status?: number }) => error.status
      )) === 404,
      'the server has let go of the note'
    )
    check(await eventually(() => !trashed(B).includes('Doomed.md')), 'and no device offers it any more', trashed(B))
    // The device that purged cleared its own copy; the others hold theirs until their trash pass.
    {
      const database = `mycel/${B.keys?.vaultId}/${doomedId}`
      const heldThere = B.locals.has(database) && (await B.locals.history.entries(docRoom(doomedId))).length > 0
      await B.trash?.purge()
      check(
        heldThere && !B.locals.has(database) && (await B.locals.history.entries(docRoom(doomedId))).length === 0,
        "another device's trash pass clears its copy of the purged note - its database and its history",
        { heldThere }
      )
      const opened = B.locals.opened.get(database)
      await B.trash?.purge()
      check(B.locals.opened.get(database) === opened && !B.locals.has(database), 'once: its database is never opened again')
    }
    check(
      A.vault.text('Gone (restored).md') === 'content of a note that was deleted\n' && A.vault.text('Gone.md') === 'a new note\n',
      'while the notes that live are untouched'
    )
    // This server keeps content uploaded within the last minutes, whatever
    // anyone asks; what it kept must not be forgotten as if it went.
    check(
      trashed(A).includes('Holiday/photo.jpg'),
      'a deleted file whose content the server kept for now is still in the trash',
      trashed(A)
    )
  }

  // Opening a new note in a leaf that showed another one. For a moment the
  // view already names the new note while the buffer still holds the old
  // text; binding then took that text for edits to the new note.
  const leaf = A.open('First.md')
  check(await eventually(() => A.editors.boundCount() === 1), 'A has First.md open')
  for (const [name, rebuild] of [['Fresh.md', true], ['Fresher.md', false]] as const) {
    await A.vault.userCreate(name, '')
    await delay(300)
    await leaf.showFileSlowly(A.vault.file(name), 400, rebuild)
    await delay(1_000)
    check(
      A.vault.text(name) === '' && B.vault.text(name) === '' && leaf.text() === '',
      `a new note opened in a used leaf stays empty (${rebuild ? 'fresh state' : 'same state'})`,
      { editor: leaf.text(), a: A.vault.text(name), b: B.vault.text(name) }
    )
    check(A.vault.text('First.md') === 'first note\n', 'and the note that was open before is untouched')
    leaf.showFile(A.vault.file('First.md'))
    await delay(300)
  }
  leaf.showFile(A.vault.file('Fresh.md'))
  check(await eventually(() => A.editors.boundCount() === 1), 'Fresh.md binds')
  leaf.type('fresh text')
  check(await eventually(() => B.vault.text('Fresh.md') === 'fresh text'), 'typing in it then reaches the other device')
  A.close(leaf)

  // --- a new device whose vault is a copy, with a note open at startup ----------
  // Nothing stored locally yet, so the document is empty until the server
  // answers. Binding then seeded the room with the editor's copy of a note the
  // room already held - the note doubled on every device.
  const D = new Device(alice, false, {
    'Archive/Plan.md': A.vault.text('Archive/Plan.md') ?? '',
    'Welcome.md': A.vault.text('Welcome.md') ?? ''
  })
  try {
    const planBefore = A.vault.text('Archive/Plan.md')
    const dPlan = D.open('Archive/Plan.md')
    check(await D.boot(), 'a new device with a copied vault signs in and starts')
    check(await eventually(() => D.editors.boundCount() === 1), 'its open editor binds')
    await delay(800)
    check(
      dPlan.text() === planBefore && A.vault.text('Archive/Plan.md') === planBefore,
      'and the note is not doubled anywhere',
      { phone: dPlan.text(), a: A.vault.text('Archive/Plan.md'), expected: planBefore }
    )
  } finally {
    await D.shutdown()
  }

  // --- a device joining with its own, different version of a note ---------------------
  // Nothing tells which side changed what, so both are kept - and the user
  // gets to choose.
  await A.vault.userCreate('Pairing.md', 'line one\nline two\n')
  check(await eventually(() => A.docText('Pairing.md') === 'line one\nline two\n'), 'A has a note')
  {
    // The cloud in the status bar.
    const state = (): string => A.store?.noteState(A.vault.file('Pairing.md')) ?? 'none'
    check(await eventually(() => state() === 'synced'), 'a note the server has confirmed shows as synced', state())
    const socket = (A.socket as unknown as { ws: { send(data: Uint8Array): void; close(): void } }).ws
    const send = socket.send.bind(socket)
    socket.send = (data: Uint8Array) => {
      if (data[0] !== 3) send(data)
    }
    await A.vault.userWrite('Pairing.md', 'line one\nline two\nnot sent yet\n')
    // Past the moment the file is being taken in: only the unconfirmed edit is left.
    await eventually(() => A.docText('Pairing.md') === 'line one\nline two\nnot sent yet\n')
    await delay(1_000)
    check(state() === 'unsent', 'an edit the server has not confirmed shows as unsent', state())
    socket.send = send
    socket.close()
    check(await eventually(() => state() === 'synced', 15_000), 'and as synced once it has', state())
    await A.vault.userWrite('Pairing.md', 'line one\nline two\n')
    check(await eventually(() => A.docText('Pairing.md') === 'line one\nline two\n' && state() === 'synced'), 'back to where it was')
  }
  const E = new Device(alice, false, { 'Pairing.md': 'line one\nline 2, as E has it\n' })
  try {
    check(await E.boot(), 'a device with an older copy of the vault joins')
    const both = 'line one\nline two\nline 2, as E has it\n'
    check(
      await eventually(() => E.vault.text('Pairing.md') === both && A.vault.text('Pairing.md') === both),
      'both versions are kept, on both devices',
      { a: A.vault.text('Pairing.md'), e: E.vault.text('Pairing.md') }
    )
    const review = E.reviews.find((candidate) => candidate.path === 'Pairing.md')
    check(
      review?.kind === 'no-base' && review.mine === 'line one\nline 2, as E has it\n' && review.theirs === 'line one\nline two\n' && review.merged === both,
      'and E keeps both versions for the user to compare',
      review
    )
    if (review) {
      const { assemble, compare } = await import('../src/sync/Reviews.js')
      const hunks = compare(review.mine, review.theirs)
      await E.store?.applyReview(review.docId, review.merged, assemble(hunks, ['mine']))
    }
    check(
      await eventually(() => A.vault.text('Pairing.md') === 'line one\nline 2, as E has it\n' && E.vault.text('Pairing.md') === 'line one\nline 2, as E has it\n'),
      "choosing E's version makes it the note everywhere",
      { a: A.vault.text('Pairing.md'), e: E.vault.text('Pairing.md') }
    )
    check(E.vault.adapter.backups().length > 0, 'after a backup of what it said')
  } finally {
    await E.shutdown()
  }

  // --- sharing one note with a person ------------------------------------------------
  // The history view merges edits less than a minute apart into one version;
  // here the draft lives for well under a second.
  const HISTORY_GAP_MS = 150
  const C = new Device(carol, true)
  try {
    check(await C.boot(), 'C creates an account of her own')

    // Contacts first: A hands C a one-time code, C enters it.
    const code = await (A.contacts as NonNullable<typeof A.contacts>).createCode()
    await C.contacts?.redeem(code)
    check(
      await eventually(() => A.contacts?.name(C.accountId) === carol && C.contacts?.name(A.accountId) === alice),
      "A and C become contacts, each knowing the other's name"
    )
    check(
      await eventually(() => B.contacts?.name(C.accountId) === carol),
      "and A's other device knows C too"
    )
    check(
      (await (C.contacts as NonNullable<typeof C.contacts>).redeem(code).then(
        () => 'redeemed',
        () => 'refused'
      )) === 'refused',
      'the code works once'
    )

    await A.vault.userCreate('Together.md', 'a draft nobody else should see\n')
    await delay(400)
    await A.vault.userWrite('Together.md', 'shared text\n')
    check(await eventually(() => A.docText('Together.md') === 'shared text\n'), 'A has Together.md')
    const docId = A.index?.docIdForPath('Together.md') as string
    const room = docRoom(docId)

    await A.sharing?.share(docId, C.accountId, 'write', false)
    check(
      await eventually(() => C.vault.text('Shared/Together.md') === 'shared text\n'),
      'C receives the note in her share folder, without being asked',
      C.vault.paths()
    )
    check(C.vault.paths().join(',') === 'Shared/Together.md', "and nothing else from A's vault", C.vault.paths())

    // A key without the owner's signature is not taken - one a server made up -,
    // and the owner's device can seal the keys of its shares anew, signed.
    {
      const sealedFor = (await A.api.sealedEpochs(room)).members[C.accountId] ?? []
      const epoch = sealedFor[sealedFor.length - 1] as number
      const ownersKey = await (A.keys as InstanceType<typeof KeyRing>).noteKey(docId, epoch)
      const keyOfC = (): Promise<Uint8Array | null> => (C.keys as InstanceType<typeof KeyRing>).noteKey(docId, epoch, { owned: false })
      check(Buffer.from((await keyOfC()) ?? []).equals(Buffer.from(ownersKey ?? [1])), "C opens the key A sealed to her, A's signature on it")
      const madeUp = await seal(C.unlocked?.publicKey as Uint8Array<ArrayBuffer>, randomBytes(32), epochKeyContext(room, epoch))
      await A.api.reseal({ room, keys: { [C.accountId]: { [String(epoch)]: madeUp } } })
      C.keys?.forgetShared(docId)
      check((await keyOfC()) === null, 'a key without the owner’s signature is refused')
      check((await A.sharing?.resealAll([])) === true, "A's device seals the keys of its shares anew")
      C.keys?.forgetShared(docId)
      check(Buffer.from((await keyOfC()) ?? []).equals(Buffer.from(ownersKey ?? [1])), 'and C opens them again')
    }

    // Every frame is signed by its author: a member posing as the owner, or
    // writing without the owner's certificate, is not taken - even by a server that
    // let the frame through.
    {
      const epoch = C.socket?.epochOf(room) ?? 0
      const raw = await (C.keys as InstanceType<typeof KeyRing>).noteKey(docId, epoch, { owned: false })
      const signing = C.unlocked?.signing
      const pushRaw = async (plaintext: Uint8Array<ArrayBuffer>): Promise<void> => {
        const data = await encrypt(await aesKey(raw as Uint8Array<ArrayBuffer>), plaintext, frameAad(room, epoch))
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MUX.push)
        encoding.writeVarString(encoder, room)
        encoding.writeVarUint(encoder, 900_000 + Math.floor(Math.random() * 1_000))
        encoding.writeVarUint(encoder, epoch)
        encoding.writeVarUint8Array(encoder, data)
        ;(C.socket as unknown as { ws: { send(data: Uint8Array): void } }).ws.send(encoding.toUint8Array(encoder))
      }
      const insert = (text: string): Uint8Array => {
        const doc = new Y.Doc()
        doc.getText('content').insert(0, text)
        return Y.encodeStateAsUpdate(doc)
      }
      if (raw && signing) {
        await pushRaw(await packSignedFrame(signing.privateKey, room, epoch, A.accountId, null, Date.now(), insert('POSING AS ALICE ')))
        await pushRaw(await packSignedFrame(signing.privateKey, room, epoch, C.accountId, null, Date.now(), insert('NO CERTIFICATE ')))
        const unsigned = insert('UNSIGNED ')
        const plain = new Uint8Array(9 + unsigned.length)
        plain.set(unsigned, 9)
        await pushRaw(plain)
      }
      check(Boolean(raw && signing), 'C holds the key and her signing key')
      await delay(1_500)
      check(
        !['POSING AS ALICE', 'NO CERTIFICATE', 'UNSIGNED'].some((text) => (A.docText('Together.md') ?? '').includes(text)),
        "a frame signed as someone else, one without the owner's certificate and one without a signature are not taken",
        A.docText('Together.md')
      )
      await C.vault.userWrite('Shared/Together.md', 'shared text\nsigned by carol\n')
      check(
        await eventually(() => A.vault.text('Together.md') === 'shared text\nsigned by carol\n'),
        'while what C writes, signed and certified, still reaches A',
        A.vault.text('Together.md')
      )
      await A.vault.userWrite('Together.md', 'shared text\n')
      check(await eventually(() => C.vault.text('Shared/Together.md') === 'shared text\n'), 'and the note goes on as it was')
    }

    {
      const history = new NoteHistory(C.api, room, (C.keys as InstanceType<typeof KeyRing>).sharedDocCrypto(docId, A.accountId), HISTORY_GAP_MS)
      await history.load()
      const texts = history.versions().map((version) => history.textAt(version.seq))
      check(
        texts.length > 0 && texts.every((text) => !text.includes('draft')),
        'shared without history, C cannot see what the note said before',
        texts
      )
      const own = new NoteHistory(A.api, room, (A.keys as InstanceType<typeof KeyRing>).ownDocCrypto(docId), HISTORY_GAP_MS)
      await own.load()
      check(
        own.versions().some((version) => own.textAt(version.seq).includes('draft')),
        'while A still sees every version'
      )
    }

    // A shared note is a note of her vault like any other: her other devices
    // get it from her index, with the keys sealed to her account.
    const C2 = new Device(carol, false)
    check(await C2.boot(), "C's second device signs in")
    check(
      await eventually(() => C2.vault.text('Shared/Together.md') === 'shared text\n'),
      'and has the shared note too',
      C2.vault.paths()
    )

    const aTogether = A.open('Together.md')
    const cTogether = C.open('Shared/Together.md')
    check(
      await eventually(() => A.editors.boundCount() === 1 && C.editors.boundCount() === 1),
      'both editors bind the shared note'
    )
    aTogether.type('from Alice ')
    check(await eventually(() => cTogether.text() === 'shared text\nfrom Alice '), 'A types, C sees it live')
    check(
      await eventually(() => C2.vault.text('Shared/Together.md') === 'shared text\nfrom Alice '),
      'and so does her second device',
      C2.vault.text('Shared/Together.md')
    )
    await C2.shutdown()
    cTogether.type('and Carol', 0)
    check(
      await eventually(() => aTogether.text() === 'and Carolshared text\nfrom Alice '),
      'C types, A sees it live',
      aTogether.text()
    )
    check(
      await eventually(() => cTogether.view.dom.querySelector('.mycel-remote-caret-label')?.textContent === alice),
      "C sees Alice's cursor"
    )
    check(
      await eventually(() => aTogether.view.dom.querySelector('.mycel-remote-caret-label')?.textContent === carol),
      "A sees Carol's cursor"
    )

    // Typing exactly at someone's caret. On their own screen the caret stays
    // in front of the new text, so that is where everyone else must see it.
    {
      const carolAt = 'and Carol'.length
      const carolOnA = (): number => {
        const caret = aTogether.view.dom.querySelector('.mycel-remote-caret')
        return caret ? aTogether.view.posAtDOM(caret) : -1
      }
      check(await eventually(() => carolOnA() === carolAt), "A sees Carol's caret where she stopped typing", carolOnA())
      aTogether.view.dispatch({ changes: { from: carolAt, insert: 'XYZ' }, userEvent: 'input.type' })
      check(await eventually(() => cTogether.text().startsWith('and CarolXYZ')), 'C gets what A typed at her caret')
      check(cTogether.view.state.selection.main.head === carolAt, "Carol's own caret stays in front of it")
      await delay(300)
      check(carolOnA() === carolAt, 'and A sees it there too, not pushed past the new text', carolOnA())

      // Carets that only move, nobody typing: typing redraws the carets
      // anyway, so the checks above could not tell.
      const aliceOnC = (): number => {
        const caret = cTogether.view.dom.querySelector('.mycel-remote-caret')
        return caret ? cTogether.view.posAtDOM(caret) : -1
      }
      cTogether.view.dispatch({ selection: { anchor: 2 } })
      check(await eventually(() => carolOnA() === 2), "A follows Carol's caret when she only moves it", carolOnA())
      aTogether.view.dispatch({ selection: { anchor: 5 } })
      check(await eventually(() => aliceOnC() === 5), "and Carol follows Alice's", aliceOnC())

      // Alice's other device in the same shared note: Carol's caret, never Alice's own.
      const bTogether = B.open('Together.md')
      const labelsOnB = (): string[] =>
        Array.from(bTogether.view.dom.querySelectorAll('.mycel-remote-caret-label')).map((label) => label.textContent ?? '')
      cTogether.view.dispatch({ selection: { anchor: 3 } })
      aTogether.view.dispatch({ selection: { anchor: 6 } })
      check(await eventually(() => labelsOnB().join() === carol), "Alice's other device shows Carol's caret, not Alice's own", labelsOnB())
      B.close(bTogether)
    }
    check(await eventually(() => B.store?.isShared(docId) === true), "A's other device learns the note is shared")

    // Syncing your own devices never shows a caret.
    const bWelcome = B.open('Welcome.md')
    const aWelcome = A.open('Welcome.md')
    check(
      await eventually(() => A.editors.boundCount() === 2 && B.editors.boundCount() === 2),
      "an unshared note binds on both of A's devices"
    )
    aWelcome.type(' caret?')
    await delay(600)
    check(bWelcome.view.dom.querySelector('.mycel-remote-caret') === null, 'and shows no cursor between them')
    {
      const welcome = await B.store?.handle(A.index?.docIdForPath('Welcome.md') as string)
      check(welcome?.awareness.getLocalState()?.user === undefined, 'nor announces anyone')
    }

    // Read only.
    await A.sharing?.setRole(docId, C.accountId, 'read')
    check(await eventually(() => C.store?.isReadOnly(docId) === true), 'C learns she may only read now')
    check(await eventually(() => cTogether.view.state.readOnly), "and C's editor stops taking input")
    const beforeReading = aTogether.text()
    cTogether.view.dispatch({ changes: { from: 0, insert: 'NOT ALLOWED ' } })
    await delay(600)
    check(aTogether.text() === beforeReading && cTogether.text() === beforeReading, 'nothing C slips in reaches A')
    aTogether.type(' for readers')
    check(await eventually(() => cTogether.text() === `${beforeReading} for readers`), 'while what A writes still reaches C')

    // Revoking: C keeps her copy, as a note of her own, and they part ways.
    C.close(cTogether)
    const endedNotices = (): number => Notice.shown.filter((notice) => notice.startsWith('The share of "Together"')).length
    const endedBefore = endedNotices()
    await A.sharing?.revoke(docId, C.accountId)
    const keptByCarol = `${beforeReading} for readers`
    check(
      await eventually(() => C.store?.entry(C.index?.docIdForPath('Shared/Together.md') ?? '')?.owner === undefined && Boolean(C.index?.docIdForPath('Shared/Together.md'))),
      'after the share is revoked, C has the note as one of her own',
      C.index?.docIdForPath('Shared/Together.md')
    )
    check(C.vault.text('Shared/Together.md') === keptByCarol, 'with everything up to that point', C.vault.text('Shared/Together.md'))
    {
      // The revocation arrives as a message and as a notice. Handling both
      // minted a second copy of the note, which the duplicate merge then
      // folded back - harmless only while both copies are identical.
      await delay(300)
      const everIndexed = [...(C.index?.live() ?? []), ...(C.index?.deleted() ?? [])]
        .filter(({ entry }) => entry.path === 'Shared/Together.md')
        .map(({ docId }) => docId)
      check(everIndexed.length === 2, 'the revoke moves the note once, not once per message', everIndexed)
      check(endedNotices() - endedBefore === 1, 'and says so once', Notice.shown.slice(-4))
    }
    {
      // The copy carries the history C could read - from the share on, never before it.
      const ownId = C.index?.docIdForPath('Shared/Together.md') as string
      const history = new NoteHistory(C.api, docRoom(ownId), (C.keys as InstanceType<typeof KeyRing>).ownDocCrypto(ownId), HISTORY_GAP_MS)
      await history.load()
      const texts = history.versions().map((version) => history.textAt(version.seq))
      check(
        texts.length > 1 && texts.includes('shared text\n') && texts.some((text) => text.includes('from Alice')),
        "C's own copy keeps the history she could read",
        texts
      )
      check(texts.every((text) => !text.includes('draft')), 'and nothing from before the share', texts)
      check((await C.api.forks()).forks.length === 0, 'the server lets go of what it kept for her')
    }
    aTogether.type(' after revoke')
    await C.vault.userWrite('Shared/Together.md', `${keptByCarol}\nCarol's own line`)
    await delay(1_200)
    check(!C.vault.text('Shared/Together.md')?.includes('after revoke'), 'what A writes afterwards no longer reaches C')
    check(!aTogether.text().includes("Carol's own line"), "and C's copy no longer reaches A")

    // C's second device was away through all of it.
    check(await C2.boot(), "C's second device comes back")
    check(
      await eventually(
        () =>
          C2.index?.docIdForPath('Shared/Together.md') === C.index?.docIdForPath('Shared/Together.md') &&
          C2.vault.text('Shared/Together.md') === `${keptByCarol}\nCarol's own line`
      ),
      'and carries on in the same note of her own, with what she wrote since',
      { c2: C2.vault.text('Shared/Together.md'), c: C.vault.text('Shared/Together.md') }
    )
    await C2.shutdown()

    // History, restored on the client.
    A.close(aTogether)
    await delay(300)
    {
      const history = new NoteHistory(A.api, room, (A.keys as InstanceType<typeof KeyRing>).ownDocCrypto(docId), HISTORY_GAP_MS)
      await history.load()
      const draft = history.versions().find((version) => history.textAt(version.seq).includes('draft'))
      check(Boolean(draft), 'A finds the draft in the history')
      const said = A.docText('Together.md') ?? ''
      const backupsBefore = new Set(A.vault.adapter.backups())
      if (draft) await A.store?.restore(docId, history.textAt(draft.seq))
      const added = A.vault.adapter.backups().filter((path) => !backupsBefore.has(path))
      check(
        added.length === 1 && (await A.vault.adapter.read(added[0] as string)) === said,
        'what the note said goes into a backup before it is restored',
        added
      )
      check(
        await eventually(() => A.vault.text('Together.md') === 'a draft nobody else should see\n' && B.vault.text('Together.md') === 'a draft nobody else should see\n'),
        'restoring it reaches the file and the other device',
        { a: A.vault.text('Together.md'), b: B.vault.text('Together.md') }
      )
    }

    // Compaction: the owner folds old history into a snapshot, and the note
    // still reads the same everywhere.
    A.retentionDays = 1e-9
    const compacted = (await A.compactor?.run()) ?? 0
    check(compacted > 0, 'the owner compacts old history', compacted)
    {
      const history = new NoteHistory(A.api, room, (A.keys as InstanceType<typeof KeyRing>).ownDocCrypto(docId), HISTORY_GAP_MS)
      await history.load()
      const latest = history.versions()[0]
      check(Boolean(latest) && history.textAt(latest?.seq ?? 0) === 'a draft nobody else should see\n', 'the history still ends in the current text')
    }
    await B.shutdown()
    check(await B.boot(), 'B restarts after compaction')
    check(
      await eventually(() => B.vault.text('Together.md') === 'a draft nobody else should see\n' && B.vault.text('Archive/Plan.md') === A.vault.text('Archive/Plan.md')),
      'and still has every note right'
    )
    // B stood exactly where the history was folded: the snapshot ends at its
    // last frame. That is compaction, not a server that lost data.
    {
      const held = (): string[] =>
        [indexRoom(B.keys?.vaultId ?? ''), ...(B.index?.live() ?? []).map(({ docId }) => docRoom(docId))].filter((room) =>
          B.socket?.isHeld(room)
        )
      await delay(1_000)
      check(held().length === 0 && B.asked === 0, 'and is not taken for a device that met a server restored from a backup', held())
    }

    // Detaching: C keeps a note A shares with her, as her own, and leaves the share.
    await A.vault.userCreate('Handout.md', 'handout v1\n')
    check(await eventually(() => A.docText('Handout.md') === 'handout v1\n'), 'A writes a handout')
    const handoutId = A.index?.docIdForPath('Handout.md') as string
    await A.sharing?.share(handoutId, C.accountId, 'read', true)
    check(await eventually(() => C.vault.text('Shared/Handout.md') === 'handout v1\n'), 'and shares it with C to read')
    await C.sharing?.detach(handoutId)
    {
      const own = C.index?.docIdForPath('Shared/Handout.md') as string
      check(
        Boolean(own) && own !== handoutId && C.store?.entry(own)?.owner === undefined && C.store?.isReadOnly(own) === false,
        'C detaches it: a note of her own, which she may edit',
        C.store?.entry(own)
      )
    }
    check((await A.sharing?.members(handoutId))?.members.length === 0, 'and A sees her gone')
    check(
      await eventually(() => A.store?.isShared(handoutId) === false && B.store?.isShared(handoutId) === false),
      "A's note is no longer treated as shared - no carets between A's own devices",
      { a: A.store?.isShared(handoutId), b: B.store?.isShared(handoutId) }
    )
    await C.vault.userWrite('Shared/Handout.md', "handout v1\nCarol's notes\n")
    await A.vault.userWrite('Handout.md', 'handout v2\n')
    await delay(1_000)
    check(
      A.vault.text('Handout.md') === 'handout v2\n' && C.vault.text('Shared/Handout.md') === "handout v1\nCarol's notes\n",
      'and the two go their own ways',
      { a: A.vault.text('Handout.md'), c: C.vault.text('Shared/Handout.md') }
    )

    // --- the files a shared note embeds ---------------------------------------------
    {
      const diagram = binary(53, 2_000)
      await A.vault.userCreateBinary('Assets/diagram.png', diagram)
      await A.vault.userCreate('Board.md', 'see ![[diagram.png]]\n')
      check(
        await eventually(() => Boolean(A.attachmentIndex?.idForPath('Assets/diagram.png')) && A.docText('Board.md') === 'see ![[diagram.png]]\n'),
        'A has a note that embeds a picture'
      )
      check(
        await eventually(() => A.attachments?.fileState(A.vault.file('Assets/diagram.png') as never) === 'synced'),
        "the picture's cloud says it is synced",
        A.attachments?.fileState(A.vault.file('Assets/diagram.png') as never)
      )
      const boardId = A.index?.docIdForPath('Board.md') as string
      await A.sharing?.share(boardId, C.accountId, 'write', true, true)
      check(await eventually(() => C.vault.text('Shared/Board.md') === 'see ![[diagram.png]]\n'), 'C receives a note shared with its files')
      check(
        await eventually(() => same(C.vault.bytes('Shared/Attachments/diagram.png'), diagram), 15_000),
        "and the picture it embeds, in her share folder's Attachments",
        C.vault.attachmentPaths()
      )
      {
        const id = C.attachmentIndex?.idForPath('Shared/Attachments/diagram.png') ?? ''
        check(C.attachmentIndex?.entry(id)?.via?.ref === 'diagram.png', 'as a file of her own vault, one that came in through the note')
      }

      // C draws on it: A's original follows, on both of A's devices.
      const drawn = binary(59, 2_100)
      await C.vault.userWriteBinary('Shared/Attachments/diagram.png', drawn)
      check(
        C.attachments?.fileState(C.vault.file('Shared/Attachments/diagram.png') as never) === 'unsent',
        'a picture changed a moment ago is not synced yet'
      )
      check(
        await eventually(() => same(A.vault.bytes('Assets/diagram.png'), drawn) && same(B.vault.bytes('Assets/diagram.png'), drawn), 15_000),
        "C's change to the picture reaches A's own file, on every device of A"
      )
      check(!A.vault.attachmentPaths().some((path) => path.startsWith('Shared/Attachments/diagram')), 'and A gets no second copy of it')

      // C adds a picture of her own to the note.
      const sketch = binary(61, 1_800)
      await C.vault.userCreateBinary('Carol/sketch.png', sketch)
      await delay(400)
      await C.vault.userWrite('Shared/Board.md', 'see ![[diagram.png]]\nand ![[sketch.png]]\n')
      check(
        await eventually(() => same(A.vault.bytes('Shared/Attachments/sketch.png'), sketch), 15_000),
        "a picture C adds reaches A, in A's share folder's Attachments",
        A.vault.attachmentPaths()
      )

      // A deletes the picture C added: A leaves that file, for good.
      await A.vault.trash(A.vault.file('Shared/Attachments/sketch.png'))
      check(await eventually(() => B.vault.bytes('Shared/Attachments/sketch.png') === undefined), "it goes from A's other device too")
      await delay(500)
      const redrawn = binary(67, 1_900)
      await C.vault.userWriteBinary('Carol/sketch.png', redrawn)
      check(await eventually(() => C.attachmentIndex?.entry(C.attachmentIndex.idForPath('Carol/sketch.png') ?? '')?.size === redrawn.length), 'C changes her picture')
      await delay(2_500)
      check(
        A.vault.bytes('Shared/Attachments/sketch.png') === undefined && B.vault.bytes('Shared/Attachments/sketch.png') === undefined,
        'deleting a file a shared note brings is leaving it: it does not come back to A, even changed',
        A.vault.attachmentPaths()
      )
      check(same(C.vault.bytes('Carol/sketch.png'), redrawn), 'while C keeps hers')

      // Both change the picture at once, neither seeing the other's change.
      {
        const listedHash = async (device: Device): Promise<string | undefined> =>
          ((await device.store?.handle(boardId))?.doc.getMap('attachments').get('diagram.png') as { hash?: string } | undefined)?.hash
        await delay(500)
        const holdA = holdPushes(A, 'doc:')
        const holdC = holdPushes(C, 'doc:')
        const byA = binary(73, 2_300)
        const byC = binary(79, 2_400)
        await A.vault.userWriteBinary('Assets/diagram.png', byA)
        await C.vault.userWriteBinary('Shared/Attachments/diagram.png', byC)
        const [hashA, hashC] = [await contentHash(byA), await contentHash(byC)]
        check(
          await eventually(async () => (await listedHash(A)) === hashA && (await listedHash(C)) === hashC, 15_000),
          'both put their version into the note, unseen by the other'
        )
        holdA()
        holdC()
        const versions = (device: Device, prefix: string): Uint8Array[] =>
          device.vault
            .attachmentPaths()
            .filter((path) => path.startsWith(prefix))
            .map((path) => device.vault.bytes(path) as Uint8Array)
        check(
          await eventually(() => {
            const all = [...versions(A, 'Assets/diagram'), ...versions(C, 'Shared/Attachments/diagram')]
            return (
              same(A.vault.bytes('Assets/diagram.png'), C.vault.bytes('Shared/Attachments/diagram.png')) &&
              all.some((data) => same(data, byA)) &&
              all.some((data) => same(data, byC))
            )
          }, 20_000),
          'two people changing a picture at once end with the same file, the other version kept as a second one',
          { a: A.vault.attachmentPaths(), c: C.vault.attachmentPaths() }
        )
        check(
          !B.vault.attachmentPaths().some((path) => path.startsWith('Shared/Attachments/diagram')),
          "and A's other device, which saw A's change before the note, brings in no copy of its own",
          B.vault.attachmentPaths()
        )
      }

      // Read only: what C changes stays with her.
      await A.sharing?.setRole(boardId, C.accountId, 'read')
      check(await eventually(() => C.store?.isReadOnly(boardId) === true), 'C may only read the note now')
      const ownersCopy = A.vault.bytes('Assets/diagram.png')
      await C.vault.userWriteBinary('Shared/Attachments/diagram.png', binary(71, 2_200))
      await delay(2_500)
      check(same(A.vault.bytes('Assets/diagram.png'), ownersCopy), "a reader's change to a picture does not reach the owner")
      await A.sharing?.setRole(boardId, C.accountId, 'write')
    }

    // --- sharing the notes a note links to ------------------------------------------
    {
      check(
        landingTitle('../Projects/./Plan.md') === 'Projects/Plan' && landingTitle('/Top') === 'Top',
        'a link path lands below the share folder, never above it'
      )
      const hubText = 'start at [[Ideas/Roadmap]], see [[Board]]\n'
      const roadmapText = 'roadmap: [[Todo]], back to [[Hub]]\n'
      await A.vault.userCreate('Ideas/Roadmap.md', roadmapText)
      await A.vault.userCreate('Todo.md', 'todo\n')
      await A.vault.userCreate('Hub.md', hubText)
      check(
        await eventually(() => A.docText('Hub.md') === hubText && A.docText('Ideas/Roadmap.md') === roadmapText && A.docText('Todo.md') === 'todo\n'),
        'A writes a note that links to others, which link on'
      )
      const hubId = A.index?.docIdForPath('Hub.md') as string
      const boardId = A.index?.docIdForPath('Board.md') as string
      const linked = linkedNotes(A.metadataCache as never, A.store as never, A.vault.file('Hub.md') as never, (account) => account)
      check(
        JSON.stringify(linked.map((note) => [note.path, note.title, Boolean(note.docId)])) ===
          JSON.stringify([
            ['Ideas/Roadmap.md', 'Ideas/Roadmap', true],
            ['Board.md', 'Board', true],
            ['Todo.md', 'Todo', true]
          ]),
        'the share dialog lists the notes it links to and theirs in turn, each once, with the path of its link',
        linked
      )

      await A.sharing?.share(hubId, C.accountId, 'read', false, true)
      const outcome = await A.sharing?.shareLinked(linked, C.accountId, 'read', false, true)
      check(outcome?.shared === 2 && outcome.had === 1 && outcome.failed === 0, 'A shares them along with it, all but the one C has', outcome)
      check(
        await eventually(
          () =>
            C.vault.text('Shared/Hub.md') === hubText &&
            C.vault.text('Shared/Ideas/Roadmap.md') === roadmapText &&
            C.vault.text('Shared/Todo.md') === 'todo\n',
          15_000
        ),
        'C receives them below her share folder at the paths of their links, so the links between them resolve',
        C.vault.getMarkdownFiles().map((file) => file.path)
      )
      check(
        !C.vault.text('Shared/Ideas/Roadmap 2.md') && !C.vault.text('Shared/Todo 2.md') && !C.vault.text('Shared/Hub 2.md'),
        'each once, though the server announced them one by one'
      )
      const roadmapId = C.index?.docIdForPath('Shared/Ideas/Roadmap.md') as string
      check(C.store?.isReadOnly(roadmapId) === true, 'with the access chosen for the note that links to them')
      check((await A.sharing?.attachmentsShared(A.index?.docIdForPath('Ideas/Roadmap.md') as string)) === true, 'and its choice about files')
      check(
        (await A.sharing?.members(boardId))?.members.find((member) => member.account === C.accountId)?.role === 'write' &&
          C.store?.isReadOnly(boardId) === false &&
          !C.vault.text('Shared/Board 2.md'),
        'the note C had already keeps her access and its place'
      )
    }

    // Removing a contact ends what the two share; each keeps what they have.
    await A.vault.userCreate('Parting.md', 'shared before parting\n')
    check(await eventually(() => A.docText('Parting.md') === 'shared before parting\n'), 'A writes one more note')
    const partingId = A.index?.docIdForPath('Parting.md') as string
    await A.sharing?.share(partingId, C.accountId, 'write', true)
    check(await eventually(() => C.vault.text('Shared/Parting.md') === 'shared before parting\n'), 'and shares it with C')
    // C's next edit never reaches the server: it is still waiting to be sent
    // when the share ends.
    const socket = (C.socket as unknown as { ws: { send(data: Uint8Array): void; close(): void } }).ws
    const send = socket.send.bind(socket)
    const PUSH = 3
    socket.send = (data: Uint8Array) => {
      if (data[0] !== PUSH) send(data)
    }
    const unsent = 'shared before parting\nnever sent by Carol\n'
    // Apart from A's text by more than the history's gap, so it is a version of its own.
    await delay(HISTORY_GAP_MS * 2)
    await C.vault.userWrite('Shared/Parting.md', unsent)
    check(await eventually(() => C.docText('Shared/Parting.md') === unsent), 'C edits it, and the edit waits to be sent')
    await A.sharing?.endWith(C.accountId)
    await A.contacts?.remove(C.accountId)
    check(await eventually(() => C.contacts?.isContact(A.accountId) === false), 'removing a contact reaches the other side')
    check(
      await eventually(() => {
        const id = C.index?.docIdForPath('Shared/Parting.md')
        return Boolean(id) && C.store?.entry(id as string)?.owner === undefined
      }),
      'and ends the share, C keeping her copy as a note of her own'
    )
    socket.send = send
    socket.close()
    check(await eventually(() => C.vault.text('Shared/Parting.md') === unsent), 'with the edit that never reached A', C.vault.text('Shared/Parting.md'))
    {
      const id = C.index?.docIdForPath('Shared/Parting.md') as string
      const history = new NoteHistory(C.api, docRoom(id), (C.keys as InstanceType<typeof KeyRing>).ownDocCrypto(id), HISTORY_GAP_MS)
      await history.load()
      const latest = history.versions()[0]
      check(
        Boolean(latest) && history.textAt(latest?.seq ?? 0) === unsent && history.versions().some((version) => history.textAt(version.seq) === 'shared before parting\n'),
        'which her own note on the server holds, after the history she could read',
        history.versions().map((version) => history.textAt(version.seq))
      )
    }
    check(A.vault.text('Parting.md') === 'shared before parting\n', 'while A never sees it')
    const again = await A.sharing?.share(partingId, C.accountId, 'write', true).then(
      () => 'shared',
      () => 'refused'
    )
    check(again === 'refused', 'and nothing more is shared with a former contact')
  } finally {
    await C.shutdown()
  }

  // --- the same existing vault on two devices, both starting at once ----------------
  // Notes that were there before the plugin: each device seeds the note's
  // document from its file. Started at the same moment, both see an empty
  // document and both seed it.
  {
    const erin = `erin${run}`
    const files = { 'Existing/One.md': 'a note from before the plugin\n', 'Existing/Two.md': 'another\none\n' }
    const E0 = new Device(erin, true)
    check(await E0.boot(), 'E0 creates the account')
    await E0.shutdown()
    const E1 = new Device(erin, false, files)
    const E2 = new Device(erin, false, files)
    try {
      const started = await Promise.all([E1.boot(), E2.boot()])
      check(started.every(Boolean), 'two devices with the same notes start at the same moment')
      await delay(1_500)
      const texts = Object.keys(files).map((path) => ({ path, e1: E1.vault.text(path), e2: E2.vault.text(path), doc: E1.docText(path) }))
      check(
        texts.every(({ path, e1, e2, doc }) => e1 === files[path as keyof typeof files] && e2 === e1 && doc === e1),
        'and every note is there once, on both',
        texts
      )

      // The same seed again, into a document that held it and was emptied
      // since: Yjs takes it for known and does nothing, so the device has to
      // insert its text itself - or its file was emptied, without a backup.
      const note = files['Existing/One.md']
      await E1.vault.userWrite('Existing/One.md', '')
      check(await eventually(() => E2.vault.text('Existing/One.md') === ''), 'E1 empties a note, E2 follows')
      const E3 = new Device(erin, false, { 'Existing/One.md': note })
      try {
        check(await E3.boot(), 'a device with an old copy of it starts')
        await delay(800)
        check(E3.vault.text('Existing/One.md') === note, 'and keeps its text', E3.vault.text('Existing/One.md'))
        check(await eventually(() => E1.vault.text('Existing/One.md') === note), 'which comes back everywhere, as without a base it must')
      } finally {
        await E3.shutdown()
      }

      // The other way round: a device that had agreed on a note's text, while
      // it was emptied on purpose elsewhere. An empty document with history is
      // not a new note - seeding it again brought the text back.
      await E2.shutdown()
      await E1.vault.userWrite('Existing/Two.md', '')
      check(await eventually(() => E1.docText('Existing/Two.md') === ''), 'E1 empties a note while E2 is away')
      const backupsBefore = E2.vault.adapter.backups().length
      check(await E2.boot(), 'E2 comes back')
      check(
        await eventually(() => E2.vault.text('Existing/Two.md') === ''),
        'and its copy follows the emptied note',
        E2.vault.text('Existing/Two.md')
      )
      check(E2.vault.adapter.backups().length > backupsBefore, 'keeping a backup of the text it had')
      await delay(600)
      check(E1.vault.text('Existing/Two.md') === '', 'and the text does not come back to E1', E1.vault.text('Existing/Two.md'))
    } finally {
      await E1.shutdown()
      await E2.shutdown()
    }
  }

  // --- every note live, with a limit on the notes held open (0.9.2, docs/PHASE8.md L) ---------
  {
    const liam = `liam${run}`
    const notes: Record<string, string> = Object.fromEntries(Array.from({ length: 5 }, (_value, index) => [`Live/N${index}.md`, `note ${index}\n`]))
    const paths = Object.keys(notes)
    const L1 = new Device(liam, true, notes)
    const L2 = new Device(liam, false)
    L2.maxLoaded = 2
    let most = 0
    const sampler = setInterval(() => {
      most = Math.max(most, L2.store?.loadedCount() ?? 0)
    }, 20)
    try {
      check(await L1.boot(), 'L1 starts with five notes')
      check(await L2.boot(), 'a device holding two notes open at most starts')
      check(await eventually(() => paths.every((path) => L2.vault.text(path) === notes[path]), 15_000), 'and has all five', L2.vault.paths())
      check(await eventually(() => (L2.store?.loadedCount() ?? 99) <= 2), 'holding no more than two of them open', L2.store?.loadedCount())

      most = 0
      for (const path of paths) await L1.vault.userWrite(path, `${notes[path]}changed on L1\n`)
      check(
        await eventually(() => paths.every((path) => L2.vault.text(path) === `${notes[path]}changed on L1\n`), 20_000),
        'another device changes all five: every change reaches the files - the notes let go too, not only when opened',
        paths.map((path) => L2.vault.text(path))
      )
      check(most <= 2 + 8, 'with no more than the limit open, and those being caught up', most)
      check(await eventually(() => (L2.store?.loadedCount() ?? 99) <= 2), 'and lets them go again')
      {
        const states = paths.map((path) => L2.store?.noteState(L2.vault.file(path) as never))
        check(states.every((state) => state === 'synced'), "every note's cloud says synced, open or not", states)
      }

      // A change the server has not acknowledged keeps its note open.
      const first = L2.index?.docIdForPath(paths[0] as string) as string
      await L2.store?.handle(first)
      const release = holdPushes(L2, 'doc:')
      await L2.vault.userWrite(paths[0] as string, `${notes[paths[0] as string]}changed on L1\nunsent on L2\n`)
      await delay(400)
      for (const path of paths.slice(1)) await L2.store?.handle(L2.index?.docIdForPath(path) as string)
      await delay(300)
      check(L2.store?.isLoaded(first) === true, 'a note whose change the server has not acknowledged is not let go')
      release()
      check(
        await eventually(() => L1.vault.text(paths[0] as string) === `${notes[paths[0] as string]}changed on L1\nunsent on L2\n`, 15_000),
        'and its change goes out once the connection is back'
      )

      // Changes made while the connection was down, to notes let go before.
      check(await eventually(() => (L2.store?.loadedCount() ?? 99) <= 2), 'L2 holds two notes again')
      const socket = L2.socket as unknown as { connect(): void; reconnect(): void; ws: { close(): void } | null }
      const connect = socket.connect.bind(socket)
      socket.connect = () => undefined
      socket.ws?.close()
      const away = paths.filter((path) => !L2.store?.isLoaded(L2.index?.docIdForPath(path) as string))
      for (const path of away) await L1.vault.userWrite(path, `written while L2 was away: ${path}\n`)
      await delay(1_500)
      socket.connect = connect
      socket.reconnect()
      check(
        await eventually(() => away.every((path) => L2.vault.text(path) === `written while L2 was away: ${path}\n`), 20_000),
        'changes made while the connection was down reach the notes let go before it, once it is back',
        away.map((path) => L2.vault.text(path))
      )
    } finally {
      clearInterval(sampler)
      await L1.shutdown()
      await L2.shutdown()
    }
  }
} catch (error) {
  check(false, 'the scenario ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  await A.shutdown()
  await B.shutdown()
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
