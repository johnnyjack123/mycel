import { App, Modal, Setting, TFile, normalizePath } from 'obsidian'
import { Notice } from '../notices.js'
import type { BackupRecord, BackupStore } from '../sync/BackupStore'
import { busy } from '../busy.js'
import { log } from '../log.js'

// Backups live in the plugin folder, which keeps them out of search and the
// graph but also out of sight. This makes them reachable without a file
// manager, and restoring one is a normal note edit that syncs like any other.

export class BackupModal extends Modal {
  private records: BackupRecord[] = []
  private selected: BackupRecord | null = null
  private preview = ''

  constructor(
    app: App,
    private readonly backups: BackupStore
  ) {
    super(app)
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText('Mycel backups')
    this.contentEl.createEl('p', { text: 'Loading…' })
    try {
      this.records = await this.backups.list()
    } catch (error) {
      log.error('listing backups failed', error)
    }
    this.render()
  }

  private async select(record: BackupRecord): Promise<void> {
    this.selected = record
    try {
      this.preview = await this.backups.read(record.path)
    } catch (error) {
      log.error('reading a backup failed', error)
      this.preview = ''
    }
    this.render()
  }

  private async restore(record: BackupRecord): Promise<void> {
    const target = normalizePath(record.note.replace(/_/g, '/'))
    const file = this.app.vault.getAbstractFileByPath(`${target}.md`)
    if (!(file instanceof TFile)) {
      // The original path is not recoverable from the sanitized file name in
      // every case, so fall back to a new note rather than guessing wrong.
      const created = await this.app.vault.create(
        `${record.note}-restored-${record.day}.md`,
        this.preview
      )
      new Notice(`Backup written to ${created.path}.`)
      this.close()
      return
    }
    await this.app.vault.modify(file, this.preview)
    new Notice(`${file.basename} replaced with the backup from ${record.day}.`)
    this.close()
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()

    if (this.records.length === 0) {
      contentEl.createEl('p', {
        text: 'No backups yet. They are written automatically before any merge that could remove text.'
      })
      return
    }

    contentEl.createEl('p', {
      text: `${this.records.length} backup(s). "local" is what this device had, "remote" the shared document, "merged" the result.`
    })

    const list = contentEl.createDiv({ cls: 'mycel-history-list' })
    for (const record of this.records.slice(0, 300)) {
      const row = list.createDiv({ cls: 'mycel-history-row' })
      if (this.selected?.path === record.path) row.addClass('is-selected')
      row.createSpan({ text: `${record.day} · ${record.note}` })
      row.createSpan({ cls: 'mycel-history-size', text: record.kind })
      row.onclick = () => void this.select(record)
    }

    if (this.selected) {
      const selected = this.selected
      contentEl.createEl('h4', { text: `${selected.note} (${selected.kind})` })
      contentEl.createEl('pre', { cls: 'mycel-history-preview' }).setText(this.preview.slice(0, 5_000))
      new Setting(contentEl).addButton((button) =>
        button
          .setButtonText('Write this back to the note')
          .setWarning()
          .onClick(() =>
            busy(button, () => this.restore(selected)).catch((error: unknown) => {
              log.error('writing a backup back failed', error)
              new Notice(`Writing the backup back failed: ${error instanceof Error ? error.message : String(error)}`)
            })
          )
      )
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
