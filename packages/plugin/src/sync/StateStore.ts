import type { DataAdapter } from 'obsidian'
import { log } from '../log.js'
import { emptyFolder } from '../pluginFolder.js'

// Per-device bookkeeping that must not travel through the CRDT: what this
// machine last agreed on with the shared document.

export interface FileState {
  path: string
  /** `stat` of the file as we last saw it agree with the document. */
  mtime: number
  size: number
  /**
   * Where the note's log stood then, with nothing of this device's unsent: a start that finds the
   * file as it was then and nothing unsent since (`isUnsent`) only watches the note from there
   * instead of opening it (0.9.15). Absent: the note is opened, as before.
   */
  seq?: number
  /** The fingerprint of the frame at `seq`: a seq alone names no place in a log (invariant 19). */
  hash?: string
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

/**
 * How this device first met a vault on the server (`Joining`). `before`: it had synced the
 * vault before there was such a record. Not `done`: the choice was being carried out when the
 * device stopped, and the next start carries it on without asking again.
 */
export interface JoinRecord {
  at: number
  choice: 'merge' | 'server' | 'before'
  done: boolean
  /** The copy of the whole vault made before anything was changed. */
  backup?: string
}

const STATE_FILE = 'state.json'
const ATTACHMENTS_FILE = 'attachments.json'
const CLEARED_FILE = 'cleared.json'
const UNSENT_FILE = 'unsent.json'
const JOINED_FILE = 'joined.json'
const BASE_DIR = 'base'
const SAVE_DEBOUNCE_MS = 1_000

export class StateStore {
  private readonly entries = new Map<string, FileState>()
  private readonly attachments = new Map<string, AttachmentState>()
  /** path -> fileId, for the scan's question which file this device knows a path as. */
  private readonly attachmentPaths = new Map<string, string>()
  /** Purged notes whose local copy this device has cleared - never opened, and so made, again. */
  private readonly cleared = new Set<string>()
  /**
   * Notes with changes of this device's the server has not acknowledged: written before the
   * outbox's first piece is (`markUnsent`), so a start after a crash opens each and sends them.
   */
  private readonly unsent = new Set<string>()
  /** That list could not be read: any note may have changes waiting. */
  private unsentUnknown = false
  /** By vault id. */
  private readonly joins = new Map<string, JoinRecord>()
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

  /**
   * What this device agreed on with every vault, and how it met them - gone, so the next
   * start meets the vault as a new device would (*Disconnect this vault*, `sync/Disconnect.ts`).
   * Only while no store is open on it.
   */
  static async forget(adapter: DataAdapter, root: string): Promise<void> {
    for (const file of [STATE_FILE, ATTACHMENTS_FILE, CLEARED_FILE, UNSENT_FILE, JOINED_FILE]) {
      const path = `${root}/${file}`
      if (await adapter.exists(path)) await adapter.remove(path)
    }
    const base = `${root}/${BASE_DIR}`
    if (!(await adapter.exists(base))) return
    const emptied = await emptyFolder(adapter, base, true)
    if (emptied.failed > 0) throw new Error(`${emptied.failed} base text(s) of this device could not be removed`)
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
    for (const [name, into] of [
      [CLEARED_FILE, this.cleared],
      [UNSENT_FILE, this.unsent]
    ] as const) {
      const file = this.path(name)
      if (!(await this.adapter.exists(file))) continue
      try {
        const ids = JSON.parse(await this.adapter.read(file)) as unknown
        if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') into.add(id)
      } catch (error) {
        // Unread, every note counts as possibly unsent: none is left unopened at the start.
        if (name === UNSENT_FILE) this.unsentUnknown = true
        log.error(`the local state file ${name} is unreadable, starting fresh`, error)
      }
    }
    const joined = this.path(JOINED_FILE)
    if (await this.adapter.exists(joined)) {
      try {
        const parsed = JSON.parse(await this.adapter.read(joined)) as Record<string, JoinRecord>
        for (const [vaultId, record] of Object.entries(parsed)) {
          if (record && typeof record.at === 'number' && typeof record.done === 'boolean') this.joins.set(vaultId, record)
        }
      } catch (error) {
        // Unread, the vault is compared once more before it syncs: asking again loses nothing.
        log.error(`the local state file ${JOINED_FILE} is unreadable, starting fresh`, error)
      }
    }
  }

  joinOf(vaultId: string): JoinRecord | undefined {
    return this.joins.get(vaultId)
  }

  /** Written at once and waited for: what a start after a crash carries on from. */
  setJoin(vaultId: string, record: JoinRecord): Promise<void> {
    this.joins.set(vaultId, record)
    if (this.closed) return this.writes
    this.writes = this.writes
      .then(async () => {
        await this.ensureDir(this.root)
        await this.adapter.write(this.path(JOINED_FILE), JSON.stringify(Object.fromEntries(this.joins)))
      })
      .catch((error) => log.error('writing how this device joined the vault failed', error))
    return this.writes
  }

  isUnsent(docId: string): boolean {
    return this.unsentUnknown || this.unsent.has(docId)
  }

  /**
   * Written at once, and waited for: the outbox's first piece goes to the disk only after this.
   * In line with every other write of these files, or an older save landing later took it away.
   */
  markUnsent(docId: string): Promise<void> {
    if (this.unsent.has(docId) || this.closed) return this.writes
    this.unsent.add(docId)
    this.writes = this.writes
      .then(async () => {
        await this.ensureDir(this.root)
        await this.adapter.write(this.path(UNSENT_FILE), JSON.stringify(Array.from(this.unsent)))
      })
      .catch((error) => log.error('writing the list of unsent notes failed', error))
    return this.writes
  }

  /** Everything acknowledged: said with the next save, a moment late at worst - which only opens the note once more. */
  clearUnsent(docId: string): void {
    if (!this.unsent.delete(docId)) return
    this.scheduleSave()
  }

  isCleared(docId: string): boolean {
    return this.cleared.has(docId)
  }

  markCleared(docId: string): void {
    if (this.cleared.has(docId)) return
    this.cleared.add(docId)
    this.scheduleSave()
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
        await this.adapter.write(this.path(CLEARED_FILE), JSON.stringify(Array.from(this.cleared)))
        await this.adapter.write(this.path(UNSENT_FILE), JSON.stringify(Array.from(this.unsent)))
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
