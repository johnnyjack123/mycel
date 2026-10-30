import {
  ATTACHMENTS_FIELD,
  INDEX_FIELD,
  docRoom,
  indexRoom,
  roomSubject,
  type AttachmentEntry,
  type IndexEntry,
  type LogResponse,
  type TimesResponse
} from '@obsidian-connect/shared'
import { ApiError } from '../account/api.js'
import type { RoomCrypto } from '../sync/VaultSocket.js'
import { RoomHistory } from './RoomHistory.js'

// The past of the vault or one folder of it, for the Time Machine
// (`docs/TIMEMACHINE.md`). Two sources, neither of which reads a note:
//
// - the vault index's history, walked once into events - a note or file added,
//   moved, deleted, given new content - by the authors' clocks. The entries at
//   any moment are those events replayed; no document is replayed per tick;
// - in which minutes the server took each note's frames (`GET /times`).
//
// A tick is every moment something in the vault or folder changed, those less
// than five minutes apart taken as one. A note's text at a tick is read from its
// own history when it is looked at (`NoteHistory`).

export interface Tick {
  /** The moment the tick shows: after its last change. */
  at: number
  /** When its first and its last change were made. */
  from: number
  last: number
  /** How many notes and files changed in it; 0 where the history begins. */
  changed: number
}

/** Changes less than this far apart are one tick of a folder or the vault. */
export const TICK_GAP_MS = 5 * 60_000
// A tick shows its state this long after its last change: the server's minutes
// are rounded down, and an author's clock may run a little ahead of it.
const TICK_SLACK_MS = 2 * 60_000
const MINUTE_MS = 60_000

/** A note or file of the vault index, changed at `ts`. */
interface EntryEvent {
  ts: number
  kind: 'note' | 'file'
  id: string
  /** Null when it left the index. */
  entry: IndexEntry | AttachmentEntry | null
}

/** The vault's notes and files at a moment, live and deleted, as the index had them. */
export interface VaultPast {
  notes: Map<string, IndexEntry>
  files: Map<string, AttachmentEntry>
}

export interface TimelineDeps {
  api: { log(room: string): Promise<LogResponse>; frameTimes(vaultId: string, since?: number): Promise<TimesResponse> }
  vaultId: string
  indexCrypto: RoomCrypto
}

export function inFolder(path: string | null | undefined, folder: string): boolean {
  if (path === null || path === undefined) return false
  return folder === '' || path === folder || path.startsWith(`${folder}/`)
}

/** Where a note or file is, or null while it is deleted or unknown. */
export function livePath(entry: { path: string; deletedAt?: number } | null | undefined): string | null {
  return entry && !entry.deletedAt ? entry.path : null
}

/** Whether a change of an entry is one the Time Machine shows: a note or file added, moved, deleted, or a file's content. */
function differs(before: IndexEntry | AttachmentEntry | null, after: IndexEntry | AttachmentEntry | null, kind: EntryEvent['kind']): boolean {
  if (livePath(before) !== livePath(after)) return true
  return kind === 'file' && livePath(after) !== null && (before as AttachmentEntry).hash !== (after as AttachmentEntry).hash
}

export class VaultTimeline {
  private constructor(
    private readonly initial: VaultPast,
    private readonly events: EntryEvent[],
    /** Per note, where it was from when on - oldest first. */
    private readonly paths: Map<string, Array<{ ts: number; path: string | null }>>,
    /** Per note room, the minutes it took frames in. */
    private readonly minutes: Map<string, number[]>,
    /** The earliest moment the index replays to: 0 while it holds every change. */
    readonly reach: number,
    /** Changes of the index this device has no key for. */
    readonly unreadable: number,
    /** The server could not say when notes changed: their edits make no ticks. */
    readonly withoutTimes = false
  ) {}

