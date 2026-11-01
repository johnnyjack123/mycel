import { Notice as ObsidianNotice, type DataAdapter } from 'obsidian'
import { log } from './log.js'

// The notification center (`docs/TIMEMACHINE.md`, U5): every notice the plugin
// shows still pops up, and is kept besides - on this device, in the plugin
// folder - for a view that lists them. Only the plugin's own: Obsidian lets no
// plugin read another's.

export type NoticeKind = 'info' | 'error'

/**
 * A button a notice carries - *Undo* on a delete for everyone - kept with it, so
 * it still works from the notification center, after a restart too: what it does
 * is named by `kind`, carried out by the handler registered for it, with `data`.
 */
export interface NoticeAction {
  label: string
  kind: string
  data: unknown
  /** Done already, from the notice or from the center: not offered again. */
  done?: boolean
}

export interface NoticeEntry {
  at: number
  text: string
  kind: NoticeKind
  /** The note it is about, when it names one. */
  path?: string
  action?: NoticeAction
}

const KEPT_MAX = 500
const KEPT_MS = 30 * 24 * 60 * 60_000
const SAVE_DELAY_MS = 1_000
// A notice saying something went wrong; the rest is information.
const PROBLEM = /\b(fail|failed|could not|cannot|can't|couldn't|error|refused|lost|not reachable|no answer)\b/i
const NOTE_PATH = /([^\s"'(<>:]+(?:\/[^\s"'(<>:]+)*\.md)\b/

function textOf(message: string | DocumentFragment): string {
  return typeof message === 'string' ? message : (message.textContent ?? '')
}

class NoticeLog {
  private entries: NoticeEntry[] = []
  private readonly handlers = new Map<string, (data: unknown) => Promise<void>>()
  /** Everything up to this moment was seen in the view. */
  private seenUntil = 0
  private adapter: DataAdapter | null = null
  private file: string | null = null
  private saveTimer: number | null = null
  private readonly listeners = new Set<() => void>()

  /** Reads what was kept, and keeps what comes from now on in `file`. */
  async attach(adapter: DataAdapter, file: string): Promise<void> {
    this.adapter = adapter
    this.file = file
    try {
      if (await adapter.exists(file)) {
        const stored = JSON.parse(await adapter.read(file)) as { entries?: NoticeEntry[]; seenUntil?: number }
        // Those shown before it was read stay, newest last.
        this.entries = [...(stored.entries ?? []).filter((entry) => typeof entry.text === 'string'), ...this.entries]
        this.seenUntil = Math.max(this.seenUntil, stored.seenUntil ?? 0)
        this.trim()
        this.emit()
      }
    } catch (error) {
      log.warn('reading the kept notices failed; starting afresh', error)
    }
  }

  detach(): void {
    this.flush()
    this.adapter = null
    this.file = null
  }

  /** Keeps a notice's text; null when it says nothing. Its button's label is not part of the text. */
  add(text: string, action?: NoticeAction): NoticeEntry | null {
    let said = text.trim()
    if (action && said.endsWith(action.label)) said = said.slice(0, -action.label.length).trim()
    if (!said) return null
    const entry: NoticeEntry = { at: Date.now(), text: said, kind: PROBLEM.test(said) ? 'error' : 'info' }
    const path = NOTE_PATH.exec(said)?.[1]
    if (path) entry.path = path
    if (action) entry.action = { ...action }
    this.entries.push(entry)
    this.trim()
    this.scheduleSave()
    this.emit()
    return entry
  }

  /** What a button of `kind` does; registered once by the plugin, before any such notice is used. */
  handle(kind: string, handler: (data: unknown) => Promise<void>): () => void {
    this.handlers.set(kind, handler)
    return () => this.handlers.delete(kind)
  }

  /** Whether an entry's button can still be pressed. */
  canAct(entry: NoticeEntry): boolean {
    return Boolean(entry.action && !entry.action.done && this.handlers.has(entry.action.kind))
  }

  /** Presses an entry's button - from the notice or from the center -, once. */
  async act(entry: NoticeEntry): Promise<void> {
    const action = entry.action
    const handler = action ? this.handlers.get(action.kind) : undefined
    if (!action || action.done || !handler) return
    action.done = true
    this.scheduleSave()
    this.emit()
    try {
      await handler(action.data)
    } catch (error) {
      action.done = false
      this.scheduleSave()
      this.emit()
      throw error
    }
  }

  /** Newest first. */
  list(): NoticeEntry[] {
    return [...this.entries].reverse()
  }

  unseen(): number {
    return this.entries.filter((entry) => entry.at > this.seenUntil).length
  }

  /** Whether an entry came after the view was last looked at. */
  isNew(entry: NoticeEntry): boolean {
    return entry.at > this.seenUntil
  }

  markSeen(): void {
    const last = this.entries.at(-1)?.at ?? 0
    if (last <= this.seenUntil) return
    this.seenUntil = last
    this.scheduleSave()
    this.emit()
  }

  clear(): void {
    this.entries = []
    this.scheduleSave()
    this.emit()
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private trim(): void {
    const since = Date.now() - KEPT_MS
    this.entries = this.entries.filter((entry) => entry.at >= since).slice(-KEPT_MAX)
  }

  private scheduleSave(): void {
    if (!this.adapter || this.saveTimer !== null) return
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, SAVE_DELAY_MS)
  }

  private flush(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = null
    const adapter = this.adapter
    const file = this.file
    if (!adapter || !file) return
    void adapter.write(file, JSON.stringify({ entries: this.entries, seenUntil: this.seenUntil })).catch((error: unknown) => {
      log.warn('keeping the notices failed', error)
    })
  }
}

/** The notices of this device, newest last. */
export const notices = new NoticeLog()

/** Obsidian's notice, kept for the notification center as well. */
export class Notice extends ObsidianNotice {
  /** What the center keeps of it; null for a notice that said nothing. */
  readonly entry: NoticeEntry | null

  constructor(message: string | DocumentFragment, duration?: number, action?: NoticeAction) {
    // Read before Obsidian takes the fragment's nodes into its own notice, which
    // leaves it empty: a notice with a button never reached the center (0.8.14).
    const text = textOf(message)
    super(message as string, duration)
    this.entry = notices.add(text, action)
  }
}
