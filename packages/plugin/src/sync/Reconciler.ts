import { lineDiff, threeWayMerge, type TextEdit } from '@obsidian-connect/shared'

// Deciding what happens when a file and its document disagree. Kept pure and
// free of Obsidian so it can be reasoned about and tested on its own: this is
// the only code path in the plugin that is able to delete someone's text.

export interface ReconcileInput {
  /** The text this device last saw both sides agree on, if it still knows. */
  base: string | null
  /** The file as it is on disk right now. */
  local: string
  /** The shared document. */
  remote: string
  /**
   * The document has never carried anything, here or anywhere: no change was
   * ever applied to it. Empty text alone does not say that - a note emptied
   * on purpose is empty too.
   */
  pristine: boolean
  markers: boolean
}

export type ReconcileOutcome =
  /** Both sides already say the same thing. */
  | { kind: 'agree' }
  /** Nothing changed locally; the document is simply newer. */
  | { kind: 'adopt-remote' }
  /** The document has never carried anything; the file fills it. */
  | { kind: 'seed' }
  /** The document changed, the file did not. */
  | { kind: 'adopt-local' }
  | {
      kind: 'merge'
      text: string
      conflicts: number
      /**
       * True when no base was available. The merge then only adds text and
       * never removes any, because without a base "missing here" and "added
       * there" are indistinguishable.
       */
      additiveOnly: boolean
    }

/**
 * Local-only text inserted into the document without removing anything.
 * The fallback when this device has no record of what the two sides last
 * agreed on - it can duplicate, but it cannot delete.
 */
export function additiveEdits(remote: string, local: string): TextEdit[] {
  const edits: TextEdit[] = []
  // Whole lines, not the minimal character edit: turning a replacement into an
  // insertion at character granularity splices the two versions into the same
  // line ("localremote only") instead of keeping both.
  for (const hunk of lineDiff(remote, local)) {
    if (hunk.type === 'equal') continue
    const inserted = local.slice(hunk.bFrom, hunk.bTo)
    if (inserted.length === 0) continue
    const needsBreak = hunk.aTo > 0 && remote[hunk.aTo - 1] !== '\n'
    edits.push({
      from: hunk.aTo,
      to: hunk.aTo,
      insert: needsBreak ? `\n${inserted}` : inserted
    })
  }
  return edits
}

function applyEditsToText(source: string, edits: TextEdit[]): string {
  let result = source
  for (let i = edits.length - 1; i >= 0; i -= 1) {
    const edit = edits[i] as TextEdit
    result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to)
  }
  return result
}

export function reconcile(input: ReconcileInput): ReconcileOutcome {
  const { base, local, remote } = input

  if (local === remote) return { kind: 'agree' }

  // A document that never carried anything is the one moment where taking the
  // file wholesale is correct. One that is merely empty was emptied: with a
  // base the file follows, without one the text is added back, since then
  // "emptied there" and "written here" cannot be told apart.
  if (remote.length === 0 && input.pristine) return { kind: 'seed' }

  if (base !== null) {
    if (base === local) return { kind: 'adopt-remote' }
    if (base === remote) return { kind: 'adopt-local' }
    const merged = threeWayMerge(base, local, remote, { markers: input.markers })
    return { kind: 'merge', text: merged.text, conflicts: merged.conflicts, additiveOnly: false }
  }

  const edits = additiveEdits(remote, local)
  if (edits.length === 0) return { kind: 'adopt-remote' }
  return {
    kind: 'merge',
    text: applyEditsToText(remote, edits),
    conflicts: 0,
    additiveOnly: true
  }
}
