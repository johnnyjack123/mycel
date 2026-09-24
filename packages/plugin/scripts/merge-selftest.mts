// Unit checks for the code paths that can lose a user's text or expose it: the
// merge logic and the encryption; and asking a server whether it can be used.
// No server, no DOM, no Obsidian.
//
//   npm run test:merge -w @obsidian-connect/plugin
import * as Y from 'yjs'
import {
  API,
  CONTENT_FIELD,
  PROTOCOL_VERSION,
  applyTextEdits,
  splitLines,
  textEdits,
  threeWayMerge
} from '@obsidian-connect/shared'
import * as e2e from '@obsidian-connect/shared/crypto'
import { hashWasmArgon2id } from '../src/account/argon2.js'
import { additiveEdits, reconcile } from '../src/sync/Reconciler.js'

const failures: string[] = []

function check(ok: boolean, label: string, detail?: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`)
  if (!ok) {
    failures.push(label)
    if (detail !== undefined) console.log('      got:', JSON.stringify(detail))
  }
}

function applyToText(source: string, target: string): string {
  const doc = new Y.Doc()
  const ytext = doc.getText(CONTENT_FIELD)
  ytext.insert(0, source)
  doc.transact(() => applyTextEdits(ytext, textEdits(source, target)))
  const result = ytext.toString()
  doc.destroy()
  return result
}

// --- textEdits ---------------------------------------------------------------

check(textEdits('same', 'same').length === 0, 'identical text produces no edits')
check(applyToText('', 'hello') === 'hello', 'edits can fill an empty document')
check(applyToText('hello', '') === '', 'edits can empty a document')
check(
  applyToText('line1\nline2\nline3\n', 'line1\nline2\nline3\n') === 'line1\nline2\nline3\n',
  'unchanged multi-line text survives'
)
check(
  applyToText('a\nb\nc\n', 'a\nb\nX\nc\n') === 'a\nb\nX\nc\n',
  'inserting a line in the middle'
)
check(applyToText('a\nb\nc\n', 'a\nc\n') === 'a\nc\n', 'deleting a line in the middle')

// The scenario the user asked about: a blank line inserted offline must not
// make everything below it look new.
{
  const before = 'alpha\nbravo\ncharlie\ndelta\n'
  const after = 'alpha\nbravo\n\ncharlie\ndelta\n'
  const edits = textEdits(before, after)
  const touched = edits.reduce((sum, edit) => sum + (edit.to - edit.from) + edit.insert.length, 0)
  check(applyToText(before, after) === after, 'blank line inserted mid-document')
  check(touched <= 2, 'a blank line touches one character, not the rest of the note', edits)
}

// Yjs must see a minimal edit, so a concurrent change further down survives.
{
  const doc = new Y.Doc()
  const ytext = doc.getText(CONTENT_FIELD)
  ytext.insert(0, 'alpha\nbravo\ncharlie\n')
  const remote = new Y.Doc()
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc))
  const remoteText = remote.getText(CONTENT_FIELD)

  // One side adds a blank line near the top, the other edits the last line.
  doc.transact(() => applyTextEdits(ytext, textEdits(ytext.toString(), 'alpha\n\nbravo\ncharlie\n')))
  remote.transact(() => remoteText.insert(remoteText.toString().indexOf('charlie') + 7, ' EDITED'))

  Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote))
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc))
  check(ytext.toString() === remoteText.toString(), 'both sides converge')
  check(ytext.toString().includes('EDITED'), 'a concurrent edit below the insertion survives')
  check(ytext.toString().includes('alpha\n\nbravo'), 'the inserted blank line survives')
  check(
    (ytext.toString().match(/charlie/g) ?? []).length === 1,
    'nothing was duplicated',
    ytext.toString()
  )
  doc.destroy()
  remote.destroy()
}

// --- threeWayMerge -----------------------------------------------------------

{
  const base = 'one\ntwo\nthree\n'
  const local = 'one\ntwo\nthree\nfour\n'
  const remote = 'zero\none\ntwo\nthree\n'
  const merged = threeWayMerge(base, local, remote)
  check(merged.conflicts === 0, 'edits in different places do not conflict')
  check(merged.text === 'zero\none\ntwo\nthree\nfour\n', 'both edits are kept', merged.text)
}

{
  const base = 'one\ntwo\nthree\n'
  const merged = threeWayMerge(base, 'one\nLOCAL\nthree\n', 'one\nREMOTE\nthree\n')
  check(merged.conflicts === 1, 'edits to the same line conflict')
  check(merged.text.includes('LOCAL') && merged.text.includes('REMOTE'), 'both versions are kept')
}

{
  // A deletion on one side, an untouched document on the other.
  const base = 'one\ntwo\nthree\n'
  const merged = threeWayMerge(base, 'one\nthree\n', base)
  check(merged.text === 'one\nthree\n', 'a local deletion is honoured when remote did not change')
}

{
  // The regression that started all of this: both sides edited while
  // disconnected, nothing may be silently dropped.
  const base = 'shared\n'
  const merged = threeWayMerge(base, 'shared\nfrom device A\n', 'shared\nfrom device B\n')
  check(
    merged.text.includes('from device A') && merged.text.includes('from device B'),
    'offline edits on two devices both survive',
    merged.text
  )
}

// --- reconcile ---------------------------------------------------------------

check(reconcile({ base: 'x', local: 'x', remote: 'x', markers: true }).kind === 'agree', 'agree')
check(
  reconcile({ base: null, local: 'note', remote: '', markers: true }).kind === 'seed',
  'an empty document is seeded'
)
check(
  reconcile({ base: 'x', local: 'x', remote: 'y', markers: true }).kind === 'adopt-remote',
  'an untouched file adopts the document'
)
check(
  reconcile({ base: 'x', local: 'y', remote: 'x', markers: true }).kind === 'adopt-local',
  'an untouched document adopts the file'
)

{
  // Without a base the reconcile must never delete: "missing here" and "added
  // there" are indistinguishable.
  const outcome = reconcile({
    base: null,
    local: 'kept\nlocal only\n',
    remote: 'kept\nremote only\n',
    markers: true
  })
  check(outcome.kind === 'merge', 'no base still merges')
  if (outcome.kind === 'merge') {
    check(outcome.additiveOnly, 'the merge is flagged as additive')
    check(
      outcome.text.includes('local only') && outcome.text.includes('remote only'),
      'both sides survive without a base',
      outcome.text
    )
  }
  check(
    additiveEdits('kept\nremote only\n', 'kept\nlocal only\n').every((edit) => edit.to === edit.from),
    'additive edits never delete'
  )
}

// --- document identity -------------------------------------------------------

{
  const { stableDocId } = await import('../src/sync/VaultIndex.js')
  const { matchesGlob } = await import('../src/sync/glob.js')

  // Two devices adopting the same note before either has seen the other's
  // index must arrive at the same id. Random ids per device produced two
  // documents for one file, and both sides then synced past each other.
  const a = await stableDocId('vault-1', 'Notes/Test.md')
  const b = await stableDocId('vault-1', 'Notes/Test.md')
  check(a === b, 'the same vault and path always give the same document id')
  check(a.length === 32, 'the document id is a 128-bit hex string', a)
  check(
    (await stableDocId('vault-1', 'Notes/Other.md')) !== a,
    'different paths give different ids'
  )
  check((await stableDocId('vault-2', 'Notes/Test.md')) !== a, 'different vaults give different ids')
  check(
    (await stableDocId('vault-1', 'Notes/Test.md', 0)) === a,
    'generation 0 keeps the ids existing notes already have'
  )
  check(
    (await stableDocId('vault-1', 'Notes/Test.md', 1)) !== a &&
      (await stableDocId('vault-1', 'Notes/Test.md', 1)) === (await stableDocId('vault-1', 'Notes/Test.md', 1)),
    'a later generation is a different id, and still derived'
  )

  // A new note at a path whose id is taken - by a renamed or a deleted note -
  // gets a document of its own, the same one on every device.
  {
    const { VaultIndex } = await import('../src/sync/VaultIndex.js')
    const index = new VaultIndex('vault-1')
    const first = await index.ensure('Untitled.md')
    index.rename(first, 'Renamed.md')
    const second = await index.ensure('Untitled.md')
    check(second !== first, 'a new note does not take the id of a renamed one')
    index.markDeleted(second)
    const third = await index.ensure('Untitled.md')
    check(third !== first && third !== second, 'nor the id of a deleted one')
    const other = new VaultIndex('vault-1')
    other.adopt(first, 'Renamed.md')
    other.markDeleted((await other.ensure('Untitled.md')) as string)
    check((await other.ensure('Untitled.md')) === third, 'and another device with the same index derives the same id')
    index.destroy()
    other.destroy()
  }

  check(matchesGlob('Private/Secret.md', 'Private/**'), 'glob: ** matches across segments')
  check(matchesGlob('Notes/a.md', 'Notes/*.md'), 'glob: * matches inside a segment')
  check(!matchesGlob('Notes/sub/a.md', 'Notes/*.md'), 'glob: * does not cross a separator')
  check(!matchesGlob('Public/Secret.md', 'Private/**'), 'glob: unrelated paths do not match')
}

// --- splitLines --------------------------------------------------------------

check(splitLines('a\nb').join('') === 'a\nb', 'splitLines round-trips without a trailing newline')
check(splitLines('a\nb\n').join('') === 'a\nb\n', 'splitLines round-trips with a trailing newline')
check(splitLines('').length === 0, 'splitLines on empty text')

// --- encryption ----------------------------------------------------------------

async function rejects(task: () => Promise<unknown>): Promise<boolean> {
  try {
    await task()
    return false
  } catch {
    return true
  }
}

{
  const { utf8, fromUtf8, toBase64, fromBase64, randomBytes } = e2e
  const sample = randomBytes(300)
  check(
    fromBase64(toBase64(sample)).every((byte, index) => byte === sample[index]) && fromUtf8(utf8('äöü ✓')) === 'äöü ✓',
    'base64 and utf8 round-trip'
  )

  const secret = randomBytes(32)
  const a = e2e.toHex(await e2e.hkdf(secret, 'one'))
  check(a === e2e.toHex(await e2e.hkdf(secret, 'one')), 'HKDF is deterministic')
  check(a !== e2e.toHex(await e2e.hkdf(secret, 'two')), 'and separates by purpose')

  const key = await e2e.aesKey(randomBytes(32))
  const sealed = await e2e.encrypt(key, utf8('the note'), 'doc:x#0')
  check(fromUtf8(await e2e.decrypt(key, sealed, 'doc:x#0')) === 'the note', 'AES-GCM round-trips')
  check(await rejects(() => e2e.decrypt(key, sealed, 'doc:y#0')), 'a frame moved to another room does not open')
  const tampered = new Uint8Array(sealed)
  tampered[tampered.length - 1] ^= 1
  check(await rejects(() => e2e.decrypt(key, tampered, 'doc:x#0')), 'a changed byte does not open')
  check(
    e2e.toHex(await e2e.encrypt(key, utf8('same'), 'a')) !== e2e.toHex(await e2e.encrypt(key, utf8('same'), 'a')),
    'the same text encrypts differently every time'
  )

  const master = randomBytes(32)
  const wrapped = await e2e.wrapSecret(master, secret, 'vault')
  check(e2e.toHex(await e2e.unwrapSecret(master, wrapped, 'vault')) === e2e.toHex(secret), 'wrapping round-trips')
  check(await rejects(() => e2e.unwrapSecret(master, wrapped, 'private-key')), 'a wrapped secret opens only for its purpose')
  check(await rejects(() => e2e.unwrapSecret(randomBytes(32), wrapped, 'vault')), 'and only under its master key')

  const alice = await e2e.generateIdentity()
  const bob = await e2e.generateIdentity()
  const alicePrivate = await e2e.importPrivateKey(alice.privateKey)
  const bobPrivate = await e2e.importPrivateKey(bob.privateKey)
  const box = await e2e.seal(alice.publicKey, secret, 'epoch:doc:x#1')
  check(
    e2e.toHex(await e2e.unseal(alicePrivate, alice.publicKey, box, 'epoch:doc:x#1')) === e2e.toHex(secret),
    'a sealed key opens for its recipient'
  )
  check(await rejects(() => e2e.unseal(bobPrivate, bob.publicKey, box, 'epoch:doc:x#1')), 'and for nobody else')
  check(await rejects(() => e2e.unseal(alicePrivate, alice.publicKey, box, 'epoch:doc:x#2')), 'and only as what it was sealed for')

  const vaultKey = randomBytes(32)
  const id = await e2e.deriveDocId(vaultKey, 'Notes/Plan.md', 0)
  check(id === (await e2e.deriveDocId(vaultKey, 'Notes/Plan.md', 0)) && /^[0-9a-f]{32}$/.test(id), 'note ids are derived, 128-bit hex')
  check(id !== (await e2e.deriveDocId(randomBytes(32), 'Notes/Plan.md', 0)), 'and depend on the vault key')
  check(id !== (await e2e.deriveDocId(vaultKey, 'Notes/Plan.md', 1)), 'and on the generation')
  check(
    e2e.toHex(await e2e.vaultKeys.doc(vaultKey, id, 0)) !== e2e.toHex(await e2e.vaultKeys.doc(vaultKey, id, 1)),
    'every epoch of a note has its own key'
  )

  const frame = e2e.unpackFrame(e2e.packFrame(1_790_000_000_123, utf8('update')))
  check(frame.authorTs === 1_790_000_000_123 && fromUtf8(frame.update) === 'update', 'frames carry the author clock')

  const kdf = e2e.newKdfParams()
  const first = await e2e.derivePasswordKeys('correct horse', kdf, hashWasmArgon2id)
  const again = await e2e.derivePasswordKeys('correct horse', kdf, hashWasmArgon2id)
  const other = await e2e.derivePasswordKeys('correct horsf', kdf, hashWasmArgon2id)
  check(e2e.toHex(first.masterKey) === e2e.toHex(again.masterKey), 'a password gives the same keys every time')
  check(e2e.toHex(first.authKey) !== e2e.toHex(first.masterKey), 'what logs in is not what decrypts')
  check(e2e.toHex(first.masterKey) !== e2e.toHex(other.masterKey), 'and a different password gives different keys')
}

// --- seeding an empty document from its file ------------------------------------------
{
  const { seedUpdate } = await import('../src/sync/seed.js')
  const textOf = (...updates: Uint8Array[]): Y.Doc => {
    const doc = new Y.Doc()
    for (const update of updates) Y.applyUpdate(doc, update)
    return doc
  }
  const note = 'a note from before the plugin\n'
  const one = textOf(seedUpdate('doc-1', note), seedUpdate('doc-1', note))
  check(one.getText(CONTENT_FIELD).toString() === note, 'two devices seeding the same text leave it there once')
  const both = textOf(seedUpdate('doc-1', note), seedUpdate('doc-1', 'another text\n')).getText(CONTENT_FIELD).toString()
  check(both.includes(note) && both.includes('another text\n'), 'different texts are both kept', both)
  const again = textOf(seedUpdate('doc-1', note))
  again.getText(CONTENT_FIELD).delete(0, note.length)
  Y.applyUpdate(again, seedUpdate('doc-1', note))
  check(again.getText(CONTENT_FIELD).length === 0, 'a seed deleted since does nothing when applied again - hence the fallback in DocStore')
}

// --- asking the server before signing in -----------------------------------------------
{
  const { ConnectApi } = await import('../src/account/api.js')
  const { probeServer } = await import('../src/account/probe.js')
  type Answer = { status: number; json: unknown } | 'unreachable'
  const probeWith = (answers: Record<string, Answer>) =>
    probeServer(
      new ConnectApi(
        () => 'ws://server.test',
        async (request) => {
          const answer = answers[new URL(request.url).pathname] ?? { status: 404, json: null }
          if (answer === 'unreachable') throw new Error('connection refused')
          return answer
        },
        () => null
      )
    )
  const ok = (json: unknown): Answer => ({ status: 200, json })
  const current = { ok: true, service: 'obsidian-connect-server', protocol: PROTOCOL_VERSION }

  check((await probeWith({ [API.health]: 'unreachable' })).state === 'unreachable', 'a server that does not answer is unreachable')
  check((await probeWith({})).state === 'incompatible', 'something answering 404 is not taken for a server')
  check(
    (await probeWith({ [API.health]: ok({ ok: true, service: 'something-else' }) })).state === 'incompatible',
    'nor is another service answering 200'
  )
  const older = await probeWith({ [API.health]: ok({ ...current, protocol: PROTOCOL_VERSION - 1 }) })
  check(older.state === 'incompatible' && older.reason.includes('Update the server'), 'an older server is told apart', older)
  const newer = await probeWith({ [API.health]: ok({ ...current, protocol: PROTOCOL_VERSION + 1 }) })
  check(newer.state === 'incompatible' && newer.reason.includes('Update the plugin'), 'and so is a newer one', newer)
  const open = await probeWith({ [API.health]: ok(current), [API.config]: ok({ registration: 'open', protocol: PROTOCOL_VERSION }) })
  check(open.state === 'ok' && open.registration === 'open', 'a current server says whether anyone may register', open)
  const invite = await probeWith({ [API.health]: ok(current), [API.config]: ok({ registration: 'invite', protocol: PROTOCOL_VERSION }) })
  check(invite.state === 'ok' && invite.registration === 'invite', 'or only with an invite', invite)
  const broken = await probeWith({ [API.health]: ok(current) })
  check(broken.state === 'incompatible', 'a server that answers but refuses its own settings is not called unreachable', broken)
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
