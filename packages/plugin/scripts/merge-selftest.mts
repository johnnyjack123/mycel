// Unit checks for the code paths that can lose a user's text or expose it: the
// merge logic and the encryption; and asking a server whether it can be used.
// No server, no DOM, no Obsidian.
//
//   npm run test:merge -w @mycel/plugin
import * as Y from 'yjs'
import {
  API,
  CONTENT_FIELD,
  PROTOCOL_VERSION,
  applyTextEdits,
  splitLines,
  textEdits,
  threeWayMerge
} from '@mycel/shared'
import * as e2e from '@mycel/shared/crypto'
import { hashWasmArgon2id } from '../src/account/argon2.js'
import { Replay } from '../src/history/RoomHistory.js'
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

check(reconcile({ base: 'x', local: 'x', remote: 'x', pristine: false, markers: true }).kind === 'agree', 'agree')
check(
  reconcile({ base: null, local: 'note', remote: '', pristine: true, markers: true }).kind === 'seed',
  'a document that never carried anything is seeded'
)
check(
  reconcile({ base: 'note', local: 'note', remote: '', pristine: true, markers: true }).kind === 'seed',
  'also where the device knew the note: a server and a local store both lost do not empty the file'
)
check(
  reconcile({ base: 'note', local: 'note', remote: '', pristine: false, markers: true }).kind === 'adopt-remote',
  'a note emptied elsewhere empties the untouched file'
)
{
  const emptied = reconcile({ base: null, local: 'note', remote: '', pristine: false, markers: true })
  check(
    emptied.kind === 'merge' && emptied.additiveOnly && emptied.text === 'note',
    'without a base an emptied note gets the text back, never an empty file',
    emptied
  )
}
check(
  reconcile({ base: 'x', local: 'x', remote: 'y', pristine: false, markers: true }).kind === 'adopt-remote',
  'an untouched file adopts the document'
)
check(
  reconcile({ base: 'x', local: 'y', remote: 'x', pristine: false, markers: true }).kind === 'adopt-local',
  'an untouched document adopts the file'
)

