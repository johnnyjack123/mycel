// Checks that history survives a room going idle and the server restarting.
// Runs the room layer in-process against a scratch directory - no server, no
// port, nothing near the real data.
//
//   npm run test:rooms
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import { CONTENT_FIELD } from '@obsidian-connect/shared'
import { RoomManager, type RoomSubscriber } from '../src/rooms.js'
import { Y } from '../src/yjs.js'

const failures: string[] = []
function check(ok: boolean, label: string, detail?: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`)
  if (!ok) {
    failures.push(label)
    if (detail !== undefined) console.log('      got:', JSON.stringify(detail))
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const dataDir = mkdtempSync(join(tmpdir(), 'oc-rooms-selftest-'))
const room = 'doc:rooms-selftest'
const IDLE_MS = 50

const subscriber: RoomSubscriber = { sendSync: () => undefined, sendAwareness: () => undefined }

function syncMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  syncProtocol.writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}

const client = new Y.Doc()
const text = client.getText(CONTENT_FIELD)
const pending: Uint8Array[] = []
client.on('update', (update: Uint8Array) => pending.push(update))

/** Applies one edit and returns a timestamp that falls after it and before the next. */
async function edit(manager: RoomManager, change: () => void): Promise<number> {
  change()
  for (const update of pending.splice(0)) await manager.handleSync(room, syncMessage(update), subscriber)
  // Versions are keyed by millisecond, and a replay includes a version stamped
  // exactly at the requested time. Without room on both sides the next edit
  // can land in the same millisecond as the returned timestamp.
  await delay(15)
  const between = Date.now()
  await delay(15)
  return between
}

try {
  const first = new RoomManager({ dataDir, historyRetentionDays: 30, idleCloseMs: IDLE_MS })
  await first.subscribe(room, subscriber)
  const afterFirst = await edit(first, () => text.insert(0, 'first\n'))
  const afterSecond = await edit(first, () => text.insert(text.length, 'second\n'))

  check((await first.textAt(room, afterFirst)) === 'first\n', 'an older version replays to its own text')

  // The room closes once nobody is left in it. Closing used to write a
  // snapshot of the current state, which every later replay started from.
  first.unsubscribe(room, subscriber)
  await delay(IDLE_MS * 6)

  check(
    (await first.textAt(room, afterFirst)) === 'first\n',
    'an idle close keeps older versions intact',
    await first.textAt(room, afterFirst)
  )
  check((await first.textAt(room, afterSecond)) === 'first\nsecond\n', 'the latest version is unchanged')

  await first.shutdown()

  const second = new RoomManager({ dataDir, historyRetentionDays: 30, idleCloseMs: IDLE_MS })
  check(
    (await second.textAt(room, afterFirst)) === 'first\n',
    'a restart keeps older versions intact',
    await second.textAt(room, afterFirst)
  )

  await second.restore(room, afterFirst)
  await delay(15)
  check(
    (await second.textAt(room, Date.now())) === 'first\n',
    'restoring after a restart rolls the document back',
    await second.textAt(room, Date.now())
  )
  check((await second.versions(room)).length === 3, 'the restore is a version of its own')
  await second.shutdown()
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
