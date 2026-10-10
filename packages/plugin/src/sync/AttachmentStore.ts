import { Notice, TFile, getLinkpath, type App } from 'obsidian'
import type { AttachmentEntry } from '@obsidian-connect/shared'
import { contentHash, type Bytes } from '@obsidian-connect/shared/crypto'
import { ApiError } from '../account/api.js'
import type { AttachmentIndex } from './AttachmentIndex.js'
import { BlobMissing, type Blobs } from './Blobs.js'
import { matchesGlob } from './glob.js'
import type { StateStore } from './StateStore.js'
import { log } from '../log.js'

// Every file of the vault that is not a note. Unlike a note, the file is the
// source of truth here and the server's copy an immutable blob of one of its
// versions. What keeps that safe is the base - the version this device last
// saw file and index agree on - and three rules:
//
// - An entry names only content the server has confirmed: upload, then index.
// - A file is overwritten or trashed only while it still has the base's
//   content, and only once the server holds that content: the blob is the
//   backup.
// - Without a base, or when both sides changed, both are kept - as two files.

export interface AttachmentOptions {
  excludeGlobs: string[]
  /** Larger files come only when a note needs them; null fetches everything. */
  downloadLimitBytes: number | null
  /** What the server takes; larger files stay on this device. */
  maxFileBytes: number
  /** How long a file must stay unchanged before it is taken in: programs write in pieces. */
  settleMs: number
}

export interface Transfers {
  uploads: number
  downloads: number
}

// Fewer than notes: each one can be a large file in memory.
const CONCURRENCY = 4
const RETRY_MS = 30_000
const STOP_DRAIN_MS = 2_000

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function buffer(data: Bytes): ArrayBuffer {
  return data.slice().buffer
}

function two(value: number): string {
  return value.toString().padStart(2, '0')
}

/** `name (conflict 2026-10-10 1432).png`, next to the original. */
function conflictName(path: string, when: Date, n: number): string {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  const cut = dot > slash ? dot : path.length
  const stamp = `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())} ${two(when.getHours())}${two(when.getMinutes())}`
  return `${path.slice(0, cut)} (conflict ${stamp}${n > 1 ? ` ${n}` : ''})${path.slice(cut)}`
}

/**
 * How much file content is in memory at once. Obsidian reads a file whole and
 * WebCrypto hashes it whole, so four large videos side by side could take a
 * phone down. A file larger than the budget runs on its own.
 */
const MEMORY_BUDGET = 64 * 1024 * 1024

class Budget {
  private used = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(bytes: number, task: () => Promise<T>): Promise<T> {
    const need = Math.min(Math.max(bytes, 1), this.limit)
    while (this.used > 0 && this.used + need > this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.used += need
    try {
      return await task()
    } finally {
      this.used -= need
      for (const wake of this.waiting.splice(0)) wake()
    }
  }
}

export class AttachmentStore {
  private readonly memory = new Budget(MEMORY_BUDGET)
  private readonly locks = new Map<string, Promise<void>>()
  private readonly settling = new Map<string, number>()
  private readonly tooLarge = new Set<string>()
  private readonly listeners = new Set<() => void>()
  /** Renames and deletes that happened before the index arrived. */
  private readonly early: Array<() => Promise<void>> = []
  private readonly transfers: Transfers = { uploads: 0, downloads: 0 }
  private applying: Promise<void> = Promise.resolve()
  private retryTimer: number | null = null
  private ready = false
  private stopped = false

  constructor(
    private readonly app: App,
    private readonly index: AttachmentIndex,
    private readonly state: StateStore,
    private readonly blobs: Blobs,
    private options: AttachmentOptions
  ) {}

  setOptions(options: AttachmentOptions): void {
    this.options = options
  }

  get isReady(): boolean {
    return this.ready && !this.stopped
  }

  /** Fires whenever an upload or download starts or ends. */
  onTransfer(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  activeTransfers(): Transfers {
    return { ...this.transfers }
  }

  trackedCount(): number {
    return this.index.live().length
  }

  isExcluded(path: string): boolean {
    return this.options.excludeGlobs.some((pattern) => pattern && matchesGlob(path, pattern))
  }

  private exists(file: TFile): boolean {
    return this.app.vault.getAbstractFileByPath(file.path) === file
  }

  private tracks(file: TFile): boolean {
    return this.isReady && file.extension !== 'md' && !this.isExcluded(file.path) && this.exists(file)
  }

  private withLock<T>(fileId: string, task: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(fileId) ?? Promise.resolve()).then(task)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    this.locks.set(fileId, tail)
    void tail.then(() => {
      if (this.locks.get(fileId) === tail) this.locks.delete(fileId)
    })
    return run
  }

