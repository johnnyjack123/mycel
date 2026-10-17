import * as Y from 'yjs'
import {
  BACKUP_SCHEDULE_KEY,
  BACKUP_SERVER_KEY,
  BACKUP_TARGET_KEY,
  SETTINGS_FIELD,
  backupSettingsText,
  type BackupScheduleSetting,
  type BackupServerSetting,
  type BackupTargetSetting
} from '@obsidian-connect/shared'

// Settings that must be the same on every device of an account travel in a
// document of their own, next to the vault index. History retention above
// all: compaction is client-driven, so a device with a shorter setting would
// silently prune for all the others. Per-device settings stay in data.json.

export interface SharedSettings {
  excludeGlobs: string[]
  conflictMarkers: boolean
  historyRetentionDays: number
  backupRetentionDays: number
  /** Where notes other people share with this account land. Only a default. */
  sharedFolder: string
}

export const DEFAULT_SHARED_SETTINGS: SharedSettings = {
  excludeGlobs: [],
  conflictMarkers: true,
  historyRetentionDays: 30,
  backupRetentionDays: 14,
  sharedFolder: 'Shared'
}

/** How the user answered the last time a server turned out to have other data than a device. */
export interface RecoveryDecision {
  /** `device`: what the devices had is right. `server`: the server was restored on purpose. */
  choice: 'device' | 'server'
  at: number
}

const RECOVERY_KEY = 'recovery'

/** Someone this account shares with. Their key is pinned when the contact is made. */
export interface Contact {
  accountId: string
  /** The name they gave; empty until their device answered. */
  name: string
  /** What this account calls them, if it renamed them. */
  localName?: string
  publicKey: string
  addedAt: number
}

/** A code this account handed out; its secret opens the redemption. */
export interface ContactCode {
  secret: string
  createdAt: number
  expiresAt: number
  usedBy?: string
  /**
   * Deleted before anyone redeemed it. Kept, like a used code, so a
   * redemption the server let through anyway is still refused.
   */
  revokedAt?: number
}

/** A code this account redeemed, waiting for the other side to answer with its name. */
export interface PendingContact {
  secret: string
  owner: string
  publicKey: string
  requestedAt: number
}

// One key per entry, so two devices adding different contacts at once do not
// overwrite each other the way one shared object would.
const CONTACT = 'contact:'
const CODE = 'code:'
const PENDING = 'pending:'

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : null
}

function wholeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

export class AccountSettings {
  readonly doc = new Y.Doc()
  private readonly map: Y.Map<unknown>
  private readonly listeners = new Set<(settings: SharedSettings, remote: boolean) => void>()

  constructor() {
    this.map = this.doc.getMap<unknown>(SETTINGS_FIELD)
    this.map.observe((event) => {
      const current = this.get()
      const remote = event.transaction.origin !== 'local'
      for (const listener of this.listeners) listener(current, remote)
    })
  }

  /** Whether any device ever stored a setting. */
  get empty(): boolean {
    return this.map.size === 0
  }

  get(): SharedSettings {
    const defaults = DEFAULT_SHARED_SETTINGS
    const folder = this.map.get('sharedFolder')
    return {
      excludeGlobs: stringList(this.map.get('excludeGlobs')) ?? defaults.excludeGlobs,
      conflictMarkers:
        typeof this.map.get('conflictMarkers') === 'boolean'
          ? (this.map.get('conflictMarkers') as boolean)
          : defaults.conflictMarkers,
      historyRetentionDays: wholeNumber(this.map.get('historyRetentionDays')) ?? defaults.historyRetentionDays,
      backupRetentionDays: wholeNumber(this.map.get('backupRetentionDays')) ?? defaults.backupRetentionDays,
      sharedFolder: typeof folder === 'string' ? folder : defaults.sharedFolder
    }
  }

