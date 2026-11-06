import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { finished } from 'node:stream/promises'
import type { Cache } from './cache.js'
import { chunksOf, hashOf } from './content.js'
import type { VaultKeys } from './keys.js'
import type { OutFile } from './layout.js'

// The trusted copy: the newest version of everything, decrypted, next to the
// repository - for when the restic password is lost. Brought level with each
// run instead of emptied and written again, so a run that breaks off leaves a
// whole copy. It touches only what it wrote itself.

const MANIFEST = '.mycel-backup.json'
/** The trash and the settings, in a folder Obsidian never lists - so no note of the vault can lie there. */
const EXTRA = '.mycel'

/**
 * Where a file of the backup lies in the copy: the vault's own notes and
 * files at the top, so the copy opens as a vault; what the backup keeps
 * beside the vault - its trash, its settings - in a hidden folder.
 */
export function copyPath(path: string, folder: string): string {
  if (path.startsWith(`${folder}/`)) return path.slice(folder.length + 1)
  if (path.startsWith(`${folder} (trash)/`)) return `${EXTRA}/trash/${path.slice(`${folder} (trash)/`.length)}`
  if (path === `${folder} settings.json`) return `${EXTRA}/settings.json`
  return `${EXTRA}/${path}`
}

interface Manifest {
  vaultId: string
  /** Path below the folder -> the content's SHA-256 and size, as written. */
  files: Record<string, { hash: string; size: number }>
}

export interface TrustedResult {
  written: number
  deleted: number
  kept: number
}

export class TrustedRefused extends Error {}

/** Inside the folder, or not at all: a path is never followed out of it. */
function inside(folder: string, path: string): string {
  const target = join(folder, ...path.split('/'))
  const rel = relative(folder, target)
  if (rel === '' || rel.startsWith('..') || rel.split(sep).includes('..')) throw new Error(`${path} would leave the trusted copy`)
  return target
}

async function readManifest(folder: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(join(folder, MANIFEST), 'utf8')) as Manifest
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Whose copy a folder holds: the vault's id, null for a folder that is empty
 * or not there, '' for one somebody else filled.
 */
export async function copyOf(where: string): Promise<string | null> {
  const folder = resolve(where)
  let present: string[]
  try {
    present = await readdir(folder)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (present.length === 0) return null
  const manifest = await readManifest(folder).catch(() => null)
  return manifest?.vaultId ?? ''
}

async function sizeOnDisk(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Removes folders the deletions left empty, up to the copy's own folder. */
async function pruneEmpty(folder: string, from: string): Promise<void> {
  let dir = dirname(from)
  while (dir.startsWith(folder) && dir !== folder) {
    try {
      if ((await readdir(dir)).length > 0) return
      await rmdir(dir)
    } catch {
      return
    }
    dir = dirname(dir)
  }
}

/**
 * Brings the folder level with the run's files, laid out by `copyPath` for
 * the vault's folder `vault`. `keep`: paths whose content this run could not
 * have, or only in part - what the copy has of them stays.
 */
export async function alignTrusted(
  where: string,
  vaultId: string,
  vault: string,
  backedUp: readonly OutFile[],
  incomplete: ReadonlySet<string>,
  cache: Cache,
  keys: VaultKeys
): Promise<TrustedResult> {
  const files = backedUp.map((file) => ({ ...file, path: copyPath(file.path, vault) }))
  const keep = new Set(Array.from(incomplete, (path) => copyPath(path, vault)))
  const folder = resolve(where)
  await mkdir(folder, { recursive: true })
  const manifest = await readManifest(folder)
  if (!manifest) {
    const present = (await readdir(folder)).filter((name) => name !== MANIFEST)
    if (present.length > 0) throw new TrustedRefused('the folder for the trusted copy is not empty, and not one this backup server wrote')
  } else if (manifest.vaultId !== vaultId) {
    throw new TrustedRefused('the folder for the trusted copy belongs to another vault')
  }
  const known = { ...(manifest?.files ?? {}) }
  const next: Manifest = { vaultId, files: {} }
  const result: TrustedResult = { written: 0, deleted: 0, kept: 0 }
  const save = async (manifest: Manifest): Promise<void> => {
    await writeFile(join(folder, `${MANIFEST}.tmp`), JSON.stringify(manifest))
    await rename(join(folder, `${MANIFEST}.tmp`), join(folder, MANIFEST))
  }

  // Deletions first: a file that went may stand where a folder has to go now.
  const wanted = new Set(files.map((file) => file.path))
  for (const [path, entry] of Object.entries(known)) {
    if (wanted.has(path)) continue
    if (keep.has(path)) {
      next.files[path] = entry
      result.kept += 1
      continue
    }
    const target = inside(folder, path)
    await unlink(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    await pruneEmpty(folder, target)
    delete known[path]
    result.deleted += 1
  }

  for (const file of files) {
    const target = inside(folder, file.path)
    const was = known[file.path]
    // Only part of it could be read this time: the whole one written before stays.
    if (was && keep.has(file.path)) {
      next.files[file.path] = was
      result.kept += 1
      continue
    }
    const hash = hashOf(file)
    if (was && was.hash === hash && (await sizeOnDisk(target)) === was.size) {
      next.files[file.path] = was
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.mycel.tmp`
    const out = createWriteStream(temp)
    let size = 0
    try {
      for await (const chunk of chunksOf(file, cache, keys)) {
        size += chunk.length
        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', () => resolve()))
      }
      out.end()
      await finished(out)
    } catch (error) {
      out.destroy()
      await unlink(temp).catch(() => undefined)
      throw error
    }
    await rename(temp, target)
    const seconds = file.mtime / 1000
    await utimes(target, seconds, seconds).catch(() => undefined)
    next.files[file.path] = { hash, size }
    result.written += 1
    // Written as it goes, with what it wrote before: a run breaking off
    // still knows every file of its own in the folder.
    if (result.written % 200 === 0) await save({ vaultId, files: { ...known, ...next.files } })
  }
  await save(next)
  return result
}
