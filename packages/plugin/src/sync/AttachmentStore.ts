import { Notice, TFile, getLinkpath, type App } from 'obsidian'
import type { AttachmentEntry, AttachmentVersion, BlobListResponse, SharedAttachment } from '@obsidian-connect/shared'
import { contentHash, type Bytes } from '@obsidian-connect/shared/crypto'
import { ApiError } from '../account/api.js'
import type { AttachmentIndex, SharedBase } from './AttachmentIndex.js'
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
// - A file is overwritten or trashed only while it still has the content it
//   was read with - checked right before, never assumed from earlier - and
//   only once the server holds that content: the blob is the backup.
// - Without a base, or when both sides changed, both are kept - as two files.
//
// mtime and size only ever save work: an unchanged stat lets the scan skip a
// file. They never decide anything. A canvas that saved again while its
// previous version was being uploaded looked unchanged that way, and its
// newest content was never sent.

export interface AttachmentOptions {
  excludeGlobs: string[]
  /** Larger files come only when a note needs them; null fetches everything. */
  downloadLimitBytes: number | null
  /** What the server takes; larger files stay on this device. */
  maxFileBytes: number
  /** How long a file must stay unchanged before it is taken in: programs write in pieces. */
  settleMs: number
  /** How often the vault is compared against what was last agreed, for changes no event reported. */
  rescanMs: number
  /**
   * A version that was current for less than this keeps no content after a
   * clean-up: a file a program rewrites every few seconds would otherwise
   * fill the server. Its record stays as the file's lineage.
   */
  minVersionAgeMs: number
}

/** A file of this vault in the trash. */
export interface DeletedFile {
  fileId: string
  path: string
  deletedAt: number
  size: number
}

/** A file a link points at that is not in the vault: on the server only, or in the trash. */
export interface EmbedTarget {
  fileId: string
  path: string
  hash: string
  size: number
  deleted: boolean
}

/** An earlier content of a file, still on the server. */
export interface FileVersion {
  hash: string
  size: number
  /** When it became current, and when it was replaced. */
  since: number
  at: number
}

export type AttachmentSyncState = 'synced' | 'unsent' | 'waiting' | 'local' | 'untracked'

/**
 * What the user did to a file on this device, from Obsidian's events: what a
 * shared folder decides from, as it does for notes (`LocalChange`).
 */
export type LocalFileChange =
  | { kind: 'created'; fileId: string; path: string }
  | { kind: 'renamed'; fileId: string; from: string; to: string }
  | { kind: 'deleted'; fileId: string; path: string }

export interface Transfers {
  uploads: number
  downloads: number
}

interface Stat {
  mtime: number
  size: number
}

/** A file's content as read, with the stat it had while being read. */
interface Read {
  data: Bytes
  hash: string
  stat: Stat
}

// Fewer than notes: each one can be a large file in memory.
const CONCURRENCY = 4
const RETRY_MS = 30_000
const STOP_DRAIN_MS = 2_000
// A view that had the file open may save what it held right after another
// device's version was written into it. Obsidian saves an edited view about
// 2 s after the last change; this leaves room for that.
const STALE_SAVE_MS = 5_000
const DAY_MS = 24 * 60 * 60 * 1000
// Content copied in from a shared note or folder is kept this long, up to this much in all, for writing its file.
const COPIED_KEEP_MS = 60_000
const COPIED_KEEP_BYTES = 16 * 1024 * 1024
// Content no file names is let go of only after this long untouched, whatever the retention.
const UNNAMED_MIN_DAYS = 7

/** `stem (label)ext`, or `stem (label n)ext` from the second on. */
function besides(path: string, label: string, n: number): string {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  const cut = dot > slash ? dot : path.length
  return `${path.slice(0, cut)} (${label}${n > 1 ? ` ${n}` : ''})${path.slice(cut)}`
}

