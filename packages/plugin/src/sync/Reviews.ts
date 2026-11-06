import type { DataAdapter } from 'obsidian'
import { lineDiff } from '@mycel/shared'
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
const MAX_REVIEWS = 100

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
    return this.reviews
  }

  /** Whether a note waits for a review - cheap, for menus; false until the list was read once. */
  pendingFor(docId: string): Review | undefined {
    return this.reviews?.find((review) => review.docId === docId)
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
