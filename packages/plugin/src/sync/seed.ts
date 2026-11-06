import * as Y from 'yjs'
import { CONTENT_FIELD } from '@mycel/shared'

// Filling an empty document from the file it was made for. Every device that
// seeds a note with the same text derives the same insertion - same client id,
// same clock - so when two of them do it at once, Yjs keeps one. Inserted
// under each device's own client id, both copies stayed, and a vault started
// on two devices at once had every note twice.
//
// Different texts give different ids and both stay: without a base there is
// no telling which one is right, and keeping both is recoverable.

/** FNV-1a: the same on every device and in every version, which is all this id needs. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export function seedClientId(docId: string, text: string): number {
  return fnv1a(`seed::${docId}::${text}`)
}

export function seedUpdate(docId: string, text: string): Uint8Array {
  const doc = new Y.Doc()
  try {
    doc.clientID = seedClientId(docId, text)
    doc.getText(CONTENT_FIELD).insert(0, text)
    return Y.encodeStateAsUpdate(doc)
  } finally {
    doc.destroy()
  }
}
