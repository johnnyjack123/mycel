import { resolve } from 'node:path'

export interface ServerConfig {
  host: string
  port: number
  jwtSecret: string
  dataDir: string
  devAllowAnonymous: boolean
  accessTokenTtlSeconds: number
  /** Days of individually restorable versions. Older ones fold into the snapshot. */
  historyRetentionDays: number
  /** Log every document update. Off by default: one line per keystroke. */
  logUpdates: boolean
}

function parseIntFallback(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function loadConfig(): ServerConfig {
  return {
    host: process.env.HOST ?? '0.0.0.0',
    port: parseIntFallback(process.env.PORT, 1234),
    jwtSecret: process.env.OBSIDIAN_CONNECT_JWT_SECRET ?? 'dev-insecure-secret-change-me',
    dataDir: resolve(process.env.OBSIDIAN_CONNECT_DATA_DIR ?? './data'),
    devAllowAnonymous: (process.env.OBSIDIAN_CONNECT_DEV ?? 'true') !== 'false',
    accessTokenTtlSeconds: parseIntFallback(process.env.OBSIDIAN_CONNECT_TOKEN_TTL, 86_400),
    historyRetentionDays: parseIntFallback(process.env.OBSIDIAN_CONNECT_HISTORY_DAYS, 30),
    logUpdates: process.env.OBSIDIAN_CONNECT_LOG_UPDATES === 'true'
  }
}
