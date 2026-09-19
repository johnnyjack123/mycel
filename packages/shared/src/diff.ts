// Text reconciliation for content that has no CRDT lineage: a file edited
// outside a live session, an existing vault being imported, a device whose
// local state was lost. Everything else merges through Yjs and never comes
// near this file.
//
// The guiding rule throughout: when in doubt, keep both sides. A duplicated
// paragraph is an annoyance the user can fix; a deleted one may be gone for
// good.

export interface TextEdit {
  /** Offset in the *source* text. */
  from: number
  /** Exclusive end offset in the source text. */
  to: number
  insert: string
}

export interface EditableText {
  delete(index: number, length: number): void
  insert(index: number, text: string): void
}

export interface MergeOptions {
  /** Wrap genuinely conflicting regions in `<<<<<<<` markers. */
  markers?: boolean
  localLabel?: string
  remoteLabel?: string
}

export interface MergeResult {
  text: string
  /** Regions both sides changed incompatibly. Zero means a clean merge. */
  conflicts: number
}

// A line-level LCS is O(n*m) in memory. Beyond this many cells we fall back to
// replacing the whole changed region, which is coarser but never wrong.
const MAX_LCS_CELLS = 1_000_000

/** Splits into lines, each keeping its trailing newline. */
export function splitLines(text: string): string[] {
  const lines: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      lines.push(text.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

function lineOffsets(lines: string[]): number[] {
  const offsets = new Array<number>(lines.length + 1)
  offsets[0] = 0
  for (let i = 0; i < lines.length; i += 1) {
    offsets[i + 1] = offsets[i] + (lines[i] as string).length
  }
  return offsets
}

interface Hunk {
  type: 'equal' | 'replace'
  aStart: number
  aEnd: number
  bStart: number
  bEnd: number
}

function lcsHunks(a: string[], b: string[]): Hunk[] {
  const n = a.length
  const m = b.length
  const dp = new Uint32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * (m + 1) + j] =
        a[i] === b[j]
          ? (dp[(i + 1) * (m + 1) + (j + 1)] as number) + 1
          : Math.max(dp[(i + 1) * (m + 1) + j] as number, dp[i * (m + 1) + (j + 1)] as number)
    }
  }

  const hunks: Hunk[] = []
  const push = (type: Hunk['type'], aEnd: number, bEnd: number, aStart: number, bStart: number): void => {
    if (aStart === aEnd && bStart === bEnd) return
    const last = hunks[hunks.length - 1]
    if (last && last.type === type) {
      last.aEnd = aEnd
      last.bEnd = bEnd
      return
    }
    hunks.push({ type, aStart, aEnd, bStart, bEnd })
  }

  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('equal', i + 1, j + 1, i, j)
      i += 1
      j += 1
    } else if ((dp[(i + 1) * (m + 1) + j] as number) >= (dp[i * (m + 1) + (j + 1)] as number)) {
      push('replace', i + 1, j, i, j)
      i += 1
    } else {
      push('replace', i, j + 1, i, j)
      j += 1
    }
  }
  if (i < n) push('replace', n, j, i, j)
  if (j < m) push('replace', i, m, i, j)
  return hunks
}

/** Line hunks with the common prefix and suffix peeled off first. */
function diffLines(a: string[], b: string[]): Hunk[] {
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const hunks: Hunk[] = []
  if (prefix > 0) hunks.push({ type: 'equal', aStart: 0, aEnd: prefix, bStart: 0, bEnd: prefix })

  const aMid = a.slice(prefix, a.length - suffix)
  const bMid = b.slice(prefix, b.length - suffix)
  if (aMid.length > 0 || bMid.length > 0) {
    if (aMid.length * bMid.length > MAX_LCS_CELLS) {
      hunks.push({
        type: 'replace',
        aStart: prefix,
        aEnd: prefix + aMid.length,
        bStart: prefix,
        bEnd: prefix + bMid.length
      })
    } else {
      for (const hunk of lcsHunks(aMid, bMid)) {
        hunks.push({
          type: hunk.type,
          aStart: hunk.aStart + prefix,
          aEnd: hunk.aEnd + prefix,
          bStart: hunk.bStart + prefix,
          bEnd: hunk.bEnd + prefix
        })
      }
    }
  }

  if (suffix > 0) {
    hunks.push({
      type: 'equal',
      aStart: a.length - suffix,
      aEnd: a.length,
      bStart: b.length - suffix,
      bEnd: b.length
    })
  }
  return hunks
}

export interface LineHunk {
  type: 'equal' | 'replace'
  aFrom: number
  aTo: number
  bFrom: number
  bTo: number
}

/**
 * Differing regions as whole-line spans, in character offsets and without the
 * sub-line trimming `textEdits` applies. Callers that must not split a line -
 * anything keeping both versions side by side - need this coarser view.
 */
export function lineDiff(from: string, to: string): LineHunk[] {
  const a = splitLines(from)
  const b = splitLines(to)
  const aOffsets = lineOffsets(a)
  const bOffsets = lineOffsets(b)
  return diffLines(a, b).map((hunk) => ({
    type: hunk.type,
    aFrom: aOffsets[hunk.aStart] as number,
    aTo: aOffsets[hunk.aEnd] as number,
    bFrom: bOffsets[hunk.bStart] as number,
    bTo: bOffsets[hunk.bEnd] as number
  }))
}

/**
 * Minimal edits turning `from` into `to`, in `from` coordinates, ascending and
 * non-overlapping. Deliberately fine-grained: every character left out of an
 * edit is a character the CRDT keeps, along with anyone else's concurrent
 * changes to it.
 */
