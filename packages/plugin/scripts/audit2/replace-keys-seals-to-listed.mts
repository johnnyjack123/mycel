// Audit 2, finding: *Replace all keys* seals a private note's keys to any contact the server
// lists as holding them. `KeyReplacement.sealKeys` seals every epoch named in the server's
// `wholeLog(room).keys[holder]` to each `holder`, and `recipient()` only asks that the holder be
// a contact - not that this account recorded giving them the note, as `Sharing.memberKeys` does
// since 0.9.0 (P6). A server that answers `keys: { <contact>: [0..epoch] }` for a private note
// gets that note's new keys sealed to the contact, signed by the victim - at the moment the
// person reacts to a suspected theft.
//
// The "server" here is a wrapper around `wholeLog`; the sealed keys are taken from the rewrite
// request and opened with the contact's private key, then the rewritten frames are read.
//
//   cd packages/plugin && npx tsx --tsconfig scripts/tsconfig.json scripts/audit2/replace-keys-seals-to-listed.mts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, Device, eventually, finish, useServer } from '../harness.mjs'

const Y = await import('yjs')
const { docRoom, frameAad, CONTENT_FIELD } = await import('@mycel/shared')
const { aesKey, decrypt, epochKeyContext, fromBase64, splitSealed, unpackFrame, unseal } = await import('@mycel/shared/crypto')
const { loadConfig } = await import('../../../server/src/config.js')
const { startServer } = await import('../../../server/src/server.js')

const root = mkdtempSync(join(tmpdir(), 'audit2-replace-seals-'))
const server = await startServer(
  loadConfig({ HOST: '127.0.0.1', PORT: '0', MYCEL_DATA_DIR: root, MYCEL_REGISTRATION: 'open', MYCEL_JWT_SECRET: 'audit2-replace-seals-secret-of-32-chars' }),
  { logger: false, paceMs: 0, maxFailures: 1_000 }
)
useServer(`ws://127.0.0.1:${server.port}`)

const run = Date.now().toString(36)
const devices: Device[] = []
try {
  const victim = new Device(`vic${run}`, true, { 'Private/Diary.md': 'nobody else reads this\n' })
  const contact = new Device(`con${run}`, true, { 'Own.md': 'own\n' })
  devices.push(victim, contact)
  check((await victim.boot()) && (await contact.boot()), 'the victim and a contact start')
  const code = await (contact.contacts as NonNullable<typeof contact.contacts>).createCode()
  await victim.contacts?.redeem(code)
  check(await eventually(() => contact.contacts?.isContact(victim.accountId) === true && victim.contacts?.isContact(contact.accountId) === true, 15_000), 'they are contacts')
  const docId = victim.index?.docIdForPath('Private/Diary.md') as string
  const room = docRoom(docId)
  check(await eventually(async () => (await victim.sync?.notYetSent(1_000)) === null), 'the private note is on the server, shared with nobody')
  const contactKeys = contact.sync?.unlocked as unknown as { privateKey: CryptoKey; publicKey: Uint8Array }

  // The server lists the contact as holding every key of the private note.
  type Whole = { epoch: number; keys: Record<string, number[]> }
  const api = victim.api as unknown as {
    wholeLog(room: string): Promise<Whole>
    rewrite(room: string, request: { keys: Record<string, Record<string, string>>; frames: Array<{ seq: number; data: string }> }): Promise<unknown>
  }
  const wholeLog = api.wholeLog.bind(api)
  api.wholeLog = async (asked) => {
    const whole = await wholeLog(asked)
    if (asked !== room) return whole
    return { ...whole, keys: { ...whole.keys, [contact.accountId]: Array.from({ length: whole.epoch + 1 }, (_, epoch) => epoch) } }
  }
  let captured: { keys: Record<string, string>; frames: Array<{ seq: number; data: string; epoch?: number }> } | null = null
  const rewrite = api.rewrite.bind(api)
  api.rewrite = async (asked, request) => {
    if (asked === room) {
      captured = { keys: request.keys[contact.accountId] ?? {}, frames: request.frames }
      // Passed on without them, so the honest server here takes the rest and the replacement finishes.
      const { [contact.accountId]: _taken, ...keys } = request.keys
      return rewrite(asked, { ...request, keys })
    }
    return rewrite(asked, request)
  }

  await victim.shutdown()
  await victim.replaceKeys('an entirely new horse, battery and staple')
  const sealed = captured ? Object.entries((captured as { keys: Record<string, string> }).keys) : []
  console.log(`      keys of the private note sealed to the contact: ${sealed.length}`)
  let read = ''
  if (captured && sealed.length > 0) {
    const doc = new Y.Doc()
    for (const [epoch, value] of sealed) {
      const parts = splitSealed(value)
      if (!parts) continue
      const raw = await unseal(contactKeys.privateKey, contactKeys.publicKey, parts.sealed, epochKeyContext(room, Number(epoch)))
      const key = await aesKey(raw)
      for (const frame of (captured as { frames: Array<{ seq: number; data: string }> }).frames) {
        const opened = await decrypt(key, fromBase64(frame.data), frameAad(room, Number(epoch))).catch(() => null)
        const content = opened ? unpackFrame(opened) : null
        if (content) Y.applyUpdate(doc, content.update)
      }
    }
    read = doc.getText(CONTENT_FIELD).toString()
  }
  console.log('      what the contact reads of the private note:', JSON.stringify(read))
  check(sealed.length === 0 && read === '', 'EXPECTED SAFE: a private note\'s keys go to nobody the account did not give it to (FAILS = finding reproduced)')
} catch (error) {
  check(false, 'the reproduction ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  for (const device of devices) await device.shutdown().catch(() => undefined)
  await server.close()
  rmSync(root, { recursive: true, force: true })
}
finish()
