// The account itself with real devices: signing the other devices out when
// the password changes. The server runs in this process, on a port and in a
// directory of its own, never near the user's.
//
//   npm run test:account
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, Device, eventually, finish, useServer } from './harness.mjs'

const { docRoom } = await import('@obsidian-connect/shared')
const { loadConfig } = await import('../../server/src/config.js')
const { startServer } = await import('../../server/src/server.js')

const root = mkdtempSync(join(tmpdir(), 'oc-account-selftest-'))
const server = await startServer(
  loadConfig({
    HOST: '127.0.0.1',
    PORT: '0',
    OBSIDIAN_CONNECT_DATA_DIR: root,
    OBSIDIAN_CONNECT_REGISTRATION: 'open',
    OBSIDIAN_CONNECT_JWT_SECRET: 'account-selftest'
  }),
  { logger: false, paceMs: 0 }
)
useServer(`ws://127.0.0.1:${server.port}`)

const run = Date.now().toString(36)
const NEW_PASSWORD = 'a different horse, battery and staple'
const A1 = new Device(`anna${run}`, true, { 'One.md': 'first\n', 'Two.md': 'second\n' })
const A2 = new Device(`anna${run}`, false)
try {
  check(await A1.boot(), 'A1 creates the account')
  check(await A2.boot(), 'A2 signs in')
  check(await eventually(() => A2.vault.text('One.md') === 'first\n' && A2.vault.text('Two.md') === 'second\n'), 'A2 has both notes')

  // --- a password change signs out the other devices -----------------------------
  await A1.changePassword(NEW_PASSWORD)
  check(await eventually(() => A2.signedOut === 1 && !A2.signedIn && A2.store === null), 'A1 changes the password, and A2 is signed out while it runs')
  check(
    await eventually(() => A1.socket?.connected === true) && A1.signedOut === 0 && A1.signedIn,
    'A1, whose socket the server closed as well, carries on with its new token'
  )
  await A1.vault.userWrite('One.md', 'first\nwritten after the change\n')
  const one = docRoom(A1.index?.docIdForPath('One.md') as string)
  check(await eventually(() => A1.socket?.isSettled(one) === true), 'and its edits still reach the server')
  check(A2.vault.text('One.md') === 'first\n', 'A2, signed out, hears nothing of it')

  // Nothing on the device is lost by being signed out.
  A2.vault.offlineWrite('Two.md', 'second\nwritten while signed out\n')
  check(await A2.boot().then(() => false, () => true), 'the old password no longer signs A2 in')
  A2.password = NEW_PASSWORD
  check(await A2.boot(), 'the new one does')
  check(
    await eventually(
      () =>
        A2.vault.text('One.md') === 'first\nwritten after the change\n' &&
        A1.vault.text('Two.md') === 'second\nwritten while signed out\n'
    ),
    'and both devices have both edits again',
    { a1: A1.vault.text('Two.md'), a2: A2.vault.text('One.md') }
  )
} catch (error) {
  check(false, 'the scenario ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  await A1.shutdown()
  await A2.shutdown()
  await server.close()
  rmSync(root, { recursive: true, force: true })
}

finish()