  /**
   * Every operation on one file: its lock, then room in memory for about
   * `bytes`. Always in that order, and never nested - an operation waiting
   * for another file's lock while holding memory could wait forever.
   */
  private guarded<T>(fileId: string, bytes: number, task: () => Promise<T>): Promise<T> {
    return this.withLock(fileId, () => this.memory.run(bytes, task))
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
          this.failed(error)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
  }

  /** Offline or a blob not there yet: the next pass tries again. */
  private failed(error: unknown): void {
    if (error instanceof ApiError && error.status === 0) log.debug('attachment transfer postponed: the server is not reachable')
    else if (error instanceof BlobMissing) log.warn(error.message)
    else log.error('syncing an attachment failed', error)
    this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer !== null) return
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null
      void this.resume()
    }, RETRY_MS)
  }

  private async transfer<T>(kind: keyof Transfers, task: () => Promise<T>): Promise<T> {
    this.transfers[kind] += 1
    for (const listener of this.listeners) listener()
    try {
      return await task()
    } finally {
      this.transfers[kind] -= 1
      for (const listener of this.listeners) listener()
    }
  }

  private upload(data: Bytes, hash: string): Promise<void> {
    return this.transfer('uploads', () => this.blobs.upload(data, hash))
  }

  private download(hash: string): Promise<Bytes> {
    return this.transfer('downloads', () => this.blobs.download(hash))
  }

  private agree(fileId: string, file: TFile, hash: string): void {
    this.state.setAttachment(fileId, { path: file.path, mtime: file.stat.mtime, size: file.stat.size, hash })
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

  // --- lifecycle ------------------------------------------------------------------

  /** Runs once the vault index has arrived: without it, nothing here is known. */
  async start(): Promise<void> {
    if (this.stopped || this.ready) return
    this.ready = true
    for (const replay of this.early.splice(0)) await replay()
    // Deletes before the scan, which would otherwise take a file another
    // device deleted for one that is new here.
    await this.applyDeletes()
    await this.scan()
    await this.applyRemoteChanges()
    log.info(`attachments: ${this.index.live().length} known, ${this.index.deleted().length} deleted`)
    await this.heal()
  }

  /**
   * After the connection came back: whatever could not be sent or fetched
   * meanwhile - and whatever the server lost, since a server that comes back
   * may be one restored from a backup.
   */
  async resume(): Promise<void> {
    if (!this.isReady) return
    await this.scan()
    await this.applyRemoteChanges()
    await this.heal()
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const timer of this.settling.values()) window.clearTimeout(timer)
    this.settling.clear()
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer)
    this.retryTimer = null
    await Promise.race([
      Promise.all(Array.from(this.locks.values())),
      new Promise((resolve) => window.setTimeout(resolve, STOP_DRAIN_MS))
    ])
    this.listeners.clear()
  }

  private async scan(): Promise<void> {
    const files = this.app.vault.getFiles().filter((file) => file.extension !== 'md' && !this.isExcluded(file.path))
    await this.pool(files, (file) => this.syncLocal(file))
  }

  /**
   * Uploads again what the server lost. A device that holds a file with the
   * content its entry names can always put that content back.
   */
  async heal(): Promise<number> {
    const held = new Map<string, string>()
    for (const { fileId, entry } of this.index.live()) {
      const known = this.state.attachment(fileId)
      if (known && known.hash === entry.hash && known.path === entry.path) held.set(entry.hash, fileId)
    }
    if (held.size === 0) return 0
    let missing: string[]
    try {
      missing = await this.blobs.missing(Array.from(held.keys()))
    } catch (error) {
      this.failed(error)
      return 0
    }
    let healed = 0
    for (const hash of missing) {
      const fileId = held.get(hash) as string
      await this.guarded(fileId, this.state.attachment(fileId)?.size ?? 0, async () => {
        const known = this.state.attachment(fileId)
        const file = known ? this.app.vault.getAbstractFileByPath(known.path) : null
        if (!(file instanceof TFile)) return
        const data = new Uint8Array(await this.app.vault.readBinary(file))
        if ((await contentHash(data)) !== hash) return
        await this.upload(data, hash)
        healed += 1
      }).catch((error: unknown) => this.failed(error))
    }
    if (healed > 0) log.info(`attachments: uploaded ${healed} the server had lost`)
    return healed
  }

  // --- this device ----------------------------------------------------------------

  onCreate(file: TFile): void {
    this.settle(file)
  }

  onModify(file: TFile): void {
    this.settle(file)
  }

  private settle(file: TFile): void {
    if (!this.tracks(file)) return
    const path = file.path
    const previous = this.settling.get(path)
    if (previous !== undefined) window.clearTimeout(previous)
    this.settling.set(
      path,
      window.setTimeout(() => {
        this.settling.delete(path)
        void this.syncLocal(file).catch((error: unknown) => this.failed(error))
      }, this.options.settleMs)
    )
  }

  /** Brings one file into agreement with the index. */
  async syncLocal(file: TFile): Promise<void> {
    if (!this.tracks(file)) return
    const path = file.path
    const fileId = this.index.idForPath(path) ?? this.state.attachmentAt(path) ?? (await this.index.nextId(path))
    const bytes = Math.max(file.stat.size, this.index.entry(fileId)?.size ?? 0)
    await this.guarded(fileId, bytes, () => this.takeIn(fileId, file, path))
  }

  private async takeIn(fileId: string, file: TFile, path: string): Promise<void> {
    if (this.stopped || file.path !== path || !this.exists(file)) return
    // A live entry appeared at this path while this waited: the file is
    // that one's now, and is taken in under its id - after this lock is let go.
    const claimant = this.index.idForPath(path)
    if (claimant && claimant !== fileId && !this.index.entry(fileId)) {
      this.settle(file)
      return
    }
    const known = this.state.attachment(fileId)
    let entry = this.index.entry(fileId)
    const stat = file.stat
    if (known && entry && !entry.deletedAt && known.path === path && known.mtime === stat.mtime && known.size === stat.size && entry.hash === known.hash) return
    if (stat.size > this.options.maxFileBytes) {
      if (!this.tooLarge.has(path)) log.warn(`${path}: ${stat.size} bytes, larger than the server takes; it stays on this device`)
      this.tooLarge.add(path)
      return
    }
    this.tooLarge.delete(path)

    const data = new Uint8Array(await this.app.vault.readBinary(file))
    const hash = await contentHash(data)
    const base = known?.hash ?? null
    // Unchanged here: whatever the index says now came from elsewhere - if it
    // came from someone who knew this version. Of two writes racing, one is
    // simply gone from the index, and its device must not take the other
    // one's word for it.
    const unchanged = base !== null && hash === base && this.index.replaced(fileId, base)
    entry = this.index.entry(fileId)
    if (entry?.deletedAt) {
      if (hash === entry.hash || unchanged) {
        await this.applyDelete(fileId)
        return
      }
    } else if (entry?.hash === hash) {
      this.agree(fileId, file, hash)
      return
    } else if (entry && unchanged) {
      await this.replace(fileId, file, entry, data)
      return
    }

    // Changed here, or never agreed: the content goes to the server before
    // the index names it.
    await this.upload(data, hash)
    entry = this.index.entry(fileId)
    if (this.stopped || !this.exists(file) || file.path !== path) return
    if (!entry) {
      const id = await this.index.add(path, hash, data.length)
      if (id !== fileId && this.index.entry(id)?.hash !== hash) {
        // Another device registered this path meanwhile, with other content.
        this.settle(file)
        return
      }
      this.agree(id, file, hash)
      log.info(`${path}: new attachment, ${data.length} bytes`)
      return
    }
    if (entry.deletedAt) {
      this.index.revive(fileId, path, hash, data.length)
      this.agree(fileId, file, hash)
      log.info(`${path}: deleted elsewhere but changed here, kept`)
      new Notice(`${nameOf(path)} was deleted on another device but changed here, so it was kept.`, 10_000)
      return
    }
    if (entry.hash === hash) {
      this.agree(fileId, file, hash)
      return
    }
    if (base !== null && entry.hash === base) {
      this.index.setContent(fileId, hash, data.length)
      this.agree(fileId, file, hash)
      log.debug(`${path}: changed here, ${data.length} bytes`)
      return
    }
    await this.conflict(fileId, file, data, hash, entry)
  }

  private async reviveLocal(fileId: string, file: TFile, data: Bytes, hash: string): Promise<void> {
    await this.upload(data, hash)
    if (this.stopped || !this.exists(file)) return
    this.index.revive(fileId, file.path, hash, data.length)
    this.agree(fileId, file, hash)
    log.info(`${file.path}: deleted elsewhere but changed here, kept`)
    new Notice(`${file.name} was deleted on another device but changed here, so it was kept.`, 10_000)
  }

  /**
   * Both sides changed the file - or there is no base to tell. This device's
   * version becomes a file of its own next to it; the path takes the index's.
   * The other version is fetched first: if that fails nothing has changed,
   * and trying again later does not leave a second copy behind.
   */
  private async conflict(fileId: string, file: TFile, data: Bytes, hash: string, entry: AttachmentEntry): Promise<void> {
    const theirs = await this.download(entry.hash)
    if (this.stopped || !this.exists(file)) return
    const when = new Date()
    let copyPath = conflictName(file.path, when, 1)
    for (let n = 2; this.app.vault.getAbstractFileByPath(copyPath) || this.index.idForPath(copyPath); n += 1) {
      copyPath = conflictName(file.path, when, n)
    }
    const copy = await this.app.vault.createBinary(copyPath, buffer(data))
    const copyId = await this.index.add(copyPath, hash, data.length)
    this.agree(copyId, copy, hash)
    await this.app.vault.modifyBinary(file, buffer(theirs))
    this.agree(fileId, file, entry.hash)
    log.info(`${file.path}: changed here and elsewhere; this device's version kept as ${copyPath}`)
    new Notice(`${file.name} was changed here and on another device. Both are kept: this device's version is ${nameOf(copyPath)}.`, 12_000)
  }

  /** The index's version into a file that still has the base's content. */
  private async replace(fileId: string, file: TFile, entry: AttachmentEntry, local: Bytes): Promise<void> {
    const known = this.state.attachment(fileId)
    if (known && !(await this.blobs.has(known.hash))) await this.upload(local, known.hash)
    const data = await this.download(entry.hash)
    if (this.stopped || !this.exists(file)) return
    // Changed while this was downloading: that change gets its own turn.
    if (known && (file.stat.mtime !== known.mtime || file.stat.size !== known.size)) return
    await this.app.vault.modifyBinary(file, buffer(data))
    this.agree(fileId, file, entry.hash)
    log.info(`${file.path}: changed on another device, ${data.length} bytes`)
  }

  async onRename(file: TFile, oldPath: string): Promise<void> {
    if (this.stopped) return
    if (!this.ready) {
      this.early.push(() => this.onRename(file, oldPath))
      return
    }
    if (file.extension === 'md') {
      // An attachment renamed into a note is no longer an attachment.
      if (this.index.idForPath(oldPath)) await this.onDelete(oldPath)
      return
    }
    // The new path first, for the reason notes look it up first: a rename this
    // device applied for another one arrives here too.
    const fileId = this.index.idForPath(file.path) ?? this.index.idForPath(oldPath)
    if (!fileId) {
      this.settle(file)
      return
    }
    this.index.rename(fileId, file.path)
    const known = this.state.attachment(fileId)
    if (known) this.state.setAttachment(fileId, { ...known, path: file.path })
  }

  async onDelete(path: string): Promise<void> {
    if (this.stopped) return
    if (!this.ready) {
      this.early.push(() => this.onDelete(path))
      return
    }
    const timer = this.settling.get(path)
    if (timer !== undefined) window.clearTimeout(timer)
    this.settling.delete(path)
    const fileId = this.index.idForPath(path)
    if (!fileId) return
    await this.withLock(fileId, async () => {
      this.index.markDeleted(fileId)
      this.state.forgetAttachment(fileId)
    })
    log.info(`${path}: attachment deleted here`)
  }

  /** Obsidian may report only the folder; whatever lay in it is deleted too. */
  async onDeleteFolder(path: string): Promise<void> {
    if (this.stopped) return
    if (!this.ready) {
      this.early.push(() => this.onDeleteFolder(path))
      return
    }
    const prefix = `${path}/`
    for (const { entry } of this.index.live()) {
      if (entry.path.startsWith(prefix) && !this.app.vault.getAbstractFileByPath(entry.path)) await this.onDelete(entry.path)
    }
  }

  // --- other devices -----------------------------------------------------------------

  /** What other devices changed in the index. One pass at a time. */
  applyRemoteChanges(): Promise<void> {
    this.applying = this.applying.then(async () => {
      if (!this.isReady) return
      try {
        await this.resolveDuplicates()
        await this.applyDeletes()
        await this.follow()
        await this.pullMissing()
      } catch (error) {
        log.error('applying attachment changes failed', error)
      }
    })
    return this.applying
  }

  /**
   * Two ids that ended up at one path, from a rename racing between devices.
   * The sorted-first keeps it; another with the same content goes, one with
   * other content moves next to it - so no device has to pick a winner.
   */
  private async resolveDuplicates(): Promise<void> {
    for (const { path, fileIds } of this.index.duplicatePaths()) {
      const [winnerId, ...losers] = fileIds as [string, ...string[]]
      const winner = this.index.entry(winnerId)
      for (const loserId of losers) {
        const loser = this.index.entry(loserId)
        if (!winner || !loser) continue
        if (loser.hash === winner.hash) {
          this.index.markDeleted(loserId)
          continue
        }
        let target = conflictName(path, new Date(loser.updatedAt), 1)
        for (let n = 2; this.index.idForPath(target) || this.app.vault.getAbstractFileByPath(target); n += 1) {
          target = conflictName(path, new Date(loser.updatedAt), n)
        }
        this.index.rename(loserId, target)
        log.info(`${path}: two files claimed it; one moved to ${target}`)
      }
    }
  }

  private async applyDeletes(): Promise<void> {
    for (const { fileId } of this.index.deleted()) {
      if (this.stopped) return
      const known = this.state.attachment(fileId)
      if (!known) continue
      await this.guarded(fileId, known.size, () => this.applyDelete(fileId)).catch((error: unknown) => this.failed(error))
    }
  }

  /**
   * Deleted elsewhere. Only a file that still has the content this device
   * agreed on goes - and only if whoever deleted it had seen that content -
   * and only once the server holds it. Anything else is kept, for every
   * device.
   */
  private async applyDelete(fileId: string): Promise<void> {
    const known = this.state.attachment(fileId)
    const entry = this.index.entry(fileId)
    if (!known || !entry?.deletedAt) return
    const file = this.app.vault.getAbstractFileByPath(known.path)
    if (!(file instanceof TFile)) {
      this.state.forgetAttachment(fileId)
      return
    }
    // The same content under another id at the same path: nothing to delete.
    const claimant = this.index.idForPath(known.path)
    if (claimant && claimant !== fileId && this.index.entry(claimant)?.hash === known.hash && !this.state.attachment(claimant)) {
      this.state.setAttachment(claimant, known)
      this.state.forgetAttachment(fileId)
      return
    }
    const data = new Uint8Array(await this.app.vault.readBinary(file))
    const hash = await contentHash(data)
    const seen = hash === entry.hash || this.index.replaced(fileId, hash)
    if (hash !== known.hash || !seen) {
      // Revived with this device's content.
      await this.reviveLocal(fileId, file, data, hash)
      return
    }
    if (!(await this.blobs.has(hash))) await this.upload(data, hash)
    this.state.forgetAttachment(fileId)
    log.info(`${known.path}: attachment deleted on another device, moved to the trash here`)
    await this.app.fileManager.trashFile(file)
  }

  /** Renames and new content for files this device has. */
  private async follow(): Promise<void> {
    const changed = this.index.live().filter(({ fileId, entry }) => {
      const known = this.state.attachment(fileId)
      return known && (known.path !== entry.path || known.hash !== entry.hash)
    })
    await this.pool(changed, ({ fileId, entry }) =>
      this.guarded(fileId, Math.max(entry.size, this.state.attachment(fileId)?.size ?? 0), () => this.followOne(fileId))
    )
  }

  private async followOne(fileId: string): Promise<void> {
    const entry = this.index.entry(fileId)
    const known = this.state.attachment(fileId)
    if (!entry || entry.deletedAt || !known || this.stopped) return
    let file = this.app.vault.getAbstractFileByPath(known.path)
    if (!(file instanceof TFile)) {
      // Gone here without this device noticing - deleted while Obsidian was
      // closed. Like a note, it is fetched again rather than deleted everywhere.
      this.state.forgetAttachment(fileId)
      await this.pull(fileId, true)
      return
    }
    if (known.path !== entry.path && !this.isExcluded(entry.path)) {
      if (this.app.vault.getAbstractFileByPath(entry.path)) {
        log.warn(`${known.path}: renamed elsewhere to ${entry.path}, which is taken here`)
      } else {
        await this.ensureFolder(parentOf(entry.path))
        // Not `fileManager.renameFile`: links travel inside the notes (invariant 22).
        await this.app.vault.rename(file, entry.path)
        this.state.setAttachment(fileId, { ...known, path: entry.path })
        log.info(`${known.path}: renamed on another device to ${entry.path}`)
      }
      file = this.app.vault.getAbstractFileByPath(this.state.attachment(fileId)?.path ?? '')
    }
    if (file instanceof TFile && entry.hash !== known.hash) await this.takeIn(fileId, file, file.path)
  }

  private async pullMissing(): Promise<void> {
    const limit = this.options.downloadLimitBytes
    const missing = this.index
      .live()
      .filter(({ fileId, entry }) => !this.state.attachment(fileId) && !this.isExcluded(entry.path) && (limit === null || entry.size <= limit))
    await this.pool(missing, async ({ fileId, entry }) => {
      const existing = this.app.vault.getAbstractFileByPath(entry.path)
      // The same path here already: the scan takes it in, agreeing or keeping both.
      if (existing instanceof TFile) await this.syncLocal(existing)
      else if (!existing) await this.guarded(fileId, entry.size, () => this.pull(fileId))
    })
  }

  /** Creates the file of an entry this device does not have. */
  private async pull(fileId: string, again = false): Promise<void> {
    const entry = this.index.entry(fileId)
    if (!entry || entry.deletedAt || this.stopped || this.state.attachment(fileId)) return
    if (this.app.vault.getAbstractFileByPath(entry.path)) return
    const data = await this.download(entry.hash)
    const now = this.index.entry(fileId)
    if (this.stopped || !now || now.deletedAt || now.path !== entry.path || this.app.vault.getAbstractFileByPath(entry.path)) return
    await this.ensureFolder(parentOf(entry.path))
    const file = await this.app.vault.createBinary(entry.path, buffer(data))
    this.agree(fileId, file, entry.hash)
    log.info(`${entry.path}: ${again ? 'fetched again' : 'created from the server'}, ${data.length} bytes`)
  }

  // --- on request ------------------------------------------------------------------

  /**
   * Files a note embeds or links that this device left on the server - over
   * its download limit. Matched the way Obsidian resolves a link: the whole
   * path, the end of it, or the name.
   */
  async fetchFor(note: TFile): Promise<number> {
    if (!this.isReady) return 0
    const cache = this.app.metadataCache.getFileCache(note)
    const links = new Set([...(cache?.embeds ?? []), ...(cache?.links ?? [])].map((link) => getLinkpath(link.link)))
    const wanted = new Set<string>()
    for (const link of links) {
      if (!link || this.app.metadataCache.getFirstLinkpathDest(link, note.path)) continue
      for (const { fileId, entry } of this.index.live()) {
        if (this.state.attachment(fileId) || this.isExcluded(entry.path)) continue
        if (entry.path === link || entry.path.endsWith(`/${link}`) || nameOf(entry.path) === link) wanted.add(fileId)
      }
    }
    let fetched = 0
    await this.pool(Array.from(wanted), async (fileId) => {
      await this.guarded(fileId, this.index.entry(fileId)?.size ?? 0, () => this.pull(fileId))
      if (this.state.attachment(fileId)) fetched += 1
    })
    if (fetched > 0) log.info(`${note.path}: fetched ${fetched} attachment(s) it needs`)
    return fetched
  }

  /** Everything still on the server only, whatever the download limit says. */
  async fetchAll(): Promise<number> {
    if (!this.isReady) return 0
    const missing = this.index
      .live()
      .filter(({ fileId, entry }) => !this.state.attachment(fileId) && !this.isExcluded(entry.path) && !this.app.vault.getAbstractFileByPath(entry.path))
    let fetched = 0
    await this.pool(missing, async ({ fileId, entry }) => {
      await this.guarded(fileId, entry.size, () => this.pull(fileId))
      if (this.state.attachment(fileId)) fetched += 1
    })
    return fetched
  }
}
