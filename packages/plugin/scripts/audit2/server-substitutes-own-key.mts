// Audit 2, finding: the server puts a key of its own into the victim's friend codes, and then
// reads what the victim's contacts share with the victim.
//
// `Session.unlockWith` takes the account's public keys (`publicKey`, `signingPublicKey`) from the
// bundle the server sends at every start; only the private halves are unwrapped under the master
// key, and nothing checks that the public halves belong to them. The friend code's fingerprint -
// the one thing that keeps the server out of a contact exchange (P5) - is computed from those
// public halves (`Contacts.createCode`), so it vouches for the server's key. The contact pins it,
// seals every key of what they share with the victim to it, and the server opens them.
//
// Here the "server" is the test: it hands the victim's device a bundle with its own ECDH key, and
// afterwards opens the note key the contact sealed and decrypts the note.
//
//   cd packages/plugin && npx tsx --tsconfig scripts/tsconfig.json scripts/audit2/server-substitutes-own-key.mts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, Device, eventually, finish, useServer } from '../harness.mjs'

const Y = await import('yjs')
const { docRoom, frameAad, snapshotAad, CONTENT_FIELD } = await import('@mycel/shared')
const { aesKey, decrypt, epochKeyContext, fromBase64, generateIdentity, importPrivateKey, splitSealed, toBase64, unpackFrame, unseal } = await import('@mycel/shared/crypto')
const { loadConfig } = await import('../../../server/src/config.js')
const { startServer } = await import('../../../server/src/server.js')

const root = mkdtempSync(join(tmpdir(), 'audit2-own-key-'))
const server = await startServer(
  loadConfig({ HOST: '127.0.0.1', PORT: '0', MYCEL_DATA_DIR: root, MYCEL_REGISTRATION: 'open', MYCEL_JWT_SECRET: 'audit2-own-key-secret-of-32-characters!' }),
  { logger: false, paceMs: 0 }
)
useServer(`ws://127.0.0.1:${server.port}`)

const run = Date.now().toString(36)
const devices: Device[] = []
try {
  const victim = new Device(`vic${run}`, true, { 'Mine.md': 'mine\n' })
  const contact = new Device(`con${run}`, true, { 'For V.md': 'the contact writes this for the victim only\n' })
  devices.push(victim, contact)
  check((await victim.boot()) && (await contact.boot()), 'the victim and a future contact start')

  // The server's own key pair, and the bundle it hands the victim's device at its next start.
  const servers = await generateIdentity()
  await victim.shutdown()
  const api = victim.api as unknown as { account(): Promise<Record<string, unknown>> }
  const original = api.account.bind(api)
  api.account = async () => ({ ...(await original()), publicKey: toBase64(servers.publicKey) })
  check(await victim.boot(), "the victim's device starts again, with the server's bundle")

  // The same server answers the contact's lookup of the code with the same key. (A real one would
  // also open the contact's introduction with its key and seal it on to the victim's real one -
  // the MAC inside needs no key of its own; left out here, so the victim's side stays unfinished.)
  const contactApi = contact.api as unknown as { contactCode(codeId: string): Promise<Record<string, unknown>> }
  const lookUp = contactApi.contactCode.bind(contactApi)
  contactApi.contactCode = async (codeId) => ({ ...(await lookUp(codeId)), publicKey: toBase64(servers.publicKey) })

  const code = await (victim.contacts as NonNullable<typeof victim.contacts>).createCode()
  let refused: string | null = null
  await contact.contacts?.redeem(code).catch((error: unknown) => {
    refused = error instanceof Error ? error.message : String(error)
  })
  check(refused !== null, "EXPECTED SAFE: the contact's device refuses a code whose keys the server chose (FAILS = the fingerprint vouched for the server's key)", refused)
  if (refused !== null) {
    // The attack ends here (fixed, 0.9.33): no contact is made under the server's key.
    check(contact.contacts?.isContact(victim.accountId) !== true, 'EXPECTED SAFE: the contact did not take the victim for a contact under a key the server chose')
  } else {
  check(await eventually(() => contact.contacts?.isContact(victim.accountId) === true, 15_000), 'the contact now counts the victim as a contact')
  const pinned = contact.settings?.contact(victim.accountId)?.publicKey
  check(pinned !== toBase64(servers.publicKey), "EXPECTED SAFE: the contact pins the victim's own key (FAILS = it pinned the server's)", { pinned })

  // The contact shares a note with the victim. The server opens the key sealed to "the victim".
  const docId = contact.index?.docIdForPath('For V.md') as string
  await contact.sharing?.share(docId, victim.accountId, 'read', true)
  const room = docRoom(docId)
  let read: string | null = null
  await eventually(async () => {
    const keys = await victim.api.keys(room).catch(() => null)
    const sealed = keys ? Object.entries(keys.keys) : []
    if (sealed.length === 0) return false
    const own = await importPrivateKey(servers.privateKey)
    const noteKeys = new Map<number, CryptoKey>()
    for (const [epoch, value] of sealed) {
      const parts = splitSealed(value)
      if (!parts) continue
      const raw = await unseal(own, servers.publicKey, parts.sealed, epochKeyContext(room, Number(epoch))).catch(() => null)
      if (raw) noteKeys.set(Number(epoch), await aesKey(raw))
    }
    if (noteKeys.size === 0) return false
    const log = await victim.api.log(room)
    const doc = new Y.Doc()
    const open = async (epoch: number, data: string, aad: string): Promise<void> => {
      const key = noteKeys.get(epoch)
      if (!key) return
      const frame = unpackFrame(await decrypt(key, fromBase64(data), aad))
      if (frame) Y.applyUpdate(doc, frame.update)
    }
    if (log.snapshot) await open(log.snapshot.epoch, log.snapshot.data, snapshotAad(room, log.snapshot.epoch))
    for (const frame of log.frames) await open(frame.epoch, frame.data, frameAad(room, frame.epoch))
    read = doc.getText(CONTENT_FIELD).toString()
    return read.length > 0
  }, 15_000)
  console.log('      what the server reads of the shared note:', JSON.stringify(read))
  check(read === null || read === '', 'EXPECTED SAFE: the server cannot read a note a contact shares with the victim (FAILS = finding reproduced)')
  }
} catch (error) {
  check(false, 'the reproduction ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  for (const device of devices) await device.shutdown().catch(() => undefined)
  await server.close()
  rmSync(root, { recursive: true, force: true })
}
finish()
