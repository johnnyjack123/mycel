// Three devices of one person, and a second person, against a running server,
// end-to-end encrypted. Everything real except Obsidian itself: accounts and
// keys, the DocStore, the editor binding in real CodeMirror editors, the
// socket, the server. The vault and the Markdown view are fakes that save and
// reload the way Obsidian does, because that interplay is what doubled text
// before.
//
//   PORT=1235 OBSIDIAN_CONNECT_REGISTRATION=open OBSIDIAN_CONNECT_DATA_DIR=<scratch> npm run start:server
//   npm run test:vault -- ws://localhost:1235
import { check, delay, Device, eventually, failures, useServer } from './harness.mjs'

// Imported after the harness set up the DOM; CodeMirror reads it at module scope.
const { Notice } = await import('obsidian')
const { docRoom } = await import('@obsidian-connect/shared')
const { KeyRing } = await import('../src/account/KeyRing.js')
const { NoteHistory } = await import('../src/history/NoteHistory.js')

const serverUrl = process.argv[2] ?? process.env.OBSIDIAN_CONNECT_URL ?? 'ws://localhost:1234'
useServer(serverUrl)
const run = Date.now().toString(36)

const alice = `alice${run}`
const carol = `carol${run}`
console.log(`server=${serverUrl} accounts=${alice},${carol}`)

const A = new Device(alice, true, {
  'Welcome.md': 'Hello from A\n',
  'Projects/Plan.md': 'step 1\nstep 2\n'
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

    {
      const history = new NoteHistory(C.api, room, (C.keys as InstanceType<typeof KeyRing>).sharedDocCrypto(docId), HISTORY_GAP_MS)
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
      await eventually(() => cTogether.view.dom.querySelector('.connect-remote-caret-label')?.textContent === alice),
      "C sees Alice's cursor"
    )
    check(
      await eventually(() => aTogether.view.dom.querySelector('.connect-remote-caret-label')?.textContent === carol),
      "A sees Carol's cursor"
    )

    // Typing exactly at someone's caret. On their own screen the caret stays
    // in front of the new text, so that is where everyone else must see it.
    {
      const carolAt = 'and Carol'.length
      const carolOnA = (): number => {
        const caret = aTogether.view.dom.querySelector('.connect-remote-caret')
        return caret ? aTogether.view.posAtDOM(caret) : -1
      }
      check(await eventually(() => carolOnA() === carolAt), "A sees Carol's caret where she stopped typing", carolOnA())
      aTogether.view.dispatch({ changes: { from: carolAt, insert: 'XYZ' }, userEvent: 'input.type' })
      check(await eventually(() => cTogether.text().startsWith('and CarolXYZ')), 'C gets what A typed at her caret')
      check(cTogether.view.state.selection.main.head === carolAt, "Carol's own caret stays in front of it")
      await delay(300)
      check(carolOnA() === carolAt, 'and A sees it there too, not pushed past the new text', carolOnA())
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
    check(bWelcome.view.dom.querySelector('.connect-remote-caret') === null, 'and shows no cursor between them')
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
    }
    aTogether.type(' after revoke')
    await C.vault.userWrite('Shared/Together.md', `${keptByCarol}\nCarol's own line`)
    await delay(1_200)
    check(!C.vault.text('Shared/Together.md')?.includes('after revoke'), 'what A writes afterwards no longer reaches C')
    check(!aTogether.text().includes("Carol's own line"), "and C's copy no longer reaches A")

    // History, restored on the client.
    A.close(aTogether)
    await delay(300)
    {
      const history = new NoteHistory(A.api, room, (A.keys as InstanceType<typeof KeyRing>).ownDocCrypto(docId), HISTORY_GAP_MS)
      await history.load()
      const draft = history.versions().find((version) => history.textAt(version.seq).includes('draft'))
      check(Boolean(draft), 'A finds the draft in the history')
      if (draft) await A.store?.restore(docId, history.textAt(draft.seq))
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

    // Removing a contact ends what the two share; each keeps what they have.
    await A.vault.userCreate('Parting.md', 'shared before parting\n')
    check(await eventually(() => A.docText('Parting.md') === 'shared before parting\n'), 'A writes one more note')
    const partingId = A.index?.docIdForPath('Parting.md') as string
    await A.sharing?.share(partingId, C.accountId, 'write', true)
    check(await eventually(() => C.vault.text('Shared/Parting.md') === 'shared before parting\n'), 'and shares it with C')
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
    check(C.vault.text('Shared/Parting.md') === 'shared before parting\n', 'text and all')
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
} catch (error) {
  check(false, 'the scenario ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  await A.shutdown()
  await B.shutdown()
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
