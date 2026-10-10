import { Notice, TFile, type App } from 'obsidian'
import * as Y from 'yjs'
import {
  applyTextEdits,
  docRoom,
  indexRoom,
  textEdits,
  threeWayMerge,
  type CollabUser,
  type IndexEntry,
  type ShareRole
} from '@obsidian-connect/shared'
import { additiveEdits, reconcile, type ReconcileOutcome } from './Reconciler.js'
import { matchesGlob } from './glob.js'
import { FORK_ORIGIN, RESTORE_ORIGIN, SYNC_ORIGIN } from './origin.js'
import { seedUpdate } from './seed.js'
import { memoryHistory, type HistoryEntry, type HistoryStore } from './History.js'
import type { BackupStore } from './BackupStore.js'
import type { Review, ReviewKind } from './Reviews.js'
import { DocHandle, LocalCursor, openIndexedDb, type LocalStore, type OpenLocalStore } from './DocHandle.js'
import type { StateStore } from './StateStore.js'
import type { VaultIndex } from './VaultIndex.js'
import type { RoomCrypto, VaultSocket } from './VaultSocket.js'
import { log } from '../log.js'

export interface DocStoreOptions {
  vaultId: string
  user: CollabUser
  excludeGlobs: string[]
  conflictMarkers: boolean
  maxLoadedDocuments: number
  syncTimeoutMs: number
  writeDebounceMs: number
}

/** Where the store gets its keys; the account's key ring in the plugin. */
export interface DocAccess {
  indexCrypto: RoomCrypto
  /** Derived for a note this vault owns, sealed for one someone else owns. */
  docCrypto(docId: string, entry: IndexEntry | undefined): RoomCrypto
}

export type NoteSyncState = 'synced' | 'unsent' | 'waiting' | 'held' | 'untracked'

/** A note of this vault in the trash. */
export interface DeletedNote {
  docId: string
  path: string
  deletedAt: number
}

/** A note someone shared with this account. */
export interface AcceptedShare {
  docId: string
  owner: string
  role: ShareRole
  title: string
}

// Enough to hide the round trip per note, few enough not to flood the socket
// or IndexedDB on a vault of thousands.
const CONCURRENCY = 8
// How long a write of ours is recognised when it comes back as a file event
// or as Obsidian reloading an open editor.
const OWN_WRITE_TTL_MS = 10_000
// Upper bound on how long stopping waits for running file operations, so
// unloading the plugin never hangs on a server that stopped answering.
const STOP_DRAIN_MS = 2_000

/** `extra` folded into `base` without removing anything already there. */
function mergeAdditively(base: string, extra: string): string {
  let result = base
  const edits = additiveEdits(base, extra)
  for (let i = edits.length - 1; i >= 0; i -= 1) {
    const edit = edits[i]
    if (!edit) continue
    result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to)
  }
  return result
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

function safeFileName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'Shared note'
}

export class DocStore {
  private readonly handles = new Map<string, DocHandle>()
  private readonly lastUsed = new Map<string, number>()
  private readonly pinned = new Set<string>()
  private readonly editorOwned = new Set<string>()
  private readonly writeTimers = new Map<string, number>()
  private readonly inFlight = new Map<string, Promise<DocHandle>>()
  // One file operation per document at a time. The scan, vault events, remote
  // changes and an editor binding all reach the same note concurrently, and
  // two reconciles interleaving on one note is how text gets applied twice.
  private readonly locks = new Map<string, Promise<void>>()
  private readonly ownWrites = new Map<string, { text: string; timer: number }>()
  /** Documents whose file and document have agreed at least once this session. */
  private readonly agreed = new Set<string>()
  private readonly readyListeners = new Set<() => void>()
  private readonly leaveListeners = new Set<(docId: string) => void>()
  private readonly reviewListeners = new Set<(review: Omit<Review, 'id'>) => void>()
  /** Renames and deletes that happened before the index arrived. */
  private readonly early: Array<() => Promise<void>> = []
  private indexWork: Promise<void> = Promise.resolve()
  private indexStore: LocalStore | null = null
  private indexCursor: LocalCursor | null = null
  private indexReady = false
  private stopped = false

  constructor(
    private readonly app: App,
    private readonly socket: VaultSocket,
    private readonly index: VaultIndex,
    private readonly state: StateStore,
    private readonly backups: BackupStore,
    private options: DocStoreOptions,
    private readonly access: DocAccess,
    private readonly openLocal: OpenLocalStore = openIndexedDb,
    private readonly history: HistoryStore = memoryHistory()
  ) {}

  setOptions(options: DocStoreOptions): void {
    this.options = options
  }

  get ready(): boolean {
    return this.indexReady && !this.stopped
  }

  /** Fires once the vault index has arrived and notes can be bound to editors. */
  onReady(listener: () => void): () => void {
    this.readyListeners.add(listener)
    return () => this.readyListeners.delete(listener)
  }

  isExcluded(path: string): boolean {
    return this.options.excludeGlobs.some((pattern) => pattern && matchesGlob(path, pattern))
  }

  private tracks(file: TFile): boolean {
    return this.ready && file.extension === 'md' && !this.isExcluded(file.path) && this.exists(file)
  }

  /**
   * Whether the file is still in the vault. An editor keeps its file object
   * after the note was deleted underneath it; syncing that registered the
   * note again, and it came back - empty - on every device.
   */
  private exists(file: TFile): boolean {
    return this.app.vault.getAbstractFileByPath(file.path) === file
  }

  isShared(docId: string): boolean {
    return this.index.isShared(docId)
  }

  /** Every note of this vault that is shared, either way. */
  sharedEntries(): Array<{ docId: string; entry: IndexEntry }> {
    return this.index.live().filter(({ entry }) => entry.shared || entry.owner)
  }

  /** Someone else owns the note and shared it with this account to read only. */
  isReadOnly(docId: string): boolean {
    const entry = this.index.entry(docId)
    return Boolean(entry?.owner) && entry?.role === 'read'
  }

