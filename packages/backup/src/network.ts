import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

// Where a backup task's cloud location makes restic connect. Whoever is paired
// with this backup server writes that location; pointed at an address in the
// backup server's own network - `rest:http://192.168.1.1/`, a router, a NAS, the
// cloud's metadata service at 169.254.169.254 - restic knocked on it for them.
// Such an address is refused unless the operator named the host
// (`MYCEL_BACKUP_ALLOW_HOSTS`). Checked before every start of restic, as the
// name resolves then; a name that resolves elsewhere a moment later (DNS
// rebinding) is beyond this - a firewall on the backup server's way out is not.

/** The hosts a restic location reaches, with those the credentials name; none for a path or an `rclone:` remote, which the operator configured. */
export function hostsOf(location: string, env: Record<string, string> = {}): string[] {
  const hosts: string[] = []
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(location)?.[1]?.toLowerCase()
  const rest = scheme ? location.slice(scheme.length + 1) : ''
  const urlHost = (text: string): string | null => {
    try {
      return new URL(text).hostname || null
    } catch {
      return null
    }
  }
  const add = (host: string | null | undefined): void => {
    const plain = host?.replace(/^\[|\]$/g, '').toLowerCase()
    if (plain) hosts.push(plain)
  }
  switch (scheme) {
    case 'rest':
      add(urlHost(rest))
      break
    case 's3': {
      // `s3:host/bucket`, `s3:host:port/bucket`, `s3://host/bucket`, `s3:http(s)://host:port/bucket` -
      // all of which restic dials; the two in between were read as no host, or with the port (audit 2, M5).
      if (/^https?:\/\//i.test(rest)) add(urlHost(rest))
      else add(urlHost(`http://${rest.replace(/^\/\//, '').split('/')[0] ?? ''}`))
      break
    }
    case 'sftp':
      if (rest.startsWith('//')) add(urlHost(`sftp:${rest}`))
      else {
        const target = rest.slice(rest.indexOf('@') + 1)
        add(target.startsWith('[') ? target.slice(1, target.indexOf(']')) : target.split(':')[0])
      }
      break
    case 'azure':
      if (env.AZURE_ENDPOINT_SUFFIX) add(`${env.AZURE_ACCOUNT_NAME ?? 'account'}.blob.${env.AZURE_ENDPOINT_SUFFIX}`)
      break
    default:
      break
  }
  for (const key of ['OS_AUTH_URL', 'ST_AUTH', 'OS_STORAGE_URL']) if (env[key]) add(urlHost(env[key]))
  return hosts
}

function v4(address: string): number[] | null {
  const parts = address.split('.').map(Number)
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null
}

/** Whether an address lies in a network of its own - loopback, private, link-local, shared, multicast, reserved. */
export function isInternalAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] as string
  const four = v4(ip)
  if (four) {
    const [a, b] = four as [number, number, number, number]
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && four[2] === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  if (isIP(ip) !== 6) return false
  if (ip === '::' || ip === '::1') return true
  const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
  if (mapped) return isInternalAddress(mapped[1] as string)
  // An IPv4 address inside IPv6 written in hex, as `new URL` writes `[::ffff:169.254.169.254]` (audit 2, M5).
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip)
  if (hex) {
    const high = parseInt(hex[1] as string, 16)
    const low = parseInt(hex[2] as string, 16)
    return isInternalAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`)
  }
  const first = parseInt(ip.split(':')[0] || '0', 16)
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00
}

/** The hosts the operator lets tasks reach in the backup server's own network: `MYCEL_BACKUP_ALLOW_HOSTS`, comma separated. */
export function allowedHosts(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((host) => host.trim().replace(/^\[|\]$/g, '').toLowerCase())
      .filter(Boolean)
  )
}

/**
 * Why restic must not reach a location from here, or null: a host it names is,
 * or resolves to, an address in the backup server's own network that the
 * operator did not allow - or does not resolve here, so that cannot be told:
 * left to restic, a name it resolved differently a moment later went through
 * (audit 2, M5). Without a name service the cloud is out of reach anyway.
 */
export async function networkProblem(
  location: string,
  env: Record<string, string> | undefined,
  allowed: ReadonlySet<string>,
  resolve: (host: string) => Promise<string[]> = async (host) => (await lookup(host, { all: true })).map((entry) => entry.address)
): Promise<string | null> {
  for (const host of hostsOf(location, env)) {
    if (allowed.has(host)) continue
    let addresses: string[]
    try {
      addresses = isIP(host) ? [host] : await resolve(host)
    } catch {
      return `${host} could not be resolved here, so whether it lies in the backup server's own network cannot be told`
    }
    const internal = addresses.find(isInternalAddress)
    if (internal) {
      return `${host} is in the backup server's own network (${internal}); only whoever runs the backup server can allow it, with MYCEL_BACKUP_ALLOW_HOSTS`
    }
  }
  return null
}
