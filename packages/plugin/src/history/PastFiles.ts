import { TFile, TFolder, type DataAdapter, type TAbstractFile } from 'obsidian'
import { bytes, contentHash, utf8 } from '@mycel/shared/crypto'
import { log } from '../log.js'
import { makePluginFolder, untilFree } from '../pluginFolder.js'

// The past written into the vault's own files (`docs/TIMEMACHINE.md`, U3), and
// taken out of them again. Only ever while the sync is stopped on this device:
// it would read every file written here as an edit and send the past to every
// device and person. Before a file is first replaced, moved away or written
// over, its content goes into the plugin folder, and a journal line says so -
// both before the step. *Abort* puts every file back from there, byte for
// byte, with its times; a start of the plugin that finds a journal does that
// before the sync may start (`docs/TIMEMACHINE.md`, U3 step 9).

const DIR = 'timemachine'
const JOURNAL = 'journal.jsonl'
const ASIDE_DIR = 'timemachine-aside'
// Vault events this soon after the Time Machine wrote a path are its own.
const OWN_EVENT_MS = 5_000

/** Openings whose copies are still needed: a clearing beside a new opening never takes its copies. */
const live = new Set<number>()
/** One clearing at a time: two would race for the same copies. Never rejects. */
let clearing: Promise<void> = Promise.resolve()

/** The opening a copy was made for, from its name (`<at>-<n>`); NaN for one named before 0.9.27. */
function openingOf(path: string): number {
  const match = /^(\d+)-\d+$/.exec(path.slice(path.lastIndexOf('/') + 1))
  return match ? Number(match[1]) : Number.NaN
}

async function clearCopies(adapter: DataAdapter, root: string): Promise<void> {
  const dir = `${root}/${DIR}`
  if (await adapter.exists(`${dir}/${JOURNAL}`)) return
  const copies = `${dir}/copies`
  if (!(await adapter.exists(copies))) return
  let failed = 0
  let first: unknown = null
  for (const path of (await adapter.list(copies)).files) {
    if (live.has(openingOf(path))) continue
    try {
      await adapter.remove(path)
    } catch (error) {
      failed += 1
      first ??= error
    }
  }
  if (failed > 0) log.warn(`${failed} copies of the Time Machine could not be removed; they go the next time`, first)
}

/** What the Time Machine needs of Obsidian's vault. */
export interface PastVault {
  getAbstractFileByPath(path: string): TAbstractFile | null
  readBinary(file: TFile): Promise<ArrayBuffer>
  modify(file: TFile, text: string, options?: WriteOptions): Promise<void>
  modifyBinary(file: TFile, data: ArrayBuffer, options?: WriteOptions): Promise<void>
  create(path: string, text: string, options?: WriteOptions): Promise<TFile>
  createBinary(path: string, data: ArrayBuffer, options?: WriteOptions): Promise<TFile>
  createFolder(path: string): Promise<unknown>
  delete(file: TAbstractFile, force?: boolean): Promise<void>
}

interface WriteOptions {
  ctime?: number
  mtime?: number
}

/** A file as it was before the Time Machine first touched its path. */
interface Original {
  /** Where its content lies, inside the journal's folder. */
  copy: string
  hash: string
  size: number
  ctime: number
  mtime: number
}

export interface PastStart {
  /** What the Time Machine shows: kept for the window after a crash. */
  scope: unknown
  /** The vault lock it holds, and whose, to let go of after a crash. */
  lockId: string | null
  vaultId: string | null
}

type Line =
  | ({ t: 'start'; at: number } & PastStart)
  | { t: 'path'; path: string; original: Original | null }
  | { t: 'wrote'; path: string; hash: string | null }
  | { t: 'folder'; path: string }
  | { t: 'unfolder'; path: string }

export interface RestoreReport {
  /** Paths that could not be put back; the journal stays for another try. */
  failed: string[]
  /** Past files someone else wrote over meanwhile - kept in the plugin folder, then put back. */
  aside: string[]
  /** Where those lie. */
  asideDir: string | null
}

/** How far putting the files back got. */
export type RestoreProgress = (done: number, of: number) => void

