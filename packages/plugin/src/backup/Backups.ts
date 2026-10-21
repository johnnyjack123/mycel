import {
  scheduleHours,
  type BackupAt,
  type BackupConnected,
  type BackupDataEvent,
  type BackupGrant,
  type BackupListedEntry,
  type BackupRunStatus,
  type BackupSnapshotRef,
  type BackupServerInfo,
  type BackupServerSetting,
  type BackupTaskSetting,
  type BackupVaultStatus,
  type KeepPolicy
} from '@obsidian-connect/shared'
import { backupRouteKeys, fromBase64, randomBytes, sha256, toHex, utf8 } from '@obsidian-connect/shared/crypto'
import { log } from '../log'
import type { AccountSettings } from '../sync/AccountSettings'
import { openInviteSession, openPairingSession, type BackupSession } from './BackupLink'

// This vault's backup server, as the settings show it: connecting one with an
// invitation, its backup task - where the repository lies, how long and how
// often, a decrypted copy or not -, starting a run, what came of it. A vault
// has one backup server; connecting another replaces it. The settings - the
// pairing secret among them - live in the account-wide settings document, so
// every device of the account reaches the backup server for this vault; the
// sessions are this device's own. A list all the same: two devices
// connecting two backup servers at once leave both, until one is let go.

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
  /** Null until it is set up: the backup server backs up nothing before. */
  task: BackupTaskSetting | null
  /** Null while it was not asked yet, or could not be reached. */
  status: BackupVaultStatus | null
  info: BackupServerInfo | null
  /** Why it could not be asked. */
  error: string | null
}

