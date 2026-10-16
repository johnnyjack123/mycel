import { createHash } from 'node:crypto'
import type { Cache } from './cache.js'
import type { VaultKeys } from './keys.js'
import type { OutFile } from './layout.js'

// The plaintext of one file of the backup: a note's text as it is, a file's
// content decrypted chunk by chunk from the cache - never more than a chunk of
// it in memory.

export function sizeOf(file: OutFile): number {
  return file.content.kind === 'text' ? Buffer.byteLength(file.content.text, 'utf8') : file.content.size
}

/** SHA-256 of the content, hex: the index's own hash for a file. */
export function hashOf(file: OutFile): string {
  return file.content.kind === 'text' ? createHash('sha256').update(file.content.text, 'utf8').digest('hex') : file.content.hash
}

export async function* chunksOf(file: OutFile, cache: Cache, keys: VaultKeys): AsyncGenerator<Uint8Array> {
  if (file.content.kind === 'text') {
    yield Buffer.from(file.content.text, 'utf8')
    return
  }
  const { blobId } = file.content
  const record = await cache.blob(blobId)
  if (!record) throw new Error(`the content of ${file.path} is not in the cache`)
  for (let index = 0; index < record.count; index += 1) {
    yield keys.decryptChunk(blobId, await cache.blobChunk(blobId, index, record), index, record.count)
  }
}

export async function bytesOf(file: OutFile, cache: Cache, keys: VaultKeys): Promise<Buffer> {
  const parts: Uint8Array[] = []
  for await (const chunk of chunksOf(file, cache, keys)) parts.push(chunk)
  return Buffer.concat(parts)
}
