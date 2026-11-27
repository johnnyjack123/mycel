// Audit 2, finding: one frame of bytes no key opens - pushed by anyone who may write in a note
// the victim shares - stops *Replace all keys* for good (`KeyReplacement.open`: "no key opens
// ... nothing of it was changed"). Every device drops such a frame (`frameVerdict`), so nobody
// notices it, but the replacement reads every frame and throws. main.ts then syncs nothing
// ("nothing syncs until they are"), and every later attempt meets the same frame: the account is
// stuck with the keys it wanted to replace - after a suspected theft, which is when it is used.
//
//   cd packages/plugin && npx tsx --tsconfig scripts/tsconfig.json scripts/audit2/replace-keys-blocked.mts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, delay, Device, eventually, finish, useServer } from '../harness.mjs'

const { docRoom, MUX } = await import('@mycel/shared')
const encoding = await import('lib0/encoding')
const { loadConfig } = await import('../../../server/src/config.js')
const { startServer } = await import('../../../server/src/server.js')

const root = mkdtempSync(join(tmpdir(), 'audit2-replace-blocked-'))
const server = await startServer(
  loadConfig({ HOST: '127.0.0.1', PORT: '0', MYCEL_DATA_DIR: root, MYCEL_REGISTRATION: 'open', MYCEL_JWT_SECRET: 'audit2-replace-blocked-secret-32-chars' }),
  { logger: false, paceMs: 0, maxFailures: 1_000 }
)
useServer(`ws://127.0.0.1:${server.port}`)

const run = Date.now().toString(36)
const NEXT = 'an entirely new horse, battery and staple'
const devices: Device[] = []
try {
  const victim = new Device(`vic${run}`, true, { 'Notes/Together.md': 'our notes\n', 'Mine.md': 'mine\n' })
  const writer = new Device(`wri${run}`, true, { 'Own.md': 'own\n' })
  devices.push(victim, writer)
  check((await victim.boot()) && (await writer.boot()), 'the victim and a contact start')
  const code = await (writer.contacts as NonNullable<typeof writer.contacts>).createCode()
  await victim.contacts?.redeem(code)
  check(await eventually(() => writer.contacts?.isContact(victim.accountId) === true && victim.contacts?.isContact(writer.accountId) === true, 15_000), 'they are contacts')
  const docId = victim.index?.docIdForPath('Notes/Together.md') as string
  await victim.sharing?.share(docId, writer.accountId, 'write', true)
  check(await eventually(() => writer.vault.text('Shared/Together.md') === 'our notes\n', 15_000), 'the victim shares a note with the contact, to write')

  // The writer pushes 64 random bytes into the note's log - what any client may send.
  const room = docRoom(docId)
  const epoch = writer.socket?.epochOf(room) ?? 0
  const message = encoding.createEncoder()
  encoding.writeVarUint(message, MUX.push)
  encoding.writeVarString(message, room)
  encoding.writeVarUint(message, 987_654)
  encoding.writeVarUint(message, epoch)
  encoding.writeVarUint8Array(message, crypto.getRandomValues(new Uint8Array(64)))
  const ws = (writer.socket as unknown as { ws: { send(data: Uint8Array): void } }).ws
  ws.send(encoding.toUint8Array(message))
  check(await eventually(async () => (await victim.api.wholeLog(room)).frames.length >= 2, 10_000), 'the server stored the frame in the log of the victim\'s note')
  await victim.vault.userWrite('Mine.md', 'mine\nstill syncing\n')
  await delay(1_500)
  check(victim.vault.text('Notes/Together.md') === 'our notes\n', "the victim's devices drop it, nothing to see")
  await writer.vault.userWrite('Shared/Together.md', 'our notes\nwritten after it\n')
  check(await eventually(() => victim.vault.text('Notes/Together.md') === 'our notes\nwritten after it\n', 10_000), 'and the room goes on: what the writer writes next arrives', victim.vault.text('Notes/Together.md'))

  // Later the victim suspects a theft and replaces every key.
  await victim.shutdown()
  let stopped: string | null = null
  try {
    await victim.replaceKeys(NEXT)
  } catch (error) {
    stopped = error instanceof Error ? error.message : String(error)
  }
  console.log('      the replacement says:', stopped)
  check(stopped === null, 'EXPECTED SAFE: the replacement completes (FAILS = finding reproduced: it stops at the frame)')
  // What main.ts does at every start until the replacement finished: carry it on, and sync nothing if it fails.
  let again: string | null = null
  try {
    await victim.boot()
  } catch (error) {
    again = error instanceof Error ? error.message : String(error)
  }
  console.log('      the next start says:', again)
  check(again === null, 'EXPECTED SAFE: the next start syncs again (FAILS = it meets the same frame again, nothing syncs)')
} catch (error) {
  check(false, 'the reproduction ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  for (const device of devices) await device.shutdown().catch(() => undefined)
  await server.close()
  rmSync(root, { recursive: true, force: true })
}
finish()
