import * as Y from 'yjs'

// The server used to load yjs as CJS because `y-websocket/bin/utils.cjs` did,
// and mixing both builds triggers "Yjs was already imported". The room layer is
// ours now and speaks y-protocols directly, so plain ESM is enough. Everything
// server-side still goes through this module so there is one place to change.
export { Y }
