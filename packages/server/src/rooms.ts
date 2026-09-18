import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type * as Yjs from 'yjs'
import { setPersistence } from 'y-websocket/bin/utils'
import { Y } from './yjs.js'

export class DiskPersistence {
  constructor(private readonly dataDir: string) {}

  install(): void {
    setPersistence({
      bindState: async (docName, ydoc) => {
        await this.load(docName, ydoc)
      },
      writeState: async (docName, ydoc) => {
        await this.persist(docName, ydoc)
      }
    })
  }

  private async load(docName: string, ydoc: Yjs.Doc): Promise<void> {
    try {
      const buffer = await readFile(this.filePath(docName))
      Y.applyUpdate(ydoc, new Uint8Array(buffer))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
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
