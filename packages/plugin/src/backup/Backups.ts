import type {
  BackupGrant,
  BackupScheduleSetting,
  BackupServerInfo,
  BackupServerSetting,
  BackupTargetSetting,
  BackupVaultStatus,
  KeepPolicy
} from '@obsidian-connect/shared'
import { randomBytes, toHex, type Bytes } from '@obsidian-connect/shared/crypto'
import { log } from '../log'
import type { AccountSettings } from '../sync/AccountSettings'
import { openBackupSession, type BackupSession } from './BackupLink'

// This vault's backup servers, as the settings show them: connecting one,
// where it puts the vault and how often, starting a run, what came of it. The
// settings live in the account-wide settings document, so every device sees
// them; the sessions are this device's own.

export interface BackupsDeps {
  serverUrl: () => string
  token: () => string | null
  settings: () => AccountSettings | null
  /** The vault this device syncs: its id and key, which a session shows a backup server. */
  vault: () => { vaultId: string; key: Bytes } | null
  /** A backup key for this vault and the grant around it; needs the password. */
  makeGrant: (password: string, label: string) => Promise<BackupGrant>
  deleteKey: (keyId: string) => Promise<void>
  /** When this device last saw a good backup per backup server, kept on the device. */
  lastGood: () => Record<string, number>
  saveLastGood: (value: Record<string, number>) => Promise<void>
}

/** What the settings show for one backup server. */
export interface BackupServerView {
  setting: BackupServerSetting
  targets: BackupTargetSetting[]
  everyHours: number
  /** Null while it was not asked yet, or could not be reached. */
  status: BackupVaultStatus | null
  info: BackupServerInfo | null
  /** Why it could not be asked. */
  error: string | null
}

export const SCHEDULES: ReadonlyArray<{ hours: number; label: string }> = [
  { hours: 0, label: 'Only when started here' },
  { hours: 1, label: 'Every hour' },
  { hours: 6, label: 'Every 6 hours' },
  { hours: 24, label: 'Every day' },
  { hours: 168, label: 'Every week' }
]

const DEFAULT_EVERY_HOURS = 24
export const DEFAULT_KEEP: KeepPolicy = { last: 3, daily: 7, weekly: 5, monthly: 12, yearly: 3 }
const HOUR_MS = 60 * 60 * 1000

