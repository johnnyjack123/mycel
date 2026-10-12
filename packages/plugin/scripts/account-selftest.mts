// The account itself with real devices: signing the other devices out when
// the password changes, and the recovery code. The server runs in this
// process, on a port and in a directory of its own, never near the user's.
//
//   npm run test:account
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, Device, eventually, finish, useServer } from './harness.mjs'

const { docRoom } = await import('@obsidian-connect/shared')
const { TOTP_STEP_SECONDS, encodeRecoveryCode, newRecoverySecret, newTotpSecret, totpCode, totpStep } = await import(
  '@obsidian-connect/shared/crypto'
)
const { loadConfig } = await import('../../server/src/config.js')
const { startServer } = await import('../../server/src/server.js')

const root = mkdtempSync(join(tmpdir(), 'oc-account-selftest-'))
// The clock codes are checked against, shared with the "phone" below: every
// code it shows is for a step of its own, as if half a minute had passed, so
// no test waits for the next one.
let clock = Date.now()
const server = await startServer(
  loadConfig({
    HOST: '127.0.0.1',
    PORT: '0',
    OBSIDIAN_CONNECT_DATA_DIR: root,
    OBSIDIAN_CONNECT_REGISTRATION: 'open',
    OBSIDIAN_CONNECT_JWT_SECRET: 'account-selftest'
  }),
  // Wrong passwords and codes on purpose, many more than an address may try.
  { logger: false, paceMs: 0, now: () => clock, maxFailures: 1_000 }
)

/** An authenticator app. */
class Phone {
  readonly secret = newTotpSecret()

  async code(): Promise<string> {
    clock += TOTP_STEP_SECONDS * 1000
    return totpCode(this.secret, totpStep(clock))
  }
}
useServer(`ws://127.0.0.1:${server.port}`)

