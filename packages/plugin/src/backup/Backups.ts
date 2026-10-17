import type {
  BackupConnected,
  BackupGrant,
  BackupScheduleSetting,
  BackupServerInfo,
  BackupServerSetting,
  BackupTargetSetting,
  BackupVaultStatus,
  KeepPolicy
} from '@obsidian-connect/shared'
import { backupRouteKeys, fromBase64, randomBytes, sha256, toHex, utf8 } from '@obsidian-connect/shared/crypto'
import { log } from '../log'
import type { AccountSettings } from '../sync/AccountSettings'
import { openInviteSession, openPairingSession, type BackupSession } from './BackupLink'

// This vault's backup servers, as the settings show them: connecting one with
// an invitation, where it puts the vault and how often, starting a run, what
// came of it. The settings - the pairing secrets among them - live in the
// account-wide settings document, so every device of the account reaches each
// backup server for this vault; the sessions are this device's own.

export interface BackupsDeps {
  serverUrl: () => string
  token: () => string | null
  settings: () => AccountSettings | null
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

/**
 * What a backup server says when it lost what it knew of the vault. One whose
 * operator disconnected the vault answers its route no more, which looks like
 * a backup server that is down.
 */
export const NO_LONGER_HAS_VAULT = /no longer has this vault/

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

  private get token(): string {
    const token = this.deps.token()
    if (!token) throw new Error('Sign in first.')
    return token
  }

  servers(): BackupServerSetting[] {
    return (this.deps.settings()?.backupServers() ?? []).filter((server) => typeof server.pairing === 'string').sort((a, b) => a.addedAt - b.addedAt)
  }

  private server(routeId: string): BackupServerSetting | undefined {
    return this.servers().find((server) => server.routeId === routeId)
  }