  set(patch: Partial<SharedSettings>): void {
    this.doc.transact(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) this.map.set(key, value)
      }
    }, 'local')
  }

  /**
   * Kept in this document because it is encrypted like everything else: a
   * server that could fake "the user chose the server" could make every
   * device roll back.
   */
  recoveryDecision(): RecoveryDecision | null {
    const value = this.map.get(RECOVERY_KEY) as Partial<RecoveryDecision> | undefined
    if (!value || (value.choice !== 'device' && value.choice !== 'server') || typeof value.at !== 'number') return null
    return { choice: value.choice, at: value.at }
  }

  decideRecovery(decision: RecoveryDecision): void {
    this.doc.transact(() => this.map.set(RECOVERY_KEY, decision), 'local')
  }

  /** What a backup server reads for its route, as it writes it down too. */
  backupSettingsText(routeId: string): string {
    return backupSettingsText(this.map.entries(), routeId)
  }

  private entries<T>(prefix: string): T[] {
    const found: T[] = []
    this.map.forEach((value, key) => {
      if (key.startsWith(prefix) && value && typeof value === 'object') found.push(value as T)
    })
    return found
  }

  private put(key: string, value: unknown): void {
    this.doc.transact(() => {
      if (value === null) this.map.delete(key)
      else this.map.set(key, value)
    }, 'local')
  }

  contacts(): Contact[] {
    return this.entries<Contact>(CONTACT)
  }

  contact(accountId: string): Contact | null {
    return (this.map.get(`${CONTACT}${accountId}`) as Contact | undefined) ?? null
  }

  setContact(accountId: string, contact: Contact | null): void {
    this.put(`${CONTACT}${accountId}`, contact)
  }

  codes(): Array<{ codeId: string; code: ContactCode }> {
    const found: Array<{ codeId: string; code: ContactCode }> = []
    this.map.forEach((value, key) => {
      if (key.startsWith(CODE) && value && typeof value === 'object') found.push({ codeId: key.slice(CODE.length), code: value as ContactCode })
    })
    return found
  }

  code(codeId: string): ContactCode | null {
    return (this.map.get(`${CODE}${codeId}`) as ContactCode | undefined) ?? null
  }

  setCode(codeId: string, code: ContactCode | null): void {
    this.put(`${CODE}${codeId}`, code)
  }

  pending(codeId: string): PendingContact | null {
    return (this.map.get(`${PENDING}${codeId}`) as PendingContact | undefined) ?? null
  }

  setPending(codeId: string, pending: PendingContact | null): void {
    this.put(`${PENDING}${codeId}`, pending)
  }

  // The vault's backups: which backup servers, where each puts the vault,
  // how often. The backup server reads these with its backup key.

  backupServers(): BackupServerSetting[] {
    return this.entries<BackupServerSetting>(BACKUP_SERVER_KEY)
  }

  setBackupServer(routeId: string, server: BackupServerSetting | null): void {
    this.put(`${BACKUP_SERVER_KEY}${routeId}`, server)
  }

  backupTargets(routeId?: string): BackupTargetSetting[] {
    return this.entries<BackupTargetSetting>(BACKUP_TARGET_KEY).filter((target) => routeId === undefined || target.server === routeId)
  }

  setBackupTarget(id: string, target: BackupTargetSetting | null): void {
    this.put(`${BACKUP_TARGET_KEY}${id}`, target)
  }

  backupSchedule(routeId: string): BackupScheduleSetting | null {
    return (this.map.get(`${BACKUP_SCHEDULE_KEY}${routeId}`) as BackupScheduleSetting | undefined) ?? null
  }

  setBackupSchedule(routeId: string, schedule: BackupScheduleSetting | null): void {
    this.put(`${BACKUP_SCHEDULE_KEY}${routeId}`, schedule)
  }

  /** `remote`: the change came from another device - or from this device's copy as it loaded. */
  onChange(listener: (settings: SharedSettings, remote: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  destroy(): void {
    this.listeners.clear()
    this.doc.destroy()
  }
}
