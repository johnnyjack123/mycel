import type { DataAdapter } from 'obsidian'
import { lineDiff } from '@mycel/shared'
import { alignVersions, type Aligned, type Passage, type Row, type Run, type SameRun, type Span } from './align.js'
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

/** What a passage's place in the result took: a side's lines there, or some lines of a side in one piece. */
export interface Picked {
  side: Side
  /**
   * Lines [from, to) of that version: one taken by its number, or a range of them (0.9.31). Null
   * for every line the side has in the passage.
   */
  lines: { from: number; to: number } | null
}

/** A differing passage's place in the result: what was taken into it, in order, or written there by hand. */
export interface Slot {
  picks: Picked[]
  text: string
  /** Written into by hand: taking more adds to that text instead of building it anew. */
  edited: boolean
}

function emptySlot(): Slot {
  return { picks: [], text: '', edited: false }
}

function start(span: Span, side: Side): number {
  return side === 'mine' ? span.mineFrom : span.theirsFrom
}

function end(span: Span, side: Side): number {
  return side === 'mine' ? span.mineTo : span.theirsTo
}

function passagesOf(runs: Run[]): Passage[] {
  return runs.filter((run): run is Passage => !run.same)
}

/** A place between two lines of one side, inside a run both have: the same place on the other side. */
function across(run: SameRun, side: Side, line: number): { mine: number; theirs: number } {
  const offset = line - start(run, side)
  return { mine: run.mineFrom + offset, theirs: run.theirsFrom + offset }
}

/** Runs both have that meet again - a joined passage split - are one. */
function mergeSame(runs: Run[]): Run[] {
  const merged: Run[] = []
  for (const run of runs) {
    const last = merged[merged.length - 1]
    if (last?.same && run.same) {
      merged[merged.length - 1] = { same: true, mineFrom: last.mineFrom, mineTo: run.mineTo, theirsFrom: last.theirsFrom, theirsTo: run.theirsTo }
    } else {
      merged.push(run)
    }
  }
  return merged
}

/**
 * The note being put together in "Compare versions", as git's merge tools do (the user,
 * 2026-11-18): what both versions have stands as it is, and each passage that differs
 * starts empty - this device's lines, the other's, both in the order taken, single lines of
 * either, or text of one's own go into it, one passage at a time. The passages are as fine
 * as the two versions allow (`alignVersions`, 2026-11-21): a stretch only one side has is
 * one of its own. A range of lines taken across them joins them (`takeRange`, 0.9.31).
 */
export class MergeDraft {
  /** The two versions as laid out first. */
  readonly aligned: Aligned
  /** How they stand now: `aligned`'s runs, with passages joined where a range was taken across them. */
  runs: Run[] = []
  /** The passages that differ, in order; one slot each. */
  passages: Passage[] = []
  slots: Slot[] = []

  constructor(mine: string, theirs: string) {
    this.aligned = alignVersions(mine, theirs)
    this.reset()
  }

  /** Every passage empty, and as first laid out: joined ones split again. */
  reset(): void {
    this.runs = [...this.aligned.runs]
    this.passages = passagesOf(this.runs)
    this.slots = this.passages.map(() => emptySlot())
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
    return this.lines(side).slice(start(passage, side), end(passage, side)).join('')
  }

  private holds(index: number, side: Side, line: number): boolean {
    const passage = this.passage(index)
    return line >= start(passage, side) && line < end(passage, side)
  }

  private pickText(index: number, pick: Picked): string {
    return pick.lines === null ? this.sideText(index, pick.side) : this.lines(pick.side).slice(pick.lines.from, pick.lines.to).join('')
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
    return this.slots[index]?.picks.some((pick) => pick.side === side && pick.lines === null) ?? false
  }

  /** The pick that holds a line of a side, alone or in a range. */
  private pickOf(index: number, side: Side, line: number): Picked | undefined {
    return this.slots[index]?.picks.find((pick) => pick.side === side && pick.lines !== null && line >= pick.lines.from && line < pick.lines.to)
  }

  /** Whether a line of a side is in the passage's place, alone, in a range or with its side. */
  picked(index: number, side: Side, line: number): boolean {
    return this.taken(index, side) || this.pickOf(index, side, line) !== undefined
  }

  /** Every line of a side, after what is there; lines of that side taken before go into it. */
  take(index: number, side: Side): void {
    const slot = this.slots[index]
    if (!slot || this.taken(index, side)) return
    this.drop(index, slot.picks.filter((pick) => pick.side === side))
    this.add(index, { side, lines: null })
  }

