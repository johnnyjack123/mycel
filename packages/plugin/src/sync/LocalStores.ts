// The databases a device keeps for a vault of the server, in Obsidian's IndexedDB:
// `mycel/<vaultId>/...` - each note, the index, the settings, a shared folder - and
// `mycel-history/<vaultId>`. Named by the server's vault id alone, they are the same
// for every Obsidian vault on this computer (`VaultClaims`).

const BLOCKED_MS = 20_000

function ofVault(name: string, vaultId: string): boolean {
  return name.startsWith(`mycel/${vaultId}/`) || name === `mycel-history/${vaultId}`
}

/**
 * Deletes every one of them and waits until each is gone; how many there were. Only
 * once nothing holds them open: one still open would hold its deletion up, and that
 * fails after a while rather than hanging.
 */
export async function deleteLocalStores(vaultId: string): Promise<number> {
  const factory = window.indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> }
  if (typeof factory.databases !== 'function') throw new Error('this device cannot list its databases')
  const names = (await factory.databases()).map(({ name }) => name).filter((name): name is string => typeof name === 'string' && ofVault(name, vaultId))
  await Promise.all(
    names.map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const request = factory.deleteDatabase(name)
          const timer = window.setTimeout(() => reject(new Error(`the database ${name} is still open`)), BLOCKED_MS)
          request.onsuccess = () => {
            window.clearTimeout(timer)
            resolve()
          }
          request.onerror = () => {
            window.clearTimeout(timer)
            reject(request.error ?? new Error(`deleting the database ${name} failed`))
          }
        })
    )
  )
  return names.length
}
