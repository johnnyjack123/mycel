import { App, Modal, Setting, type TFile } from 'obsidian'
import { Notice } from '../notices.js'
import { busy, type BusyButton } from '../busy.js'
import type { AttachmentStore, FileVersion } from '../sync/AttachmentStore.js'
import { formatSize as size, imageType, imageUrl } from './media.js'
import { log } from '../log.js'

// Earlier contents of a file that is not a note - an image, a PDF, a canvas.
// They live on the server as blobs; a preview is fetched only when one is
// selected.

export class FileVersionsModal extends Modal {
  private versions: FileVersion[] = []
  private selected: FileVersion | null = null
  private previewUrl: string | null = null
  private busy = false

  constructor(
    app: App,
    private readonly attachments: AttachmentStore,
    private readonly file: TFile,
    private readonly retentionDays: number
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText(`Version history: ${this.file.name}`)
    const since = this.retentionDays > 0 ? Date.now() - this.retentionDays * 24 * 60 * 60 * 1000 : 0
    this.versions = this.attachments.versionsOf(this.file, since)
    this.render()
  }

  private dropPreview(): void {
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl)
    this.previewUrl = null
  }

  private async select(version: FileVersion): Promise<void> {
    this.selected = version
    this.dropPreview()
    this.render()
    const type = imageType(this.file.extension)
    if (!type) return
    try {
      const data = await this.attachments.contentOf(version.hash)
      if (this.selected !== version) return
      this.previewUrl = imageUrl(data, type)
      this.render()
    } catch (error) {
      log.warn(`loading a version of ${this.file.path} failed`, error)
      new Notice('Could not reach the server. Earlier versions live there.')
    }
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()
    if (this.versions.length === 0) {
      contentEl.createEl('p', {
        text: 'No earlier versions. A version that was current for less than ten minutes is not kept.'
      })
      return
    }
    contentEl.createEl('p', {
      text: `${this.versions.length} earlier version(s)${this.retentionDays > 0 ? `, kept for ${this.retentionDays} days` : ''}. Restoring one is a change like any other: the current version is kept as an earlier one.`
    })

    const list = contentEl.createDiv({ cls: 'mycel-history-list' })
    for (const version of this.versions) {
      const row = list.createDiv({ cls: 'mycel-history-row' })
      if (this.selected === version) row.addClass('is-selected')
      row.createSpan({ text: `${new Date(version.since).toLocaleString()} – ${new Date(version.at).toLocaleString()}` })
      row.createSpan({ cls: 'mycel-history-size', text: size(version.size) })
      row.onclick = () => void this.select(version)
    }

    const selected = this.selected
    if (!selected) return
    if (this.previewUrl) {
      contentEl.createEl('img', { cls: 'mycel-version-preview', attr: { src: this.previewUrl, alt: this.file.name } })
    } else if (!imageType(this.file.extension)) {
      contentEl.createEl('p', { cls: 'setting-item-description', text: 'No preview for this kind of file. Save it as a copy to open it.' })
    }
    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText('Save as a copy')
          .setDisabled(this.busy)
          .onClick(() => void this.run(async () => {
            const copy = await this.attachments.saveVersionCopy(this.file, selected)
            new Notice(`Saved as ${copy.path}.`)
          }, button))
      )
      .addButton((button) =>
        button
          .setButtonText('Restore this version')
          .setCta()
          .setDisabled(this.busy)
          .onClick(() => void this.run(async () => {
            await this.attachments.restoreVersion(this.file, selected.hash)
            new Notice(`${this.file.name} restored. The version it replaced is kept, so this can be undone.`, 8_000)
          }, button))
      )
  }

  /** `button` spins meanwhile; rendering anew would take it away from under the click. */
  private async run(task: () => Promise<void>, button: BusyButton): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await busy(button, task)
      this.close()
    } catch (error) {
      log.error(`working with an earlier version of ${this.file.path} failed`, error)
      new Notice(`That did not work: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.busy = false
      if (this.contentEl.isConnected) this.render()
    }
  }

  onClose(): void {
    this.dropPreview()
    this.contentEl.empty()
  }
}
