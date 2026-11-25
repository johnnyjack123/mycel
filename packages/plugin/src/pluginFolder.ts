import type { DataAdapter } from 'obsidian'

/** What Windows answers while something else - a virus scanner, the search index - still holds a file or folder. */
const HELD = /^(EPERM|EBUSY|EACCES|ENOTEMPTY)$/
const HELD_RETRY_MS = [100, 300, 700, 1_500]

function heldCode(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string') return HELD.test(code)
  return error instanceof Error && /^(EPERM|EBUSY|EACCES|ENOTEMPTY)\b/.test(error.message)
}

/**
 * A step on a file of the plugin's folder, tried again for a few seconds while the system holds
 * it - a virus scanner reading what was just written. Anything else fails at once. Never for a
 * folder: what refused there was a read-only folder, which no waiting changes (0.9.28).
 */
export async function untilFree<T>(step: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await step()
    } catch (error) {
      const wait = HELD_RETRY_MS[attempt]
      if (wait === undefined || !heldCode(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
}

/** What emptying a folder of the plugin's left behind. */
export interface Emptied {
  /** Files removed. */
  removed: number
  /** Files that would not go, and the first reason. */
  failed: number
  error: unknown
  /** A folder refused to go - its system refuses them all, so the caller asks no more of them. */
  refused: boolean
}

/**
 * Removes every file below `dir`, then - with `folders` - the folders as far as the system lets
 * them, the deepest first, and never relies on that: a folder can be impossible to remove. Google
 * Drive for desktop set the read-only attribute on every folder of a vault it synced, Windows then
 * refused to remove one (EPERM), and Obsidian took about eleven seconds per try to say so; files it left
 * alone. Removing the Time Machine's folder whole held up the start of the sync, and opening and
 * leaving the Time Machine, for a minute each (0.9.28). Once one folder refuses, no other is asked.
 */
export async function emptyFolder(adapter: Pick<DataAdapter, 'list' | 'remove' | 'rmdir'>, dir: string, folders: boolean): Promise<Emptied> {
  const emptied: Emptied = { removed: 0, failed: 0, error: null, refused: false }
  const walked: string[] = []
  const walk = async (folder: string): Promise<void> => {
    const listed = await adapter.list(folder)
    for (const file of listed.files) {
      try {
        await adapter.remove(file)
        emptied.removed += 1
      } catch (error) {
        emptied.failed += 1
        emptied.error ??= error
      }
    }
    for (const inner of listed.folders) await walk(inner)
    walked.push(folder)
  }
  await walk(dir)
  if (!folders || emptied.failed > 0) return emptied
  for (const folder of walked) {
    try {
      await adapter.rmdir(folder, false)
    } catch {
      emptied.refused = true
      break
    }
  }
  return emptied
}

/**
 * Makes `dir` inside the plugin's folder `root`, each missing folder from there down, and
 * never asks about anything above `root`: that is Obsidian's configuration, behind the gate
 * (`guard.ts`). Walking the folders from the top of the vault asked about `.obsidian`, was
 * refused, and so every copy before joining, before a rollback and of what was written over the
 * Time Machine's past failed on a device (0.9.20). `made` spares asking again during one copy.
 */
export async function makePluginFolder(
  adapter: Pick<DataAdapter, 'exists' | 'mkdir'>,
  root: string,
  dir: string,
  made?: Set<string>
): Promise<void> {
  if (dir !== root && !dir.startsWith(`${root}/`)) throw new Error(`${JSON.stringify(dir)} is not in the plugin's folder`)
  let path = root
  for (const part of dir.slice(root.length + 1).split('/')) {
    if (part === '') continue
    path = `${path}/${part}`
    if (made?.has(path)) continue
    if (!(await adapter.exists(path))) {
      try {
        await adapter.mkdir(path)
      } catch (error) {
        // Losing the race against a parallel create is harmless; anything else is not.
        if (!(await adapter.exists(path))) throw error
      }
    }
    made?.add(path)
  }
}