  /** Takes a side out again, its single lines and ranges too. */
  remove(index: number, side: Side): void {
    const slot = this.slots[index]
    if (slot) this.drop(index, slot.picks.filter((pick) => pick.side === side))
  }

  /** One line of a side, after what is there - or out again, with the range it came in. Nothing while the whole side is taken. */
  toggleLine(index: number, side: Side, line: number): void {
    const slot = this.slots[index]
    if (!slot || this.taken(index, side) || !this.holds(index, side, line)) return
    const there = this.pickOf(index, side, line)
    if (there) this.drop(index, [there])
    else this.add(index, { side, lines: { from: line, to: line + 1 } })
  }

  /**
   * The lines from `first` to `last` of a side, either way round, after what is there, as one
   * piece (0.9.31). A range reaching past its passage, over lines both have, makes one passage of
   * everything it touches: two blocks written in the same place on two devices were cut apart by
   * the lines both have between them (`---`, an empty line), and could not be put one under the
   * other. What those passages held stays in the joined one; the lines both had between them are
   * the range's from then on. Returns the passage it went into.
   */
  takeRange(side: Side, first: number, last: number): number | null {
    const from = Math.max(0, Math.min(first, last))
    const to = Math.min(this.lines(side).length, Math.max(first, last) + 1)
    if (from >= to) return null
    const a = this.runAt(side, from)
    const b = this.runAt(side, to - 1)
    if (a < 0 || b < 0) return null
    const only = this.runs[a]
    const index = a === b && only && !only.same ? this.passages.indexOf(only) : this.join(side, from, to, a, b)
    const slot = this.slots[index]
    if (!slot || this.taken(index, side)) return index
    // Lines of it taken before - its first one, by its number - are in it now.
    this.drop(index, slot.picks.filter((pick) => pick.side === side && pick.lines !== null && pick.lines.from >= from && pick.lines.to <= to))
    this.add(index, { side, lines: { from, to } })
    return index
  }

  private runAt(side: Side, line: number): number {
    return this.runs.findIndex((run) => line >= start(run, side) && line < end(run, side))
  }

  /** Runs `a` to `b` as one passage; a run both have at either end is cut where the range begins or ends. */
  private join(side: Side, from: number, to: number, a: number, b: number): number {
    const first = this.runs[a] as Run
    const last = this.runs[b] as Run
    const begin = first.same ? across(first, side, from) : { mine: first.mineFrom, theirs: first.theirsFrom }
    const finish = last.same ? across(last, side, to) : { mine: last.mineTo, theirs: last.theirsTo }
    const rows: Row[] = []
    const picks: Picked[] = []
    const texts: string[] = []
    let edited = false
    for (const run of this.runs.slice(a, b + 1)) {
      if (run.same) {
        const mineFrom = Math.max(run.mineFrom, begin.mine)
        const mineTo = Math.min(run.mineTo, finish.mine)
        for (let line = mineFrom; line < mineTo; line += 1) rows.push({ mine: line, theirs: run.theirsFrom + (line - run.mineFrom), paired: false, same: true })
        continue
      }
      rows.push(...run.rows)
      const slot = this.slots[this.passages.indexOf(run)]
      if (!slot) continue
      for (const pick of slot.picks) {
        // A passage's whole side is only a range of the joined one.
        const lines = pick.lines ?? { from: start(run, pick.side), to: end(run, pick.side) }
        if (lines.to > lines.from) picks.push({ side: pick.side, lines })
      }
      edited ||= slot.edited
      texts.push(slot.text)
    }
    const joined: Passage = { same: false, joined: true, mineFrom: begin.mine, mineTo: finish.mine, theirsFrom: begin.theirs, theirsTo: finish.theirs, rows }
    const pieces: Run[] = []
    if (first.same && begin.mine > first.mineFrom) {
      pieces.push({ same: true, mineFrom: first.mineFrom, mineTo: begin.mine, theirsFrom: first.theirsFrom, theirsTo: begin.theirs })
    }
    pieces.push(joined)
    if (last.same && finish.mine < last.mineTo) {
      pieces.push({ same: true, mineFrom: finish.mine, mineTo: last.mineTo, theirsFrom: finish.theirs, theirsTo: last.theirsTo })
    }
    const slots = this.slotsByPassage()
    slots.set(joined, { picks, text: joinParts(texts), edited })
    this.restructure([...this.runs.slice(0, a), ...pieces, ...this.runs.slice(b + 1)], slots)
    const index = this.passages.indexOf(joined)
    this.rebuild(index)
    return index
  }

