import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// What the running backup server writes into its data folder for the command
// line, which runs as a process of its own: whether it reaches the sync
// server, why not, and which routes the relay answers for it. Without this an
// invitation that reached nobody looked the same as one that did, until a
// device said "the backup server is not connected".

export interface ServerStatus {
  /** The sync server, as configured. */
  server: string
  /** When written: on every change, and every minute while it runs. */
  updatedAt: number
  connected: boolean
  /** Why it is not connected, as the last attempt failed. */
  error: string | null
  /** When `connected` last changed. */
  since: number
  /** The route ids the relay answers for it now. */
  registered: string[]
  /** Open invitation id -> its route id. */
  invites: Record<string, string>
  vaults: number
}

const FILE = 'status.json'

/** Written again at least this often while it runs; older means it does not run. */
export const STATUS_EVERY_MS = 60_000

export async function writeStatus(dataDir: string, status: ServerStatus): Promise<void> {
  const path = join(dataDir, FILE)
  await writeFile(`${path}.tmp`, JSON.stringify(status, null, 2))
  await rename(`${path}.tmp`, path)
}

export async function readStatus(dataDir: string): Promise<ServerStatus | null> {
  try {
    return JSON.parse(await readFile(join(dataDir, FILE), 'utf8')) as ServerStatus
  } catch {
    return null
  }
}
