import { App, Modal, Setting } from 'obsidian'
import { Notice } from '../notices.js'
import { busy } from '../busy.js'
import { assemble, compare, type Choice, type Hunk, type Review } from '../sync/Reviews.js'

const CONTEXT_LINES = 2

const CHOICES: Array<{ choice: Choice; label: string }> = [
  { choice: 'mine', label: 'This device' },
  { choice: 'theirs', label: 'Other version' },
  { choice: 'both', label: 'Both' }
]

function lines(text: string): string[] {
  const split = text.split('\n')
  if (split[split.length - 1] === '') split.pop()
  return split
}

/**
 * The two versions of a note side by side, passage by passage. Whatever is
 * chosen replaces the note on every device, as an edit that can be undone
 * from the history; the note is backed up first.
 */
export class ReviewModal extends Modal {
  private hunks: Hunk[] = []
  private choices: Choice[] = []
  private preview: HTMLElement | null = null

  constructor(
    app: App,
    private readonly review: Review,
    private readonly apply: (text: string) => Promise<'applied' | 'merged'>,
    private readonly dismiss: () => Promise<void>
  ) {
    super(app)
  }

  onOpen(): void {
    this.modalEl.addClass('mycel-review-modal')
    this.titleEl.setText(`Compare versions: ${this.review.path}`)
    this.hunks = compare(this.review.mine, this.review.theirs)
    this.choices = this.hunks.filter((hunk) => !hunk.same).map((): Choice => 'both')
    this.render()
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        this.review.kind === 'no-base'
          ? `This note said different things on your devices when they met (${new Date(this.review.at).toLocaleString()}), and nothing told which side changed what. Both versions were kept. Choose per passage what stays.`
          : `This note was changed in the same place on two devices (${new Date(this.review.at).toLocaleString()}). Both changes were kept. Choose per passage what stays.`
    })

    new Setting(contentEl)
      .setName('Everywhere at once')
      .addButton((button) => button.setButtonText("This device's version").onClick(() => this.chooseAll('mine')))
      .addButton((button) => button.setButtonText('The other version').onClick(() => this.chooseAll('theirs')))
      .addButton((button) => button.setButtonText('Both').onClick(() => this.chooseAll('both')))

    const list = contentEl.createDiv({ cls: 'mycel-review-list' })
    let index = 0
    for (const hunk of this.hunks) {
      if (hunk.same) this.renderSame(list, hunk.mine)
      else this.renderHunk(list, hunk, index++)
    }

    contentEl.createEl('div', { cls: 'mycel-review-heading', text: 'The note will say' })
    this.preview = contentEl.createEl('pre', { cls: 'mycel-history-preview' })
    this.updatePreview()

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText('Apply')
          .setCta()
          .onClick(() => void busy(button, () => this.submit()))
      )
      .addButton((button) =>
        button
          .setButtonText('Keep it as it is')
          .setTooltip('Both versions stay in the note, and this review goes away')
          .onClick(() => void busy(button, () => this.keep()))
      )
  }

  private renderSame(parent: HTMLElement, text: string): void {
    const all = lines(text)
    const shown =
      all.length <= CONTEXT_LINES * 2 + 1
        ? all
        : [...all.slice(0, CONTEXT_LINES), `… ${all.length - CONTEXT_LINES * 2} unchanged lines …`, ...all.slice(-CONTEXT_LINES)]
    parent.createEl('pre', { cls: 'mycel-review-same', text: shown.join('\n') })
  }

  private renderHunk(parent: HTMLElement, hunk: Hunk, index: number): void {
    const box = parent.createDiv({ cls: 'mycel-review-hunk' })
    const sides = box.createDiv({ cls: 'mycel-review-sides' })
    for (const [label, text, cls] of [
      ['This device', hunk.mine, 'is-mine'],
      ['Other version', hunk.theirs, 'is-theirs']
    ] as const) {
      const side = sides.createDiv({ cls: `mycel-review-side ${cls}` })
      side.createDiv({ cls: 'mycel-review-label', text: label })
      side.createEl('pre', { text: text.length > 0 ? text.replace(/\n$/, '') : '(nothing)' })
    }
    const buttons = box.createDiv({ cls: 'mycel-review-choices' })
    for (const { choice, label } of CHOICES) {
      const button = buttons.createEl('button', { text: label })
      if (this.choices[index] === choice) button.addClass('is-active')
      button.addEventListener('click', () => {
        this.choices[index] = choice
        for (const other of Array.from(buttons.children)) other.removeClass('is-active')
        button.addClass('is-active')
        this.updatePreview()
      })
    }
  }

  private chooseAll(choice: Choice): void {
    this.choices = this.choices.map(() => choice)
    this.render()
  }

  private updatePreview(): void {
    if (this.preview) this.preview.setText(assemble(this.hunks, this.choices))
  }

  private async submit(): Promise<void> {
    try {
      const outcome = await this.apply(assemble(this.hunks, this.choices))
      new Notice(
        outcome === 'applied'
          ? `${this.review.path} now says what you chose, on all your devices.`
          : `${this.review.path} had changed since; your choice was merged into it. A backup is in the plugin folder.`
      )
      this.close()
    } catch (error) {
      new Notice(`Applying failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async keep(): Promise<void> {
    await this.dismiss()
    this.close()
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

/** Every note waiting for a review, to pick one. */
export class ReviewListModal extends Modal {
  constructor(
    app: App,
    private readonly reviews: Review[],
    private readonly compareOne: (review: Review) => void
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText('Notes with two versions')
    if (this.reviews.length === 0) {
      this.contentEl.createEl('p', { text: 'None. Every note says one thing on all your devices.' })
      return
    }
    for (const review of this.reviews) {
      new Setting(this.contentEl)
        .setName(review.path)
        .setDesc(`${review.kind === 'no-base' ? 'Differed between devices' : 'Changed in the same place twice'} · ${new Date(review.at).toLocaleString()}`)
        .addButton((button) =>
          button
            .setButtonText('Compare')
            .setCta()
            .onClick(() => {
              this.close()
              this.compareOne(review)
            })
        )
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
