import type { DataAdapter } from 'obsidian'
import { lineDiff } from '@mycel/shared'
import { alignVersions, type Aligned, type Passage } from './align.js'
import { log } from '../log.js'

// A note that differed on two devices with nothing to tell which side changed
// what - typically the first time two existing vaults meet - is merged by
// keeping everything, so no word is lost. That leaves both versions of every
// line that differed. A review shows the two side by side and lets the user
// take one, the other, or both, per passage.
//
// Kept on this device, in the plugin folder next to the backups: it holds the
// two texts as they were.

/** Which version of one differing passage to keep. */
export type Choice = 'mine' | 'theirs' | 'both'

/** A passage of the note: the same on both sides, or not. */
export interface Hunk {
  same: boolean
  /** This device's lines. */
  mine: string
  /** The other version's lines. */
  theirs: string
}

/** The two versions in whole lines, in order. */
export function compare(mine: string, theirs: string): Hunk[] {
  return lineDiff(theirs, mine).map((hunk) => ({
    same: hunk.type === 'equal',
    theirs: theirs.slice(hunk.aFrom, hunk.aTo),
    mine: mine.slice(hunk.bFrom, hunk.bTo)
  }))
}

/** Both passages, the other version's first - the order the merge kept them in. */
function both(theirs: string, mine: string): string {
  if (theirs.length === 0 || mine.length === 0) return theirs + mine
  return theirs.endsWith('\n') ? theirs + mine : `${theirs}\n${mine}`
}

/** The note the choices make, one per differing passage; a missing one keeps both. */
export function assemble(hunks: Hunk[], choices: Choice[]): string {
  let text = ''
  let next = 0
  for (const hunk of hunks) {
    if (hunk.same) {
      text += hunk.mine
      continue
    }
    const choice = choices[next] ?? 'both'
    next += 1
    text += choice === 'mine' ? hunk.mine : choice === 'theirs' ? hunk.theirs : both(hunk.theirs, hunk.mine)
  }
  return text
}

/** One side of a differing passage. */
export type Side = 'mine' | 'theirs'

/** Parts of a note one after another, a line break put between two where the first lacks one. */
export function joinParts(parts: string[]): string {
  let text = ''
  for (const part of parts) {
    if (part.length === 0) continue
    if (text.length > 0 && !text.endsWith('\n')) text += '\n'
    text += part
  }
  return text
}

/** What a passage's place in the result took: a side's lines there, or one line of a side. */
export interface Picked {
  side: Side
  /** The line's index in that version; null for every line the side has in the passage. */
  line: number | null
}

/** A differing passage's place in the result: what was taken into it, in order, or written there by hand. */
export interface Slot {
  picks: Picked[]
  text: string
  /** Written into by hand: taking more adds to that text instead of building it anew. */
  edited: boolean
}

/**
 * The note being put together in "Compare versions", as git's merge tools do (the user,
 * 2026-11-18): what both versions have stands as it is, and each passage that differs
 * starts empty - this device's lines, the other's, both in the order taken, single lines of
 * either, or text of one's own go into it, one passage at a time. The passages are as fine
 * as the two versions allow (`alignVersions`, 2026-11-21): a stretch only one side has is
 * one of its own.
 */
export class MergeDraft {
  readonly aligned: Aligned
  /** The passages that differ, in order; one slot each. */
  readonly passages: Passage[]
  readonly slots: Slot[]

  constructor(mine: string, theirs: string) {
    this.aligned = alignVersions(mine, theirs)
    this.passages = this.aligned.runs.filter((run): run is Passage => !run.same)
    this.slots = this.passages.map(() => ({ picks: [], text: '', edited: false }))
  }

  passage(index: number): Passage {
    return this.passages[index] as Passage
  }

  lines(side: Side): string[] {
    return side === 'mine' ? this.aligned.mine : this.aligned.theirs
  }

  /** Every line a side has in the passage, as it stands there. */
  sideText(index: number, side: Side): string {
    const passage = this.passage(index)
    return side === 'mine'
      ? this.aligned.mine.slice(passage.mineFrom, passage.mineTo).join('')
      : this.aligned.theirs.slice(passage.theirsFrom, passage.theirsTo).join('')
  }

  private holds(index: number, side: Side, line: number): boolean {
    const passage = this.passage(index)
    return side === 'mine' ? line >= passage.mineFrom && line < passage.mineTo : line >= passage.theirsFrom && line < passage.theirsTo
  }

  private pickText(index: number, pick: Picked): string {
    return pick.line === null ? this.sideText(index, pick.side) : (this.lines(pick.side)[pick.line] ?? '')
  }

  private rebuild(index: number): void {
    const slot = this.slots[index]
    if (slot && !slot.edited) slot.text = joinParts(slot.picks.map((pick) => this.pickText(index, pick)))
  }

  /** Takes picks out; from text written by hand only where each still stands as taken. */
  private drop(index: number, gone: Picked[]): void {
    const slot = this.slots[index]
    if (!slot || gone.length === 0) return
    slot.picks = slot.picks.filter((pick) => !gone.includes(pick))
    if (!slot.edited) return this.rebuild(index)
    for (const pick of gone) {
      const text = this.pickText(index, pick)
      const at = text.length > 0 ? slot.text.indexOf(text) : -1
      if (at >= 0) slot.text = slot.text.slice(0, at) + slot.text.slice(at + text.length)
    }
  }

  private add(index: number, pick: Picked): void {
    const slot = this.slots[index]
    if (!slot) return
    slot.picks.push(pick)
    if (slot.edited) slot.text = joinParts([slot.text, this.pickText(index, pick)])
    else this.rebuild(index)
  }

