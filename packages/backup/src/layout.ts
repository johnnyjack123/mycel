import {
  ATTACHMENTS_FIELD,
  CONTENT_FIELD,
  INDEX_FIELD,
  SETTINGS_FIELD,
  docRoom,
  indexRoom,
  settingsRoom,
  type AttachmentEntry,
  type IndexEntry
} from '@mycel/shared'
import type { Cache } from './cache.js'
import type { VaultKeys } from './keys.js'

// What a backup holds, decided from the vault's index the way the plugin
// decides it: the live notes and files under their paths, what the trash can
// still restore, and the account-wide settings.
//
//   <Vault>/                  the vault: notes, canvases, attachments, shared notes in the share folder
//   <Vault> (trash)/          what the trash still has, under its last path
//   <Vault> settings.json     the account-wide settings

/** One file of the backup, by its path below the destination. */
export interface OutFile {
  path: string
  /** Milliseconds; when it last changed, as far as the backup can tell. */
  mtime: number
  content: { kind: 'text'; text: string } | { kind: 'blob'; blobId: string; hash: string; size: number }
  /** Into the folder restic reads (notes, canvases, settings), or into the stream of files. */
  part: 'notes' | 'files'
}

export interface VaultLayout {
  files: OutFile[]
  /** Live notes and files, for noticing a vault that suddenly lost most of either. */
  liveNotes: number
  liveFiles: number
  /** Blobs the layout reads, by blob id, with their content hash. */
  blobs: Map<string, string>
  /** Rooms the index still names; the cache lets go of the others. */
  rooms: Set<string>
  /**
   * Paths whose content could not be had this time - a note with frames there
   * was no key for, a file the sync server lacks. The trusted copy keeps what
   * it has for them.
   */
  incomplete: Set<string>
  problems: string[]
}

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_RETENTION_DAYS = 30
const TRASH = ' (trash)'
const SETTINGS = ' settings.json'
// Entries of the settings document that are not settings: contacts, their
// codes, the recovery decision, the backup servers with their passwords.
const NOT_SETTINGS = /^(contact|code|pending|backup[A-Za-z]*):|^recovery$/

/** The vault's folder name: its name, made a single path segment. */
export function vaultFolder(name: string): string {
  const folder = name.replace(/[/\\]/g, '_').replace(/[\u0000-\u001f]/g, '').trim()
  return folder === '' || folder === '.' || folder === '..' ? '_' : folder
}

/**
 * A vault path made safe to write below a folder: no absolute path, no `..`,
 * no empty or control-character segment. Paths come from the vault's own
 * index, but a backup writing outside its folder would be beyond repair.
 */
export function safePath(path: string): string {
  const segments = path
    .split('/')
    .map((segment) => segment.replace(/[\u0000-\u001f]/g, ''))
    .filter((segment) => segment !== '' && segment !== '.')
    .map((segment) => (segment === '..' ? '__' : segment))
  return segments.length === 0 ? '_' : segments.join('/')
}

/** `a/b.md` with ` (2)` becomes `a/b (2).md`. */
export function withSuffix(path: string, suffix: string): string {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  return dot > slash + 1 ? `${path.slice(0, dot)}${suffix}${path.slice(dot)}` : `${path}${suffix}`
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-')
}

function isCanvas(path: string): boolean {
  return path.toLowerCase().endsWith('.canvas')
}

