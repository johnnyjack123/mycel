import * as Y from 'yjs'
import { SETTINGS_FIELD } from '@obsidian-connect/shared'

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

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : null
}

function wholeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

export class AccountSettings {
  readonly doc = new Y.Doc()
  private readonly map: Y.Map<unknown>
  private readonly listeners = new Set<(settings: SharedSettings) => void>()

  constructor() {
    this.map = this.doc.getMap<unknown>(SETTINGS_FIELD)
    this.map.observe(() => {
      const current = this.get()
      for (const listener of this.listeners) listener(current)
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

  onChange(listener: (settings: SharedSettings) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  destroy(): void {
    this.listeners.clear()
    this.doc.destroy()
  }
}