/** This device's time zone; a schedule at a time of day goes by it. */
export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** When a vault is backed up unless told otherwise: every night at three, this device's night. */
export function defaultSchedule(): { everyHours: number; at: BackupAt } {
  return { everyHours: 24, at: { minutes: 3 * 60, zone: deviceZone() } }
}
// Reading a backup back means restic going through a whole snapshot.
const READ_TIMEOUT_MS = 30 * 60 * 1000
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
  /** Backup servers letting a held copy follow just now: nothing asks about it meanwhile. */
  private readonly followingCopy = new Set<string>()
  private readonly dismissed = new Set<string>()

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
      task: this.deps.settings()?.backupTask(routeId) ?? null,
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
   * A vault has one backup server: another one is let go once this one took
   * the vault. The same one connected again keeps its task.
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
        // The same vault connected again: its task carries on under the new pairing.
        const task = settings.backupTask(previous.routeId)
        if (task) settings.setBackupTask(routeId, { ...task, server: routeId })
        settings.setBackupTask(previous.routeId, null)
        settings.setBackupServer(previous.routeId, null)
        if (previous.keyId !== grant.keyId) await this.deps.deleteKey(previous.keyId).catch(() => undefined)
        this.forgetSession(previous.routeId)
      }
      for (const other of this.servers()) {
        if (other.routeId !== routeId) await this.disconnect(other.routeId)
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

  /** Takes the vault off a backup server: its key goes, its settings go. Its repository and copy stay where they are. */
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
    settings.setBackupTask(routeId, null)
    settings.setBackupServer(routeId, null)
    this.forgetSession(routeId)
    this.views.delete(routeId)
    this.changed()
  }

  /** What the backup server says of a task before it is saved. */
  private async check(routeId: string, task: BackupTaskSetting): Promise<{ created: boolean }> {
    const session = await this.session(routeId)
    const checked = await session.call<{ ok: boolean; created?: boolean; error?: string }>('check', { task })
    if (!checked.ok) throw new Error(checked.error ?? 'The backup server cannot carry this out.')
    return { created: checked.created === true }
  }

  /**
   * Sets the vault's backup task up, once the backup server checked it: its
   * folders, the repository opening with the password - made where there is
   * none yet. Without a schedule given, every night at three.
   */
  async setTask(routeId: string, task: Omit<BackupTaskSetting, 'server' | 'createdAt' | 'everyHours'> & { everyHours?: number }): Promise<{ created: boolean }> {
    const given = task.everyHours !== undefined || task.at !== undefined
    const schedule = given ? { everyHours: task.everyHours ?? 0, ...(task.at ? { at: task.at } : {}) } : defaultSchedule()
    const full: BackupTaskSetting = { ...task, ...schedule, server: routeId, createdAt: Date.now() }
    const checked = await this.check(routeId, full)
    this.settings.setBackupTask(routeId, full)
    await this.refreshServer(routeId)
    return checked
  }

  /**
   * Changes what can change of the task: how long and how often, the
   * credentials, the decrypted copy and its guard. The repository's place and
   * password stay - another repository is another task. Checked by the backup
   * server first when the credentials change or the copy is turned on. A key
   * given as undefined is cleared.
   */
  async updateTask(routeId: string, patch: Partial<Pick<BackupTaskSetting, 'keep' | 'env' | 'decrypted' | 'guard' | 'everyHours' | 'at'>>): Promise<void> {
    const current = this.settings.backupTask(routeId)
    if (!current) throw new Error('This vault has no backup task any more.')
    const next: BackupTaskSetting = { ...current }
    for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
      if (patch[key] === undefined) delete next[key]
      else (next as unknown as Record<string, unknown>)[key] = patch[key]
    }
    if (JSON.stringify(next.env ?? {}) !== JSON.stringify(current.env ?? {}) || (next.decrypted && !current.decrypted)) await this.check(routeId, next)
    this.settings.setBackupTask(routeId, next)
    await this.refreshServer(routeId)
  }

  /** No more backups. The repository and the decrypted copy stay where they are. */
  async removeTask(routeId: string): Promise<void> {
    this.settings.setBackupTask(routeId, null)
    await this.refreshServer(routeId)
  }

  /** Every so many hours (0: only by hand), or - with `at` - at a time of day. */
  async setSchedule(routeId: string, everyHours: number, at?: BackupAt): Promise<void> {
    await this.updateTask(routeId, { everyHours, at })
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
  async backUpFresh(routeId: string, options: { pollMs?: number; timeoutMs?: number; keepAll?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
    const outcome = await this.runAndWait(routeId, { keepAll: options.keepAll === true }, options)
    return outcome.ok ? { ok: true } : { ok: false, error: outcome.error }
  }

  /**
   * Starts a run and waits until it is done: a run under way first - asked to
   * run then, the backup server would merely hand back the one under way, with
   * the options it started with -, then this one. Never throws.
   */
  private async runAndWait(
    routeId: string,
    params: { keepAll?: boolean; acceptShrink?: boolean },
    options: { pollMs?: number; timeoutMs?: number } = {}
  ): Promise<{ ok: boolean; error?: string; run?: BackupRunStatus }> {
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
      await session.call<BackupVaultStatus>('run', params)
      for (;;) {
        if (Date.now() > deadline) return { ok: false, error: 'the backup did not finish in time' }
        await wait()
        status = await session.call<BackupVaultStatus>('status')
        this.remember(routeId, { status, error: null })
        const last = status.runs[0]
        // A new run: another first entry - not its time, which is the backup server's clock.
        if (!status.running && last && (last.startedAt !== before || status.runs.length !== count)) {
          this.changed()
          if (last.ok) return { ok: true, run: last }
          return { ok: false, run: last, error: last.error ?? last.destinations.find((destination) => !destination.ok)?.error ?? last.trusted?.error ?? 'the backup failed' }
        }
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // --- a decrypted copy the guard holds -------------------------------------------------------

  /** That backup server's newest run, when it left the decrypted copy waiting - not while the copy is being let follow. */
  heldCopy(routeId: string): { run: BackupRunStatus; key: string } | null {
    if (this.followingCopy.has(routeId)) return null
    const run = this.views.get(routeId)?.status?.runs[0]
    const held = run?.trusted?.held
    return run && held ? { run, key: `${routeId}\n${held}` } : null
  }

  /** Asked about it already, and told "not now": not again until it waits for another reason, or the plugin starts again. */
  dismissHold(key: string): void {
    this.dismissed.add(key)
  }

  holdDismissed(key: string): boolean {
    return this.dismissed.has(key)
  }

  following(routeId: string): boolean {
    return this.followingCopy.has(routeId)
  }

  /**
   * Lets a held decrypted copy follow the vault: a run that takes what
   * vanished, waited for until it is checked - whoever asked hears how it
   * went, not merely that it started.
   */
  async followCopy(routeId: string): Promise<{ ok: boolean; error?: string; run?: BackupRunStatus }> {
    this.followingCopy.add(routeId)
    this.changed()
    try {
      return await this.runAndWait(routeId, { acceptShrink: true }, { pollMs: 1_500 })
    } finally {
      this.followingCopy.delete(routeId)
      await this.ask(routeId)
    }
  }

  // --- reading a backup back, for a rollback further than the history reaches ---------

  /** The newest backup of this vault on that backup server at or before `at`; null for none. */
  async backupAt(routeId: string, at: number): Promise<BackupSnapshotRef | null> {
    const session = await this.session(routeId)
    return session.call<BackupSnapshotRef | null>('backupAt', { at }, READ_TIMEOUT_MS)
  }

  /** Every note and file that backup holds, by path, with its SHA-256. */
  async backupListing(routeId: string, ref: BackupSnapshotRef): Promise<BackupListedEntry[]> {
    const session = await this.session(routeId)
    return session.call<BackupListedEntry[]>('backupList', { ref }, READ_TIMEOUT_MS)
  }

  /**
   * The content of these paths of that backup, each handed to `take` once it
   * is whole. Resolves once all of them came, or the backup server said it
   * found no more.
   */
  async backupRead(routeId: string, ref: BackupSnapshotRef, paths: string[], take: (path: string, data: Uint8Array) => Promise<void>): Promise<number> {
    const session = await this.session(routeId)
    const rid = toHex(randomBytes(8))
    const pieces = new Map<string, Uint8Array[]>()
    let taking: Promise<void> = Promise.resolve()
    const stop = session.onEvent((event) => {
      if (event.ev !== 'backup-data') return
      const data = event.p as BackupDataEvent
      if (data.rid !== rid) return
      const parts = pieces.get(data.path) ?? []
      if (data.data) parts.push(fromBase64(data.data))
      pieces.set(data.path, parts)
      if (!data.last) return
      pieces.delete(data.path)
      const whole = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
      let offset = 0
      for (const part of parts) {
        whole.set(part, offset)
        offset += part.length
      }
      taking = taking.then(() => take(data.path, whole))
    })
    try {
      const answer = await session.call<{ found: number }>('backupRead', { ref, paths, rid }, READ_TIMEOUT_MS)
      await taking
      return answer.found
    } finally {
      stop()
    }
  }

  /**
   * What deserves a notice: a backup server whose last run failed, whose
   * decrypted copy waits, or whose last good backup is overdue - also when it
   * cannot be reached, since a backup server that is down is the case that
   * matters, and when it was never given a task. Asks every backup server
   * first.
   */
  async problems(now = Date.now()): Promise<string[]> {
    const found: string[] = []
    for (const server of this.servers()) {
      const view = await this.ask(server.routeId)
      if (!view) continue
      const every = (view.task ? scheduleHours(view.task) : 0) || 72
      const lastGood = this.deps.lastGood()[server.routeId] ?? server.addedAt
      const overdue = now - lastGood > 2 * every * HOUR_MS
      const last = view.status?.runs[0]
      if (view.error && NO_LONGER_HAS_VAULT.test(view.error)) {
        found.push(`${server.label} no longer has this vault; connect it again with a new invitation`)
      } else if (!view.task && overdue) {
        found.push(`${server.label} backs up nothing: set up the backup in the settings`)
      } else if (view.status && last && !last.ok) {
        found.push(`${server.label}: the last backup failed - ${last.error ?? last.destinations.find((d) => !d.ok)?.error ?? 'see the settings'}`)
      } else if (last?.trusted?.held) {
        found.push(`${server.label}: the decrypted copy waits - ${last.trusted.held}`)
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
