import { Notice, TFile, type App } from 'obsidian'
import { applyTextEdits, indexRoom, textEdits, type CollabUser } from '@obsidian-connect/shared'
import { additiveEdits } from './Reconciler.js'
import { matchesGlob } from './glob.js'
import { SYNC_ORIGIN } from './origin.js'
import type { BackupStore } from './BackupStore.js'
import { DocHandle } from './DocHandle.js'
import { reconcile, type ReconcileOutcome } from './Reconciler.js'
import type { StateStore } from './StateStore.js'
import type { VaultIndex } from './VaultIndex.js'
import type { VaultSocket } from './VaultSocket.js'

export interface DocStoreOptions {
  vaultId: string
  user: CollabUser
  excludeGlobs: string[]
  conflictMarkers: boolean
  maxLoadedDocuments: number
  syncTimeoutMs: number
  writeDebounceMs: number
}

const SCAN_BATCH = 25

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

export class DocStore {
  private readonly handles = new Map<string, DocHandle>()
  private readonly lastUsed = new Map<string, number>()
  private readonly pinned = new Set<string>()
  private readonly editorOwned = new Set<string>()
  // Presence belongs to a shared document, not to the vault: syncing your own
  // devices must not broadcast your caret. Phase 2 fills this from the share
  // ACL; until sharing exists it stays empty and no awareness is registered.
  private readonly sharedDocs = new Set<string>()
  private readonly writeTimers = new Map<string, number>()
  private readonly inFlight = new Map<string, Promise<DocHandle>>()
  private indexReady = false
  private stopped = false

  constructor(
    private readonly app: App,
    private readonly socket: VaultSocket,
    private readonly index: VaultIndex,
    private readonly state: StateStore,
    private readonly backups: BackupStore,
    private options: DocStoreOptions
  ) {}

  setOptions(options: DocStoreOptions): void {
    this.options = options
  }

  isExcluded(path: string): boolean {
    return this.options.excludeGlobs.some((pattern) => pattern && matchesGlob(path, pattern))
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

  async start(): Promise<boolean> {
    await this.state.load()
    // Without the index we do not know which document a file belongs to.
    // Minting ids anyway would create a second document per note, so a
    // failure here has to stop the scan rather than guess.
    const indexSynced = await Promise.race([
      this.socket.register(indexRoom(this.options.vaultId), this.index.doc, null).then(() => true),
      new Promise<boolean>((resolve) =>
        window.setTimeout(() => resolve(false), this.options.syncTimeoutMs)
      )
    ])
    if (!indexSynced) {
      console.warn('[obsidian-connect] the vault index did not sync; waiting for the server')
      return false
    }
    this.indexReady = true
    await this.scanVault()
    return true
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const timer of this.writeTimers.values()) window.clearTimeout(timer)
    this.writeTimers.clear()
    for (const handle of this.handles.values()) await handle.destroy(this.socket)
    this.handles.clear()
    await this.state.flush()
  }

  // --- document lifecycle --------------------------------------------------

  private touch(docId: string): void {
    this.lastUsed.set(docId, Date.now())
  }

