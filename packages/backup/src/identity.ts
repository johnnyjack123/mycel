import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  backupServerKeys,
  encodeBackupServerCode,
  fromBase64,
  newBackupServerSecret,
  toBase64,
  type BackupServerKeys,
  type Bytes
} from '@obsidian-connect/shared/crypto'

// The backup server's code, made on its first start and kept in its data
// folder. Whoever has the code can connect vaults to this backup server; it
// is kept like a password.

export interface Identity {
  code: string
  keys: BackupServerKeys
}

interface StoredIdentity {
  secret: string
  createdAt: number
}

export async function loadIdentity(dataDir: string): Promise<{ identity: Identity; created: boolean }> {
  const file = join(dataDir, 'identity.json')
  let secret: Bytes
  let created = false
  try {
    secret = fromBase64((JSON.parse(await readFile(file, 'utf8')) as StoredIdentity).secret)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    secret = newBackupServerSecret()
    const stored: StoredIdentity = { secret: toBase64(secret), createdAt: Date.now() }
    await mkdir(dataDir, { recursive: true })
    await writeFile(`${file}.tmp`, JSON.stringify(stored, null, 2), { mode: 0o600 })
    await rename(`${file}.tmp`, file)
    created = true
  }
  return { identity: { code: await encodeBackupServerCode(secret), keys: await backupServerKeys(secret) }, created }
}
