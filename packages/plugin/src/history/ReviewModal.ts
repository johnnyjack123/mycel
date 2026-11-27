import { App, Modal, Platform, Setting, setIcon } from 'obsidian'
import { Notice } from '../notices.js'
import { busy } from '../busy.js'
import { lineChanges, lineText, type Row, type SameRun } from '../sync/align.js'
import { MergeDraft, versionNames, type Review, type Side } from '../sync/Reviews.js'
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
 * by their number, a range of them from one number to another (0.9.31), or written by hand.
 * Whatever is applied replaces the note on every device, as an edit the history can undo; the
 * note is backed up first. *Done* leaves the note as the merge made it.
 */
export class ReviewModal extends Modal {
  private readonly draft: MergeDraft
  private progressEl: HTMLElement | null = null
  private hintEl: HTMLElement | null = null
  private rangeButton: HTMLButtonElement | null = null
  private applyButton: HTMLButtonElement | null = null
  private listEl: HTMLElement | null = null
  private readonly passages: Array<{ el: HTMLElement; render: () => void }> = []
  /** The column a selection began in: copying takes that version's lines alone. */
  private selecting: Side | null = null
  /** The number clicked last: where a range of lines begins. */
  private anchor: { side: Side; line: number } | null = null
  /** Every number tapped begins or ends a range - for a phone, which has no Shift. */
  private ranging = false

