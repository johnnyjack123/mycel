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
 * A step on the plugin's folder, tried again for a few seconds while the system holds what it
 * touches: removing the Time Machine's copies failed on Windows with EPERM a moment after they
 * were read, and with it leaving the past (0.9.27). Anything else fails at once.
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
