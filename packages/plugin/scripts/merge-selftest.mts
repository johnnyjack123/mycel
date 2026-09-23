// Unit checks for the only code path that can delete a user's text. No server,
// no DOM, no Obsidian - just the merge logic.
//
//   npm run test:merge -w @obsidian-connect/plugin
import * as Y from 'yjs'
import {
  CONTENT_FIELD,
  applyTextEdits,
  parseShareLink,
  shareLink,
  splitLines,
  textEdits,
  threeWayMerge
} from '@obsidian-connect/shared'
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

// --- share links -------------------------------------------------------------

{
  const docId = '0123456789abcdef0123456789abcdef'
  const link = shareLink({ docId, title: 'Plans & ideas / 2026 #draft' })
  const parsed = parseShareLink(link)
  check(parsed?.docId === docId, 'a share link carries the document id', parsed)
  check(parsed?.title === 'Plans & ideas / 2026 #draft', 'and the title, whatever characters it has', parsed)
  check(parseShareLink(`  ${docId}\n`)?.docId === docId, 'a bare document id is accepted too')
  check(parseShareLink('obsidian://connect-share?id=not-an-id&title=x') === null, 'an invalid id is rejected')
  check(parseShareLink('https://example.com/?title=x') === null, 'a link without an id is rejected')
  check(parseShareLink('obsidian://connect-share?id=%E0%A4%A&title=x') === null, 'a malformed link is rejected')
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
