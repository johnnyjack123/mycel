/**
 * What a vault does with a file it shares with others - a shared note's or a
 * shared folder's - when the list names a version of it: the one decision
 * `SharedFiles` and `FolderFiles` both make (invariant 24). Another version is
 * taken only if it knew this vault's; anything else keeps both.
 *
 * - `agree`: the list names what this vault has.
 * - `wait`: this vault's own newer version is on its way into the list - put
 *   there by another of its devices, whose base arrived before the list did.
 * - `adopt`: unchanged here, and the list's version replaced exactly this one.
 * - `publish`: changed here, and the list still names the version it changed
 *   from: this vault's goes out (`prev` = that version) - from someone who may write.
 * - `keep-both`: both changed, or the list moved past this version without
 *   knowing it: this vault's is kept aside, the list's taken.
 * - `unrelated`: no base, and the list's version replaced something else -
 *   a file of this vault's own that only shares the name, or one whose base
 *   was lost. A shared note's file then comes in next to it; elsewhere it is
 *   `keep-both`.
 */
export type VersionStep =
  | { step: 'agree' }
  | { step: 'wait' }
  | { step: 'adopt' }
  | { step: 'publish'; prev: string }
  | { step: 'keep-both' }
  | { step: 'unrelated' }

/** `base`: what file and list last agreed on here, and the list's version this vault replaced if it put one in. */
export function versionStep(here: string, base: { hash: string; prev?: string } | undefined, listed: { hash: string; prev?: string }): VersionStep {
  if (here === listed.hash) return { step: 'agree' }
  if (base?.prev !== undefined && listed.hash === base.prev && here === base.hash) return { step: 'wait' }
  // No base - a crash before it was written -, yet the list's version
  // replaced exactly what this vault has: that is as good as one.
  const known = base?.hash ?? (listed.prev === here ? here : undefined)
  if (known === undefined) return { step: 'unrelated' }
  if (here === known) return listed.prev === known ? { step: 'adopt' } : { step: 'keep-both' }
  if (listed.hash === known) return { step: 'publish', prev: known }
  return { step: 'keep-both' }
}
