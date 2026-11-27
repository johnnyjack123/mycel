// Audit 2, finding: a private note of the victim's goes into a note someone else shared with
// them - and so to that person - when one of the victim's devices took the path for the share
// while another device of the victim held a note of its own there that the first did not know.
//
// The share lands at a free path on the device that accepts it (`DocStore.acceptShare`,
// `freePath`): free *there*. The victim's other device, offline, wrote its own note at that path.
// When it starts, the vault index names someone else's shared note at that path, the scan takes
// the private file for that note's file (`syncFile`: `index.docIdForPath`), finds no base and
// merges additively (invariant 3) - into the sharer's document, which the sharer reads.
//
// Variant B (running, offline device): both ids end up live at one path and `mergeDuplicates`
// folds the loser into the sorted-first id, whoever owns it - the sharer can pick a note whose id
// sorts low. Shown here: variant A, which needs no luck.
//
//   cd packages/plugin && npx tsx --tsconfig scripts/tsconfig.json scripts/audit2/private-note-into-share.mts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, delay, Device, eventually, finish, useServer } from '../harness.mjs'

const { loadConfig } = await import('../../../server/src/config.js')
const { startServer } = await import('../../../server/src/server.js')

const root = mkdtempSync(join(tmpdir(), 'audit2-private-into-share-'))
const server = await startServer(
  loadConfig({ HOST: '127.0.0.1', PORT: '0', MYCEL_DATA_DIR: root, MYCEL_REGISTRATION: 'open', MYCEL_JWT_SECRET: 'audit2-private-share-secret-32-chars!!' }),
  { logger: false, paceMs: 0 }
)
useServer(`ws://127.0.0.1:${server.port}`)

const run = Date.now().toString(36)
const SECRET = 'PRIVATE: my bank PIN is 4711\n'
const devices: Device[] = []
try {
  const mallory = new Device(`mal${run}`, true, { 'Own/Plan.md': "mallory's plan\n" })
  const laptop = new Device(`vic${run}`, true, { 'Notes/a.md': 'a\n' })
  devices.push(mallory, laptop)
  check(await mallory.boot(), "the sharer's device starts")
  check(await laptop.boot(), "the victim's laptop starts")
  const phone = new Device(`vic${run}`, false)
  devices.push(phone)
  check(await phone.boot(), "the victim's phone starts")
  check(await eventually(() => phone.vault.text('Notes/a.md') === 'a\n'), 'the phone has the vault')

  const code = await (mallory.contacts as NonNullable<typeof mallory.contacts>).createCode()
  await laptop.contacts?.redeem(code)
  check(await eventually(() => mallory.contacts?.isContact(laptop.accountId) === true && laptop.contacts?.isContact(mallory.accountId) === true, 15_000), 'the two are contacts')

  // The phone goes offline; the victim writes a private note in the share folder there.
  await phone.shutdown()
  phone.vault.offlineWrite('Shared/Plan.md', SECRET)

  // Meanwhile the contact shares a note titled "Plan"; the laptop takes it in at Shared/Plan.md - free there.
  const planId = mallory.index?.docIdForPath('Own/Plan.md') as string
  await mallory.sharing?.share(planId, laptop.accountId, 'write', false)
  check(await eventually(() => laptop.vault.text('Shared/Plan.md') === "mallory's plan\n", 15_000), 'the laptop took the share in at Shared/Plan.md', laptop.vault.paths())

  // The phone comes back.
  check(await phone.boot(), 'the phone starts again')
  await delay(4_000)
  const leaked = (mallory.vault.text('Own/Plan.md') ?? '').includes('bank PIN')
  console.log("      the sharer's note now reads:", JSON.stringify(mallory.vault.text('Own/Plan.md')))
  console.log('      phone Shared/:', JSON.stringify(phone.vault.paths().filter((path) => path.startsWith('Shared/')).map((path) => [path, phone.vault.text(path)])))
  check(!leaked, "EXPECTED SAFE: the victim's private note never reaches the sharer (FAILS = finding reproduced)")
} catch (error) {
  check(false, 'the reproduction ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  for (const device of devices) await device.shutdown().catch(() => undefined)
  await server.close()
  rmSync(root, { recursive: true, force: true })
}
finish()
