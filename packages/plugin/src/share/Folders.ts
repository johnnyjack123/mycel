import { TFile, TFolder, type App } from 'obsidian'
import * as Y from 'yjs'
import {
  docRoom,
  folderRoom,
  roomKind,
  roomSubject,
  snapshotAad,
  type FolderNotice,
  type FolderRotation,
  type FolderStateResponse,
  type FolderTie,
  type IncomingFolder,
  type IndexEntry,
  type NoteRotation,
  type NotifyKind,
  type ShareRole,
  type VaultFolder
} from '@obsidian-connect/shared'
import { aesKey, deriveDocId, encrypt, packFrame, toBase64 } from '@obsidian-connect/shared/crypto'
import { ApiError, type ConnectApi } from '../account/api.js'
import type { KeyRing } from '../account/KeyRing.js'
import { LocalCursor, type LocalStore, type OpenLocalStore } from '../sync/DocHandle.js'
import type { AttachmentStore, LocalFileChange } from '../sync/AttachmentStore.js'
import type { DocStore, LocalChange } from '../sync/DocStore.js'
import { FolderIndex } from '../sync/FolderIndex.js'
import { FolderFiles } from './FolderFiles.js'
import { linkedFiles, linkedOutside, type LinkedNote } from './LinkedNotes.js'
import type { IdScheme, VaultIndex } from '../sync/VaultIndex.js'
import type { VaultSocket } from '../sync/VaultSocket.js'
import type { Sharing } from './Sharing.js'
import { log } from '../log.js'

// Shared folders on this device (docs/PHASE7.md). Each folder is a room of
// its own holding where its notes are, relative to the folder; this mirrors it
// into the vault index below the folder's place in this vault - the folder
// itself for its owner, the copy someone accepted for everyone else - and the
// other way round. What reaches everyone is decided by the device where it
// happened, from Obsidian's events, once they settled: a folder renamed or
// deleted arrives as an event per file, and must not be taken for its notes
// moving out or being deleted one by one.

const STALE_RETRIES = 5
const STALE_WAIT_MS = 300

export interface FoldersOptions {
  /** Where folders others share land. */
  shareFolder: () => string
  syncTimeoutMs: number
  /** Accept incoming folders into this vault without asking - true when the account has one vault. */
  autoAccept: () => boolean
  /** How long the events of one move or delete are gathered before it is weighed. */
  settleMs: number
  /**
   * How long another device of the account may take to weigh a delete it
   * made: a delete in the vault index the folder does not know of is undone
   * only once it is older than that.
   */
  decideMs: number
}

/** An existing note moved into a shared folder: it goes into the share only once someone said so. */
export interface MoveInQuestion {
  folderId: string
  /** The folder's name and where the note lies now. */
  folderPath: string
  path: string
  /** Who would see it. */
  people: string[]
  /** Files outside the folder the note embeds or links, which would go along with it. */
  files: string[]
  /**
   * Notes outside the folder it reaches through links, which can go along once
   * - shared on their own, staying where they are (E8).
   */
  linked: LinkedNote[]
  /** Of everyone in the folder, how many are not contacts here: a note can only be shared with a contact. */
  strangers: number
  /** Someone else's folder: the note is copied in, and becomes theirs. */
  copy: boolean
  /** Resolves when the question no longer stands - answered on another device, the note moved again. */
  moot: Promise<void>
}

export interface MoveInAnswer {
  choice: 'share' | 'back'
  /** Share the notes it links to as well, with everyone in the folder. */
  withLinked: boolean
}

/** A note of the owner's lies outside its shared folder, still shared there - after a crash in between. */
export interface OutsideQuestion {
  folderId: string
  folderPath: string
  path: string
  people: string[]
  moot: Promise<void>
}

export interface FolderPrompts {
  moveIn(question: MoveInQuestion): Promise<MoveInAnswer | null>
  outside(question: OutsideQuestion): Promise<'end' | 'back' | null>
}

/** What a device says about folders, as a notice or in the log. */
export type FolderNews =
  | { kind: 'deleted'; folderPath: string; names: string[]; people: string[]; batch: DeletedBatch }
  | { kind: 'moved-out'; path: string; people: string[] }
  | { kind: 'stays-yours'; folderPath: string; path: string }
  | { kind: 'not-yours'; path: string; owner: string }
  | { kind: 'accepted'; path: string; owner: string }
  | { kind: 'ended'; path: string; owner: string; kept: number }
  /** For the owner: someone the folder is shared with left it. */
  | { kind: 'left'; path: string; who: string }
  /** The notes a note moved into a folder links to went along. */
  | { kind: 'linked'; path: string; shared: number; failed: number; people: string[] }

interface OpenFolder {
  index: FolderIndex
  local: LocalStore
  cursor: LocalCursor
}

/** What a delete for everyone in a shared folder took: enough to bring it back, from a notice or later from the notification center. */
export interface DeletedBatch {
  folderId: string
  names: string[]
  docIds: Array<{ docId: string; path: string }>
  files: Array<{ file: string; path: string }>
}

/** A path inside a shared folder of this vault: which folder, and where in it. */
export interface FolderPlace {
  folderId: string
  folder: VaultFolder
  mount: string
  rel: string
}

function joinPath(mount: string, rel: string): string {
  return mount ? `${mount}/${rel}` : rel
}

function inside(path: string, mount: string): boolean {
  return path.startsWith(`${mount}/`)
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Shared folder'
}

export class Folders {
  private readonly open = new Map<string, OpenFolder>()
  private readonly opening = new Map<string, Promise<OpenFolder | null>>()
  private readonly work = new Map<string, Promise<void>>()
  private readonly pending = new Map<string, LocalChange>()
  private readonly pendingFiles = new Map<string, LocalFileChange>()
  /** Who is in each of this vault's folders, as the server said lately: whose stores the folder's files may lie in. */
  private readonly memberCache = new Map<string, { at: number; accounts: Set<string> }>()
  private readonly files: FolderFiles | null = null
  /** Folders a folder-level event named, deleted or renamed, while their notes' events settle. */
  private readonly folderEvents: Array<{ kind: 'renamed'; from: string; to: string } | { kind: 'deleted'; path: string }> = []
  private readonly asking = new Set<string>()
  /** Notes whose window was closed without an answer: not asked again until the next start. */
  private readonly dismissed = new Set<string>()
  /** Folders whose pass waits until this device's own changes are weighed. */
  private readonly later = new Set<string>()
  /** Folders whose first pass since opening is still to come: the one that looks for what a crash left. */
  private readonly fresh = new Set<string>()
  private readonly toldReader = new Set<string>()
  private readonly mootWaiters = new Set<() => void>()
  private readonly peopleCache = new Map<string, { at: number; names: string[]; strangers: number }>()
  /** Folders this device is leaving or keeping as its own: their end is no news here. */
  private readonly parting = new Map<string, 'leave' | 'detach'>()
  /** Notes and files asked about as moved in the moment their event came: not asked again once the move settled. */
  private readonly askedEarly = new Set<string>()
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private allTimer: ReturnType<typeof setTimeout> | null = null
  /** Folders whose pass comes back once a delete another device made had time to be weighed. */
  private readonly rechecks = new Map<string, ReturnType<typeof setTimeout>>()
  /** When the changes being gathered began: a note placed in a folder after that is a newcomer. */
  private batchStart = 0
  private deciding: Promise<void> = Promise.resolve()
  private unwatch: Array<() => void> = []
  private stopped = false
  private started = false

  constructor(
    private readonly app: App,
    private readonly api: ConnectApi,
    private readonly keys: KeyRing,
    private readonly store: DocStore,
    private readonly index: VaultIndex,
    private readonly socket: VaultSocket,
    private readonly openLocal: OpenLocalStore,
    private readonly sharing: Sharing,
    private readonly options: FoldersOptions,
    private readonly prompts: FolderPrompts,
    private readonly news: (news: FolderNews) => void,
    private readonly attachments: AttachmentStore | null = null
  ) {
    // Before the vault is scanned: a note new in a shared folder takes its id
    // from the folder, and the keys of this vault's folders are derived.
    keys.setFolderOwnership((folderId) => {
      const folder = index.folder(folderId)
      return folder !== undefined && !folder.owner
    })
    index.setIdScheme((path) => this.idScheme(path))
    this.unwatch.push(store.onLocalChange((change) => this.onLocal(change)))
    if (attachments) {
      this.files = new FolderFiles(
        attachments,
        api,
        keys,
        (path) => this.taken(path) || attachments.fileAt(path) !== null,
        (folderId, file) => this.index.isDeclined(this.fileDeclinedKey(folderId, file)),
        (folderId) => this.folderEpoch(folderId)
      )
      this.unwatch.push(attachments.onLocalFileChange((change) => this.onLocalFile(change)))
      this.unwatch.push(
        attachments.onLocalChange((change) => {
          const link = change.entry.folder
          if (change.kind !== 'restored' || !link) return
          void this.restoredFile(link).catch((error: unknown) => log.warn('bringing a file back into its shared folder failed', error))
        })
      )
    }
  }

  /**
   * A file of a shared folder brought back from this vault's trash. One a
   * reader let go of follows the folder again. One deleted for everyone comes
   * back for everyone from someone who may write - the folder's pass would
   * otherwise delete it again at once - and stays a reader's own.
   */
  private async restoredFile(link: { id: string; file: string }): Promise<void> {
    this.index.undecline(this.fileDeclinedKey(link.id, link.file))
    const opened = await this.opened(link.id)
    const folder = this.index.folder(link.id)
    const listed = opened?.index.file(link.file)
    const local = this.attachments?.linked(link.id, link.file)
    if (opened && folder && listed?.deletedAt && local && !local.entry.deletedAt) {
      if (this.mayWrite(folder)) {
        const place = this.placeOf(local.entry.path)
        opened.index.reviveFile(link.file, place?.folderId === link.id ? place.rel : listed.path, this.keys.accountId)
        log.info(`${local.entry.path}: brought back for everyone in its shared folder`)
      } else {
        this.attachments?.setFolderLink(local.fileId, null)
        this.attachments?.setFolderBase(link.id, link.file, null)
      }
    }
    await this.schedule(link.id)
  }

