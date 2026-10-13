import { App, Component, MarkdownRenderer, Modal, Notice, Setting, getLinkpath, type TFile } from 'obsidian'
import { busy } from '../busy.js'
import type { EmbedTarget } from '../sync/AttachmentStore.js'
import type { NoteHistory, Version } from './NoteHistory.js'
import { formatSize, imageType, imageUrl } from './media.js'
import { log } from '../log.js'

// Point-in-time rollback for a single note. The log is decrypted and replayed
// on this device, so this shows what the note actually said at that moment -
// rendered, with the pictures it embedded then, even those deleted since.

/** Where the files a version embeds come from when the vault no longer has them. */
export interface EmbedSource {
  target(link: string): EmbedTarget | null
  content(hash: string): Promise<Uint8Array>
  /** Brings a deleted file back from the trash. */
  restore(fileId: string): Promise<TFile | null>
}

export interface HistoryModalOptions {
  history: NoteHistory
  file: TFile
  /** False for a note shared to read only. */
  canRestore: boolean
  restore: (text: string) => Promise<void>
  embeds?: EmbedSource
}

// A preview fetches no picture larger than this.
const PREVIEW_MAX_BYTES = 20 * 1024 * 1024

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString()
}

export class HistoryModal extends Modal {
  private versions: Version[] = []
  private selected: Version | null = null
  private preview = ''
  private showSource = false
  /** Owns what the Markdown renderer attached to the preview; replaced with it. */
  private previewComponent: Component | null = null
  private readonly urls: string[] = []

  constructor(
    app: App,
    private readonly options: HistoryModalOptions
  ) {
    super(app)
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText(`Version history: ${this.options.file.basename}`)
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

  private dropPreview(): void {
    this.previewComponent?.unload()
    this.previewComponent = null
    for (const url of this.urls.splice(0)) URL.revokeObjectURL(url)
  }

  private render(): void {
    const { contentEl } = this
    this.dropPreview()
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
    new Setting(contentEl).setName(`Preview — ${formatTimestamp(selected.ts)}`).setHeading().addExtraButton((button) =>
      button
        .setIcon(this.showSource ? 'eye' : 'code')
        .setTooltip(this.showSource ? 'Show it rendered' : 'Show the text')
        .onClick(() => {
          this.showSource = !this.showSource
          this.render()
        })
    )
    if (this.showSource) {
      contentEl.createEl('pre', { cls: 'connect-history-preview', text: this.preview.slice(0, 20_000) })
    } else {
      const box = contentEl.createDiv({ cls: 'connect-history-preview connect-history-rendered markdown-rendered' })
      void this.renderPreview(box)
    }

    if (!this.options.canRestore) {
      contentEl.createEl('p', { text: 'This note is shared with you to read only, so it cannot be restored here.' })
      return
    }
    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText('Restore this version')
        .setCta()
        .onClick(() => void busy(button, () => this.restore(selected)))
    )
  }

  private async renderPreview(box: HTMLElement): Promise<void> {
    const component = new Component()
    component.load()
    this.previewComponent = component
    try {
      await MarkdownRenderer.render(this.app, this.preview, box, this.options.file.path, component)
    } catch (error) {
      log.warn('rendering a version failed', error)
      box.empty()
      box.createEl('pre', { text: this.preview.slice(0, 20_000) })
      return
    }
    if (this.previewComponent === component) await this.fillEmbeds(box, component)
  }

  /**
   * Embeds the vault no longer answers - a picture deleted since, or one this
   * device never downloaded - shown from the server instead, a deleted one
   * with a way to bring it back.
   */
  private async fillEmbeds(box: HTMLElement, component: Component): Promise<void> {
    const embeds = this.options.embeds
    if (!embeds) return
    for (const span of Array.from(box.querySelectorAll<HTMLElement>('.internal-embed[src]'))) {
      const link = getLinkpath(span.getAttribute('src') ?? '')
      if (!link || this.app.metadataCache.getFirstLinkpathDest(link, this.options.file.path)) continue
      const target = embeds.target(link)
      if (!target) continue
      span.empty()
      span.addClass('connect-embed-from-server')
      const type = imageType(target.path)
      if (type && target.size <= PREVIEW_MAX_BYTES) {
        try {
          const data = await embeds.content(target.hash)
          if (this.previewComponent !== component) return
          const url = imageUrl(data, type)
          this.urls.push(url)
          span.createEl('img', { attr: { src: url, alt: target.path } })
        } catch (error) {
          log.warn(`fetching ${target.path} for a preview failed`, error)
        }
      }
      const note = span.createDiv({ cls: 'connect-embed-note' })
      note.createSpan({
        text: target.deleted
          ? `${target.path} is in the trash (${formatSize(target.size)}).`
          : `${target.path} is on the server, not on this device (${formatSize(target.size)}).`
      })
      if (target.deleted) {
        const button = note.createEl('button', { text: 'Restore' })
        const spinning = { buttonEl: button, setDisabled: (disabled: boolean) => (button.disabled = disabled) }
        button.onclick = () =>
          void busy(spinning, async () => {
            try {
              const file = await embeds.restore(target.fileId)
              new Notice(file ? `Restored as ${file.path}.` : `${target.path} comes back as soon as the server answers.`)
              this.render()
            } catch (error) {
              new Notice(`Restoring failed: ${error instanceof Error ? error.message : String(error)}`)
            }
          })
      }
    }
  }

  onClose(): void {
    this.dropPreview()
    this.contentEl.empty()
  }
}