  /** A passage a range made, split again into the passages it was made of - each empty, as first laid out. */
  split(index: number): void {
    const passage = this.passages[index]
    if (!passage?.joined) return
    const pieces: Run[] = []
    for (const run of this.aligned.runs) {
      if (run.same) {
        const mineFrom = Math.max(run.mineFrom, passage.mineFrom)
        const mineTo = Math.min(run.mineTo, passage.mineTo)
        if (mineTo > mineFrom) {
          pieces.push({ same: true, mineFrom, mineTo, theirsFrom: run.theirsFrom + (mineFrom - run.mineFrom), theirsTo: run.theirsFrom + (mineTo - run.mineFrom) })
        }
      } else if (run.mineFrom >= passage.mineFrom && run.mineTo <= passage.mineTo && run.theirsFrom >= passage.theirsFrom && run.theirsTo <= passage.theirsTo) {
        pieces.push(run)
      }
    }
    const at = this.runs.indexOf(passage)
    this.restructure([...this.runs.slice(0, at), ...pieces, ...this.runs.slice(at + 1)], this.slotsByPassage())
  }

  private slotsByPassage(): Map<Passage, Slot> {
    return new Map(this.passages.map((passage, at) => [passage, this.slots[at] ?? emptySlot()]))
  }

  /** New runs; each passage keeps its slot, a new one starts empty. */
  private restructure(runs: Run[], slots: Map<Passage, Slot>): void {
    this.runs = mergeSame(runs)
    this.passages = passagesOf(this.runs)
    this.slots = this.passages.map((passage) => slots.get(passage) ?? emptySlot())
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
    return joinParts(this.runs.map((run) => (run.same ? this.aligned.mine.slice(run.mineFrom, run.mineTo).join('') : (this.slots[next++]?.text ?? ''))))
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
  /** The device where the two met, by its name then; absent on reviews from before 0.9.29. */
  device?: string
  /** That device's id: "this device" means it only there. */
  deviceId?: string
}

/** What the two versions are called where the review is shown: "this device" only where they met. */
export function versionNames(review: Review, deviceId: string): { mine: string; mineWords: string; theirs: string } {
  if (review.deviceId === undefined || review.deviceId === deviceId) return { mine: 'This device', mineWords: 'this device', theirs: 'Other version' }
  const device = review.device ?? 'another device'
  return { mine: `On ${device}`, mineWords: `"${device}"`, theirs: 'Other version' }
}

/** The account's settings, where every device finds the reviews (`AccountSettings`). */
export interface SharedReviews {
  reviews(): Review[]
  setReview(review: Review): void
  deleteReview(id: string): void
  onReviews(listener: () => void): () => void
}

const DIR = 'reviews'
// Joining an older copy of a vault merges every note that differs at once, and each is
// marked in the explorer until looked at: a hundred left the rest unmarked (0.9.22).
const MAX_REVIEWS = 2000
// Every device holds every review in the account's settings: beyond these a review stays on
// the device where it was made, as all did before 0.9.29. A note's three texts in one frame
// must stay well below what the server takes in one message (32 MB).
const SHARED_MAX = 500
const SHARED_MAX_CHARS = 3_000_000

function sizeOf(review: Review): number {
  return review.mine.length + review.theirs.length + review.merged.length
}

/**
 * The reviews of a vault: in the account's settings, where every device of the account
 * finds them (`shared`), and in this device's plugin folder those too large for that - or
 * all of them, without `shared`. The plugin folder held them all before 0.9.29; they move
 * into the settings the first time they are read.
 */
export class ReviewStore {
  /** This device's own, from its plugin folder; null until read. */
  private local: Review[] | null = null
  private reading: Promise<Review[]> | null = null
  private readonly listeners = new Set<() => void>()
  private readonly unwatch: (() => void) | null

  constructor(
    private readonly adapter: Pick<DataAdapter, 'exists' | 'mkdir' | 'write' | 'read' | 'list' | 'remove'>,
    private readonly root: string,
    private readonly shared: SharedReviews | null = null,
    private readonly device: { id: string; name: string } | null = null
  ) {
    this.unwatch = shared?.onReviews(() => this.changed()) ?? null
  }

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

