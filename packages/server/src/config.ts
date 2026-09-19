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
}

function parseIntFallback(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function loadConfig(): ServerConfig {
  return {
    host: process.env.HOST ?? '0.0.0.0',
    port: parseIntFallback(process.env.PORT, 1234),
    jwtSecret: process.env.CRDT_SYNC_JWT_SECRET ?? 'dev-insecure-secret-change-me',
    dataDir: resolve(process.env.CRDT_SYNC_DATA_DIR ?? './data'),
    devAllowAnonymous: (process.env.CRDT_SYNC_DEV ?? 'true') !== 'false',
    accessTokenTtlSeconds: parseIntFallback(process.env.CRDT_SYNC_TOKEN_TTL, 86_400),
    historyRetentionDays: parseIntFallback(process.env.CRDT_SYNC_HISTORY_DAYS, 30)
  }
}
