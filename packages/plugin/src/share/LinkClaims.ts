import type { App } from 'obsidian'
import type * as Y from 'yjs'
import { NOTE_LINKS_FIELD, type LinkClaim, type ShareRole } from '@mycel/shared'
import type { ConnectApi } from '../account/api.js'
import type { DocHandle } from '../sync/DocHandle.js'
import type { DocStore } from '../sync/DocStore.js'
import { EDITOR_ORIGIN, SYNC_ORIGIN } from '../sync/origin.js'
import { landingTitle } from './LinkedNotes.js'
import { idsAt, linksIn, linksNear, touchedBy, type LinkAt } from './links.js'
import { log } from '../log.js'

// Whose a link in a shared note is. `[[Recipe]]` is only text, and every vault
// resolves it by name in itself: a link one person typed meant a note of theirs,
// and on someone else's device it opened - or shared - a note of that name of
// their own. So the device a link was typed on says what it means, in the
// note's document, signed by its account (`LinkClaim`): only for a link its
// own edit made, typed into the editor or the file. A link someone made out of
// someone else's letters - by deleting what lay between them - is nobody's,
// whoever typed each letter.
//
// What follows from it: a link is this account's, someone else's - their note
// if this vault has it, else a dead link here - or nobody's, which Obsidian
// resolves as ever. A file of this vault goes into a shared note's list only
// for a link of this account's (`SharedFiles`). And for a link of this
// account's to a note of its own that others in the note do not have, the
// device that typed it asks whether it goes to them.

const ORIGIN = 'link-claims'

export interface LinkClaimKeys {
  readonly accountId: string
  claimLink(note: string, anchor: string, ref: string, target: string): Promise<LinkClaim>
  checkLinkClaim(note: string, anchor: string, claim: LinkClaim): Promise<boolean>
}

export interface LinkPerson {
  account: string
  role: ShareRole
}

/** Who is in a note besides this account, and whether someone has a note already. */
export interface LinkPeople {
  of(docId: string): Promise<LinkPerson[]>
  has(docId: string, account: string): Promise<boolean>
}

/** A note of this vault a link typed here names, which people in the note do not have. */
export interface LinkQuestion {
  note: string
  notePath: string
  target: string
  targetPath: string
  ref: string
  people: Array<LinkPerson & { name: string }>
}

export interface LinkClaimsOptions {
  /** How long after this device's last edit in a note it says whose the links it made are. */
  settleMs: number
  /** And how long before it asks about a note of this vault one of them names: never in the middle of typing it. */
  askMs: number
  /** Where the file a shared note brings for a link lies in this vault. */
  deliveredPath(docId: string, ref: string): string | null
  people: LinkPeople
  /** What this account calls a contact; null for anyone else. */
  name(account: string): string | null
  asked(note: string, target: string): boolean
  markAsked(note: string, target: string): void
  ask(question: LinkQuestion): void
  share(target: string, person: LinkPerson, landing: string): Promise<void>
}

export type LinkOwner =
  | { kind: 'own' }
  /** No claim this device can check: Obsidian resolves it, as before claims existed. */
  | { kind: 'unknown' }
  /** Someone else's: their note or file where this vault has it, else null - a dead link here. */
  | { kind: 'theirs'; account: string; name: string; target: string; path: string | null }

export interface LinkVerdict extends LinkAt {
  /** The link as it stands in the text. */
  text: string
  owner: LinkOwner
}

interface Seen extends LinkAt {
  text: string
  claim: LinkClaim | null
}

interface Watched {
  handle: DocHandle
  /** Links this device's own edits touched last, by anchor, not claimed yet. */
  pending: Set<string>
  /** Links someone else's change touched while a claim was being signed. */
  elsewhere: Set<string>
  settleTimer: number | null
  askTimer: number | null
  viewTimer: number | null
  view: Seen[] | null
  version: number
}

function claimsOf(handle: DocHandle): Y.Map<LinkClaim> {
  return handle.doc.getMap<LinkClaim>(NOTE_LINKS_FIELD)
}

/** Everyone in a note but this account, from the server's lists - a question names each, so nobody goes unseen. */
export function notePeople(api: ConnectApi, store: DocStore, me: string): LinkPeople {
  const add = (into: Map<string, ShareRole>, account: string, role: ShareRole): void => {
    if (account !== me && into.get(account) !== 'write') into.set(account, role)
  }
  return {
    async of(docId) {
      const entry = store.entry(docId)
      const people = new Map<string, ShareRole>()
      if (!entry) return []
      if (entry.folder) {
        const state = await api.folderState(entry.folder)
        add(people, state.owner, 'write')
        for (const member of state.members) add(people, member.account, member.role)
      }
      if (entry.shared || entry.owner) {
        const listed = await api.members(docId)
        add(people, listed.owner, 'write')
        for (const member of listed.members) add(people, member.account, member.role)
      }
      return Array.from(people, ([account, role]) => ({ account, role }))
    },
    async has(docId, account) {
      const entry = store.entry(docId)
      if (!entry) return false
      if (entry.folder) {
        const state = await api.folderState(entry.folder)
        if (state.owner === account || state.members.some((member) => member.account === account)) return true
      }
      if (entry.shared) {
        const listed = await api.members(docId)
        if (listed.members.some((member) => member.account === account)) return true
      }
      return false
    }
  }
}

