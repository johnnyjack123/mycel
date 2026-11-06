import { spawn } from 'node:child_process'
import type { Writable } from 'node:stream'
import type { KeepPolicy } from '@mycel/shared'

// restic as the backup server runs it: one repository per call, its password
// and credentials in the environment of that call only. restic encrypts
// everything it stores; the backup server hands it plaintext through a folder
// in memory or a stream, never a file on disk.

export interface ResticRepo {
  /** A path, or any location restic knows: `s3:…`, `b2:…`, `sftp:…`, `rest:…`, `rclone:…`. */
  repository: string
  password: string
  /** Credentials the location needs, e.g. `AWS_ACCESS_KEY_ID`. */
  env?: Record<string, string>
}

export class ResticError extends Error {
  constructor(
    readonly code: number | null,
    readonly stderr: string,
    message: string
  ) {
    super(message)
  }
}

export interface BackupSummary {
  snapshotId: string
  filesNew: number
  filesChanged: number
  filesUnmodified: number
  dataAdded: number
  totalBytes: number
}

export interface SnapshotInfo {
  id: string
  time: string
  tags: string[]
  paths: string[]
}

export interface LsEntry {
  path: string
  type: string
  size?: number
}

/** restic's exit codes since 0.17. */
const NO_REPOSITORY = 10
const WRONG_PASSWORD = 12
const LOCKED = 11
const INCOMPLETE = 3

/** What goes to restic: nothing of the backup server's own environment that names a repository. */
function environment(repo: ResticRepo, cacheDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('RESTIC_') && !key.startsWith('MYCEL_')) env[key] = value
  }
  Object.assign(env, repo.env ?? {})
  env.RESTIC_REPOSITORY = repo.repository
  env.RESTIC_PASSWORD = repo.password
  env.RESTIC_CACHE_DIR = cacheDir
  // Status lines would only fill the buffer; the summary comes at the end anyway.
  env.RESTIC_PROGRESS_FPS = '0.0167'
  return env
}

function describe(code: number | null, stderr: string): string {
  if (code === NO_REPOSITORY) return 'there is no repository at that location'
  if (code === WRONG_PASSWORD) return 'the repository password is wrong'
  if (code === LOCKED) return 'the repository is locked by another restic'
  if (code === INCOMPLETE) return 'restic could not read every file'
  const line = stderr.trim().split('\n').filter(Boolean).pop()
  return line ? `restic: ${line}` : `restic stopped with ${code}`
}

function jsonLines<T>(stdout: string): T[] {
  const lines: T[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue
    try {
      lines.push(JSON.parse(trimmed) as T)
    } catch {
      // a status line cut short
    }
  }
  return lines
}

export class Restic {
  constructor(
    private readonly binary: string,
    private readonly cacheDir: string,
    /** Every snapshot carries it, so restic finds the last one of a vault whatever the container is called. */
    readonly host: string
  ) {}

