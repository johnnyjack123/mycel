// The backup server's log: what happened, to which vault and destination, with
// counts and ids. Never a note's text, a key or a password.

type Level = 'debug' | 'info' | 'warn' | 'error'

let quiet = false

/** Self-tests keep their own output readable. */
export function silence(on: boolean): void {
  quiet = on
}

function write(level: Level, message: string, error?: unknown): void {
  if (quiet && level !== 'error') return
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}`
  const detail = error instanceof Error ? ` - ${error.message}` : error !== undefined ? ` - ${String(error)}` : ''
  if (level === 'error' || level === 'warn') console.error(line + detail)
  else console.log(line + detail)
}

export const log = {
  debug: (message: string): void => {
    if (process.env.MYCEL_BACKUP_DEBUG === 'true') write('debug', message)
  },
  info: (message: string): void => write('info', message),
  warn: (message: string, error?: unknown): void => write('warn', message, error),
  error: (message: string, error?: unknown): void => write('error', message, error)
}
