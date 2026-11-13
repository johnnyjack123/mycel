import { TFile, TFolder, type DataAdapter, type TAbstractFile } from 'obsidian'
import { bytes, contentHash, utf8 } from '@mycel/shared/crypto'
import { log } from '../log.js'
import { makePluginFolder } from '../pluginFolder.js'

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

  /** Starts a journal; refused while one waits. */
  static async begin(vault: PastVault, adapter: DataAdapter, root: string, start: PastStart): Promise<PastFiles> {
    if (await PastFiles.pending(adapter, root)) throw new Error('the past of an earlier Time Machine still waits to be put back')
    const dir = PastFiles.dir(root)
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir)
    if (!(await adapter.exists(`${dir}/copies`))) await adapter.mkdir(`${dir}/copies`)
    const files = new PastFiles(vault, adapter, root, { ...start, at: Date.now() })
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
    if (!this.originals.has(path)) return undefined
    const original = this.originals.get(path)
    if (!original) return null
    return new Uint8Array(await this.adapter.readBinary(`${this.dir}/${original.copy}`))
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
      const copy = `copies/${this.copies}`
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
  async show(path: string, content: string | Uint8Array | null, mtime?: number): Promise<void> {
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

  /** A folder of now that the past does not have, emptied by taking its files away. */
  async removeFolderIfEmpty(path: string): Promise<void> {
    const folder = this.vault.getAbstractFileByPath(path)
    if (!(folder instanceof TFolder) || folder.children.length > 0) return
    await this.append({ t: 'unfolder', path })
    this.removedFolders.push(path)
    this.own.set(path, Date.now())
    await this.vault.delete(folder, true)
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
  async restore(): Promise<RestoreReport> {
    const failed: string[] = []
    const aside: string[] = [...this.asideKept]
    const asideDir = this.asideDir()
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

  /** The journal and the copies go - only after a restore that left nothing out. */
  async finish(): Promise<void> {
    await this.adapter.rmdir(this.dir, true)
  }
}
