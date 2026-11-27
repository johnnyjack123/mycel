// Audit 2, finding: what a device writes while offline loses to a delete made elsewhere, and does
// not even reach the server. CLAUDE.md: "an edit here wins over a delete there and revives the
// note". `DocStore.applyRemoteDelete` decides that by the file against the last agreement - but a
// device offline agrees with its own document at once, so its unsent edit counts as agreed. The
// note is trashed there, and `dropHandle` unregisters the room with the edit still in the outbox
// (unlike `evict`, which never lets go of an unacknowledged change): restored from the trash on
// another device, the note comes back without it.
//
//   cd packages/plugin && npx tsx --tsconfig scripts/tsconfig.json scripts/audit2/offline-edit-vs-delete.mts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, delay, Device, eventually, finish, useServer } from '../harness.mjs'

const { loadConfig } = await import('../../../server/src/config.js')
const { startServer } = await import('../../../server/src/server.js')

const root = mkdtempSync(join(tmpdir(), 'audit2-offline-edit-'))
const server = await startServer(
  loadConfig({ HOST: '127.0.0.1', PORT: '0', MYCEL_DATA_DIR: root, MYCEL_REGISTRATION: 'open', MYCEL_JWT_SECRET: 'audit2-offline-edit-secret-of-32-chars' }),
  { logger: false, paceMs: 0 }
)
useServer(`ws://127.0.0.1:${server.port}`)

const name = `oe${Date.now().toString(36)}`
const devices: Device[] = []
try {
  const desk = new Device(name, true, { 'Trip.md': 'day one\n', 'Other.md': 'other\n' })
  devices.push(desk)
  check(await desk.boot(), 'the desktop starts')
  const laptop = new Device(name, false)
  devices.push(laptop)
  check(await laptop.boot(), 'the laptop starts')
  check(await eventually(() => laptop.vault.text('Trip.md') === 'day one\n'), 'the laptop has the note')
  const docId = desk.index?.docIdForPath('Trip.md') as string

  // The laptop loses its connection on the way out: nothing it sends arrives (pushes dropped, as vault-selftest does).
  const ws = (laptop.socket as unknown as { ws: { send(data: Uint8Array): void; close(): void } }).ws
  const send = ws.send.bind(ws)
  ws.send = (data: Uint8Array) => {
    if (data[0] !== 3) send(data)
  }
  await laptop.vault.userWrite('Trip.md', 'day one\nday two - written on the train\n')
  check(await eventually(() => laptop.docText('Trip.md') === 'day one\nday two - written on the train\n'), 'the laptop takes the edit into its note, unsent')
  await delay(1_000)
  check(laptop.store?.noteState(laptop.vault.file('Trip.md')) === 'unsent', 'and shows it as unsent', laptop.store?.noteState(laptop.vault.file('Trip.md')))

  // Meanwhile the note is deleted on the desktop.
  await desk.vault.trash(desk.vault.file('Trip.md'))
  check(await eventually(() => laptop.index?.entry(docId)?.deletedAt !== undefined), "the delete reaches the laptop's index")
  await delay(2_000)
  const kept = laptop.vault.text('Trip.md') !== undefined
  check(kept, 'EXPECTED SAFE: the laptop keeps the note it changed after the delete (FAILS = trashed there)', laptop.vault.paths())

  // The connection comes back.
  ws.send = send
  ws.close()
  await delay(4_000)
  const item = desk.trash?.list().find((candidate) => candidate.id === docId)
  check(item !== undefined, 'the note is in the trash on the desktop')
  if (item) await desk.trash?.restore(item)
  check(await eventually(() => desk.vault.text('Trip.md') !== undefined, 10_000), 'restored from the trash')
  console.log('      restored text:', JSON.stringify(desk.vault.text('Trip.md')))
  check(
    (desk.vault.text('Trip.md') ?? '').includes('day two'),
    'EXPECTED SAFE: what the laptop wrote reached the server and comes back with the note (FAILS = it stayed behind in the laptop\'s outbox)'
  )
} catch (error) {
  check(false, 'the reproduction ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  for (const device of devices) await device.shutdown().catch(() => undefined)
  await server.close()
  rmSync(root, { recursive: true, force: true })
}
finish()
