import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import type { RegistrationMode } from '@mycel/shared'

const BYTE_ORDER_MARK = 0xfeff

/**
 * The `.env` next to `docker-compose.yml`, so running the server with npm
 * reads the same settings the container gets. Variables already set win,
 * which keeps the self-tests' `PORT=1235 …` from being overridden by it. The
 * image has no such file; compose hands the container its variables itself.
 */
export function loadEnvFile(path = fileURLToPath(new URL('../../../.env', import.meta.url))): string | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  // Windows PowerShell 5.1 writes UTF-8 with a byte order mark, and Node's
  // parser keeps it as part of the first name: that setting silently vanished.
  // Compared by code: written as a character it is invisible in the source.
  const parsed = parseEnv(raw.charCodeAt(0) === BYTE_ORDER_MARK ? raw.slice(1) : raw)
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined && typeof value === 'string') process.env[key] = value
  }
  return path
}

export interface ServerConfig {
  host: string
  port: number
  /**
   * Signs every token. Null when none is set: the server then makes a random
   * one in its data folder (`jwt-secret`) and keeps it - there is no built-in
   * secret any more, since anyone could read that one in the sources and sign
   * a token for any account.
   */
  jwtSecret: string | null
  /**
   * Which addresses the server takes `X-Forwarded-For` from - the reverse
   * proxy in front of it. Without it every request seemed to come from the
   * proxy, and ten wrong passwords from anyone blocked everybody's sign-in.
   * Unset, the header is ignored: anyone could write it.
   */
  trustProxy: string[] | null
  dataDir: string
  /** `open`: anyone who reaches the server can register. `invite`: only with a code from the CLI. */
  registration: RegistrationMode
  accessTokenTtlSeconds: number
  /** Log every document frame. Off by default: one line per keystroke. */
  logUpdates: boolean
  /** The largest attachment taken, in bytes. */
  maxFileBytes: number
  /** What one account may store in attachments, in bytes; null for no limit. */
  quotaBytes: number | null
  /** How long after its last upload a blob is kept even when a device asks to delete it. */
  purgeGraceMs: number
}

/**
 * HS256 wants a key of 256 bits (RFC 7518). Every account holds a token signed
 * with it - all an offline search for a short or human-made secret needs.
 */
export const MIN_JWT_SECRET_LENGTH = 32
const THIRTY_DAYS = 30 * 24 * 60 * 60
const MB = 1024 * 1024
const DEFAULT_MAX_FILE_MB = 100
const DEFAULT_PURGE_GRACE_S = 10 * 60

function parseIntFallback(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** `MYCEL_TRUST_PROXY`: addresses or subnets (comma separated), `loopback`, `linklocal`, `uniquelocal` as Fastify reads them. */
function trustedProxies(value: string | undefined): string[] | null {
  const list = (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  return list.length > 0 ? list : null
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.HOST ?? '0.0.0.0',
    port: parseIntFallback(env.PORT, 1234),
    jwtSecret: env.MYCEL_JWT_SECRET ? env.MYCEL_JWT_SECRET : null,
    trustProxy: trustedProxies(env.MYCEL_TRUST_PROXY),
    dataDir: resolve(env.MYCEL_DATA_DIR ?? './data'),
    registration: env.MYCEL_REGISTRATION === 'open' ? 'open' : 'invite',
    accessTokenTtlSeconds: parseIntFallback(env.MYCEL_TOKEN_TTL, THIRTY_DAYS),
    logUpdates: env.MYCEL_LOG_UPDATES === 'true',
    maxFileBytes: Math.max(1, parseIntFallback(env.MYCEL_MAX_FILE_MB, DEFAULT_MAX_FILE_MB)) * MB,
    // With open registration, this is what keeps a stranger from filling the disk.
    quotaBytes: env.MYCEL_QUOTA_MB ? Math.max(0, parseIntFallback(env.MYCEL_QUOTA_MB, 0)) * MB : null,
    purgeGraceMs: Math.max(0, parseIntFallback(env.MYCEL_PURGE_GRACE_S, DEFAULT_PURGE_GRACE_S)) * 1000
  }
}
