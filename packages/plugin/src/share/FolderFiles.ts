import { Notice } from '../notices.js'
import { folderRoom, isFilePath, vaultPathProblem, type AttachmentEntry, type FolderFile, type FolderWrite, type VaultFolder } from '@mycel/shared'
import { deriveFileId, type Bytes } from '@mycel/shared/crypto'
import type { ConnectApi } from '../account/api.js'
import type { SharedBase } from '../sync/AttachmentIndex.js'
import type { AttachmentStore } from '../sync/AttachmentStore.js'
import type { FolderIndex } from '../sync/FolderIndex.js'
import { log } from '../log.js'

// The files of a shared folder (docs/PHASE7.md, E8): every file inside it
// belongs to it and lies at the same place for everyone. The folder's
// document names each one's current content, in the store of whoever put that
// version there; every vault copies it into its own store and keeps it as a
// file of its own, linked to the folder's (`AttachmentEntry.folder`). The rules
// are the ones files of a shared note follow (`SharedFiles`, invariants 23 and
// 24): a base per file per vault, the version each entry replaced, both kept
// when both sides changed, and readers never publish.

/** What sharing a folder's files takes of the key ring. */
export interface FolderFileKeys {
  readonly accountId: string
  readonly vaultId: string
  blobId(hash: string): Promise<string>
  blobKeyForShare(blobId: string): Promise<string>
  folderIdKey(folderId: string, epoch: number): Promise<Bytes | null>
  fileId(path: string, generation: number): Promise<string>
}

/** What a folder's pass leaves alone for now (`reconcile`). */
export interface FileWaits {
  pending(fileId: string): boolean
  undecided(deletedAt: number): boolean
}

function joinPath(mount: string, rel: string): string {
  return mount ? `${mount}/${rel}` : rel
}

