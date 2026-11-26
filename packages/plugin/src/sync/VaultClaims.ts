// Which Obsidian vault on this computer syncs a vault of the server (0.9.29). The
// databases a device keeps for the sync are named by the server's vault id alone,
// and every Obsidian vault on a computer sees the same ones: two of them syncing
// the same vault of the server would share each other's copies of the notes, what
// waits to be sent and where each log stands, and disconnecting one, or a vault
// deleted on the server, would clear the other's. So one Obsidian vault holds a
// vault of the server per computer, by a claim where all of them see it; another
// one asks before it takes over.

/** Where the claims lie: storage every Obsidian vault on this computer shares (`window.localStorage`). */
export interface ClaimStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  readonly length: number
  key(index: number): string | null
}

/** An Obsidian vault on this computer. */
export interface ClaimHolder {
  /** Obsidian's id of the vault. */
  id: string
  /** Its name, to say which one. */
  name: string
  at: number
}

const PREFIX = 'mycel-claim:'

/** Where nothing is shared - no `localStorage` -, claims of this vault alone. */
export function memoryClaimStorage(): ClaimStorage {
  const items = new Map<string, string>()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value)
    },
    removeItem: (key) => {
      items.delete(key)
    },
    get length() {
      return items.size
    },
    key: (index) => Array.from(items.keys())[index] ?? null
  }
}

export function claimKey(vaultId: string): string {
  return `${PREFIX}${vaultId}`
}

export class VaultClaims {
  constructor(
    private readonly storage: ClaimStorage,
    private readonly self: { id: string; name: string }
  ) {}

  /** Who holds the vault of the server on this computer; null for nobody. */
  holder(vaultId: string): ClaimHolder | null {
    try {
      const value = JSON.parse(this.storage.getItem(claimKey(vaultId)) ?? 'null') as Partial<ClaimHolder> | null
      if (!value || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.at !== 'number') return null
      return { id: value.id, name: value.name, at: value.at }
    } catch {
      return null
    }
  }

  /** Whether this Obsidian vault holds it - or nobody does, so nothing of another's is touched. */
  mine(vaultId: string): boolean {
    const holder = this.holder(vaultId)
    return holder === null || holder.id === this.self.id
  }

  /** Takes it when free or this vault's already; otherwise says who holds it, and takes nothing. */
  claim(vaultId: string): ClaimHolder | null {
    const holder = this.holder(vaultId)
    if (holder && holder.id !== this.self.id) return holder
    this.take(vaultId)
    return null
  }

  /** Takes it over, asked: the other Obsidian vault stops syncing it the moment it hears. */
  take(vaultId: string): void {
    this.storage.setItem(claimKey(vaultId), JSON.stringify({ id: this.self.id, name: this.self.name, at: Date.now() } satisfies ClaimHolder))
  }

  /** Every vault of the server this Obsidian vault holds here - whose databases are its own to clear. */
  held(): string[] {
    const keys: string[] = []
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index)
      if (key?.startsWith(PREFIX)) keys.push(key)
    }
    return keys.map((key) => key.slice(PREFIX.length)).filter((vaultId) => this.holder(vaultId)?.id === this.self.id)
  }

  /** Lets go of it, if it is this vault's: disconnected, another Obsidian vault here may sync it unasked. */
  release(vaultId: string): void {
    if (this.holder(vaultId)?.id === this.self.id) this.storage.removeItem(claimKey(vaultId))
  }
}
