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
import type { DocStore, LocalChange } from '../sync/DocStore.js'
import { FolderIndex } from '../sync/FolderIndex.js'
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
}

/** An existing note moved into a shared folder: it goes into the share only once someone said so. */
export interface MoveInQuestion {
  folderId: string
  /** The folder's name and where the note lies now. */
  folderPath: string
  path: string
  /** Who would see it. */
  people: string[]
  /** Someone else's folder: the note is copied in, and becomes theirs. */
  copy: boolean
  /** Resolves when the question no longer stands - answered on another device, the note moved again. */
  moot: Promise<void>
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
  moveIn(question: MoveInQuestion): Promise<'share' | 'back' | null>
  outside(question: OutsideQuestion): Promise<'end' | 'back' | null>
}

/** What a device says about folders, as a notice or in the log. */
export type FolderNews =
  | { kind: 'deleted'; folderPath: string; names: string[]; people: string[]; undo: () => Promise<void> }
  | { kind: 'moved-out'; path: string; people: string[] }
  | { kind: 'stays-yours'; folderPath: string; path: string }
  | { kind: 'not-yours'; path: string; owner: string }
  | { kind: 'accepted'; path: string; owner: string }
  | { kind: 'ended'; path: string; owner: string }

interface OpenFolder {
  index: FolderIndex
  local: LocalStore
  cursor: LocalCursor
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
  /** Folders a folder-level event named, deleted or renamed, while their notes' events settle. */
  private readonly folderEvents: Array<{ kind: 'renamed'; from: string; to: string } | { kind: 'deleted'; path: string }> = []
  private readonly asking = new Set<string>()
  private readonly toldReader = new Set<string>()
  private readonly mootWaiters = new Set<() => void>()
  private settleTimer: ReturnType<typeof setTimeout> | null = null
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
    private readonly news: (news: FolderNews) => void
  ) {
    // Before the vault is scanned: a note new in a shared folder takes its id
    // from the folder, and the keys of this vault's folders are derived.
    keys.setFolderOwnership((folderId) => {
      const folder = index.folder(folderId)
      return folder !== undefined && !folder.owner
    })
    index.setIdScheme((path) => this.idScheme(path))
    this.unwatch.push(store.onLocalChange((change) => this.onLocal(change)))
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
    const used = (candidate: string): boolean =>
      this.app.vault.getAbstractFileByPath(candidate) !== null || this.index.liveFolders().some(({ folder }) => folder.path === candidate)
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
    if (write) this.checkStrays(folderId, folder, fi)
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
   * Notes the folder and this vault disagree about with nobody deciding -
   * after a crash between an event and its decision: asked about, never
   * guessed.
   */
  private checkStrays(folderId: string, folder: VaultFolder, fi: FolderIndex): void {
    const mount = folder.path
    for (const { docId, entry } of this.index.live()) {
      if (this.pending.has(docId) || this.asking.has(docId)) continue
      const there = inside(entry.path, mount) && this.placeOf(entry.path)?.folderId === folderId
      if (there && !entry.folder && !entry.owner && !fi.has(docId) && !this.store.isExcluded(entry.path)) {
        // A note of this account's own inside the folder that is not in it.
        void this.askMoveIn(this.placeOf(entry.path) as FolderPlace, docId, null)
      } else if (!folder.owner && entry.folder === folderId && !there && fi.note(docId) && !fi.note(docId)?.leftAt && !fi.note(docId)?.deletedAt) {
        void this.askOutside(folderId, folder, docId, entry.path)
      }
    }
  }

  // --- from the vault into the folder ----------------------------------------------

  private onLocal(change: LocalChange): void {
    if (this.stopped) return
    if (change.kind === 'created') {
      this.created(change)
      return
    }
    const before = this.pending.get(change.docId)
    this.pending.set(
      change.docId,
      before?.kind === 'renamed' && change.kind === 'renamed' ? { ...change, from: before.from } : change
    )
    this.scheduleDecide()
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

  private followFolderRename(from: string, to: string): void {
    for (const { folderId, folder } of this.index.liveFolders()) {
      if (folder.path === from) this.index.setFolder(folderId, { ...folder, path: to, updatedAt: Date.now() })
      else if (inside(folder.path, from)) this.index.setFolder(folderId, { ...folder, path: `${to}${folder.path.slice(from.length)}`, updatedAt: Date.now() })
    }
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
    const folderEvents = this.folderEvents.splice(0)
    if (this.stopped) return
    this.findMovedFolders(changes)
    const gone = this.goneFolders(changes, folderEvents)
    const deleted = new Map<string, { folderId: string; names: string[]; docIds: Array<{ docId: string; path: string }> }>()
    for (const change of changes) {
      try {
        if (change.kind === 'renamed') await this.renamed(change)
        else if (change.kind === 'deleted') this.deleted(change, gone, deleted)
      } catch (error) {
        log.error(`${change.kind === 'renamed' ? change.to : change.path}: changing it in its shared folder failed`, error)
      }
    }
    for (const { folderId, names, docIds } of deleted.values()) await this.announceDeleted(folderId, names, docIds)
    for (const folderId of gone) {
      try {
        await this.folderGone(folderId)
      } catch (error) {
        log.error('ending the share of a deleted folder failed', error)
      }
    }
  }

  /**
   * A shared folder that is no longer where it was, but whose notes turn up
   * together somewhere else, was moved or renamed - even when Obsidian's
   * event for the folder itself never came.
   */
  private findMovedFolders(changes: LocalChange[]): void {
    for (const { folderId, folder } of this.index.liveFolders()) {
      if (this.isFolder(folder.path)) continue
      for (const change of changes) {
        if (change.kind !== 'renamed') continue
        const entry = this.index.entry(change.docId)
        if (entry?.folder !== folderId || entry.folderPath === undefined) continue
        if (change.from !== joinPath(folder.path, entry.folderPath) || !change.to.endsWith(`/${entry.folderPath}`)) continue
        const moved = change.to.slice(0, change.to.length - entry.folderPath.length - 1)
        if (!this.isFolder(moved)) continue
        log.info(`${folder.path}: the shared folder moved to ${moved}`)
        this.followFolderRename(folder.path, moved)
        break
      }
    }
  }

  /** Shared folders deleted as a whole: their notes' deletes are the folder's, not each its own. */
  private goneFolders(changes: LocalChange[], events: Array<{ kind: 'renamed'; from: string; to: string } | { kind: 'deleted'; path: string }>): Set<string> {
    const gone = new Set<string>()
    for (const { folderId, folder } of this.index.liveFolders()) {
      if (this.isFolder(folder.path)) continue
      const named = events.some((event) => event.kind === 'deleted' && (event.path === folder.path || inside(folder.path, event.path)))
      const notesWent = changes.some((change) => change.kind === 'deleted' && this.index.entry(change.docId)?.folder === folderId)
      if (named || notesWent) gone.add(folderId)
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
    if (to) await this.askMoveIn(to, change.docId, change.from)
  }

  private deleted(
    change: Extract<LocalChange, { kind: 'deleted' }>,
    gone: Set<string>,
    deleted: Map<string, { folderId: string; names: string[]; docIds: Array<{ docId: string; path: string }> }>
  ): void {
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
    const batch = deleted.get(folderId) ?? { folderId, names: [], docIds: [] }
    batch.names.push(baseName(change.path).replace(/\.md$/, ''))
    batch.docIds.push({ docId: change.docId, path: change.path })
    deleted.set(folderId, batch)
    log.info(`${change.path}: deleted for everyone in its shared folder`)
  }

  private async announceDeleted(folderId: string, names: string[], docIds: Array<{ docId: string; path: string }>): Promise<void> {
    const folder = this.index.folder(folderId)
    if (!folder) return
    this.news({
      kind: 'deleted',
      folderPath: folder.path,
      names,
      people: await this.peopleOf(folderId),
      undo: async () => {
        const opened = await this.opened(folderId)
        const mount = this.index.folder(folderId)?.path ?? folder.path
        for (const { docId, path } of docIds) {
          opened?.index.revive(docId, this.relOf(path, mount) ?? baseName(path), this.keys.accountId)
        }
        await this.schedule(folderId)
      }
    })
  }

  // --- moving in and out -----------------------------------------------------------

  private async peopleOf(folderId: string): Promise<string[]> {
    try {
      const state = await this.api.folderState(folderId)
      const others = state.members.map((member) => member.account)
      if (state.owner !== this.keys.accountId) others.unshift(state.owner)
      return others.filter((account) => account !== this.keys.accountId).map((account) => this.sharing.nameOf(account))
    } catch {
      return []
    }
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
    const opened = await this.ready(folderId)
    if (!opened || opened.index.has(docId)) return
    this.asking.add(docId)
    try {
      const path = entry.path
      const answer = await this.prompts.moveIn({
        folderId,
        folderPath: folder.path,
        path,
        people: await this.peopleOf(folderId),
        copy: Boolean(folder.owner),
        moot: this.moot(() => {
          const now = this.index.entry(docId)
          return Boolean(now && !now.deletedAt && now.path === path && !opened.index.has(docId))
        })
      })
      const now = this.index.entry(docId)
      if (!now || now.deletedAt || now.path !== path || opened.index.has(docId)) return
      if (answer === 'share') {
        if (folder.owner) await this.copyIn(this.placeOf(path) as FolderPlace, docId)
        else await this.join(this.placeOf(path) as FolderPlace, docId)
      } else if (answer === 'back') {
        await this.moveBack(path, from)
      }
    } finally {
      this.asking.delete(docId)
    }
  }

  private async askOutside(folderId: string, folder: VaultFolder, docId: string, path: string): Promise<void> {
    if (this.asking.has(docId)) return
    this.asking.add(docId)
    try {
      const answer = await this.prompts.outside({
        folderId,
        folderPath: folder.path,
        path,
        people: await this.peopleOf(folderId),
        moot: this.moot(() => this.index.entry(docId)?.path === path && this.index.entry(docId)?.folder === folderId)
      })
      if (this.index.entry(docId)?.path !== path) return
      if (answer === 'end') await this.moveOut(folderId, docId)
      else if (answer === 'back') {
        const rel = this.index.entry(docId)?.folderPath
        if (rel) await this.moveBack(path, joinPath(folder.path, rel))
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
    for (const member of members) {
      const sealed = await this.keys.sealEpochKeys(docId, [epoch], await this.sharing.publicKey(member), { epoch, tie })
      keys[member] = sealed[String(epoch)] as string
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

  /** The notes this account let go of in folders it reads, for the trash. */
  declinedNotes(): Array<{ folderId: string; docId: string; path: string; deletedAt: number }> {
    const found: Array<{ folderId: string; docId: string; path: string; deletedAt: number }> = []
    for (const { docId, entry } of this.index.deleted()) {
      const folderId = entry.folder
      if (folderId && this.isDeclined(folderId, docId) && !this.index.folder(folderId)?.endedAt) {
        found.push({ folderId, docId, path: entry.path, deletedAt: entry.deletedAt as number })
      }
    }
    return found.sort((a, b) => b.deletedAt - a.deletedAt)
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
    this.index.setFolder(folderId, { path, updatedAt: Date.now() })
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
    progress: (done: number, total: number) => void = () => undefined
  ): Promise<void> {
    const recipientKey = await this.sharing.publicKey(account)
    const folderId = await this.ownFolder(path)
    const opened = await this.ready(folderId)
    if (!opened) throw new Error('The server is not reachable.')
    // Every note of the folder in it first.
    const joining = this.notesToJoin(folderId, path, opened.index)
    let done = 0
    const total = joining.length
    for (const { docId, rel } of joining) {
      await this.join({ folderId, folder: this.index.folder(folderId) as VaultFolder, mount: path, rel }, docId)
      done += 1
      progress(done, total)
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
    const keys: Record<string, string> = {}
    for (const member of state.members) {
      if (member.account === leaving) continue
      keys[member.account] = (await this.keys.sealFolderKeys(folderId, [epoch], await this.sharing.publicKey(member.account)))[String(epoch)] as string
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
    await this.api.leaveFolder(folderId)
    this.finish(folderId, 'leftAt')
    await this.close(folderId)
    for (const { docId, entry } of this.index.live()) {
      if (entry.folder === folderId) await this.keepOrFork(docId)
    }
    log.info(`${this.index.folder(folderId)?.path ?? folderId}: left`)
  }

  /** A member keeps the whole folder as their own and leaves it. */
  async detach(folderId: string): Promise<void> {
    await this.api.detachFolder(folderId)
    await this.ended(folderId)
  }

  /**
   * The share of someone else's folder ended - revoked, ended by its owner,
   * detached, the owner's account removed: every note of it carries on as
   * this vault's own, where it lies (invariant 20). A note shared on its own
   * as well stays shared that way.
   */
  async ended(folderId: string): Promise<void> {
    const folder = this.index.folder(folderId)
    if (!folder?.owner || folder.endedAt || folder.leftAt) return
    this.index.setFolder(folderId, { ...folder, endedAt: Date.now(), updatedAt: Date.now() })
    await this.close(folderId)
    for (const { docId, entry } of this.index.live()) {
      if (entry.folder === folderId) await this.keepOrFork(docId)
    }
    log.info(`${folder.path}: the share of the folder with ${folder.owner} ended`)
    this.news({ kind: 'ended', path: folder.path, owner: this.sharing.nameOf(folder.owner) })
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

  /** The folder's document as this device has it. */
  documentOf(folderId: string): FolderIndex | undefined {
    return this.open.get(folderId)?.index
  }
}