/** The files are being put back: the past is written no more. */
export class PastFilesClosed extends Error {
  constructor() {
    super('the Time Machine is putting the files back')
  }
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

function buffer(data: Uint8Array): ArrayBuffer {
  return data.slice().buffer
}

export class PastFiles {
  private readonly originals = new Map<string, Original | null>()
  /** What the Time Machine last wrote at a path; null: it took the file away. */
  private readonly wrote = new Map<string, string | null>()
  /** Folders it made for the past, and folders of now it took away because they emptied. */
  private readonly madeFolders: string[] = []
  private readonly removedFolders: string[] = []
  private readonly own = new Map<string, number>()
  /** Past files someone else wrote over since: kept aside before they are written again. */
  private readonly foreign = new Set<string>()
  private readonly asideKept: string[] = []
  private copies = 0
  /**
   * Set once the files go back: no past is written after that. What is being
   * written at that moment is waited for, nothing else - reading the past from
   * the server, which may hang, never holds *Abort* up (0.9.21).
   */
  private closed = false
  private readonly writing = new Set<Promise<unknown>>()
  /** Copies being read - for an editor's marks, the overview -, waited for before they are removed. */
  private readonly reading = new Set<Promise<unknown>>()
  /** The files are back and the journal goes: what lay at a path is read from the vault again, never from a copy. */
  private finished = false

  private constructor(
    private readonly vault: PastVault,
    private readonly adapter: DataAdapter,
    private readonly root: string,
    readonly start: PastStart & { at: number }
  ) {}

  private static dir(root: string): string {
    return `${root}/${DIR}`
  }

  private get dir(): string {
    return PastFiles.dir(this.root)
  }

  /** Whether a journal waits: the past may still lie in the files. */
  static pending(adapter: DataAdapter, root: string): Promise<boolean> {
    return adapter.exists(`${PastFiles.dir(root)}/${JOURNAL}`)
  }

  /**
   * Starts a journal; refused while one waits. Its folders stay from one opening to the next:
   * removing a folder may never work (`clearLeftovers`), and nothing waits for leftovers here.
   */
  static async begin(vault: PastVault, adapter: DataAdapter, root: string, start: PastStart): Promise<PastFiles> {
    if (await PastFiles.pending(adapter, root)) throw new Error('the past of an earlier Time Machine still waits to be put back')
    const dir = PastFiles.dir(root)
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir)
    if (!(await adapter.exists(`${dir}/copies`))) await adapter.mkdir(`${dir}/copies`)
    const files = new PastFiles(vault, adapter, root, { ...start, at: Date.now() })
    live.add(files.start.at)
    await adapter.write(`${dir}/${JOURNAL}`, `${JSON.stringify({ t: 'start', at: files.start.at, ...start } satisfies Line)}\n`)
    return files
  }