const run = Date.now().toString(36)
const NEW_PASSWORD = 'a different horse, battery and staple'
const A1 = new Device(`anna${run}`, true, { 'One.md': 'first\n', 'Two.md': 'second\n' })
const A2 = new Device(`anna${run}`, false)
const devices = [A1, A2]
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

  // --- the recovery code: name and password forgotten ---------------------------------
  check(typeof A1.recoveryCode === 'string' && A1.hasRecoveryCode === true, 'the account got a recovery code when it was made')
  const firstCode = A1.recoveryCode as string
  const RECOVERED = 'recovered horse, battery and staple'
  const newName = `berta${run}`
  const A3 = new Device('', false)
  devices.push(A3)
  const typo = `${firstCode[0] === 'A' ? 'B' : 'A'}${firstCode.slice(1)}`
  check(
    await A3.recover(typo, newName, RECOVERED).then(
      () => false,
      (error: unknown) => error instanceof Error && error.message.includes('typo')
    ),
    'a typo in the code is caught on the device'
  )
  const unknown = await encodeRecoveryCode(newRecoverySecret())
  check(
    await A3.recover(unknown, newName, RECOVERED).then(
      () => false,
      (error: unknown) => error instanceof Error && error.message.includes('not known')
    ),
    'a code the server does not know is refused'
  )
  await A3.recover(firstCode, newName, RECOVERED)
  check(typeof A3.recoveryCode === 'string' && A3.recoveryCode !== firstCode, 'the code alone sets a new name and password, and a new code comes back')
  check(await A3.boot(), 'the device that recovered opens the vault')
  check(
    await eventually(() => A3.vault.text('One.md') === 'first\nwritten after the change\n' && A3.vault.text('Two.md') === 'second\nwritten while signed out\n'),
    'the same vault, every note readable: the keys survived'
  )
  check(await eventually(() => A1.signedOut === 1 && A2.signedOut === 2), 'every other device is signed out', { a1: A1.signedOut, a2: A2.signedOut })
  check(
    await new Device('', false).recover(firstCode, newName, RECOVERED).then(
      () => false,
      () => true
    ),
    'the code used is spent'
  )
  check(await A2.boot().then(() => false, () => true), 'the old name and password no longer sign in')
  A1.username = newName
  A1.password = RECOVERED
  check(await A1.boot(), 'the new ones do')
  await A1.vault.userWrite('One.md', 'first\nafter the recovery\n')
  check(await eventually(() => A3.vault.text('One.md') === 'first\nafter the recovery\n'), 'and the devices sync as before')

  // --- in the settings: a new code, or none ---------------------------------------------
  check(await A1.makeRecoveryCode('not the password at all').then(() => false, () => true), 'a new code needs the password')
  const before = A3.recoveryCode as string
  await A1.makeRecoveryCode()
  check(typeof A1.recoveryCode === 'string' && A1.recoveryCode !== before && A1.hasRecoveryCode === true, 'with it, one is made')
  check(await new Device('', false).recover(before, newName, RECOVERED).then(() => false, () => true), 'and the one before stops working at once')
  check(await A1.deleteRecoveryCode('not the password at all').then(() => false, () => true), 'deleting it needs the password too')
  await A1.deleteRecoveryCode()
  check(A1.hasRecoveryCode === false, 'and leaves the account without one')
  check(
    await new Device('', false).recover(A1.recoveryCode as string, newName, RECOVERED).then(() => false, () => true),
    'so that no code opens it'
  )

  // --- two-factor sign-in ---------------------------------------------------------------
  const phone = new Phone()
  check(await A1.enableTotp(phone.secret, '000000').then(() => false, () => true), 'two-factor sign-in needs a code the app made')
  await A1.enableTotp(phone.secret, await phone.code())
  check(A1.hasTotp === true, 'with one, A1 turns it on')
  check(await eventually(() => A3.signedOut === 1 && !A3.signedIn), 'and every other device is signed out', { a3: A3.signedOut })
  check(await eventually(() => A1.socket?.connected === true) && A1.signedOut === 1, 'A1 itself carries on')

  check(
    (await A3.boot().then(
      () => false,
      (error: unknown) => error instanceof Error && error.message.includes('cancelled')
    )) && A3.askedForCode.join() === 'false',
    'the password alone no longer signs A3 in: it asks for a code',
    A3.askedForCode
  )
  let wrongFirst = true
  A3.authenticator = {
    code: async () => {
      if (!wrongFirst) return phone.code()
      wrongFirst = false
      return '000000'
    }
  }
  check(await A3.boot(), 'with a code from the app it does')
  check(A3.askedForCode.slice(-2).join() === 'false,true', 'after asking again for a wrong one', A3.askedForCode)
  await A1.vault.userWrite('Two.md', 'second\nwith two factors\n')
  check(await eventually(() => A3.vault.text('Two.md') === 'second\nwith two factors\n'), 'and syncs as before')
  check(await A1.disableTotp('000000').then(() => false, () => true), 'turning it off needs a current code')

  // The phone is lost: the recovery code gets in without it.
  await A1.makeRecoveryCode()
  const RECOVERED_AGAIN = 'phone gone, horse, battery and staple'
  const A4 = new Device('', false)
  devices.push(A4)
  await A4.recover(A1.recoveryCode as string, newName, RECOVERED_AGAIN)
  check(A4.totpWasOn && (await A4.boot()) && A4.hasTotp === false, 'a recovery needs no code, and turns two-factor sign-in off')
  A1.password = RECOVERED_AGAIN
  A1.authenticator = null
  check(await eventually(() => A1.signedOut === 2) && (await A1.boot()), 'the other devices sign in with the password alone again')

  const newPhone = new Phone()
  await A4.enableTotp(newPhone.secret, await newPhone.code())
  check(A4.hasTotp === true, 'it can be turned on again, with the new phone')
  await A4.disableTotp(await newPhone.code())
  check(A4.hasTotp === false, 'and off, with password and a current code')
} catch (error) {
  check(false, 'the scenario ran to the end', error instanceof Error ? error.stack : String(error))
} finally {
  for (const device of devices) await device.shutdown()
  await server.close()
  rmSync(root, { recursive: true, force: true })
}

finish()
