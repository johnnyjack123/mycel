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
