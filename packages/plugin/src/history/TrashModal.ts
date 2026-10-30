import { App, Modal, Setting } from 'obsidian'
import { Notice } from '../notices.js'
import { busy } from '../busy.js'
import type { DeletedItem, Trash } from '../sync/Trash.js'
import { formatSize as size } from './media.js'

/** Deleted notes and files of this vault - or of one folder of it - that can still be brought back. */
export class TrashModal extends Modal {
  private items: DeletedItem[] = []

  constructor(
    app: App,
    private readonly trash: Trash,
    private readonly retentionDays: number,
    private readonly folder: string | null = null
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText(this.folder ? `Deleted in ${this.folder}` : 'Deleted notes and files')
    const prefix = this.folder ? `${this.folder}/` : ''
    this.items = this.trash.list().filter((item) => item.path.startsWith(prefix))
    this.render()
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.createEl('p', {
      text:
        this.retentionDays > 0
          ? `Deleted notes and files can be restored for ${this.retentionDays} days, on any of your devices. After that the server deletes them.`
          : 'Deleted notes and files can be restored on any of your devices. The history retention is unlimited, so the server keeps them.'
    })
    if (this.items.length === 0) {
      contentEl.createEl('p', { text: 'Nothing deleted.' })
      return
    }
    for (const item of this.items) {
      const when = `Deleted ${new Date(item.deletedAt).toLocaleString()}`
      new Setting(contentEl)
        .setName(item.path)
        .setDesc(item.kind === 'file' ? `${when} · ${size(item.size)}` : item.kind === 'folder-note' ? `${when} · in a shared folder` : when)
        .addButton((button) =>
          button
            .setButtonText('Restore')
            .setCta()
            .onClick(() => void busy(button, () => this.restore(item)))
        )
    }
  }

  private async restore(item: DeletedItem): Promise<void> {
    try {
      const file = await this.trash.restore(item)
      new Notice(file ? `Restored as ${file.path}.` : `${item.path} comes back as soon as the server answers.`)
      this.items = this.items.filter((candidate) => candidate.id !== item.id)
      this.render()
    } catch (error) {
      new Notice(`Restoring failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
