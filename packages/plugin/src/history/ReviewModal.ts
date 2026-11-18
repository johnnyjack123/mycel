import { App, Modal, Setting, setIcon } from 'obsidian'
import { Notice } from '../notices.js'
import { busy } from '../busy.js'
import { MergeDraft, type Review, type Side } from '../sync/Reviews.js'
import { ConfirmModal } from './TimeMachineModals.js'

const CONTEXT_LINES = 2

function lines(text: string): string[] {
  const split = text.split('\n')
  if (split[split.length - 1] === '') split.pop()
  return split
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The two versions of a note and the note put together from them, as git's merge tools
 * have it (the user, 2026-11-18): this device's version on the left, the other on the
 * right, the result in the middle. What both have stands there already; every passage
 * that differs starts empty and is brought in one at a time - either side, both in the
 * order taken, or written by hand. Whatever is applied replaces the note on every device,
 * as an edit the history can undo; the note is backed up first. *Done* leaves the note as
 * the merge made it.
 */
export class ReviewModal extends Modal {
  private readonly draft: MergeDraft
  private progressEl: HTMLElement | null = null
  private applyButton: HTMLButtonElement | null = null
  private readonly rows: Array<{ row: HTMLElement; render: () => void }> = []

  constructor(
    app: App,
    private readonly review: Review,
    private readonly apply: (text: string) => Promise<'applied' | 'merged'>,
    private readonly dismiss: () => Promise<void>
  ) {
    super(app)
    this.draft = new MergeDraft(review.mine, review.theirs)
  }

  onOpen(): void {
    this.modalEl.addClass('mycel-merge-modal')
    this.titleEl.setText(`Compare versions: ${this.review.path}`)
    this.render()
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()
    this.rows.length = 0
    const at = new Date(this.review.at).toLocaleString()
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: `${
        this.review.kind === 'no-base'
          ? `This note said different things on your devices when they met (${at}), and nothing told which side changed what, so it was merged keeping every line of both.`
          : `This note was changed in the same place on two devices (${at}), and both changes were kept.`
      } Put it together here: bring each passage that differs into the middle from either side - both, in the order you take them - or write it yourself. Or press Done if the note is right as it is.`
    })

    const bar = contentEl.createDiv({ cls: 'mycel-merge-bar' })
    this.progressEl = bar.createSpan({ cls: 'mycel-merge-progress' })
    const all = bar.createDiv({ cls: 'mycel-merge-all' })
    const allButton = (label: string, run: () => void): void => {
      const button = all.createEl('button', { text: label })
      button.addEventListener('click', run)
    }
    allButton('Next open passage', () => this.nextOpen())
    allButton("All from this device", () => this.everywhere('mine'))
    allButton('All from the other', () => this.everywhere('theirs'))
    allButton('Empty again', () => this.everywhere(null))

    const list = contentEl.createDiv({ cls: 'mycel-merge-list' })
    const head = list.createDiv({ cls: 'mycel-merge-row mycel-merge-head' })
    head.createDiv({ cls: 'mycel-merge-cell is-mine', text: 'This device' })
    head.createDiv({ cls: 'mycel-merge-cell is-result', text: 'The note will say' })
    head.createDiv({ cls: 'mycel-merge-cell is-theirs', text: 'Other version' })

    let index = 0
    for (const hunk of this.draft.hunks) {
      if (hunk.same) this.renderSame(list, hunk.mine)
      else this.renderPassage(list, index++)
    }

    const buttons = new Setting(contentEl)
    buttons
      .addButton((button) => {
        this.applyButton = button.buttonEl
        button
          .setButtonText('Apply')
          .setCta()
          .onClick(() => void busy(button, () => this.submit()))
      })
      .addButton((button) =>
        button
          .setButtonText('Done')
          .setTooltip('The note stays as it is now; its mark in the file explorer and "Compare versions" go away')
          .onClick(() => void busy(button, () => this.keep()))
      )
    this.updateProgress()
  }

  /** What both versions have: once, across the three columns, the middle of a long run folded. */
  private renderSame(parent: HTMLElement, text: string): void {
    const all = lines(text)
    const el = parent.createEl('pre', { cls: 'mycel-merge-same' })
    if (all.length <= CONTEXT_LINES * 2 + 1) {
      el.setText(all.join('\n'))
      return
    }
    el.setText([...all.slice(0, CONTEXT_LINES), `… ${all.length - CONTEXT_LINES * 2} lines both have - show …`, ...all.slice(-CONTEXT_LINES)].join('\n'))
    el.addClass('is-folded')
    el.setAttr('aria-label', 'Show every line')
    el.addEventListener('click', () => {
      el.removeClass('is-folded')
      el.removeAttribute('aria-label')
      el.setText(all.join('\n'))
    })
  }

  /** One passage that differs: both sides with their way into the middle, and the middle. */
  private renderPassage(parent: HTMLElement, index: number): void {
    const row = parent.createDiv({ cls: 'mycel-merge-row' })
    const render = (): void => {
      row.empty()
      const slot = this.draft.slots[index]
      const hunk = this.draft.hunk(index)
      if (!slot) return
      row.toggleClass('is-open', !this.draft.decided(index))
      this.renderSide(row, index, 'mine', hunk.mine, slot.taken.includes('mine'))
      const middle = row.createDiv({ cls: 'mycel-merge-cell is-result' })
      const area = middle.createEl('textarea', {
        cls: 'mycel-merge-slot',
        attr: {
          placeholder: 'Empty - bring a version in with Take, or write here',
          'aria-label': `Passage ${index + 1}: what the note will say`,
          spellcheck: 'false'
        }
      })
      area.value = slot.text
      const fit = (): void => {
        area.setCssStyles({ height: 'auto' })
        area.setCssStyles({ height: `${Math.max(area.scrollHeight, 40)}px` })
      }
      area.addEventListener('input', () => {
        this.draft.edit(index, area.value)
        row.toggleClass('is-open', !this.draft.decided(index))
        fit()
        this.updateProgress()
      })
      window.requestAnimationFrame(fit)
      if (slot.taken.length > 0 || slot.edited) {
        const clear = middle.createEl('button', { cls: 'clickable-icon mycel-merge-clear', attr: { 'aria-label': 'Empty this passage again' } })
        setIcon(clear, 'eraser')
        clear.addEventListener('click', () => {
          this.draft.clear(index)
          render()
          this.updateProgress()
        })
      }
      this.renderSide(row, index, 'theirs', hunk.theirs, slot.taken.includes('theirs'))
    }
    this.rows.push({ row, render })
    render()
  }

  private renderSide(row: HTMLElement, index: number, side: Side, text: string, taken: boolean): void {
    const cell = row.createDiv({ cls: `mycel-merge-cell is-${side}` })
    cell.toggleClass('is-taken', taken)
    const button = cell.createEl('button', { cls: 'mycel-merge-take' })
    const icon = button.createSpan({ cls: 'mycel-merge-take-icon' })
    if (taken) {
      setIcon(icon, 'undo-2')
      button.appendText('Give back')
      button.setAttr('aria-label', 'Take this side out of the middle again')
    } else {
      setIcon(icon, side === 'mine' ? 'arrow-right' : 'arrow-left')
      button.appendText(text.length > 0 ? 'Take' : 'Take: nothing')
      button.setAttr('aria-label', text.length > 0 ? 'Bring this side into the middle, after what is there' : 'This side has nothing here: decide the passage that way')
    }
    button.addEventListener('click', () => {
      if (taken) this.draft.remove(index, side)
      else this.draft.take(index, side)
      this.rows[index]?.render()
      this.updateProgress()
    })
    cell.createEl('pre', { cls: 'mycel-merge-block', text: text.length > 0 ? text.replace(/\n$/, '') : '(nothing here)' })
  }

  private everywhere(side: Side | null): void {
    if (side) this.draft.takeAll(side)
    else this.draft.slots.forEach((_slot, index) => this.draft.clear(index))
    for (const each of this.rows) each.render()
    this.updateProgress()
  }

  private nextOpen(): void {
    const index = this.draft.slots.findIndex((_slot, at) => !this.draft.decided(at))
    const row = index >= 0 ? this.rows[index]?.row : null
    if (!row) {
      new Notice('Every passage is decided.')
      return
    }
    row.scrollIntoView({ block: 'center', behavior: 'smooth' })
    row.querySelector('textarea')?.focus({ preventScroll: true })
  }

  private updateProgress(): void {
    const total = this.draft.slots.length
    const open = this.draft.open
    this.progressEl?.setText(open === 0 ? `All ${plural(total, 'passage', 'passages')} decided` : `${open} of ${plural(total, 'passage', 'passages')} still open`)
    this.progressEl?.toggleClass('is-open', open > 0)
    this.applyButton?.setAttr('aria-label', open > 0 ? `${plural(open, 'passage', 'passages')} still empty: left out of the note` : 'Write this into the note, on all your devices')
  }

  private async submit(): Promise<void> {
    const open = this.draft.open
    if (open > 0) {
      const go = await new ConfirmModal(
        this.app,
        `${plural(open, 'passage is', 'passages are')} still empty`,
        `Nothing was taken into ${open === 1 ? 'it' : 'them'}, so the text both versions have there is left out of the note. The note is backed up first, and the Time Machine can undo this.`,
        'Apply anyway'
      ).ask()
      if (!go) return
    }
    try {
      const outcome = await this.apply(this.draft.result())
      new Notice(
        outcome === 'applied'
          ? `${this.review.path} now says what you put together, on all your devices.`
          : `${this.review.path} had changed since; what you put together was merged into it. A backup is in the plugin folder.`
      )
      this.close()
    } catch (error) {
      new Notice(`Applying failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async keep(): Promise<void> {
    await this.dismiss()
    new Notice(`${this.review.path}: done - it stays as it is.`)
    this.close()
  }

  onClose(): void {
    this.contentEl.empty()
    this.rows.length = 0
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
