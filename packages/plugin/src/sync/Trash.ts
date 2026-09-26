import type { TFile } from 'obsidian'
import { docRoom } from '@obsidian-connect/shared'
import { ApiError, type ConnectApi } from '../account/api.js'
import type { DeletedNote, DocStore } from './DocStore.js'

// A deleted note stays restorable as long as the history retention keeps its
// versions: the server still has its document, so restoring it is pulling it
// again. After that the owner's device lets the server delete it.

const DAY_MS = 24 * 60 * 60 * 1000

export class Trash {
  constructor(
    private readonly api: ConnectApi,
    private readonly store: DocStore,
    private readonly retentionDays: () => number
  ) {}

  /** What can still be restored, newest first. With no retention limit, everything ever deleted. */
  list(now = Date.now()): DeletedNote[] {
    const days = this.retentionDays()
    return this.store.deletedNotes(days > 0 ? now - days * DAY_MS : 0)
  }

  restore(docId: string): Promise<TFile | null> {
    return this.store.restoreDeleted(docId)
  }

  /**
   * Lets go of notes deleted longer ago than the retention. The server keeps
   * a note that is still shared - the others keep theirs - and this asks again
   * next time. Returns how many went.
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
            console.warn(`[obsidian-connect] letting go of the deleted ${note.path} failed`, error)
          }
          continue
        }
      }
      await this.store.forgetDeleted(note.docId)
      purged += 1
    }
    return purged
  }
}
