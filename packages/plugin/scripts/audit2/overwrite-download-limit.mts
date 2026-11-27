// Audit 2, finding: "Overwrite the server with this vault" (0.9.33) on a device with a download
// limit - a phone, 10 MB by default - deletes every file above the limit on the server and on
// every other device. Those files were never in the phone's vault, so the comparison lists them
// as "only the server has", and the join window offers to overwrite exactly then ("the same
// state, but the server has more").
//
//   cd packages/plugin && npx tsx --tsconfig scripts/tsconfig.json scripts/audit2/overwrite-download-limit.mts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, delay, Device, eventually, finish, useServer } from '../harness.mjs'

const { loadConfig } = await import('../../../server/src/config.js')
const { startServer } = await import('../../../server/src/server.js')

const root = mkdtempSync(join(tmpdir(), 'audit2-overwrite-limit-'))
const server = await startServer(
  loadConfig({ HOST: '127.0.0.1', PORT: '0', MYCEL_DATA_DIR: root, MYCEL_REGISTRATION: 'open', MYCEL_JWT_SECRET: 'audit2-overwrite-secret-of-32-chars!!' }),
  { logger: false, paceMs: 0 }
)
useServer(`ws://127.0.0.1:${server.port}`)

const name = `ow${Date.now().toString(36)}`
const BIG = new Uint8Array(4096).fill(7) // "large": above the phone's limit below
const SMALL = new Uint8Array([1, 2, 3])
const devices: Device[] = []
try {
  const desktop = new Device(name, true, { 'Note.md': 'hello\n', 'small.png': SMALL, 'Scans/contract.pdf': BIG })
  devices.push(desktop)
  check(await desktop.boot(), 'the desktop starts and uploads its vault')
  check(await eventually(async () => (await desktop.sync?.notYetSent(1_000)) === null), 'and everything went up')

  // The phone syncs with a download limit: the large PDF stays on the server.
  const phone = new Device(name, false)
  phone.downloadLimit = 1024
  devices.push(phone)
  check(await phone.boot(), 'the phone starts')
  check(await eventually(() => phone.vault.text('Note.md') === 'hello\n' && phone.vault.bytes('small.png') !== undefined), 'the phone has the note and the small file')
  await delay(1_000)
  check(phone.vault.bytes('Scans/contract.pdf') === undefined, 'and, by its download limit, not the large PDF')

  // Later the user disconnects the phone (as CLAUDE.md says, the way a device that synced
  // before reaches "Overwrite the server") and joins again, choosing to overwrite.
  const vaultId = phone.keys?.vaultId as string
  await phone.shutdown()
  await phone.disconnect(vaultId)
  phone.joinAnswer = 'here'
  check(await phone.boot(), 'signed in again, the phone joins')
  const plan = phone.joinPlans.at(-1)
  console.log('      plan:', JSON.stringify({ kind: plan?.kind, notes: plan?.notes, files: plan?.files }))
  check(
    plan?.kind === 'same' && plan.files.onlyThere.includes('Scans/contract.pdf'),
    'the comparison calls it the same state, the server having more: the large PDF counts as "only the server has" - the case where the window offers to overwrite'
  )
  const result = phone.joinResults.at(-1)
  check(result?.ok === true && result.choice === 'here' && result.trashed === 1, 'overwriting deletes it on the server', result)

  // The desktop, which has the file and never deleted it, loses it too.
  const gone = await eventually(() => desktop.vault.bytes('Scans/contract.pdf') === undefined, 10_000)
  const fileId = desktop.attachmentIndex?.idForPath('Scans/contract.pdf')
  console.log('      desktop index entry:', JSON.stringify(fileId ? desktop.attachmentIndex?.entry(fileId) : null))
  check(!gone, 'EXPECTED SAFE: the desktop keeps a file the phone never downloaded (FAILS = finding reproduced: it was trashed on the desktop)')
} catch (error) {
  check(false, 'the reproduction ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  for (const device of devices) await device.shutdown().catch(() => undefined)
  await server.close()
  rmSync(root, { recursive: true, force: true })
}
finish()