  /**
   * Runs restic once. `input` writes its standard input; when it fails, restic
   * is killed before the input ends - an ended stream would be stored as a
   * backup cut short.
   */
  private run(
    repo: ResticRepo,
    args: string[],
    options: { cwd?: string; input?: (stdin: Writable) => Promise<void>; binary?: boolean } = {}
  ): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, {
        cwd: options.cwd,
        env: environment(repo, this.cacheDir),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      if (!options.input) child.stdin.end()
      const stdout: Buffer[] = []
      let stderr = ''
      let failed: unknown = null
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
        if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024)
      })
      child.on('error', (error) => reject(new ResticError(null, stderr, `restic could not be started: ${error.message}`)))
      child.on('close', (code) => {
        if (failed) reject(failed)
        else resolve({ code, stdout: Buffer.concat(stdout), stderr })
      })
      if (options.input) {
        const stdin = child.stdin
        // restic stopping early breaks the pipe; its exit code tells why.
        stdin.on('error', () => undefined)
        options.input(stdin).then(
          () => stdin.end(),
          (error: unknown) => {
            failed = error
            child.kill('SIGKILL')
          }
        )
      }
    })
  }

  private async ok(repo: ResticRepo, args: string[], options: Parameters<Restic['run']>[2] = {}): Promise<Buffer> {
    const result = await this.run(repo, args, options)
    if (result.code !== 0) throw new ResticError(result.code, result.stderr, describe(result.code, result.stderr))
    return result.stdout
  }

  async version(): Promise<string> {
    const result = await this.run({ repository: '', password: '' }, ['version'])
    return result.stdout.toString('utf8').trim()
  }

  /** Opens the repository, and creates it where there is none yet. */
  async ensureRepo(repo: ResticRepo): Promise<'opened' | 'created'> {
    const probe = await this.run(repo, ['cat', 'config'])
    if (probe.code === 0) return 'opened'
    if (probe.code !== NO_REPOSITORY) throw new ResticError(probe.code, probe.stderr, describe(probe.code, probe.stderr))
    await this.ok(repo, ['init'])
    return 'created'
  }

  private summary(stdout: Buffer): BackupSummary {
    const summary = jsonLines<Record<string, unknown>>(stdout.toString('utf8')).find((line) => line.message_type === 'summary')
    if (!summary || typeof summary.snapshot_id !== 'string') throw new ResticError(0, '', 'restic reported no snapshot')
    const count = (key: string): number => (typeof summary[key] === 'number' ? (summary[key] as number) : 0)
    return {
      snapshotId: summary.snapshot_id,
      filesNew: count('files_new'),
      filesChanged: count('files_changed'),
      filesUnmodified: count('files_unmodified'),
      dataAdded: count('data_added'),
      totalBytes: count('total_bytes_processed')
    }
  }

  /** The folder `cwd`, as the paths given relative to it: the snapshot holds them at its root. */
  async backupFolder(repo: ResticRepo, cwd: string, paths: string[], tags: string[]): Promise<BackupSummary> {
    const args = ['backup', '--json', '--host', this.host, ...tags.flatMap((tag) => ['--tag', tag]), '--', ...paths]
    return this.summary(await this.ok(repo, args, { cwd }))
  }

  async backupStream(repo: ResticRepo, filename: string, tags: string[], input: (stdin: Writable) => Promise<void>): Promise<BackupSummary> {
    const args = ['backup', '--json', '--host', this.host, ...tags.flatMap((tag) => ['--tag', tag]), '--stdin', '--stdin-filename', filename]
    return this.summary(await this.ok(repo, args, { input }))
  }

  async snapshots(repo: ResticRepo, tag: string): Promise<SnapshotInfo[]> {
    const stdout = await this.ok(repo, ['snapshots', '--json', '--host', this.host, '--tag', tag])
    const parsed = jsonLines<Array<{ id: string; short_id?: string; time: string; tags?: string[]; paths?: string[] }>>(stdout.toString('utf8'))[0] ?? []
    return parsed.map((snapshot) => ({ id: snapshot.id, time: snapshot.time, tags: snapshot.tags ?? [], paths: snapshot.paths ?? [] }))
  }

  /**
   * Lets go of snapshots the policy does not keep, per group of host and
   * tags - the notes and the files of a vault each keep their own. Nothing is
   * forgotten without a policy.
   */
  async forget(repo: ResticRepo, keep: KeepPolicy): Promise<void> {
    const rules = Object.entries(keep).filter(([, count]) => typeof count === 'number' && count > 0)
    if (rules.length === 0) return
    await this.ok(repo, ['forget', '--host', this.host, '--group-by', 'host,tags', ...rules.flatMap(([rule, count]) => [`--keep-${rule}`, String(count)])])
  }

  async prune(repo: ResticRepo): Promise<void> {
    await this.ok(repo, ['prune'])
  }

  /** `readData`: also read a part of the stored data, e.g. `5%`. */
  async check(repo: ResticRepo, readData?: string): Promise<void> {
    await this.ok(repo, ['check', ...(readData ? [`--read-data-subset=${readData}`] : [])])
  }

  async ls(repo: ResticRepo, snapshotId: string): Promise<LsEntry[]> {
    const stdout = await this.ok(repo, ['ls', '--json', snapshotId])
    return jsonLines<{ struct_type?: string; path?: string; type?: string; size?: number }>(stdout.toString('utf8'))
      .filter((line) => line.struct_type === 'node' && typeof line.path === 'string')
      .map((line) => ({ path: line.path as string, type: line.type ?? '', size: line.size }))
  }

  /** One file of a snapshot, whole. Only for small ones: the check reads notes back this way. */
  async dump(repo: ResticRepo, snapshotId: string, path: string): Promise<Buffer> {
    return this.ok(repo, ['dump', snapshotId, path])
  }

  /** One file of a snapshot, as a stream - a files snapshot's tar, read back whole for the weekly check. */
  async dumpTo(repo: ResticRepo, snapshotId: string, path: string, sink: (chunk: Buffer) => Promise<void>): Promise<void> {
    const child = spawn(this.binary, ['dump', snapshotId, path], {
      env: environment(repo, this.cacheDir),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-32 * 1024)
    })
    const exited = new Promise<number | null>((resolve, reject) => {
      child.on('error', (error) => reject(new ResticError(null, stderr, `restic could not be started: ${error.message}`)))
      child.on('close', resolve)
    })
    try {
      for await (const chunk of child.stdout) await sink(chunk as Buffer)
    } catch (error) {
      child.kill('SIGKILL')
      await exited.catch(() => undefined)
      throw error
    }
    const code = await exited
    if (code !== 0) throw new ResticError(code, stderr, describe(code, stderr))
  }
}
