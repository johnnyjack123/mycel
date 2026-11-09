import { TFile, getLinkpath, type App } from 'obsidian'
import { Notice } from '../notices.js'
import * as Y from 'yjs'
import { NOTE_ATTACHMENTS_FIELD, NOTE_SHARE_FIELD, docRoom, isFilePath, vaultPathProblem, type AttachmentEntry, type SharedAttachment } from '@mycel/shared'
import type { ConnectApi } from '../account/api.js'
import type { AttachmentStore } from '../sync/AttachmentStore.js'
import type { DocHandle } from '../sync/DocHandle.js'
import type { DocStore } from '../sync/DocStore.js'
import { log } from '../log.js'

// The files a shared note embeds or links travel with it, both ways. The
// note's own document carries a list: for each link, the content's hash and
// where it lies, with the key to read it - encrypted with the note, so
// everyone in the note can read it and nobody else.
//
// For each link this device keeps a base, the version it last saw its file
// and the list agree on, and the rules of step 1 apply: whoever changed it,
// the other side follows - if the list's version replaced this one knowingly;
// changed on both sides, both are kept. What comes in is copied into this
// vault's own store and is a file of the vault like any other.

export interface SharedFilesOptions {
  /** The share folder; files that come in go below `<folder>/Attachments`. */
  folder: () => string
  syncTimeoutMs: number
  /**
   * How long a link no list names and no claim of this account's covers waits
   * before this device says so in its log: the claim of a link just typed
   * comes a moment after the text.
   */
  claimDelayMs: number
  /**
   * Whether this account typed a link to `ref` in the note, as its signed
   * claim says (`LinkClaims`). Only then does a file of this vault go to
   * everyone in the note for it.
   */
  claimed: (docId: string, ref: string) => boolean
  /**
   * Notes of shared folders: whether their files outside the folder go along
   * is the folder's choice, and a link to a file of the folder travels with the
   * folder - it must not come in twice.
   */
  folders?: {
    linkedFilesOf(docId: string): boolean | null
    linksIntoFolder(docId: string, ref: string, target: string | null): boolean
  }
}

/** What naming this vault's blobs in a list takes; the key ring in the plugin. */
export interface SharedFileKeys {
  readonly accountId: string
  readonly vaultId: string
  blobId(hash: string): Promise<string>
  blobKeyForShare(blobId: string): Promise<string>
}

const ORIGIN = 'shared-files'
const RESCHEDULE_MS = 300

export function attachmentsShared(doc: Y.Doc): boolean {
  return doc.getMap(NOTE_SHARE_FIELD).get('attachments') === true
}

/** The owner's choice for the note; everyone in it reads the same document. */
export function setAttachmentsShared(doc: Y.Doc, shared: boolean): void {
  if (attachmentsShared(doc) === shared) return
  doc.transact(() => doc.getMap(NOTE_SHARE_FIELD).set('attachments', shared), ORIGIN)
}

