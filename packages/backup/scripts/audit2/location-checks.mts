// Audit 2: the backup task's location checks (R7, B2) against locations that reach the backup
// server's own network, or a folder outside its own, all the same. Pure functions, no restic.
// Each FAIL is a location the checks let through.
//
//   cd packages/backup && npx tsx scripts/audit2/location-checks.mts
import { hostsOf, networkProblem } from '../../src/network.js'
import { isRemote } from '../../src/config.js'

const allowed = new Set<string>()
// Names do not resolve here: nothing depends on this machine's resolver.
const resolve = async (host: string): Promise<string[]> => {
  throw new Error(`no such host ${host}`)
}
let failed = 0
for (const location of [
  'rest:http://169.254.169.254/',
  's3://10.0.0.5/bucket',
  's3:10.0.0.5:9000/bucket',
  'rest:http://[::ffff:169.254.169.254]/',
  'rest:http://[::ffff:a9fe:a9fe]/'
]) {
  const refused = (await networkProblem(location, {}, allowed, resolve)) !== null
  if (!refused) failed += 1
  console.log(`${refused ? 'PASS' : 'FAIL'}: ${location} refused (hosts seen: ${JSON.stringify(hostsOf(location))})`)
}
const unknown = 'xx:/../../somewhere/else'
const remote = isRemote(unknown)
if (remote) failed += 1
console.log(`${remote ? 'FAIL' : 'PASS'}: ${unknown} is not taken for a cloud location (restic reads an unknown scheme as a local path)`)
process.exit(failed > 0 ? 1 : 0)
