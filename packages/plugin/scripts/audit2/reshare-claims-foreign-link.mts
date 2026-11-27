// Audit 2, finding: P11 (0.9.11) comes back through "Share again". A writer puts
// `![[passport.pdf]]` into a note the victim shares with its files, claiming nothing; the victim's
// device rightly shares nothing for it. But every later `Sharing.share` of that note - sharing it
// again to change someone's access, or with one more person - runs `LinkClaims.claimAll`, which
// names every unclaimed link as this account's, and `SharedFiles.approve`, which approves every
// link the note has. The victim's own passport.pdf goes into the note's list, and to the writer.
// docs/AUDIT.md: "A writer can delete claims; the links are then nobody's, and nothing is shared
// because of that."
//
//   cd packages/plugin && npx tsx --tsconfig scripts/tsconfig.json scripts/audit2/reshare-claims-foreign-link.mts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, delay, Device, eventually, finish, useServer } from '../harness.mjs'

const { NOTE_ATTACHMENTS_FIELD } = await import('@mycel/shared')
const { loadConfig } = await import('../../../server/src/config.js')
const { startServer } = await import('../../../server/src/server.js')

const root = mkdtempSync(join(tmpdir(), 'audit2-reshare-link-'))
const server = await startServer(
  loadConfig({ HOST: '127.0.0.1', PORT: '0', MYCEL_DATA_DIR: root, MYCEL_REGISTRATION: 'open', MYCEL_JWT_SECRET: 'audit2-reshare-link-secret-of-32-chars' }),
  { logger: false, paceMs: 0 }
)
useServer(`ws://127.0.0.1:${server.port}`)

const run = Date.now().toString(36)
const PASSPORT = new Uint8Array(3_000).map((_byte, index) => (index * 13 + 7) & 255)
const devices: Device[] = []
try {
  const victor = new Device(`vic${run}`, true, { 'Notes/Together.md': 'notes for mallory\n', 'Private/passport.pdf': PASSPORT })
  const mallory = new Device(`mal${run}`, true, { 'Own.md': 'own\n' })
  devices.push(victor, mallory)
  check((await victor.boot()) && (await mallory.boot()), 'the victim and the attacker start')
  const code = await (mallory.contacts as NonNullable<typeof mallory.contacts>).createCode()
  await victor.contacts?.redeem(code)
  check(await eventually(() => mallory.contacts?.isContact(victor.accountId) === true && victor.contacts?.isContact(mallory.accountId) === true, 15_000), 'they are contacts')
  const docId = victor.index?.docIdForPath('Notes/Together.md') as string
  await victor.sharing?.share(docId, mallory.accountId, 'write', true, true)
  check(await eventually(() => mallory.vault.text('Shared/Together.md') === 'notes for mallory\n', 15_000), 'the victim shares the note with its files, to write')
  const listed = async (): Promise<string[]> => {
    const handle = await victor.store?.handle(docId)
    return handle ? Array.from(handle.doc.getMap(NOTE_ATTACHMENTS_FIELD).keys()) : []
  }

  // Straight into the document, claiming nothing - what the attacker's own build does.
  const theirs = await mallory.store?.handle(docId)
  theirs?.doc.transact(() => theirs.ytext.insert(theirs.ytext.length, '![[passport.pdf]]\n'), 'attack')
  check(await eventually(async () => (await victor.store?.handle(docId))?.text().includes('![[passport.pdf]]') === true, 15_000), "the attacker's link reaches the victim")
  await delay(3_000)
  check(!(await listed()).includes('passport.pdf'), 'as 0.9.11 has it: a link someone else typed shares nothing', await listed())

  // Weeks later the victim shares the note again - the same person, the same access, its files as before.
  await victor.sharing?.share(docId, mallory.accountId, 'write', false, true)
  await delay(3_000)
  const now = await listed()
  console.log('      the note lists:', JSON.stringify(now))
  const got = await eventually(() => mallory.vault.attachmentPaths().some((path) => path.endsWith('passport.pdf')), 10_000)
  console.log("      the attacker's vault:", JSON.stringify(mallory.vault.attachmentPaths()))
  check(!now.includes('passport.pdf') && !got, "EXPECTED SAFE: sharing again does not hand over the victim's file for someone else's link (FAILS = finding reproduced)")
} catch (error) {
  check(false, 'the reproduction ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  for (const device of devices) await device.shutdown().catch(() => undefined)
  await server.close()
  rmSync(root, { recursive: true, force: true })
}
finish()
