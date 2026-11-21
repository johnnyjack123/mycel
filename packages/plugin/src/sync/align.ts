import { listDiff, splitLines } from '@mycel/shared'

// "Compare versions" shows both versions whole, line beside line (the user, 2026-11-21):
// what both have on the same rows, and where they differ, lines that resemble each other
// side by side and a gap opposite a line only one side has. This only lays the two out -
// nothing here decides what the note says.

/** A row of the window: a line of each version by its index, or null for a gap. */
export interface Row {
  mine: number | null
  theirs: number | null
  /** The two lines resemble each other - one is the other, changed - so what changed is marked. */
  paired: boolean
}

/** Lines of each version, [from, to); for a passage only one side has, the other's range is empty, at its place. */
export interface Span {
  mineFrom: number
  mineTo: number
  theirsFrom: number
  theirsTo: number
}

/** Lines both versions have, row for row. */
export interface SameRun extends Span {
  same: true
}

/** A passage that differs: its lines on each side, and how they stand beside each other. */
export interface Passage extends Span {
  same: false
  rows: Row[]
}

export type Run = SameRun | Passage

export interface Aligned {
  /** Each version's lines, every one with its line break where it has one. */
  mine: string[]
  theirs: string[]
  runs: Run[]
}

/** Lines whose text without the break is alike resemble each other completely; a pair is drawn from this on. */
const PAIR_AT = 0.5
/** Beyond this many pairs of lines to weigh, a passage is laid out without pairing - coarser, never wrong. */
const MAX_PAIR_CELLS = 250_000
/** Words to compare within one line before simply marking the whole line. */
const MAX_WORDS = 2_000
const EPSILON = 1e-9

/**
 * A line as compared: without its break. A last line that has none is the same line as one
 * that does - otherwise a line added below the last one made the last line differ too.
 */
export function lineText(line: string): string {
  return line.endsWith('\r\n') ? line.slice(0, -2) : line.endsWith('\n') ? line.slice(0, -1) : line
}

export function alignVersions(mine: string, theirs: string): Aligned {
  const mineLines = splitLines(mine)
  const theirsLines = splitLines(theirs)
  const mineTexts = mineLines.map(lineText)
  const theirsTexts = theirsLines.map(lineText)
  const runs: Run[] = []
  for (const hunk of listDiff(theirsTexts, mineTexts)) {
    if (hunk.type === 'equal') {
      runs.push({ same: true, mineFrom: hunk.bStart, mineTo: hunk.bEnd, theirsFrom: hunk.aStart, theirsTo: hunk.aEnd })
    } else {
      runs.push(...passages(mineTexts, theirsTexts, { mineFrom: hunk.bStart, mineTo: hunk.bEnd, theirsFrom: hunk.aStart, theirsTo: hunk.aEnd }))
    }
  }
  return { mine: mineLines, theirs: theirsLines, runs }
}

/**
 * One differing region split where it can be: lines that resemble each other are paired,
 * what lies between two pairs stands side by side, top-aligned. A stretch only one side has
 * is a passage of its own - taken from that side or left out -, while stretches both sides
 * have run together into one.
 */
function passages(mineTexts: string[], theirsTexts: string[], span: Span): Passage[] {
  const pairs = pairLines(mineTexts.slice(span.mineFrom, span.mineTo), theirsTexts.slice(span.theirsFrom, span.theirsTo))
  const units: Passage[] = []
  let mine = span.mineFrom
  let theirs = span.theirsFrom
  const between = (mineEnd: number, theirsEnd: number): void => {
    const mineCount = mineEnd - mine
    const theirsCount = theirsEnd - theirs
    if (mineCount === 0 && theirsCount === 0) return
    const rows: Row[] = []
    for (let k = 0; k < Math.max(mineCount, theirsCount); k += 1) {
      rows.push({ mine: k < mineCount ? mine + k : null, theirs: k < theirsCount ? theirs + k : null, paired: false })
    }
    units.push({ same: false, mineFrom: mine, mineTo: mineEnd, theirsFrom: theirs, theirsTo: theirsEnd, rows })
    mine = mineEnd
    theirs = theirsEnd
  }
  for (const [mineAt, theirsAt] of pairs) {
    between(span.mineFrom + mineAt, span.theirsFrom + theirsAt)
    units.push({ same: false, mineFrom: mine, mineTo: mine + 1, theirsFrom: theirs, theirsTo: theirs + 1, rows: [{ mine, theirs, paired: true }] })
    mine += 1
    theirs += 1
  }
  between(span.mineTo, span.theirsTo)

  const runs: Passage[] = []
  const twoSided = (unit: Passage): boolean => unit.mineTo > unit.mineFrom && unit.theirsTo > unit.theirsFrom
  for (const unit of units) {
    const last = runs[runs.length - 1]
    if (last && twoSided(last) && twoSided(unit)) {
      last.mineTo = unit.mineTo
      last.theirsTo = unit.theirsTo
      last.rows.push(...unit.rows)
    } else {
      runs.push(unit)
    }
  }
  return runs
}

