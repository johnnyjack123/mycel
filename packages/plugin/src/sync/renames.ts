/** `path` with ` (label)` - from the second on ` (label n)` - before its extension. */
export function besides(path: string, label: string, n: number): string {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  const cut = dot > slash ? dot : path.length
  return `${path.slice(0, cut)} (${label}${n > 1 ? ` ${n}` : ''})${path.slice(cut)}`
}

/** `path` with ` n` before its extension: the n-th place next to one taken. */
export function numbered(path: string, n: number): string {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  const cut = dot > slash ? dot : path.length
  return `${path.slice(0, cut)} ${n}${path.slice(cut)}`
}

/** A rename another device made: which note or file, where it lies here, where the index has it. */
export interface PendingRename {
  id: string
  at: string
  to: string
}

export interface RenameMoves {
  /** Whether something lies at the path in the vault now. */
  taken(path: string): boolean
  /** Whether the index names something at the path: a name to wait at must be nobody's. */
  claimed(path: string): boolean
  /** Moves one where the index has it - or, `aside`, to a free name for a moment; false when it did not move. */
  move(id: string, to: string, aside: boolean): Promise<boolean>
  stopped(): boolean
}

/**
 * Renames other devices made, in rounds (invariant 27), for notes and files
 * alike: one whose new place another still holds waits for that one to move
 * on. Two that swapped names - by hand, or rolled back - would wait for each
 * other forever, and this device kept each under the other's name; so one of
 * them waits at a free name meanwhile (`... (moving).md`), which neither the
 * index, a rename event nor a scan may take for one of its own.
 */
export async function renameInRounds(pending: PendingRename[], moves: RenameMoves): Promise<void> {
  for (let round = 0; pending.length > 0 && round < pending.length * 3 + 3; round += 1) {
    if (moves.stopped()) return
    let moved = false
    for (const item of pending.slice()) {
      if (moves.taken(item.to)) continue
      await moves.move(item.id, item.to, false)
      pending.splice(pending.indexOf(item), 1)
      moved = true
    }
    if (moved) continue
    const blocked = pending.find((item) => pending.some((other) => other !== item && other.at === item.to))
    if (!blocked) return
    const occupant = pending.find((other) => other.at === blocked.to) as PendingRename
    let aside = besides(occupant.at, 'moving', 1)
    for (let n = 2; moves.taken(aside) || moves.claimed(aside); n += 1) aside = besides(occupant.at, 'moving', n)
    if (!(await moves.move(occupant.id, aside, true))) return
    occupant.at = aside
  }
}
