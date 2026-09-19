import type { DataAdapter } from 'obsidian'

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

  private async ensureDir(path: string): Promise<void> {
    if (await this.adapter.exists(path)) return
    try {
      await this.adapter.mkdir(path)
    } catch {
      // Losing the race against a parallel create is harmless.
    }
  }

  /** Writes one snapshot and returns where it landed. */
  async write(notePath: string, kind: BackupKind, text: string, when = new Date()): Promise<string> {
    const day = dayOf(when)
    await this.ensureDir([this.root, BACKUP_DIR].join('/'))
    await this.ensureDir(this.path(day))
    const file = `${timeOf(when)}-${safeName(notePath)}.${kind}.md`
    const target = this.path(day, file)
    await this.adapter.write(target, text)
    return target
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
        console.error(`[crdt-sync] removing old backups in ${dayPath} failed`, error)
      }
    }
    return removed
  }
}