  stop(): void {
    this.unwatch?.()
    this.listeners.clear()
  }

  /** Every review, the newest first - read from the plugin folder once, and moved into the settings then. */
  async list(): Promise<Review[]> {
    this.reading ??= this.readLocal().then(async (found) => {
      this.local = found
      await this.moveIntoSettings()
      this.changed()
      return found
    })
    await this.reading
    return this.all()
  }

  private async readLocal(): Promise<Review[]> {
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
    return found
  }

  /** The reviews made here before they were shared: into the settings, made here, as far as they fit. */
  private async moveIntoSettings(): Promise<void> {
    if (!this.shared || !this.local || this.local.length === 0) return
    let moved = 0
    for (const review of [...this.local].sort((a, b) => a.at - b.at)) {
      const here: Review = { ...review, device: review.device ?? this.device?.name, deviceId: review.deviceId ?? this.device?.id }
      if (!this.fitsShared(here)) continue
      this.shared.setReview(here)
      await this.removeLocal(review.id)
      moved += 1
    }
    if (moved > 0) log.info(`${moved} note(s) to compare moved into the account's settings: every device shows them now`)
  }

  private all(): Review[] {
    const shared = this.shared?.reviews() ?? []
    const ids = new Set(shared.map((review) => review.id))
    return [...shared, ...(this.local ?? []).filter((review) => !ids.has(review.id))].sort((a, b) => b.at - a.at).slice(0, MAX_REVIEWS)
  }

  /** Whether a note waits for a review - cheap, for menus; this device's own only once the list was read. */
  pendingFor(docId: string): Review | undefined {
    return this.all().find((review) => review.docId === docId)
  }

  /** Every note waiting for a review: for the explorer's marks. */
  pending(): Review[] {
    return this.all()
  }

  /** Whether the review is still there - put together on another device meanwhile, it is not. */
  has(id: string): boolean {
    return this.all().some((review) => review.id === id)
  }

  private fitsShared(review: Review): boolean {
    if (!this.shared || sizeOf(review) > SHARED_MAX_CHARS) return false
    const others = this.shared.reviews().filter((candidate) => candidate.id !== review.id)
    return others.length < SHARED_MAX
  }

  /**
   * One review per note and device: a later merge of the same note here is what
   * the user now sees, so it takes the earlier one's place - keeping the earlier
   * "mine", which is this device's own text from before either merge. Another
   * device's review of the same note stays beside it: its "mine" is its own.
   */
  async add(review: Omit<Review, 'id' | 'device' | 'deviceId'>): Promise<Review> {
    await this.list()
    const deviceId = this.device?.id
    const earlier = this.all().find((candidate) => candidate.docId === review.docId && (candidate.deviceId === undefined || candidate.deviceId === deviceId))
    const next: Review = {
      ...review,
      id: earlier?.id ?? `${review.at.toString(36)}-${review.docId.slice(0, 8)}${deviceId ? `-${deviceId.slice(0, 4)}` : ''}`,
      mine: earlier?.mine ?? review.mine,
      ...(this.device ? { device: this.device.name, deviceId: this.device.id } : {})
    }
    if (this.fitsShared(next)) {
      ;(this.shared as SharedReviews).setReview(next)
      await this.removeLocal(next.id)
    } else {
      if (this.shared) log.warn(`${review.path}: its versions are kept on this device only - too large, or too many notes wait already`)
      await this.writeLocal(next)
      this.shared?.deleteReview(next.id)
    }
    this.changed()
    return next
  }

  async remove(id: string): Promise<void> {
    await this.list()
    this.shared?.deleteReview(id)
    await this.removeLocal(id)
    this.changed()
  }

  private async writeLocal(review: Review): Promise<void> {
    if (!(await this.adapter.exists(this.dir()))) await this.adapter.mkdir(this.dir())
    await this.adapter.write(`${this.dir()}/${review.id}.json`, JSON.stringify(review))
    this.local = [review, ...(this.local ?? []).filter((candidate) => candidate.id !== review.id)]
  }

  private async removeLocal(id: string): Promise<void> {
    if (!this.local?.some((review) => review.id === id)) return
    this.local = this.local.filter((review) => review.id !== id)
    await this.adapter.remove(`${this.dir()}/${id}.json`).catch(() => undefined)
  }
}