interface Grams {
  text: string
  counts: Map<string, number>
  size: number
}

function grams(line: string): Grams {
  const text = line.trim().toLowerCase()
  const counts = new Map<string, number>()
  for (let at = 0; at + 1 < text.length; at += 1) {
    const gram = text.slice(at, at + 2)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return { text, counts, size: Math.max(0, text.length - 1) }
}

/**
 * How much two lines resemble each other, 0 to 1: the share of letter pairs they have in
 * common - or, for a line that went into a longer one ("Zeile 2" and "Zeile 2 und mehr"),
 * how much of the shorter one is in the longer.
 */
export function resemblance(a: string, b: string): number {
  return resemblanceOf(grams(a), grams(b))
}

function resemblanceOf(a: Grams, b: Grams): number {
  if (a.text === b.text) return 1
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.counts.size <= b.counts.size ? [a, b] : [b, a]
  let shared = 0
  for (const [gram, count] of small.counts) shared += Math.min(count, large.counts.get(gram) ?? 0)
  const dice = (2 * shared) / (a.size + b.size)
  const shorter = Math.min(a.size, b.size)
  const contained = shorter >= 4 ? (shared / shorter) * 0.75 : 0
  return Math.max(dice, contained)
}

/** The pairs, in order on both sides, that resemble each other most in all. */
function pairLines(mine: string[], theirs: string[]): Array<[number, number]> {
  const n = mine.length
  const m = theirs.length
  if (n === 0 || m === 0 || n * m > MAX_PAIR_CELLS) return []
  const mineGrams = mine.map(grams)
  const theirsGrams = theirs.map(grams)
  const alike = new Float64Array(n * m)
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) alike[i * m + j] = resemblanceOf(mineGrams[i] as Grams, theirsGrams[j] as Grams)
  }
  const width = m + 1
  const best = new Float64Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const score = alike[i * m + j] as number
      const pair = score >= PAIR_AT ? score + (best[(i + 1) * width + j + 1] as number) : -1
      best[i * width + j] = Math.max(pair, best[(i + 1) * width + j] as number, best[i * width + j + 1] as number)
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const score = alike[i * m + j] as number
    if (score >= PAIR_AT && score + (best[(i + 1) * width + j + 1] as number) >= (best[i * width + j] as number) - EPSILON) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if ((best[(i + 1) * width + j] as number) >= (best[i * width + j + 1] as number)) {
      i += 1
    } else {
      j += 1
    }
  }
  return pairs
}

const WORD = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu

/** What differs between two lines that resemble each other: character ranges [from, to) on each side, by whole words. */
export function lineChanges(mine: string, theirs: string): { mine: Array<[number, number]>; theirs: Array<[number, number]> } {
  const mineWords = mine.match(WORD) ?? []
  const theirsWords = theirs.match(WORD) ?? []
  if (mineWords.length > MAX_WORDS || theirsWords.length > MAX_WORDS) {
    return { mine: mine.length > 0 ? [[0, mine.length]] : [], theirs: theirs.length > 0 ? [[0, theirs.length]] : [] }
  }
  const offsets = (words: string[]): number[] => {
    const at = [0]
    for (const word of words) at.push((at[at.length - 1] as number) + word.length)
    return at
  }
  const mineAt = offsets(mineWords)
  const theirsAt = offsets(theirsWords)
  const changes = { mine: [] as Array<[number, number]>, theirs: [] as Array<[number, number]> }
  for (const hunk of listDiff(theirsWords, mineWords)) {
    if (hunk.type === 'equal') continue
    if (hunk.bEnd > hunk.bStart) changes.mine.push([mineAt[hunk.bStart] as number, mineAt[hunk.bEnd] as number])
    if (hunk.aEnd > hunk.aStart) changes.theirs.push([theirsAt[hunk.aStart] as number, theirsAt[hunk.aEnd] as number])
  }
  return changes
}