  /** Every folder's pass, after this vault's files changed: their new versions go out from there. */
  scheduleAll(): void {
    if (this.allTimer) clearTimeout(this.allTimer)
    this.allTimer = setTimeout(() => {
      this.allTimer = null
      for (const folderId of this.open.keys()) void this.schedule(folderId)
    }, 300)
  }

  /**
   * Whether the files a note of a shared folder links outside the folder go
   * along, as a shared note's do: the folder's choice. Null for a note in no
   * shared folder.
   */
  linkedFilesOf(docId: string): boolean | null {
    const folderId = this.index.entry(docId)?.folder
    const fi = folderId ? this.open.get(folderId)?.index : undefined
    return fi ? fi.linkedFiles : null
  }

  /** The folder's choice about files linked outside it, for the share dialog; null for a folder not shared yet. */
  linkedFilesAt(path: string): boolean | null {
    const shared = this.folderAt(path)
    const fi = shared ? this.open.get(shared.folderId)?.index : undefined
    return fi ? fi.linkedFiles : null
  }

  /** Whether a link of a note in a shared folder is to a file of that folder - which travels with the folder already. */
  linksIntoFolder(docId: string, ref: string, target: string | null): boolean {
    const folderId = this.index.entry(docId)?.folder
    const folder = folderId ? this.index.folder(folderId) : undefined
    const fi = folderId ? this.open.get(folderId)?.index : undefined
    if (!folderId || !folder || !fi) return false
    if (target && inside(target, folder.path)) return true
    return fi.allFiles().some(({ entry }) => !entry.deletedAt && !entry.leftAt && (entry.path === ref || entry.path.endsWith(`/${ref}`) || baseName(entry.path) === ref))
  }

