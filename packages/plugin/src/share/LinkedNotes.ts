import { getLinkpath, type MetadataCache, type TFile } from 'obsidian'
import type { DocStore } from '../sync/DocStore.js'

// The notes a note links to, and the notes those link to, for sharing them
// along with it - once, when the share is made. Each lands on the other side
// below the share folder at the path of the link that led to it, so the links
// between them resolve there as well: `[[Projects/Plan]]` becomes
// `Shared/Projects/Plan.md`.

export interface LinkedNote {
  path: string
  /** Where it lands below the other side's share folder, without `.md`. */
  title: string
  /** Null when it cannot be shared; `reason` says why. */
  docId: string | null
  reason?: string
}

/** A link's path as a place below a folder: no `./`, `../` or leading `/`, no `.md`. */
export function landingTitle(linkpath: string): string {
  return linkpath
    .replace(/\.md$/i, '')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/')
}

function decoded(linkpath: string): string {
  try {
    return decodeURI(linkpath)
  } catch {
    // Not URL-encoded after all.
    return linkpath
  }
}

/** Every note `root` reaches through links, root excluded, in the order they were found. */
export function linkedNotes(
  metadataCache: MetadataCache,
  store: DocStore,
  root: TFile,
  nameOf: (account: string) => string
): LinkedNote[] {
  return reached(metadataCache, store, [root], nameOf, () => false)
}

/**
 * Every note outside a folder that its notes reach through links. A note
 * inside goes along with the folder anyway, and its links are followed as
 * the roots' are.
 */
export function linkedOutside(
  metadataCache: MetadataCache,
  store: DocStore,
  notes: TFile[],
  folder: string,
  nameOf: (account: string) => string
): LinkedNote[] {
  const prefix = `${folder}/`
  return reached(metadataCache, store, notes, nameOf, (path) => path.startsWith(prefix))
}

function reached(
  metadataCache: MetadataCache,
  store: DocStore,
  roots: TFile[],
  nameOf: (account: string) => string,
  inside: (path: string) => boolean
): LinkedNote[] {
  const found: LinkedNote[] = []
  const seen = new Set(roots.map((root) => root.path))
  const queue: TFile[] = [...roots]
  for (let note = queue.shift(); note; note = queue.shift()) {
    const cache = metadataCache.getFileCache(note)
    for (const link of [...(cache?.links ?? []), ...(cache?.embeds ?? []), ...(cache?.frontmatterLinks ?? [])]) {
      const linkpath = decoded(getLinkpath(link.link))
      if (!linkpath) continue
      const target = metadataCache.getFirstLinkpathDest(linkpath, note.path)
      if (!target || target.extension !== 'md' || seen.has(target.path) || inside(target.path)) continue
      seen.add(target.path)
      const linked = describe(store, target, landingTitle(linkpath) || target.basename, nameOf)
      found.push(linked)
      // Only through notes that go along: the links of the others lead
      // nowhere on the other side.
      if (linked.docId) queue.push(target)
    }
  }
  return found
}

function describe(store: DocStore, file: TFile, title: string, nameOf: (account: string) => string): LinkedNote {
  const cannot = (reason: string): LinkedNote => ({ path: file.path, title, docId: null, reason })
  if (store.isExcluded(file.path)) return cannot('excluded from sync')
  const docId = store.docIdForPath(file.path)
  const entry = docId ? store.entry(docId) : undefined
  if (!docId || !entry || entry.deletedAt) return cannot('not synced yet')
  if (entry.owner) return cannot(`${nameOf(entry.owner)}'s note; only they can share it`)
  return { path: file.path, title, docId }
}
