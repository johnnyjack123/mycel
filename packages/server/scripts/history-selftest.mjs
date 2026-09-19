// Checks the version history end to end: every edit becomes a restorable
// version, and restoring rolls the live document back through the normal sync
// path rather than replacing it behind the clients' backs.
//
//   npm run start:server
//   npm run test:history -- ws://localhost:1234
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'

const serverUrl = process.argv[2] ?? process.env.OBSIDIAN_CONNECT_URL ?? 'ws://localhost:1234'
const httpUrl = serverUrl.replace(/^ws/, 'http').replace(/\/+$/, '')
const room = `history-selftest-${Date.now().toString(36)}`
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const failures = []
function check(ok, label, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`)
  if (!ok) {
    failures.push(label)
    if (detail !== undefined) console.log('      got:', JSON.stringify(detail))
  }
}

async function api(path, init) {
  const response = await fetch(`${httpUrl}/history/${encodeURIComponent(room)}${path}`, init)
  if (!response.ok) throw new Error(`${path} -> ${response.status}`)
  return response.json()
}

const doc = new Y.Doc()
const text = doc.getText('content')
const provider = new WebsocketProvider(serverUrl, room, doc, { WebSocketPolyfill: WebSocket })

await Promise.race([
  new Promise((resolve) => provider.once('sync', resolve)),
  delay(6_000)
])
check(provider.synced, 'connected to the server')

text.insert(0, 'first version\n')
await delay(700)
const afterFirst = text.toString()

text.insert(text.length, 'second version\n')
await delay(700)

text.insert(text.length, 'third version\n')
await delay(1_000)

const { versions } = await api('/versions')
check(versions.length >= 3, 'every edit is recorded as a version', versions.length)

// The timestamp of the first edit must still reproduce the note as it was then.
const sorted = versions.slice().sort((a, b) => a.ts - b.ts)
const firstTs = sorted[0].ts
const { text: firstText } = await api(`/text?ts=${firstTs}`)
check(firstText === afterFirst, 'replaying to a timestamp reproduces that state', firstText)

const latest = text.toString()
check(latest.includes('third version'), 'the live document has all three edits')

await api('/restore', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ts: firstTs })
})
await delay(1_200)

check(text.toString() === afterFirst, 'restoring reaches the connected client', text.toString())

// A restore is an edit like any other, so it is itself restorable.
const after = await api('/versions')
check(after.versions.length > versions.length, 'the restore is recorded as a new version')

const { text: stillLatest } = await api(`/text?ts=${Date.now()}`)
check(stillLatest === afterFirst, 'the newest version is the restored state')

provider.destroy()
doc.destroy()

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