  /** Whether every line of a side is in the passage's place. */
  taken(index: number, side: Side): boolean {
    return this.slots[index]?.picks.some((pick) => pick.side === side && pick.line === null) ?? false
  }

  /** Whether a line of a side is in the passage's place, alone or with its side. */
  picked(index: number, side: Side, line: number): boolean {
    return this.taken(index, side) || (this.slots[index]?.picks.some((pick) => pick.side === side && pick.line === line) ?? false)
  }

  /** Every line of a side, after what is there; single lines of that side taken before go into it. */
  take(index: number, side: Side): void {
    const slot = this.slots[index]
    if (!slot || this.taken(index, side)) return
    this.drop(index, slot.picks.filter((pick) => pick.side === side))
    this.add(index, { side, line: null })
  }

  /** Takes a side out again, its single lines too. */
  remove(index: number, side: Side): void {
    const slot = this.slots[index]
    if (slot) this.drop(index, slot.picks.filter((pick) => pick.side === side))
  }

  /** One line of a side, after what is there - or out again. Nothing while the whole side is taken. */
  toggleLine(index: number, side: Side, line: number): void {
    const slot = this.slots[index]
    if (!slot || this.taken(index, side) || !this.holds(index, side, line)) return
    const there = slot.picks.find((pick) => pick.side === side && pick.line === line)
    if (there) this.drop(index, [there])
    else this.add(index, { side, line })
  }

  edit(index: number, text: string): void {
    const slot = this.slots[index]
    if (!slot) return
    slot.text = text
    slot.edited = true
  }

  clear(index: number): void {
    const slot = this.slots[index]
    if (!slot) return
    slot.picks = []
    slot.text = ''
    slot.edited = false
  }

  /** Every passage from one side alone. */
  takeAll(side: Side): void {
    this.slots.forEach((_slot, index) => {
      this.clear(index)
      this.take(index, side)
    })
  }

  /** Something was taken into it or written there - nothing taken from an empty side counts too. */
  decided(index: number): boolean {
    const slot = this.slots[index]
    return slot !== undefined && (slot.picks.length > 0 || slot.edited)
  }

  /** Passages nothing was decided for yet. */
  get open(): number {
    return this.slots.filter((_slot, index) => !this.decided(index)).length
  }

  /**
   * The note as put together: a passage nothing was decided for is left out. What both have
   * is this device's lines - the two differ there at most in the break after the last line.
   */
  result(): string {
    let next = 0
    return joinParts(
      this.aligned.runs.map((run) => (run.same ? this.aligned.mine.slice(run.mineFrom, run.mineTo).join('') : (this.slots[next++]?.text ?? '')))
    )
  }
}

/** How the two versions came to be merged. */
export type ReviewKind = 'no-base' | 'conflict'

export interface Review {
  id: string
  docId: string
  path: string
  at: number
  kind: ReviewKind
  /** This device's version when they met. */
  mine: string
  /** The version the other devices had. */
  theirs: string
  /** What the merge made of them - the note's text right after. */
  merged: string
}

const DIR = 'reviews'
// Joining an older copy of a vault merges every note that differs at once, and each is
// marked in the explorer until looked at: a hundred left the rest unmarked (0.9.22).
const MAX_REVIEWS = 2000

export class ReviewStore {
  private reviews: Review[] | null = null
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly adapter: Pick<DataAdapter, 'exists' | 'mkdir' | 'write' | 'read' | 'list' | 'remove'>,
    private readonly root: string
  ) {}

  private dir(): string {
    return `${this.root}/${DIR}`
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }

  async list(): Promise<Review[]> {
    if (this.reviews) return this.reviews
    const found: Review[] = []
    try {
      if (await this.adapter.exists(this.dir())) {
        for (const path of (await this.adapter.list(this.dir())).files) {
          if (!path.endsWith('.json')) continue
          try {
            found.push(JSON.parse(await this.adapter.read(path)) as Review)
          } catch (error) {
            log.warn(`the review ${path} could not be read`, error)
          }
        }
      }
    } catch (error) {
      log.warn('listing the reviews failed', error)
    }
    this.reviews = found.sort((a, b) => b.at - a.at)
    this.changed()
    return this.reviews
  }

  /** Whether a note waits for a review - cheap, for menus; false until the list was read once. */
  pendingFor(docId: string): Review | undefined {
    return this.reviews?.find((review) => review.docId === docId)
  }

  /** Every note waiting for a review, as far as the list was read: for the explorer's marks. */
  pending(): Review[] {
    return this.reviews ?? []
  }

  /**
   * One review per note: a later merge of the same note is what the user now
   * sees, so it takes the earlier one's place - keeping the earlier "mine",
   * which is this device's own text from before either merge.
   */
  async add(review: Omit<Review, 'id'>): Promise<Review> {
    const reviews = await this.list()
    const earlier = reviews.find((candidate) => candidate.docId === review.docId)
    const next: Review = { ...review, id: earlier?.id ?? `${review.at.toString(36)}-${review.docId.slice(0, 8)}`, mine: earlier?.mine ?? review.mine }
    if (!(await this.adapter.exists(this.dir()))) await this.adapter.mkdir(this.dir())
    await this.adapter.write(`${this.dir()}/${next.id}.json`, JSON.stringify(next))
    this.reviews = [next, ...reviews.filter((candidate) => candidate.id !== next.id)].slice(0, MAX_REVIEWS)
    this.changed()
    return next
  }

  async remove(id: string): Promise<void> {
    const reviews = await this.list()
    this.reviews = reviews.filter((review) => review.id !== id)
    await this.adapter.remove(`${this.dir()}/${id}.json`).catch(() => undefined)
    this.changed()
  }
}
