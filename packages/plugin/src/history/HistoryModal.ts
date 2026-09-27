import { App, Modal, Notice, Setting, type TFile } from 'obsidian'
import type { NoteHistory, Version } from './NoteHistory.js'
import { log } from '../log.js'

// Point-in-time rollback for a single note. The log is decrypted and replayed
// on this device, so this shows what the note actually said at that moment.

export interface HistoryModalOptions {
  history: NoteHistory
  file: TFile
  /** False for a note shared to read only. */
  canRestore: boolean
  restore: (text: string) => Promise<void>
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString()
}

export class HistoryModal extends Modal {
  private versions: Version[] = []
  private selected: Version | null = null
  private preview = ''

  constructor(
    app: App,
    private readonly options: HistoryModalOptions
  ) {
    super(app)
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText(`History: ${this.options.file.basename}`)
    this.contentEl.createEl('p', { text: 'Loading and decrypting versions…' })
    try {
      await this.options.history.load()
      this.versions = this.options.history.versions()
    } catch (error) {
      log.error('loading history failed', error)
      this.contentEl.empty()
      this.contentEl.createEl('p', {
        text: 'Could not reach the server. History lives there, so it is unavailable offline.'
      })
      return
    }
    this.render()
  }

  private select(version: Version): void {
    this.selected = version
    this.preview = this.options.history.textAt(version.seq)
    this.render()
  }

  private async restore(version: Version): Promise<void> {
    try {
      await this.options.restore(this.options.history.textAt(version.seq))
      new Notice(
        `${this.options.file.basename} restored to ${formatTimestamp(version.ts)}. The rollback is itself a version, so it can be undone.`,
        8_000
      )
      this.close()
    } catch (error) {
      log.error('restoring failed', error)
      new Notice('Restoring failed; see the console.')
    }
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()

    if (this.versions.length === 0) {
      contentEl.createEl('p', { text: 'No versions recorded yet.' })
      return
    }

    const skipped = this.options.history.unreadable
    contentEl.createEl('p', {
      text: `${this.versions.length} version(s). Selecting one shows how the note read at that point.${
        skipped > 0 ? ` ${skipped} change(s) from before you had access are not shown.` : ''
      }`
    })

    const list = contentEl.createDiv({ cls: 'connect-history-list' })
    for (const version of this.versions.slice(0, 200)) {
      const row = list.createDiv({ cls: 'connect-history-row' })
      if (this.selected?.seq === version.seq) row.addClass('is-selected')
      row.createSpan({ text: formatTimestamp(version.ts) })
      row.onclick = () => this.select(version)
    }

    const selected = this.selected
    if (!selected) return
    contentEl.createEl('h4', { text: `Preview — ${formatTimestamp(selected.ts)}` })
    const box = contentEl.createEl('pre', { cls: 'connect-history-preview' })
    box.setText(this.preview.slice(0, 5_000))

    if (!this.options.canRestore) {
      contentEl.createEl('p', { text: 'This note is shared with you to read only, so it cannot be restored here.' })
      return
    }
    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText('Restore this version')
        .setCta()
        .onClick(() => {
          void this.restore(selected)
        })
    )
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
