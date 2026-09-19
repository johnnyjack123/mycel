// Exercises the multiplexed vault transport against a running server: many
// documents over one WebSocket, which is what makes syncing a whole vault
// possible at all.
//
//   npm run start:server
//   npm run test:socket -w @crdt-sync/plugin -- ws://localhost:1234
import { WebSocket as NodeWebSocket } from 'ws'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { CONTENT_FIELD, docRoom, indexRoom } from '@crdt-sync/shared'

// VaultSocket targets the browser environment Obsidian runs in. Supplying the
// two globals it uses is lighter than a full DOM.
const globals = globalThis as Record<string, unknown>
globals.WebSocket = NodeWebSocket
globals.window = {
  setTimeout: (handler: () => void, ms?: number) => setTimeout(handler, ms) as unknown as number,
  clearTimeout: (id?: number) => clearTimeout(id as unknown as NodeJS.Timeout)
}

const { VaultSocket } = await import('../src/sync/VaultSocket.js')

const serverUrl = process.argv[2] ?? process.env.CRDT_SYNC_URL ?? 'ws://localhost:1234'
const vaultId = `socket-selftest-${Date.now().toString(36)}`
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const failures: string[] = []
function check(ok: boolean, label: string, detail?: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`)
  if (!ok) {
    failures.push(label)
    if (detail !== undefined) console.log('      got:', JSON.stringify(detail))
  }
}

const user = { id: 'tester', name: 'Tester', color: '#30bced', colorLight: '#30bced33' }

const socketA = new VaultSocket(serverUrl, vaultId, '')
const socketB = new VaultSocket(serverUrl, vaultId, '')
socketA.connect()
socketB.connect()

const rooms = ['alpha', 'bravo', 'charlie'].map((name) => docRoom(`${vaultId}-${name}`))
const docsA = rooms.map(() => new Y.Doc())
const docsB = rooms.map(() => new Y.Doc())

const readyA = rooms.map((room, i) => socketA.register(room, docsA[i] as Y.Doc, null))
const readyB = rooms.map((room, i) => socketB.register(room, docsB[i] as Y.Doc, null))

await Promise.race([Promise.all([...readyA, ...readyB]), delay(8_000)])
check(
  rooms.every((room) => socketA.isSynced(room) && socketB.isSynced(room)),
  'three documents synced over one socket each'
)

// Every document must stay independent even though they share a connection.
rooms.forEach((_room, i) => {
  ;(docsA[i] as Y.Doc).getText(CONTENT_FIELD).insert(0, `content ${i}`)
})
await delay(1_200)
check(
  rooms.every((_room, i) => (docsB[i] as Y.Doc).getText(CONTENT_FIELD).toString() === `content ${i}`),
  'each document arrives in the right room',
  rooms.map((_r, i) => (docsB[i] as Y.Doc).getText(CONTENT_FIELD).toString())
)

// Concurrent edits on the same document still converge.
;(docsA[0] as Y.Doc).getText(CONTENT_FIELD).insert(0, 'A:')
;(docsB[0] as Y.Doc).getText(CONTENT_FIELD).insert(0, 'B:')
await delay(1_500)
check(
  (docsA[0] as Y.Doc).getText(CONTENT_FIELD).toString() ===
    (docsB[0] as Y.Doc).getText(CONTENT_FIELD).toString(),
  'concurrent edits converge over the multiplexed socket',
  (docsA[0] as Y.Doc).getText(CONTENT_FIELD).toString()
)

// The vault index travels over the same connection as the notes.
const indexA = new Y.Doc()
const indexB = new Y.Doc()
await Promise.race([
  Promise.all([
    socketA.register(indexRoom(vaultId), indexA, null),
    socketB.register(indexRoom(vaultId), indexB, null)
  ]),
  delay(6_000)
])
indexA.getMap('files').set('doc-1', { path: 'Note.md', updatedAt: Date.now() })
await delay(1_200)
check(
  (indexB.getMap('files').get('doc-1') as { path?: string } | undefined)?.path === 'Note.md',
  'the vault index syncs alongside the notes'
)

// Awareness is per document, not per connection.
const awarenessA = new Awareness(docsA[1] as Y.Doc)
awarenessA.setLocalStateField('user', user)
const awarenessB = new Awareness(docsB[1] as Y.Doc)
socketA.unregister(rooms[1] as string)
socketB.unregister(rooms[1] as string)
await socketA.register(rooms[1] as string, docsA[1] as Y.Doc, awarenessA)
await socketB.register(rooms[1] as string, docsB[1] as Y.Doc, awarenessB)
awarenessA.setLocalStateField('cursor', { anchor: 0, head: 0 })
await delay(1_200)
const seen = Array.from(awarenessB.getStates().values()).some(
  (state) => (state as { user?: { name?: string } }).user?.name === 'Tester'
)
check(seen, 'awareness reaches the other client')

// Unsubscribing must stop traffic for that document only.
socketB.unregister(rooms[2] as string)
await delay(300)
;(docsA[2] as Y.Doc).getText(CONTENT_FIELD).insert(0, 'after unsubscribe ')
await delay(1_000)
check(
  !(docsB[2] as Y.Doc).getText(CONTENT_FIELD).toString().startsWith('after unsubscribe'),
  'an unsubscribed document stops receiving updates'
)
;(docsA[0] as Y.Doc).getText(CONTENT_FIELD).insert(0, 'still live ')
await delay(1_000)
check(
  (docsB[0] as Y.Doc).getText(CONTENT_FIELD).toString().startsWith('still live'),
  'the other documents keep syncing'
)

socketA.destroy()
socketB.destroy()
for (const doc of [...docsA, ...docsB, indexA, indexB]) doc.destroy()

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