  /** The journal a crash left, read back; null when there is none. */
  static async resume(vault: PastVault, adapter: DataAdapter, root: string): Promise<PastFiles | null> {
    const path = `${PastFiles.dir(root)}/${JOURNAL}`
    if (!(await adapter.exists(path))) return null
    const lines = (await adapter.read(path))
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Line]
        } catch {
          // A line cut short by the crash: the step after it never began.
          return []
        }
      })
    const head = lines[0]
    const start =
      head?.t === 'start' ? { at: head.at, scope: head.scope, lockId: head.lockId, vaultId: head.vaultId } : { at: 0, scope: null, lockId: null, vaultId: null }
    const files = new PastFiles(vault, adapter, root, start)
    live.add(start.at)
    for (const line of lines) {
      if (line.t === 'path' && !files.originals.has(line.path)) files.originals.set(line.path, line.original)
      else if (line.t === 'wrote') files.wrote.set(line.path, line.hash)
      else if (line.t === 'folder') files.madeFolders.push(line.path)
      else if (line.t === 'unfolder') files.removedFolders.push(line.path)
    }
    files.copies = files.originals.size
    return files
  }

  private async append(line: Line): Promise<void> {
    await this.adapter.append(`${this.dir}/${JOURNAL}`, `${JSON.stringify(line)}\n`)
  }

  private fileAt(path: string): TFile | null {
    const file = this.vault.getAbstractFileByPath(path)
    return file instanceof TFile ? file : null
  }

  /** Whether the Time Machine has written, moved or taken away anything at this path. */
  touched(path: string): boolean {
    return this.originals.has(path)
  }

  /** Every path it touched. */
  paths(): string[] {
    return Array.from(this.originals.keys())
  }

  /** Whether a vault event at this path is the Time Machine's own. */
  isOwn(path: string): boolean {
    const at = this.own.get(path)
    return at !== undefined && Date.now() - at < OWN_EVENT_MS
  }

  /** A vault event: someone else's at a path showing the past is kept aside before that path is written again. */
  noteEvent(path: string): void {
    if (this.originals.has(path) && !this.isOwn(path)) this.foreign.add(path)
  }

  /** What lay at a path before the Time Machine touched it; undefined while it has not, null for nothing. */
  async originalBytes(path: string): Promise<Uint8Array | null | undefined> {
    if (this.finished || !this.originals.has(path)) return undefined
    const original = this.originals.get(path)
    if (!original) return null
    const read = this.adapter.readBinary(`${this.dir}/${original.copy}`)
    this.reading.add(read)
    try {
      return new Uint8Array(await read)
    } finally {
      this.reading.delete(read)
    }
  }

  /**
   * Copies what lies at a path before it is first replaced, and checks the copy
   * by reading it back: a file is only ever replaced or taken away once its
   * content is safe.
   */
  private async keep(path: string): Promise<void> {
    if (this.originals.has(path)) return
    const file = this.fileAt(path)
    let original: Original | null = null
    if (file) {
      const data = new Uint8Array(await this.vault.readBinary(file))
      const hash = await contentHash(bytes(data))
      this.copies += 1
      // Named per opening: a copy an earlier one left, still held by the system, is never written over.
      const copy = `copies/${this.start.at}-${this.copies}`
      await this.adapter.writeBinary(`${this.dir}/${copy}`, buffer(data))
      const back = new Uint8Array(await this.adapter.readBinary(`${this.dir}/${copy}`))
      if ((await contentHash(bytes(back))) !== hash) throw new Error(`the copy of ${path} did not read back as written`)
      original = { copy, hash, size: data.length, ctime: file.stat.ctime, mtime: file.stat.mtime }
    }
    await this.append({ t: 'path', path, original })
    this.originals.set(path, original)
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!path || this.vault.getAbstractFileByPath(path)) return
    await this.ensureFolder(parentOf(path))
    await this.append({ t: 'folder', path })
    this.madeFolders.push(path)
    this.own.set(path, Date.now())
    await this.vault.createFolder(path)
  }

  /**
   * Makes a path hold `content` - a note's text, a file's bytes - or nothing.
   * `mtime`: the time the file had then, so the explorer sorts the past as it
   * was and plugins that stamp notes see no edit.
   */
  show(path: string, content: string | Uint8Array | null, mtime?: number): Promise<void> {
    return this.writes(() => this.write(path, content, mtime))
  }

  /** A step that writes the past, refused once the files go back, and waited for by that. */
  private writes<T>(step: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new PastFilesClosed())
    const running = step()
    this.writing.add(running)
    const forget = (): void => {
      this.writing.delete(running)
    }
    running.then(forget, forget)
    return running
  }

  private async write(path: string, content: string | Uint8Array | null, mtime?: number): Promise<void> {
    await this.keep(path)
    const data = content === null ? null : typeof content === 'string' ? utf8(content) : bytes(content)
    const hash = data ? await contentHash(data) : null
    const file = this.fileAt(path)
    if (!file && !data) return
    if (file && this.foreign.delete(path)) {
      const current = new Uint8Array(await this.vault.readBinary(file))
      const known = await contentHash(bytes(current))
      if (known !== this.wrote.get(path) && known !== this.originals.get(path)?.hash) {
        await this.keepAside(this.asideDir(), path, current)
        this.asideKept.push(path)
      }
    }
    await this.append({ t: 'wrote', path, hash })
    this.wrote.set(path, hash)
    this.own.set(path, Date.now())
    const options = mtime === undefined ? undefined : { mtime }
    if (!data) {
      if (file) await this.vault.delete(file, true)
      return
    }
    if (file) {
      if (typeof content === 'string') await this.vault.modify(file, content, options)
      else await this.vault.modifyBinary(file, buffer(data), options)
      return
    }
    await this.ensureFolder(parentOf(path))
    if (typeof content === 'string') await this.vault.create(path, content, options)
    else await this.vault.createBinary(path, buffer(data), options)
  }

  /** What lay at a path goes back while the past is still shown: the moment shown has it as it is now. */
  async showOriginal(path: string): Promise<void> {
    if (!this.originals.has(path)) return
    const original = this.originals.get(path) ?? null
    await this.show(path, original ? await this.readCopy(original) : null, original?.mtime)
  }

  /**
   * A folder of now that the past does not have, emptied by taking its files away. One that will
   * not go - read-only, which Windows refuses to remove (0.9.28) - stays, empty: the past shows
   * well enough with it, and failing showed nothing.
   */
  removeFolderIfEmpty(path: string): Promise<void> {
    return this.writes(async () => {
      const folder = this.vault.getAbstractFileByPath(path)
      if (!(folder instanceof TFolder) || folder.children.length > 0) return
      await this.append({ t: 'unfolder', path })
      this.removedFolders.push(path)
      this.own.set(path, Date.now())
      try {
        await this.vault.delete(folder, true)
      } catch (error) {
        log.warn(`the folder ${path} could not be taken away for the past; it stays, empty`, error)
      }
    })
  }

  private async readCopy(original: Original): Promise<Uint8Array> {
    const data = new Uint8Array(await this.adapter.readBinary(`${this.dir}/${original.copy}`))
    if ((await contentHash(bytes(data))) !== original.hash) throw new Error('a copy in the plugin folder is damaged')
    return data
  }

  /**
   * Every path back to what it held before, with its times. Whatever someone
   * else wrote over a past file meanwhile - a plugin, the user in another app -
   * goes into the plugin folder first: nothing is overwritten unseen.
   */
  async restore(progress?: RestoreProgress): Promise<RestoreReport> {
    this.closed = true
    await Promise.allSettled(Array.from(this.writing))
    const failed: string[] = []
    const aside: string[] = [...this.asideKept]
    const asideDir = this.asideDir()
    const of = this.originals.size
    let done = 0
    progress?.(done, of)
    // The folders of now first, so files go back into them.
    for (const path of this.removedFolders) {
      try {
        await this.ensureVaultFolder(path)
      } catch (error) {
        log.error(`putting the folder ${path} back failed`, error)
        failed.push(path)
      }
    }
    for (const [path, original] of this.originals) {
      try {
        const file = this.fileAt(path)
        if (file) {
          const current = new Uint8Array(await this.vault.readBinary(file))
          const hash = await contentHash(bytes(current))
          if (original && hash === original.hash) continue
          if (hash !== this.wrote.get(path)) {
            await this.keepAside(asideDir, path, current)
            aside.push(path)
          }
          this.own.set(path, Date.now())
          if (original) await this.vault.modifyBinary(file, buffer(await this.readCopy(original)), { ctime: original.ctime, mtime: original.mtime })
          else await this.vault.delete(file, true)
        } else if (original) {
          await this.ensureVaultFolder(parentOf(path))
          this.own.set(path, Date.now())
          await this.vault.createBinary(path, buffer(await this.readCopy(original)), { ctime: original.ctime, mtime: original.mtime })
        }
        const after = this.fileAt(path)
        const ok = original ? after !== null && (await contentHash(bytes(new Uint8Array(await this.vault.readBinary(after))))) === original.hash : after === null
        if (!ok) throw new Error('it did not read back as it was')
      } catch (error) {
        log.error(`putting ${path} back failed`, error)
        failed.push(path)
      }
      done += 1
      progress?.(done, of)
    }
    // Folders made for the past, the deepest first, once empty.
    for (const path of [...this.madeFolders].reverse()) {
      const folder = this.vault.getAbstractFileByPath(path)
      if (folder instanceof TFolder && folder.children.length === 0 && !this.removedFolders.includes(path)) {
        try {
          await this.vault.delete(folder, true)
        } catch (error) {
          log.warn(`removing the folder ${path} failed`, error)
        }
      }
    }
    return { failed, aside, asideDir: aside.length > 0 ? asideDir : null }
  }

  private async ensureVaultFolder(path: string): Promise<void> {
    if (!path || this.vault.getAbstractFileByPath(path)) return
    await this.ensureVaultFolder(parentOf(path))
    this.own.set(path, Date.now())
    await this.vault.createFolder(path)
  }

  /** Where what was written over the past lies, per opening of the Time Machine. */
  private asideDir(): string {
    return `${this.root}/${ASIDE_DIR}/${new Date(this.start.at).toISOString().replace(/[:.]/g, '-')}`
  }

  private async keepAside(dir: string, path: string, data: Uint8Array): Promise<void> {
    const target = `${dir}/${path}`
    await makePluginFolder(this.adapter, this.root, parentOf(target))
    await this.adapter.writeBinary(target, buffer(data))
  }

  /**
   * The journal goes - only after a restore that left nothing out. It alone says the past may
   * still lie in the files, so only it must go before anything goes on; the copies are cleared
   * behind it (`clearLeftovers`), and nothing waits for them.
   */
  async finish(): Promise<void> {
    this.finished = true
    await Promise.allSettled(Array.from(this.reading))
    const journal = `${this.dir}/${JOURNAL}`
    if (await this.adapter.exists(journal)) await untilFree(() => this.adapter.remove(journal))
    live.delete(this.start.at)
    void PastFiles.clearLeftovers(this.adapter, this.root)
  }

  /**
   * The copies of openings that are over, removed one file at a time - the folders stay. A
   * folder may be impossible to remove: Google Drive set the read-only attribute on every folder
   * of a vault it synced, and Windows refuses to remove such a folder (EPERM). Removing
   * `timemachine/` whole, retried while Windows refused, held up the start of the sync, and
   * opening and leaving the Time Machine, for a minute each (0.9.28). Never while a journal
   * waits, never a copy of an opening still going; nobody needs to wait for it.
   */
  static clearLeftovers(adapter: DataAdapter, root: string): Promise<void> {
    clearing = clearing
      .then(() => clearCopies(adapter, root))
      .catch((error: unknown) => log.warn('clearing the copies of the Time Machine failed; they go the next time', error))
    return clearing
  }

  /** Resolves once no clearing runs - for the plugin's unload, which nothing may outlive. */
  static idle(): Promise<void> {
    return clearing
  }
}
