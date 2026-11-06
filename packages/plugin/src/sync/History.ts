// Every change a device has seen of a note, kept on the device: the Yjs update
// and when its author made it. The server holds the same history encrypted;
// this copy is what a device uploads again when the server lost it, and what
// a participant keeps when a share ends.
//
// Not encrypted, on purpose: the vault files lie on the same disk in plain
// text anyway, and a device that lost its credentials can still recover every
// version from here.

import { log } from '../log.js'

export interface HistoryEntry {
  /** The author's clock when the change was made. */
  authorTs: number
  update: Uint8Array
}

export interface HistoryStore {
  /** Fire and forget; a change seen twice is kept once. */
  add(room: string, entry: HistoryEntry): void
  /** Oldest first. */
  entries(room: string): Promise<HistoryEntry[]>
  /** Drops every change made before `before`, in every room. */
  prune(before: number): Promise<void>
  clear(room: string): Promise<void>
}

/** FNV-1a over the update, enough to tell two changes apart and see one twice. */
function fingerprint(update: Uint8Array): string {
  let hash = 0x811c9dc5
  for (const byte of update) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${update.length.toString(36)}.${hash.toString(36)}`
}

/** The same change seen twice - from the server and from this device - has the same key. */
export function entryKey(entry: HistoryEntry): string {
  return `${entry.authorTs}:${fingerprint(entry.update)}`
}

function byAuthorTs(a: HistoryEntry, b: HistoryEntry): number {
  return a.authorTs - b.authorTs
}

export function memoryHistory(): HistoryStore {
  const rooms = new Map<string, Map<string, HistoryEntry>>()
  return {
    add(room, entry) {
      let entries = rooms.get(room)
      if (!entries) {
        entries = new Map()
        rooms.set(room, entries)
      }
      entries.set(entryKey(entry), { authorTs: entry.authorTs, update: entry.update.slice() })
    },
    async entries(room) {
      return Array.from(rooms.get(room)?.values() ?? []).sort(byAuthorTs)
    },
    async prune(before) {
      for (const entries of rooms.values()) {
        for (const [key, entry] of entries) if (entry.authorTs < before) entries.delete(key)
      }
    },
    async clear(room) {
      rooms.delete(room)
    }
  }
}

interface StoredEntry {
  key: string
  room: string
  authorTs: number
  update: Uint8Array
}

const STORE = 'entries'

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** In Obsidian's IndexedDB, one database per vault, next to the notes' own. */
export function indexedDbHistory(vaultId: string): HistoryStore {
  let opened: Promise<IDBDatabase> | null = null
  const database = (): Promise<IDBDatabase> => {
    opened ??= new Promise((resolve, reject) => {
      const open = indexedDB.open(`mycel-history/${vaultId}`, 1)
      open.onupgradeneeded = () => {
        const store = open.result.createObjectStore(STORE, { keyPath: 'key' })
        store.createIndex('room', 'room')
        store.createIndex('authorTs', 'authorTs')
      }
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    return opened
  }
  const transaction = async (mode: IDBTransactionMode): Promise<IDBObjectStore> =>
    (await database()).transaction(STORE, mode).objectStore(STORE)

  return {
    add(room, entry) {
      const stored: StoredEntry = { key: `${room}|${entryKey(entry)}`, room, authorTs: entry.authorTs, update: entry.update.slice() }
      void transaction('readwrite')
        .then((store) => request(store.put(stored)))
        .catch((error) => log.error('keeping a change in the local history failed', error))
    },
    async entries(room) {
      const store = await transaction('readonly')
      const stored = (await request(store.index('room').getAll(room))) as StoredEntry[]
      return stored.map((entry) => ({ authorTs: entry.authorTs, update: entry.update })).sort(byAuthorTs)
    },
    async prune(before) {
      const store = await transaction('readwrite')
      const keys = await request(store.index('authorTs').getAllKeys(IDBKeyRange.upperBound(before, true)))
      await Promise.all(keys.map((key) => request(store.delete(key))))
    },
    async clear(room) {
      const store = await transaction('readwrite')
      const keys = await request(store.index('room').getAllKeys(room))
      await Promise.all(keys.map((key) => request(store.delete(key))))
    }
  }
}