  /** Fires when a note someone else owns is deleted here: that is leaving the share. */
  onLeave(listener: (docId: string) => void): () => void {
    this.leaveListeners.add(listener)
    return () => this.leaveListeners.delete(listener)
  }

  /** Keeps a document loaded while it is open in an editor. */
  pin(docId: string): void {
    this.pinned.add(docId)
  }

  unpin(docId: string): void {
    this.pinned.delete(docId)
  }

  /**
   * While an editor is bound to a note, Obsidian owns the file: it saves the
   * buffer the binding keeps in step with the document. Writing the file
   * ourselves as well made Obsidian reload the open editor, which the binding
   * then read back as a user edit - a loop that doubled the text on every pass.
   */
  setEditorOwned(docId: string, owned: boolean): void {
    if (owned) {
      this.editorOwned.add(docId)
      return
    }
    if (!this.editorOwned.delete(docId)) return
    // The editor is gone, so anything it never got round to saving is ours
    // to write out now.
    this.scheduleWrite(docId)
  }

  isEditorOwned(docId: string): boolean {
    return this.editorOwned.has(docId)
  }

  private withLock<T>(docId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(docId) ?? Promise.resolve()
    const run = previous.then(task)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    this.locks.set(docId, tail)
    void tail.then(() => {
      if (this.locks.get(docId) === tail) this.locks.delete(docId)
    })
    return run
  }

  // --- own writes ------------------------------------------------------------

  private rememberOwnWrite(docId: string, text: string): void {
    const previous = this.ownWrites.get(docId)
    if (previous) window.clearTimeout(previous.timer)
    const timer = window.setTimeout(() => {
      if (this.ownWrites.get(docId)?.timer === timer) this.ownWrites.delete(docId)
    }, OWN_WRITE_TTL_MS)
    this.ownWrites.set(docId, { text, timer })
  }

  /**
   * The text this device wrote to the note's file within the last few seconds.
   * It comes back as a modify event, and Obsidian may reload it into an editor
   * that is bound by then; neither is an edit.
   */
  recentWrite(docId: string): string | null {
    return this.ownWrites.get(docId)?.text ?? null
  }

  private async writeFile(docId: string, file: TFile, text: string): Promise<void> {
    this.rememberOwnWrite(docId, text)
    await this.app.vault.modify(file, text)
  }

  // --- lifecycle -------------------------------------------------------------

  /**
   * The index is kept on the device like every note, so a rename or delete
   * made offline survives a restart and is sent once the server answers.
   */
  private async registerIndex(): Promise<void> {
    if (this.indexStore) return
    const store = this.openLocal(`obsidian-connect/${this.options.vaultId}/idx`, this.index.doc)
    this.indexStore = store
    await store.whenSynced
    this.indexCursor = await LocalCursor.load(store)
    this.socket.register(indexRoom(this.options.vaultId), this.index.doc, {
      crypto: this.access.indexCrypto,
      cursor: this.indexCursor
    })
  }

  async start(): Promise<boolean> {
    await this.state.load()
    await this.registerIndex()
    // Without the server's index we do not know which document a file belongs
    // to. Minting ids anyway would create a second document per note, so a
    // failure here has to stop the scan rather than guess.
    const indexSynced = await Promise.race([
      this.socket.whenSynced(indexRoom(this.options.vaultId)).then(() => true),
      new Promise<boolean>((resolve) =>
        window.setTimeout(() => resolve(false), this.options.syncTimeoutMs)
      )
    ])
    if (!indexSynced) {
      log.warn('the vault index did not sync; waiting for the server')
      return false
    }
    log.info(`vault index arrived: ${this.index.live().length} notes, ${this.index.deleted().length} deleted`)
    this.indexReady = true
    for (const replay of this.early.splice(0)) await replay()
    for (const listener of this.readyListeners) listener()

    // Deletes before the scan: the scan would otherwise find the file of a note
    // another device deleted and bring it back.
    await this.applyRemoteDeletes()
    await this.scanVault()
    await this.applyRemoteIndexChanges()
    return true
  }

  /** Resolves when the vault index arrives, however long that takes. */
  whenIndexSynced(): Promise<void> {
    return this.socket.whenSynced(indexRoom(this.options.vaultId))
  }

