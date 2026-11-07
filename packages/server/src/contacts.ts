import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { InboxItem } from '@mycel/shared'
import { AccountError, isAccountId } from './accounts.js'
import { ensureDir, writeDurable } from './durable.js'

// Who may share with whom. Two accounts become contacts when one redeems a
// one-time code the other made; the server only checks the redemption against
// a hash and passes sealed messages between them. It cannot read the names in
// them, nor forge them: both devices sign what they send with a key from the
// code that never reached the server.

const CODE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
const MAX_INBOX = 200
/**
 * An introduction is a name, an account id, two public keys and a MAC, sealed:
 * about a kilobyte. Without a bound a code's creator answered its redemption
 * with 64 MiB, again and again, until contacts.json could no longer be read -
 * and contacts and shares stopped for everyone.
 */
export const MAX_SEALED_INTRODUCTION = 16 * 1024
/** Codes one account has open at once; every code made rewrites contacts.json whole. */
export const MAX_OPEN_CODES = 50

interface StoredCode {
  owner: string
  redeemHash: string
  expiresAt: number
  usedBy?: string
}

interface ContactFile {
  codes: Record<string, StoredCode>
  /** "a|b" with a < b -> since. */
  pairs: Record<string, number>
  inbox: Record<string, InboxItem[]>
}

function empty(): ContactFile {
  return { codes: {}, pairs: {}, inbox: {} }
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
}

