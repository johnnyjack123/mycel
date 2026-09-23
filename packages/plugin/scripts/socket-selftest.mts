// The encrypted vault transport against a running server: two devices of one
// account, many documents over one socket each, the outbox across a
// disconnect and a crash, presence, and who may open a vault's connection.
// Everything the server sees is ciphertext.
//
//   PORT=1235 OBSIDIAN_CONNECT_REGISTRATION=open OBSIDIAN_CONNECT_DATA_DIR=<scratch> npm run start:server
//   npm run test:socket -- ws://localhost:1235
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { CONTENT_FIELD, docRoom, indexRoom } from '@obsidian-connect/shared'

// VaultSocket targets the browser Obsidian runs in: Node 22+ has a WebSocket,
// the timers need a `window`.
;(globalThis as Record<string, unknown>).window = globalThis

const { ConnectApi, fetchHttp } = await import('../src/account/api.js')
const { Session } = await import('../src/account/Session.js')
const { KeyRing } = await import('../src/account/KeyRing.js')
const { hashWasmArgon2id } = await import('../src/account/argon2.js')
const { VaultSocket, memoryCursor } = await import('../src/sync/VaultSocket.js')
const { LocalCursor } = await import('../src/sync/DocHandle.js')

const serverUrl = process.argv[2] ?? process.env.OBSIDIAN_CONNECT_URL ?? 'ws://localhost:1234'
const run = Date.now().toString(36)
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const failures: string[] = []
function check(ok: boolean, label: string, detail?: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`)
  if (!ok) {
    failures.push(label)
    if (detail !== undefined) console.log('      got:', JSON.stringify(detail))
  }
}

async function eventually(predicate: () => boolean, timeoutMs = 6_000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await delay(40)
  }
  return predicate()
}

async function device(username: string, password: string, create: boolean) {
  let token: string | null = null
  const secrets = new Map<string, string>()
  const api = new ConnectApi(() => serverUrl, fetchHttp, () => token)
  const session = new Session(
    api,
    { load: (key) => secrets.get(key) ?? null, save: (key, value) => (value === null ? secrets.delete(key) : secrets.set(key, value)) },
    hashWasmArgon2id,
    async (next) => {
      token = next
    }
  )
  const unlocked = create ? await session.register(username, password) : await session.login(username, password)
  const vault = await session.openVault(unlocked, 'Socket test')
  const keys = new KeyRing(vault, unlocked, api, { load: () => null, save: () => undefined })
  const socket = new VaultSocket(serverUrl, vault.vaultId, () => token ?? '')
  return { api, session, unlocked, vault, keys, socket, token: () => token }
}

const username = `socket-${run}`
const one = await device(username, 'a long enough password', true)
const two = await device(username, 'a long enough password', false)
check(one.vault.vaultId === two.vault.vaultId, 'both devices open the same vault by name')

one.socket.connect()
two.socket.connect()

const ids = await Promise.all(['alpha', 'bravo', 'charlie'].map((name) => one.keys.docId(`${name}.md`, 0)))
check(ids.join() === (await Promise.all(['alpha', 'bravo', 'charlie'].map((name) => two.keys.docId(`${name}.md`, 0)))).join(), 'and derive the same note ids')

const docsOne = ids.map(() => new Y.Doc())
const docsTwo = ids.map(() => new Y.Doc())
const readyOne = ids.map((id, i) =>
  one.socket.register(docRoom(id), docsOne[i] as Y.Doc, { crypto: one.keys.ownDocCrypto(id), cursor: memoryCursor() })
)
const readyTwo = ids.map((id, i) =>
  two.socket.register(docRoom(id), docsTwo[i] as Y.Doc, { crypto: two.keys.ownDocCrypto(id), cursor: memoryCursor() })
)
await Promise.race([Promise.all([...readyOne, ...readyTwo]), delay(8_000)])
check(ids.every((id) => one.socket.isSynced(docRoom(id)) && two.socket.isSynced(docRoom(id))), 'three documents synced over one socket each')

ids.forEach((_id, i) => (docsOne[i] as Y.Doc).getText(CONTENT_FIELD).insert(0, `content ${i}`))
check(
  await eventually(() => ids.every((_id, i) => (docsTwo[i] as Y.Doc).getText(CONTENT_FIELD).toString() === `content ${i}`)),
  'each document arrives in the right room, decrypted',
  docsTwo.map((doc) => doc.getText(CONTENT_FIELD).toString())
)

;(docsOne[0] as Y.Doc).getText(CONTENT_FIELD).insert(0, 'A:')
;(docsTwo[0] as Y.Doc).getText(CONTENT_FIELD).insert(0, 'B:')
check(
  await eventually(
    () =>
      (docsOne[0] as Y.Doc).getText(CONTENT_FIELD).toString() === (docsTwo[0] as Y.Doc).getText(CONTENT_FIELD).toString() &&
      (docsOne[0] as Y.Doc).getText(CONTENT_FIELD).length === 'A:B:content 0'.length
  ),
  'concurrent edits converge',
  (docsOne[0] as Y.Doc).getText(CONTENT_FIELD).toString()
)

// What the server stores is ciphertext.
{
  const log = await one.api.log(docRoom(ids[1] as string))
  const stored = log.frames.map((frame) => Buffer.from(frame.data, 'base64').toString('latin1')).join('')
  check(log.frames.length > 0 && !stored.includes('content 1'), 'the server holds no readable text', stored.slice(0, 40))
}

// The vault index travels over the same connection, under its own key.
{
  const indexOne = new Y.Doc()
  const indexTwo = new Y.Doc()
  await Promise.race([
    Promise.all([
      one.socket.register(indexRoom(one.vault.vaultId), indexOne, { crypto: one.keys.indexCrypto(), cursor: memoryCursor() }),
      two.socket.register(indexRoom(two.vault.vaultId), indexTwo, { crypto: two.keys.indexCrypto(), cursor: memoryCursor() })
    ]),
    delay(6_000)
  ])
  indexOne.getMap('files').set('doc-1', { path: 'Note.md', updatedAt: Date.now() })
  check(
    await eventually(() => (indexTwo.getMap('files').get('doc-1') as { path?: string } | undefined)?.path === 'Note.md'),
    'the vault index syncs alongside the notes'
  )
}

// Changes made while disconnected stay in the outbox and go out on reconnect.
{
  const id = await one.keys.docId('offline.md', 0)
  const docOne = new Y.Doc()
  const docTwo = new Y.Doc()
  const cursorTwo = memoryCursor()
  await one.socket.register(docRoom(id), docOne, { crypto: one.keys.ownDocCrypto(id), cursor: memoryCursor() })
  // A device without a connection: registered, but nothing gets through.
  const offline = new VaultSocket('ws://127.0.0.1:9', two.vault.vaultId, () => two.token() ?? '')
  void offline.register(docRoom(id), docTwo, { crypto: two.keys.ownDocCrypto(id), cursor: cursorTwo })
  docTwo.getText(CONTENT_FIELD).insert(0, 'written offline')
  await delay(200)
  check(Boolean(cursorTwo.outbox ?? cursorTwo.sending), 'an edit made offline waits in the outbox')
  offline.destroy()
  const again = new VaultSocket(serverUrl, two.vault.vaultId, () => two.token() ?? '')
  again.connect()
  await again.register(docRoom(id), docTwo, { crypto: two.keys.ownDocCrypto(id), cursor: cursorTwo })
  check(
    await eventually(() => docOne.getText(CONTENT_FIELD).toString() === 'written offline'),
    'and reaches the other device after reconnecting',
    docOne.getText(CONTENT_FIELD).toString()
  )
  check(await eventually(() => !cursorTwo.outbox && !cursorTwo.sending), 'the outbox empties once acknowledged')
  again.destroy()
}

// The document is stored locally the moment it changes. The outbox has to be
// stored with it: a crash in between leaves an edit on this device that is
// never sent, and every later edit built on it undecodable elsewhere.
{
  const id = await one.keys.docId('crash.md', 0)
  const saved = new Map<string, string>()
  const store = {
    whenSynced: Promise.resolve(),
    destroy: () => undefined,
    get: async (key: string) => saved.get(key) ?? null,
    set: async (key: string, value: string) => {
      saved.set(key, value)
    }
  }
  const cursor = await LocalCursor.load(store)
  const doc = new Y.Doc()
  const offline = new VaultSocket('ws://127.0.0.1:9', one.vault.vaultId, () => one.token() ?? '')
  void offline.register(docRoom(id), doc, { crypto: one.keys.ownDocCrypto(id), cursor })
  doc.getText(CONTENT_FIELD).insert(0, 'typed just before a crash')
  await delay(30)
  const stored = saved.get('cursor')
  check(Boolean(stored && (JSON.parse(stored) as { outbox?: string | null }).outbox), 'an unsent edit is stored as soon as it is made')
  offline.destroy()
}

// Presence travels encrypted too, and only where a room registers it.
{
  const id = await one.keys.docId('together.md', 0)
  const docOne = new Y.Doc()
  const docThree = new Y.Doc()
  const awarenessOne = new Awareness(docOne)
  awarenessOne.setLocalStateField('user', { name: 'Tester' })
  const awarenessThree = new Awareness(docThree)
  const three = new VaultSocket(serverUrl, one.vault.vaultId, () => one.token() ?? '')
  three.connect()
  await one.socket.register(docRoom(id), docOne, { crypto: one.keys.ownDocCrypto(id), cursor: memoryCursor(), awareness: awarenessOne })
  await three.register(docRoom(id), docThree, { crypto: one.keys.ownDocCrypto(id), cursor: memoryCursor(), awareness: awarenessThree })
  awarenessOne.setLocalStateField('cursor', { anchor: 0, head: 0 })
  check(
    await eventually(() =>
      Array.from(awarenessThree.getStates().values()).some((state) => (state as { user?: { name?: string } }).user?.name === 'Tester')
    ),
    'presence reaches the other client'
  )
  three.destroy()
}

// A vault's connection carries its index and settings, so only the account
// that owns the vault may open it - checked at the upgrade, before any room.
{
  const other = await device(`socket-other-${run}`, 'another long password', true)
  const opens = (token: string): Promise<boolean> =>
    new Promise((resolve) => {
      const ws = new WebSocket(`${serverUrl.replace(/\/+$/, '')}/vault/${one.vault.vaultId}?token=${encodeURIComponent(token)}`)
      const timer = setTimeout(() => {
        ws.close()
        resolve(false)
      }, 5_000)
      ws.onopen = () => {
        clearTimeout(timer)
        ws.close()
        resolve(true)
      }
      ws.onerror = () => {
        clearTimeout(timer)
        resolve(false)
      }
    })
  check(!(await opens(other.token() ?? '')), "another account's token does not open this vault")
  check(!(await opens('')), 'nor does no token')
  check(await opens(one.token() ?? ''), 'while its own does')
  other.socket.destroy()
}

// Unsubscribing stops one room only.
two.socket.unregister(docRoom(ids[2] as string))
;(docsOne[2] as Y.Doc).getText(CONTENT_FIELD).insert(0, 'after unsubscribe ')
;(docsOne[0] as Y.Doc).getText(CONTENT_FIELD).insert(0, 'still live ')
check(
  await eventually(() => (docsTwo[0] as Y.Doc).getText(CONTENT_FIELD).toString().startsWith('still live')),
  'the other documents keep syncing'
)
check(
  !(docsTwo[2] as Y.Doc).getText(CONTENT_FIELD).toString().startsWith('after unsubscribe'),
  'an unsubscribed document stops receiving updates'
)

one.socket.destroy()
two.socket.destroy()

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
