import { App, Modal, Notice, Setting } from 'obsidian'
import type { DeletedItem, Trash } from '../sync/Trash.js'

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Deleted notes and files of this vault that can still be brought back. */
export class TrashModal extends Modal {
  private items: DeletedItem[] = []

  constructor(
    app: App,
    private readonly trash: Trash,
    private readonly retentionDays: number
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText('Deleted notes and files')
    this.items = this.trash.list()
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
        .setDesc(item.kind === 'file' ? `${when} · ${size(item.size)}` : when)
        .addButton((button) =>
          button
            .setButtonText('Restore')
            .setCta()
            .onClick(() => void this.restore(item))
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