export class ContactStore {
  private cache: { mtimeMs: number; data: ContactFile } | null = null
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly dataDir: string) {}

  private get file(): string {
    return join(this.dataDir, 'contacts.json')
  }

  private async load(): Promise<ContactFile> {
    let mtimeMs: number
    try {
      mtimeMs = (await stat(this.file)).mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return empty()
    }
    if (this.cache && this.cache.mtimeMs === mtimeMs) return this.cache.data
    const data = { ...empty(), ...(JSON.parse(await readFile(this.file, 'utf8')) as Partial<ContactFile>) }
    this.cache = { mtimeMs, data }
    return data
  }

  /** Read, change, write, one at a time. Only the server writes this file - the CLI never does - so no lock between processes. */
  private update<T>(mutate: (data: ContactFile) => T | Promise<T>): Promise<T> {
    const run = this.writes.then(async () => {
      this.cache = null
      const loaded = await this.load()
      const before = JSON.stringify(loaded, null, 2)
      const data = structuredClone(loaded)
      const result = await mutate(data)
      const after = JSON.stringify(data, null, 2)
      if (after === before) return result
      await ensureDir(this.dataDir)
      await writeDurable(this.file, after)
      this.cache = { mtimeMs: (await stat(this.file)).mtimeMs, data }
      return result
    })
    this.writes = run.catch(() => undefined)
    return run
  }

  /** Waits for the writes queued so far. */
  flush(): Promise<unknown> {
    return this.writes
  }

  addCode(owner: string, codeId: unknown, redeemHash: unknown, expiresAt: unknown, now = Date.now()): Promise<void> {
    if (typeof codeId !== 'string' || !/^[0-9a-f]{32}$/.test(codeId)) return Promise.reject(new AccountError(400, 'not a code id'))
    if (typeof redeemHash !== 'string' || !/^[0-9a-f]{64}$/.test(redeemHash)) return Promise.reject(new AccountError(400, 'not a redeem hash'))
    const expires = typeof expiresAt === 'number' ? Math.min(expiresAt, now + CODE_LIFETIME_MS) : now + CODE_LIFETIME_MS
    return this.update((data) => {
      if (data.codes[codeId]) throw new AccountError(409, 'that code exists already')
      for (const [id, code] of Object.entries(data.codes)) if (code.expiresAt < now) delete data.codes[id]
      const open = Object.values(data.codes).filter((code) => code.owner === owner && !code.usedBy).length
      if (open >= MAX_OPEN_CODES) throw new AccountError(429, 'too many friend codes are open; delete some first')
      data.codes[codeId] = { owner, redeemHash, expiresAt: expires }
    })
  }

  /** The creator takes back a code nobody has redeemed. */
  revokeCode(owner: string, codeId: unknown): Promise<void> {
    if (typeof codeId !== 'string') return Promise.reject(new AccountError(400, 'not a code id'))
    return this.update((data) => {
      const code = data.codes[codeId]
      if (!code || code.owner !== owner || code.usedBy) return
      delete data.codes[codeId]
    })
  }

  /** The creator of a code still open, for the holder to check the creator's key against the code. */
  async codeOwner(codeId: unknown, now = Date.now()): Promise<string | null> {
    if (typeof codeId !== 'string') return null
    const code = (await this.load()).codes[codeId]
    return code && !code.usedBy && code.expiresAt >= now ? code.owner : null
  }

  /**
   * Redeems a code once: the two become contacts, and the creator finds the
   * redeemer's sealed message in their inbox.
   */
  redeem(redeemer: string, codeId: unknown, redeemKey: unknown, sealed: unknown, now = Date.now()): Promise<string> {
    if (typeof codeId !== 'string' || typeof redeemKey !== 'string' || typeof sealed !== 'string' || sealed.length === 0) {
      return Promise.reject(new AccountError(400, 'incomplete redemption'))
    }
    if (sealed.length > MAX_SEALED_INTRODUCTION) return Promise.reject(new AccountError(413, 'the introduction is too long'))
    return this.update((data) => {
      const code = data.codes[codeId]
      const hash = sha256Hex(Buffer.from(redeemKey, 'base64'))
      if (!code || code.usedBy || code.expiresAt < now || !sameHex(code.redeemHash, hash)) {
        throw new AccountError(403, 'this code is not valid (any more)')
      }
      if (code.owner === redeemer) throw new AccountError(400, 'that is your own code')
      code.usedBy = redeemer
      data.pairs[pairKey(code.owner, redeemer)] ??= now
      this.deliver(data, code.owner, { kind: 'request', from: redeemer, codeId, sealed }, now)
      return code.owner
    })
  }

  /** The creator's answer to a redemption: only to the one who redeemed that code. */
  reply(from: string, to: unknown, codeId: unknown, sealed: unknown, now = Date.now()): Promise<void> {
    if (!isAccountId(to) || typeof codeId !== 'string' || typeof sealed !== 'string' || sealed.length === 0) {
      return Promise.reject(new AccountError(400, 'incomplete reply'))
    }
    if (sealed.length > MAX_SEALED_INTRODUCTION) return Promise.reject(new AccountError(413, 'the introduction is too long'))
    return this.update((data) => {
      const code = data.codes[codeId]
      if (!code || code.owner !== from || code.usedBy !== to) throw new AccountError(403, 'no such redemption')
      // One answer per redemption: a device answering again - another device of
      // the creator, a retry - replaces the one still waiting.
      const inbox = data.inbox[to]
      if (inbox) data.inbox[to] = inbox.filter((item) => !(item.kind === 'reply' && item.codeId === codeId && item.from === from))
      this.deliver(data, to, { kind: 'reply', from, codeId, sealed }, now)
    })
  }

  private deliver(data: ContactFile, to: string, item: Omit<InboxItem, 'id' | 'at'>, now: number): void {
    const inbox = (data.inbox[to] ??= [])
    inbox.push({ ...item, id: randomBytes(8).toString('hex'), at: now })
    if (inbox.length > MAX_INBOX) inbox.splice(0, inbox.length - MAX_INBOX)
  }

  async inbox(account: string): Promise<InboxItem[]> {
    return (await this.load()).inbox[account] ?? []
  }

  done(account: string, ids: unknown): Promise<void> {
    const drop = new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])
    return this.update((data) => {
      const inbox = data.inbox[account]
      if (!inbox) return
      data.inbox[account] = inbox.filter((item) => !drop.has(item.id))
      if (data.inbox[account]?.length === 0) delete data.inbox[account]
    })
  }

  async connected(a: string, b: string): Promise<boolean> {
    return Boolean((await this.load()).pairs[pairKey(a, b)])
  }

  async contactsOf(account: string): Promise<string[]> {
    const found: string[] = []
    for (const key of Object.keys((await this.load()).pairs)) {
      const [a, b] = key.split('|') as [string, string]
      if (a === account) found.push(b)
      else if (b === account) found.push(a)
    }
    return found
  }

  /** Two accounts connected without a code - only for tests and administration. */
  pair(a: string, b: string, now = Date.now()): Promise<void> {
    return this.update((data) => {
      data.pairs[pairKey(a, b)] ??= now
    })
  }

  /** Returns whether they were connected. */
  unpair(a: string, b: string): Promise<boolean> {
    return this.update((data) => {
      const key = pairKey(a, b)
      if (!data.pairs[key]) return false
      delete data.pairs[key]
      return true
    })
  }

  /**
   * An account replaced every key. Its open codes carry the old identity's
   * fingerprint, and what waits in an inbox to or from it was sealed with the
   * old keys - an introduction from before taken now would pin them again. All
   * of it goes; returns its contacts, to be told.
   */
  replaced(account: string): Promise<string[]> {
    return this.update((data) => {
      for (const [id, code] of Object.entries(data.codes)) if (code.owner === account && !code.usedBy) delete data.codes[id]
      delete data.inbox[account]
      for (const [to, items] of Object.entries(data.inbox)) {
        const kept = items.filter((item) => item.from !== account)
        if (kept.length === 0) delete data.inbox[to]
        else data.inbox[to] = kept
      }
      const contacts: string[] = []
      for (const key of Object.keys(data.pairs)) {
        const [a, b] = key.split('|') as [string, string]
        if (a === account) contacts.push(b)
        else if (b === account) contacts.push(a)
      }
      return contacts
    })
  }

  /** Everything of an account that is being removed. */
  forget(account: string): Promise<string[]> {
    return this.update((data) => {
      const former: string[] = []
      for (const key of Object.keys(data.pairs)) {
        const [a, b] = key.split('|') as [string, string]
        if (a === account || b === account) {
          former.push(a === account ? b : a)
          delete data.pairs[key]
        }
      }
      for (const [id, code] of Object.entries(data.codes)) if (code.owner === account) delete data.codes[id]
      delete data.inbox[account]
      return former
    })
  }
}