  constructor(
    app: App,
    private readonly review: Review,
    private readonly apply: (text: string) => Promise<'applied' | 'merged'>,
    private readonly dismiss: () => Promise<void>,
    /** What the two versions are called here: "This device" only on the device where they met (`versionNames`). */
    private readonly names: { mine: string; mineWords: string; theirs: string } = { mine: 'This device', mineWords: 'this device', theirs: 'Other version' }
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
    const range = Platform.isMobile
      ? 'with "Range of lines" on, two numbers bring everything from the first to the second as one piece, lines both have included'
      : 'Shift-click a second one and everything from the first to it comes in as one piece, lines both have included'
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: `${
        this.review.kind === 'no-base'
          ? `This note said different things on your devices when they met (${at}), and nothing told which side changed what, so it was merged keeping every line of both.`
          : `This note was changed in the same place on two devices (${at}), and both changes were kept.`
      } Both versions stand here whole, line beside line; what both have is in the middle already. Put each passage that differs together: Take brings a side in, a line's number brings that line alone - ${range} -, or write it yourself. Or press Done if the note is right as it is.`
    })

    const bar = contentEl.createDiv({ cls: 'mycel-merge-bar' })
    this.progressEl = bar.createSpan({ cls: 'mycel-merge-progress' })
    const all = bar.createDiv({ cls: 'mycel-merge-all' })
    const allButton = (label: string, run: () => void): HTMLButtonElement => {
      const button = all.createEl('button', { text: label })
      button.addEventListener('click', run)
      return button
    }
    allButton('Next open passage', () => this.nextOpen())
    allButton(`All from ${this.names.mineWords}`, () => this.everywhere('mine'))
    allButton('All from the other', () => this.everywhere('theirs'))
    allButton('Empty again', () => this.everywhere(null))
    this.rangeButton = allButton('Range of lines', () => this.setRanging(!this.ranging))
    this.rangeButton.setAttr('aria-pressed', 'false')
    this.rangeButton.setAttr(
      'aria-label',
      "On: a line's number begins a range and the next one of the same side ends it - everything from the first to the last goes into the middle as one piece. Shift-click does the same."
    )
    this.hintEl = contentEl.createDiv({ cls: 'mycel-merge-hint' })

    const list = contentEl.createDiv({ cls: 'mycel-merge-list' })
    this.listEl = list
    list.addEventListener('pointerdown', (event) => this.startSelecting(event))
    list.addEventListener('copy', (event) => this.copy(event))
    this.renderList()

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

  /** The three columns, drawn anew when passages were joined or split - where they were scrolled to. */
  private renderList(): void {
    const list = this.listEl
    if (!list) return
    const scrolled = list.scrollTop
    list.empty()
    this.passages.length = 0
    const head = list.createDiv({ cls: 'mycel-merge-head' })
    head.createDiv({ cls: 'is-mine', text: this.names.mine })
    head.createDiv({ cls: 'is-result', text: 'The note will say' })
    head.createDiv({ cls: 'is-theirs', text: this.names.theirs })
    const runs = this.draft.runs
    let index = 0
    runs.forEach((run, at) => {
      if (run.same) this.renderSame(list, run, at === 0, at === runs.length - 1)
      else this.renderPassage(list, index++)
    })
    list.scrollTop = scrolled
    this.markAnchor()
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
      this.markAnchor()
    })
    for (let k = count - below; k < count; k += 1) row(k)
  }

  /** One line of a version outside the passages: its text, and its number, where a range may begin or end. */
  private line(parent: HTMLElement, side: Side, index: number): void {
    const cell = parent.createDiv({ cls: `mycel-merge-line is-${side}` })
    cell.setAttr('data-line', String(index))
    this.number(cell, side, index, null, 'Begin or end a range of lines here: everything from its first line to its last goes into the middle as one piece')
    cell.createSpan({ cls: 'mycel-merge-text', text: lineText(this.draft.lines(side)[index] ?? '') })
  }

  /** A line's number: alone it takes its line - in a passage -, with Shift or "Range of lines" it begins or ends a range. */
  private number(cell: HTMLElement, side: Side, line: number, index: number | null, label: string): HTMLButtonElement {
    const number = cell.createEl('button', { cls: 'mycel-merge-num', text: String(line + 1), attr: { 'aria-label': label } })
    // Shift held, the browser would select the text between the last click and this one.
    number.addEventListener('mousedown', (event) => {
      if (event.shiftKey) event.preventDefault()
    })
    number.addEventListener('click', (event) => this.numberClicked(side, line, event.shiftKey, index))
    return number
  }

  private numberClicked(side: Side, line: number, shift: boolean, index: number | null): void {
    const anchor = this.anchor
    if ((shift || this.ranging) && anchor?.side === side && anchor.line !== line) {
      this.anchor = null
      const runs = this.draft.runs
      const into = this.draft.takeRange(side, anchor.line, line)
      if (this.draft.runs !== runs) this.renderList()
      else if (into !== null) this.changed(into)
      this.markAnchor()
      return
    }
    if (this.ranging) {
      // A range's first line: nothing is taken before its last one.
      this.anchor = anchor?.side === side && anchor.line === line ? null : { side, line }
      this.markAnchor()
      return
    }
    if (index !== null) {
      this.draft.toggleLine(index, side, line)
      this.changed(index)
    }
    this.anchor = { side, line }
    this.markAnchor()
  }

  private setRanging(on: boolean): void {
    this.ranging = on
    this.rangeButton?.toggleClass('mod-cta', on)
    this.rangeButton?.setAttr('aria-pressed', String(on))
    this.markAnchor()
  }

  /** Where a range begins, marked, and what to do next said. */
  private markAnchor(): void {
    const list = this.listEl
    const anchor = this.anchor
    if (list) {
      for (const el of Array.from(list.querySelectorAll('.mycel-merge-line.is-anchor'))) el.classList.remove('is-anchor')
      if (anchor) list.querySelector(`.mycel-merge-line.is-${anchor.side}[data-line="${anchor.line}"]`)?.classList.add('is-anchor')
    }
    const which = anchor?.side === 'mine' ? this.names.mineWords : 'the other version'
    let hint = ''
    if (this.ranging) {
      hint = anchor
        ? `Range from line ${anchor.line + 1} of ${which}: now the number of its last line.`
        : "Range of lines: tap the number of the range's first line."
    } else if (anchor && !Platform.isMobile) {
      hint = `Shift-click another number of ${which} to bring everything from line ${anchor.line + 1} to it into the middle as one piece.`
    }
    this.hintEl?.setText(hint)
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
    const joined = this.draft.passage(index).joined === true
    if (this.draft.decided(index) || joined) {
      const clear = middle.createEl('button', {
        cls: 'clickable-icon mycel-merge-clear',
        attr: { 'aria-label': joined ? 'Empty this passage again, split into the passages it was made of' : 'Empty this passage again' }
      })
      setIcon(clear, 'eraser')
      clear.addEventListener('click', () => {
        if (joined) {
          this.draft.split(index)
          this.renderList()
          return
        }
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
    cell.setAttr('data-line', String(line))
    // Both have it, and a range took it into the passage: the range's now, though both have it.
    cell.toggleClass('is-both', row.same === true)
    const picked = this.draft.picked(index, side, line)
    cell.toggleClass('is-picked', picked)
    const whole = this.draft.taken(index, side)
    const number = this.number(
      cell,
      side,
      line,
      index,
      whole ? 'In the middle with its side' : picked ? 'Take this line out of the middle again, with the range it came in' : 'Bring this line alone into the middle, after what is there'
    )
    number.disabled = whole
    const text = lineText(this.draft.lines(side)[line] ?? '')
    const textEl = cell.createSpan({ cls: 'mycel-merge-text' })
    if (changes) marked(textEl, text, changes)
    else textEl.setText(text)
  }

  private changed(index: number): void {
    this.passages[index]?.render()
    this.updateProgress()
    this.markAnchor()
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
    if (!side) {
      // Every passage empty, and joined ones split again.
      this.draft.reset()
      this.anchor = null
      this.renderList()
      return
    }
    this.draft.takeAll(side)
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
    private readonly compareOne: (review: Review) => void,
    /** This device's id: a review made on another device says where. */
    private readonly deviceId = ''
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
        .setDesc(
          `${review.kind === 'no-base' ? 'Differed between devices' : 'Changed in the same place twice'} · ${new Date(review.at).toLocaleString()}${
            review.deviceId && review.deviceId !== this.deviceId ? ` · met on ${versionNames(review, this.deviceId).mineWords}` : ''
          }`
        )
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
