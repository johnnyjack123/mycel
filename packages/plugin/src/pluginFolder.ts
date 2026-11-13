import type { DataAdapter } from 'obsidian'

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
