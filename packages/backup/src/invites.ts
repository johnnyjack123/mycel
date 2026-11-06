import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { encodeBackupInvite, fromBase64, newBackupSecret, toBase64 } from '@mycel/shared/crypto'

// The operator's invitations: each lets one person connect one vault, once,
// within a week. The command line writes them into the data volume and the
// running backup server takes them up from there; connecting spends one.

export interface Invite {
  id: string
  /** Base64; the invitation's secret, which the code carries. */
  secret: string
  /** Whom it is for, as the operator named it. */
  label: string
  createdAt: number
  expiresAt: number
}

interface InviteFile {
  invites: Record<string, Invite>
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export class Invites {
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly dataDir: string) {}

  private get file(): string {
    return join(this.dataDir, 'invites.json')
  }

  private async read(): Promise<InviteFile> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<InviteFile>
      return { invites: parsed.invites ?? {} }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { invites: {} }
      throw error
    }
  }

  /** Read, change, write - one at a time here; the command line and the server rarely meet. */
  private update<T>(change: (data: InviteFile) => T): Promise<T> {
    const run = this.writes.then(async () => {
      const data = await this.read()
      const result = change(data)
      await mkdir(this.dataDir, { recursive: true })
      await writeFile(`${this.file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 })
      await rename(`${this.file}.tmp`, this.file)
      return result
    })
    this.writes = run.catch(() => undefined)
    return run
  }

  /** When the file last changed, for noticing an invitation the command line made. */
  async changedAt(): Promise<number> {
    try {
      return (await stat(this.file)).mtimeMs
    } catch {
      return 0
    }
  }

  /** The invitations that still work. */
  async open(now = Date.now()): Promise<Invite[]> {
    return Object.values((await this.read()).invites)
      .filter((invite) => invite.expiresAt > now)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  async create(label: string, now = Date.now()): Promise<{ invite: Invite; code: string }> {
    const secret = newBackupSecret()
    const invite: Invite = {
      id: randomBytes(4).toString('hex'),
      secret: toBase64(secret),
      label: label.trim(),
      createdAt: now,
      expiresAt: now + WEEK_MS
    }
    await this.update((data) => {
      // Expired ones go whenever the file is written anyway.
      for (const [id, old] of Object.entries(data.invites)) if (old.expiresAt <= now) delete data.invites[id]
      data.invites[invite.id] = invite
    })
    return { invite, code: await encodeBackupInvite(secret) }
  }

  /** Withdraws one, or spends it once it was used. Whether there was one. */
  remove(id: string): Promise<boolean> {
    return this.update((data) => {
      const had = Boolean(data.invites[id])
      delete data.invites[id]
      return had
    })
  }

  static secretOf(invite: Invite): Uint8Array<ArrayBuffer> {
    return fromBase64(invite.secret)
  }
}
