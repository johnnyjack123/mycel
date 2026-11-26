import type { DataAdapter } from 'obsidian'
import { PastFiles } from '../history/PastFiles.js'
import { emptyFolder } from '../pluginFolder.js'
import type { CarriedTexts } from '../SyncSession.js'
import { StateStore } from './StateStore.js'

// *Disconnect this vault* (0.9.30): everything this device kept for syncing goes - the databases of
// each vault of the server this Obsidian vault holds here, what it agreed on and how it met the
// vault, the notes to compare that lay on this device alone, the Time Machine's leftovers and,
// unless kept, the safety copies. Never a file of the vault, nothing on the server. Signing out,
// the keys in Obsidian's storage, the claims, the log, the notices and the settings are the
// plugin's (`main.ts`), around this; signed in again, the device meets the vault as a new one
// (invariant 34).

/** The copies made to undo with: before joining and merging (`BackupStore`), before a rollback (`Rollback`). */
export const SAFETY_COPIES = ['backups', 'rollbacks'] as const

/** Notes to compare too large for the account's settings (`ReviewStore`). */
const LOCAL_REVIEWS = 'reviews'

export interface ForgetHost {
  /** The plugin's folder, behind the gate. */
  readonly adapter: DataAdapter
  readonly root: string
  readonly carried: CarriedTexts
  /** Every database this device keeps for a vault of the server deleted, and waited for. */
  clearLocal(vaultId: string): Promise<void>
}

/**
 * What this device knows of syncing, forgotten - only while no session runs. Each step can run
 * again: an interrupted disconnect is carried on at the next start, from the top.
 */
export async function forgetDevice(host: ForgetHost, vaultIds: readonly string[], options: { keepCopies: boolean }): Promise<void> {
  for (const vaultId of vaultIds) {
    host.carried.take(vaultId)
    await host.clearLocal(vaultId)
  }
  await StateStore.forget(host.adapter, host.root)
  await removeFolder(host.adapter, `${host.root}/${LOCAL_REVIEWS}`)
  if (!options.keepCopies) for (const dir of SAFETY_COPIES) await removeFolder(host.adapter, `${host.root}/${dir}`)
  // Never while a journal says the past may still lie in the files: those copies are what puts them back.
  await PastFiles.clearLeftovers(host.adapter, host.root)
}

/** How much the safety copies hold, for the window to say what keeping them means. */
export async function safetyCopiesSize(adapter: Pick<DataAdapter, 'exists' | 'list' | 'stat'>, root: string): Promise<{ files: number; bytes: number }> {
  const total = { files: 0, bytes: 0 }
  const walk = async (dir: string): Promise<void> => {
    const listed = await adapter.list(dir)
    for (const file of listed.files) {
      total.files += 1
      total.bytes += (await adapter.stat(file))?.size ?? 0
    }
    for (const folder of listed.folders) await walk(folder)
  }
  for (const dir of SAFETY_COPIES) {
    const path = `${root}/${dir}`
    if (await adapter.exists(path)) await walk(path)
  }
  return total
}

/** Its files at least: a folder a cloud client made read-only stays, empty (`emptyFolder`). */
async function removeFolder(adapter: DataAdapter, dir: string): Promise<void> {
  if (!(await adapter.exists(dir))) return
  const emptied = await emptyFolder(adapter, dir, true)
  if (emptied.failed > 0) throw new Error(`${emptied.failed} file(s) in ${dir} could not be removed`, { cause: emptied.error })
}
