// What a path from somewhere else may name. A shared folder's document, a
// shared note's list of files, a sealed title: all of it is written by other
// people - and by the server, if it lies - and every one of those paths ends
// up in `vault.create`, `vault.rename` or an adapter write on this device. A
// path that climbed out of the folder it was meant for (`../`), named the
// vault's configuration (`.obsidian/plugins/…/main.js` runs on the next start)
// or left the vault altogether would make whoever wrote it the author of any
// file here. So nothing that is not a plain path inside the vault is written,
// whatever wrote it.

const MAX_PATH = 4096

/** Control characters, by code: written as characters they are invisible in the source. */
function hasControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * Why `path` is no file or folder a vault may hold, or null when it is one:
 * relative, separated by `/` only, no segment empty, `.` or `..`, none hidden
 * (Obsidian lists no file or folder whose name starts with a dot - the
 * configuration folder, the trash, a git repository), none that Windows reads
 * as one of those after dropping trailing dots and spaces, no control
 * characters, no drive letter.
 */
export function vaultPathProblem(path: unknown): string | null {
  if (typeof path !== 'string' || path.length === 0) return 'no path'
  if (path.length > MAX_PATH) return 'too long'
  if (hasControl(path)) return 'a control character'
  if (path.includes('\\')) return 'a backslash'
  if (path.startsWith('/')) return 'an absolute path'
  if (/^[A-Za-z]:/.test(path)) return 'a drive'
  for (const segment of path.split('/')) {
    if (segment === '') return 'an empty segment'
    if (segment.startsWith('.')) return segment === '.' || segment === '..' ? 'a climb out of its folder' : 'a hidden file or folder'
    // Windows drops trailing dots and spaces: `.. ` is `..` there.
    const core = segment.replace(/[. ]+$/, '')
    if (core.trim() === '' || core.startsWith('.')) return 'a climb out of its folder'
  }
  return null
}

export function isVaultPath(path: unknown): path is string {
  return vaultPathProblem(path) === null
}

/** A note's path: a vault path ending in `.md`. */
export function isNotePath(path: unknown): path is string {
  return isVaultPath(path) && path.toLowerCase().endsWith('.md')
}

/** A file's path - an attachment, anything but a note. */
export function isFilePath(path: unknown): path is string {
  return isVaultPath(path) && !path.toLowerCase().endsWith('.md')
}

/**
 * Whether `path` lies inside `folder` (itself a vault path, or '' for the
 * vault) - by its segments, not by its letters: `Shared/X` is not inside `Shared/XY`.
 */
export function isInside(path: string, folder: string): boolean {
  if (!isVaultPath(path)) return false
  return folder === '' || path.startsWith(`${folder}/`)
}
