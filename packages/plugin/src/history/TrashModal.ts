import { App, Modal, Notice, Setting } from 'obsidian'
import type { DeletedNote } from '../sync/DocStore.js'
import type { Trash } from '../sync/Trash.js'

/** Deleted notes of this vault that can still be brought back. */
export class TrashModal extends Modal {
  private notes: DeletedNote[] = []

  constructor(
    app: App,
    private readonly trash: Trash,
    private readonly retentionDays: number
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText('Deleted notes')
    this.notes = this.trash.list()
    this.render()
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.createEl('p', {
      text:
        this.retentionDays > 0
          ? `Deleted notes can be restored for ${this.retentionDays} days, on any of your devices. After that the server deletes them.`
          : 'Deleted notes can be restored on any of your devices. The history retention is unlimited, so the server keeps them.'
    })
    if (this.notes.length === 0) {
      contentEl.createEl('p', { text: 'Nothing deleted.' })
      return
    }
    for (const note of this.notes) {
      new Setting(contentEl)
        .setName(note.path)
        .setDesc(`Deleted ${new Date(note.deletedAt).toLocaleString()}`)
        .addButton((button) =>
          button
            .setButtonText('Restore')
            .setCta()
            .onClick(() => void this.restore(note))
        )
    }
  }

  private async restore(note: DeletedNote): Promise<void> {
    try {
      const file = await this.trash.restore(note.docId)
      new Notice(file ? `Restored as ${file.path}.` : `${note.path} comes back as soon as the server answers.`)
      this.notes = this.notes.filter((candidate) => candidate.docId !== note.docId)
      this.render()
    } catch (error) {
      new Notice(`Restoring failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