  async handleFor(docId: string): Promise<DocHandle> {
    const existing = this.handles.get(docId)
    if (existing && !existing.isDestroyed) {
      this.touch(docId)
      return existing
    }
    const pending = this.inFlight.get(docId)
    if (pending) return pending

    const creation = (async () => {
      const handle = new DocHandle(docId, this.options.vaultId, this.socket, this.options.user, this.sharedDocs.has(docId))
      this.handles.set(docId, handle)
      this.touch(docId)
      await handle.whenLocalReady()
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
      .filter((docId) => !this.pinned.has(docId) && !this.writeTimers.has(docId))
      .sort((a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0))

    for (const docId of candidates) {
      if (this.handles.size <= limit) break
      const handle = this.handles.get(docId)
      if (!handle) continue
      this.handles.delete(docId)
      this.lastUsed.delete(docId)
      await handle.destroy(this.socket)
    }
  }

  // --- file <-> document ---------------------------------------------------

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
      void this.writeToFile(docId)
    }, this.options.writeDebounceMs)
    this.writeTimers.set(docId, timer)
  }

  /** Projects the document onto disk. The document is the source of truth. */
  private async writeToFile(docId: string): Promise<void> {
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
      await this.app.vault.modify(file, text)
      await this.recordAgreement(docId, file, text)
    } catch (error) {
      console.error(`[obsidian-connect] writing ${file.path} failed`, error)
    }
  }

  /**
   * Remembers that file and document say the same thing. This snapshot is what
   * a later reconcile uses to tell an addition from a deletion.
   */
  private async recordAgreement(docId: string, file: TFile, text: string): Promise<void> {
    await this.state.setBaseText(docId, text)
    this.state.set(docId, { path: file.path, mtime: file.stat.mtime, size: file.stat.size })
  }

  private applyToDocument(handle: DocHandle, target: string): void {
    const edits = textEdits(handle.text(), target)
    if (edits.length === 0) return
    handle.doc.transact(() => applyTextEdits(handle.ytext, edits), SYNC_ORIGIN)
  }

  /**
   * Brings one note into agreement. Everything that can lose text funnels
   * through here, and every branch that can delete takes a backup first.
   */
  async syncFile(file: TFile, force = false): Promise<void> {
    if (this.stopped || file.extension !== 'md' || this.isExcluded(file.path)) return

    const docId = await this.index.ensure(file.path)
    const known = this.state.get(docId)
    const unchanged =
      !force && known && known.path === file.path && known.mtime === file.stat.mtime && known.size === file.stat.size

    const handle = await this.handleFor(docId)
    const remoteKnown = await handle.whenRemoteReady(this.options.syncTimeoutMs)

    const local = await this.app.vault.read(file)
    const remote = handle.text()

    // Not reaching the server means the document state is unknown. Seeding or
    // merging against it could duplicate the note or delete the other side's
    // work, so only an exact match is safe to act on.
    if (!remoteKnown && remote.length === 0) {
      if (local.length > 0) {
        console.warn(`[obsidian-connect] server unreachable, leaving ${file.path} untouched`)
      }
      return
    }

    if (unchanged && local === remote) {
      await this.recordAgreement(docId, file, local)
      return
    }

    const outcome = reconcile({
      base: await this.state.baseText(docId),
      local,
      remote,
      markers: this.options.conflictMarkers
    })

    await this.applyOutcome(docId, file, handle, local, remote, outcome)
  }

  private async applyOutcome(
    docId: string,
    file: TFile,
    handle: DocHandle,
    local: string,
    remote: string,
    outcome: ReconcileOutcome
  ): Promise<void> {
    switch (outcome.kind) {
      case 'agree':
        await this.recordAgreement(docId, file, local)
        return

      case 'seed':
        this.applyToDocument(handle, local)
        await this.recordAgreement(docId, file, local)
        return

      case 'adopt-local':
        this.applyToDocument(handle, local)
        await this.recordAgreement(docId, file, local)
        return

      case 'adopt-remote':
        // The file did not change since the last agreement, so overwriting it
        // cannot lose anything - but back it up anyway, it is nearly free.
        await this.backups.write(file.path, 'local', local)
        await this.app.vault.modify(file, remote)
        await this.recordAgreement(docId, file, remote)
        return

      case 'merge': {
        await this.backups.captureBoth(file.path, local, remote)
        await this.backups.write(file.path, 'merged', outcome.text)
        this.applyToDocument(handle, outcome.text)
        await this.app.vault.modify(file, outcome.text)
        await this.recordAgreement(docId, file, outcome.text)

        if (outcome.conflicts > 0) {
          new Notice(
            `${file.basename}: ${outcome.conflicts} conflicting change(s) kept side by side. Backups are in the plugin folder.`,
            10_000
          )
        } else if (outcome.additiveOnly) {
          new Notice(
            `${file.basename}: merged without a known base, so nothing was deleted. Check for duplicates.`,
            10_000
          )
        }
        return
      }
    }
  }

  // --- vault events --------------------------------------------------------

  async onModify(file: TFile): Promise<void> {
    if (!this.indexReady) return
    const docId = this.index.docIdForPath(file.path)
    if (!docId) {
      await this.syncFile(file)
      return
    }
    const handle = this.handles.get(docId)
    if (!handle) {
      await this.syncFile(file, true)
      return
    }
    const text = await this.app.vault.read(file)
    // Our own write-back, or the editor saving what the binding already put
    // into the document. Nothing to merge.
    if (text === handle.text()) {
      await this.recordAgreement(docId, file, text)
      return
    }
    await this.syncFile(file, true)
  }

  async onCreate(file: TFile): Promise<void> {
    if (!this.indexReady) return
    await this.syncFile(file, true)
  }

  async onRename(file: TFile, oldPath: string): Promise<void> {
    if (!this.indexReady) return
    const docId = this.index.docIdForPath(oldPath) ?? this.index.docIdForPath(file.path)
    if (!docId) {
      await this.syncFile(file, true)
      return
    }
    // The identity is the document, not the path, so a rename is a rename -
    // not a delete plus a new note that has lost its history.
    this.index.rename(docId, file.path)
    const known = this.state.get(docId)
    if (known) this.state.set(docId, { ...known, path: file.path })
  }

  async onDelete(path: string): Promise<void> {
    if (!this.indexReady) return
    const docId = this.index.docIdForPath(path)
    if (!docId) return
    const handle = this.handles.get(docId)
    if (handle) {
      // Keep a copy: a delete that arrives on another device is irreversible
      // there unless the text survives somewhere.
      await this.backups.write(path, 'local', handle.text())
      this.handles.delete(docId)
      await handle.destroy(this.socket)
    }
    this.index.markDeleted(docId)
    this.state.forget(docId)
  }

  /**
   * Folds documents that ended up claiming the same file into one. Without
   * this each device keeps syncing its own copy and the two never meet, which
   * looks exactly like sync being broken.
   */
  private async mergeDuplicates(): Promise<void> {
    for (const { path, docIds } of this.index.duplicatePaths()) {
      const [winnerId, ...losers] = docIds as [string, ...string[]]
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
        this.handles.delete(loserId)
        await loser.destroy(this.socket)
        this.state.forget(loserId)
      }
      console.info(`[obsidian-connect] merged ${losers.length} duplicate(s) of ${path}`)
    }
  }

  /** Applies renames and deletes that arrived from another device. */
  async applyRemoteIndexChanges(): Promise<void> {
    if (!this.indexReady || this.stopped) return

    // An entry from the other device may only now reveal that both adopted the
    // same file independently.
    await this.mergeDuplicates()

    for (const { docId, entry } of this.index.live()) {
      const known = this.state.get(docId)
      if (!known || known.path === entry.path) continue
      const current = this.app.vault.getAbstractFileByPath(known.path)
      if (!(current instanceof TFile)) continue
      if (this.app.vault.getAbstractFileByPath(entry.path)) continue
      try {
        await this.app.fileManager.renameFile(current, entry.path)
        this.state.set(docId, { ...known, path: entry.path })
      } catch (error) {
        console.error(`[obsidian-connect] renaming ${known.path} to ${entry.path} failed`, error)
      }
    }

    for (const { docId, entry } of this.index.deleted()) {
      const file = this.app.vault.getAbstractFileByPath(entry.path)
      if (!(file instanceof TFile)) continue
      try {
        await this.backups.write(entry.path, 'local', await this.app.vault.read(file))
        await this.app.fileManager.trashFile(file)
      } catch (error) {
        console.error(`[obsidian-connect] deleting ${entry.path} failed`, error)
      }
      this.state.forget(docId)
    }
  }

  // --- startup scan --------------------------------------------------------

  private async scanVault(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles().filter((file) => !this.isExcluded(file.path))
    for (let i = 0; i < files.length; i += SCAN_BATCH) {
      if (this.stopped) return
      const batch = files.slice(i, i + SCAN_BATCH)
      for (const file of batch) {
        try {
          await this.syncFile(file)
        } catch (error) {
          console.error(`[obsidian-connect] initial sync of ${file.path} failed`, error)
        }
      }
      // Let Obsidian breathe between batches so a large vault does not freeze
      // the UI on startup.
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    }
    await this.mergeDuplicates()
    await this.applyRemoteIndexChanges()
  }

  loadedCount(): number {
    return this.handles.size
  }

  trackedCount(): number {
    return this.index.live().length
  }
}
