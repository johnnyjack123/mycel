import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import type { RegistrationMode } from '@obsidian-connect/shared'

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
  jwtSecret: string
  /** True while the JWT secret is the built-in one - fine for a laptop, not for a server. */
  insecureSecret: boolean
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
}

const DEV_SECRET = 'dev-insecure-secret-change-me'
const THIRTY_DAYS = 30 * 24 * 60 * 60
const MB = 1024 * 1024
const DEFAULT_MAX_FILE_MB = 100

function parseIntFallback(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const jwtSecret = env.OBSIDIAN_CONNECT_JWT_SECRET || DEV_SECRET
  return {
    host: env.HOST ?? '0.0.0.0',
    port: parseIntFallback(env.PORT, 1234),
    jwtSecret,
    insecureSecret: jwtSecret === DEV_SECRET,
    dataDir: resolve(env.OBSIDIAN_CONNECT_DATA_DIR ?? './data'),
    registration: env.OBSIDIAN_CONNECT_REGISTRATION === 'open' ? 'open' : 'invite',
    accessTokenTtlSeconds: parseIntFallback(env.OBSIDIAN_CONNECT_TOKEN_TTL, THIRTY_DAYS),
    logUpdates: env.OBSIDIAN_CONNECT_LOG_UPDATES === 'true',
    maxFileBytes: Math.max(1, parseIntFallback(env.OBSIDIAN_CONNECT_MAX_FILE_MB, DEFAULT_MAX_FILE_MB)) * MB,
    // With open registration, this is what keeps a stranger from filling the disk.
    quotaBytes: env.OBSIDIAN_CONNECT_QUOTA_MB ? Math.max(0, parseIntFallback(env.OBSIDIAN_CONNECT_QUOTA_MB, 0)) * MB : null
  }
}
