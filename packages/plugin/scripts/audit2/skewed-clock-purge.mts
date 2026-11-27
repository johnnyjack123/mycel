// Audit 2, finding: the trash's retention runs on the deleting device's clock. A tombstone's
// `deletedAt` is that device's `Date.now()`; every device of the account purges what
// `deletedAt < now - retention` names (`Trash.purge`, `DocStore.expiredDeleted`) and asks the
// server to delete the room. A device whose clock is behind by more than the retention (a dead
// CMOS battery, a VM restored from a snapshot) deletes a note that is never listed in the trash
// and is purged from the server - its whole history - at the next trash pass of any other device.
//
//   cd packages/plugin && npx tsx --tsconfig scripts/tsconfig.json scripts/audit2/skewed-clock-purge.mts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, delay, Device, eventually, finish, useServer } from '../harness.mjs'

const { docRoom } = await import('@mycel/shared')
const { loadConfig } = await import('../../../server/src/config.js')
const { startServer } = await import('../../../server/src/server.js')

const root = mkdtempSync(join(tmpdir(), 'audit2-skewed-clock-'))
const server = await startServer(
  loadConfig({ HOST: '127.0.0.1', PORT: '0', MYCEL_DATA_DIR: root, MYCEL_REGISTRATION: 'open', MYCEL_JWT_SECRET: 'audit2-skewed-clock-secret-of-32-chars' }),
  { logger: false, paceMs: 0 }
)
useServer(`ws://127.0.0.1:${server.port}`)

const DAY = 24 * 60 * 60 * 1000
const name = `sk${Date.now().toString(36)}`
const devices: Device[] = []
try {
  const right = new Device(name, true, { 'Thesis.md': 'chapter one\n', 'Other.md': 'other\n' })
  devices.push(right)
  check(await right.boot(), 'a device with a correct clock starts')
  const skewed = new Device(name, false)
  devices.push(skewed)
  check(await skewed.boot(), 'a second device of the account starts')
  check(await eventually(() => skewed.vault.text('Thesis.md') === 'chapter one\n'), 'it has the note')
  const docId = right.index?.docIdForPath('Thesis.md') as string

  // The second device's clock is 45 days behind (retention: 30 days) while the person deletes the note there.
  const realNow = Date.now
  Date.now = () => realNow() - 45 * DAY
  try {
    await skewed.vault.trash(skewed.vault.file('Thesis.md'))
    // Its own index takes the tombstone a moment later, still by its clock.
    for (let i = 0; i < 200 && skewed.index?.entry(docId)?.deletedAt === undefined; i += 1) await delay(10)
  } finally {
    Date.now = realNow
  }
  check(await eventually(() => right.index?.entry(docId)?.deletedAt !== undefined), 'the delete reaches the device with the correct clock')
  console.log('      deletedAt is', Math.round((realNow() - (right.index?.entry(docId)?.deletedAt ?? 0)) / DAY), 'days ago by the correct clock')
  const listed = right.trash?.list().some((item) => item.id === docId) ?? false
  check(listed, 'EXPECTED SAFE: a note deleted a moment ago is in the trash, to restore (FAILS = it is not listed)')

  // The next trash pass of the correct device - every few hours in the plugin.
  await right.sync?.compact()
  await delay(500)
  const still = await right.api.wholeLog(docRoom(docId)).then(() => true, () => false)
  check(still, "EXPECTED SAFE: the note's room and its history stay on the server for the retention (FAILS = purged at once)")
} catch (error) {
  check(false, 'the reproduction ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  for (const device of devices) await device.shutdown().catch(() => undefined)
  await server.close()
  rmSync(root, { recursive: true, force: true })
}
finish()