function stamp(when: Date): string {
  return `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())} ${two(when.getHours())}${two(when.getMinutes())}`
}

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
  return besides(path, `conflict ${stamp(when)}`, n)
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
  private readonly localListeners = new Set<(change: { kind: 'deleted' | 'restored'; entry: AttachmentEntry }) => void>()
  private readonly fileListeners = new Set<(change: LocalFileChange) => void>()
  /** Renames and deletes that happened before the index arrived. */
  private readonly early: Array<() => Promise<void>> = []
  private readonly transfers: Transfers = { uploads: 0, downloads: 0 }
  /** fileId -> when this device last wrote another device's version into the file. */
  private readonly written = new Map<string, number>()
  /** Content copied in from someone else's store just now, by hash, for the file written from it next. */
  private readonly copied = new Map<string, Bytes>()
  /** Names a file waits at while two swap names (`followRenames`); nothing may take one for a file of its own. */
  private readonly aside = new Set<string>()
  private applying: Promise<void> = Promise.resolve()
  private scanning: Promise<void> | null = null
  private retryTimer: number | null = null
  private rescanTimer: number | null = null
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
    // Signed out elsewhere - a password change, a recovery, 2FA turned on. Said
    // once where the device learns it; not a failure of this transfer.
    else if (error instanceof ApiError && error.status === 401) log.info('attachment transfer stopped: this device is signed out')
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
    // Copied in from someone's shared note or folder a moment ago: the same bytes, not fetched twice.
    const copied = this.copied.get(hash)
    if (copied) {
      this.copied.delete(hash)
      return Promise.resolve(copied)
    }
    return this.transfer('downloads', () => this.blobs.download(hash))
  }

  /**
   * File and index agree on `hash`. `stat` must be the one the file had when
   * that content was read or written - not the one it has by now, which may
   * belong to a newer save.
   */
  private agree(fileId: string, path: string, stat: Stat, hash: string): void {
    this.state.setAttachment(fileId, { path, mtime: stat.mtime, size: stat.size, hash })
  }

  /** The content with the stat it had while being read; null if it changed meanwhile. */
  private async read(file: TFile): Promise<Read | null> {
    const stat = { mtime: file.stat.mtime, size: file.stat.size }
    const data = new Uint8Array(await this.app.vault.readBinary(file))
    if (file.stat.mtime !== stat.mtime || file.stat.size !== stat.size || data.length !== stat.size) return null
    return { data, hash: await contentHash(data), stat }
  }

  /** Whether the file still has what was read: by its stat, or failing that by its content. */
  private async stillHolds(file: TFile, read: Read): Promise<boolean> {
    if (this.stopped || !this.exists(file)) return false
    if (file.stat.mtime === read.stat.mtime && file.stat.size === read.stat.size) return true
    const now = await this.read(file)
    return now !== null && now.hash === read.hash
  }

  /** Whether the scan may skip the file: it looks exactly as when this device last agreed on it. */
  private looksUnchanged(file: TFile, fileId = this.state.attachmentAt(file.path)): boolean {
    if (!fileId) return false
    const known = this.state.attachment(fileId)
    const entry = this.index.entry(fileId)
    return Boolean(
      known &&
        entry &&
        !entry.deletedAt &&
        known.path === file.path &&
        entry.hash === known.hash &&
        known.mtime === file.stat.mtime &&
        known.size === file.stat.size
    )
  }

  /** Whether a view on this device shows the file - and may save what it holds. */
  private isOpen(file: TFile): boolean {
    let open = false
    this.app.workspace?.iterateAllLeaves((leaf) => {
      if ((leaf.view as { file?: TFile | null }).file === file) open = true
    })
    return open
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
    // Not every write reaches a plugin as an event; this catches what did not.
    this.rescanTimer = window.setInterval(() => void this.scan(), this.options.rescanMs)
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
    this.copied.clear()
    for (const timer of this.settling.values()) window.clearTimeout(timer)
    this.settling.clear()
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (this.rescanTimer !== null) window.clearInterval(this.rescanTimer)
    this.rescanTimer = null
    await Promise.race([
      Promise.all(Array.from(this.locks.values())),
      new Promise((resolve) => window.setTimeout(resolve, STOP_DRAIN_MS))
    ])
    this.listeners.clear()
  }

  /** Every file that does not look as last agreed. One scan at a time. */
  private scan(): Promise<void> {
    if (this.scanning) return this.scanning
    const run = async (): Promise<void> => {
      if (!this.isReady) return
      const files = this.app.vault
        .getFiles()
        .filter((file) => file.extension !== 'md' && !this.isExcluded(file.path) && !this.looksUnchanged(file))
      await this.pool(files, (file) => this.syncLocal(file))
    }
    this.scanning = run().finally(() => {
      this.scanning = null
    })
    return this.scanning
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
        void this.syncLocal(file, true).catch((error: unknown) => this.failed(error))
      }, this.options.settleMs)
    )
  }

  /**
   * Brings one file into agreement with the index. `changed`: an event said
   * its content changed, so it is read whatever its stat says.
   */
  async syncLocal(file: TFile, changed = false): Promise<void> {
    if (!this.tracks(file) || this.aside.has(file.path)) return
    const path = file.path
    const fileId = this.index.idForPath(path) ?? this.state.attachmentAt(path) ?? (await this.index.nextId(path))
    const bytes = Math.max(file.stat.size, this.index.entry(fileId)?.size ?? 0)
    await this.guarded(fileId, bytes, () => this.takeIn(fileId, file, path, changed))
  }

  private async takeIn(fileId: string, file: TFile, path: string, changed = false): Promise<void> {
    if (this.stopped || file.path !== path || !this.exists(file)) return
    // A live entry appeared at this path while this waited: the file is
    // that one's now, and is taken in under its id - after this lock is let go.
    const claimant = this.index.idForPath(path)
    if (claimant && claimant !== fileId && !this.index.entry(fileId)) {
      this.settle(file)
      return
    }
    if (!changed && this.looksUnchanged(file, fileId)) return
    if (file.stat.size > this.options.maxFileBytes) {
      if (!this.tooLarge.has(path)) log.warn(`${path}: ${file.stat.size} bytes, larger than the server takes; it stays on this device`)
      this.tooLarge.add(path)
      return
    }
    this.tooLarge.delete(path)

    const read = await this.read(file)
    if (!read) {
      // Written to while being read: the write's own event brings it back.
      this.settle(file)
      return
    }
    const { data, hash } = read
    const known = this.state.attachment(fileId)
    let entry = this.index.entry(fileId)
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
      this.agree(fileId, path, read.stat, hash)
      return
    } else if (entry && unchanged) {
      await this.replace(fileId, file, entry, read)
      return
    }

    // Changed here, or never agreed: the content goes to the server before
    // the index names it.
    await this.upload(data, hash)
    entry = this.index.entry(fileId)
    if (this.stopped || !this.exists(file) || file.path !== path) return
    if (!entry) {
      const known = this.index.idForPath(path)
      const id = await this.index.add(path, hash, data.length)
      if (id !== fileId && this.index.entry(id)?.hash !== hash) {
        // Another device registered this path meanwhile, with other content.
        this.settle(file)
        return
      }
      this.agree(id, path, read.stat, hash)
      log.info(`${path}: new attachment, ${data.length} bytes`)
      if (!known) this.created(id, path)
      return
    }
    if (entry.deletedAt) {
      this.index.revive(fileId, path, hash, data.length)
      this.agree(fileId, path, read.stat, hash)
      log.info(`${path}: deleted elsewhere but changed here, kept`)
      new Notice(`${nameOf(path)} was deleted on another device but changed here, so it was kept.`, 10_000)
      return
    }
    if (entry.hash === hash) {
      this.agree(fileId, path, read.stat, hash)
      return
    }
    if (base !== null && entry.hash === base) {
      if (this.staleSave(fileId, file)) {
        await this.keepTheirsAside(fileId, file, read, entry)
        return
      }
      this.index.setContent(fileId, hash, data.length)
      this.agree(fileId, path, read.stat, hash)
      log.debug(`${path}: changed here, ${data.length} bytes`)
      return
    }
    await this.conflict(fileId, file, read, entry)
  }

  private async reviveLocal(fileId: string, file: TFile, read: Read): Promise<void> {
    await this.upload(read.data, read.hash)
    if (this.stopped || !this.exists(file)) return
    this.index.revive(fileId, file.path, read.hash, read.data.length)
    this.agree(fileId, file.path, read.stat, read.hash)
    log.info(`${file.path}: deleted elsewhere but changed here, kept`)
    new Notice(`${file.name} was deleted on another device but changed here, so it was kept.`, 10_000)
  }

  /** A file new in this vault, made on this device - by the user, or as the second of two versions kept. */
  private created(fileId: string, path: string): void {
    for (const listener of this.fileListeners) listener({ kind: 'created', fileId, path })
  }

  private freeConflictPath(path: string, when: Date): string {
    let candidate = conflictName(path, when, 1)
    for (let n = 2; this.app.vault.getAbstractFileByPath(candidate) || this.index.idForPath(candidate); n += 1) {
      candidate = conflictName(path, when, n)
    }
    return candidate
  }

  /** Writes another device's version into a file, remembering when - see `staleSave`. */
  private async overwrite(fileId: string, file: TFile, data: Bytes, hash: string): Promise<void> {
    await this.app.vault.modifyBinary(file, buffer(data))
    this.written.set(fileId, Date.now())
    this.agree(fileId, file.path, { mtime: file.stat.mtime, size: data.length }, hash)
  }

  /**
   * Both sides changed the file - or there is no base to tell. This device's
   * version becomes a file of its own next to it; the path takes the index's.
   * The other version is fetched first: if that fails nothing has changed,
   * and trying again later does not leave a second copy behind. And the
   * file must still hold what was read - a save while this downloaded is
   * newer than the copy would be, and overwriting it lost it.
   */
  private async conflict(fileId: string, file: TFile, read: Read, entry: AttachmentEntry): Promise<void> {
    const theirs = await this.download(entry.hash)
    if (!(await this.stillHolds(file, read))) {
      this.settle(file)
      return
    }
    const copyPath = this.freeConflictPath(file.path, new Date())
    const copy = await this.app.vault.createBinary(copyPath, buffer(read.data))
    const copyId = await this.index.add(copyPath, read.hash, read.data.length)
    this.agree(copyId, copyPath, { mtime: copy.stat.mtime, size: read.data.length }, read.hash)
    this.created(copyId, copyPath)
    // Saved in the moment the copy took: that save is a change of its own,
    // and gets a copy of its own rather than being overwritten.
    if (!(await this.stillHolds(file, read))) {
      this.settle(file)
      return
    }
    await this.overwrite(fileId, file, theirs, entry.hash)
    log.error(`${file.path}: two versions kept - changed here and elsewhere; this device's version is ${copyPath}`)
    new Notice(`${file.name} was changed here and on another device. Both are kept: this device's version is ${nameOf(copyPath)}.`, 12_000)
  }

  /**
   * A view showing the file saved what it held, just after another device's
   * version was written into it - that version would be gone without anyone
   * having seen it.
   */
  private staleSave(fileId: string, file: TFile): boolean {
    const at = this.written.get(fileId)
    return at !== undefined && Date.now() - at < STALE_SAVE_MS && this.isOpen(file)
  }

  /**
   * Keeps the other device's version next to the file, and this device's at
   * the path - not the other way round: writing into the open view again
   * would only make it save once more.
   */
  private async keepTheirsAside(fileId: string, file: TFile, read: Read, entry: AttachmentEntry): Promise<void> {
    const theirs = await this.download(entry.hash)
    if (!(await this.stillHolds(file, read))) {
      this.settle(file)
      return
    }
    const copyPath = this.freeConflictPath(file.path, new Date())
    const copy = await this.app.vault.createBinary(copyPath, buffer(theirs))
    const copyId = await this.index.add(copyPath, entry.hash, theirs.length)
    this.agree(copyId, copyPath, { mtime: copy.stat.mtime, size: theirs.length }, entry.hash)
    this.index.setContent(fileId, read.hash, read.data.length)
    this.agree(fileId, file.path, read.stat, read.hash)
    this.written.delete(fileId)
    this.created(copyId, copyPath)
    log.error(`${file.path}: two versions kept - saved by its open view over another device's version, which is ${copyPath}`)
    new Notice(
      `${file.name} was saved here just as another device's version arrived. Both are kept: the other version is ${nameOf(copyPath)}.`,
      12_000
    )
  }

  /** The index's version into a file that still has the base's content. */
  private async replace(fileId: string, file: TFile, entry: AttachmentEntry, read: Read): Promise<void> {
    if (!(await this.blobs.keep(read.hash))) await this.upload(read.data, read.hash)
    const data = await this.download(entry.hash)
    // Changed while this was downloading: that change gets its own turn.
    if (!(await this.stillHolds(file, read))) {
      this.settle(file)
      return
    }
    await this.overwrite(fileId, file, data, entry.hash)
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
    // Moved out of another's way by `followRenames`, which keeps the state itself.
    if (this.aside.has(file.path)) return
    // The new path first, for the reason notes look it up first: a rename this
    // device applied for another one arrives here too.
    const fileId = this.index.idForPath(file.path) ?? this.index.idForPath(oldPath)
    if (!fileId) {
      this.settle(file)
      return
    }
    const renamed = this.index.rename(fileId, file.path)
    const known = this.state.attachment(fileId)
    if (known) this.state.setAttachment(fileId, { ...known, path: file.path })
    if (renamed) for (const listener of this.fileListeners) listener({ kind: 'renamed', fileId, from: oldPath, to: file.path })
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
    const entry = this.index.entry(fileId)
    await this.withLock(fileId, async () => {
      this.index.markDeleted(fileId)
      this.state.forgetAttachment(fileId)
    })
    log.info(`${path}: attachment deleted here`)
    if (entry) for (const listener of this.localListeners) listener({ kind: 'deleted', entry })
    for (const listener of this.fileListeners) listener({ kind: 'deleted', fileId, path })
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
    const read = await this.read(file)
    if (!read) {
      this.settle(file)
      return
    }
    const seen = read.hash === entry.hash || this.index.replaced(fileId, read.hash)
    if (read.hash !== known.hash || !seen) {
      // Revived with this device's content.
      await this.reviveLocal(fileId, file, read)
      return
    }
    if (!(await this.blobs.keep(read.hash))) await this.upload(read.data, read.hash)
    if (!(await this.stillHolds(file, read))) {
      this.settle(file)
      return
    }
    this.state.forgetAttachment(fileId)
    log.info(`${known.path}: attachment deleted on another device, moved to the trash here`)
    await this.app.fileManager.trashFile(file)
  }

  /** Renames and new content for files this device has. */
  private async follow(): Promise<void> {
    await this.followRenames()
    const changed = this.index.live().filter(({ fileId, entry }) => {
      const known = this.state.attachment(fileId)
      return known && (known.path !== entry.path || known.hash !== entry.hash)
    })
    await this.pool(changed, ({ fileId, entry }) =>
      this.guarded(fileId, Math.max(entry.size, this.state.attachment(fileId)?.size ?? 0), () => this.followOne(fileId))
    )
  }

  /**
   * Renames other devices made, in rounds, before anything else: a file whose
   * new place another file still holds waits for it to move on, and of two
   * that swapped names one waits at a free name meanwhile - as notes do
   * (`DocStore.applyRemoteRenames`). One at a time, each followed singly, two
   * that swapped stayed where they were.
   */
  private async followRenames(): Promise<void> {
    const pending = this.index.live().flatMap(({ fileId, entry }) => {
      const known = this.state.attachment(fileId)
      return known && known.path !== entry.path && !this.isExcluded(entry.path) ? [{ fileId, at: known.path, to: entry.path }] : []
    })
    for (let round = 0; pending.length > 0 && round < pending.length * 3 + 3; round += 1) {
      if (this.stopped) return
      let moved = false
      for (const item of pending.slice()) {
        if (this.app.vault.getAbstractFileByPath(item.to)) continue
        await this.withLock(item.fileId, () => this.renameTo(item.fileId, item.to)).catch((error: unknown) => this.failed(error))
        pending.splice(pending.indexOf(item), 1)
        moved = true
      }
      if (moved) continue
      const blocked = pending.find((item) => pending.some((other) => other !== item && other.at === item.to))
      if (!blocked) return
      const occupant = pending.find((other) => other.at === blocked.to) as (typeof pending)[number]
      let aside = besides(occupant.at, 'moving', 1)
      for (let n = 2; this.app.vault.getAbstractFileByPath(aside) || this.index.idForPath(aside); n += 1) aside = besides(occupant.at, 'moving', n)
      const went = await this.withLock(occupant.fileId, () => this.renameTo(occupant.fileId, aside, true)).catch((error: unknown) => {
        this.failed(error)
        return false
      })
      if (!went) return
      occupant.at = aside
    }
  }

  /** Moves a file where the index has it - or, `aside`, out of another's way for a moment. */
  private async renameTo(fileId: string, target: string, aside = false): Promise<boolean> {
    const known = this.state.attachment(fileId)
    const file = known ? this.app.vault.getAbstractFileByPath(known.path) : null
    if (!known || !(file instanceof TFile) || this.app.vault.getAbstractFileByPath(target)) return false
    if (!aside && this.index.entry(fileId)?.path !== target) return false
    await this.ensureFolder(parentOf(target))
    // Before the rename: its event must find the name taken already.
    if (aside) this.aside.add(target)
    else this.aside.delete(known.path)
    try {
      // Not `fileManager.renameFile`: links travel inside the notes (invariant 22).
      await this.app.vault.rename(file, target)
    } catch (error) {
      if (aside) this.aside.delete(target)
      throw error
    }
    this.state.setAttachment(fileId, { ...known, path: target })
    log.info(aside ? `${known.path}: out of the way at ${target}, two files swap names` : `${known.path}: renamed on another device to ${target}`)
    return true
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
    this.agree(fileId, file.path, { mtime: file.stat.mtime, size: data.length }, entry.hash)
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

  // --- files of shared notes ------------------------------------------------------------
  //
  // What comes in through a shared note is copied into this vault's own store
  // and named in its index like any other file - so everything above holds
  // for it unchanged: downloading, healing, versions, the trash, cleaning up.
  // The price is the server holding it once per account.

  /** The live file at a path, as the index has it. */
  fileAt(path: string): { fileId: string; entry: AttachmentEntry } | null {
    const fileId = this.index.idForPath(path)
    const entry = fileId ? this.index.entry(fileId) : undefined
    return fileId && entry ? { fileId, entry } : null
  }

  delivered(docId: string, ref: string): { fileId: string; entry: AttachmentEntry } | null {
    return this.index.delivered(docId, ref) ?? null
  }

  isDeclined(docId: string, ref: string): boolean {
    return this.index.isDeclined(docId, ref)
  }

  sharedBase(docId: string, ref: string): SharedBase | undefined {
    return this.index.sharedBase(docId, ref)
  }

  setSharedBase(docId: string, ref: string, base: SharedBase | null): void {
    this.index.setSharedBase(docId, ref, base)
  }

  sharedAt(path: string): Array<{ docId: string; ref: string }> {
    return this.index.sharedAt(path)
  }

  decline(docId: string, ref: string): void {
    this.index.decline(docId, ref)
  }

  undecline(docId: string, ref: string): void {
    this.index.undecline(docId, ref)
  }

  /** Fires when the user deletes a file here, or brings one back from the trash. */
  onLocalChange(listener: (change: { kind: 'deleted' | 'restored'; entry: AttachmentEntry }) => void): () => void {
    this.localListeners.add(listener)
    return () => this.localListeners.delete(listener)
  }

  /** Fires for every file the user creates, renames or deletes here. */
  onLocalFileChange(listener: (change: LocalFileChange) => void): () => void {
    this.fileListeners.add(listener)
    return () => this.fileListeners.delete(listener)
  }

  // --- files of shared folders --------------------------------------------------------
  // A shared folder's files are files of this vault like any other, copied into
  // its own store; the link says which file of which folder each one is.

  /** This vault's file for a shared folder's file. */
  linked(folderId: string, file: string): { fileId: string; entry: AttachmentEntry } | null {
    return this.index.linked(folderId, file) ?? null
  }

  setFolderLink(fileId: string, folder: AttachmentEntry['folder'] | null): void {
    this.index.setFolderLink(fileId, folder)
  }

  folderBase(folderId: string, file: string): SharedBase | undefined {
    return this.index.folderBase(folderId, file)
  }

  setFolderBase(folderId: string, file: string, base: SharedBase | null): void {
    this.index.setFolderBase(folderId, file, base)
  }

  /** Every live file of this vault. */
  liveFiles(): Array<{ fileId: string; entry: AttachmentEntry }> {
    return this.index.live()
  }

  /** A shared folder's file deleted for everyone: deleted here as a delete from another device is (`applyDelete`). */
  deleteFromFolder(fileId: string): void {
    this.index.markDeleted(fileId)
  }

  /** A shared folder's file renamed there: the index moves it, and the file follows (`followRenames`). */
  renameFromFolder(fileId: string, path: string): void {
    this.index.rename(fileId, path)
  }

  /** A shared folder's file brought back for everyone: back here too, the file pulled again. */
  reviveFromFolder(fileId: string, path: string): void {
    const entry = this.index.entry(fileId)
    if (!entry?.deletedAt) return
    this.index.revive(fileId, path, entry.hash, entry.size)
  }

  /**
   * A shared folder's file, new here: copied into this vault's store, then
   * named at `path` with its link to the folder. Null if the path was taken
   * meanwhile.
   */
  async deliverFromFolder(path: string, source: SharedAttachment, room: string, link: NonNullable<AttachmentEntry['folder']>): Promise<string | null> {
    if (!this.isReady) return null
    return this.guarded(await this.index.nextId(path), source.size, async () => {
      if (this.index.idForPath(path) || this.app.vault.getAbstractFileByPath(path)) return null
      await this.copyIn(source, room)
      const fileId = await this.index.add(path, source.hash, source.size, undefined, link)
      log.info(`${path}: came in through a shared folder, ${source.size} bytes`)
      return fileId
    })
  }

  /** Content in someone else's store, named by a shared note, copied into this vault's. */
  private async copyIn(source: SharedAttachment, room: string): Promise<void> {
    if (await this.blobs.keep(source.hash)) return
    const data = await this.transfer('downloads', () => this.blobs.downloadFrom(source, room))
    await this.upload(data, source.hash)
    // The file is written from it next (`pull`); kept a moment, all of them together within a budget.
    let kept = 0
    for (const bytes of this.copied.values()) kept += bytes.length
    if (kept + data.length <= COPIED_KEEP_BYTES) {
      this.copied.set(source.hash, data)
      setTimeout(() => this.copied.delete(source.hash), COPIED_KEEP_MS)
    }
  }

  /**
   * A file a shared note brings, new here: copied into this vault's store,
   * then named at `path`. Every device of the account fetches it from there,
   * within its download limit. Null if the path was taken meanwhile.
   */
  async deliver(path: string, source: SharedAttachment, room: string, via: { docId: string; ref: string }): Promise<string | null> {
    if (!this.isReady) return null
    return this.guarded(await this.index.nextId(path), source.size, async () => {
      if (this.index.idForPath(path) || this.app.vault.getAbstractFileByPath(path)) return null
      await this.copyIn(source, room)
      const fileId = await this.index.add(path, source.hash, source.size, via)
      log.info(`${path}: came in through a shared note, ${source.size} bytes`)
      return fileId
    })
  }

  /** A delivered file whose link was renamed in the note: it follows, rather than coming in twice. */
  reroute(fileId: string, via: { docId: string; ref: string }, path: string): void {
    this.index.reroute(fileId, via)
    if (!this.app.vault.getAbstractFileByPath(path) && !this.index.idForPath(path)) this.index.rename(fileId, path)
  }

  /**
   * A shared note's newer version of a file here, which replaced the one this
   * vault has knowingly: into this vault's store, then the file takes it -
   * on every device, the way any change from elsewhere arrives.
   */
  async adopt(fileId: string, source: SharedAttachment, room: string): Promise<void> {
    await this.guarded(fileId, source.size, async () => {
      if (!this.index.entry(fileId) || this.index.entry(fileId)?.deletedAt) return
      await this.copyIn(source, room)
      this.index.setContent(fileId, source.hash, source.size)
    })
  }

  /**
   * Both this vault and the shared note changed a file: this vault's version
   * is kept as a file of its own next to it, the note's takes the file. The
   * copy's content is on the server already; only the index has to name it.
   * Returns where the copy went.
   */
  async keepAsideAndAdopt(fileId: string, source: SharedAttachment, room: string): Promise<string | null> {
    const entry = this.index.entry(fileId)
    if (!entry || entry.deletedAt) return null
    return this.guarded(fileId, Math.max(entry.size, source.size), async () => {
      const current = this.index.entry(fileId)
      // Another device of the account got there first.
      if (!current || current.deletedAt || current.hash === source.hash) return null
      await this.copyIn(source, room)
      const copyPath = this.freeConflictPath(current.path, new Date())
      const copyId = await this.index.add(copyPath, current.hash, current.size)
      this.index.setContent(fileId, source.hash, source.size)
      this.created(copyId, copyPath)
      log.error(`${current.path}: two versions kept - changed here and in a shared note; this vault's version is ${copyPath}`)
      return copyPath
    })
  }

  // --- the trash and earlier versions -------------------------------------------------

  /** Files of this vault deleted since `since` whose content the server still keeps, newest first. */
  deletedFiles(since: number): DeletedFile[] {
    return this.index
      .deleted()
      .filter(({ entry }) => !entry.purgedAt && (entry.deletedAt as number) >= since)
      .map(({ fileId, entry }) => ({ fileId, path: entry.path, deletedAt: entry.deletedAt as number, size: entry.size }))
      .sort((a, b) => b.deletedAt - a.deletedAt)
  }

  /**
   * Brings a deleted file back - here and, through the index, on every
   * device - at its path, or next to whatever took that meanwhile. Null while
   * its content cannot be fetched: the file follows once the server answers.
   */
  async restoreDeleted(fileId: string): Promise<TFile | null> {
    const entry = this.index.entry(fileId)
    if (!this.isReady || !entry?.deletedAt || entry.purgedAt) return null
    let path = entry.path
    for (let n = 1; this.app.vault.getAbstractFileByPath(path) || this.index.idForPath(path); n += 1) path = besides(entry.path, 'restored', n)
    await this.guarded(fileId, entry.size, async () => {
      this.index.revive(fileId, path, entry.hash, entry.size)
      this.state.forgetAttachment(fileId)
      await this.pull(fileId).catch((error: unknown) => this.failed(error))
    })
    log.info(`${entry.path}: restored from the trash${path === entry.path ? '' : ` as ${path}`}`)
    for (const listener of this.localListeners) listener({ kind: 'restored', entry })
    const file = this.app.vault.getAbstractFileByPath(path)
    return file instanceof TFile ? file : null
  }

  /**
   * What a link in a note points at when no file in the vault answers it: a
   * file this device left on the server, or one in the trash - the newest
   * deleted first. Matched the way Obsidian resolves a link.
   */
  embedTarget(link: string): EmbedTarget | null {
    if (!this.isReady || !link) return null
    const matches = (path: string): boolean => path === link || path.endsWith(`/${link}`) || nameOf(path) === link
    const live = this.index.live().find(({ entry }) => matches(entry.path) && !this.app.vault.getAbstractFileByPath(entry.path))
    if (live) return { fileId: live.fileId, path: live.entry.path, hash: live.entry.hash, size: live.entry.size, deleted: false }
    const deleted = this.index
      .deleted()
      .filter(({ entry }) => !entry.purgedAt && matches(entry.path))
      .sort((a, b) => (b.entry.deletedAt ?? 0) - (a.entry.deletedAt ?? 0))[0]
    if (!deleted) return null
    return { fileId: deleted.fileId, path: deleted.entry.path, hash: deleted.entry.hash, size: deleted.entry.size, deleted: true }
  }

  /** Whether the file is one this store syncs and the index knows. */
  knows(file: TFile): boolean {
    return this.isReady && file.extension !== 'md' && Boolean(this.index.idForPath(file.path))
  }

  /**
   * Where one file stands, for the cloud in the status bar: `unsent` while it
   * is not taken in as it is now, `waiting` while another device's version is
   * on its way, `local` when the server does not take a file that large.
   */
  fileState(file: TFile): AttachmentSyncState {
    if (!this.tracks(file)) return 'untracked'
    if (this.tooLarge.has(file.path)) return 'local'
    const fileId = this.state.attachmentAt(file.path)
    if (!fileId || this.locks.has(fileId) || this.settling.has(file.path)) return 'unsent'
    if (this.looksUnchanged(file, fileId)) return 'synced'
    const known = this.state.attachment(fileId)
    const entry = this.index.entry(fileId)
    const asAgreed = known && known.path === file.path && known.mtime === file.stat.mtime && known.size === file.stat.size
    return asAgreed && entry && !entry.deletedAt && entry.hash !== known.hash ? 'waiting' : 'unsent'
  }

  /** Earlier contents of a file that the server keeps, newest first. */
  versionsOf(file: TFile, since = 0): FileVersion[] {
    const fileId = this.index.idForPath(file.path)
    const entry = fileId ? this.index.entry(fileId) : undefined
    if (!fileId || !entry) return []
    return this.index
      .versions(fileId)
      .filter(
        (version) =>
          version.hash !== entry.hash && !version.purgedAt && version.at >= since && version.at - version.since >= this.options.minVersionAgeMs
      )
      .map(({ hash, size, since: from, at }) => ({ hash, size, since: from, at }))
  }

  /** One version's content, for a preview. */
  contentOf(hash: string): Promise<Bytes> {
    return this.download(hash)
  }

  /**
   * Makes an earlier version current again. An edit like any other: what the
   * file holds now becomes a version in turn, and every device follows.
   */
  async restoreVersion(file: TFile, hash: string): Promise<void> {
    const fileId = this.index.idForPath(file.path)
    const entry = fileId ? this.index.entry(fileId) : undefined
    if (!fileId || !entry) throw new Error('This file is not synced.')
    await this.guarded(fileId, Math.max(entry.size, file.stat.size), async () => {
      const read = await this.read(file)
      if (!read) throw new Error('The file is being written; try again in a moment.')
      // What it holds now - perhaps a change not taken in yet - becomes a
      // version first, so the restore replaces nothing that is not kept.
      if (read.hash !== this.index.entry(fileId)?.hash) {
        await this.upload(read.data, read.hash)
        this.index.setContent(fileId, read.hash, read.data.length)
      }
      const data = await this.download(hash)
      if (!(await this.stillHolds(file, read))) throw new Error('The file changed meanwhile; try again.')
      await this.app.vault.modifyBinary(file, buffer(data))
      this.index.setContent(fileId, hash, data.length)
      this.agree(fileId, file.path, { mtime: file.stat.mtime, size: data.length }, hash)
    })
    log.info(`${file.path}: an earlier version restored`)
  }

  /** An earlier version as a file of its own, next to the file. */
  async saveVersionCopy(file: TFile, version: FileVersion): Promise<TFile> {
    const data = await this.download(version.hash)
    const label = `version ${stamp(new Date(version.since))}`
    let path = besides(file.path, label, 1)
    for (let n = 2; this.app.vault.getAbstractFileByPath(path) || this.index.idForPath(path); n += 1) path = besides(file.path, label, n)
    const copy = await this.app.vault.createBinary(path, buffer(data))
    // The content is on the server already; only the index has to name it.
    await this.guarded(await this.index.nextId(path), data.length, async () => {
      const id = await this.index.add(path, version.hash, data.length)
      if (this.index.entry(id)?.hash === version.hash) this.agree(id, path, { mtime: copy.stat.mtime, size: data.length }, version.hash)
    })
    log.info(`${file.path}: an earlier version saved as ${path}`)
    return copy
  }

  // --- rolling back ------------------------------------------------------------------
  // As with notes, a rollback trashes, moves, brings back and replaces files
  // the way a person would, and every device follows.

  /** Every entry of the index, live and deleted. */
  allEntries(): Array<{ fileId: string; entry: AttachmentEntry }> {
    return [...this.index.live(), ...this.index.deleted()]
  }

  entryOf(fileId: string): AttachmentEntry | undefined {
    return this.index.entry(fileId)
  }

  /** Which of these contents the server no longer has. */
  missingContents(hashes: string[]): Promise<string[]> {
    return hashes.length === 0 ? Promise.resolve([]) : this.blobs.missing(hashes)
  }

  /** What this device holds of a file, for a rollback's copy; null when it is on the server only. */
  async currentBytes(fileId: string): Promise<Bytes | null> {
    const entry = this.index.entry(fileId)
    const file = entry && !entry.deletedAt ? this.app.vault.getAbstractFileByPath(entry.path) : null
    return file instanceof TFile ? new Uint8Array(await this.app.vault.readBinary(file)) : null
  }

  /**
   * A file that did not exist at the moment rolled back to goes to the trash -
   * once the server holds what it holds now, so the trash brings that back
   * (invariant 23).
   */
  async trashFile(fileId: string): Promise<void> {
    const entry = this.index.entry(fileId)
    if (!entry || entry.deletedAt) return
    const file = this.app.vault.getAbstractFileByPath(entry.path)
    await this.guarded(fileId, file instanceof TFile ? file.stat.size : 0, async () => {
      if (file instanceof TFile) {
        const read = await this.read(file)
        if (!read) throw new Error(`${entry.path} is being written; try again in a moment`)
        if (!(await this.blobs.keep(read.hash))) await this.upload(read.data, read.hash)
        if (read.hash !== entry.hash) this.index.setContent(fileId, read.hash, read.data.length)
        if (!(await this.stillHolds(file, read))) throw new Error(`${entry.path} changed meanwhile; try again`)
      }
      this.index.markDeleted(fileId)
      this.state.forgetAttachment(fileId)
      // Its delete event then finds nothing left to do.
      if (file instanceof TFile) await this.app.fileManager.trashFile(file)
    })
    log.info(`${entry.path}: moved to the trash by a rollback`)
    for (const listener of this.localListeners) listener({ kind: 'deleted', entry })
  }

  /** Moves a file back, with `vault.rename` (invariant 22). */
  async moveFile(fileId: string, path: string): Promise<void> {
    const entry = this.index.entry(fileId)
    if (!entry || entry.deletedAt || entry.path === path) return
    const file = this.app.vault.getAbstractFileByPath(entry.path)
    if (!(file instanceof TFile)) {
      this.index.rename(fileId, path)
      return
    }
    const from = file.path
    await this.ensureFolder(parentOf(path))
    await this.app.vault.rename(file, path)
    await this.onRename(file, from)
  }

  /** Brings a deleted file back with the content it had then, at `path` or next to it. Returns where it went. */
  async reviveFile(fileId: string, path: string, hash: string, size: number): Promise<string | null> {
    const entry = this.index.entry(fileId)
    if (!entry) return null
    if (!entry.deletedAt) return entry.path
    let target = path
    for (let n = 1; this.app.vault.getAbstractFileByPath(target) || this.index.idForPath(target); n += 1) target = besides(path, 'restored', n)
    await this.guarded(fileId, size, async () => {
      this.index.revive(fileId, target, hash, size)
      this.state.forgetAttachment(fileId)
      await this.pull(fileId)
    })
    for (const listener of this.localListeners) listener({ kind: 'restored', entry })
    return target
  }

  /**
   * Content only a backup still had, put back into the vault's store - checked
   * against the hash it is named by - so an entry can name it again.
   */
  async uploadContent(data: Bytes, hash: string): Promise<void> {
    if ((await contentHash(data)) !== hash) throw new Error(`the content does not match its hash ${hash.slice(0, 12)}`)
    await this.memory.run(data.length, () => this.upload(data, hash))
  }

  /**
   * A file a backup holds that the vault knows under no name any more: written
   * into the vault, where it is taken in like any new file. Returns where it
   * went - next to its old place when that is taken.
   */
  async createFile(path: string, data: Bytes, hash: string): Promise<string> {
    if ((await contentHash(data)) !== hash) throw new Error(`the content does not match its hash ${hash.slice(0, 12)}`)
    let target = path
    for (let n = 1; this.app.vault.getAbstractFileByPath(target) || this.index.idForPath(target); n += 1) target = besides(path, 'restored', n)
    await this.ensureFolder(parentOf(target))
    await this.app.vault.createBinary(target, buffer(data))
    return target
  }

  /**
   * A file's content as it was - like restoring a version: what it holds now
   * stays a version of its own. A file this device left on the server only
   * changes in the index; it comes with the new content when it is needed.
   */
  async setFileContent(fileId: string, hash: string, size: number): Promise<void> {
    const entry = this.index.entry(fileId)
    if (!entry || entry.deletedAt) return
    const file = this.app.vault.getAbstractFileByPath(entry.path)
    if (file instanceof TFile) await this.restoreVersion(file, hash)
    else this.index.setContent(fileId, hash, size)
  }

  /**
   * Lets the server go of content nothing needs any more: files deleted
   * longer ago than the retention, versions older than it, and versions that
   * were current only briefly. Any device of the account may run it. Only
   * what the server confirms gone leaves the index; what it kept for now is
   * asked about again next time, so nothing is forgotten while it still
   * takes up room. Returns how many contents went.
   */
  async cleanUp(retentionDays: number, now = Date.now()): Promise<number> {
    if (!this.isReady || retentionDays <= 0) return 0
    const cutoff = now - retentionDays * DAY_MS
    const needed = new Set<string>()
    const expiredFiles: Array<{ fileId: string; hash: string }> = []
    for (const { entry } of this.index.live()) needed.add(entry.hash)
    for (const { fileId, entry } of this.index.deleted()) {
      if (entry.purgedAt) continue
      if ((entry.deletedAt as number) >= cutoff) needed.add(entry.hash)
      else expiredFiles.push({ fileId, hash: entry.hash })
    }
    const expiredVersions: AttachmentVersion[] = []
    const briefVersions: AttachmentVersion[] = []
    for (const version of this.index.versions()) {
      if (version.at < cutoff) expiredVersions.push(version)
      else if (version.at - version.since >= this.options.minVersionAgeMs) needed.add(version.hash)
      else if (!version.purgedAt) briefVersions.push(version)
    }
    const candidates = new Set(
      [...expiredFiles, ...expiredVersions.filter((version) => !version.purgedAt), ...briefVersions]
        .map(({ hash }) => hash)
        .filter((hash) => !needed.has(hash))
    )
    const kept = candidates.size > 0 ? await this.blobs.purge(Array.from(candidates)) : new Set<string>()
    for (const { fileId, hash } of expiredFiles) if (!kept.has(hash)) this.index.markPurged(fileId)
    for (const version of expiredVersions) if (!kept.has(version.hash)) this.index.dropVersion(version.fileId, version.hash)
    for (const version of briefVersions) {
      if (candidates.has(version.hash) && !kept.has(version.hash)) this.index.markVersionPurged(version.fileId, version.hash)
    }
    const gone = Array.from(candidates).filter((hash) => !kept.has(hash)).length
    if (gone > 0) log.info(`attachments: let go of ${gone} content(s) nothing needs any more`)
    return gone + (await this.letGoOfUnnamed(retentionDays, now))
  }

  /**
   * Content in this vault's store that no file names: uploaded, and then a
   * crash, a stop or a delete before its entry was written - the order
   * invariant 23 demands leaves that behind - and uploads that never ended.
   * Only what was untouched for longer than the retention, and never less than
   * a week: another device may have uploaded it a moment ago and name it next,
   * and reusing content touches it (`Blobs.keep`).
   */
  private async letGoOfUnnamed(retentionDays: number, now: number): Promise<number> {
    let listing: BlobListResponse
    try {
      listing = await this.blobs.list()
    } catch (error) {
      // A server from before 0.8.2 lists nothing.
      if (error instanceof ApiError && error.status === 404) return 0
      throw error
    }
    const cutoff = now - Math.max(retentionDays, UNNAMED_MIN_DAYS) * DAY_MS
    const old = [...listing.blobs, ...listing.uploads].filter((blob) => blob.touchedAt < cutoff)
    if (old.length === 0) return 0
    const named = new Set<string>()
    for (const hash of this.index.namedHashes()) named.add(await this.blobs.idOf(hash))
    const unnamed = old.map((blob) => blob.id).filter((id) => !named.has(id))
    if (unnamed.length === 0) return 0
    const kept = await this.blobs.purgeIds(unnamed)
    const gone = unnamed.filter((id) => !kept.has(id)).length
    if (gone > 0) log.info(`attachments: let go of ${gone} content(s) no file ever named`)
    return gone
  }
}
