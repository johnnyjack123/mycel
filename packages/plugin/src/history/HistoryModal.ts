import { App, Modal, Notice, Setting, TFile, requestUrl } from 'obsidian'
import { API, docRoom, type HistoryVersion } from '@crdt-sync/shared'

// Point-in-time rollback for a single note. The server replays its update log,
// so this restores what the note actually said at that moment rather than what
// some periodic file snapshot happened to catch.

export interface HistoryModalOptions {
  httpUrl: string
  token: string
  docId: string
  file: TFile
  onRestored: () => void
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString()
}

export class HistoryModal extends Modal {
  private versions: HistoryVersion[] = []
  private selected: number | null = null
  private preview = ''

  constructor(
    app: App,
    private readonly options: HistoryModalOptions
  ) {
    super(app)
  }

  private endpoint(suffix: string): string {
    const room = encodeURIComponent(docRoom(this.options.docId))
    return `${this.options.httpUrl}${API.history}/${room}${suffix}`
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`
    return headers
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText(`History: ${this.options.file.basename}`)
    this.contentEl.createEl('p', { text: 'Loading versions…' })
    try {
      const response = await requestUrl({
        url: this.endpoint('/versions'),
        headers: this.headers()
      })
      const body = response.json as { versions?: HistoryVersion[] }
      // Newest first: that is the one people look for.
      this.versions = (body.versions ?? []).slice().sort((a, b) => b.ts - a.ts)
    } catch (error) {
      console.error('[crdt-sync] loading history failed', error)
      this.contentEl.empty()
      this.contentEl.createEl('p', {
        text: 'Could not reach the server. History lives there, so it is unavailable offline.'
      })
      return
    }
    this.render()
  }

  private async loadPreview(ts: number): Promise<void> {
    try {
      const response = await requestUrl({
        url: this.endpoint(`/text?ts=${ts}`),
        headers: this.headers()
      })
      this.preview = (response.json as { text?: string }).text ?? ''
    } catch (error) {
      console.error('[crdt-sync] loading a previous version failed', error)
      this.preview = ''
    }
    this.render()
  }

  private async restore(ts: number): Promise<void> {
    try {
      await requestUrl({
        url: this.endpoint('/restore'),
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ ts })
      })
      new Notice(
        `${this.options.file.basename} restored to ${formatTimestamp(ts)}. The rollback is itself a version, so it can be undone.`,
        8_000
      )
      this.options.onRestored()
      this.close()
    } catch (error) {
      console.error('[crdt-sync] restoring failed', error)
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

    contentEl.createEl('p', {
      text: `${this.versions.length} version(s). Selecting one shows how the note read at that point.`
    })

    const list = contentEl.createDiv({ cls: 'crdt-history-list' })
    for (const version of this.versions.slice(0, 200)) {
      const row = list.createDiv({ cls: 'crdt-history-row' })
      if (this.selected === version.ts) row.addClass('is-selected')
      row.createSpan({ text: formatTimestamp(version.ts) })
      row.createSpan({ cls: 'crdt-history-size', text: `${version.bytes} B` })
      row.onclick = () => {
        this.selected = version.ts
        void this.loadPreview(version.ts)
      }
    }

    if (this.selected !== null) {
      contentEl.createEl('h4', { text: `Preview — ${formatTimestamp(this.selected)}` })
      const box = contentEl.createEl('pre', { cls: 'crdt-history-preview' })
      box.setText(this.preview.slice(0, 5_000))

      const selected = this.selected
      new Setting(contentEl).addButton((button) =>
        button
          .setButtonText('Restore this version')
          .setCta()
          .onClick(() => {
            void this.restore(selected)
          })
      )
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
