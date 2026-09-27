// The plugin's log: what happened on this device, kept in the plugin folder
// so a bug that cannot be reproduced can still be followed afterwards. It
// mirrors the console, one file per day, a week of them.
//
// Never the text of a note: paths, ids, sizes and outcomes only. The vault
// holds the text in plain sight anyway, but a log is what gets pasted into
// an issue.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** What the log needs of Obsidian's DataAdapter. */
export interface LogFiles {
  exists(path: string): Promise<boolean>
  mkdir(path: string): Promise<void>
  append(path: string, data: string): Promise<void>
  read(path: string): Promise<string>
  list(path: string): Promise<{ files: string[] }>
  remove(path: string): Promise<void>
}

const PREFIX = '[obsidian-connect]'
const KEEP_DAYS = 7
const FLUSH_MS = 2_000
/** Lines kept while no file is attached yet, or while writing fails. */
const MAX_PENDING = 2_000
const MAX_DETAIL = 2_000
const DAY_MS = 24 * 60 * 60 * 1000

function day(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

function describe(detail: unknown): string {
  if (detail instanceof Error) return `${detail.name}: ${detail.message}${detail.stack ? `\n${detail.stack}` : ''}`
  if (typeof detail === 'string') return detail
  try {
    const json = JSON.stringify(detail, (_key, value: unknown) =>
      value instanceof Uint8Array ? `<${value.length} bytes>` : value
    )
    return json.length > MAX_DETAIL ? `${json.slice(0, MAX_DETAIL)}…` : json
  } catch {
    return String(detail)
  }
}

export class Log {
  /** Detailed logging: every frame, every caret. Off, `debug` goes nowhere. */
  verbose = false
  private files: LogFiles | null = null
  private dir = ''
  private pending: string[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()

  /** From now on the log goes to `dir`; what was logged before goes there too. Old days are deleted. */
  async attach(files: LogFiles, dir: string, now = Date.now()): Promise<void> {
    this.files = files
    this.dir = dir
    try {
      if (!(await files.exists(dir))) await files.mkdir(dir)
      const oldest = day(now - KEEP_DAYS * DAY_MS)
      for (const path of (await files.list(dir)).files) {
        const match = /connect-(\d{4}-\d{2}-\d{2})\.log$/.exec(path)
        if (match && (match[1] as string) < oldest) await files.remove(path)
      }
    } catch (error) {
      console.warn(`${PREFIX} preparing the log folder failed`, error)
    }
    this.schedule()
  }

  debug(message: string, detail?: unknown): void {
    if (this.verbose) this.write('debug', message, detail)
  }

  info(message: string, detail?: unknown): void {
    this.write('info', message, detail)
  }

  warn(message: string, detail?: unknown): void {
    this.write('warn', message, detail)
  }

  error(message: string, detail?: unknown): void {
    this.write('error', message, detail)
  }

  private write(level: LogLevel, message: string, detail: unknown): void {
    const args = detail === undefined ? [`${PREFIX} ${message}`] : [`${PREFIX} ${message}`, detail]
    if (level === 'error') console.error(...args)
    else if (level === 'warn') console.warn(...args)
    else if (level === 'info') console.info(...args)
    else console.debug(...args)
    const now = Date.now()
    const line = `${new Date(now).toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${detail === undefined ? '' : ` ${describe(detail)}`}`
    this.pending.push(line)
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING)
    this.schedule()
  }

  private schedule(): void {
    if (!this.files || this.timer !== null || this.pending.length === 0) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, FLUSH_MS)
  }

  private file(ts: number): string {
    return `${this.dir}/connect-${day(ts)}.log`
  }

  /** Writes what is pending. Resolves once it is on disk. */
  flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.writing = this.writing.then(async () => {
      const files = this.files
      if (!files || this.pending.length === 0) return
      const lines = this.pending.splice(0)
      try {
        await files.append(this.file(Date.now()), `${lines.join('\n')}\n`)
      } catch (error) {
        // Kept for the next attempt; the console has them already.
        this.pending.unshift(...lines)
        console.warn(`${PREFIX} writing the log failed`, error)
      }
    })
    return this.writing
  }

  /** The last `maxChars` of today's and yesterday's log, for pasting into an issue. */
  async recent(maxChars = 200_000, now = Date.now()): Promise<string> {
    await this.flush()
    const files = this.files
    if (!files) return this.pending.join('\n')
    let text = ''
    for (const ts of [now - DAY_MS, now]) {
      const path = this.file(ts)
      if (await files.exists(path)) text += await files.read(path)
    }
    return text.length > maxChars ? text.slice(text.length - maxChars) : text
  }

  /** Stops writing; what is pending is written first. */
  async detach(): Promise<void> {
    await this.flush()
    this.files = null
  }
}

/** The one log of the plugin. */
export const log = new Log()
