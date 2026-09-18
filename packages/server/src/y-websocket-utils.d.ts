declare module 'y-websocket/bin/utils' {
  import type { IncomingMessage } from 'node:http'
  import type { WebSocket } from 'ws'
  import type * as Y from 'yjs'

  export function setupWSConnection(
    conn: WebSocket,
    req: IncomingMessage,
    opts?: { docName?: string; gc?: boolean }
  ): void

  export interface Persistence {
    bindState: (docName: string, ydoc: Y.Doc) => Promise<void> | void
    writeState: (docName: string, ydoc: Y.Doc) => Promise<void> | void
  }

  export function setPersistence(persistence: Persistence): void

  export interface WSSharedDoc extends Y.Doc {
    name: string
    conns: Map<unknown, Set<number>>
  }

  export const docs: Map<string, WSSharedDoc>
}