export function textEdits(from: string, to: string): TextEdit[] {
  if (from === to) return []

  const a = splitLines(from)
  const b = splitLines(to)
  const aOffsets = lineOffsets(a)
  const bOffsets = lineOffsets(b)
  const edits: TextEdit[] = []

  for (const hunk of diffLines(a, b)) {
    if (hunk.type === 'equal') continue
    const start = aOffsets[hunk.aStart] as number
    const end = aOffsets[hunk.aEnd] as number
    const removed = from.slice(start, end)
    const inserted = to.slice(bOffsets[hunk.bStart] as number, bOffsets[hunk.bEnd] as number)

    // Shrink the hunk to the characters that actually differ.
    let prefix = 0
    while (prefix < removed.length && prefix < inserted.length && removed[prefix] === inserted[prefix]) {
      prefix += 1
    }
    let suffix = 0
    while (
      suffix < removed.length - prefix &&
      suffix < inserted.length - prefix &&
      removed[removed.length - 1 - suffix] === inserted[inserted.length - 1 - suffix]
    ) {
      suffix += 1
    }

    const edit: TextEdit = {
      from: start + prefix,
      to: end - suffix,
      insert: inserted.slice(prefix, inserted.length - suffix)
    }
    if (edit.to > edit.from || edit.insert.length > 0) edits.push(edit)
  }

  return edits
}

/** Applies edits back to front so earlier offsets stay valid. */
export function applyTextEdits(target: EditableText, edits: TextEdit[]): void {
  for (let i = edits.length - 1; i >= 0; i -= 1) {
    const edit = edits[i] as TextEdit
    if (edit.to > edit.from) target.delete(edit.from, edit.to - edit.from)
    if (edit.insert.length > 0) target.insert(edit.from, edit.insert)
  }
}

interface Change {
  start: number
  end: number
  lines: string[]
}

function changesAgainstBase(baseLines: string[], otherLines: string[]): Change[] {
  const changes: Change[] = []
  for (const hunk of diffLines(baseLines, otherLines)) {
    if (hunk.type === 'equal') continue
    changes.push({
      start: hunk.aStart,
      end: hunk.aEnd,
      lines: otherLines.slice(hunk.bStart, hunk.bEnd)
    })
  }
  return changes
}

function withNewline(text: string): string {
  if (text.length === 0 || text.endsWith('\n')) return text
  return `${text}\n`
}

/**
 * Merges two independent edits of the same base.
 *
 * A two-way diff cannot do this job: "present remotely, absent locally" is
 * ambiguous - either the other side added it or this side deleted it - and
 * guessing wrong deletes someone's work. The base resolves the ambiguity.
 * Regions both sides changed incompatibly keep both versions rather than
 * picking a winner.
 */
export function threeWayMerge(
  base: string,
  local: string,
  remote: string,
  options: MergeOptions = {}
): MergeResult {
  if (local === remote) return { text: local, conflicts: 0 }
  if (base === local) return { text: remote, conflicts: 0 }
  if (base === remote) return { text: local, conflicts: 0 }

  const baseLines = splitLines(base)
  const localChanges = changesAgainstBase(baseLines, splitLines(local))
  const remoteChanges = changesAgainstBase(baseLines, splitLines(remote))

  const out: string[] = []
  let position = 0
  let li = 0
  let ri = 0
  let conflicts = 0

  while (li < localChanges.length || ri < remoteChanges.length) {
    const l = localChanges[li]
    const r = remoteChanges[ri]

    if (l && (!r || l.end <= r.start)) {
      out.push(...baseLines.slice(position, l.start), ...l.lines)
      position = l.end
      li += 1
      continue
    }
    if (r && (!l || r.end <= l.start)) {
      out.push(...baseLines.slice(position, r.start), ...r.lines)
      position = r.end
      ri += 1
      continue
    }
    if (!l || !r) continue

    // Overlapping regions. Absorb everything that touches the region from
    // either side so the conflict is reported as one block.
    let start = Math.min(l.start, r.start)
    let end = Math.max(l.end, r.end)
    const localParts: string[] = []
    const remoteParts: string[] = []
    for (;;) {
      let grew = false
      while (li < localChanges.length && (localChanges[li] as Change).start <= end) {
        const change = localChanges[li] as Change
        start = Math.min(start, change.start)
        end = Math.max(end, change.end)
        localParts.push(...change.lines)
        li += 1
        grew = true
      }
      while (ri < remoteChanges.length && (remoteChanges[ri] as Change).start <= end) {
        const change = remoteChanges[ri] as Change
        start = Math.min(start, change.start)
        end = Math.max(end, change.end)
        remoteParts.push(...change.lines)
        ri += 1
        grew = true
      }
      if (!grew) break
    }

    out.push(...baseLines.slice(position, start))
    const localText = localParts.join('')
    const remoteText = remoteParts.join('')
    if (localText === remoteText) {
      out.push(localText)
    } else {
      conflicts += 1
      if (options.markers === false) {
        out.push(withNewline(localText), remoteText)
      } else {
        out.push(
          `<<<<<<< ${options.localLabel ?? 'local'}\n`,
          withNewline(localText),
          '=======\n',
          withNewline(remoteText),
          `>>>>>>> ${options.remoteLabel ?? 'remote'}\n`
        )
      }
    }
    position = end
  }

  out.push(...baseLines.slice(position))
  return { text: out.join(''), conflicts }
}
