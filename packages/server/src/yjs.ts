import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)

// yjs ships separate ESM and CJS builds. y-websocket/bin/utils.cjs loads the
// CJS build, so the server must load the same one. Mixing both triggers
// "Yjs was already imported" and breaks yjs constructor checks.
export const Y = nodeRequire('yjs') as typeof import('yjs')