{
  // Without a base the reconcile must never delete: "missing here" and "added
  // there" are indistinguishable.
  const outcome = reconcile({
    base: null,
    local: 'kept\nlocal only\n',
    remote: 'kept\nremote only\n',
    pristine: false,
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

  // Signing keys: the owner signs what it seals.
  {
    const owner = await e2e.generateSigningKeys()
    const ownerSigning = await e2e.importSigningKey(owner.privateKey)
    const aliceId = 'a'.repeat(32)
    const ownerId = 'b'.repeat(32)
    const signed = await e2e.signSealed(ownerSigning, ownerId, 'doc:x', 1, aliceId, box)
    const parts = e2e.splitSealed(signed)
    check(parts?.sealed === box && parts.signer === ownerId, 'a signed sealed key names its sealer')
    check(parts !== null && (await e2e.verifySealed(owner.publicKey, 'doc:x', 1, aliceId, parts)), "and the owner's signature holds")
    check(
      parts !== null &&
        !(await e2e.verifySealed(owner.publicKey, 'doc:x', 2, aliceId, parts)) &&
        !(await e2e.verifySealed(owner.publicKey, 'doc:y', 1, aliceId, parts)) &&
        !(await e2e.verifySealed(owner.publicKey, 'doc:x', 1, ownerId, parts)),
      'for that room, that epoch and that recipient only'
    )
    const other = await e2e.generateSigningKeys()
    check(parts !== null && !(await e2e.verifySealed(other.publicKey, 'doc:x', 1, aliceId, parts)), "nobody else's key makes it hold")
    const swapped = e2e.splitSealed(`${await e2e.seal(alice.publicKey, randomBytes(32), 'epoch:doc:x#1')}.${ownerId}.${parts?.signature ?? ''}`)
    check(swapped !== null && !(await e2e.verifySealed(owner.publicKey, 'doc:x', 1, aliceId, swapped)), 'a box swapped under the signature is caught')
    check(e2e.splitSealed(box) === null, 'a key sealed without a signature is told apart')

    // An identity is both keys: a code's fingerprint covers the signing key too.
    const signing = await e2e.generateSigningKeys()
    const identity = await e2e.identityFingerprint(aliceId, alice.publicKey, signing.publicKey)
    check(
      e2e.toHex(identity) === e2e.toHex(await e2e.identityFingerprint(aliceId, alice.publicKey, signing.publicKey)) &&
        e2e.toHex(identity) !== e2e.toHex(await e2e.identityFingerprint(aliceId, alice.publicKey, other.publicKey)) &&
        e2e.toHex(identity) !== e2e.toHex(await e2e.identityFingerprint(aliceId, bob.publicKey, signing.publicKey)),
      "an identity's fingerprint changes with either of its keys"
    )
    // And with the account: a server naming another contact as a code's creator is caught.
    check(
      e2e.toHex(identity) !== e2e.toHex(await e2e.identityFingerprint(ownerId, alice.publicKey, signing.publicKey)),
      "an identity's fingerprint changes with its account id"
    )

    // Signed frames: the author signs inside the encryption; a writer carries the owner's certificate.
    const update = utf8('a change')
    const byOwner = e2e.unpackFrame(await e2e.packSignedFrame(ownerSigning, 'doc:x', 3, ownerId, null, 1_790_000_000_000, update)) as e2e.OpenedFrame
    check(
      byOwner.author === ownerId && byOwner.cert === null && byOwner.authorTs === 1_790_000_000_000 && e2e.toHex(byOwner.update) === e2e.toHex(update),
      'a signed frame names its author and keeps clock and change'
    )
    check(await e2e.verifyFrame(owner.publicKey, 'doc:x', 3, byOwner), "the owner's frame holds under the owner's key")
    check(
      !(await e2e.verifyFrame(owner.publicKey, 'doc:x', 4, byOwner)) && !(await e2e.verifyFrame(owner.publicKey, 'doc:y', 3, byOwner)),
      'in that room and epoch only'
    )
    check(!(await e2e.verifyFrame(owner.publicKey, 'doc:x', 3, { ...byOwner, update: utf8('another change') })), 'and with that change only')
    const writer = await e2e.generateSigningKeys()
    const writerSigning = await e2e.importSigningKey(writer.privateKey)
    const certSignature = e2e.fromBase64(await e2e.signWriterCert(ownerSigning, 'doc:x', 3, aliceId, writer.publicKey))
    const cert = { signingKey: writer.publicKey, signature: certSignature }
    const byWriter = e2e.unpackFrame(await e2e.packSignedFrame(writerSigning, 'doc:x', 3, aliceId, cert, 1, update)) as e2e.OpenedFrame
    check(
      byWriter.cert !== null &&
        (await e2e.verifyWriterCert(owner.publicKey, 'doc:x', 3, aliceId, byWriter.cert)) &&
        (await e2e.verifyFrame(writer.publicKey, 'doc:x', 3, byWriter)),
      "a writer's frame carries the owner's certificate, and holds under the key it names"
    )
    check(!(await e2e.verifyFrame(writer.publicKey, 'doc:x', 3, { ...byWriter, author: ownerId })), 'and as its author only')
    check(
      !(await e2e.verifyWriterCert(owner.publicKey, 'doc:x', 4, aliceId, cert)) &&
        !(await e2e.verifyWriterCert(owner.publicKey, 'doc:x', 3, ownerId, cert)) &&
        !(await e2e.verifyWriterCert(owner.publicKey, 'doc:x', 3, aliceId, { ...cert, signingKey: other.publicKey })),
      'a certificate is for that writer, that key and that epoch only'
    )
    const plain = new Uint8Array(9 + update.length)
    plain.set(update, 9)
    plain[0] = 1
    check(
      e2e.unpackFrame(plain.subarray(0, 40)) === null && e2e.unpackFrame(new Uint8Array(9 + update.length)) === null,
      'a frame without a signature is no frame'
    )
    const flagged = await e2e.packSignedFrame(ownerSigning, 'doc:x', 3, ownerId, null, 1, update)
    flagged[9 + 16] = 1
    check(e2e.unpackFrame(flagged.subarray(0, 9 + 16 + 1 + 64 + 65)) === null, 'nor one cut short behind its certificate')
  }

  const vaultKey = randomBytes(32)
  const id = await e2e.deriveDocId(vaultKey, 'Notes/Plan.md', 0)
  check(id === (await e2e.deriveDocId(vaultKey, 'Notes/Plan.md', 0)) && /^[0-9a-f]{32}$/.test(id), 'note ids are derived, 128-bit hex')
  check(id !== (await e2e.deriveDocId(randomBytes(32), 'Notes/Plan.md', 0)), 'and depend on the vault key')
  check(id !== (await e2e.deriveDocId(vaultKey, 'Notes/Plan.md', 1)), 'and on the generation')
  check(
    e2e.toHex(await e2e.vaultKeys.doc(vaultKey, id, 0)) !== e2e.toHex(await e2e.vaultKeys.doc(vaultKey, id, 1)),
    'every epoch of a note has its own key'
  )

  // Shared folders: one key per folder epoch opens every note in it.
  const folderId = await e2e.deriveFolderId(vaultKey, 'Projects/X', 0)
  check(
    /^[0-9a-f]{32}$/.test(folderId) &&
      folderId === (await e2e.deriveFolderId(vaultKey, 'Projects/X', 0)) &&
      folderId !== (await e2e.deriveFolderId(vaultKey, 'Projects/X', 1)) &&
      folderId !== (await e2e.deriveDocId(vaultKey, 'Projects/X', 0)),
    "a folder's id is derived like a note's, under a label of its own"
  )
  const f0 = await e2e.vaultKeys.folder(vaultKey, folderId, 0)
  const f1 = await e2e.vaultKeys.folder(vaultKey, folderId, 1)
  check(e2e.toHex(f0) !== e2e.toHex(f1), 'every folder epoch has its own key')
  check(
    e2e.toHex(await e2e.folderKeys.doc(f0, id, 3)) === e2e.toHex(await e2e.folderKeys.doc(f0, id, 3)) &&
      e2e.toHex(await e2e.folderKeys.doc(f0, id, 3)) !== e2e.toHex(await e2e.folderKeys.doc(f1, id, 3)) &&
      e2e.toHex(await e2e.folderKeys.doc(f0, id, 3)) !== e2e.toHex(await e2e.vaultKeys.doc(vaultKey, id, 3)),
    "a note's key in the folder comes from the folder's key, not the vault's"
  )
  check(
    e2e.toHex(await e2e.folderKeys.room(f0)) !== e2e.toHex(f0) && e2e.toHex(await e2e.folderKeys.ids(f0)) !== e2e.toHex(await e2e.folderKeys.room(f0)),
    "the folder room and the ids take keys of their own from it"
  )
  const inFolder = await e2e.deriveDocId(await e2e.folderKeys.ids(f0), 'Plan.md', 0)
  check(
    inFolder === (await e2e.deriveDocId(await e2e.folderKeys.ids(await e2e.vaultKeys.folder(vaultKey, folderId, 0)), 'Plan.md', 0)) &&
      inFolder !== (await e2e.deriveDocId(await e2e.folderKeys.ids(f1), 'Plan.md', 0)),
    'everyone in a folder derives the same id for a new note, and a later epoch another'
  )
  const { tiesAscend } = await import('@mycel/shared')
  const tie = (folder: string, epoch: number): { folder: string; epoch: number } => ({ folder, epoch })
  check(
    tiesAscend({ '1': tie('a', 0), '2': tie('a', 1), '3': tie('a', 1), '5': tie('b', 0), '6': tie('a', 4) }) && tiesAscend({}),
    'ties that never go back within a folder are taken, moving between folders included'
  )
  check(
    !tiesAscend({ '1': tie('a', 2), '2': tie('a', 1) }) && !tiesAscend({ '1': tie('a', 0.5) }),
    'a later note epoch tied to an earlier epoch of the same folder is not'
  )

  // The salt: derived, not stored - from the server's id and the name.
  const salt = await e2e.accountSalt('server-a', 'Anna')
  check(e2e.toHex(salt) === e2e.toHex(await e2e.accountSalt('server-a', '  anna ')), 'a name is the same account however it is typed')
  check(e2e.toHex(salt) !== e2e.toHex(await e2e.accountSalt('server-b', 'anna')), 'another server gives another salt')
  check(e2e.toHex(salt) !== e2e.toHex(await e2e.accountSalt('server-a', 'ben')), 'and so does another name')

  const version = e2e.CURRENT_KDF_VERSION
  check((e2e.KDF_VERSIONS[version]?.memoryKiB ?? 0) >= 65_536, 'Argon2id runs with at least 64 MiB')
  const first = await e2e.derivePasswordKeys('correct horse', salt, version, hashWasmArgon2id)
  const again = await e2e.derivePasswordKeys('correct horse', salt, version, hashWasmArgon2id)
  const other = await e2e.derivePasswordKeys('correct horsf', salt, version, hashWasmArgon2id)
  const elsewhere = await e2e.derivePasswordKeys('correct horse', await e2e.accountSalt('server-a', 'ben'), version, hashWasmArgon2id)
  check(e2e.toHex(first.masterKey) === e2e.toHex(again.masterKey), 'a password gives the same keys every time')
  check(e2e.toHex(first.loginKey) !== e2e.toHex(first.masterKey), 'what logs in is not what decrypts')
  check(e2e.toHex(first.masterKey) !== e2e.toHex(other.masterKey), 'and a different password gives different keys')
  check(e2e.toHex(first.loginKey) !== e2e.toHex(elsewhere.loginKey), 'the same password under another name is another account')

  // Vaults: ids and names from the account secret.
  const accountSecret = e2e.randomBytes(32)
  check(
    (await e2e.accountKeys.vaultId(accountSecret, 'Notes')) === (await e2e.accountKeys.vaultId(accountSecret, ' Notes ')) &&
      (await e2e.accountKeys.vaultId(accountSecret, 'Notes')) !== (await e2e.accountKeys.vaultId(e2e.randomBytes(32), 'Notes')),
    "a vault's id follows from the account secret and its name, and means nothing without the secret"
  )
}

// --- blobs: the encrypted content of attachments ---------------------------------------
{
  const { BLOB_CHUNK_BYTES, BLOB_CHUNK_OVERHEAD, blobChunkCount } = await import('@mycel/shared')
  const vaultKey = e2e.randomBytes(32)
  const fileId = await e2e.deriveFileId(vaultKey, 'Assets/diagram.png', 0)
  check(
    fileId === (await e2e.deriveFileId(vaultKey, 'Assets/diagram.png', 0)) &&
      fileId !== (await e2e.deriveFileId(vaultKey, 'Assets/diagram.png', 1)) &&
      fileId !== (await e2e.deriveDocId(vaultKey, 'Assets/diagram.png', 0)),
    "a file's id is derived like a note's, under a label of its own"
  )

  // WebCrypto hands out at most 64 KiB of randomness at a time.
  const data = new Uint8Array(BLOB_CHUNK_BYTES * 2 + 1234).map((_byte, index) => (index * 31 + 7) & 255)
  const hash = await e2e.contentHash(data)
  const idKey = await e2e.vaultKeys.blobId(vaultKey)
  const blobId = await e2e.blobIdFor(idKey, hash)
  check(
    /^[0-9a-f]{32}$/.test(blobId) && blobId === (await e2e.blobIdFor(idKey, hash)) && blobId !== (await e2e.blobIdFor(await e2e.vaultKeys.blobId(e2e.randomBytes(32)), hash)),
    'a blob is named after its content, under a key of the vault'
  )
  check(blobId !== hash.slice(0, 32), "and the name is not the content's plain hash, which the server could look up")

  const key = await e2e.aesKey(await e2e.vaultKeys.blob(vaultKey, blobId))
  const chunks = await e2e.encryptBlob(key, data, blobId)
  check(
    chunks.length === 3 && blobChunkCount(data.length) === 3 && chunks[0]?.length === BLOB_CHUNK_BYTES + BLOB_CHUNK_OVERHEAD && chunks[2]?.length === 1234 + BLOB_CHUNK_OVERHEAD,
    'a file is encrypted in chunks of a fixed size, the last one shorter',
    chunks.map((chunk) => chunk.length)
  )
  const back = await e2e.decryptBlob(key, chunks, blobId)
  check(back.length === data.length && (await e2e.contentHash(back)) === hash, 'and decrypts to the same bytes')
  check(await rejects(() => e2e.decryptBlob(key, [chunks[1], chunks[0], chunks[2]] as Uint8Array[], blobId)), 'chunks in another order do not open')
  check(await rejects(() => e2e.decryptBlob(key, chunks.slice(0, 2), blobId)), 'nor with the last chunk dropped')
  check(await rejects(() => e2e.decryptBlob(key, [chunks[0], chunks[2]] as Uint8Array[], blobId)), 'nor with one in the middle dropped')
  const otherId = `${blobId.slice(0, 31)}${blobId.endsWith('0') ? '1' : '0'}`
  check(await rejects(() => e2e.decryptBlob(key, chunks, otherId)), 'nor under the name of another blob')
  const empty = await e2e.encryptBlob(key, new Uint8Array(0), blobId)
  check(empty.length === 1 && (await e2e.decryptBlob(key, empty, blobId)).length === 0, 'an empty file is one empty chunk')
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

// --- the recovery code --------------------------------------------------------------------
{
  // Fixed, so whether every typo is caught does not depend on the draw.
  const secret = new Uint8Array(Array.from({ length: 16 }, (_, index) => (index * 37 + 11) & 255))
  const code = await e2e.encodeRecoveryCode(secret)
  check(/^([0-9A-HJKMNP-TV-Z]{5}-){5}[0-9A-HJKMNP-TV-Z]{5}$/.test(code), 'a recovery code is six groups of five characters', code)
  check(e2e.toHex((await e2e.decodeRecoveryCode(code)) ?? new Uint8Array()) === e2e.toHex(secret), 'and reads back as its secret')
  check(
    e2e.toHex((await e2e.decodeRecoveryCode(code.toLowerCase().replace(/-/g, ' ').replace(/1/g, 'l').replace(/0/g, 'o'))) ?? new Uint8Array()) ===
      e2e.toHex(secret),
    'typed in lower case, with spaces, l for 1 and o for 0 too'
  )
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const plain = code.replace(/-/g, '')
  let typos = 0
  let missed = 0
  for (let position = 0; position < plain.length; position += 1) {
    for (const char of alphabet) {
      if (char === plain[position]) continue
      typos += 1
      if ((await e2e.decodeRecoveryCode(plain.slice(0, position) + char + plain.slice(position + 1))) !== null) missed += 1
    }
  }
  check(missed === 0, `every single-character typo is caught (${typos} tried)`, { missed })
  check(
    (await e2e.decodeRecoveryCode(plain.slice(1))) === null && (await e2e.decodeRecoveryCode(`${plain}A`)) === null,
    'so is a character left out or one too many'
  )
  check((await e2e.decodeRecoveryCode('not a code')) === null, 'and anything else is no code')
  const keys = await e2e.recoveryKeys(secret)
  const password = await e2e.derivePasswordKeys('x'.repeat(12), new Uint8Array(16), 1, async (_p, _s, params) => new Uint8Array(params.hashLength).fill(7))
  check(
    new Set([keys.recoveryKey, keys.wrapKey, password.loginKey, password.masterKey].map((key) => e2e.toHex(key))).size === 4,
    'what the server gets from the code is not what wraps the keys'
  )
  const accountSecret = e2e.randomBytes(32)
  const wrapped = await e2e.wrapSecret(keys.wrapKey, accountSecret, 'recovery-account-secret')
  check(
    await e2e.unwrapSecret(keys.wrapKey, wrapped, 'recovery-private-key').then(() => false, () => true),
    'a wrapping does not open under another context'
  )
}

// --- two-factor sign-in --------------------------------------------------------------------
{
  // RFC 6238, appendix B, SHA-1: the last six of its eight digits.
  const rfc = e2e.utf8('12345678901234567890')
  const vectors: Array<[number, string]> = [
    [59, '287082'],
    [1_111_111_109, '081804'],
    [1_111_111_111, '050471'],
    [1_234_567_890, '005924'],
    [2_000_000_000, '279037'],
    [20_000_000_000, '353130']
  ]
  const codes = await Promise.all(vectors.map(([seconds]) => e2e.totpCode(rfc, e2e.totpStep(seconds * 1000))))
  check(codes.join() === vectors.map(([, code]) => code).join(), "the device's codes match RFC 6238's test vectors", codes)
  check(e2e.totpKeyText(rfc) === 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'the key an app is given to type is RFC 4648 base32')
  const uri = e2e.totpUri(rfc, 'anna', 'Mycel')
  check(
    uri === 'otpauth://totp/Mycel:anna?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Mycel&algorithm=SHA1&digits=6&period=30',
    'and the link an app opens names the secret, the issuer and the account',
    uri
  )
  const at = 1_111_111_111_000
  check(
    (await e2e.totpMatches(rfc, '050471', at)) && (await e2e.totpMatches(rfc, '050 471', at + 30_000)) && !(await e2e.totpMatches(rfc, '050471', at + 90_000)),
    'a code fits its own step and the ones beside it, no further'
  )
}

// --- contacts, against a server that may lie ---------------------------------------------
{
  const { Contacts } = await import('../src/share/Contacts.js')
  const { AccountSettings } = await import('../src/sync/AccountSettings.js')
  type InboxItem = { id: string; kind: 'request' | 'reply'; from: string; codeId: string; sealed: string; at: number }

  const codeRoundTrip = e2e.decodeContactCode(e2e.encodeContactCode(e2e.newContactSecret(), e2e.randomBytes(12)))
  check(codeRoundTrip !== null, 'a contact code reads back')
  const sample = e2e.encodeContactCode(e2e.newContactSecret(), e2e.randomBytes(12))
  check(
    e2e.toHex(e2e.decodeContactCode(sample.toLowerCase().replace(/-/g, ' '))?.secret ?? new Uint8Array()) ===
      e2e.toHex(e2e.decodeContactCode(sample)?.secret ?? new Uint8Array(1)),
    'typed in lower case or with spaces, too'
  )
  check(e2e.decodeContactCode('not a code') === null, 'and anything else is no code')

  // The server as the plugin sees it; `lie` lets it misbehave.
  const codes = new Map<string, { owner: string; redeemHash: string; usedBy?: string }>()
  const inbox = new Map<string, InboxItem[]>()
  const keysOf = new Map<string, string>()
  const signingKeysOf = new Map<string, string>()
  const lie: { swapKey?: string; swapSigningKey?: string } = {}
  const deliver = (to: string, item: Omit<InboxItem, 'id' | 'at'>): void => {
    inbox.set(to, [...(inbox.get(to) ?? []), { ...item, id: Math.random().toString(36).slice(2), at: Date.now() }])
  }
  const apiFor = (me: string) => ({
    addContactCode: async (request: { codeId: string; redeemHash: string }) => {
      codes.set(request.codeId, { owner: me, redeemHash: request.redeemHash })
    },
    contactCode: async (codeId: string) => {
      const code = codes.get(codeId)
      if (!code) throw new Error('no such code')
      return {
        owner: code.owner,
        publicKey: lie.swapKey ?? (keysOf.get(code.owner) as string),
        signingPublicKey: lie.swapSigningKey ?? (signingKeysOf.get(code.owner) as string)
      }
    },
    redeemContact: async (request: { codeId: string; redeemKey: string; sealed: string }) => {
      const code = codes.get(request.codeId)
      const hash = e2e.toHex(await e2e.sha256(e2e.fromBase64(request.redeemKey)))
      if (!code || code.redeemHash !== hash) throw new Error('refused')
      code.usedBy = me
      deliver(code.owner, { kind: 'request', from: me, codeId: request.codeId, sealed: request.sealed })
      return { owner: code.owner }
    },
    replyContact: async (request: { to: string; codeId: string; sealed: string }) => {
      deliver(request.to, { kind: 'reply', from: me, codeId: request.codeId, sealed: request.sealed })
    },
    contactInbox: async () => ({ items: inbox.get(me) ?? [] }),
    contactInboxDone: async (ids: string[]) => {
      inbox.set(me, (inbox.get(me) ?? []).filter((item) => !ids.includes(item.id)))
    },
    // Deletes nothing: the device must not rely on the server to refuse a revoked code.
    revokeContactCode: async () => ({}),
    removeContact: async () => ({})
  })
  const person = async (name: string) => {
    const identity = await e2e.generateIdentity()
    const signing = await e2e.generateSigningKeys()
    const accountId = e2e.toHex(e2e.randomBytes(16))
    keysOf.set(accountId, e2e.toBase64(identity.publicKey))
    signingKeysOf.set(accountId, e2e.toBase64(signing.publicKey))
    const settings = new AccountSettings()
    const me = {
      accountId,
      username: name,
      publicKey: identity.publicKey,
      privateKey: await e2e.importPrivateKey(identity.privateKey),
      signingPublicKey: signing.publicKey
    }
    return { me, settings, contacts: new Contacts(apiFor(accountId) as never, me, settings) }
  }
  const pinnedSigning = (holder: { contacts: { signingKey(account: string): Uint8Array | null } }, account: string): string | undefined => {
    const key = holder.contacts.signingKey(account)
    return key ? e2e.toBase64(key) : undefined
  }

  const anna = await person('anna')
  const ben = await person('ben')
  const code = await anna.contacts.createCode()
  check((await ben.contacts.redeem(code)) === anna.me.accountId, "ben redeems anna's code")
  check((await anna.contacts.processInbox()) === 1, "anna's device takes ben in")
  check((await ben.contacts.processInbox()) === 1, "and ben's device learns anna's name from her answer")
  check(anna.contacts.name(ben.me.accountId) === 'ben' && ben.contacts.name(anna.me.accountId) === 'anna', 'each knows the other by name')
  check(
    e2e.toBase64(ben.contacts.publicKey(anna.me.accountId) ?? new Uint8Array()) === keysOf.get(anna.me.accountId),
    "and holds the other's key, pinned"
  )
  check(
    pinnedSigning(ben, anna.me.accountId) === signingKeysOf.get(anna.me.accountId) &&
      pinnedSigning(anna, ben.me.accountId) === signingKeysOf.get(ben.me.accountId),
    "and the other's signing key, both ways"
  )

  // A second person with the same code: the server lets it through, anna's device does not.
  const eve = await person('eve')
  const secondCode = await anna.contacts.createCode()
  await ben.contacts.redeem(secondCode)
  await anna.contacts.processInbox()
  await ben.contacts.processInbox()
  const reused = codes.get([...codes.keys()].at(-1) as string)
  if (reused) reused.usedBy = undefined
  await eve.contacts.redeem(secondCode).catch(() => undefined)
  await anna.contacts.processInbox()
  check(!anna.contacts.isContact(eve.me.accountId), "a code redeemed a second time is refused by the creator's device")

  // A server handing out its own key for the code's creator.
  const fake = await e2e.generateIdentity()
  lie.swapKey = e2e.toBase64(fake.publicKey)
  const thirdCode = await anna.contacts.createCode()
  const swapped = await eve.contacts.redeem(thirdCode).then(
    () => 'sent',
    (error: Error) => error.message
  )
  check(swapped.includes('do not belong'), 'a key that does not match the code is refused before anything is sent', swapped)
  lie.swapKey = undefined
  // Only the signing key swapped: whoever holds it could sign keys and frames in anna's name.
  lie.swapSigningKey = e2e.toBase64((await e2e.generateSigningKeys()).publicKey)
  const fifthCode = await anna.contacts.createCode()
  const swappedSigning = await eve.contacts.redeem(fifthCode).then(
    () => 'sent',
    (error: Error) => error.message
  )
  check(swappedSigning.includes('do not belong'), 'so is a signing key that does not', swappedSigning)
  lie.swapSigningKey = undefined

  // A server inventing a request: it has no code secret, so no valid MAC.
  const forger = await person('mallory')
  const forged = await e2e.seal(
    anna.me.publicKey,
    e2e.utf8(
      JSON.stringify({
        account: forger.me.accountId,
        publicKey: keysOf.get(forger.me.accountId),
        signingKey: signingKeysOf.get(forger.me.accountId),
        name: 'ben',
        mac: '00'.repeat(32)
      })
    ),
    e2e.contactContext([...codes.keys()].at(-1) as string, 'request')
  )
  const forgedCodeId = [...codes.keys()].at(-1) as string
  deliver(anna.me.accountId, { kind: 'request', from: forger.me.accountId, codeId: forgedCodeId, sealed: forged })
  await anna.contacts.processInbox()
  check(!anna.contacts.isContact(forger.me.accountId), 'an introduction without the code is not believed')

  // A server answering in anna's name with a key of its own.
  const fourthCode = await anna.contacts.createCode()
  const carl = await person('carl')
  await carl.contacts.redeem(fourthCode)
  inbox.set(anna.me.accountId, [])
  const fakeAnswer = await e2e.seal(
    carl.me.publicKey,
    e2e.utf8(
      JSON.stringify({
        account: anna.me.accountId,
        publicKey: e2e.toBase64(fake.publicKey),
        signingKey: e2e.toBase64((await e2e.generateSigningKeys()).publicKey),
        name: 'anna',
        mac: '00'.repeat(32)
      })
    ),
    e2e.contactContext([...codes.keys()].at(-1) as string, 'reply')
  )
  deliver(carl.me.accountId, { kind: 'reply', from: anna.me.accountId, codeId: [...codes.keys()].at(-1) as string, sealed: fakeAnswer })
  await carl.contacts.processInbox()
  check(
    carl.contacts.name(anna.me.accountId) !== 'anna' &&
      e2e.toBase64(carl.contacts.publicKey(anna.me.accountId) ?? new Uint8Array()) === keysOf.get(anna.me.accountId) &&
      pinnedSigning(carl, anna.me.accountId) === signingKeysOf.get(anna.me.accountId),
    "a forged answer neither names the contact nor changes the keys checked against the code"
  )
  // The same with anna's real key: only the MAC can tell it is not hers.
  const namedAnswer = await e2e.seal(
    carl.me.publicKey,
    e2e.utf8(
      JSON.stringify({
        account: anna.me.accountId,
        publicKey: keysOf.get(anna.me.accountId),
        signingKey: signingKeysOf.get(anna.me.accountId),
        name: 'not anna',
        mac: '00'.repeat(32)
      })
    ),
    e2e.contactContext([...codes.keys()].at(-1) as string, 'reply')
  )
  deliver(carl.me.accountId, { kind: 'reply', from: anna.me.accountId, codeId: [...codes.keys()].at(-1) as string, sealed: namedAnswer })
  await carl.contacts.processInbox()
  check(carl.contacts.name(anna.me.accountId) !== 'not anna', 'nor does one with the right key but without the code')

  // The list of codes handed out and not redeemed yet.
  {
    const dora = await person('dora')
    const open = async (): Promise<string[]> => (await dora.contacts.openCodes()).map((entry) => entry.code)
    const first = await dora.contacts.createCode()
    const second = await dora.contacts.createCode()
    check((await open()).join() === [first, second].join(), 'every code made waits in the list, oldest first, as it was handed out')
    const frank = await person('frank')
    await frank.contacts.redeem(first)
    await dora.contacts.processInbox()
    check((await open()).join() === second, 'a redeemed code leaves the list')
    const secondId = (await dora.contacts.openCodes())[0]?.codeId as string
    await dora.contacts.revokeCode(secondId)
    check((await open()).length === 0, 'so does a deleted one')
    const gina = await person('gina')
    await gina.contacts.redeem(second)
    await dora.contacts.processInbox()
    check(!dora.contacts.isContact(gina.me.accountId), "and a deleted code redeemed anyway - the server let it through - is refused by the creator's device")
    const later = Date.now() + 8 * 24 * 60 * 60 * 1000
    await dora.contacts.createCode()
    check((await dora.contacts.openCodes(later)).length === 0, 'a code past its seven days is no longer offered')
  }
}

// --- passwords -------------------------------------------------------------------------
{
  const { generatePassword, judgePassword } = await import('../src/account/password.js')
  check(!judgePassword('short').ok, 'a short password is refused')
  for (const weak of ['Sommer2024!Sommer2024!', 'passwordpassword1', 'qwertzuiopasdfgh', 'Passwort123456!']) {
    check(!judgePassword(weak).ok, `a long but guessable password is refused: ${weak}`)
  }
  check(!judgePassword('anna-anna-anna-2024', ['anna']).ok, 'and so is one built on the name')
  const generated = Array.from({ length: 20 }, () => generatePassword())
  check(
    generated.every((password) => /^([A-HJ-NP-Za-km-z2-9]{5}-){3}[A-HJ-NP-Za-km-z2-9]{5}$/.test(password)),
    'generated passwords are 20 unambiguous characters in groups of five',
    generated[0]
  )
  check(new Set(generated).size === generated.length, 'and never repeat')
  check(generated.every((password) => judgePassword(password).ok), 'and pass the rule themselves')
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
  const current = { ok: true, service: 'mycel-server', protocol: PROTOCOL_VERSION }

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

// --- comparing two versions of a note ----------------------------------------------------
{
  const { assemble, compare } = await import('../src/sync/Reviews.js')
  const mine = 'title\nshared line\nchanged here\nkept\nonly here\n'
  const theirs = 'title\nshared line\nchanged there\nkept\n'
  const hunks = compare(mine, theirs)
  const differing = hunks.filter((hunk) => !hunk.same).length
  check(differing === 2, 'the passages that differ are found, in whole lines', hunks)
  check(assemble(hunks, Array(differing).fill('mine')) === mine, "taking this device's side everywhere gives this device's version")
  check(assemble(hunks, Array(differing).fill('theirs')) === theirs, 'taking the other side everywhere gives the other version')
  const merged = reconcile({ base: null, local: mine, remote: theirs, pristine: false, markers: false })
  check(
    merged.kind === 'merge' && assemble(hunks, []) === merged.text,
    'keeping both everywhere is exactly what the merge without a base kept',
    { merged: merged.kind === 'merge' ? merged.text : merged.kind, both: assemble(hunks, []) }
  )
  check(
    assemble(hunks, ['theirs', 'mine']) === 'title\nshared line\nchanged there\nkept\nonly here\n',
    'and each passage can go its own way'
  )
  const noNewline = compare('a\nb', 'a\nc')
  check(assemble(noNewline, ['both']) === 'a\nc\nb', 'a last line without a line break still keeps both apart', assemble(noNewline, ['both']))
}

// --- emptying the trash ------------------------------------------------------------------
{
  const { Trash } = await import('../src/sync/Trash.js')
  const { ApiError } = await import('../src/account/api.js')
  const answers: Record<string, () => Promise<unknown>> = {
    'doc:gone': async () => ({ ok: true }),
    'doc:shared': async () => Promise.reject(new ApiError(409, 'the note is still shared')),
    'doc:missing': async () => Promise.reject(new ApiError(404, 'no such room')),
    'doc:offline': async () => Promise.reject(new ApiError(0, 'unreachable'))
  }
  const asked: string[] = []
  const forgotten: string[] = []
  const api = {
    purge: (room: string) => {
      asked.push(room)
      return (answers[room] as () => Promise<unknown>)()
    }
  }
  const store = {
    expiredDeleted: () => ['gone', 'shared', 'missing', 'offline'].map((docId) => ({ docId, path: `${docId}.md`, deletedAt: 0 })),
    forgetDeleted: async (docId: string) => {
      forgotten.push(docId)
    }
  }
  let days = 0
  const trash = new Trash(api as never, store as never, () => days)
  check((await trash.purge()) === 0 && asked.length === 0, 'with no retention limit, the trash is never emptied')
  days = 30
  const purged = await trash.purge()
  check(purged === 2 && forgotten.join() === 'gone,missing', 'a note goes once the server let go of it, or never had it', forgotten)
  check(!forgotten.includes('shared'), 'one still shared stays in the trash, to be asked about again')
  check(!forgotten.includes('offline'), 'and so does one the server could not be asked about')
}

// --- settings of all devices, changed elsewhere -----------------------------------------------
{
  const { AccountSettings } = await import('../src/sync/AccountSettings.js')
  const here = new AccountSettings()
  const there = new AccountSettings()
  const remote: boolean[] = []
  here.onChange((_settings, fromElsewhere) => remote.push(fromElsewhere))
  here.set({ conflictMarkers: false })
  there.set({ historyRetentionDays: 7 })
  Y.applyUpdate(here.doc, Y.encodeStateAsUpdate(there.doc), 'socket')
  check(
    remote.join() === 'false,true' && here.get().historyRetentionDays === 7,
    'a change from another device is told apart from one made here - the open settings show it',
    remote
  )
  here.destroy()
  there.destroy()
}

// --- a button busy with its click -----------------------------------------------------------
{
  const { busy } = await import('../src/busy.js')
  const classes = new Set<string>()
  const disabled: boolean[] = []
  const button = {
    buttonEl: {
      classList: {
        add: (name: string) => void classes.add(name),
        remove: (name: string) => void classes.delete(name),
        contains: (name: string) => classes.has(name)
      }
    } as unknown as HTMLElement,
    setDisabled: (value: boolean) => void disabled.push(value)
  }
  let release = (): void => undefined
  let runs = 0
  const first = busy(button, () => {
    runs += 1
    return new Promise<void>((resolve) => (release = resolve))
  })
  check(classes.has('mycel-busy') && disabled.join() === 'true', 'a clicked button is greyed out and spins at once')
  await busy(button, async () => {
    runs += 1
  })
  check(runs === 1, 'and a second click meanwhile starts nothing')
  release()
  await first
  check(!classes.has('mycel-busy') && disabled.at(-1) === false, 'once the work is done it is a button again')
  const failed = await busy(button, async () => {
    throw new Error('refused')
  }).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  )
  check(failed === 'refused' && !classes.has('mycel-busy') && disabled.at(-1) === false, 'also when it failed, and the error still reaches the caller')
}

// --- the log for a bug report ---------------------------------------------------------------
{
  const { withSummary } = await import('../src/log.js')
  const text = [
    '2026-10-13T20:00:40.070Z DEBUG doc:1: push 1, 24 B, epoch 0',
    '2026-10-13T20:00:41.000Z INFO  connected to ws://localhost:1234, 1 room(s)',
    '2026-10-13T20:00:42.000Z ERROR Typing.md: two versions kept (conflict); choose with "Compare versions"',
    '2026-10-13T20:00:43.000Z WARN  presence for doc:1 could not be read Error: bad',
    'Error: bad',
    '    at somewhere (plugin:mycel:1:1)',
    ''
  ].join('\n')
  const report = withSummary(text, 'Mycel 0.6.4')
  const [head, rest] = report.split('\n\nThe whole log:\n')
  check(
    head === 'Mycel 0.6.4\n\nErrors and warnings (2):\n' + `${text.split('\n')[2]}\n${text.split('\n')[3]}`,
    'a copied log starts with its errors and warnings, one line each, without stacks',
    head
  )
  check(rest === text, 'followed by the whole log, unchanged')
  check(withSummary('2026-10-13T20:00:41.000Z INFO  connected\n', 'h').includes('Errors and warnings: none'), 'and says so when there are none')
}

// --- a backup server's invitation, and a session through a relay that may lie ----------------
{
  const secret = e2e.newBackupSecret()
  const code = await e2e.encodeBackupInvite(secret)
  check(/^([0-9A-HJKMNP-TV-Z]{5}-){5}[0-9A-HJKMNP-TV-Z]{5}$/.test(code), "a backup server's invitation is written like a recovery code", code)
  check(e2e.toHex((await e2e.decodeBackupInvite(code)) ?? new Uint8Array()) === e2e.toHex(secret), 'and reads back as its secret')
  const recovery = await e2e.encodeRecoveryCode(secret)
  check(
    (await e2e.decodeBackupInvite(recovery)) === null && (await e2e.decodeRecoveryCode(code)) === null,
    'a recovery code is no invitation, nor the other way round'
  )
  const keys = await e2e.backupRouteKeys(secret)
  check(
    keys.routeId === e2e.toHex(await e2e.sha256(keys.routeToken)) && e2e.toHex(keys.routeToken) !== e2e.toHex(keys.psk),
    'the sync server addresses it by a hash, and the key of its sessions is another one'
  )
  const other = await e2e.backupRouteKeys(e2e.newBackupSecret())
  check(other.routeId !== keys.routeId && e2e.toHex(other.psk) !== e2e.toHex(keys.psk), 'every secret is a route and a key of its own')

  // A session as it should go.
  const { hello, pending } = await e2e.openSession()
  const { answer, keys: backupKeys } = await e2e.answerSession(keys.psk, hello)
  const pluginKeys = await e2e.finishSession(keys.psk, pending, answer)
  const plugin = new e2e.SessionCipher(pluginKeys, 'plugin')
  const backup = new e2e.SessionCipher(backupKeys, 'backup')
  check((await backup.open(await plugin.seal('first'))) === 'first' && (await plugin.open(await backup.seal('reply'))) === 'reply', 'both ends of a session read each other')
  check(
    pluginKeys.transcript === backupKeys.transcript &&
      (await e2e.sessionProof(keys.psk, 'plugin', pluginKeys.transcript)) !== (await e2e.sessionProof(keys.psk, 'backup', pluginKeys.transcript)),
    'and each side proves the code with a proof of its own'
  )

  const refuses = async (task: () => Promise<unknown>): Promise<boolean> => task().then(() => false, () => true)

  // The relay answering in the backup server's place: it does not know the code.
  {
    const relay = await e2e.answerSession(await e2e.hkdf(e2e.randomBytes(16), 'not the code'), hello)
    check(await refuses(() => e2e.finishSession(keys.psk, pending, relay.answer)), 'a relay posing as the backup server is caught by its proof')
    const swapped = await e2e.openSession()
    const forged = { ...relay.answer, mac: answer.mac }
    check(await refuses(() => e2e.finishSession(keys.psk, swapped.pending, forged)), "nor can it reuse the backup server's proof with a key of its own")
  }

  // The relay tampering with, replaying, reordering or reflecting messages.
  {
    // Fresh ends for each case, so nothing but the case itself can make a message fail.
    const sender = (): InstanceType<typeof e2e.SessionCipher> => new e2e.SessionCipher(pluginKeys, 'plugin')
    const receiver = (): InstanceType<typeof e2e.SessionCipher> => new e2e.SessionCipher(backupKeys, 'backup')
    const message = await sender().seal('m0')
    const tampered = e2e.fromBase64(message)
    tampered[tampered.length - 1] ^= 1
    check(
      (await receiver().open(message)) === 'm0' && (await refuses(() => receiver().open(e2e.toBase64(tampered)))),
      'a message changed on the way does not open'
    )
    const once = receiver()
    const again = await sender().seal('m0')
    check((await once.open(message)) === 'm0' && (await refuses(() => once.open(again))), 'a message replayed opens only once')
    const ahead = sender()
    await ahead.seal('m0')
    const second = await ahead.seal('m1')
    check(await refuses(() => receiver().open(second)), 'a message out of order does not open')
    check(await refuses(() => new e2e.SessionCipher(pluginKeys, 'plugin').open(message)), 'nor does one sent back to its sender')
  }

  // Someone who knows another route - an invitation spent long ago, another vault's pairing - cannot open this one.
  {
    const { hello: otherHello, pending: otherPending } = await e2e.openSession()
    const answered = await e2e.answerSession(keys.psk, otherHello)
    check(await refuses(() => e2e.finishSession(other.psk, otherPending, answered.answer)), "another route's secret does not open a session on this one")
  }
}

// --- the Time Machine's replay -----------------------------------------------
{
  const source = new Y.Doc()
  const steps: Array<{ seq: number; ts: number; update: Uint8Array }> = []
  source.on('update', (update: Uint8Array) => steps.push({ seq: steps.length + 1, ts: 1_000 + steps.length * 10, update }))
  const text = source.getText(CONTENT_FIELD)
  for (let i = 0; i < 450; i += 1) {
    if (i % 7 === 3 && text.length > 10) text.delete((i * 17) % (text.length - 3), 3)
    else text.insert(text.length === 0 ? 0 : (i * 31) % text.length, `${i} `)
  }
  const fromStart = (count: number): string => {
    const doc = new Y.Doc()
    for (const step of steps.slice(0, count)) Y.applyUpdate(doc, step.update)
    const result = doc.getText(CONTENT_FIELD).toString()
    doc.destroy()
    return result
  }
  // Past a checkpoint and back before it, forward again, to the start and the end.
  const replay = new Replay(null, steps)
  const wrong = [450, 10, 399, 401, 200, 199, 0, 450, 205, 3].filter((count) => replay.to(count).getText(CONTENT_FIELD).toString() !== fromStart(count))
  check(wrong.length === 0, "the Time Machine's replay gives the text a replay from the start gives, sliding forward and back", wrong)
  check(replay.countAt(1_000 + 99 * 10) === 100 && replay.countAt(0) === 0 && replay.countAt(Number.POSITIVE_INFINITY) === 450, 'and counts the changes made up to a moment')
  replay.destroy()
  const compacted = new Replay({ seq: 100, ts: 1_990, update: Y.mergeUpdates(steps.slice(0, 100).map((step) => step.update)) }, steps.slice(100))
  check(
    compacted.to(0).getText(CONTENT_FIELD).toString() === fromStart(100) && compacted.to(350).getText(CONTENT_FIELD).toString() === fromStart(450),
    'also from a snapshot'
  )
  compacted.destroy()
  source.destroy()
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
