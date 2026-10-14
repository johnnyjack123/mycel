import type { TFile } from 'obsidian'
import { docRoom } from '@obsidian-connect/shared'
import { ApiError, type ConnectApi } from '../account/api.js'
import type { AttachmentStore } from './AttachmentStore.js'
import type { DocStore } from './DocStore.js'
import { log } from '../log.js'

// A deleted note or file stays restorable as long as the history retention
// keeps its versions: the server still has its document or its content, so
// restoring it is pulling it again. After that a device lets the server
// delete it.

const DAY_MS = 24 * 60 * 60 * 1000

/** One thing in the trash: a note, or any other file of the vault. */
export type DeletedItem =
  | { kind: 'note'; id: string; path: string; deletedAt: number }
  | { kind: 'file'; id: string; path: string; deletedAt: number; size: number }

export class Trash {
  constructor(
    private readonly api: ConnectApi,
    private readonly store: DocStore,
    private readonly retentionDays: () => number,
    private readonly attachments: AttachmentStore | null = null
  ) {}

  /** What can still be restored, newest first. With no retention limit, everything ever deleted. */
  list(now = Date.now()): DeletedItem[] {
    const days = this.retentionDays()
    const since = days > 0 ? now - days * DAY_MS : 0
    const notes: DeletedItem[] = this.store
      .deletedNotes(since)
      .map((note) => ({ kind: 'note', id: note.docId, path: note.path, deletedAt: note.deletedAt }))
    const files: DeletedItem[] = (this.attachments?.isReady ? this.attachments.deletedFiles(since) : []).map((file) => ({
      kind: 'file',
      id: file.fileId,
      path: file.path,
      deletedAt: file.deletedAt,
      size: file.size
    }))
    return [...notes, ...files].sort((a, b) => b.deletedAt - a.deletedAt)
  }

  restore(item: DeletedItem): Promise<TFile | null> {
    if (item.kind === 'file') return this.attachments?.restoreDeleted(item.id) ?? Promise.resolve(null)
    return this.store.restoreDeleted(item.id)
  }

  /**
   * Lets go of what was deleted longer ago than the retention. The server
   * keeps a note that is still shared - the others keep theirs - and this
   * asks again next time. Returns how many notes and contents went.
   */
  async purge(now = Date.now()): Promise<number> {
    const days = this.retentionDays()
    if (days <= 0) return 0
    let purged = 0
    for (const note of this.store.expiredDeleted(now - days * DAY_MS)) {
      try {
        await this.api.purge(docRoom(note.docId))
      } catch (error) {
        // Gone already: another device of this account was first, or the
        // note never reached the server.
        if (!(error instanceof ApiError && error.status === 404)) {
          if (!(error instanceof ApiError && error.status === 409)) {
            log.warn(`letting go of the deleted ${note.path} failed`, error)
          }
          continue
        }
      }
      await this.store.forgetDeleted(note.docId)
      purged += 1
    }
    try {
      purged += (await this.attachments?.cleanUp(days, now)) ?? 0
    } catch (error) {
      log.warn('cleaning up attachments on the server failed', error)
    }
    return purged
  }
}