  /**
   * Catches up after the connection came back: notes that could not be
   * settled while the server was unreachable, and whatever the index gained
   * in the meantime.
   */
  async resume(): Promise<void> {
    if (!this.ready) return
    const unsettled = this.app.vault.getMarkdownFiles().filter((file) => {
      if (this.isExcluded(file.path)) return false
      const docId = this.index.docIdForPath(file.path)
      return !docId || !this.agreed.has(docId)
    })
    await this.pool(unsettled, (file) => this.syncFile(file))
    await this.applyRemoteIndexChanges()
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const timer of this.writeTimers.values()) window.clearTimeout(timer)
    this.writeTimers.clear()
    // Let file operations already under way record their outcome. Saving the
    // state before a pull finished forgot that this device has the note, and
    // a delete from elsewhere was then no longer applied to it.
    await Promise.race([
      Promise.all(Array.from(this.locks.values())),
      new Promise((resolve) => window.setTimeout(resolve, STOP_DRAIN_MS))
    ])
    for (const { timer } of this.ownWrites.values()) window.clearTimeout(timer)
    this.ownWrites.clear()
    for (const handle of this.handles.values()) await handle.destroy()
    this.handles.clear()
    this.readyListeners.clear()
    this.leaveListeners.clear()
    this.socket.unregister(indexRoom(this.options.vaultId))
    try {
      await this.indexCursor?.flush()
      await this.indexStore?.destroy()
    } catch (error) {
      log.error('closing the local index failed', error)
    }
    await this.state.close()
  }

  private async pool<T>(items: T[], task: (item: T) => Promise<void>): Promise<void> {
    let next = 0
    const worker = async (): Promise<void> => {
      while (!this.stopped && next < items.length) {
        const item = items[next] as T
        next += 1
        try {
          await task(item)
        } catch (error) {
          log.error('syncing a note failed', error)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
  }

  // --- document lifecycle ----------------------------------------------------

  private touch(docId: string): void {
    this.lastUsed.set(docId, Date.now())
  }

  async handleFor(docId: string): Promise<DocHandle> {
    // In flight first: the handle is in the map before its local state has
    // loaded, and a second caller must not see that empty document.
    const pending = this.inFlight.get(docId)
    if (pending) return pending
    const existing = this.handles.get(docId)
    if (existing && !existing.isDestroyed) {
      this.touch(docId)
      return existing
    }

    const creation = (async () => {
      const handle = new DocHandle(
        docId,
        this.options.vaultId,
        this.socket,
        this.options.user,
        {
          shared: this.isShared(docId),
          readOnly: this.isReadOnly(docId),
          crypto: this.access.docCrypto(docId, this.index.entry(docId)),
          history: this.history,
          owned: !this.index.entry(docId)?.owner
        },
        this.openLocal
      )
      this.handles.set(docId, handle)
      this.touch(docId)
      await handle.open()
      handle.ytext.observe((_event, transaction) => {
        if (transaction.origin === SYNC_ORIGIN) return
        this.scheduleWrite(docId)
      })
      return handle
    })()

    this.inFlight.set(docId, creation)
    try {
      return await creation
    } finally {
      this.inFlight.delete(docId)
      void this.evict()
    }
  }

  /**
   * Releases the least recently used documents. They stop receiving live
   * updates until touched again and catch up on the next load - the price of
   * not holding a whole vault of CRDTs in memory at once.
   */
  private async evict(): Promise<void> {
    const limit = Math.max(this.options.maxLoadedDocuments, this.pinned.size + 1)
    if (this.handles.size <= limit) return
    const candidates = Array.from(this.handles.keys())
      .filter(
        (docId) =>
          !this.pinned.has(docId) &&
          !this.inFlight.has(docId) &&
          !this.writeTimers.has(docId) &&
          !this.locks.has(docId) &&
          !this.editorOwned.has(docId)
      )
      .sort((a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0))

    for (const docId of candidates) {
      if (this.handles.size <= limit) break
      await this.dropHandle(docId)
    }
  }

  private async dropHandle(docId: string, clearLocal = false): Promise<void> {
    const timer = this.writeTimers.get(docId)
    if (timer !== undefined) window.clearTimeout(timer)
    this.writeTimers.delete(docId)
    const handle = this.handles.get(docId)
    this.handles.delete(docId)
    this.lastUsed.delete(docId)
    await handle?.destroy(clearLocal)
  }

  // --- a server that lost data or was rolled back ---------------------------------

  /** This device is right: its whole note goes to the server again, with its history. */
  async keepLocal(docId: string): Promise<void> {
    const room = docRoom(docId)
    this.socket.keepLocal(room, await this.history.entries(room))
  }

  /**
   * The server is right - it was restored on purpose. This device's text is
   * backed up, its copy of the note dropped and fetched again from the
   * server; the file then follows. A note the server does not have at all is
   * seeded again from the file, so nothing that exists here disappears.
   */
  async adoptServer(docId: string): Promise<void> {
    await this.withLock(docId, async () => {
      const file = this.fileFor(docId)
      const path = file?.path ?? this.index.pathFor(docId) ?? docId
      const text = file && this.exists(file) ? await this.app.vault.read(file) : (this.handles.get(docId)?.text() ?? '')
      if (text.length > 0) await this.backups.write(path, 'local', text)
      await this.dropHandle(docId, true)
    })
    const file = this.fileFor(docId)
    if (file && this.exists(file)) await this.syncFile(file)
  }

  private forget(docId: string): void {
    this.state.forget(docId)
    this.agreed.delete(docId)
  }

  // --- file <-> document -----------------------------------------------------

  private fileFor(docId: string): TFile | null {
    const path = this.index.pathFor(docId)
    if (!path) return null
    const file = this.app.vault.getAbstractFileByPath(path)
    return file instanceof TFile ? file : null
  }

  private scheduleWrite(docId: string): void {
    if (this.stopped || this.editorOwned.has(docId)) return
    const existing = this.writeTimers.get(docId)
    if (existing !== undefined) window.clearTimeout(existing)
    const timer = window.setTimeout(() => {
      this.writeTimers.delete(docId)
      void this.withLock(docId, () => this.writeToFile(docId))
    }, this.options.writeDebounceMs)
    this.writeTimers.set(docId, timer)
  }

  /** Projects the document onto disk. The document is the source of truth. */
  private async writeToFile(docId: string): Promise<void> {
    // Checked again here: an editor may have claimed the note since this was
    // scheduled, and from then on Obsidian is the only writer.
    if (this.stopped || this.editorOwned.has(docId)) return
    const handle = this.handles.get(docId)
    const file = this.fileFor(docId)
    if (!handle || !file) return
    const text = handle.text()
    try {
      const current = await this.app.vault.read(file)
      if (current === text) {
        await this.recordAgreement(docId, file, text)
        return
      }
      const base = await this.state.baseText(docId)
      // A plain overwrite is only safe for a note that agreed with its
      // document this session, and whose file has not changed since. Anything
      // else - a document whose state was never confirmed, a file edit not yet
      // taken in - goes through the reconcile, which knows how to keep both.
      if (!this.agreed.has(docId) || (current !== base && current !== this.recentWrite(docId))) {
        await this.reconcileFile(docId, file)
        return
      }
      await this.writeFile(docId, file, text)
      await this.recordAgreement(docId, file, text)
    } catch (error) {
      log.error(`writing ${file.path} failed`, error)
    }
  }

  /**
   * Remembers that file and document say the same thing. This snapshot is what
   * a later reconcile uses to tell an addition from a deletion.
   */
  private async recordAgreement(docId: string, file: TFile, text: string): Promise<void> {
    await this.state.setBaseText(docId, text)
    this.state.set(docId, { path: file.path, mtime: file.stat.mtime, size: file.stat.size })
    this.agreed.add(docId)
  }

  baseText(docId: string): Promise<string | null> {
    return this.state.baseText(docId)
  }

  private applyToDocument(handle: DocHandle, target: string): void {
    const edits = textEdits(handle.text(), target)
    if (edits.length === 0) return
    handle.doc.transact(() => applyTextEdits(handle.ytext, edits), SYNC_ORIGIN)
  }

  /**
   * Fills an empty document from its file with the insertion every device
   * derives alike (`seed.ts`), and returns what the document says afterwards.
   * Whatever arrived while this waited stays: with no base to tell additions
   * from deletions, only a union is safe - replacing it, as before, deleted it.
   */
  private seedDocument(handle: DocHandle, text: string): string {
    const current = handle.text()
    if (current === text) return text
    if (current.length > 0) {
      this.applyToDocument(handle, mergeAdditively(current, text))
      return handle.text()
    }
    Y.applyUpdate(handle.doc, seedUpdate(handle.docId, text), SYNC_ORIGIN)
    // A seed applied and deleted before is a no-op in Yjs. `reconcile` seeds
    // only documents that never carried anything, so that should not happen -
    // but if it did, the file's text would silently not get in.
    if (handle.text() !== text) this.applyToDocument(handle, text)
    return handle.text()
  }

  /**
   * Brings one note into agreement. Everything that can lose text funnels
   * through here, and every branch that can delete takes a backup first.
   */
  async syncFile(file: TFile): Promise<void> {
    if (!this.tracks(file)) return
    const path = file.path
    const known = this.index.docIdForPath(path)
    const docId = known ?? (await this.index.ensure(path))
    if (!known && (file.path !== path || !this.exists(file))) {
      // Deleted or renamed while its id was being derived. An entry left at
      // that path would be pulled straight back in as a note of its own.
      if (this.index.pathFor(docId) === path) this.index.markDeleted(docId)
      if (this.exists(file)) await this.syncFile(file)
      return
    }
    await this.withLock(docId, () => this.reconcileFile(docId, file))
  }

  /**
   * Settles a note that is about to be shown in an editor. Resolves to its
   * document id once file and document agree, or null while that cannot be
   * established - the server has never been reached for an empty document.
   */
  async settle(file: TFile): Promise<string | null> {
    if (!this.tracks(file)) return null
    await this.syncFile(file)
    const docId = this.index.docIdForPath(file.path)
    return docId && this.agreed.has(docId) ? docId : null
  }

  private async reconcileFile(docId: string, file: TFile): Promise<void> {
    // The index may have moved the note on while this waited for the lock,
    // or the file may be gone.
    if (this.stopped || this.index.pathFor(docId) !== file.path || !this.exists(file)) return
    const handle = await this.handleFor(docId)

    if (this.editorOwned.has(docId)) {
      // The editor and the document are kept identical keystroke by
      // keystroke, and Obsidian writes the file from that editor. The file is
      // at best a slightly older copy of the same text; merging it back in
      // is what duplicated everything typed since it was saved.
      const local = await this.app.vault.read(file)
      if (local === handle.text()) await this.recordAgreement(docId, file, local)
      return
    }

    const remoteKnown = await handle.whenRemoteReady(this.options.syncTimeoutMs)
    const local = await this.app.vault.read(file)
    const remote = handle.text()

    // Not reaching the server means the document state is unknown. Seeding or
    // merging against it could duplicate the note or delete the other side's
    // work, so only an exact match is safe to act on.
    if (!remoteKnown && remote.length === 0) {
      if (local.length > 0) {
        log.warn(`server unreachable, leaving ${file.path} untouched`)
      }
      return
    }

    if (local === remote) {
      await this.recordAgreement(docId, file, local)
      return
    }

    if (this.isReadOnly(docId)) {
      // Someone else's note, shared to read. The server refuses changes from
      // here, so the file follows the document; what was edited locally is
      // kept as a backup rather than silently diverging.
      await this.backups.write(file.path, 'local', local)
      await this.writeFile(docId, file, remote)
      await this.recordAgreement(docId, file, remote)
      return
    }

    const base = await this.state.baseText(docId)
    const outcome = reconcile({ base, local, remote, pristine: handle.pristine, markers: this.options.conflictMarkers })
    await this.applyOutcome(docId, file, handle, local, remote, base, outcome)
  }

  private async applyOutcome(
    docId: string,
    file: TFile,
    handle: DocHandle,
    local: string,
    remote: string,
    base: string | null,
    outcome: ReconcileOutcome
  ): Promise<void> {
    if (outcome.kind === 'agree') log.debug(`${file.path}: file and note agree`)
    else {
      const detail = outcome.kind === 'merge' ? ` (${outcome.additiveOnly ? 'no common base, union' : `${outcome.conflicts} conflict(s)`})` : ''
      log.info(`${file.path}: ${outcome.kind}${detail}, file ${local.length} chars, note ${remote.length}, base ${base === null ? 'none' : `${base.length}`}`)
    }
    switch (outcome.kind) {
      case 'agree':
        await this.recordAgreement(docId, file, local)
        return

      case 'seed': {
        const text = this.seedDocument(handle, local)
        if (text !== local) await this.writeFile(docId, file, text)
        await this.recordAgreement(docId, file, text)
        return
      }

      case 'adopt-local':
        this.applyToDocument(handle, local)
        await this.recordAgreement(docId, file, local)
        return

      case 'adopt-remote':
        // Text this device wrote itself a moment ago needs no copy, and while
        // someone types elsewhere every write is superseded by the next one -
        // a backup each time would bury the real ones.
        if (!(local === base && local === this.recentWrite(docId))) {
          await this.backups.write(file.path, 'local', local)
        }
        await this.writeFile(docId, file, remote)
        await this.recordAgreement(docId, file, remote)
        // Without a base, this device's version was only a part of the other
        // one - nothing of it was lost, but the other side's lines came in
        // unasked. Worth a look like any merge of two unrelated versions.
        if (base === null && local.length > 0) this.review(docId, file.path, 'no-base', local, remote, remote)
        return

      case 'merge': {
        await this.backups.captureBoth(file.path, local, remote)
        await this.backups.write(file.path, 'merged', outcome.text)
        this.applyToDocument(handle, outcome.text)
        await this.writeFile(docId, file, outcome.text)
        await this.recordAgreement(docId, file, outcome.text)
        this.announceMerge(file, outcome)
        if (outcome.additiveOnly || outcome.conflicts > 0) {
          this.review(docId, file.path, outcome.additiveOnly ? 'no-base' : 'conflict', local, remote, outcome.text)
        }
        return
      }
    }
  }

  private announceMerge(file: TFile, outcome: ReconcileOutcome & { kind: 'merge' }): void {
    if (outcome.conflicts > 0) {
      new Notice(
        `${file.basename}: ${outcome.conflicts} conflicting change(s) kept side by side. Choose what to keep with "Compare versions" in the note's menu.`,
        10_000
      )
    } else if (outcome.additiveOnly) {
      new Notice(
        `${file.basename} differed between your devices, so both versions were kept. Choose what to keep with "Compare versions" in the note's menu.`,
        10_000
      )
    }
  }

  /**
   * Edits made in an editor before it was bound - typed while the note was
   * still being settled. Returns the text editor and document both take on;
   * the caller applies it to both at once.
   */
  async resolveEditorEdits(docId: string, local: string, remote: string): Promise<string> {
    const file = this.fileFor(docId)
    const path = file?.path ?? this.index.pathFor(docId) ?? docId
    const base = await this.state.baseText(docId)
    if (this.isReadOnly(docId)) {
      if (local !== base) await this.backups.write(path, 'local', local)
      return remote
    }
    const pristine = this.handles.get(docId)?.pristine ?? false
    const outcome = reconcile({ base, local, remote, pristine, markers: this.options.conflictMarkers })
    switch (outcome.kind) {
      case 'agree':
        return remote
      case 'seed':
      case 'adopt-local':
        return local
      case 'adopt-remote':
        if (local !== base) await this.backups.write(path, 'local', local)
        return remote
      case 'merge':
        await this.backups.captureBoth(path, local, remote)
        await this.backups.write(path, 'merged', outcome.text)
        if (file) this.announceMerge(file, outcome)
        if (outcome.additiveOnly || outcome.conflicts > 0) {
          this.review(docId, path, outcome.additiveOnly ? 'no-base' : 'conflict', local, remote, outcome.text)
        }
        return outcome.text
    }
  }

  /** Two versions were kept side by side; the user may want to choose. */
  onReview(listener: (review: Omit<Review, 'id'>) => void): () => void {
    this.reviewListeners.add(listener)
    return () => this.reviewListeners.delete(listener)
  }

  private review(docId: string, path: string, kind: ReviewKind, mine: string, theirs: string, merged: string): void {
    if (mine === theirs) return
    log.info(`${path}: two versions kept (${kind}); waiting for a review`)
    for (const listener of this.reviewListeners) listener({ docId, path, at: Date.now(), kind, mine, theirs, merged })
  }

  /**
   * The user chose what a note that was merged should say. Backed up first.
   * If the note changed since the merge, the choice is merged into what it
   * says now, keeping both where the two disagree, rather than overwriting it.
   */
  async applyReview(docId: string, merged: string, chosen: string): Promise<'applied' | 'merged'> {
    return this.withLock(docId, async () => {
      const handle = await this.handleFor(docId)
      const current = handle.text()
      const path = this.index.pathFor(docId) ?? docId
      await this.backups.write(path, 'local', current)
      const target = current === merged ? chosen : threeWayMerge(merged, current, chosen, { markers: this.options.conflictMarkers }).text
      const edits = textEdits(current, target)
      // Not from the file: the file follows, like a restore.
      if (edits.length > 0) handle.doc.transact(() => applyTextEdits(handle.ytext, edits), RESTORE_ORIGIN)
      log.info(`${path}: review applied${current === merged ? '' : ', merged into what the note said since'}`)
      return current === merged ? 'applied' : 'merged'
    })
  }

  // --- vault events ----------------------------------------------------------

  async onModify(file: TFile): Promise<void> {
    await this.syncFile(file)
  }

  async onCreate(file: TFile): Promise<void> {
    await this.syncFile(file)
  }

  async onRename(file: TFile, oldPath: string): Promise<void> {
    if (this.stopped) return
    if (file.extension !== 'md') {
      // A note renamed into another kind of file is no longer a note. Left
      // in the index, it would be pulled back in at its old path, next to
      // the file it became.
      if (oldPath.endsWith('.md')) await this.onDelete(oldPath)
      return
    }
    if (!this.ready) {
      // Lost, the index would keep the old path and the old note would be
      // pulled back in next to the renamed one.
      this.early.push(() => this.onRename(file, oldPath))
      return
    }
    // Not `tracks`: moving a note into an excluded folder still moves it. Left
    // at the old path in the index, it would be pulled back in right there.
    //
    // The new path first. When the index already has a note there, this is a
    // rename it asked for - from another device - and the old path may by now
    // belong to a different note, which looking it up first used to move too.
    const docId = this.index.docIdForPath(file.path) ?? this.index.docIdForPath(oldPath)
    if (!docId) {
      await this.syncFile(file)
      return
    }
    // The identity is the document, not the path, so a rename is a rename -
    // not a delete plus a new note that has lost its history.
    this.index.rename(docId, file.path)
    const known = this.state.get(docId)
    if (known) this.state.set(docId, { ...known, path: file.path })
  }

  async onDelete(path: string): Promise<void> {
    if (this.stopped) return
    if (!this.ready) {
      // Lost, the note would be pulled back in from the index.
      this.early.push(() => this.onDelete(path))
      return
    }
    const docId = this.index.docIdForPath(path)
    if (!docId) return
    const foreign = Boolean(this.index.entry(docId)?.owner)
    await this.withLock(docId, async () => {
      const handle = this.handles.get(docId)
      if (handle) {
        // Keep a copy: a delete that arrives on another device is irreversible
        // there unless the text survives somewhere.
        await this.backups.write(path, 'local', handle.text())
        await this.dropHandle(docId)
      }
      this.index.markDeleted(docId)
      this.forget(docId)
    })
    log.info(`${path}: deleted here${foreign ? ', leaving its share' : ''}`)
    // Deleting a note someone else owns only removes it from this vault. The
    // document stays theirs; this account just leaves the share.
    if (foreign) for (const listener of this.leaveListeners) listener(docId)
  }

  /**
   * Whatever the index still holds under a deleted folder. Obsidian may report
   * only the folder, and a note left live in the index would be pulled back.
   */
  async onDeleteFolder(path: string): Promise<void> {
    if (this.stopped) return
    if (!this.ready) {
      this.early.push(() => this.onDeleteFolder(path))
      return
    }
    const prefix = `${path}/`
    for (const { entry } of this.index.live()) {
      if (entry.path.startsWith(prefix) && !this.app.vault.getAbstractFileByPath(entry.path)) {
        await this.onDelete(entry.path)
      }
    }
  }

  // --- remote index changes --------------------------------------------------

  /** Applies what other devices changed in the index. Runs one pass at a time. */
  applyRemoteIndexChanges(): Promise<void> {
    this.indexWork = this.indexWork.then(async () => {
      if (!this.ready) return
      try {
        // An entry from the other device may only now reveal that both
        // adopted the same file independently.
        await this.mergeDuplicates()
        await this.applyRemoteDeletes()
        await this.applyRemoteRenames()
        await this.pullMissing()
        this.applySharing()
      } catch (error) {
        log.error('applying index changes failed', error)
      }
    })
    return this.indexWork
  }

  /**
   * Folds documents that ended up claiming the same file into one. Without
   * this each device keeps syncing its own copy and the two never meet, which
   * looks exactly like sync being broken.
   */
  private async mergeDuplicates(): Promise<void> {
    for (const { path, docIds } of this.index.duplicatePaths()) {
      const [winnerId, ...losers] = docIds as [string, ...string[]]
      await this.withLock(winnerId, async () => {
        const winner = await this.handleFor(winnerId)
        await winner.whenRemoteReady(this.options.syncTimeoutMs)

        for (const loserId of losers) {
          const loser = await this.handleFor(loserId)
          await loser.whenRemoteReady(this.options.syncTimeoutMs)
          const text = loser.text()
          if (text.length > 0 && text !== winner.text()) {
            // Additive: the duplicate may hold edits nobody else has.
            await this.backups.write(path, 'local', text)
            this.applyToDocument(winner, mergeAdditively(winner.text(), text))
          }
          this.index.markDeleted(loserId)
          await this.dropHandle(loserId)
          this.forget(loserId)
        }
      })
      log.info(`merged ${losers.length} duplicate(s) of ${path}`)
    }
  }

  private async applyRemoteDeletes(): Promise<void> {
    for (const { docId, entry } of this.index.deleted()) {
      if (this.stopped) return
      if (!this.state.get(docId)) continue
      if (entry.forkedTo) {
        // Another device ended the share and carries the note on; what this
        // one held goes into it instead of away.
        await this.forkInto(docId, entry.forkedTo)
        continue
      }
      await this.withLock(docId, () => this.applyRemoteDelete(docId, entry))
    }
  }

  private async applyRemoteDelete(docId: string, entry: IndexEntry): Promise<void> {
    // Only a file this device has seen agree with that document is known to
    // be the note that was deleted. Anything else is not ours to remove.
    const known = this.state.get(docId)
    if (!known || !this.index.entry(docId)?.deletedAt) return
    const claimant = this.index.docIdForPath(known.path)
    const file = this.app.vault.getAbstractFileByPath(known.path)
    if ((claimant && claimant !== docId) || !(file instanceof TFile)) {
      this.forget(docId)
      return
    }
    const local = await this.app.vault.read(file)
    const base = await this.state.baseText(docId)
    if (base === null || local !== base) {
      // Changed here after this device last agreed with the document. A
      // delete elsewhere does not get to discard that, so the note stays -
      // for every device.
      log.info(`${known.path}: deleted elsewhere but changed here, kept`)
      this.index.revive(docId, known.path)
      new Notice(`${file.basename} was deleted on another device but changed here, so it was kept.`, 10_000)
      return
    }
    await this.backups.write(known.path, 'local', local)
    await this.dropHandle(docId)
    this.forget(docId)
    log.info(`${known.path}: deleted on another device, moved to the trash here`)
    try {
      await this.app.fileManager.trashFile(file)
    } catch (error) {
      log.error(`deleting ${entry.path} failed`, error)
    }
  }

  private async applyRemoteRenames(): Promise<void> {
    for (const { docId, entry } of this.index.live()) {
      if (this.stopped) return
      const known = this.state.get(docId)
      if (!known || known.path === entry.path) continue
      await this.withLock(docId, async () => {
        const target = this.index.pathFor(docId)
        const current = this.app.vault.getAbstractFileByPath(known.path)
        if (!target || !(current instanceof TFile)) return
        if (this.app.vault.getAbstractFileByPath(target)) return
        try {
          await this.ensureFolder(parentOf(target))
          // Not `fileManager.renameFile`: that rewrites the links to the note
          // in other notes, which the renaming device has already done - and
          // sent along with those notes. Both edits arriving concurrently put
          // every rewritten link in twice.
          await this.app.vault.rename(current, target)
          this.state.set(docId, { ...known, path: target })
          log.info(`${known.path}: renamed on another device to ${target}`)
        } catch (error) {
          log.error(`renaming ${known.path} to ${target} failed`, error)
        }
      })
    }
  }

  /** Creates the files of notes that exist in the index but not in this vault. */
  private async pullMissing(): Promise<void> {
    const missing = this.index
      .live()
      .filter(
        ({ entry }) =>
          entry.path.endsWith('.md') &&
          !this.isExcluded(entry.path) &&
          !this.app.vault.getAbstractFileByPath(entry.path)
      )
    await this.pool(missing, ({ docId }) => this.withLock(docId, () => this.pull(docId)))
  }

  private async pull(docId: string): Promise<void> {
    const path = this.index.pathFor(docId)
    if (!path || this.stopped || this.app.vault.getAbstractFileByPath(path)) return
    const handle = await this.handleFor(docId)
    const remoteKnown = await handle.whenRemoteReady(this.options.syncTimeoutMs)
    // Unknown, not empty. The next index change or reconnect tries again.
    if (!remoteKnown && handle.text().length === 0) return
    if (this.index.pathFor(docId) !== path || this.app.vault.getAbstractFileByPath(path)) return

    const text = handle.text()
    await this.ensureFolder(parentOf(path))
    this.rememberOwnWrite(docId, text)
    const file = await this.app.vault.create(path, text)
    await this.recordAgreement(docId, file, text)
    log.info(`${path}: created from the server, ${text.length} chars`)
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!path || this.app.vault.getAbstractFileByPath(path)) return
    await this.ensureFolder(parentOf(path))
    try {
      await this.app.vault.createFolder(path)
    } catch {
      // Created concurrently, which is all we wanted.
    }
  }

  /** Presence and write access of loaded notes follow their index entries. */
  private applySharing(): void {
    for (const [docId, handle] of this.handles) {
      handle.setShared(this.isShared(docId))
      handle.setReadOnly(this.isReadOnly(docId))
    }
  }

  // --- sharing ---------------------------------------------------------------

  share(docId: string, shared: boolean): void {
    this.index.setShared(docId, shared)
    this.applySharing()
  }

  setShareRole(docId: string, role: ShareRole): void {
    this.index.setRole(docId, role)
    this.applySharing()
  }

  /**
   * Adds a note someone shared into this vault, under `folder`, and resolves
   * to its file. An id the index already knows just resolves to that file.
   */
  async acceptShare(share: AcceptedShare, folder: string): Promise<TFile | null> {
    if (!this.ready) return null
    let path = this.index.pathFor(share.docId)
    if (!path) {
      path = this.freePath(folder, share.title)
      this.index.adopt(share.docId, path, { shared: true, owner: share.owner, role: share.role })
    }
    this.applySharing()
    await this.withLock(share.docId, () => this.pull(share.docId))
    const file = this.app.vault.getAbstractFileByPath(path)
    return file instanceof TFile ? file : null
  }

  /** The id a new note at `path` would get. */
  nextDocId(path: string): Promise<string> {
    return this.index.nextId(path)
  }

  private localName(docId: string): string {
    return `obsidian-connect/${this.options.vaultId}/${docId}`
  }

  /**
   * Everything this device holds of a note as Yjs state - unsent edits
   * included - from the loaded document or the one stored on the device.
   * Never the server's: this is for a share that ended, where the server no
   * longer answers. Null when the device holds nothing.
   */
  async localState(docId: string, clear = false): Promise<Uint8Array | null> {
    const handle = this.handles.get(docId)
    if (handle && !handle.isDestroyed) {
      const state = handle.pristine ? null : Y.encodeStateAsUpdate(handle.doc)
      if (clear) await this.dropHandle(docId, true)
      return state
    }
    const doc = new Y.Doc()
    const store = this.openLocal(this.localName(docId), doc)
    try {
      await store.whenSynced
      return doc.store.clients.size === 0 ? null : Y.encodeStateAsUpdate(doc)
    } finally {
      await (clear ? store.clear() : store.destroy())
      doc.destroy()
    }
  }

  /** The changes of a note this device kept, decrypted, oldest first. */
  historyOf(docId: string): Promise<HistoryEntry[]> {
    return this.history.entries(docRoom(docId))
  }

  /**
   * A note someone else owned carries on as this vault's own under
   * `newDocId`, because its share ended. The file stays where it is. What this
   * device holds of the old note goes in as the Yjs state it is - the new note
   * was built from the same changes, so a second device doing this after the
   * first adds its unsent edits and duplicates nothing. Both index changes go
   * out together, so another device sees the path taken by the new note in the
   * same breath as the old one's tombstone, and does not trash the file.
   */
  async forkInto(docId: string, newDocId: string): Promise<TFile | null> {
    const moved = await this.withLock(docId, async () => {
      // Looked up under the lock: the end of a share arrives as a message, a
      // notice and an index change, and whichever comes second finds it done.
      const current = this.index.pathFor(docId)
      const path = current ?? this.index.pathFor(newDocId)
      const known = this.state.get(docId)
      if (!current && !known) return null
      const file = path ? this.app.vault.getAbstractFileByPath(path) : null
      // Bound to an editor, the note runs ahead of its file: Obsidian saves
      // what was typed a moment later. The file is then an older version of
      // the note, not a second side to merge with it - which duplicated text.
      const base =
        this.editorOwned.has(docId) && file instanceof TFile ? await this.app.vault.read(file) : await this.state.baseText(docId)
      const state = await this.localState(docId, true)
      this.forget(docId)
      await this.history.clear(docRoom(docId))
      if (current) this.index.replace(docId, newDocId, current)
      // The last text file and note agreed on stays the base: a file that
      // lags the note, or was edited meanwhile, still merges three ways.
      if (path && base !== null && (await this.state.baseText(newDocId)) === null) await this.state.setBaseText(newDocId, base)
      return { path, state }
    })
    if (!moved?.path) return null
    const { path, state } = moved
    log.info(`${path}: the share ended; carries on as ${newDocId.slice(0, 8)}, ${state ? `${state.length} B held here` : 'nothing held here'}`)
    if (state) {
      await this.withLock(newDocId, async () => {
        const handle = await this.handleFor(newDocId)
        await handle.whenRemoteReady(this.options.syncTimeoutMs)
        Y.applyUpdate(handle.doc, state, FORK_ORIGIN)
      })
    }
    const file = this.app.vault.getAbstractFileByPath(path)
    // A note this device never pulled comes in with the index like any other.
    if (!(file instanceof TFile)) return null
    await this.syncFile(file)
    return file
  }

  // --- the trash --------------------------------------------------------------

  /** Whether a tombstone is one of this vault's own notes the server still keeps. */
  private isTrashed(entry: IndexEntry): boolean {
    return Boolean(entry.deletedAt) && !entry.owner && !entry.forkedTo && !entry.purgedAt
  }

  /** Notes of this vault deleted since `since` and still restorable, newest first. */
  deletedNotes(since: number): DeletedNote[] {
    return this.index
      .deleted()
      .filter(({ entry }) => this.isTrashed(entry) && (entry.deletedAt as number) >= since)
      .map(({ docId, entry }) => ({ docId, path: entry.path, deletedAt: entry.deletedAt as number }))
      .sort((a, b) => b.deletedAt - a.deletedAt)
  }

  /** Deleted before `before`: what the server may let go of. */
  expiredDeleted(before: number): DeletedNote[] {
    return this.index
      .deleted()
      .filter(({ entry }) => this.isTrashed(entry) && (entry.deletedAt as number) < before)
      .map(({ docId, entry }) => ({ docId, path: entry.path, deletedAt: entry.deletedAt as number }))
  }

  /**
   * Brings a deleted note back, from its document - on this device and,
   * through the index, on every other one. Its old place may have been taken
   * meanwhile; it then comes back next to it. Null while its text cannot be
   * had: the file follows once the server answers.
   */
  async restoreDeleted(docId: string): Promise<TFile | null> {
    const entry = this.index.entry(docId)
    if (!entry || !this.isTrashed(entry)) return null
    const path = this.freeRestorePath(entry.path)
    log.info(`${entry.path}: restored from the trash${path === entry.path ? '' : ` as ${path}`}`)
    await this.withLock(docId, async () => {
      this.index.revive(docId, path)
      await this.pull(docId)
    })
    const file = this.app.vault.getAbstractFileByPath(path)
    return file instanceof TFile ? file : null
  }

  private freeRestorePath(path: string): string {
    const taken = (candidate: string): boolean =>
      Boolean(this.app.vault.getAbstractFileByPath(candidate) || this.index.docIdForPath(candidate))
    if (!taken(path)) return path
    const stem = path.replace(/\.md$/, '')
    let candidate = `${stem} (restored).md`
    for (let n = 2; taken(candidate); n += 1) candidate = `${stem} (restored ${n}).md`
    return candidate
  }

  /** The server let go of a deleted note: this device does too, and none offers it for restoring any more. */
  async forgetDeleted(docId: string): Promise<void> {
    await this.withLock(docId, async () => {
      await this.localState(docId, true)
      await this.history.clear(docRoom(docId))
      this.index.markPurged(docId)
    })
  }

  /** Rolls the live document back to `text`; it travels like any other edit. */
  async restore(docId: string, text: string): Promise<void> {
    const handle = await this.handleFor(docId)
    const edits = textEdits(handle.text(), text)
    if (edits.length > 0) handle.doc.transact(() => applyTextEdits(handle.ytext, edits), RESTORE_ORIGIN)
  }

  /** A loaded note's handle, for the history view and sharing. */
  handle(docId: string): Promise<DocHandle> {
    return this.handleFor(docId)
  }

  entry(docId: string): IndexEntry | undefined {
    return this.index.entry(docId)
  }

  docIdForPath(path: string): string | undefined {
    return this.index.docIdForPath(path)
  }

  private freePath(folder: string, title: string): string {
    const name = safeFileName(title)
    const prefix = folder.replace(/^\/+|\/+$/g, '')
    const at = (suffix: string): string => `${prefix ? `${prefix}/` : ''}${name}${suffix}.md`
    let candidate = at('')
    for (let n = 2; this.app.vault.getAbstractFileByPath(candidate) || this.index.docIdForPath(candidate); n += 1) {
      candidate = at(` ${n}`)
    }
    return candidate
  }

  // --- startup scan ----------------------------------------------------------

  private async scanVault(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles().filter((file) => !this.isExcluded(file.path))
    await this.pool(files, (file) => this.syncFile(file))
  }

  /**
   * Where one note stands, for the cloud in the status bar: `unsent` while
   * this device holds something the server has not confirmed - edits in the
   * outbox, a file change not taken in yet, a note not registered yet;
   * `waiting` while the server's state is not known (offline, catching up);
   * `held` while a server that lost data waits for the user's decision.
   */
  noteState(file: TFile): NoteSyncState {
    if (!this.ready || file.extension !== 'md' || this.isExcluded(file.path) || !this.exists(file)) return 'untracked'
    const docId = this.index.docIdForPath(file.path)
    if (!docId) return 'unsent'
    const room = docRoom(docId)
    if (this.socket.isHeld(room)) return 'held'
    if (!this.socket.isSettled(room) || this.writeTimers.has(docId) || this.locks.has(docId) || this.inFlight.has(docId)) {
      return 'unsent'
    }
    // Not loaded: it agreed with the server when it was, and nothing changed it since.
    if (!this.handles.has(docId)) return this.agreed.has(docId) ? 'synced' : 'waiting'
    if (!this.socket.isSynced(room)) return 'waiting'
    return this.agreed.has(docId) || this.editorOwned.has(docId) ? 'synced' : 'unsent'
  }

  loadedCount(): number {
    return this.handles.size
  }

  trackedCount(): number {
    return this.index.live().length
  }

  sharedCount(): number {
    return this.index.live().filter(({ entry }) => entry.shared === true).length
  }
}
