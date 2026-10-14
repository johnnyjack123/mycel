// Guessing name and password online. Every attempt answers after the same
// time, whatever happened inside, so how long the server took tells nothing;
// and an address that keeps failing is turned away for a while.
//
// There is no per-account limit, and there cannot be: a wrong password is a
// different login key, so the server does not know which account was tried.
// That also means nobody can lock someone else out.

const PACE_MS = 1_000
const WINDOW_MS = 15 * 60 * 1000
const MAX_FAILURES = 10
const BLOCK_MS = 15 * 60 * 1000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Runs `task` and answers no earlier than one second after it started, failure or not. */
export async function paced<T>(task: () => Promise<T>, paceMs = PACE_MS): Promise<T> {
  const started = Date.now()
  try {
    return await task()
  } finally {
    const left = paceMs - (Date.now() - started)
    if (left > 0) await delay(left)
  }
}

interface Attempts {
  failures: number[]
  blockedUntil: number
}

export class AddressGuard {
  private readonly records = new Map<string, Attempts>()

  constructor(
    private readonly maxFailures = MAX_FAILURES,
    private readonly windowMs = WINDOW_MS,
    private readonly blockMs = BLOCK_MS
  ) {}

  blocked(address: string, now = Date.now()): boolean {
    const record = this.records.get(address)
    return Boolean(record && record.blockedUntil > now)
  }

  failed(address: string, now = Date.now()): void {
    const record = this.records.get(address) ?? { failures: [], blockedUntil: 0 }
    record.failures = record.failures.filter((at) => now - at < this.windowMs)
    record.failures.push(now)
    if (record.failures.length >= this.maxFailures) {
      record.blockedUntil = now + this.blockMs
      record.failures = []
    }
    this.records.set(address, record)
    // Forget addresses that have been quiet, so the map cannot grow forever.
    if (this.records.size > 10_000) {
      for (const [key, value] of this.records) {
        if (value.blockedUntil < now && value.failures.every((at) => now - at >= this.windowMs)) this.records.delete(key)
      }
    }
  }
}
