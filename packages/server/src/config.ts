import { resolve } from 'node:path'
import type { RegistrationMode } from '@obsidian-connect/shared'

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
}

const DEV_SECRET = 'dev-insecure-secret-change-me'
const THIRTY_DAYS = 30 * 24 * 60 * 60

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
    logUpdates: env.OBSIDIAN_CONNECT_LOG_UPDATES === 'true'
  }
}
