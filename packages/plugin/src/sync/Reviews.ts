import type { DataAdapter } from 'obsidian'
import { lineDiff, listDiff, splitLines } from '@mycel/shared'
import { alignVersions, lineText, type Aligned, type Passage, type Run, type Span } from './align.js'
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

/**
 * A line of the middle: one of a version's, by its number there, or one written by hand. Each has
 * an id of its own, so the window can select and move it while others come and go around it.
 */
export type Item = { id: number; side: Side; line: number } | { id: number; typed: string }

/** A differing passage's place in the result: its lines, in order. */
export interface Slot {
  items: Item[]
  /** Written into by hand: decided, even when it was emptied that way. */
  edited: boolean
  /** Sides taken that have nothing in the passage: decided, empty. */
  emptyTaken: Side[]
}

/**
 * Where lines go in the middle (0.9.32): into a passage's place, before its `at`-th line - or
 * between the lines of a run both have, before its `at`-th line (`at` its length: after its last).
 */
export type Place = { passage: number; at: number } | { run: number; at: number }

function emptySlot(): Slot {
  return { items: [], edited: false, emptyTaken: [] }
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

/** Runs both have that meet again - a place between them gone - are one. */
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
 * starts empty - this device's lines, the other's, both in the order taken, or text of one's
 * own go into it. The passages are as fine as the two versions allow (`alignVersions`,
 * 2026-11-21): a stretch only one side has is one of its own. Since 0.9.32 the middle is a list
 * of lines, as on a board of cards (the user, 2026-11-27): lines of either version go into it
 * anywhere - between lines both have too, where a place of their own opens (`inserted`) - and
 * move about in it. A range of lines taken by Shift-click joined passages before (0.9.31), and
 * was hard to follow: the window changed under the click.
 */
export class MergeDraft {
  /** The two versions as laid out first. */
  readonly aligned: Aligned
  /** How they stand now: `aligned`'s runs, with places opened between lines both have. */
  runs: Run[] = []
  /** The passages, in order - those that differ and the places opened; one slot each. */
  passages: Passage[] = []
  slots: Slot[] = []
  private nextId = 1

  constructor(mine: string, theirs: string) {
    this.aligned = alignVersions(mine, theirs)
    this.reset()
  }

  /** Every passage empty, and the places opened between lines both have gone. */
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

  /** The numbers of the lines a side has in the passage. */
  sideLines(index: number, side: Side): number[] {
    const passage = this.passage(index)
    const lines: number[] = []
    for (let line = start(passage, side); line < end(passage, side); line += 1) lines.push(line)
    return lines
  }

  /** Every line a side has in the passage, as it stands there. */
  sideText(index: number, side: Side): string {
    const passage = this.passage(index)
    return this.lines(side).slice(start(passage, side), end(passage, side)).join('')
  }

  /** A line of the middle as the note will have it, with its break where it has one. */
  itemText(item: Item): string {
    return 'typed' in item ? `${item.typed}\n` : (this.lines(item.side)[item.line] ?? '')
  }

  /** What a passage's place says. */
  text(index: number): string {
    return joinParts((this.slots[index]?.items ?? []).map((item) => this.itemText(item)))
  }

  private item(side: Side, line: number): Item {
    return { id: this.nextId++, side, line }
  }

  /** The lines of a version that are in the middle, wherever they were put. */
  placed(side: Side): Set<number> {
    const lines = new Set<number>()
    for (const slot of this.slots) {
      for (const item of slot.items) if (!('typed' in item) && item.side === side) lines.add(item.line)
    }
    return lines
  }

  /** Takes a side's own lines of the passage out of its place, wherever in it they stand. */
  private dropSide(index: number, side: Side): void {
    const slot = this.slots[index]
    if (!slot) return
    const own = new Set(this.sideLines(index, side))
    slot.items = slot.items.filter((item) => 'typed' in item || item.side !== side || !own.has(item.line))
  }

  /** Whether every line of a side is in the passage's place - for a side with none there, whether it was taken as nothing. */
  taken(index: number, side: Side): boolean {
    const slot = this.slots[index]
    if (!slot) return false
    const lines = this.sideLines(index, side)
    if (lines.length === 0) return slot.emptyTaken.includes(side)
    const held = new Set(slot.items.flatMap((item) => ('typed' in item || item.side !== side ? [] : [item.line])))
    return lines.every((line) => held.has(line))
  }

  /** Every line of a side, after what is there; lines of it put there before go into it, in its order. */
  take(index: number, side: Side): void {
    const slot = this.slots[index]
    if (!slot || this.taken(index, side)) return
    const lines = this.sideLines(index, side)
    if (lines.length === 0) {
      slot.emptyTaken.push(side)
      return
    }
    this.dropSide(index, side)
    slot.items.push(...lines.map((line) => this.item(side, line)))
  }

  /** Takes a side out again: its lines of the passage, wherever in the place they stand. */
  remove(index: number, side: Side): void {
    const slot = this.slots[index]
    if (!slot) return
    slot.emptyTaken = slot.emptyTaken.filter((each) => each !== side)
    this.dropSide(index, side)
  }

  /**
   * The place's text, written by hand. Lines that stay as they were keep where they came from,
   * so giving a side back still takes them out, and the version still marks them as in the middle.
   */
  edit(index: number, text: string): void {
    const slot = this.slots[index]
    if (!slot) return
    const lines = splitLines(text).map(lineText)
    const before = slot.items.map((item) => lineText(this.itemText(item)))
    const items: Item[] = []
    for (const hunk of listDiff(before, lines)) {
      if (hunk.type === 'equal') items.push(...slot.items.slice(hunk.aStart, hunk.aEnd))
      else for (const line of lines.slice(hunk.bStart, hunk.bEnd)) items.push({ id: this.nextId++, typed: line })
    }
    slot.items = items
    slot.edited = true
  }

  clear(index: number): void {
    const slot = this.slots[index]
    if (!slot) return
    slot.items = []
    slot.edited = false
    slot.emptyTaken = []
    this.tidy()
  }

  /** Lines of a version into the middle at a place, in their order there (0.9.32). The version keeps them. */
  put(side: Side, lines: number[], place: Place): void {
    const count = this.lines(side).length
    const chosen = [...new Set(lines)].filter((line) => line >= 0 && line < count).sort((a, b) => a - b)
    if (chosen.length === 0) return
    const target = this.resolve(place)
    if (!target) return
    this.insert(target, chosen.map((line) => this.item(side, line)))
    this.tidy()
  }

  /** Lines of the middle to another place in it, in the order they stood. */
  move(ids: number[], place: Place): void {
    const moving = new Set(ids)
    const items = this.slots.flatMap((slot) => slot.items.filter((item) => moving.has(item.id)))
    if (items.length === 0) return
    const target = this.resolve(place)
    if (!target) return
    // Put before a line that moves itself, they go before the next one that stays.
    let before = target.before
    if (before && moving.has(before.id)) {
      const from = target.slot.items.indexOf(before)
      before = target.slot.items.slice(from).find((item) => !moving.has(item.id)) ?? null
    }
    for (const slot of this.slots) slot.items = slot.items.filter((item) => !moving.has(item.id))
    this.insert({ slot: target.slot, before }, items)
    this.tidy()
  }

  /** Lines out of the middle again. */
  drop(ids: number[]): void {
    const gone = new Set(ids)
    for (const slot of this.slots) slot.items = slot.items.filter((item) => !gone.has(item.id))
    this.tidy()
  }

  /** Where a line of the middle stands: its passage and its place in it. */
  find(id: number): { index: number; at: number } | null {
    for (let index = 0; index < this.slots.length; index += 1) {
      const at = this.slots[index]?.items.findIndex((item) => item.id === id) ?? -1
      if (at >= 0) return { index, at }
    }
    return null
  }

  /** Every line of the middle, in the order the note will have them. */
  items(): Item[] {
    return this.slots.flatMap((slot) => slot.items)
  }

  private insert(target: { slot: Slot; before: Item | null }, items: Item[]): void {
    const at = target.before ? target.slot.items.indexOf(target.before) : -1
    if (at < 0) target.slot.items.push(...items)
    else target.slot.items.splice(at, 0, ...items)
  }

  /**
   * The slot a place names, and the line there to go before (none: at its end). Between lines
   * both have, a place opened there before takes them - at its end, coming from below it, at its
   * start from above -, or a new one opens.
   */
  private resolve(place: Place): { slot: Slot; before: Item | null } | null {
    if ('passage' in place) {
      const slot = this.slots[place.passage]
      return slot ? { slot, before: slot.items[place.at] ?? null } : null
    }
    const run = this.runs[place.run]
    if (!run) return null
    if (!run.same) {
      const slot = this.slots[this.passages.indexOf(run)]
      return slot ? { slot, before: slot.items[place.at] ?? null } : null
    }
    const length = run.mineTo - run.mineFrom
    const at = Math.max(0, Math.min(length, place.at))
    const above = this.runs[place.run - 1]
    if (at === 0 && above && !above.same && above.inserted) {
      const slot = this.slots[this.passages.indexOf(above)]
      if (slot) return { slot, before: null }
    }
    const below = this.runs[place.run + 1]
    if (at === length && below && !below.same && below.inserted) {
      const slot = this.slots[this.passages.indexOf(below)]
      if (slot) return { slot, before: slot.items[0] ?? null }
    }
    const mine = run.mineFrom + at
    const theirs = run.theirsFrom + at
    const opened: Passage = { same: false, inserted: true, mineFrom: mine, mineTo: mine, theirsFrom: theirs, theirsTo: theirs, rows: [] }
    const pieces: Run[] = []
    if (at > 0) pieces.push({ same: true, mineFrom: run.mineFrom, mineTo: mine, theirsFrom: run.theirsFrom, theirsTo: theirs })
    pieces.push(opened)
    if (at < length) pieces.push({ same: true, mineFrom: mine, mineTo: run.mineTo, theirsFrom: theirs, theirsTo: run.theirsTo })
    const slot = emptySlot()
    const slots = this.slotsByPassage()
    slots.set(opened, slot)
    this.restructure([...this.runs.slice(0, place.run), ...pieces, ...this.runs.slice(place.run + 1)], slots)
    return { slot, before: null }
  }

  /** A place opened between lines both have goes again once nothing is in it; says whether one went. */
  tidy(): boolean {
    const runs = this.runs.filter((run) => run.same || !run.inserted || (this.slots[this.passages.indexOf(run)]?.items.length ?? 0) > 0)
    if (runs.length === this.runs.length) return false
    this.restructure(runs, this.slotsByPassage())
    return true
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

  /** Every passage from one side alone - the places opened between lines both have gone. */
  takeAll(side: Side): void {
    this.reset()
    this.slots.forEach((_slot, index) => this.take(index, side))
  }

  /** Something is in it or was written there - nothing taken from an empty side counts too. */
  decided(index: number): boolean {
    const slot = this.slots[index]
    return slot !== undefined && (slot.items.length > 0 || slot.edited || slot.emptyTaken.length > 0)
  }

  /** The passages that differ - not the places opened between lines both have. */
  get total(): number {
    return this.passages.filter((passage) => !passage.inserted).length
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
    return joinParts(this.runs.map((run) => (run.same ? this.aligned.mine.slice(run.mineFrom, run.mineTo).join('') : this.text(next++))))
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
