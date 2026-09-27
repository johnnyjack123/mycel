import type { DataAdapter } from 'obsidian'
import { log } from '../log.js'

// Per-device bookkeeping that must not travel through the CRDT: what this
// machine last agreed on with the shared document.

export interface FileState {
  path: string
  /** `stat` of the file as we last saw it agree with the document. */
  mtime: number
  size: number
}

const STATE_FILE = 'state.json'
const BASE_DIR = 'base'
const SAVE_DEBOUNCE_MS = 1_000

export class StateStore {
  private readonly entries = new Map<string, FileState>()
  private saveTimer: number | null = null
  private writes: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly adapter: DataAdapter,
    private readonly root: string
  ) {}

  private path(...parts: string[]): string {
    return [this.root, ...parts].join('/')
  }

  private async ensureDir(path: string): Promise<void> {
    if (await this.adapter.exists(path)) return
    try {
      await this.adapter.mkdir(path)
    } catch {
      // A concurrent create is fine; anything else surfaces on the next write.
    }
  }

  async load(): Promise<void> {
    await this.ensureDir(this.root)
    const file = this.path(STATE_FILE)
    if (!(await this.adapter.exists(file))) return
    try {
      const parsed = JSON.parse(await this.adapter.read(file)) as Record<string, FileState>
      for (const [docId, state] of Object.entries(parsed)) {
        if (state && typeof state.path === 'string') this.entries.set(docId, state)
      }
    } catch (error) {
      log.error('the local state file is unreadable, starting fresh', error)
    }
  }

  get(docId: string): FileState | undefined {
    return this.entries.get(docId)
  }

  set(docId: string, state: FileState): void {
    this.entries.set(docId, state)
    this.scheduleSave()
  }

  forget(docId: string): void {
    this.entries.delete(docId)
    this.scheduleSave()
    void this.adapter.remove(this.path(BASE_DIR, `${docId}.md`)).catch(() => undefined)
  }

  docIds(): string[] {
    return Array.from(this.entries.keys())
  }

  private scheduleSave(): void {
    if (this.closed) return
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null
      void this.flush()
    }, SAVE_DEBOUNCE_MS)
  }

  /**
   * Final save. Nothing is written after this: a restart has already loaded
   * the file into a new instance, and a late save from this one would
   * overwrite it with an older picture.
   */
  async close(): Promise<void> {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = null
    await this.flush()
    this.closed = true
  }

  flush(): Promise<void> {
    if (this.closed) return this.writes
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.writes = this.writes
      .then(async () => {
        await this.ensureDir(this.root)
        const plain: Record<string, FileState> = {}
        for (const [docId, state] of this.entries) plain[docId] = state
        await this.adapter.write(this.path(STATE_FILE), JSON.stringify(plain))
      })
      .catch((error) => {
        log.error('writing the local state failed', error)
      })
    return this.writes
  }

  /**
   * The text this device last saw file and document agree on. Without it a
   * reconcile cannot tell "the other side added this" from "I deleted this",
   * and guessing wrong is exactly how edits disappear.
   */
  async baseText(docId: string): Promise<string | null> {
    const file = this.path(BASE_DIR, `${docId}.md`)
    if (!(await this.adapter.exists(file))) return null
    try {
      return await this.adapter.read(file)
    } catch {
      return null
    }
  }

  async setBaseText(docId: string, text: string): Promise<void> {
    await this.ensureDir(this.root)
    await this.ensureDir(this.path(BASE_DIR))
    await this.adapter.write(this.path(BASE_DIR, `${docId}.md`), text)
  }
}
