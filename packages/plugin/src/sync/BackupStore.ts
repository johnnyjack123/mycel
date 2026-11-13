import type { DataAdapter } from 'obsidian'
import { log } from '../log.js'
import { makePluginFolder } from '../pluginFolder.js'

// Copies taken before anything that could delete text. They live in the plugin
// folder rather than the vault so they stay out of search, graph and tags - and
// out of whatever else syncs the vault.

export type BackupKind = 'local' | 'remote' | 'merged'

export interface BackupRecord {
  path: string
  day: string
  file: string
  kind: BackupKind
  note: string
}

const BACKUP_DIR = 'backups'

function two(value: number): string {
  return value.toString().padStart(2, '0')
}

function dayOf(date: Date): string {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
}

function timeOf(date: Date): string {
  return `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
}

function safeName(notePath: string): string {
  return notePath.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
}

export class BackupStore {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly root: string
  ) {}

  private path(...parts: string[]): string {
    return [this.root, BACKUP_DIR, ...parts].join('/')
  }

  /**
   * Writes one snapshot and returns where it landed. Never over another one: two of the same
   * note within a second - an adopt and a merge, one after the other - each keep a file.
   */
  async write(notePath: string, kind: BackupKind, text: string, when = new Date()): Promise<string> {
    const day = dayOf(when)
    await makePluginFolder(this.adapter, this.root, this.path(day))
    const name = `${timeOf(when)}-${safeName(notePath)}`
    let target = this.path(day, `${name}.${kind}.md`)
    for (let n = 2; await this.adapter.exists(target); n += 1) target = this.path(day, `${name} (${n}).${kind}.md`)
    await this.adapter.write(target, text)
    return target
  }

  /**
   * A copy of every file of the vault, made before a device new to a vault on the server
   * changes anything in it (`Joining`). In a folder of its own inside the day's, so it goes
   * when that day's merge backups go. Returns the folder; throws when a file could not be
   * copied whole - nothing may be changed then.
   */
  async copyVault(
    paths: string[],
    /** Null: the file is gone since it was listed - nothing of it to keep. */
    read: (path: string) => Promise<ArrayBuffer | null>,
    progress: (done: number, total: number) => void = () => undefined,
    when = new Date()
  ): Promise<string> {
    const day = dayOf(when)
    let folder = this.path(day, `${timeOf(when)} before connecting`)
    for (let n = 2; await this.adapter.exists(folder); n += 1) folder = this.path(day, `${timeOf(when)} before connecting (${n})`)
    const made = new Set<string>()
    const ensureAll = (dir: string): Promise<void> => makePluginFolder(this.adapter, this.root, dir, made)
    progress(0, paths.length)
    for (const [done, path] of paths.entries()) {
      const data = await read(path)
      if (data === null) {
        progress(done + 1, paths.length)
        continue
      }
      const target = `${folder}/${path}`
      await ensureAll(target.slice(0, target.lastIndexOf('/')))
      await this.adapter.writeBinary(target, data)
      const stat = await this.adapter.stat(target)
      if (!stat || stat.size !== data.byteLength) throw new Error(`${path} was not copied whole`)
      progress(done + 1, paths.length)
    }
    // Even an empty vault leaves its folder: the window names it.
    await ensureAll(folder)
    return folder
  }

  /** Both sides of a reconcile, so either can be recovered by hand. */
  async captureBoth(notePath: string, local: string, remote: string): Promise<string[]> {
    const when = new Date()
    return [
      await this.write(notePath, 'local', local, when),
      await this.write(notePath, 'remote', remote, when)
    ]
  }

  async list(): Promise<BackupRecord[]> {
    const base = [this.root, BACKUP_DIR].join('/')
    if (!(await this.adapter.exists(base))) return []
    const records: BackupRecord[] = []
    const days = await this.adapter.list(base)
    for (const dayPath of days.folders) {
      const day = dayPath.split('/').pop() ?? dayPath
      const entries = await this.adapter.list(dayPath)
      for (const filePath of entries.files) {
        const file = filePath.split('/').pop() ?? filePath
        const match = /^(\d{6})-(.*)\.(local|remote|merged)\.md$/.exec(file)
        if (!match) continue
        records.push({
          path: filePath,
          day,
          file,
          kind: match[3] as BackupKind,
          note: match[2] as string
        })
      }
    }
    return records.sort((a, b) => (a.day === b.day ? b.file.localeCompare(a.file) : b.day.localeCompare(a.day)))
  }

  async read(path: string): Promise<string> {
    return this.adapter.read(path)
  }

  /** Drops whole day folders past the retention window. */
  async prune(retentionDays: number): Promise<number> {
    if (retentionDays <= 0) return 0
    const base = [this.root, BACKUP_DIR].join('/')
    if (!(await this.adapter.exists(base))) return 0
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    const cutoffDay = dayOf(cutoff)
    let removed = 0
    const days = await this.adapter.list(base)
    for (const dayPath of days.folders) {
      const day = dayPath.split('/').pop() ?? ''
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= cutoffDay) continue
      try {
        await this.adapter.rmdir(dayPath, true)
        removed += 1
      } catch (error) {
        log.error(`removing old backups in ${dayPath} failed`, error)
      }
    }
    return removed
  }
}
