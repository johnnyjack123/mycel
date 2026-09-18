import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'

// y-websocket defaults to the global WebSocket, which Node only exposes from
// v22 on. `engines` allows Node 20, so the polyfill has to be explicit.
const providerOptions = { WebSocketPolyfill: WebSocket }

const serverUrl = process.argv[2] ?? process.env.CRDT_SYNC_URL ?? 'ws://localhost:1234'
const room = `selftest-${Date.now().toString(36)}`
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function whenSynced(provider) {
  if (provider.synced) return Promise.resolve()
  return new Promise((resolve) => provider.once('sync', () => resolve()))
}

async function run() {
  const docA = new Y.Doc()
  const docB = new Y.Doc()
  const providerA = new WebsocketProvider(serverUrl, room, docA, providerOptions)
  const providerB = new WebsocketProvider(serverUrl, room, docB, providerOptions)

  try {
    console.log(`connecting two clients to ${serverUrl} room=${room}`)
    await Promise.race([
      Promise.all([whenSynced(providerA), whenSynced(providerB)]),
      delay(6000).then(() => {
        throw new Error('timeout waiting for initial sync')
      })
    ])

    docA.getText('content').insert(0, 'hello-from-a')
    await delay(1500)

    const received = docB.getText('content').toString()
    if (received === 'hello-from-a') {
      console.log('PASS: server relayed the update between two clients')
    } else {
      console.error(`FAIL: client B received ${JSON.stringify(received)}`)
      process.exitCode = 1
    }
  } catch (error) {
    console.error(`FAIL: ${error.message}`)
    process.exitCode = 1
  } finally {
    providerA.destroy()
    providerB.destroy()
    docA.destroy()
    docB.destroy()
  }
}

await run()
process.exit(process.exitCode ?? 0)
