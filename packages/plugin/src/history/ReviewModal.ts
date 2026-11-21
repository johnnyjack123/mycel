import { App, Modal, Setting, setIcon } from 'obsidian'
import { Notice } from '../notices.js'
import { busy } from '../busy.js'
import { lineChanges, lineText, type Row, type SameRun } from '../sync/align.js'
import { MergeDraft, type Review, type Side } from '../sync/Reviews.js'
import { ConfirmModal } from './TimeMachineModals.js'

/** Lines both versions have shown around a passage before the rest of the run folds away. */
const CONTEXT_LINES = 3

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** A text with its changed ranges marked. */
function marked(el: HTMLElement, text: string, ranges: Array<[number, number]>): void {
  let at = 0
  for (const [from, to] of ranges) {
    if (from > at) el.appendText(text.slice(at, from))
    el.createSpan({ cls: 'mycel-merge-changed', text: text.slice(from, to) })
    at = to
  }
  if (at < text.length) el.appendText(text.slice(at))
}

/** The part of a selection that lies inside one element. */
function selectedIn(range: Range, el: Element): string {
  const part = el.ownerDocument.createRange()
  part.selectNodeContents(el)
  if (range.compareBoundaryPoints(range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset)
  if (range.compareBoundaryPoints(range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset)
  return part.toString()
}

/** A slot's text in its field: the break that ends its last line is the field's end. */
function shown(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

/**
 * The two versions of a note and the note put together from them, as git's merge tools
 * have it (the user, 2026-11-18): this device's version on the left, the other on the
 * right, the result in the middle. Both versions stand whole, line beside line (2026-11-21):
 * what both have on the same rows and already in the middle, lines that resemble each other
 * side by side, a gap opposite a line only one side has. Every passage that differs starts
 * empty and is brought in one at a time - either side, both in the order taken, single lines
 * by their number, or written by hand. Whatever is applied replaces the note on every device,
 * as an edit the history can undo; the note is backed up first. *Done* leaves the note as the
 * merge made it.
 */
export class ReviewModal extends Modal {
  private readonly draft: MergeDraft
  private progressEl: HTMLElement | null = null
  private applyButton: HTMLButtonElement | null = null
  private listEl: HTMLElement | null = null
  private readonly passages: Array<{ el: HTMLElement; render: () => void }> = []
  /** The column a selection began in: copying takes that version's lines alone. */
  private selecting: Side | null = null

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
    this.passages.length = 0
    const at = new Date(this.review.at).toLocaleString()
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: `${
        this.review.kind === 'no-base'
          ? `This note said different things on your devices when they met (${at}), and nothing told which side changed what, so it was merged keeping every line of both.`
          : `This note was changed in the same place on two devices (${at}), and both changes were kept.`
      } Both versions stand here whole, line beside line; what both have is in the middle already. Put each passage that differs together: Take brings a side in, a line's number brings that line alone, or write it yourself. Or press Done if the note is right as it is.`
    })

    const bar = contentEl.createDiv({ cls: 'mycel-merge-bar' })
    this.progressEl = bar.createSpan({ cls: 'mycel-merge-progress' })
    const all = bar.createDiv({ cls: 'mycel-merge-all' })
    const allButton = (label: string, run: () => void): void => {
      const button = all.createEl('button', { text: label })
      button.addEventListener('click', run)
    }
    allButton('Next open passage', () => this.nextOpen())
    allButton('All from this device', () => this.everywhere('mine'))
    allButton('All from the other', () => this.everywhere('theirs'))
    allButton('Empty again', () => this.everywhere(null))

    const list = contentEl.createDiv({ cls: 'mycel-merge-list' })
    this.listEl = list
    list.addEventListener('pointerdown', (event) => this.startSelecting(event))
    list.addEventListener('copy', (event) => this.copy(event))
    const head = list.createDiv({ cls: 'mycel-merge-head' })
    head.createDiv({ cls: 'is-mine', text: 'This device' })
    head.createDiv({ cls: 'is-result', text: 'The note will say' })
    head.createDiv({ cls: 'is-theirs', text: 'Other version' })

    const runs = this.draft.aligned.runs
    let index = 0
    runs.forEach((run, at) => {
      if (run.same) this.renderSame(list, run, at === 0, at === runs.length - 1)
      else this.renderPassage(list, index++)
    })

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

  /** What both versions have, row for row in all three columns; a long run folds its middle away. */
  private renderSame(parent: HTMLElement, run: SameRun, first: boolean, last: boolean): void {
    const group = parent.createDiv({ cls: 'mycel-merge-same' })
    const count = run.mineTo - run.mineFrom
    const row = (k: number): void => {
      this.line(group, 'mine', run.mineFrom + k)
      const middle = group.createDiv({ cls: 'mycel-merge-line is-result' })
      middle.createSpan({ cls: 'mycel-merge-text', text: lineText(this.draft.aligned.mine[run.mineFrom + k] ?? '') })
      this.line(group, 'theirs', run.theirsFrom + k)
    }
    const above = first ? 0 : CONTEXT_LINES
    const below = last ? 0 : CONTEXT_LINES
    if (count <= above + below + 2) {
      for (let k = 0; k < count; k += 1) row(k)
      return
    }
    for (let k = 0; k < above; k += 1) row(k)
    const fold = group.createEl('button', { cls: 'mycel-merge-fold', text: `… ${count - above - below} lines both have - show` })
    fold.addEventListener('click', () => {
      group.empty()
      for (let k = 0; k < count; k += 1) row(k)
    })
    for (let k = count - below; k < count; k += 1) row(k)
  }

  /** One line of a version outside the passages: its number and its text. */
  private line(parent: HTMLElement, side: Side, index: number): void {
    const cell = parent.createDiv({ cls: `mycel-merge-line is-${side}` })
    cell.createSpan({ cls: 'mycel-merge-num', text: String(index + 1) })
    cell.createSpan({ cls: 'mycel-merge-text', text: lineText(this.draft.lines(side)[index] ?? '') })
  }

  /** One passage that differs: each side's way into the middle, its rows, and the middle beside them. */
  private renderPassage(parent: HTMLElement, index: number): void {
    const el = parent.createDiv({ cls: 'mycel-merge-passage' })
    const render = (): void => {
      el.empty()
      const passage = this.draft.passage(index)
      el.toggleClass('is-open', !this.draft.decided(index))
      // A row per line, and one more that takes whatever height the middle needs beyond them.
      el.setCssStyles({ gridTemplateRows: `auto repeat(${passage.rows.length}, auto) 1fr` })
      this.takeCell(el, index, 'mine')
      this.middle(el, index)
      this.takeCell(el, index, 'theirs')
      passage.rows.forEach((row, at) => {
        const changes = row.paired && row.mine !== null && row.theirs !== null ? lineChanges(lineText(this.draft.aligned.mine[row.mine] ?? ''), lineText(this.draft.aligned.theirs[row.theirs] ?? '')) : null
        this.passageLine(el, index, 'mine', row, at + 2, changes?.mine ?? null)
        this.passageLine(el, index, 'theirs', row, at + 2, changes?.theirs ?? null)
      })
    }
    this.passages.push({ el, render })
    render()
  }

  private takeCell(el: HTMLElement, index: number, side: Side): void {
    const cell = el.createDiv({ cls: `mycel-merge-take-cell is-${side}` })
    const taken = this.draft.taken(index, side)
    const empty = this.draft.sideText(index, side).length === 0
    cell.toggleClass('is-taken', taken)
    const button = cell.createEl('button', { cls: 'mycel-merge-take' })
    const icon = button.createSpan({ cls: 'mycel-merge-take-icon' })
    if (taken) {
      setIcon(icon, 'undo-2')
      button.appendText('Give back')
      button.setAttr('aria-label', 'Take this side out of the middle again')
    } else {
      setIcon(icon, side === 'mine' ? 'arrow-right' : 'arrow-left')
      button.appendText(empty ? 'Take: nothing' : 'Take')
      button.setAttr('aria-label', empty ? 'This side has nothing here: decide the passage that way' : 'Bring this side into the middle, after what is there')
    }
    button.addEventListener('click', () => {
      if (taken) this.draft.remove(index, side)
      else this.draft.take(index, side)
      this.changed(index)
    })
  }

  private middle(el: HTMLElement, index: number): void {
    const slot = this.draft.slots[index]
    if (!slot) return
    const middle = el.createDiv({ cls: 'mycel-merge-result' })
    const area = middle.createEl('textarea', {
      cls: 'mycel-merge-slot',
      attr: {
        placeholder: "Empty - bring a side in with Take, a line with its number, or write here",
        'aria-label': `Passage ${index + 1}: what the note will say`,
        spellcheck: 'false'
      }
    })
    area.value = shown(slot.text)
    const fit = (): void => {
      area.setCssStyles({ height: 'auto' })
      area.setCssStyles({ height: `${Math.max(area.scrollHeight, 40)}px` })
    }
    area.addEventListener('input', () => {
      this.draft.edit(index, area.value.length > 0 ? `${area.value}\n` : '')
      el.toggleClass('is-open', !this.draft.decided(index))
      fit()
      this.updateProgress()
    })
    window.requestAnimationFrame(fit)
    if (this.draft.decided(index)) {
      const clear = middle.createEl('button', { cls: 'clickable-icon mycel-merge-clear', attr: { 'aria-label': 'Empty this passage again' } })
      setIcon(clear, 'eraser')
      clear.addEventListener('click', () => {
        this.draft.clear(index)
        this.changed(index)
      })
    }
  }

  /** A line of a passage, or a gap where this side has none; its number takes it alone. */
  private passageLine(el: HTMLElement, index: number, side: Side, row: Row, gridRow: number, changes: Array<[number, number]> | null): void {
    const cell = el.createDiv({ cls: `mycel-merge-line is-${side}` })
    cell.setCssStyles({ gridRow: String(gridRow) })
    const line = side === 'mine' ? row.mine : row.theirs
    if (line === null) {
      cell.addClass('is-gap')
      return
    }
    const picked = this.draft.picked(index, side, line)
    cell.toggleClass('is-picked', picked)
    const whole = this.draft.taken(index, side)
    const number = cell.createEl('button', {
      cls: 'mycel-merge-num',
      text: String(line + 1),
      attr: { 'aria-label': whole ? 'In the middle with its side' : picked ? 'Take this line out of the middle again' : 'Bring this line alone into the middle, after what is there' }
    })
    number.disabled = whole
    number.addEventListener('click', () => {
      this.draft.toggleLine(index, side, line)
      this.changed(index)
    })
    const text = lineText(this.draft.lines(side)[line] ?? '')
    const textEl = cell.createSpan({ cls: 'mycel-merge-text' })
    if (changes) marked(textEl, text, changes)
    else textEl.setText(text)
  }

  private changed(index: number): void {
    this.passages[index]?.render()
    this.updateProgress()
  }

  /** A selection starting in one version stays in it: the other columns let go of the pointer's drag. */
  private startSelecting(event: PointerEvent): void {
    const target = event.target as Element | null
    const cell = target?.closest?.('.mycel-merge-line') ?? null
    this.selecting = cell?.classList.contains('is-mine') ? 'mine' : cell?.classList.contains('is-theirs') ? 'theirs' : null
    this.listEl?.toggleClass('is-selecting-mine', this.selecting === 'mine')
    this.listEl?.toggleClass('is-selecting-theirs', this.selecting === 'theirs')
  }

  /** Copying from one version gives its lines as they read - no numbers, nothing of the other columns. */
  private copy(event: ClipboardEvent): void {
    const side = this.selecting
    const list = this.listEl
    const selection = this.contentEl.ownerDocument.getSelection()
    if (!side || !list || !selection || selection.isCollapsed || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    const parts: string[] = []
    for (const text of Array.from(list.querySelectorAll(`.mycel-merge-line.is-${side} .mycel-merge-text`))) {
      if (range.intersectsNode(text)) parts.push(selectedIn(range, text))
    }
    if (parts.length === 0 || !event.clipboardData) return
    event.clipboardData.setData('text/plain', parts.join('\n'))
    event.preventDefault()
  }

  private everywhere(side: Side | null): void {
    if (side) this.draft.takeAll(side)
    else this.draft.slots.forEach((_slot, index) => this.draft.clear(index))
    for (const each of this.passages) each.render()
    this.updateProgress()
  }

  private nextOpen(): void {
    const index = this.draft.slots.findIndex((_slot, at) => !this.draft.decided(at))
    const el = index >= 0 ? this.passages[index]?.el : null
    if (!el) {
      new Notice('Every passage is decided.')
      return
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.querySelector('textarea')?.focus({ preventScroll: true })
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
    this.passages.length = 0
    this.listEl = null
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