export class Backups {
  private readonly sessions = new Map<string, Promise<BackupSession>>()
  private readonly views = new Map<string, { status: BackupVaultStatus | null; info: BackupServerInfo | null; error: string | null }>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: BackupsDeps) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }

  private get settings(): AccountSettings {
    const settings = this.deps.settings()
    if (!settings) throw new Error('Sync is not running.')
    return settings
  }

  servers(): BackupServerSetting[] {
    return (this.deps.settings()?.backupServers() ?? []).sort((a, b) => a.addedAt - b.addedAt)
  }

  view(routeId: string): BackupServerView | null {
    const setting = this.servers().find((server) => server.routeId === routeId)
    if (!setting) return null
    const known = this.views.get(routeId)
    return {
      setting,
      targets: (this.deps.settings()?.backupTargets(routeId) ?? []).sort((a, b) => a.addedAt - b.addedAt),
      everyHours: this.deps.settings()?.backupSchedule(routeId)?.everyHours ?? 0,
      status: known?.status ?? null,
      info: known?.info ?? null,
      error: known?.error ?? null
    }
  }

  /** A session showing this vault to the backup server; opened once and kept while it lasts. */
  private session(routeId: string, authorize = true): Promise<BackupSession> {
    const existing = this.sessions.get(routeId)
    if (existing) {
      return existing.then((session) => {
        if (session.open) return session
        this.sessions.delete(routeId)
        return this.session(routeId, authorize)
      })
    }
    const setting = this.servers().find((server) => server.routeId === routeId)
    if (!setting) return Promise.reject(new Error('That backup server is not connected to this vault.'))
    const opening = (async () => {
      const token = this.deps.token()
      if (!token) throw new Error('Sign in first.')
      const session = await openBackupSession(this.deps.serverUrl(), token, setting.code)
      if (authorize) {
        const vault = this.deps.vault()
        if (!vault) throw new Error('Sync is not running.')
        await session.authorize(vault.vaultId, vault.key)
      }
      session.onEvent((event) => {
        if (event.ev === 'finished') void this.ask(routeId)
      })
      return session
    })()
    this.sessions.set(routeId, opening)
    opening.catch(() => {
      if (this.sessions.get(routeId) === opening) this.sessions.delete(routeId)
    })
    return opening
  }

  /** Asks a backup server how this vault stands there; the view keeps the answer. */
  async ask(routeId: string): Promise<BackupServerView | null> {
    const vault = this.deps.vault()
    try {
      const session = await this.session(routeId)
      const status = await session.call<BackupVaultStatus>('status', { vaultId: vault?.vaultId })
      const info = this.views.get(routeId)?.info ?? (await session.call<BackupServerInfo>('info'))
      this.views.set(routeId, { status, info, error: null })
      const good = status.runs.find((run) => run.ok)
      if (good) await this.noteGood(routeId, good.finishedAt)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.views.set(routeId, { status: null, info: this.views.get(routeId)?.info ?? null, error: message })
    }
    this.changed()
    return this.view(routeId)
  }

  private async noteGood(routeId: string, at: number): Promise<void> {
    const known = this.deps.lastGood()
    if ((known[routeId] ?? 0) >= at) return
    await this.deps.saveLastGood({ ...known, [routeId]: at })
  }

  /**
   * Connects a backup server to this vault: a backup key for it, handed over
   * inside the session, and an entry in the settings every device shares.
   */
  async connect(code: string, password: string, label: string): Promise<BackupServerSetting> {
    const token = this.deps.token()
    if (!token) throw new Error('Sign in first.')
    const session = await openBackupSession(this.deps.serverUrl(), token, code)
    try {
      const info = await session.call<BackupServerInfo>('info')
      const name = label.trim() || info.name
      const grant = await this.deps.makeGrant(password, name)
      await session.call('connect', { grant })
      const setting: BackupServerSetting = { routeId: session.routeId, code: code.trim(), label: name, keyId: grant.keyId, addedAt: Date.now() }
      const settings = this.settings
      const previous = settings.backupServers().find((server) => server.routeId === session.routeId)
      settings.setBackupServer(session.routeId, setting)
      if (!settings.backupSchedule(session.routeId)) {
        settings.setBackupSchedule(session.routeId, { server: session.routeId, everyHours: DEFAULT_EVERY_HOURS } satisfies BackupScheduleSetting)
      }
      // Connected again - a new key in place of one a password change ended, or of an old one.
      if (previous && previous.keyId !== grant.keyId) await this.deps.deleteKey(previous.keyId).catch(() => undefined)
      this.views.set(session.routeId, { status: null, info, error: null })
      this.changed()
      return setting
    } finally {
      session.close()
    }
  }

  /**
   * Hands every backup server of this vault a new key - after a password
   * change or a recovery ended the old ones. A backup server that cannot be
   * reached is left; its view says it needs connecting again.
   */
  async reconnectAll(password: string): Promise<number> {
    let done = 0
    for (const server of this.servers()) {
      try {
        await this.connect(server.code, password, server.label)
        done += 1
      } catch (error) {
        log.warn(`connecting the backup server ${server.label} again failed`, error)
        this.views.set(server.routeId, { status: null, info: null, error: 'Its backup key ended with the password change; connect it again.' })
      }
    }
    this.closeSessions()
    this.changed()
    return done
  }

  /** Takes the vault off a backup server: its key goes, its settings go. Its repositories stay where they are. */
  async disconnect(routeId: string): Promise<void> {
    const setting = this.servers().find((server) => server.routeId === routeId)
    if (!setting) return
    const vault = this.deps.vault()
    try {
      const session = await this.session(routeId)
      await session.call('disconnect', { vaultId: vault?.vaultId })
    } catch (error) {
      // Unreachable or already forgotten: without its key it reads nothing anyway.
      log.warn(`telling ${setting.label} to forget the vault failed`, error)
    }
    await this.deps.deleteKey(setting.keyId)
    const settings = this.settings
    for (const target of settings.backupTargets(routeId)) settings.setBackupTarget(target.id, null)
    settings.setBackupSchedule(routeId, null)
    settings.setBackupServer(routeId, null)
    this.forgetSession(routeId)
    this.views.delete(routeId)
    this.changed()
  }

  /**
   * Adds a destination after the backup server checked it - its folder, and
   * for restic the repository and password, made if there is none.
   */
  async addTarget(routeId: string, target: Pick<BackupTargetSetting, 'kind' | 'location' | 'password' | 'env' | 'keep'>): Promise<{ created: boolean }> {
    const vault = this.deps.vault()
    const session = await this.session(routeId)
    const checked = await session.call<{ ok: boolean; created?: boolean; error?: string }>('check', { vaultId: vault?.vaultId, target })
    if (!checked.ok) throw new Error(checked.error ?? 'The backup server cannot use this destination.')
    const id = toHex(randomBytes(8))
    this.settings.setBackupTarget(id, { ...target, id, server: routeId, addedAt: Date.now() })
    await this.refreshServer(routeId)
    return { created: checked.created === true }
  }

  async removeTarget(routeId: string, id: string): Promise<void> {
    this.settings.setBackupTarget(id, null)
    await this.refreshServer(routeId)
  }

  async setSchedule(routeId: string, everyHours: number): Promise<void> {
    this.settings.setBackupSchedule(routeId, { server: routeId, everyHours })
    await this.refreshServer(routeId)
  }

  /**
   * Tells the backup server the settings changed. It reads them from the sync
   * server, so they have to be there first: asked again for a few seconds
   * until it has them.
   */
  private async refreshServer(routeId: string): Promise<void> {
    const vault = this.deps.vault()
    const settings = this.deps.settings()
    const expected = (settings?.backupTargets(routeId) ?? []).map((target) => target.id).sort().join()
    const everyHours = settings?.backupSchedule(routeId)?.everyHours ?? 0
    try {
      const session = await this.session(routeId)
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const status = await session.call<BackupVaultStatus>('refresh', { vaultId: vault?.vaultId })
        this.views.set(routeId, { status, info: this.views.get(routeId)?.info ?? null, error: null })
        if ([...status.seen].sort().join() === expected && status.everyHours === everyHours) break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    } catch (error) {
      log.warn('telling the backup server about changed settings failed', error)
    }
    this.changed()
  }

  /** Starts a backup now; `acceptShrink` lets a held trusted copy follow a vault that lost most of its notes. */
  async runNow(routeId: string, acceptShrink = false): Promise<void> {
    const vault = this.deps.vault()
    const session = await this.session(routeId)
    const status = await session.call<BackupVaultStatus>('run', { vaultId: vault?.vaultId, acceptShrink })
    this.views.set(routeId, { status, info: this.views.get(routeId)?.info ?? null, error: null })
    this.changed()
  }

  /**
   * What deserves a notice: a backup server whose last run failed, whose
   * trusted copy waits, or whose last good backup is overdue - also when it
   * cannot be reached, since a backup server that is down is the case that
   * matters. Asks every backup server first.
   */
  async problems(now = Date.now()): Promise<string[]> {
    const found: string[] = []
    for (const server of this.servers()) {
      const view = await this.ask(server.routeId)
      if (!view) continue
      const every = view.everyHours > 0 ? view.everyHours : 72
      const lastGood = this.deps.lastGood()[server.routeId] ?? server.addedAt
      const overdue = now - lastGood > 2 * every * HOUR_MS
      const last = view.status?.runs[0]
      if (view.status && last && !last.ok) found.push(`${server.label}: the last backup failed - ${last.error ?? last.destinations.find((d) => !d.ok)?.error ?? 'see the settings'}`)
      else if (last?.trusted?.held) found.push(`${server.label}: the trusted copy waits - ${last.trusted.held}`)
      else if (overdue) {
        const since = new Date(lastGood).toLocaleString()
        found.push(view.error ? `${server.label} cannot be reached, and the last good backup is from ${since}` : `${server.label}: no good backup since ${since}`)
      }
    }
    return found
  }

  private forgetSession(routeId: string): void {
    const session = this.sessions.get(routeId)
    this.sessions.delete(routeId)
    void session?.then((open) => open.close()).catch(() => undefined)
  }

  closeSessions(): void {
    for (const routeId of Array.from(this.sessions.keys())) this.forgetSession(routeId)
  }
}