  static async load(deps: TimelineDeps): Promise<VaultTimeline> {
    const [history, times] = await Promise.all([
      RoomHistory.load(deps.api, indexRoom(deps.vaultId), deps.indexCrypto),
      // A server before 0.8.11 cannot say: then only what the index shows makes ticks.
      deps.api.frameTimes(deps.vaultId, 0).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) return null
        throw error
      })
    ])
    const initial: VaultPast = { notes: new Map(), files: new Map() }
    const events: EntryEvent[] = []
    const paths = new Map<string, Array<{ ts: number; path: string | null }>>()
    const changedNotes = new Set<string>()
    const changedFiles = new Set<string>()
    history.walk((doc, ts, isBase) => {
      const notes = doc.getMap<IndexEntry>(INDEX_FIELD)
      const files = doc.getMap<AttachmentEntry>(ATTACHMENTS_FIELD)
      if (isBase) {
        for (const [id, entry] of notes.entries()) {
          initial.notes.set(id, entry)
          paths.set(id, [{ ts: Number.NEGATIVE_INFINITY, path: livePath(entry) }])
        }
        for (const [id, entry] of files.entries()) initial.files.set(id, entry)
        notes.observe((event) => event.keysChanged.forEach((id) => changedNotes.add(id)))
        files.observe((event) => event.keysChanged.forEach((id) => changedFiles.add(id)))
        return
      }
      for (const id of changedNotes) {
        const entry = notes.get(id) ?? null
        events.push({ ts, kind: 'note', id, entry })
        const known = paths.get(id) ?? []
        known.push({ ts, path: livePath(entry) })
        paths.set(id, known)
      }
      for (const id of changedFiles) events.push({ ts, kind: 'file', id, entry: files.get(id) ?? null })
      changedNotes.clear()
      changedFiles.clear()
    })
    return new VaultTimeline(initial, events, paths, new Map(Object.entries(times?.rooms ?? {})), history.reach, history.unreadable, times === null)
  }

  /** Whether the index at `ts` can be told. */
  reaches(ts: number): boolean {
    return this.unreadable === 0 && ts >= this.reach
  }

  /** The vault's notes and files as the index had them at `ts`. */
  stateAt(ts: number): VaultPast {
    const notes = new Map(this.initial.notes)
    const files = new Map(this.initial.files)
    for (const event of this.events) {
      if (event.ts > ts) break
      if (event.kind === 'note') {
        if (event.entry) notes.set(event.id, event.entry as IndexEntry)
        else notes.delete(event.id)
      } else if (event.entry) {
        files.set(event.id, event.entry as AttachmentEntry)
      } else {
        files.delete(event.id)
      }
    }
    return { notes, files }
  }

  /** Where a note was at `ts`; null while deleted or before it existed. */
  pathAt(docId: string, ts: number): string | null {
    const known = this.paths.get(docId)
    if (!known) return null
    let path = known[0]?.path ?? null
    for (const record of known) {
      if (record.ts > ts) break
      path = record.path
    }
    return path
  }

  /**
   * The ticks of the vault, or of `folder`: every moment a note or file in it
   * changed, those less than `gapMs` apart as one, oldest first. Where the
   * history begins later than the vault, that is a tick too.
   */
  ticks(folder = '', gapMs = TICK_GAP_MS): Tick[] {
    const moments: Array<{ ts: number; id: string }> = []
    const notes = new Map<string, IndexEntry | AttachmentEntry>(this.initial.notes)
    const files = new Map<string, IndexEntry | AttachmentEntry>(this.initial.files)
    for (const event of this.events) {
      const entries = event.kind === 'note' ? notes : files
      const before = entries.get(event.id) ?? null
      if (event.entry) entries.set(event.id, event.entry)
      else entries.delete(event.id)
      if (!differs(before, event.entry, event.kind)) continue
      if (inFolder(livePath(before), folder) || inFolder(livePath(event.entry), folder)) moments.push({ ts: event.ts, id: `${event.kind}:${event.id}` })
    }
    // Edits of notes, by when the server took them; where the note lay then, by the index.
    for (const [room, minutes] of this.minutes) {
      const docId = roomSubject(room)
      if (!this.paths.has(docId)) continue
      for (const minute of minutes) {
        const ts = minute * MINUTE_MS
        if (ts + MINUTE_MS <= this.reach) continue
        if (inFolder(this.pathAt(docId, ts + MINUTE_MS - 1), folder)) moments.push({ ts, id: `note:${docId}` })
      }
    }
    moments.sort((a, b) => a.ts - b.ts)
    const groups: Array<{ from: number; last: number; ids: Set<string> }> = []
    for (const moment of moments) {
      const group = groups.at(-1)
      if (group && moment.ts - group.last <= gapMs) {
        group.last = moment.ts
        group.ids.add(moment.id)
      } else {
        groups.push({ from: moment.ts, last: moment.ts, ids: new Set([moment.id]) })
      }
    }
    const ticks: Tick[] = groups.map((group, i) => {
      const next = groups[i + 1]
      return { at: Math.min(group.last + TICK_SLACK_MS, next ? next.from - 1 : Number.POSITIVE_INFINITY), from: group.from, last: group.last, changed: group.ids.size }
    })
    if (this.reach > 0 && (ticks[0]?.from ?? Number.POSITIVE_INFINITY) > this.reach) {
      ticks.unshift({ at: this.reach, from: this.reach, last: this.reach, changed: 0 })
    }
    return ticks
  }

  /** When the index last changed a note or file up to `ts` - added, moved, given new content; null before the history. */
  changedAt(id: string, ts: number): number | null {
    let at: number | null = null
    for (const event of this.events) {
      if (event.ts > ts) break
      if (event.id === id) at = event.ts
    }
    return at
  }

  /** Whether the server took a change of the note after `ts` - a hint, by its clock, to the minute. */
  editedAfter(docId: string, ts: number): boolean {
    const last = this.minutes.get(docRoom(docId))?.at(-1)
    return last !== undefined && last * MINUTE_MS + MINUTE_MS > ts
  }
}
