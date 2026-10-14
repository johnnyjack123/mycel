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

/**
 * An attachment as this device last saw its file and the index agree: the
 * base. A file whose hash still equals it is unchanged here, so whatever the
 * index says now came from elsewhere - the same test notes make with their
 * base text.
 */
export interface AttachmentState extends FileState {
  hash: string
}

const STATE_FILE = 'state.json'
const ATTACHMENTS_FILE = 'attachments.json'
const BASE_DIR = 'base'
const SAVE_DEBOUNCE_MS = 1_000

export class StateStore {
  private readonly entries = new Map<string, FileState>()
  private readonly attachments = new Map<string, AttachmentState>()
  /** path -> fileId, for the scan's question which file this device knows a path as. */
  private readonly attachmentPaths = new Map<string, string>()
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
    for (const [name, into] of [
      [STATE_FILE, this.entries],
      [ATTACHMENTS_FILE, this.attachments]
    ] as const) {
      const file = this.path(name)
      if (!(await this.adapter.exists(file))) continue
      try {
        const parsed = JSON.parse(await this.adapter.read(file)) as Record<string, AttachmentState>
        for (const [id, state] of Object.entries(parsed)) {
          if (state && typeof state.path === 'string') into.set(id, state)
        }
      } catch (error) {
        log.error(`the local state file ${name} is unreadable, starting fresh`, error)
      }
    }
    for (const [fileId, state] of this.attachments) this.attachmentPaths.set(state.path, fileId)
  }

  attachment(fileId: string): AttachmentState | undefined {
    return this.attachments.get(fileId)
  }

  /** The file this device last knew at `path`, live or deleted since. */
  attachmentAt(path: string): string | undefined {
    return this.attachmentPaths.get(path)
  }

  setAttachment(fileId: string, state: AttachmentState): void {
    const previous = this.attachments.get(fileId)
    if (previous && this.attachmentPaths.get(previous.path) === fileId) this.attachmentPaths.delete(previous.path)
    this.attachments.set(fileId, state)
    this.attachmentPaths.set(state.path, fileId)
    this.scheduleSave()
  }

  forgetAttachment(fileId: string): void {
    const previous = this.attachments.get(fileId)
    if (!previous) return
    if (this.attachmentPaths.get(previous.path) === fileId) this.attachmentPaths.delete(previous.path)
    this.attachments.delete(fileId)
    this.scheduleSave()
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
        await this.adapter.write(this.path(STATE_FILE), JSON.stringify(Object.fromEntries(this.entries)))
        await this.adapter.write(this.path(ATTACHMENTS_FILE), JSON.stringify(Object.fromEntries(this.attachments)))
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
