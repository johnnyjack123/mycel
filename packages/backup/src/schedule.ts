import { scheduleDays, type BackupAt } from '@mycel/shared'

// When a backup at a time of day comes next - in the time zone of the device
// that set it: a container's clock runs in UTC, and "at three at night" means
// the person's night, summer time or not.

const formats = new Map<string, Intl.DateTimeFormat>()

/** Whether this runtime knows the time zone. */
export function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

function format(zone: string): Intl.DateTimeFormat {
  let known = formats.get(zone)
  if (!known) {
    known = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric'
    })
    formats.set(zone, known)
  }
  return known
}

/** What the wall clock in `zone` shows at `instant`. */
function wallClock(instant: number, zone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts: Record<string, string> = {}
  for (const part of format(zone).formatToParts(new Date(instant))) parts[part.type] = part.value
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  }
}

/**
 * The instant the wall clock in `zone` shows that date and time. A time the
 * clocks skip when summer time begins comes an hour later; one they show
 * twice when it ends is taken once.
 */
function instantOf(year: number, month: number, day: number, minutes: number, zone: string): number {
  const wanted = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60)
  let instant = wanted
  for (let round = 0; round < 2; round += 1) {
    const shown = wallClock(instant, zone)
    instant += wanted - Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second)
  }
  return instant
}

/** The first moment after `after` the schedule names; a zone this runtime does not know counts as UTC. */
export function nextAt(at: BackupAt, after: number): number {
  const zone = knownZone(at.zone) ? at.zone : 'UTC'
  const days = new Set(scheduleDays(at))
  const today = wallClock(after, zone)
  for (let offset = 0; offset <= 8; offset += 1) {
    // The date alone, at noon: a change of the clocks never moves it to another day.
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset, 12))
    if (!days.has(date.getUTCDay())) continue
    const instant = instantOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), at.minutes, zone)
    if (instant > after) return instant
  }
  // Not reached: within eight days every weekday comes once.
  return after + 24 * 60 * 60 * 1000
}

/** A schedule as the settings hold it, or null when it is not one. */
export function atOf(value: unknown): BackupAt | null {
  if (!value || typeof value !== 'object') return null
  const { minutes, weekdays, zone } = value as Partial<BackupAt>
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 0 || minutes > 1439) return null
  if (typeof zone !== 'string' || zone === '') return null
  const at: BackupAt = { minutes, zone }
  const day = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6
  if (Array.isArray(weekdays)) {
    // Days out of range dropped; none left is every day.
    const valid = weekdays.filter(day)
    if (valid.length > 0 && valid.length < 7) at.weekdays = scheduleDays({ weekdays: valid })
  }
  return at
}