function inside(path: string, mount: string): boolean {
  return path.startsWith(`${mount}/`)
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** A base with the write to the folder's document it agrees with, where the document names one. */
function withWrite(base: SharedBase, write: FolderWrite | undefined): SharedBase {
  return write ? { ...base, write } : base
}

/** `photo.png` -> `photo 2.png`. */
function besides(path: string, n: number): string {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  const cut = dot > slash ? dot : path.length
  return `${path.slice(0, cut)} ${n}${path.slice(cut)}`
}

export class FolderFiles {
  private readonly publishing = new Map<string, Promise<void>>()

  constructor(
    private readonly attachments: AttachmentStore,
    private readonly api: ConnectApi,
    private readonly keys: FolderFileKeys,
    /** Whether a path holds anything in this vault. */
    private readonly taken: (path: string) => boolean,
    /** Whether a file this vault let go of in a folder it only reads stays away. */
    private readonly declined: (folderId: string, file: string) => boolean,
    /** The folder's epoch as this device has it, for the ids of new files. */
    private readonly folderEpoch: (folderId: string) => number
  ) {}

  get ready(): boolean {
    return this.attachments.isReady
  }

  private freePlace(path: string): string {
    if (!this.taken(path)) return path
    let n = 2
    while (this.taken(besides(path, n))) n += 1
    return besides(path, n)
  }

  /** The id a new file of the folder gets: the same for everyone in it, from its path in the folder. */
  private async nextFileId(folderId: string, fi: FolderIndex, rel: string): Promise<string> {
    const idKey = await this.keys.folderIdKey(folderId, this.folderEpoch(folderId))
    const derive = (generation: number): Promise<string> =>
      idKey ? deriveFileId(idKey, rel, generation) : this.keys.fileId(`${folderId}/${rel}`, generation)
    let fileId = await derive(0)
    for (let generation = 1; fi.hasFile(fileId); generation += 1) fileId = await derive(generation)
    return fileId
  }

  /**
   * Names this vault's file in the folder: its content stays in this vault's
   * store - the index names only content the server holds (invariant 23) -,
   * attached to the folder's room so everyone in it may read it. One at a
   * time per file: two at once would each take a new id for it.
   */
  async publish(folderId: string, fi: FolderIndex, fileId: string, rel: string, prev?: string): Promise<void> {
    const previous = this.publishing.get(fileId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => this.publishNow(folderId, fi, fileId, rel, prev))
    this.publishing.set(fileId, next)
    try {
      await next
    } finally {
      if (this.publishing.get(fileId) === next) this.publishing.delete(fileId)
    }
  }

  private async publishNow(folderId: string, fi: FolderIndex, fileId: string, rel: string, prev?: string): Promise<void> {
    const entry = this.attachments.entryOf(fileId)
    if (!entry || entry.deletedAt) return
    const blob = await this.keys.blobId(entry.hash)
    await this.api.attachBlobs(folderRoom(folderId), { attach: [{ account: this.keys.accountId, vault: this.keys.vaultId, blob }] })
    const file = entry.folder?.id === folderId ? entry.folder.file : await this.nextFileId(folderId, fi, rel)
    const listed: FolderFile = {
      path: rel,
      account: this.keys.accountId,
      vault: this.keys.vaultId,
      blob,
      key: await this.keys.blobKeyForShare(blob),
      hash: entry.hash,
      size: entry.size,
      updatedAt: Date.now(),
      by: this.keys.accountId
    }
    if (prev) listed.prev = prev
    // The link first: another device of the account that learnt of the file
    // from the folder before its link would take it for new and fetch it twice.
    this.attachments.setFolderLink(fileId, { id: folderId, file })
    fi.setFile(file, listed)
    this.attachments.setFolderBase(folderId, file, withWrite(prev ? { hash: entry.hash, path: rel, prev } : { hash: entry.hash, path: rel }, fi.fileWrite(file)))
    log.info(`${entry.path}: shares its ${prev ? 'new version' : 'content'} in its folder, ${entry.size} bytes`)
  }

  private readonly refused = new Set<string>()

  /** A file the folder names under a path no vault may hold: left out, and said once. */
  private refusePath(folderId: string, file: string, path: unknown): void {
    const key = `${folderId}:${file}:${String(path)}`
    if (this.refused.has(key)) return
    this.refused.add(key)
    log.error(`a shared folder names a file at ${JSON.stringify(String(path))}: ${vaultPathProblem(path) ?? 'not a file'}; left out`)
  }

  /** Every file of this vault's own inside a folder that is not in it yet - when the folder is first shared. */
  async publishAll(folderId: string, fi: FolderIndex, mount: string, isExcluded: (path: string) => boolean): Promise<number> {
    if (!this.ready) return 0
    let published = 0
    for (const { fileId, entry } of this.attachments.liveFiles()) {
      if (!inside(entry.path, mount) || entry.folder || entry.via || isExcluded(entry.path)) continue
      await this.publish(folderId, fi, fileId, entry.path.slice(mount.length + 1))
      published += 1
    }
    return published
  }

  /**
   * Brings this vault's files in line with the folder's: new ones come in,
   * renames follow where the file still lies where the folder had it, new
   * versions come in or go out, a delete for everyone is applied as a delete
   * from another device. `waits.pending`: files whose change here is still
   * being weighed - nothing is decided about them; `waits.undecided`: a
   * delete in this vault another device may still be weighing.
   */
  async reconcile(folderId: string, folder: VaultFolder, fi: FolderIndex, waits: FileWaits, members: Set<string> | null): Promise<void> {
    if (!this.ready) return
    const mount = folder.path
    const write = !folder.owner || folder.role === 'write'
    const room = folderRoom(folderId)
    for (const { fileId: file, entry: listed } of fi.allFiles()) {
      try {
        await this.reconcileOne(folderId, folder, fi, file, listed, { mount, write, room, waits })
      } catch (error) {
        log.warn(`${joinPath(mount, listed.path)}: following the folder's file failed`, error)
      }
    }
    if (!folder.owner && members) await this.adoptLeftovers(folderId, fi, members)
  }

  private async reconcileOne(
    folderId: string,
    folder: VaultFolder,
    fi: FolderIndex,
    file: string,
    listed: FolderFile,
    context: { mount: string; write: boolean; room: string; waits: FileWaits }
  ): Promise<void> {
    const { mount, write, room, waits } = context
    // Written by anyone who may write in the folder: a path that climbs out of
    // it or names something hidden would put their file anywhere here.
    if (!isFilePath(listed.path)) {
      this.refusePath(folderId, file, listed.path)
      return
    }
    const local = this.attachments.linked(folderId, file)
    if (local && waits.pending(local.fileId)) return
    const base = this.attachments.folderBase(folderId, file)
    // The base comes with the vault index, apart from the folder's document:
    // another device of this account renamed the file or put in a version, and
    // its frame for the folder is still on its way here. Taken for the folder's
    // word, the older document moved the file back on every device of the account.
    if (base?.write && !fi.holds(base.write)) return
    if (listed.leftAt) {
      // Taken out of the folder by its owner: what this vault has stays its own.
      if (local) this.attachments.setFolderLink(local.fileId, null)
      this.attachments.setFolderBase(folderId, file, null)
      return
    }
    if (listed.deletedAt) {
      if (!local || local.entry.deletedAt) return
      const changedHere = base !== undefined && local.entry.hash !== base.hash
      // Changed or brought back from the trash here after the delete - on
      // another device of the account, whose index may arrive before the
      // folder's document does: it stays, for everyone from someone who may
      // write, as this vault's own otherwise.
      const since = local.entry.updatedAt > listed.deletedAt
      if (since && write) {
        if (changedHere) await this.publish(folderId, fi, local.fileId, base?.path ?? listed.path, listed.hash)
        else fi.reviveFile(file, base?.path ?? listed.path, this.keys.accountId)
        return
      }
      if (since || changedHere) {
        this.attachments.setFolderLink(local.fileId, null)
        this.attachments.setFolderBase(folderId, file, null)
        return
      }
      this.attachments.deleteFromFolder(local.fileId)
      return
    }
    if (this.declined(folderId, file)) return
    const agreed = (): SharedBase => withWrite({ hash: listed.hash, path: listed.path }, fi.fileWrite(file))
    if (!local) {
      const there = this.attachments.fileAt(joinPath(mount, listed.path))
      if (there && !there.entry.folder && there.entry.hash === listed.hash) {
        // This vault's own file, put into the folder on another of its devices
        // whose link is still on its way: the same file, not a second one.
        this.attachments.setFolderLink(there.fileId, { id: folderId, file })
        this.attachments.setFolderBase(folderId, file, agreed())
        return
      }
      const path = this.freePlace(joinPath(mount, listed.path))
      const fileId = await this.attachments.deliverFromFolder(path, listed, room, { id: folderId, file })
      if (fileId) this.attachments.setFolderBase(folderId, file, agreed())
      return
    }
    if (local.entry.deletedAt) {
      // Brought back in the folder - or a delete here never decided on. Its
      // own place, which its file may still hold, unless another took it.
      if (waits.undecided(local.entry.deletedAt)) return
      const place = joinPath(mount, listed.path)
      const own = local.entry.path === place && this.attachments.fileAt(place) === null
      this.attachments.reviveFromFolder(local.fileId, own ? place : this.freePlace(place))
      return
    }
    // Where it lies: it follows the folder's renames while it lies where the folder had it.
    const rel = base?.path ?? listed.path
    if (listed.path !== rel && local.entry.path === joinPath(mount, rel) && !this.taken(joinPath(mount, listed.path))) {
      this.attachments.renameFromFolder(local.fileId, joinPath(mount, listed.path))
    }
    const now = this.attachments.entryOf(local.fileId) as AttachmentEntry
    const agree = (): void => this.attachments.setFolderBase(folderId, file, agreed())
    if (now.hash === listed.hash) {
      agree()
      return
    }
    // This vault's own newer version is on its way into the folder.
    if (base?.prev !== undefined && listed.hash === base.prev && now.hash === base.hash) return
    const known = base?.hash ?? (listed.prev === now.hash ? now.hash : undefined)
    if (known !== undefined && now.hash === known) {
      // Unchanged here; the folder's version replaced it knowingly, or past it.
      if (listed.prev === known) {
        // Changed here after all, while this waited for the file: the next pass weighs that.
        if (!(await this.attachments.adopt(local.fileId, listed, room))) return
      } else await this.keepAside(local.fileId, listed, room, mount)
      agree()
      return
    }
    if (known !== undefined && listed.hash === known) {
      // Changed here. A reader's change stays here; the next version meets it as a conflict.
      if (write) await this.publish(folderId, fi, local.fileId, listed.path, known)
      return
    }
    await this.keepAside(local.fileId, listed, room, mount)
    agree()
  }

  /**
   * Both kept: the copy is a file new here, and goes into the folder as one
   * (`Folders.createdFile`) when this account may write.
   */
  private async keepAside(fileId: string, listed: FolderFile, room: string, mount: string): Promise<void> {
    const copy = await this.attachments.keepAsideAndAdopt(fileId, listed, room)
    if (!copy) return
    new Notice(
      `${listed.path} was changed here and in the shared folder ${baseName(mount)}. Both are kept: this vault's version is ${baseName(copy)}.`,
      12_000
    )
  }

  /**
   * Content in the store of someone no longer in the folder: the owner names
   * its own copy instead - every vault copies what comes in into its own store,
   * so the owner has it - and the server may let go of theirs.
   */
  private async adoptLeftovers(folderId: string, fi: FolderIndex, members: Set<string>): Promise<void> {
    for (const { fileId: file, entry: listed } of fi.allFiles()) {
      if (listed.deletedAt || listed.leftAt || listed.account === this.keys.accountId || members.has(listed.account)) continue
      const local = this.attachments.linked(folderId, file)
      if (!local || local.entry.deletedAt || local.entry.hash !== listed.hash) continue
      const blob = await this.keys.blobId(listed.hash)
      await this.api.attachBlobs(folderRoom(folderId), { attach: [{ account: this.keys.accountId, vault: this.keys.vaultId, blob }] })
      fi.setFile(file, { ...listed, account: this.keys.accountId, vault: this.keys.vaultId, blob, key: await this.keys.blobKeyForShare(blob) })
      log.info(`${local.entry.path}: its content now lies in the folder owner's store`)
    }
  }

  /** A file renamed inside its folder by someone who may write: the folder's path for it follows. */
  renamedWithin(folderId: string, fi: FolderIndex, fileId: string, rel: string): void {
    const link = this.attachments.entryOf(fileId)?.folder
    if (!link || link.id !== folderId) return
    fi.renameFile(link.file, rel, this.keys.accountId)
    const base = this.attachments.folderBase(folderId, link.file)
    if (base) this.attachments.setFolderBase(folderId, link.file, withWrite({ ...base, path: rel }, fi.fileWrite(link.file)))
  }

  /** The owner took a file out of the folder: everyone keeps what they have. */
  movedOut(folderId: string, fi: FolderIndex, fileId: string): void {
    const link = this.attachments.entryOf(fileId)?.folder
    if (!link || link.id !== folderId) return
    fi.markFileLeft(link.file, this.keys.accountId)
    this.attachments.setFolderLink(fileId, null)
    this.attachments.setFolderBase(folderId, link.file, null)
  }

  /** Deleted here by someone who may write: deleted for everyone. Returns the folder's id for it. */
  deleted(folderId: string, fi: FolderIndex, fileId: string): string | null {
    const link = this.attachments.entryOf(fileId)?.folder
    if (!link || link.id !== folderId) return null
    fi.markFileDeleted(link.file, this.keys.accountId)
    return link.file
  }
}
