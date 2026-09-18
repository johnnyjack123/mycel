import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type * as Yjs from 'yjs'
import { getYDoc, setPersistence } from 'y-websocket/bin/utils'
import { Y } from './yjs.js'

const SAVE_DEBOUNCE_MS = 1_000

export class DiskPersistence {
  private readonly loaded = new Map<string, Promise<void>>()
  private readonly saveTimers = new Map<string, NodeJS.Timeout>()
  private writes = Promise.resolve()

  constructor(private readonly dataDir: string) {}

  install(): void {
    setPersistence({
      // Deliberately synchronous up to the promise so `ensureLoaded` can pick it
      // up immediately after `getYDoc` has created the room.
      bindState: (docName, ydoc) => {
        const loading = this.load(docName, ydoc)
        this.loaded.set(docName, loading)
        return loading
      },
      writeState: async (docName, ydoc) => {
        this.cancelScheduledSave(docName)
        this.loaded.delete(docName)
        await this.persist(docName, ydoc)
      }
    })
  }

  // y-websocket creates a room lazily and never awaits `bindState`, so without
  // this a client is sent sync step 1 against an empty document while the stored
  // state is still being read, and then seeds the note a second time.
  async ensureLoaded(room: string): Promise<void> {
    getYDoc(room, true)
    await this.loaded.get(room)
  }

  private async load(docName: string, ydoc: Yjs.Doc): Promise<void> {
    try {
      const buffer = await readFile(this.filePath(docName))
      Y.applyUpdate(ydoc, new Uint8Array(buffer))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // Storing only when the last client leaves loses the room on a crash or a
    // restart, which during testing looks exactly like a sync failure.
    ydoc.on('update', () => this.scheduleSave(docName, ydoc))
  }

  private scheduleSave(docName: string, ydoc: Yjs.Doc): void {
    this.cancelScheduledSave(docName)
    const timer = setTimeout(() => {
      this.saveTimers.delete(docName)
      this.writes = this.writes
        .then(() => this.persist(docName, ydoc))
        .catch((error) => {
          console.error(`[crdt-sync] persisting room "${docName}" failed`, error)
        })
    }, SAVE_DEBOUNCE_MS)
    timer.unref?.()
    this.saveTimers.set(docName, timer)
  }

  private cancelScheduledSave(docName: string): void {
    const timer = this.saveTimers.get(docName)
    if (!timer) return
    clearTimeout(timer)
    this.saveTimers.delete(docName)
  }

  private async persist(docName: string, ydoc: Yjs.Doc): Promise<void> {
    await mkdir(this.dataDir, { recursive: true })
    const update = Y.encodeStateAsUpdate(ydoc)
    const target = this.filePath(docName)
    const temp = `${target}.tmp`
    await writeFile(temp, update)
    await rename(temp, target)
  }

  private filePath(docName: string): string {
    return join(this.dataDir, `${encodeURIComponent(docName)}.bin`)
  }
}