export async function buildLayout(cache: Cache, keys: VaultKeys, now: number): Promise<VaultLayout> {
  const { vaultId, vaultName } = keys.grant
  const folder = vaultFolder(vaultName)
  const layout: VaultLayout = {
    files: [],
    liveNotes: 0,
    liveFiles: 0,
    blobs: new Map(),
    rooms: new Set([indexRoom(vaultId), settingsRoom(vaultId)]),
    incomplete: new Set(),
    problems: []
  }
  const taken = new Set<string>()
  const place = (wanted: string, suffix: (n: number) => string): string => {
    let path = wanted
    for (let n = 2; taken.has(path.toLowerCase()); n += 1) path = withSuffix(wanted, suffix(n))
    taken.add(path.toLowerCase())
    return path
  }

  const index = await cache.room(indexRoom(vaultId))
  if (!index) throw new Error('the vault index is not available')
  const indexed = await keys.replay(index)
  if (indexed.unreadable > 0) throw new Error('the vault index could not be decrypted')
  const settingsRoomCache = await cache.room(settingsRoom(vaultId))
  const settings = settingsRoomCache ? await keys.replay(settingsRoomCache) : null
  try {
    const settingsMap = settings?.doc.getMap<unknown>(SETTINGS_FIELD)
    const retention = settingsMap?.get('historyRetentionDays')
    const days = typeof retention === 'number' && Number.isInteger(retention) && retention >= 0 ? retention : DEFAULT_RETENTION_DAYS
    const since = days > 0 ? now - days * DAY_MS : 0

    const notes = indexed.doc.getMap<IndexEntry>(INDEX_FIELD)
    const attachments = indexed.doc.getMap<AttachmentEntry>(ATTACHMENTS_FIELD)
    notes.forEach((entry, docId) => {
      if (!entry.purgedAt && !entry.forkedTo) layout.rooms.add(docRoom(docId))
    })
    // Sorted by id, as the plugin sorts when two claim one path: every run
    // gives the same file the same place.
    const live = Array.from(notes.entries())
      .filter(([, entry]) => !entry.deletedAt)
      .sort(([a], [b]) => (a < b ? -1 : 1))
    layout.liveNotes = live.length
    const trashed = Array.from(notes.entries())
      .filter(([, entry]) => entry.deletedAt && !entry.owner && !entry.forkedTo && !entry.purgedAt && entry.deletedAt >= since)
      .sort(([, a], [, b]) => (b.deletedAt as number) - (a.deletedAt as number))

    const noteText = async (docId: string, path: string): Promise<{ text: string; changedAt: number } | null> => {
      const cached = await cache.room(docRoom(docId))
      if (!cached) {
        layout.problems.push(`no copy of the note ${docId}`)
        layout.incomplete.add(path)
        return null
      }
      const replayed = await keys.replay(cached)
      try {
        if (replayed.unreadable > 0) {
          layout.problems.push(`${replayed.unreadable} change(s) of the note ${docId} could not be decrypted`)
          layout.incomplete.add(path)
        }
        return { text: replayed.doc.getText(CONTENT_FIELD).toString(), changedAt: replayed.changedAt }
      } finally {
        replayed.doc.destroy()
      }
    }

    for (const [docId, entry] of live) {
      const path = place(`${folder}/${safePath(entry.path)}`, (n) => ` (${n})`)
      const note = await noteText(docId, path)
      if (!note) continue
      layout.files.push({ path, mtime: note.changedAt || entry.updatedAt, content: { kind: 'text', text: note.text }, part: 'notes' })
    }

    const fileOut = async (entry: AttachmentEntry, path: string): Promise<void> => {
      const blobId = await keys.blobId(entry.hash)
      layout.blobs.set(blobId, entry.hash)
      layout.files.push({
        path,
        mtime: entry.updatedAt,
        content: { kind: 'blob', blobId, hash: entry.hash, size: entry.size },
        part: isCanvas(entry.path) ? 'notes' : 'files'
      })
    }
    const liveFiles = Array.from(attachments.entries())
      .filter(([, entry]) => !entry.deletedAt)
      .sort(([a], [b]) => (a < b ? -1 : 1))
    layout.liveFiles = liveFiles.length
    for (const [, entry] of liveFiles) await fileOut(entry, place(`${folder}/${safePath(entry.path)}`, (n) => ` (${n})`))

    // The newest deletion keeps the plain path; older ones of the same path
    // are told apart by when they went.
    const trashFolder = `${folder}${TRASH}`
    const deletedPath = (path: string, deletedAt: number): string =>
      place(`${trashFolder}/${safePath(path)}`, () => ` (deleted ${stamp(deletedAt)})`)
    for (const [docId, entry] of trashed) {
      const path = deletedPath(entry.path, entry.deletedAt as number)
      const note = await noteText(docId, path)
      if (!note) continue
      layout.files.push({ path, mtime: note.changedAt || entry.updatedAt, content: { kind: 'text', text: note.text }, part: 'notes' })
    }
    const trashedFiles = Array.from(attachments.entries())
      .filter(([, entry]) => entry.deletedAt && !entry.purgedAt && entry.deletedAt >= since)
      .sort(([, a], [, b]) => (b.deletedAt as number) - (a.deletedAt as number))
    for (const [, entry] of trashedFiles) await fileOut(entry, deletedPath(entry.path, entry.deletedAt as number))

    if (settingsMap) {
      const values: Record<string, unknown> = {}
      for (const key of Array.from(settingsMap.keys()).sort()) {
        if (!NOT_SETTINGS.test(key)) values[key] = settingsMap.get(key)
      }
      layout.files.push({
        path: place(`${folder}${SETTINGS}`, (n) => ` (${n})`),
        mtime: settings?.changedAt || now,
        content: { kind: 'text', text: `${JSON.stringify(values, null, 2)}\n` },
        part: 'notes'
      })
    }
  } finally {
    indexed.doc.destroy()
    settings?.doc.destroy()
  }
  return layout
}