  /** Opens every shared folder of the vault, once the vault index is there. */
  start(): void {
    if (this.stopped || this.started) return
    this.started = true
    this.unwatch.push(this.index.onFoldersChange(() => void this.openAll()))
    this.unwatch.push(this.index.onChange(() => this.wakeMoot()))
    void this.openAll()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.settleTimer) clearTimeout(this.settleTimer)
    if (this.allTimer) clearTimeout(this.allTimer)
    for (const timer of this.rechecks.values()) clearTimeout(timer)
    this.rechecks.clear()
    for (const unwatch of this.unwatch.splice(0)) unwatch()
    this.wakeMoot(true)
    for (const folderId of Array.from(this.open.keys())) await this.close(folderId)
  }

  // --- where things are ----------------------------------------------------------

  /** The innermost shared folder of this vault a path lies in. */
  placeOf(path: string): FolderPlace | null {
    let best: FolderPlace | null = null
    for (const { folderId, folder } of this.index.liveFolders()) {
      if (!inside(path, folder.path)) continue
      if (best && best.mount.length >= folder.path.length) continue
      best = { folderId, folder, mount: folder.path, rel: path.slice(folder.path.length + 1) }
    }
    return best
  }

  /** The live shared folder whose place is exactly this path. */
  folderAt(path: string): { folderId: string; folder: VaultFolder } | null {
    return this.index.liveFolders().find(({ folder }) => folder.path === path) ?? null
  }

  mayWrite(folder: VaultFolder): boolean {
    return !folder.owner || folder.role === 'write'
  }

  /** The folder a missing note is created in on the server - one this account may write in. */
  roomFolder(_docId: string, entry: IndexEntry | undefined): string | null {
    if (!entry) return null
    const folderId = entry.folder ?? this.placeOf(entry.path)?.folderId
    const folder = folderId ? this.index.folder(folderId) : undefined
    if (!folderId || !folder || folder.endedAt || folder.leftAt || !this.mayWrite(folder)) return null
    // Someone else's note lying in the folder stays theirs.
    if (entry.owner && entry.owner !== (folder.owner ?? this.keys.accountId)) return null
    return folderId
  }

  folderEpoch(folderId: string): number {
    return this.socket.epochOf(folderRoom(folderId))
  }

  /** The folder's epoch as the server has it now. */
  async currentEpoch(folderId: string): Promise<number> {
    return (await this.api.folderState(folderId)).epoch
  }

  private idScheme(path: string): IdScheme | null {
    const place = this.placeOf(path)
    if (!place || !this.mayWrite(place.folder)) return null
    return {
      derive: async (generation) => {
        const key = await this.keys.folderIdKey(place.folderId, this.folderEpoch(place.folderId))
        return key ? deriveDocId(key, place.rel, generation) : null
      },
      taken: (docId) => this.open.get(place.folderId)?.index.has(docId) ?? false
    }
  }

  private isFolder(path: string): boolean {
    return this.app.vault.getAbstractFileByPath(path) instanceof TFolder
  }

  /** Whether a path holds anything - a file, or a note this vault knows there. */
  private taken(path: string): boolean {
    return this.app.vault.getAbstractFileByPath(path) !== null || this.index.docIdForPath(path) !== undefined
  }

  /** The path itself, or the first free one next to it. */
  private freePlace(path: string): string {
    if (!this.taken(path)) return path
    const stem = path.replace(/\.md$/, '')
    let candidate = `${stem} 2.md`
    for (let n = 3; this.taken(candidate); n += 1) candidate = `${stem} ${n}.md`
    return candidate
  }

  private freeFolderPath(path: string): string {
    // An empty folder is free: what a folder deleted on another device of this
    // account leaves behind here - the same folder shared again took "X 2".
    const used = (candidate: string): boolean => {
      const there = this.app.vault.getAbstractFileByPath(candidate)
      const empty = there instanceof TFolder && !this.app.vault.getFiles().some((file) => inside(file.path, candidate))
      return (there !== null && !empty) || this.index.liveFolders().some(({ folder }) => folder.path === candidate)
    }
    if (!used(path)) return path
    let candidate = `${path} 2`
    for (let n = 3; used(candidate); n += 1) candidate = `${path} ${n}`
    return candidate
  }

  // --- the folder rooms ----------------------------------------------------------

  private async openAll(): Promise<void> {
    if (this.stopped) return
    const live = new Set(this.index.liveFolders().map(({ folderId }) => folderId))
    for (const folderId of live) if (!this.open.has(folderId)) void this.opened(folderId)
    for (const folderId of Array.from(this.open.keys())) if (!live.has(folderId)) await this.close(folderId)
  }

  /** The folder's document, kept on the device and joined to its room. */
  private opened(folderId: string): Promise<OpenFolder | null> {
    const open = this.open.get(folderId)
    if (open) return Promise.resolve(open)
    const pending = this.opening.get(folderId)
    if (pending) return pending
    const opening = this.openFolder(folderId).finally(() => this.opening.delete(folderId))
    this.opening.set(folderId, opening)
    return opening
  }

  private async openFolder(folderId: string): Promise<OpenFolder | null> {
    const folder = this.index.folder(folderId)
    if (!folder || folder.endedAt || folder.leftAt || this.stopped) return null
    const index = new FolderIndex(folderId)
    const local = this.openLocal(`obsidian-connect/${this.keys.vaultId}/fld-${folderId}`, index.doc)
    await local.whenSynced
    const cursor = await LocalCursor.load(local)
    const still = this.index.folder(folderId)
    if (this.stopped || !still || still.endedAt || still.leftAt) {
      await cursor.flush()
      await local.destroy()
      index.destroy()
      return null
    }
    const opened: OpenFolder = { index, local, cursor }
    this.open.set(folderId, opened)
    this.fresh.add(folderId)
    this.socket.register(folderRoom(folderId), index.doc, {
      crypto: this.keys.folderRoomCrypto(folderId),
      cursor,
      create: !folder.owner,
      readOnly: !this.mayWrite(folder)
    })
    index.onChange(() => {
      this.wakeMoot()
      this.schedule(folderId)
    })
    this.schedule(folderId)
    return opened
  }

  private async close(folderId: string): Promise<void> {
    const opened = this.open.get(folderId)
    if (!opened) return
    this.open.delete(folderId)
    this.socket.unregister(folderRoom(folderId))
    await opened.cursor.flush()
    await opened.local.destroy()
    opened.index.destroy()
  }

  /** Whether the folder's document is what the server has: nothing is decided against one it never sent. */
  private async ready(folderId: string): Promise<OpenFolder | null> {
    const opened = await this.opened(folderId)
    if (!opened) return null
    const room = folderRoom(folderId)
    if (this.socket.isSynced(room)) return opened
    const synced = await Promise.race([
      this.socket.whenSynced(room).then(() => true),
      delay(this.options.syncTimeoutMs).then(() => false)
    ])
    return synced ? opened : null
  }

  /** One pass per folder at a time; a pass asked for meanwhile runs after it. */
  schedule(folderId: string): Promise<void> {
    const previous = this.work.get(folderId) ?? Promise.resolve()
    const next = previous.then(() => this.reconcile(folderId)).catch((error: unknown) => log.error('following a shared folder failed', error))
    this.work.set(folderId, next)
    return next
  }

  /** Waits until every folder's pending pass is done - and the decisions about local changes. */
  async settled(): Promise<void> {
    await this.deciding
    await Promise.all(Array.from(this.work.values()))
  }

  // --- from the folder into the vault ----------------------------------------------

  /**
   * Brings the vault in line with the folder's document: notes new in it
   * come in, renames follow where the note still lies where the folder had
   * it, a delete for everyone is applied as a delete from another device.
   */
  private async reconcile(folderId: string): Promise<void> {
    if (this.stopped || !this.store.ready) return
    // While this device's own moves and deletes settle, the folder may be
    // between two places: a note coming in now would land at the old one and
    // bring the folder back there.
    if (this.settleTimer !== null || this.pending.size > 0 || this.pendingFiles.size > 0 || this.folderEvents.length > 0) {
      this.later.add(folderId)
      return
    }
    const opened = await this.ready(folderId)
    const folder = this.index.folder(folderId)
    if (!opened || !folder || folder.endedAt || folder.leftAt) return
    const fi = opened.index
    const mount = folder.path
    const write = this.mayWrite(folder)
    const me = this.keys.accountId
    if (!folder.owner && !fi.name) fi.setName(baseName(mount))

    for (const { docId, entry } of fi.all()) {
      if (this.pending.has(docId) || this.asking.has(docId)) continue
      const known = this.index.entry(docId)
      const target = joinPath(mount, entry.path)
      if (entry.leftAt) continue
      if (entry.deletedAt) {
        if (known && !known.deletedAt && known.folder === folderId) {
          // Changed here after it was deleted elsewhere: it stays, for everyone.
          if (write && known.updatedAt > entry.deletedAt) fi.revive(docId, this.relOf(known.path, mount) ?? entry.path, me)
          else this.index.markDeleted(docId)
        }
        continue
      }
      if (this.isDeclined(folderId, docId)) continue
      if (!known) {
        this.index.adopt(docId, this.freePlace(target), {
          shared: true,
          owner: folder.owner,
          role: folder.role,
          folder: folderId,
          folderPath: entry.path
        })
        continue
      }
      if (known.forkedTo || known.purgedAt) continue
      if (known.deletedAt) {
        // Restored in the folder - or a delete here that was never decided on.
        if (this.undecided(folderId, known.deletedAt)) continue
        this.index.revive(docId, this.freePlace(target))
        this.index.setFolderOf(docId, { id: folderId, path: entry.path, owner: folder.owner, role: folder.role })
        continue
      }
      const following = known.folderPath === undefined ? known.path === target : known.path === joinPath(mount, known.folderPath)
      if (known.folder !== folderId || known.folderPath !== entry.path || (folder.owner && known.role !== this.roleOf(known, folder))) {
        if (following && known.path !== target && !this.taken(target)) this.index.rename(docId, target)
        this.index.setFolderOf(docId, { id: folderId, path: entry.path, owner: folder.owner, role: this.roleOf(known, folder) })
      }
    }
    if (this.files) {
      const waits = {
        pending: (fileId: string): boolean => this.pendingFiles.has(fileId),
        undecided: (deletedAt: number): boolean => this.undecided(folderId, deletedAt)
      }
      await this.files.reconcile(folderId, folder, fi, waits, await this.membersOf(folderId, folder))
    }
    const first = this.fresh.delete(folderId)
    if (write) this.checkStrays(folderId, folder, fi, first)
  }

  /**
   * A delete in the vault index that the folder does not know of: the device
   * it was made on may still be weighing it (invariant 29) - this one would
   * otherwise bring the note back before that one says it is gone for
   * everyone. Undone only once it had time; the folder's pass comes back then.
   */
  private undecided(folderId: string, deletedAt: number): boolean {
    const wait = deletedAt + this.options.decideMs - Date.now()
    if (wait <= 0) return false
    if (!this.rechecks.has(folderId)) {
      this.rechecks.set(
        folderId,
        setTimeout(() => {
          this.rechecks.delete(folderId)
          void this.schedule(folderId)
        }, wait + 50)
      )
    }
    return true
  }

  /** Who is in one of this vault's folders - asked of the server at most once a minute; null for someone else's folder. */
  private async membersOf(folderId: string, folder: VaultFolder): Promise<Set<string> | null> {
    if (folder.owner) return null
    const cached = this.memberCache.get(folderId)
    if (cached && Date.now() - cached.at < 60_000) return cached.accounts
    try {
      const state = await this.api.folderState(folderId)
      const accounts = new Set(state.members.map((member) => member.account))
      this.memberCache.set(folderId, { at: Date.now(), accounts })
      return accounts
    } catch {
      return null
    }
  }

  private fileDeclinedKey(folderId: string, file: string): string {
    return `folderfile:${folderId}:${file}`
  }

  private relOf(path: string, mount: string): string | null {
    return inside(path, mount) ? path.slice(mount.length + 1) : null
  }

  /** Someone else's folder: its role, or - for a note shared on its own as well - the higher of the two. */
  private roleOf(entry: IndexEntry, folder: VaultFolder): ShareRole | undefined {
    if (!folder.owner) return undefined
    if (entry.folder !== undefined || !entry.owner) return folder.role
    return entry.role === 'write' || folder.role === 'write' ? 'write' : 'read'
  }

  /**
   * Notes the folder and this vault disagree about with nobody deciding:
   * asked about, never guessed. A note of this account's own lying in the
   * folder without being in it was moved in - on another device of the
   * account, or before a crash. A note of the owner's that is in the folder
   * but lies outside it can only be a crash between its move and the
   * decision, so that is looked for once, when the folder opens: while
   * another device of the owner moves the folder, its notes lie outside for
   * a moment.
   */
  private checkStrays(folderId: string, folder: VaultFolder, fi: FolderIndex, first: boolean): void {
    const mount = folder.path
    // A note that carries on a former note of the folder - its share ended - is
    // not a note moved in.
    const forks = new Set(this.index.deleted().flatMap(({ entry }) => (entry.forkedTo ? [entry.forkedTo] : [])))
    // What lay in the folder when it was shared goes in with the share, which
    // may still be at it here or on another device: never a note moved in.
    const before = (updatedAt: number): boolean => folder.sharedAt !== undefined && updatedAt <= folder.sharedAt
    for (const { docId, entry } of this.index.live()) {
      if (this.pending.has(docId) || this.asking.has(docId) || this.dismissed.has(docId) || forks.has(docId) || before(entry.updatedAt)) continue
      const there = inside(entry.path, mount) && this.placeOf(entry.path)?.folderId === folderId
      if (there && !entry.folder && !entry.owner && !fi.has(docId) && !this.store.isExcluded(entry.path)) {
        void this.askMoveIn(this.placeOf(entry.path) as FolderPlace, docId, null)
      } else if (first && !folder.owner && entry.folder === folderId && !there) {
        const note = fi.note(docId)
        if (note && !note.leftAt && !note.deletedAt) void this.askOutside(folderId, docId, entry.path)
      }
    }
    // A file is published from the device it was created on, a moment after
    // the vault index names it: another device of the account takes one lying
    // in the folder without being in it for moved in only when it starts.
    if (!first || !this.attachments?.isReady) return
    for (const { fileId, entry } of this.attachments.liveFiles()) {
      const key = `file:${fileId}`
      if (entry.folder || entry.via || before(entry.updatedAt) || this.pendingFiles.has(fileId) || this.asking.has(key) || this.dismissed.has(key)) continue
      const place = this.placeOf(entry.path)
      if (place?.folderId !== folderId || this.attachments.isExcluded(entry.path)) continue
      void this.askMoveInFile(place, fileId, null)
    }
  }

  // --- from the vault into the folder ----------------------------------------------

  private onLocal(change: LocalChange): void {
    if (this.stopped) return
    if (change.kind === 'created') {
      this.created(change)
      return
    }
    if (this.pending.size === 0) this.batchStart = Date.now()
    const before = this.pending.get(change.docId)
    this.pending.set(
      change.docId,
      before?.kind === 'renamed' && change.kind === 'renamed' ? { ...change, from: before.from } : change
    )
    this.scheduleDecide()
    if (change.kind === 'renamed') this.askEarly(change)
  }

  /**
   * A note moved into a shared folder from outside it is asked about at once,
   * not once the move's events settled: it cannot be part of the folder
   * itself moving, which moves only notes already in it - and waiting for
   * that made the window come seconds after the note was dropped there.
   */
  private askEarly(change: Extract<LocalChange, { kind: 'renamed' }>): void {
    const entry = this.index.entry(change.docId)
    const to = this.placeOf(change.to)
    if (!entry || entry.deletedAt || entry.folder || !to || this.placeOf(change.from)?.folderId === to.folderId) return
    this.askedEarly.add(change.docId)
    void this.askMoveIn(to, change.docId, change.from).catch((error: unknown) => log.error(`${change.to}: asking about it failed`, error))
  }

  private onLocalFile(change: LocalFileChange): void {
    if (this.stopped) return
    if (change.kind === 'created') {
      void this.createdFile(change).catch((error: unknown) => log.error(`${change.path}: sharing it in its folder failed`, error))
      return
    }
    if (this.pending.size === 0 && this.pendingFiles.size === 0) this.batchStart = Date.now()
    const before = this.pendingFiles.get(change.fileId)
    this.pendingFiles.set(
      change.fileId,
      before?.kind === 'renamed' && change.kind === 'renamed' ? { ...change, from: before.from } : change
    )
    this.scheduleDecide()
    if (change.kind !== 'renamed') return
    // Asked at once, as a note is (`askEarly`).
    const entry = this.attachments?.entryOf(change.fileId)
    const to = this.placeOf(change.to)
    if (!entry || entry.deletedAt || entry.folder || !to || this.placeOf(change.from)?.folderId === to.folderId) return
    this.askedEarly.add(`file:${change.fileId}`)
    void this.askMoveInFile(to, change.fileId, change.from).catch((error: unknown) => log.error(`${change.to}: asking about it failed`, error))
  }

  /** A file new on this device: in a folder this account writes in, it goes into the folder at once. */
  private async createdFile(change: Extract<LocalFileChange, { kind: 'created' }>): Promise<void> {
    const place = this.placeOf(change.path)
    if (!place || !this.files) return
    const { folderId, folder } = place
    if (!this.mayWrite(folder)) {
      if (!this.toldReader.has(folderId)) {
        this.toldReader.add(folderId)
        this.news({ kind: 'stays-yours', folderPath: folder.path, path: change.path })
      }
      return
    }
    const opened = await this.ready(folderId)
    if (opened) await this.files.publish(folderId, opened.index, change.fileId, place.rel)
  }

  /** Obsidian renamed a folder: a shared folder's place follows at once. */
  onFolderRenamed(from: string, to: string): void {
    if (this.stopped) return
    this.followFolderRename(from, to)
    this.folderEvents.push({ kind: 'renamed', from, to })
    this.scheduleDecide()
  }

  /** Obsidian deleted a folder: weighed with the deletes of its notes. */
  onFolderDeleted(path: string): void {
    if (this.stopped) return
    this.folderEvents.push({ kind: 'deleted', path })
    this.scheduleDecide()
  }

  /**
   * A shared folder moved: its record follows, and so does any note of it
   * that another device of the account placed at the old place meanwhile.
   */
  private followFolderRename(from: string, to: string): void {
    for (const { folderId, folder } of this.index.liveFolders()) {
      if (folder.path !== from && !inside(folder.path, from)) continue
      const old = folder.path
      const now = `${to}${old.slice(from.length)}`
      this.index.setFolder(folderId, { ...folder, path: now, updatedAt: Date.now() })
      for (const { docId, entry } of this.index.live()) {
        if (entry.folder === folderId && entry.folderPath !== undefined && entry.path === joinPath(old, entry.folderPath)) {
          this.index.rename(docId, joinPath(now, entry.folderPath))
        }
      }
      for (const { fileId, entry } of this.attachments?.liveFiles() ?? []) {
        const rel = entry.folder?.id === folderId ? this.attachments?.folderBase(folderId, entry.folder.file)?.path : undefined
        if (rel !== undefined && entry.path === joinPath(old, rel)) this.attachments?.renameFromFolder(fileId, joinPath(now, rel))
      }
    }
  }

  /**
   * Where each note or file of a shared folder went in these renames, with its
   * path in the folder - what a folder moving as a whole is told from.
   */
  private folderMoves(changes: LocalChange[], fileChanges: LocalFileChange[]): Array<{ folderId: string; rel: string; from: string; to: string }> {
    const moves: Array<{ folderId: string; rel: string; from: string; to: string }> = []
    for (const change of changes) {
      if (change.kind !== 'renamed') continue
      const entry = this.index.entry(change.docId)
      if (entry?.folder && entry.folderPath !== undefined) moves.push({ folderId: entry.folder, rel: entry.folderPath, from: change.from, to: change.to })
    }
    for (const change of fileChanges) {
      if (change.kind !== 'renamed') continue
      const link = this.attachments?.entryOf(change.fileId)?.folder
      const rel = link ? this.attachments?.folderBase(link.id, link.file)?.path : undefined
      if (link && rel !== undefined) moves.push({ folderId: link.id, rel, from: change.from, to: change.to })
    }
    return moves
  }

  private scheduleDecide(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      this.deciding = this.deciding.then(() => this.decide()).catch((error: unknown) => log.error('weighing changes in a shared folder failed', error))
    }, this.options.settleMs)
  }

  /** A note new on this device: in a folder this account writes in, it is the folder's from its first frame. */
  private created(change: Extract<LocalChange, { kind: 'created' }>): void {
    const place = this.placeOf(change.path)
    if (!place) return
    const { folderId, folder } = place
    if (!this.mayWrite(folder)) {
      if (!this.toldReader.has(folderId)) {
        this.toldReader.add(folderId)
        this.news({ kind: 'stays-yours', folderPath: folder.path, path: change.path })
      }
      return
    }
    this.index.setFolderOf(change.docId, { id: folderId, path: place.rel, owner: folder.owner, role: folder.role })
    void this.opened(folderId).then((opened) => opened?.index.add(change.docId, place.rel, this.keys.accountId))
  }

  private async decide(): Promise<void> {
    const changes = Array.from(this.pending.values())
    this.pending.clear()
    const fileChanges = Array.from(this.pendingFiles.values())
    this.pendingFiles.clear()
    const folderEvents = this.folderEvents.splice(0)
    if (this.stopped) return
    this.findMovedFolders(this.folderMoves(changes, fileChanges))
    const gone = this.goneFolders(changes, fileChanges, folderEvents)
    const deleted = new Map<string, DeletedBatch>()
    for (const change of changes) {
      try {
        if (change.kind === 'renamed') await this.renamed(change)
        else if (change.kind === 'deleted') this.deleted(change, gone, deleted)
      } catch (error) {
        log.error(`${change.kind === 'renamed' ? change.to : change.path}: changing it in its shared folder failed`, error)
      }
    }
    for (const change of fileChanges) {
      try {
        if (change.kind === 'renamed') await this.renamedFile(change)
        else if (change.kind === 'deleted') this.deletedFile(change, gone, deleted)
      } catch (error) {
        log.error(`${change.kind === 'renamed' ? change.to : change.path}: changing it in its shared folder failed`, error)
      }
    }
    for (const batch of deleted.values()) await this.announceDeleted(batch)
    for (const folderId of gone) {
      try {
        await this.folderGone(folderId)
      } catch (error) {
        log.error('ending the share of a deleted folder failed', error)
      }
    }
    if (this.settleTimer !== null || this.pending.size > 0 || this.pendingFiles.size > 0) return
    for (const folderId of Array.from(this.later)) {
      this.later.delete(folderId)
      void this.schedule(folderId)
    }
  }

  /**
   * A shared folder whose notes all turned up together somewhere else, each
   * at its place in the folder, was moved or renamed - even when Obsidian's
   * event for the folder itself never came. What still lies at the old place
   * may only be a newcomer another device of the account put there meanwhile;
   * an old place left empty is a folder that stayed while its notes went.
   */
  private findMovedFolders(moves: Array<{ folderId: string; rel: string; from: string; to: string }>): void {
    for (const { folderId, folder } of this.index.liveFolders()) {
      if (folder.owner) continue
      const targets = new Set<string>()
      for (const move of moves) {
        if (move.folderId !== folderId) continue
        if (move.from !== joinPath(folder.path, move.rel) || !move.to.endsWith(`/${move.rel}`)) {
          targets.add('')
          continue
        }
        targets.add(move.to.slice(0, move.to.length - move.rel.length - 1))
      }
      const moved = targets.size === 1 ? (Array.from(targets)[0] as string) : ''
      if (!moved || !this.isFolder(moved)) continue
      const notesStayed = this.index
        .live()
        .some(({ entry }) => entry.folder === folderId && inside(entry.path, folder.path) && entry.updatedAt < this.batchStart)
      const filesStayed = (this.attachments?.liveFiles() ?? []).some(
        ({ entry }) => entry.folder?.id === folderId && inside(entry.path, folder.path) && entry.updatedAt < this.batchStart
      )
      const leftEmpty = this.isFolder(folder.path) && !this.app.vault.getFiles().some((file) => inside(file.path, folder.path))
      if (notesStayed || filesStayed || leftEmpty) continue
      log.info(`${folder.path}: the shared folder moved to ${moved}`)
      this.followFolderRename(folder.path, moved)
    }
  }

  /** Shared folders deleted as a whole: their notes' and files' deletes are the folder's, not each its own. */
  private goneFolders(
    changes: LocalChange[],
    fileChanges: LocalFileChange[],
    events: Array<{ kind: 'renamed'; from: string; to: string } | { kind: 'deleted'; path: string }>
  ): Set<string> {
    const gone = new Set<string>()
    for (const { folderId, folder } of this.index.liveFolders()) {
      if (this.isFolder(folder.path)) continue
      const named = events.some((event) => event.kind === 'deleted' && (event.path === folder.path || inside(folder.path, event.path)))
      const notesWent = changes.some((change) => change.kind === 'deleted' && this.index.entry(change.docId)?.folder === folderId)
      const filesWent = fileChanges.some((change) => change.kind === 'deleted' && this.attachments?.entryOf(change.fileId)?.folder?.id === folderId)
      if (named || notesWent || filesWent) gone.add(folderId)
    }
    return gone
  }

  private async renamed(change: Extract<LocalChange, { kind: 'renamed' }>): Promise<void> {
    const entry = this.index.entry(change.docId)
    if (!entry || entry.deletedAt || entry.path !== change.to) return
    const to = this.placeOf(change.to)
    if (entry.folder) {
      const folderId = entry.folder
      const folder = this.index.folder(folderId)
      if (!folder || folder.endedAt || folder.leftAt) return
      if (to?.folderId === folderId) {
        // Within its folder - or back into it after lying elsewhere.
        if (this.mayWrite(folder)) {
          const opened = await this.opened(folderId)
          opened?.index.rename(change.docId, to.rel, this.keys.accountId)
          this.index.setFolderOf(change.docId, { id: folderId, path: to.rel, owner: folder.owner, role: this.roleOf(entry, folder) })
        }
        return
      }
      // Out of its folder. For its owner that ends its share there (E2.2);
      // for anyone else it only lies elsewhere now (E2.3).
      if (folder.owner) return
      if (!this.isFolder(folder.path)) return
      await this.moveOut(folderId, change.docId)
      if (to) await this.askMoveIn(to, change.docId, change.from)
      return
    }
    // Into a folder from outside it; a note moved about inside one it is not
    // in - one that carries on after its share ended - stays as it is.
    if (this.askedEarly.delete(change.docId)) return
    if (to && this.placeOf(change.from)?.folderId !== to.folderId) await this.askMoveIn(to, change.docId, change.from)
  }

  private deleted(change: Extract<LocalChange, { kind: 'deleted' }>, gone: Set<string>, deleted: Map<string, DeletedBatch>): void {
    const entry = this.index.entry(change.docId)
    const folderId = entry?.folder
    if (!entry || !folderId || gone.has(folderId)) return
    const folder = this.index.folder(folderId)
    const opened = this.open.get(folderId)
    if (!folder || folder.endedAt || folder.leftAt || !opened) return
    if (!this.mayWrite(folder)) {
      // A reader lets go of it for their account; restoring it from the trash brings it back.
      this.decline(folderId, change.docId)
      log.info(`${change.path}: deleted here, so this account lets go of it in its shared folder`)
      return
    }
    opened.index.markDeleted(change.docId, this.keys.accountId)
    const batch = this.batchOf(deleted, folderId)
    batch.names.push(baseName(change.path).replace(/\.md$/, ''))
    batch.docIds.push({ docId: change.docId, path: change.path })
    log.info(`${change.path}: deleted for everyone in its shared folder`)
  }

  private batchOf(deleted: Map<string, DeletedBatch>, folderId: string): DeletedBatch {
    let batch = deleted.get(folderId)
    if (!batch) {
      batch = { folderId, names: [], docIds: [], files: [] }
      deleted.set(folderId, batch)
    }
    return batch
  }

  private async announceDeleted(batch: DeletedBatch): Promise<void> {
    const folder = this.index.folder(batch.folderId)
    if (!folder) return
    this.news({ kind: 'deleted', folderPath: folder.path, names: batch.names, people: await this.peopleOf(batch.folderId), batch })
  }

  /** Brings back what a delete for everyone took, for everyone - its notice's *Undo*. */
  async undoDeleted({ folderId, docIds, files }: DeletedBatch): Promise<void> {
    const folder = this.index.folder(folderId)
    if (!folder) throw new Error('the folder is no longer shared here')
    const opened = await this.opened(folderId)
    const mount = folder.path
    for (const { docId, path } of docIds) {
      opened?.index.revive(docId, this.relOf(path, mount) ?? baseName(path), this.keys.accountId)
    }
    for (const { file, path } of files) {
      opened?.index.reviveFile(file, this.relOf(path, mount) ?? baseName(path), this.keys.accountId)
    }
    await this.schedule(folderId)
  }

  // --- files -------------------------------------------------------------------------
  // The same decisions as for notes; what a file does in the folder is
  // `FolderFiles`'.

  private async renamedFile(change: Extract<LocalFileChange, { kind: 'renamed' }>): Promise<void> {
    const entry = this.attachments?.entryOf(change.fileId)
    if (!entry || entry.deletedAt || entry.path !== change.to || !this.files) return
    const to = this.placeOf(change.to)
    const link = entry.folder
    if (link) {
      const folder = this.index.folder(link.id)
      const opened = await this.opened(link.id)
      if (!folder || folder.endedAt || folder.leftAt || !opened) return
      if (to?.folderId === link.id) {
        if (this.mayWrite(folder)) this.files.renamedWithin(link.id, opened.index, change.fileId, to.rel)
        return
      }
      // Out of its folder: the owner takes it out for everyone, anyone else only puts it elsewhere.
      if (folder.owner || !this.isFolder(folder.path)) return
      this.files.movedOut(link.id, opened.index, change.fileId)
      log.info(`${change.to}: left its shared folder`)
      if (to) await this.askMoveInFile(to, change.fileId, change.from)
      return
    }
    if (this.askedEarly.delete(`file:${change.fileId}`)) return
    if (to && this.placeOf(change.from)?.folderId !== to.folderId) await this.askMoveInFile(to, change.fileId, change.from)
  }

  private deletedFile(change: Extract<LocalFileChange, { kind: 'deleted' }>, gone: Set<string>, deleted: Map<string, DeletedBatch>): void {
    const link = this.attachments?.entryOf(change.fileId)?.folder
    if (!link || gone.has(link.id) || !this.files) return
    const folder = this.index.folder(link.id)
    const opened = this.open.get(link.id)
    if (!folder || folder.endedAt || folder.leftAt || !opened) return
    if (!this.mayWrite(folder)) {
      this.index.decline(this.fileDeclinedKey(link.id, link.file))
      log.info(`${change.path}: deleted here, so this account lets go of it in its shared folder`)
      return
    }
    const file = this.files.deleted(link.id, opened.index, change.fileId)
    if (!file) return
    const batch = this.batchOf(deleted, link.id)
    batch.names.push(baseName(change.path))
    batch.files.push({ file, path: change.path })
    log.info(`${change.path}: deleted for everyone in its shared folder`)
  }

  /** An existing file moved into a shared folder: shared only once asked, as a note is. */
  private async askMoveInFile(place: FolderPlace, fileId: string, from: string | null): Promise<void> {
    const key = `file:${fileId}`
    const entry = this.attachments?.entryOf(fileId)
    if (!entry || entry.deletedAt || this.asking.has(key) || !this.files) return
    const { folderId, folder } = place
    if (!this.mayWrite(folder)) {
      if (!this.toldReader.has(folderId)) {
        this.toldReader.add(folderId)
        this.news({ kind: 'stays-yours', folderPath: folder.path, path: entry.path })
      }
      return
    }
    this.asking.add(key)
    try {
      const opened = await this.ready(folderId)
      if (!opened) return
      const path = entry.path
      const stands = (): boolean => {
        const now = this.attachments?.entryOf(fileId)
        return Boolean(now && !now.deletedAt && now.path === path && !now.folder)
      }
      const audience = await this.audienceOf(folderId)
      const answer = await this.prompts.moveIn({
        folderId,
        folderPath: folder.path,
        path,
        people: audience.names,
        files: [],
        linked: [],
        strangers: audience.strangers,
        copy: false,
        moot: this.moot(stands)
      })
      if (!stands()) return
      if (answer === null) this.dismissed.add(key)
      if (answer?.choice === 'share') await this.files.publish(folderId, opened.index, fileId, place.rel)
      else if (answer?.choice === 'back') await this.moveBack(path, from)
    } finally {
      this.asking.delete(key)
    }
  }

  // --- moving in and out -----------------------------------------------------------

  /**
   * Everyone else the folder is shared with, as names: contacts by theirs,
   * the others - members a participant does not know - counted. Remembered a
   * minute, so the window asking about a note moved in opens without waiting
   * for the server.
   */
  private async peopleOf(folderId: string): Promise<string[]> {
    return (await this.audienceOf(folderId)).names
  }

  /** `peopleOf`, and how many of them are not contacts here. */
  private async audienceOf(folderId: string): Promise<{ names: string[]; strangers: number }> {
    const cached = this.peopleCache.get(folderId)
    if (cached && Date.now() - cached.at < 60_000) return cached
    try {
      const state = await this.api.folderState(folderId)
      const others = state.members.map((member) => member.account)
      if (state.owner !== this.keys.accountId) others.unshift(state.owner)
      const names: string[] = []
      let strangers = 0
      for (const account of others) {
        if (account === this.keys.accountId) continue
        const name = this.sharing.knownName(account)
        if (name) names.push(name)
        else strangers += 1
      }
      if (strangers > 0) names.push(`${strangers} more ${strangers === 1 ? 'person' : 'people'}`)
      const audience = { at: Date.now(), names, strangers }
      this.peopleCache.set(folderId, audience)
      return audience
    } catch {
      return cached ?? { names: [], strangers: 0 }
    }
  }

  /** The notes outside the folder a note moved into it reaches through links. */
  private linkedAlong(folder: VaultFolder, path: string): LinkedNote[] {
    const note = this.app.vault.getAbstractFileByPath(path)
    if (!(note instanceof TFile)) return []
    return linkedOutside(this.app.metadataCache, this.store, [note], folder.path, (account) => this.sharing.nameOf(account))
  }

  /**
   * Shares the notes a note moved into a folder links to with everyone in the
   * folder who is a contact here - once, as a note shared on its own (E8): each
   * stays where it is, and lands in the others' share folder. Everyone gets the
   * access they have in the folder, the owner to edit; without the history, as
   * the note itself went in.
   */
  private async shareAlong(folderId: string, path: string, linked: LinkedNote[]): Promise<void> {
    if (!linked.some((note) => note.docId)) return
    const state = await this.api.folderState(folderId)
    const people = state.members.map((member) => ({ account: member.account, role: member.role }))
    if (state.owner !== this.keys.accountId) people.unshift({ account: state.owner, role: 'write' })
    const files = this.open.get(folderId)?.index.linkedFiles
    const names: string[] = []
    let shared = 0
    let failed = 0
    for (const { account, role } of people) {
      const name = account === this.keys.accountId ? null : this.sharing.knownName(account)
      if (!name) continue
      const outcome = await this.sharing.shareLinked(linked, account, role, false, files)
      names.push(name)
      shared = Math.max(shared, outcome.shared + outcome.had)
      failed += outcome.failed
    }
    log.info(`${path}: ${shared} note(s) it links to shared along with ${names.length} person(s), ${failed} failed`)
    if (names.length > 0) this.news({ kind: 'linked', path, shared, failed, people: names })
  }

  /** The files a note embeds or links outside its folder that go along with it - the folder's choice. */
  private filesAlong(folderId: string, path: string): string[] {
    const fi = this.open.get(folderId)?.index
    const folder = this.index.folder(folderId)
    const note = this.app.vault.getAbstractFileByPath(path)
    if (!fi?.linkedFiles || !folder || !(note instanceof TFile)) return []
    return linkedFiles(this.app.metadataCache, note)
      .map((file) => file.path)
      .filter((file) => !inside(file, folder.path) && !this.attachments?.isExcluded(file))
  }

  /** Resolves once `stands` turns false - something changed elsewhere that answered the question. */
  private moot(stands: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      const check = (stopping = false): void => {
        if (!stopping && stands()) return
        this.mootWaiters.delete(check)
        resolve()
      }
      this.mootWaiters.add(check)
    })
  }

  private wakeMoot(stopping = false): void {
    for (const check of Array.from(this.mootWaiters)) (check as (stopping?: boolean) => void)(stopping)
  }

  /** An existing note in a shared folder that is not in it: shared only once asked (E2.1, E7.2). */
  private async askMoveIn(place: FolderPlace, docId: string, from: string | null): Promise<void> {
    const entry = this.index.entry(docId)
    if (!entry || entry.deletedAt || this.asking.has(docId)) return
    const { folderId, folder } = place
    if (entry.owner) {
      this.news({ kind: 'not-yours', path: entry.path, owner: this.sharing.nameOf(entry.owner) })
      return
    }
    if (!this.mayWrite(folder)) {
      if (!this.toldReader.has(folderId)) {
        this.toldReader.add(folderId)
        this.news({ kind: 'stays-yours', folderPath: folder.path, path: entry.path })
      }
      return
    }
    // Taken before anything is awaited: the same move may ask from two places.
    this.asking.add(docId)
    try {
      const opened = await this.ready(folderId)
      if (!opened || opened.index.has(docId)) return
      const path = entry.path
      const audience = await this.audienceOf(folderId)
      const linked = this.linkedAlong(folder, path)
      const answer = await this.prompts.moveIn({
        folderId,
        folderPath: folder.path,
        path,
        people: audience.names,
        files: this.filesAlong(folderId, path),
        linked,
        strangers: audience.strangers,
        copy: Boolean(folder.owner),
        moot: this.moot(() => {
          const now = this.index.entry(docId)
          return Boolean(now && !now.deletedAt && now.path === path && !opened.index.has(docId))
        })
      })
      const now = this.index.entry(docId)
      if (!now || now.deletedAt || now.path !== path || opened.index.has(docId)) return
      // Closed without an answer: it stays here, unshared, until asked again after a restart.
      if (answer === null) this.dismissed.add(docId)
      if (answer?.choice === 'share') {
        if (folder.owner) await this.copyIn(this.placeOf(path) as FolderPlace, docId)
        else await this.join(this.placeOf(path) as FolderPlace, docId)
        if (answer.withLinked) {
          // The note is in the folder by now: what goes along is a matter of its own.
          await this.shareAlong(folderId, path, linked).catch((error: unknown) => log.error(`${path}: sharing the notes it links to failed`, error))
        }
      } else if (answer?.choice === 'back') {
        await this.moveBack(path, from)
      }
    } finally {
      this.asking.delete(docId)
    }
  }

  private async askOutside(folderId: string, docId: string, path: string): Promise<void> {
    if (this.asking.has(docId)) return
    // Still outside the folder, wherever the folder is by now.
    const outside = (): boolean => {
      const entry = this.index.entry(docId)
      const folder = this.index.folder(folderId)
      return Boolean(entry && !entry.deletedAt && entry.path === path && entry.folder === folderId && folder && !inside(path, folder.path))
    }
    this.asking.add(docId)
    try {
      const folder = this.index.folder(folderId) as VaultFolder
      const answer = await this.prompts.outside({
        folderId,
        folderPath: folder.path,
        path,
        people: await this.peopleOf(folderId),
        moot: this.moot(outside)
      })
      if (!outside()) return
      if (answer === null) this.dismissed.add(docId)
      if (answer === 'end') await this.moveOut(folderId, docId)
      else if (answer === 'back') {
        const rel = this.index.entry(docId)?.folderPath
        const now = this.index.folder(folderId)
        if (rel && now) await this.moveBack(path, joinPath(now.path, rel))
      }
    } finally {
      this.asking.delete(docId)
    }
  }

  /** Moves a note back where it came from, as the user would: links rewritten along. */
  private async moveBack(path: string, to: string | null): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) return
    let target = to && !this.taken(to) ? to : null
    if (!target) {
      // Came into the folder some other way: out of it, next to it.
      const place = this.placeOf(path)
      target = this.freePlace(place ? baseName(path) : path)
    }
    const parent = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : ''
    if (parent && !this.app.vault.getAbstractFileByPath(parent)) await this.app.vault.createFolder(parent)
    await this.app.fileManager.renameFile(file, target)
  }

  /** The note as it stands now, encrypted under the key of an epoch about to begin. */
  private async startingPoint(docId: string, epoch: number, tie: FolderTie | null): Promise<{ uptoSeq: number; data: string }> {
    const handle = await this.store.handle(docId)
    if (!(await handle.whenRemoteReady(this.options.syncTimeoutMs))) throw new Error('The server is not reachable.')
    const raw = await this.keys.noteKeyUnder(docId, epoch, tie)
    if (!raw) throw new Error('The key of the shared folder is not here yet.')
    const state = packFrame(Date.now(), Y.encodeStateAsUpdate(handle.doc))
    const data = await encrypt(await aesKey(raw), state, snapshotAad(docRoom(docId), epoch))
    return { uptoSeq: handle.lastSeq, data: toBase64(data) }
  }

  /** The note's next key sealed for its own members. */
  private async sealForMembers(docId: string, members: string[], epoch: number, tie: FolderTie | null): Promise<Record<string, string>> {
    const keys: Record<string, string> = {}
    for (const [member, key] of await this.sharing.memberKeys(members, { kind: 'note', docId })) {
      keys[member] = (await this.keys.sealEpochKeys(docId, [epoch], key, { epoch, tie }))[String(epoch)] as string
    }
    return keys
  }

  /** Retries what the server refused because something moved meanwhile. */
  private async retrying(task: () => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await task()
        return
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && attempt < STALE_RETRIES) {
          await delay(STALE_WAIT_MS)
          continue
        }
        throw error
      }
    }
  }

  /** A note of the owner's joins its folder; its history there starts now. */
  private async join(place: FolderPlace, docId: string): Promise<void> {
    const { folderId } = place
    await this.retrying(async () => {
      const members = await this.api.members(docId)
      const state = await this.api.folderState(folderId)
      const epoch = members.epoch + 1
      const tie: FolderTie = { folder: folderId, epoch: state.epoch }
      const keys = await this.sealForMembers(docId, members.members.map((member) => member.account), epoch, tie)
      const snapshot = state.members.length > 0 ? await this.startingPoint(docId, epoch, tie) : undefined
      await this.api.joinFolderNote(folderId, { docId, epoch, folderEpoch: state.epoch, keys, snapshot })
    })
    const opened = await this.opened(folderId)
    opened?.index.add(docId, place.rel, this.keys.accountId)
    this.index.setFolderOf(docId, { id: folderId, path: place.rel })
    log.info(`${joinPath(place.mount, place.rel)}: joined its shared folder`)
  }

  /**
   * A note of a participant's own moved into someone else's folder: copied in
   * as a new note of the folder - the owner's - without its history. Its own
   * note ends, and the account's other devices fold what they hold into the
   * copy (`DocStore.forkInto`).
   */
  private async copyIn(place: FolderPlace, docId: string): Promise<void> {
    const path = joinPath(place.mount, place.rel)
    const target = await this.index.nextId(path)
    await this.store.forkInto(docId, target)
    this.index.setFolderOf(target, { id: place.folderId, path: place.rel, owner: place.folder.owner, role: place.folder.role })
    const opened = await this.opened(place.folderId)
    opened?.index.add(target, place.rel, this.keys.accountId)
    log.info(`${path}: copied into its shared folder`)
  }

  /** The owner takes a note out of its folder: everyone who had it only through the folder keeps it as their own. */
  private async moveOut(folderId: string, docId: string): Promise<void> {
    const people = await this.peopleOf(folderId)
    await this.retrying(async () => {
      const members = await this.api.members(docId)
      const epoch = members.epoch + 1
      const keys = await this.sealForMembers(docId, members.members.map((member) => member.account), epoch, null)
      await this.api.leaveFolderNote(folderId, { docId, rotation: { epoch, keys } })
    })
    const opened = await this.opened(folderId)
    opened?.index.markLeft(docId, this.keys.accountId)
    this.index.setFolderOf(docId, null)
    const path = this.index.entry(docId)?.path ?? docId
    log.info(`${path}: left its shared folder`)
    this.news({ kind: 'moved-out', path, people })
  }

  // --- declined notes ----------------------------------------------------------------

  private declinedKey(folderId: string, docId: string): string {
    return `folder:${folderId}:${docId}`
  }

  isDeclined(folderId: string, docId: string): boolean {
    return this.index.isDeclined(this.declinedKey(folderId, docId))
  }

  private decline(folderId: string, docId: string): void {
    this.index.decline(this.declinedKey(folderId, docId))
  }

  /** A note a reader let go of, brought back from their trash: it follows the folder again. */
  async undecline(folderId: string, docId: string): Promise<void> {
    this.index.undecline(this.declinedKey(folderId, docId))
    const entry = this.index.entry(docId)
    if (entry?.deletedAt) this.index.revive(docId, this.freePlace(entry.path))
    await this.schedule(folderId)
  }

  /**
   * Notes of someone else's folders that can be brought back, for the trash:
   * the ones this account let go of as a reader, and - for a writer - the
   * ones deleted for everyone, whose room the owner still keeps. The owner's
   * own are in the trash already, as notes of the vault.
   */
  trashItems(since: number): Array<{ folderId: string; docId: string; path: string; deletedAt: number }> {
    const found: Array<{ folderId: string; docId: string; path: string; deletedAt: number }> = []
    for (const { docId, entry } of this.index.deleted()) {
      const folderId = entry.folder
      const folder = folderId ? this.index.folder(folderId) : undefined
      if (!folderId || !folder?.owner || folder.endedAt || folder.leftAt || entry.forkedTo || entry.purgedAt) continue
      const deletedAt = entry.deletedAt as number
      if (deletedAt < since) continue
      const inFolder = this.open.get(folderId)?.index.note(docId)
      const restorable = this.isDeclined(folderId, docId) || (this.mayWrite(folder) && inFolder?.deletedAt !== undefined && !inFolder.leftAt)
      if (restorable) found.push({ folderId, docId, path: entry.path, deletedAt })
    }
    return found.sort((a, b) => b.deletedAt - a.deletedAt)
  }

  /** Brings a note of someone else's folder back from the trash - for everyone, when it was deleted for everyone. */
  async restore(folderId: string, docId: string): Promise<void> {
    if (this.isDeclined(folderId, docId)) {
      await this.undecline(folderId, docId)
      return
    }
    const opened = await this.ready(folderId)
    const folder = this.index.folder(folderId)
    const note = opened?.index.note(docId)
    if (!opened || !folder || !note) throw new Error('The server is not reachable.')
    opened.index.revive(docId, note.path, this.keys.accountId)
    await this.schedule(folderId)
  }

  // --- sharing a folder ----------------------------------------------------------------

  /** The folder of this vault at a path, made a shared folder if it is not one yet. */
  private async ownFolder(path: string): Promise<string> {
    const existing = this.folderAt(path)
    if (existing) {
      if (existing.folder.owner) throw new Error('This folder was shared with you; only its owner shares it.')
      return existing.folderId
    }
    for (const { folder } of this.index.liveFolders()) {
      if (inside(path, folder.path) || inside(folder.path, path)) {
        throw new Error('A folder inside a shared folder, or holding one, cannot be shared on its own.')
      }
    }
    let generation = 0
    let folderId = await this.keys.folderId(path, generation)
    while (this.index.hasFolder(folderId)) {
      generation += 1
      folderId = await this.keys.folderId(path, generation)
    }
    const now = Date.now()
    this.index.setFolder(folderId, { path, updatedAt: now, sharedAt: now })
    const opened = await this.ready(folderId)
    if (!opened) throw new Error('The server is not reachable.')
    opened.index.setName(baseName(path))
    return folderId
  }

  /** The notes of this vault's own in a folder, not in it yet. */
  private notesToJoin(folderId: string, path: string, fi: FolderIndex): Array<{ docId: string; rel: string }> {
    const found: Array<{ docId: string; rel: string }> = []
    for (const { docId, entry } of this.index.live()) {
      if (!inside(entry.path, path) || entry.owner || fi.has(docId)) continue
      if (entry.folder && entry.folder !== folderId) continue
      if (this.placeOf(entry.path)?.folderId !== folderId || this.store.isExcluded(entry.path)) continue
      found.push({ docId, rel: entry.path.slice(path.length + 1) })
    }
    return found
  }

  /** What sharing the folder at `path` would take along, for the dialog. */
  preview(path: string): { notes: number; others: string[]; nested: boolean; shared: boolean } {
    const others = this.index
      .live()
      .filter(({ entry }) => inside(entry.path, path) && entry.owner && entry.folder === undefined)
      .map(({ entry }) => entry.path)
    const nested = this.index
      .liveFolders()
      .some(({ folder }) => folder.path !== path && (inside(path, folder.path) || inside(folder.path, path)))
    const notes = this.index.live().filter(({ entry }) => inside(entry.path, path) && !entry.owner).length
    return { notes, others, nested, shared: this.folderAt(path) !== null }
  }

  /**
   * Shares the folder at `path` with someone - or again, with new access.
   * With history they read every note from where it is in the folder;
   * without, the folder moves to a new epoch and each room gets a starting
   * point first, and `progress` says how far that is.
   */
  async share(
    path: string,
    account: string,
    role: ShareRole,
    withHistory: boolean,
    progress: (done: number, total: number) => void = () => undefined,
    /** Whether the files its notes link outside it go along, as a shared note's do; unchanged when left out. */
    linkedFiles?: boolean
  ): Promise<void> {
    const recipientKey = this.sharing.recipientKey(account)
    const folderId = await this.ownFolder(path)
    const opened = await this.ready(folderId)
    if (!opened) throw new Error('The server is not reachable.')
    if (linkedFiles !== undefined) opened.index.setLinkedFiles(linkedFiles)
    // Every note and file of the folder in it first.
    const joining = this.notesToJoin(folderId, path, opened.index)
    let done = 0
    const total = joining.length
    for (const { docId, rel } of joining) {
      await this.join({ folderId, folder: this.index.folder(folderId) as VaultFolder, mount: path, rel }, docId)
      done += 1
      progress(done, total)
    }
    if (this.files && this.attachments) {
      const attachments = this.attachments
      const published = await this.files.publishAll(folderId, opened.index, path, (file) => attachments.isExcluded(file))
      if (published > 0) log.info(`${path}: ${published} file(s) went into the shared folder`)
    }
    const title = await this.keys.sealTitle(folderId, opened.index.name || baseName(path), recipientKey)
    if (withHistory) {
      await this.retrying(async () => {
        const state = await this.api.folderState(folderId)
        const keys = await this.keys.sealFolderKeys(folderId, Array.from({ length: state.epoch + 1 }, (_value, epoch) => epoch), recipientKey)
        const noteKeys: Record<string, Record<string, string>> = {}
        for (const note of state.notes ?? []) {
          if (note.since !== 0) continue
          const own = await this.ownEpochs(note.docId, folderId)
          if (own.length > 0) noteKeys[note.docId] = await this.keys.sealEpochKeys(note.docId, own, recipientKey)
        }
        await this.api.shareFolder({ folderId, account, role, withHistory: true, title, keys, noteKeys })
      })
    } else {
      await this.rotate(folderId)
      await this.startingPoints(folderId, progress)
      await this.retrying(async () => {
        const state = await this.api.folderState(folderId)
        const missing = [state.start, ...(state.notes ?? []).map((note) => note.start)].some((start) => start === null)
        if (missing) await this.startingPoints(folderId, progress)
        const keys = await this.keys.sealFolderKeys(folderId, [state.epoch], recipientKey)
        await this.api.shareFolder({ folderId, account, role, withHistory: false, title, keys })
      })
    }
    log.info(`${path}: shared with ${account} to ${role}, ${withHistory ? 'with' : 'without'} history`)
  }

  /** A note's epochs before it joined the folder - the ones the folder's key does not open. */
  private async ownEpochs(docId: string, folderId: string): Promise<number[]> {
    const response = await this.api.keys(docRoom(docId))
    const tied = Object.entries(response.ties ?? {})
      .filter(([, tie]) => tie.folder === folderId)
      .map(([epoch]) => Number(epoch))
    const first = tied.length > 0 ? Math.min(...tied) : response.epoch + 1
    return Array.from({ length: first }, (_value, epoch) => epoch)
  }

  /** The folder and every note in it to a new epoch, sealed for everyone who stays. */
  private async rotate(folderId: string, leaving?: string): Promise<FolderRotation> {
    let used: FolderRotation | null = null
    await this.retrying(async () => {
      const state = await this.api.folderState(folderId)
      const rotation = await this.rotationFor(folderId, state, leaving)
      if (leaving) await this.api.revokeFolder(folderId, { account: leaving, rotation })
      else await this.api.rotateFolder(folderId, rotation)
      used = rotation
    })
    return used as unknown as FolderRotation
  }

  private async rotationFor(folderId: string, state: FolderStateResponse, leaving?: string): Promise<FolderRotation> {
    const epoch = state.epoch + 1
    const staying = state.members.map((member) => member.account).filter((member) => member !== leaving)
    const keys: Record<string, string> = {}
    for (const [member, key] of await this.sharing.memberKeys(staying, { kind: 'folder', folderId })) {
      keys[member] = (await this.keys.sealFolderKeys(folderId, [epoch], key))[String(epoch)] as string
    }
    const notes: Record<string, NoteRotation> = {}
    for (const note of state.notes ?? []) {
      if (note.members.length === 0) continue
      const next = note.epoch + 1
      notes[note.docId] = { epoch: next, keys: await this.sealForMembers(note.docId, note.members, next, { folder: folderId, epoch }) }
    }
    return { epoch, keys, notes }
  }

  /** A starting point in its current epoch for every room of the folder that lacks one. */
  private async startingPoints(folderId: string, progress: (done: number, total: number) => void): Promise<void> {
    const state = await this.api.folderState(folderId)
    const rooms = [
      ...(state.start === null ? [folderRoom(folderId)] : []),
      ...(state.notes ?? []).filter((note) => note.start === null).map((note) => docRoom(note.docId))
    ]
    let done = 0
    for (const room of rooms) {
      await this.retrying(async () => {
        if (roomKind(room) === 'fld') await this.folderStart(folderId)
        else {
          const docId = roomSubject(room)
          const keys = await this.api.keys(room)
          const tie = keys.ties?.[String(keys.epoch)] ?? null
          const point = await this.startingPoint(docId, keys.epoch, tie)
          await this.api.startSnapshot(room, { epoch: keys.epoch, uptoSeq: point.uptoSeq, data: point.data })
        }
      })
      done += 1
      progress(done, rooms.length)
    }
  }

  private async folderStart(folderId: string): Promise<void> {
    const opened = await this.ready(folderId)
    if (!opened) throw new Error('The server is not reachable.')
    const room = folderRoom(folderId)
    const epoch = this.socket.epochOf(room)
    const key = await this.keys.folderRoomCrypto(folderId).key(epoch)
    if (!key) throw new Error('The key of the shared folder is not here yet.')
    const state = packFrame(Date.now(), Y.encodeStateAsUpdate(opened.index.doc))
    const data = await encrypt(key, state, snapshotAad(room, epoch))
    await this.api.startSnapshot(room, { epoch, uptoSeq: this.socket.lastSeqOf(room), data: toBase64(data) })
  }

  async revoke(folderId: string, account: string): Promise<void> {
    await this.rotate(folderId, account)
    log.info(`${this.index.folder(folderId)?.path ?? folderId}: access of ${account} revoked`)
  }

  async setRole(folderId: string, account: string, role: ShareRole): Promise<void> {
    await this.api.setFolderRole(folderId, { account, role })
  }

  members(folderId: string): Promise<FolderStateResponse> {
    return this.api.folderState(folderId)
  }

  /** The owner ends the share for everyone; each keeps the folder as their own. */
  async end(folderId: string): Promise<void> {
    await this.retrying(async () => {
      const state = await this.api.folderState(folderId)
      const notes: Record<string, NoteRotation> = {}
      for (const note of state.notes ?? []) {
        if (note.members.length === 0) continue
        notes[note.docId] = { epoch: note.epoch + 1, keys: await this.sealForMembers(note.docId, note.members, note.epoch + 1, null) }
      }
      await this.api.endFolder(folderId, { notes })
    })
    this.finish(folderId, 'endedAt')
    log.info(`${this.index.folder(folderId)?.path ?? folderId}: no longer shared`)
  }

  /** The vault's record of a folder whose share is over, and its notes no longer in it. */
  private finish(folderId: string, how: 'endedAt' | 'leftAt'): void {
    const folder = this.index.folder(folderId)
    if (!folder) return
    this.index.setFolder(folderId, { ...folder, [how]: Date.now(), updatedAt: Date.now() })
    for (const { docId, entry } of this.index.live()) {
      if (entry.folder === folderId && !entry.owner) this.index.setFolderOf(docId, null)
    }
  }

  /** The folder itself was deleted here: its owner ends the share (E4.3), anyone else leaves it. */
  private async folderGone(folderId: string): Promise<void> {
    const folder = this.index.folder(folderId)
    if (!folder || folder.endedAt || folder.leftAt) return
    if (!folder.owner) {
      await this.end(folderId)
      return
    }
    await this.leave(folderId)
  }

  // --- someone else's folders ------------------------------------------------------------

  /** A member leaves a folder and keeps nothing of it; notes they placed elsewhere carry on as their own. */
  async leave(folderId: string): Promise<void> {
    // The server's word that the share ended can come before its answer, and is no news here.
    this.parting.set(folderId, 'leave')
    try {
      await this.api.leaveFolder(folderId)
    } finally {
      this.parting.delete(folderId)
    }
    this.finish(folderId, 'leftAt')
    await this.close(folderId)
    for (const { docId, entry } of this.index.live()) {
      if (entry.folder === folderId) await this.keepOrFork(docId)
    }
    log.info(`${this.index.folder(folderId)?.path ?? folderId}: left`)
  }

  /** A member keeps the whole folder as their own and leaves it. */
  async detach(folderId: string): Promise<void> {
    // The dialog that asked says so itself.
    this.parting.set(folderId, 'detach')
    try {
      await this.api.detachFolder(folderId)
      await this.ended(folderId)
    } finally {
      this.parting.delete(folderId)
    }
  }

  /**
   * The share of someone else's folder ended - revoked, ended by its owner,
   * detached, the owner's account removed: every note of it carries on as
   * this vault's own, where it lies (invariant 20). A note shared on its own
   * as well stays shared that way.
   */
  async ended(folderId: string): Promise<void> {
    const parting = this.parting.get(folderId)
    const folder = this.index.folder(folderId)
    if (parting === 'leave' || !folder?.owner || folder.endedAt || folder.leftAt) return
    this.index.setFolder(folderId, { ...folder, endedAt: Date.now(), updatedAt: Date.now() })
    await this.close(folderId)
    let kept = 0
    for (const { docId, entry } of this.index.live()) {
      if (entry.folder !== folderId) continue
      await this.keepOrFork(docId)
      kept += 1
    }
    log.info(`${folder.path}: the share of the folder with ${folder.owner} ended, ${kept} note(s) kept`)
    // Deleted on another device of this account, nothing is kept: the notice must not say otherwise.
    if (!parting) this.news({ kind: 'ended', path: folder.path, owner: this.sharing.nameOf(folder.owner), kept })
  }

  private async keepOrFork(docId: string): Promise<void> {
    try {
      await this.api.members(docId)
      // Still shared on its own: no longer the folder's.
      this.index.setFolderOf(docId, null)
    } catch {
      await this.sharing.endShare(docId)
    }
  }

  /** Accepts every folder waiting, if this vault may without asking. Returns how many still wait. */
  async checkIncoming(): Promise<number> {
    const { folders } = await this.api.incomingFolders()
    if (!this.options.autoAccept()) return folders.length
    for (const incoming of folders) {
      try {
        await this.accept(incoming)
      } catch (error) {
        log.error(`accepting the folder ${incoming.folderId} failed`, error)
      }
    }
    return 0
  }

  incoming(): Promise<IncomingFolder[]> {
    return this.api.incomingFolders().then((response) => response.folders)
  }

  async accept(incoming: IncomingFolder): Promise<string> {
    const existing = this.index.folder(incoming.folderId)
    let path = existing && !existing.endedAt && !existing.leftAt ? existing.path : null
    if (!path) {
      const title = (await this.keys.openTitle(incoming.folderId, incoming.title)) || 'Shared folder'
      const root = this.options.shareFolder().replace(/^\/+|\/+$/g, '')
      path = this.freeFolderPath(joinPath(root, safeName(title)))
      this.index.setFolder(incoming.folderId, { path, owner: incoming.owner, role: incoming.role, updatedAt: Date.now() })
    }
    await this.api.acceptFolder(incoming.folderId, this.keys.vaultId)
    if (!this.app.vault.getAbstractFileByPath(path)) await this.ensureFolder(path)
    await this.opened(incoming.folderId)
    log.info(`${path}: a folder shared by ${incoming.owner} to ${incoming.role}, added`)
    this.news({ kind: 'accepted', path, owner: this.sharing.nameOf(incoming.owner) })
    return path
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!path || this.app.vault.getAbstractFileByPath(path)) return
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    await this.ensureFolder(parent)
    try {
      await this.app.vault.createFolder(path)
    } catch {
      // Created meanwhile, which is all we wanted.
    }
  }

  async onNotify(kind: NotifyKind, notice: FolderNotice): Promise<void> {
    switch (kind) {
      case 'folder-added':
        await this.checkIncoming()
        return
      case 'folder-changed': {
        const folder = this.index.folder(notice.folderId)
        this.peopleCache.delete(notice.folderId)
        if (notice.left && folder && !folder.owner) {
          this.news({ kind: 'left', path: folder.path, who: this.sharing.nameOf(notice.left) })
        }
        if (notice.role && folder?.owner && folder.role !== notice.role) {
          this.index.setFolder(notice.folderId, { ...folder, role: notice.role, updatedAt: Date.now() })
          this.socket.setReadOnly(folderRoom(notice.folderId), notice.role === 'read')
          await this.schedule(notice.folderId)
        }
        return
      }
      case 'folder-removed':
        await this.ended(notice.folderId)
        return
      default:
        return
    }
  }

  /** The server ended this account's access to a folder room. */
  onRevoked(room: string): Promise<void> {
    return this.ended(roomSubject(room))
  }

  /** Before a contact goes: every folder shared with them ends for them, theirs are left. */
  async endWith(account: string): Promise<void> {
    for (const { folderId, folder } of this.index.liveFolders()) {
      try {
        if (folder.owner === account) await this.detach(folderId)
        else if (!folder.owner && (await this.api.folderState(folderId)).members.some((member) => member.account === account)) {
          await this.revoke(folderId, account)
        }
      } catch (error) {
        log.error(`ending the folder ${folderId} with ${account} failed`, error)
      }
    }
  }

  /** The folder a note of this vault is in, and whether this account owns it. */
  folderOf(docId: string): { folderId: string; folder: VaultFolder } | null {
    const folderId = this.index.entry(docId)?.folder
    const folder = folderId ? this.index.folder(folderId) : undefined
    return folderId && folder && !folder.endedAt && !folder.leftAt ? { folderId, folder } : null
  }

  /** The epoch a note's next key is taken from, for single shares of notes in a folder. */
  nextTie(folderId: string): Promise<number> {
    return this.currentEpoch(folderId)
  }

  /** Whether this account's share of a folder ended, was left or is being kept as its own. */
  over(folderId: string): boolean {
    const folder = this.index.folder(folderId)
    return this.parting.has(folderId) || Boolean(folder?.endedAt || folder?.leftAt)
  }

  /** The folder's document as this device has it. */
  documentOf(folderId: string): FolderIndex | undefined {
    return this.open.get(folderId)?.index
  }
}
