// Every attack of the second audit (docs/AUDIT2.md), one after another: each script
// prints FAIL while its attack works and exits non-zero then. One at a time - the
// development machine is short of memory, and the relay script starts a server.
//
//   npm run test:audit2
//   (the backup server's restic injection needs MYCEL_RESTIC naming restic; without it, it is skipped)
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const runs = []
for (const pkg of ['server', 'backup', 'plugin']) {
  const dir = join(root, 'packages', pkg, 'scripts', 'audit2')
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.mts')).sort()) {
    if (name === 'restic-snapshot-id-injection.mts' && !process.env.MYCEL_RESTIC) {
      console.log(`skipped ${pkg}/${name}: MYCEL_RESTIC is not set`)
      continue
    }
    runs.push({ pkg, name })
  }
}

const failed = []
for (const { pkg, name } of runs) {
  const args = pkg === 'plugin' ? ['tsx', '--tsconfig', 'scripts/tsconfig.json', `scripts/audit2/${name}`] : ['tsx', `scripts/audit2/${name}`]
  console.log(`\n=== ${pkg}/${name}`)
  const result = spawnSync('npx', args, { cwd: join(root, 'packages', pkg), stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) failed.push(`${pkg}/${name}`)
}
console.log(failed.length === 0 ? `\nevery attack of the second audit was refused (${runs.length})` : `\n${failed.length} attack(s) work again: ${failed.join(', ')}`)
process.exit(failed.length === 0 ? 0 : 1)