  view(routeId: string): BackupServerView | null {
    const setting = this.server(routeId)
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

  private remember(routeId: string, patch: Partial<{ status: BackupVaultStatus | null; info: BackupServerInfo | null; error: string | null }>): void {
    const known = this.views.get(routeId) ?? { status: null, info: null, error: null }
    this.views.set(routeId, { ...known, ...patch })
  }

  /** A session on the vault's pairing route; opened once and kept while it lasts. */
  private session(routeId: string): Promise<BackupSession> {
    const existing = this.sessions.get(routeId)
    if (existing) {
      return existing.then((session) => {
        if (session.open) return session
        this.sessions.delete(routeId)
        return this.session(routeId)
      })
    }
    const setting = this.server(routeId)
    if (!setting) return Promise.reject(new Error('That backup server is not connected to this vault.'))
    const opening = (async () => {
      const session = await openPairingSession(this.deps.serverUrl(), this.token, setting.pairing)
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
    try {
      const session = await this.session(routeId)
      const status = await session.call<BackupVaultStatus>('status')
      const info = this.views.get(routeId)?.info ?? (await session.call<BackupServerInfo>('info'))
      this.remember(routeId, { status, info, error: null })
      const good = status.runs.find((run) => run.ok)
      if (good) await this.noteGood(routeId, good.finishedAt)
    } catch (error) {
      this.remember(routeId, { status: null, error: error instanceof Error ? error.message : String(error) })
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
   * Connects this vault with an invitation from a backup server's operator: a
   * backup key for it, handed over inside the session, and the pairing secret
   * it answers with, kept in the settings every device of the account shares.
   */
  async connect(invitation: string, password: string, label: string): Promise<BackupServerSetting> {
    const session = await openInviteSession(this.deps.serverUrl(), this.token, invitation)
    try {
      const info = await session.call<BackupServerInfo>('info')
      const name = label.trim() || info.name
      const grant = await this.deps.makeGrant(password, name)
      let connected: BackupConnected
      try {
        connected = await session.call<BackupConnected>('connect', { grant })
      } catch (error) {
        // The key made for it reads the vault; it goes when the backup server did not take it.
        await this.deps.deleteKey(grant.keyId).catch(() => undefined)
        throw error
      }
      const routeId = (await backupRouteKeys(fromBase64(connected.pairing))).routeId
      const setting: BackupServerSetting = { routeId, pairing: connected.pairing, label: name, keyId: grant.keyId, addedAt: Date.now() }
      const settings = this.settings
      const previous = connected.replaced ? this.server(connected.replaced) : undefined
      settings.setBackupServer(routeId, setting)
      if (previous) {
        // The same vault connected again: its destinations and schedule carry on under the new pairing.
        for (const target of settings.backupTargets(previous.routeId)) settings.setBackupTarget(target.id, { ...target, server: routeId })
        const schedule = settings.backupSchedule(previous.routeId)
        if (schedule) settings.setBackupSchedule(routeId, { ...schedule, server: routeId })
        settings.setBackupSchedule(previous.routeId, null)
        settings.setBackupServer(previous.routeId, null)
        if (previous.keyId !== grant.keyId) await this.deps.deleteKey(previous.keyId).catch(() => undefined)
        this.forgetSession(previous.routeId)
      }
      if (!settings.backupSchedule(routeId)) {
        settings.setBackupSchedule(routeId, { server: routeId, everyHours: DEFAULT_EVERY_HOURS } satisfies BackupScheduleSetting)
      }
      this.remember(routeId, { status: null, info, error: null })
      if (previous) await this.refreshServer(routeId)
      this.changed()
      return setting
    } finally {
      session.close()
    }
  }

  /**
   * A new backup key over the vault's pairing - after a password change or a
   * recovery ended the one before. Needs the password, as making any backup
   * key does; the pairing itself stands.
   */
  async rekey(routeId: string, password: string): Promise<void> {
    const setting = this.server(routeId)
    if (!setting) throw new Error('That backup server is not connected to this vault.')
    const session = await this.session(routeId)
    const grant = await this.deps.makeGrant(password, setting.label)
    try {
      const status = await session.call<BackupVaultStatus>('rekey', { grant })
      this.remember(routeId, { status, error: null })
    } catch (error) {
      // The key made for it reads the vault; it goes when the backup server did not take it.
      await this.deps.deleteKey(grant.keyId).catch(() => undefined)
      throw error
    }
    this.settings.setBackupServer(routeId, { ...setting, keyId: grant.keyId })
    if (setting.keyId !== grant.keyId) await this.deps.deleteKey(setting.keyId).catch(() => undefined)
    this.changed()
  }

  /**
   * Hands every backup server of this vault a new key - after a password
   * change or a recovery ended the old ones. One that cannot be reached is
   * left; its view says so, and "Connect again…" asks for the password later.
   */
  async reconnectAll(password: string): Promise<number> {
    let done = 0
    for (const server of this.servers()) {
      try {
        await this.rekey(server.routeId, password)
        done += 1
      } catch (error) {
        log.warn(`handing ${server.label} a new backup key failed`, error)
        this.remember(server.routeId, { status: null, error: 'Its backup key ended with the password change; connect it again.' })
      }
    }
    this.changed()
    return done
  }

  /** Takes the vault off a backup server: its key goes, its settings go. Its repositories stay where they are. */
  async disconnect(routeId: string): Promise<void> {
    const setting = this.server(routeId)
    if (!setting) return
    try {
      const session = await this.session(routeId)
      await session.call('disconnect')
    } catch (error) {
      // Unreachable, or it let go of the vault already: without its key it reads nothing anyway.
      log.warn(`telling ${setting.label} to forget the vault failed`, error)
    }
    await this.forget(routeId)
  }

  /** Drops a backup server from the settings and its key from the sync server, without asking it. */
  async forget(routeId: string): Promise<void> {
    const setting = this.server(routeId)
    if (!setting) return
    await this.deps.deleteKey(setting.keyId).catch(() => undefined)
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
  async addTarget(routeId: string, target: Pick<BackupTargetSetting, 'kind' | 'location' | 'password' | 'env' | 'keep' | 'guard'>): Promise<{ created: boolean }> {
    const session = await this.session(routeId)
    const checked = await session.call<{ ok: boolean; created?: boolean; error?: string }>('check', { target })
    if (!checked.ok) throw new Error(checked.error ?? 'The backup server cannot use this destination.')
    const id = toHex(randomBytes(8))
    this.settings.setBackupTarget(id, { ...target, id, server: routeId, addedAt: Date.now() })
    await this.refreshServer(routeId)
    return { created: checked.created === true }
  }

  /**
   * Changes what can change of a destination: its retention, credentials,
   * guard. New credentials are checked by the backup server first, as a new
   * destination is.
   */
  async updateTarget(routeId: string, id: string, patch: Pick<BackupTargetSetting, 'keep' | 'env' | 'guard'>): Promise<void> {
    const current = this.settings.backupTargets(routeId).find((target) => target.id === id)
    if (!current) throw new Error('That destination is gone.')
    const next: BackupTargetSetting = { ...current }
    for (const key of ['keep', 'env', 'guard'] as const) {
      if (patch[key] === undefined) delete next[key]
      else (next as unknown as Record<string, unknown>)[key] = patch[key]
    }
    if (next.kind === 'restic' && JSON.stringify(next.env ?? {}) !== JSON.stringify(current.env ?? {})) {
      const session = await this.session(routeId)
      const checked = await session.call<{ ok: boolean; error?: string }>('check', { target: next })
      if (!checked.ok) throw new Error(checked.error ?? 'The backup server cannot use these credentials.')
    }
    this.settings.setBackupTarget(id, next)
    await this.refreshServer(routeId)
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
   * until what it read is what this device holds - a run started right after
   * a change would otherwise go by the settings before it.
   */
  private async refreshServer(routeId: string): Promise<void> {
    const settings = this.deps.settings()
    if (!settings) return
    const expected = toHex(await sha256(utf8(settings.backupSettingsText(routeId))))
    try {
      const session = await this.session(routeId)
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const status = await session.call<BackupVaultStatus>('refresh')
        this.remember(routeId, { status, error: null })
        if (status.settingsDigest === expected) break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    } catch (error) {
      log.warn('telling the backup server about changed settings failed', error)
    }
    this.changed()
  }

  /** Starts a backup now; `acceptShrink` lets a held trusted copy follow a vault that lost most of what it held. */
  async runNow(routeId: string, acceptShrink = false): Promise<BackupVaultStatus> {
    const session = await this.session(routeId)
    const status = await session.call<BackupVaultStatus>('run', { acceptShrink })
    this.remember(routeId, { status, error: null })
    this.changed()
    return status
  }

  /**
   * A backup made now, and waited for until it is checked - for a rollback,
   * which must not begin before every backup server holds what is about to
   * change. A run under way is let finish first: it may have read the vault
   * before the last changes. Never throws; says how it went.
   */
  async backUpFresh(routeId: string, options: { pollMs?: number; timeoutMs?: number } = {}): Promise<{ ok: boolean; error?: string }> {
    const pollMs = options.pollMs ?? 2_000
    const deadline = Date.now() + (options.timeoutMs ?? 60 * 60 * 1000)
    const wait = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, pollMs))
    try {
      const session = await this.session(routeId)
      let status = await session.call<BackupVaultStatus>('status')
      while (status.running) {
        if (Date.now() > deadline) return { ok: false, error: 'a backup under way did not finish' }
        await wait()
        status = await session.call<BackupVaultStatus>('status')
      }
      const before = status.runs[0]?.startedAt
      const count = status.runs.length
      await session.call<BackupVaultStatus>('run')
      for (;;) {
        if (Date.now() > deadline) return { ok: false, error: 'the backup did not finish in time' }
        await wait()
        status = await session.call<BackupVaultStatus>('status')
        this.remember(routeId, { status, error: null })
        const last = status.runs[0]
        // A new run: another first entry - not its time, which is the backup server's clock.
        if (!status.running && last && (last.startedAt !== before || status.runs.length !== count)) {
          this.changed()
          if (last.ok) return { ok: true }
          return { ok: false, error: last.error ?? last.destinations.find((destination) => !destination.ok)?.error ?? 'the backup failed' }
        }
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
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
      if (view.error && NO_LONGER_HAS_VAULT.test(view.error)) {
        found.push(`${server.label} no longer has this vault; connect it again with a new invitation`)
      } else if (view.status && last && !last.ok) {
        found.push(`${server.label}: the last backup failed - ${last.error ?? last.destinations.find((d) => !d.ok)?.error ?? 'see the settings'}`)
      } else if (last?.trusted?.held) {
        found.push(`${server.label}: the trusted copy waits - ${last.trusted.held}`)
      } else if (overdue) {
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