/** A link to a file that is not a note: something with an extension other than `.md`. */
function isFileRef(ref: string): boolean {
  const name = ref.slice(ref.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 && name.slice(dot + 1).toLowerCase() !== 'md'
}

function besides(path: string, n: number): string {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  const cut = dot > slash ? dot : path.length
  return `${path.slice(0, cut)} ${n}${path.slice(cut)}`
}

function safeSegment(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim() || 'Shared note'
}

interface Note {
  docId: string
  file: TFile
  handle: DocHandle
  list: Y.Map<SharedAttachment>
  room: string
  isOwner: boolean
  canWrite: boolean
  refs: Set<string>
}

export class SharedFiles {
  private readonly timers = new Map<string, number>()
  private readonly running = new Map<string, Promise<void>>()
  /** `${docId}:${ref}` -> when this device first saw that link with no list entry. */
  private readonly unlisted = new Map<string, number>()
  private readonly watched = new WeakSet<Y.Doc>()
  private readonly warned = new Set<string>()
  /** `${docId}:${ref}`: links whose file this device may share (`approve`). */
  private readonly approved = new Set<string>()
  /** `${docId}:${ref}`: links left alone here, said once in the log. */
  private readonly leftAlone = new Set<string>()
  private stopped = false
  private ready = false

  constructor(
    private readonly app: App,
    private readonly store: DocStore,
    private readonly attachments: AttachmentStore,
    private readonly api: ConnectApi,
    private readonly keys: SharedFileKeys,
    private readonly options: SharedFilesOptions
  ) {
    attachments.onLocalChange((change) => this.onLocalChange(change))
  }

  start(): void {
    if (this.stopped) return
    this.ready = true
    this.scheduleAll()
  }

  stop(): void {
    this.stopped = true
    for (const timer of this.timers.values()) window.clearTimeout(timer)
    this.timers.clear()
  }

  /** Every note shared either way. Cheap to call often: each note is debounced. */
  scheduleAll(): void {
    for (const { docId } of this.store.sharedEntries()) this.schedule(docId)
  }

  /** A note's text changed: its links may have. */
  noteChanged(file: TFile): void {
    const docId = this.store.docIdForPath(file.path)
    const entry = docId ? this.store.entry(docId) : undefined
    if (docId && entry && (entry.shared || entry.owner)) this.schedule(docId)
  }

  schedule(docId: string, delayMs = RESCHEDULE_MS): void {
    if (!this.ready || this.stopped) return
    const previous = this.timers.get(docId)
    if (previous !== undefined) window.clearTimeout(previous)
    this.timers.set(
      docId,
      window.setTimeout(() => {
        this.timers.delete(docId)
        void this.run(docId)
      }, delayMs)
    )
  }

  /** One pass per note at a time; a pass asked for meanwhile runs after it. */
  run(docId: string): Promise<void> {
    const previous = this.running.get(docId) ?? Promise.resolve()
    const next = previous
      .then(() => this.sync(docId))
      .catch((error: unknown) => log.warn(`syncing the files of a shared note failed`, error))
    this.running.set(docId, next)
    void next.then(() => {
      if (this.running.get(docId) === next) this.running.delete(docId)
    })
    return next
  }

  /** Lets the note's list wake this up when another device changes it. */
  private watch(docId: string, doc: Y.Doc): void {
    if (this.watched.has(doc)) return
    this.watched.add(doc)
    doc.getMap(NOTE_ATTACHMENTS_FIELD).observe((event) => {
      if (event.transaction.origin !== ORIGIN) this.schedule(docId)
    })
    doc.getMap(NOTE_SHARE_FIELD).observe(() => this.schedule(docId))
  }

  /** The files a note embeds or links that would go along with it: how many, how large. */
  summary(file: TFile): { count: number; bytes: number } {
    let count = 0
    let bytes = 0
    for (const ref of this.refsOf(file)) {
      const target = this.app.metadataCache.getFirstLinkpathDest(ref, file.path)
      const known = target ? this.attachments.fileAt(target.path) : null
      if (!known) continue
      count += 1
      bytes += known.entry.size
    }
    return { count, bytes }
  }

  /** The links of a note that point at files, not notes, as Obsidian reports them. */
  private refsOf(file: TFile): Set<string> {
    const cache = this.app.metadataCache.getFileCache(file)
    const refs = new Set<string>()
    for (const link of [...(cache?.embeds ?? []), ...(cache?.links ?? [])]) {
      let ref = getLinkpath(link.link)
      try {
        ref = decodeURI(ref)
      } catch {
        // Not URL-encoded after all.
      }
      if (!isFileRef(ref)) continue
      const target = this.app.metadataCache.getFirstLinkpathDest(ref, file.path)
      if (target && target.extension === 'md') continue
      refs.add(ref)
    }
    return refs
  }

  private async sync(docId: string): Promise<void> {
    if (this.stopped || !this.attachments.isReady) return
    const entry = this.store.entry(docId)
    if (!entry || entry.deletedAt || !(entry.shared || entry.owner)) return
    const file = this.app.vault.getAbstractFileByPath(entry.path)
    if (!(file instanceof TFile)) return
    const handle = await this.store.handle(docId)
    this.watch(docId, handle.doc)
    // Unknown is not empty (invariant 1): nothing is done against a list the
    // server has not sent.
    if (!(await handle.whenRemoteReady(this.options.syncTimeoutMs)) || handle.pristine) return
    const byFolder = this.options.folders?.linkedFilesOf(docId) ?? null
    if (byFolder === false || (byFolder === null && !attachmentsShared(handle.doc))) return
    const isOwner = !entry.owner
    const refs = this.refsOf(file)
    if (byFolder !== null) {
      for (const ref of Array.from(refs)) {
        const target = this.app.metadataCache.getFirstLinkpathDest(ref, file.path)
        if (this.options.folders?.linksIntoFolder(docId, ref, target?.path ?? null)) refs.delete(ref)
      }
    }
    const note: Note = {
      docId,
      file,
      handle,
      list: handle.doc.getMap<SharedAttachment>(NOTE_ATTACHMENTS_FIELD),
      room: docRoom(docId),
      isOwner,
      canWrite: isOwner || entry.role === 'write',
      refs
    }
    // Links first, then what the list holds beyond them - so a renamed link
    // finds the file that came in under its old name before that one goes.
    const order = [...note.refs, ...Array.from(note.list.keys()).filter((ref) => !note.refs.has(ref))]
    for (const ref of order) {
      if (this.stopped) return
      try {
        await this.syncRef(note, ref)
      } catch (error) {
        log.warn(`${note.file.path}: the file behind ${ref} could not be synced`, error)
      }
    }
  }

  /**
   * The file this vault has for a link: one that came in for it, the one this
   * device last agreed on, or the one the link resolves to.
   */
  private localFor(note: Note, ref: string): { fileId: string; entry: AttachmentEntry } | null {
    const delivered = this.attachments.delivered(note.docId, ref)
    if (delivered) return delivered
    const base = this.attachments.sharedBase(note.docId, ref)
    if (base) {
      const known = this.attachments.fileAt(base.path)
      if (known) return known
    }
    const target = this.app.metadataCache.getFirstLinkpathDest(ref, note.file.path)
    return target && target.extension !== 'md' ? this.attachments.fileAt(target.path) : null
  }

  private async syncRef(note: Note, ref: string): Promise<void> {
    const { docId } = note
    if (this.attachments.isDeclined(docId, ref)) return
    const listed = note.list.get(ref)
    const base = this.attachments.sharedBase(docId, ref)
    const local = this.localFor(note, ref)

    if (!note.refs.has(ref)) {
      // The link left the note. Whoever received the file keeps it; there is
      // no remote delete. A writer drops it from the list.
      if (listed && note.canWrite && (listed.by === this.keys.accountId || note.isOwner)) {
        note.handle.doc.transact(() => note.list.delete(ref), ORIGIN)
        const stillNamed = Array.from(note.list.values()).some((other) => other.blob === listed.blob && other.account === listed.account)
        if (!stillNamed) {
          await this.api.attachBlobs(note.room, { detach: [{ account: listed.account, vault: listed.vault, blob: listed.blob }] })
        }
        log.info(`${note.file.path}: ${ref} is no longer linked; no longer shared`)
      }
      this.attachments.setSharedBase(docId, ref, null)
      return
    }

    if (!listed) {
      if (!local || !note.canWrite) return
      const key = `${docId}:${ref}`
      // A link is text anyone who may write in the note can type: one naming a
      // file of this vault - `![[passport.pdf]]` - had every such device hand
      // its own file of that name to everyone in the note, unasked. A file goes
      // out only for a link this account typed - here, or on another of its
      // devices, as its signed claim says -, one in the note when it was
      // shared from here, or one the user said yes to. A link someone else
      // typed means a file of theirs, and nobody here is asked about it.
      if (this.options.claimed(docId, ref)) this.approved.add(key)
      if (!this.approved.has(key)) {
        const seen = this.unlisted.get(key) ?? Date.now()
        this.unlisted.set(key, seen)
        const waited = Date.now() - seen
        if (waited < this.options.claimDelayMs) {
          this.schedule(docId, this.options.claimDelayMs - waited + 50)
          return
        }
        if (!this.leftAlone.has(key)) {
          this.leftAlone.add(key)
          log.info(`${note.file.path}: ${ref} names ${local.entry.path} of this vault, but this account did not type the link; not shared`)
        }
        return
      }
      await this.publish(note, ref, local, undefined)
      return
    }
    this.unlisted.delete(`${docId}:${ref}`)

    if (local && local.entry.hash === listed.hash) {
      this.agree(note, ref, listed.hash, local.entry.path)
      return
    }
    // This vault's own newer version is on its way into the list - written by
    // another of its devices, whose index arrived here before the note did.
    if (base?.prev !== undefined && listed.hash === base.prev && local?.entry.hash === base.hash) return
    // No base - a crash before it was written -, yet the list's version
    // replaced exactly what this vault has: that is as good as one.
    const known = base?.hash ?? (local && listed.prev === local.entry.hash ? local.entry.hash : undefined)
    // Nothing here for this link yet - or only a file of this vault's own that
    // happens to share the name: the note's file comes in next to it.
    if (!local || (known === undefined && !local.entry.via)) {
      await this.deliver(note, ref, listed)
      return
    }
    const ours = local.entry.hash
    if (known !== undefined && ours === known) {
      // Unchanged here. The list moved on - knowingly, or past this version.
      if (listed.prev === known) {
        // Changed here after all, while this waited for the file: the next pass weighs that.
        if (!(await this.attachments.adopt(local.fileId, listed, note.room))) return
        log.info(`${note.file.path}: ${ref} changed in the shared note`)
      } else {
        await this.keepAside(note, ref, local.fileId, listed)
      }
      this.agree(note, ref, listed.hash, local.entry.path)
      return
    }
    if (base && listed.hash === base.hash) {
      // Changed here. A reader's change stays here; the next version from the
      // list meets it as a conflict.
      if (note.canWrite) await this.publish(note, ref, local, base.hash)
      return
    }
    await this.keepAside(note, ref, local.fileId, listed)
    this.agree(note, ref, listed.hash, local.entry.path)
  }

  /**
   * The user's yes for one link - or, without `ref`, for every link the note
   * has now: it is being shared from here, with what it shows. A yes for one
   * link comes from a notice of before 0.9.11, which still works from the
   * notification center.
   */
  approve(docId: string, ref?: string): void {
    if (ref !== undefined) {
      this.approved.add(`${docId}:${ref}`)
    } else {
      const entry = this.store.entry(docId)
      const file = entry ? this.app.vault.getAbstractFileByPath(entry.path) : null
      if (file instanceof TFile) for (const link of this.refsOf(file)) this.approved.add(`${docId}:${link}`)
    }
    this.schedule(docId)
  }

  private agree(note: Note, ref: string, hash: string, path: string): void {
    const base = this.attachments.sharedBase(note.docId, ref)
    if (base?.hash !== hash || base.path !== path) this.attachments.setSharedBase(note.docId, ref, { hash, path })
    this.checkResolves(note, ref, path)
  }

  /** The list names this vault's file for the link; the server lets the others read it first. */
  private async publish(note: Note, ref: string, local: { fileId: string; entry: AttachmentEntry }, prev: string | undefined): Promise<void> {
    const { hash, size, path } = local.entry
    const blob = await this.keys.blobId(hash)
    await this.api.attachBlobs(note.room, { attach: [{ account: this.keys.accountId, vault: this.keys.vaultId, blob }] })
    const listed: SharedAttachment = {
      account: this.keys.accountId,
      vault: this.keys.vaultId,
      blob,
      key: await this.keys.blobKeyForShare(blob),
      hash,
      size,
      updatedAt: Date.now(),
      by: this.keys.accountId
    }
    if (prev) listed.prev = prev
    note.handle.doc.transact(() => note.list.set(ref, listed), ORIGIN)
    this.attachments.setSharedBase(note.docId, ref, prev ? { hash, path, prev } : { hash, path })
    log.info(`${note.file.path}: shares ${path} as ${ref}, ${size} bytes`)
  }

  private async deliver(note: Note, ref: string, listed: SharedAttachment): Promise<void> {
    // A link renamed in the note: the file that came in under the old name
    // follows, rather than coming in twice.
    for (const [other, entry] of note.list.entries()) {
      if (other === ref || note.refs.has(other) || entry.hash !== listed.hash) continue
      const moved = this.attachments.delivered(note.docId, other)
      if (!moved) continue
      const path = this.deliveryPath(note, ref)
      if (path === null) return
      this.attachments.reroute(moved.fileId, { docId: note.docId, ref }, path)
      this.attachments.setSharedBase(note.docId, other, null)
      this.attachments.setSharedBase(note.docId, ref, { hash: listed.hash, path })
      log.info(`${note.file.path}: ${other} was renamed to ${ref}; the file follows`)
      return
    }
    const path = this.deliveryPath(note, ref)
    if (path === null) return
    const fileId = await this.attachments.deliver(path, listed, note.room, { docId: note.docId, ref })
    if (fileId) this.attachments.setSharedBase(note.docId, ref, { hash: listed.hash, path })
  }

  /**
   * `<share folder>/Attachments/<link>`: Obsidian finds a file by the end of
   * its path, so the link resolves as written. For everyone, the owner too:
   * whatever comes in through a share lands in one place.
   */
  private deliveryPath(note: Note, ref: string): string | null {
    const root = [this.options.folder().replace(/^\/+|\/+$/g, ''), 'Attachments'].filter(Boolean).join('/')
    // The link is written by anyone who may write in the note. A backslash is
    // a separator on Windows - `..\..\x` passed a filter of `/` segments -, and a
    // hidden name is nothing Obsidian lists: both made one segment each, and
    // what does not make a plain segment then goes.
    const clean = ref
      .split(/[/\\]/)
      .map((segment) => segment.replace(/^[. ]+|[. ]+$/g, ''))
      .filter(Boolean)
      .join('/')
    const taken = (path: string): boolean => Boolean(this.app.vault.getAbstractFileByPath(path) || this.attachments.fileAt(path))
    const first = `${root}/${clean}`
    if (!isFilePath(first)) {
      log.error(`${note.file.path}: the link ${JSON.stringify(ref)} makes no file path (${vaultPathProblem(first) ?? 'a note'}); its file is left out`)
      return null
    }
    if (!taken(first)) return first
    const second = `${root}/${safeSegment(note.file.basename)}/${clean}`
    let path = second
    for (let n = 2; taken(path); n += 1) path = besides(second, n)
    return path
  }

  private async keepAside(note: Note, ref: string, fileId: string, listed: SharedAttachment): Promise<void> {
    const copy = await this.attachments.keepAsideAndAdopt(fileId, listed, note.room)
    if (!copy) return
    new Notice(
      `${ref} was changed here and in the shared note "${note.file.basename}". Both are kept: this vault's version is ${copy.slice(copy.lastIndexOf('/') + 1)}.`,
      12_000
    )
  }

  /** A file of the user's own with the same name may win the link; links are never rewritten, so say so. */
  private checkResolves(note: Note, ref: string, path: string): void {
    const target = this.app.metadataCache.getFirstLinkpathDest(ref, note.file.path)
    const key = `${note.docId}:${ref}`
    if (!target || target.path === path || this.warned.has(key)) return
    this.warned.add(key)
    log.warn(`${note.file.path}: ${ref} resolves to ${target.path} here, not to the shared ${path}`)
    new Notice(`In "${note.file.basename}", ${ref} shows ${target.path} on this device - a file of the same name. The shared one is ${path}.`, 12_000)
  }

  /**
   * Deleting a file a shared note brings is leaving that file: no device of
   * the account fetches or follows it again, the others keep theirs, and the
   * note stays shared. Bringing it back from the trash rejoins.
   */
  private onLocalChange(change: { kind: 'deleted' | 'restored'; entry: AttachmentEntry }): void {
    const links = change.entry.via ? [change.entry.via] : this.attachments.sharedAt(change.entry.path)
    for (const { docId, ref } of links) {
      if (change.kind === 'deleted') {
        this.attachments.decline(docId, ref)
        log.info(`${change.entry.path}: deleted here, so this account leaves ${ref} of a shared note`)
      } else {
        this.attachments.undecline(docId, ref)
        this.schedule(docId)
      }
    }
  }
}