export class LinkClaims {
  private readonly notes = new Map<string, Watched>()
  /** Claims whose signature held, by everything it covers. */
  private readonly held = new Set<string>()
  private readonly listeners = new Set<(docId: string) => void>()
  private readonly unwatch: () => void
  private stopped = false

  constructor(
    private readonly app: App,
    private readonly store: DocStore,
    private readonly keys: LinkClaimKeys,
    private readonly options: LinkClaimsOptions
  ) {
    this.unwatch = store.onOpened((docId, handle) => this.attach(docId, handle))
  }

  stop(): void {
    this.stopped = true
    this.unwatch()
    const shown = Array.from(this.notes.keys())
    for (const watched of this.notes.values()) {
      for (const timer of [watched.settleTimer, watched.askTimer, watched.viewTimer]) if (timer !== null) window.clearTimeout(timer)
    }
    this.notes.clear()
    // The marks of a stopped sync go with it.
    for (const docId of shown) this.emit(docId)
    this.listeners.clear()
  }

  /** A note someone else is in, so its links are someone's. */
  covers(docId: string): boolean {
    const entry = this.store.entry(docId)
    return Boolean(entry && !entry.deletedAt && (entry.shared || entry.owner || entry.folder))
  }

  /** Fires when what this device knows of a note's links changed. */
  onChange(listener: (docId: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Every link of a note open here, and whose it is. Empty for a note nobody else is in. */
  linksOf(docId: string): LinkVerdict[] {
    const watched = this.notes.get(docId)
    if (!watched?.view || watched.handle.isDestroyed || !this.covers(docId)) return []
    return watched.view.map((seen) => ({ start: seen.start, end: seen.end, ref: seen.ref, embed: seen.embed, text: seen.text, owner: this.ownerOf(docId, seen) }))
  }

  /** Whether this account typed a link to `ref` in the note - here or on another of its devices. */
  ownsRef(docId: string, ref: string): boolean {
    return this.linksOf(docId).some((link) => link.ref === ref && link.owner.kind === 'own')
  }

  /** Whether every link to `ref` in the note is someone else's: none of them means a note of this vault. */
  othersOnly(docId: string, ref: string): boolean {
    const links = this.linksOf(docId).filter((link) => link.ref === ref)
    return links.length > 0 && links.every((link) => link.owner.kind === 'theirs')
  }

  /**
   * Claims every link of a note shared from here that nobody claimed yet: what
   * a note holds when it is shared is its owner's word - its links resolved in
   * this vault, as they always were.
   */
  async claimAll(docId: string): Promise<void> {
    if (this.stopped || this.store.isReadOnly(docId)) return
    const entry = this.store.entry(docId)
    if (!entry) return
    const handle = await this.store.handle(docId)
    if (handle.pristine) return
    const text = handle.ytext.toString()
    const links = linksIn(text)
    const anchors = idsAt(handle.ytext, links.map((link) => link.start))
    const claims = claimsOf(handle)
    const writes: Array<[string, LinkClaim]> = []
    for (const [i, link] of links.entries()) {
      const anchor = anchors[i]
      if (!anchor || !link.ref) continue
      const existing = claims.get(anchor)
      if (existing && existing.ref === link.ref && (await this.holds(docId, anchor, existing))) continue
      writes.push([anchor, await this.keys.claimLink(docId, anchor, link.ref, this.resolve(entry.path, link.ref))])
    }
    if (writes.length === 0 || handle.isDestroyed) return
    handle.doc.transact(() => {
      for (const [anchor, claim] of writes) claims.set(anchor, claim)
    }, ORIGIN)
    log.info(`${entry.path}: ${writes.length} link(s) in it named as this account's, as it is shared`)
  }

  /** The person's yes from the question: the note goes to everyone it named who still lacks it, without its history. */
  async shareLinked(question: { target: string; ref: string; people: LinkPerson[] }): Promise<{ shared: number; failed: number }> {
    const outcome = { shared: 0, failed: 0 }
    for (const person of question.people) {
      try {
        if (await this.options.people.has(question.target, person.account)) continue
        await this.options.share(question.target, person, landingTitle(question.ref) || question.ref)
        outcome.shared += 1
      } catch (error) {
        log.warn(`sharing a linked note with ${person.account.slice(0, 8)} failed`, error)
        outcome.failed += 1
      }
    }
    return outcome
  }

  private attach(docId: string, handle: DocHandle): void {
    if (this.stopped) return
    const previous = this.notes.get(docId)
    if (previous) for (const timer of [previous.settleTimer, previous.askTimer, previous.viewTimer]) if (timer !== null) window.clearTimeout(timer)
    const watched: Watched = { handle, pending: new Set(), elsewhere: new Set(), settleTimer: null, askTimer: null, viewTimer: null, view: null, version: 0 }
    this.notes.set(docId, watched)
    handle.ytext.observe((event, transaction) => this.changed(docId, watched, event.delta as never, transaction.origin))
    claimsOf(handle).observe(() => this.scheduleView(docId, watched))
    if (this.covers(docId)) this.scheduleView(docId, watched)
  }

  private live(docId: string, watched: Watched): boolean {
    return !this.stopped && this.notes.get(docId) === watched && !watched.handle.isDestroyed
  }

  private changed(docId: string, watched: Watched, delta: Array<{ retain?: number; insert?: unknown; delete?: number }>, origin: unknown): void {
    if (!this.live(docId, watched) || !this.covers(docId)) return
    // Typed into the editor, or into the file; a restore, a fork or someone else's change made nothing here.
    const typed = origin === EDITOR_ORIGIN || origin === SYNC_ORIGIN
    const ytext = watched.handle.ytext
    const near = linksNear(ytext.toString(), touchedBy(delta)).sort((a, b) => a.start - b.start)
    if (near.length > 0) {
      for (const anchor of idsAt(ytext, near.map((link) => link.start))) {
        if (!anchor) continue
        if (typed) {
          watched.pending.add(anchor)
        } else {
          watched.pending.delete(anchor)
          watched.elsewhere.add(anchor)
        }
      }
    }
    if (typed) {
      watched.settleTimer = this.restart(watched.settleTimer, this.options.settleMs, () => void this.settle(docId, watched))
      watched.askTimer = this.restart(watched.askTimer, this.options.askMs, () => void this.askAbout(docId, watched))
    }
    this.scheduleView(docId, watched)
  }

  private restart(timer: number | null, delayMs: number, run: () => void): number {
    if (timer !== null) window.clearTimeout(timer)
    return window.setTimeout(run, delayMs)
  }

  /** What `[[ref]]` means in this vault, seen from the note. */
  private resolve(notePath: string, ref: string): string {
    const dest = this.app.metadataCache.getFirstLinkpathDest(ref, notePath)
    if (!dest) return 'none'
    if (dest.extension !== 'md') return 'file'
    const docId = this.store.docIdForPath(dest.path)
    return docId ? `note:${docId}` : 'none'
  }

  /** Claims the links this device's edits made or changed, and lets go of its claims on links that are gone. */
  private async settle(docId: string, watched: Watched): Promise<void> {
    watched.settleTimer = null
    if (!this.live(docId, watched)) return
    const pending = new Set(watched.pending)
    watched.pending.clear()
    watched.elsewhere.clear()
    const entry = this.store.entry(docId)
    if (!entry || !this.covers(docId) || this.store.isReadOnly(docId)) return
    const me = this.keys.accountId
    const ytext = watched.handle.ytext
    const links = linksIn(ytext.toString())
    const anchors = idsAt(ytext, links.map((link) => link.start))
    const claims = claimsOf(watched.handle)
    const present = new Set<string>()
    const writes: Array<[string, LinkClaim]> = []
    try {
      for (const [i, link] of links.entries()) {
        const anchor = anchors[i]
        if (!anchor) continue
        present.add(anchor)
        if (!pending.has(anchor) || !link.ref) continue
        const target = this.resolve(entry.path, link.ref)
        const existing = claims.get(anchor)
        if (existing?.account === me && existing.ref === link.ref && existing.target === target && (await this.holds(docId, anchor, existing))) continue
        writes.push([anchor, await this.keys.claimLink(docId, anchor, link.ref, target)])
      }
    } catch (error) {
      log.warn(`${entry.path}: naming its links failed`, error)
      return
    }
    if (!this.live(docId, watched)) return
    // Someone else changed one of them while it was being signed: the last change is theirs.
    const claimed = writes.filter(([anchor]) => !watched.elsewhere.has(anchor))
    const gone = Array.from(claims.entries())
      .filter(([anchor, claim]) => claim.account === me && !present.has(anchor))
      .map(([anchor]) => anchor)
    if (claimed.length === 0 && gone.length === 0) return
    watched.handle.doc.transact(() => {
      for (const [anchor, claim] of claimed) claims.set(anchor, claim)
      for (const anchor of gone) claims.delete(anchor)
    }, ORIGIN)
    if (claimed.length > 0) log.debug(`${entry.path}: ${claimed.length} link(s) typed here named`)
  }

  /** Asks once per note and linked note whether a note of this vault a link typed here names goes to the people in it. */
  private async askAbout(docId: string, watched: Watched): Promise<void> {
    watched.askTimer = null
    if (!this.live(docId, watched) || !this.covers(docId) || this.store.isReadOnly(docId)) return
    // Claims first, if they are still to come.
    if (watched.settleTimer !== null || watched.pending.size > 0) {
      watched.askTimer = this.restart(watched.askTimer, this.options.settleMs, () => void this.askAbout(docId, watched))
      return
    }
    const entry = this.store.entry(docId)
    if (!entry || !watched.view) return
    const targets = new Map<string, string>()
    for (const { claim, ref } of watched.view) {
      if (claim?.account === this.keys.accountId && claim.target.startsWith('note:')) targets.set(claim.target.slice('note:'.length), ref)
    }
    let people: LinkPerson[] | null = null
    for (const [target, ref] of targets) {
      if (target === docId || this.options.asked(docId, target)) continue
      const linked = this.store.entry(target)
      // Only a note of this vault's own can go from here.
      if (!linked || linked.deletedAt || linked.owner || this.store.isExcluded(linked.path)) continue
      try {
        people ??= await this.options.people.of(docId)
        const lacking: LinkQuestion['people'] = []
        for (const person of people) {
          const name = this.options.name(person.account)
          // Notes are shared with contacts only: for anyone else the link stays dead.
          if (!name || (await this.options.people.has(target, person.account))) continue
          lacking.push({ ...person, name })
        }
        if (lacking.length === 0 || !this.live(docId, watched)) continue
        this.options.markAsked(docId, target)
        log.info(`${entry.path}: links ${linked.path}, which ${lacking.length} person(s) in it do not have; asked whether it goes to them`)
        this.options.ask({ note: docId, notePath: entry.path, target, targetPath: linked.path, ref, people: lacking })
      } catch (error) {
        log.warn(`${entry.path}: who has the notes it links could not be asked`, error)
        return
      }
    }
  }

  private scheduleView(docId: string, watched: Watched): void {
    if (!this.live(docId, watched)) return
    watched.viewTimer = this.restart(watched.viewTimer, 150, () => void this.computeView(docId, watched))
  }

  /** The note's links with the claims that hold for them. */
  private async computeView(docId: string, watched: Watched): Promise<void> {
    watched.viewTimer = null
    if (!this.live(docId, watched)) return
    if (!this.covers(docId)) {
      if (watched.view !== null) {
        watched.view = null
        this.emit(docId)
      }
      return
    }
    const version = ++watched.version
    const ytext = watched.handle.ytext
    const text = ytext.toString()
    const links = linksIn(text)
    const anchors = idsAt(ytext, links.map((link) => link.start))
    const claims = claimsOf(watched.handle)
    const seen: Seen[] = []
    for (const [i, link] of links.entries()) {
      const anchor = anchors[i]
      const raw = anchor ? claims.get(anchor) : undefined
      // A claim on a link changed since names another one.
      const claim = anchor && raw && raw.ref === link.ref && (await this.holds(docId, anchor, raw)) ? raw : null
      seen.push({ ...link, text: text.slice(link.start, link.end), claim })
    }
    if (!this.live(docId, watched) || watched.version !== version) return
    watched.view = seen
    this.emit(docId)
  }

  private async holds(note: string, anchor: string, claim: LinkClaim): Promise<boolean> {
    const key = JSON.stringify([note, anchor, claim.account, claim.ref, claim.target, claim.signature])
    if (this.held.has(key)) return true
    // A claim of someone who becomes a contact later holds from then on: only a yes is kept.
    if (!(await this.keys.checkLinkClaim(note, anchor, claim))) return false
    this.held.add(key)
    return true
  }

  private ownerOf(docId: string, seen: Seen): LinkOwner {
    const claim = seen.claim
    if (!claim) return { kind: 'unknown' }
    if (claim.account === this.keys.accountId) return { kind: 'own' }
    return { kind: 'theirs', account: claim.account, name: this.options.name(claim.account) ?? claim.account.slice(0, 8), target: claim.target, path: this.pathOf(docId, claim) }
  }

  /** Where this vault has what someone else's link means: their note shared with this account, the file the note brought. */
  private pathOf(docId: string, claim: LinkClaim): string | null {
    if (claim.target.startsWith('note:')) {
      const entry = this.store.entry(claim.target.slice('note:'.length))
      return entry && !entry.deletedAt ? entry.path : null
    }
    if (claim.target === 'file') return this.options.deliveredPath(docId, claim.ref)
    return null
  }

  private emit(docId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(docId)
      } catch (error) {
        log.warn('a listener to the links of a note failed', error)
      }
    }
  }
}
