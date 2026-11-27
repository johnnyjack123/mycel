import { App, Modal, Setting, setIcon } from 'obsidian'
import { Notice } from '../notices.js'
import { busy } from '../busy.js'
import { lineChanges, lineText, type Row, type SameRun } from '../sync/align.js'
import { MergeDraft, versionNames, type Place, type Review, type Side } from '../sync/Reviews.js'
import { ConfirmModal } from './TimeMachineModals.js'

/** Lines both versions have shown around a passage before the rest of the run folds away. */
const CONTEXT_LINES = 3
/** How far a press moves before it is a drag, in pixels. */
const DRAG_AFTER = 5
/** How close to the list's top or bottom a drag scrolls it, and how far each frame, in pixels. */
const SCROLL_EDGE = 40
const SCROLL_STEP = 14

/** A column of the window: one of the versions, or the note being put together. */
type Column = Side | 'result'

/** What a drag carries: lines of a version, which it copies into the middle, or lines of the middle, which it moves. */
type Dragged = { side: Side; lines: number[] } | { ids: number[] }

/** Where a drag goes: a place in the middle, drawn at an edge of `el` - or out of the middle, onto a version. */
type Target = { place: Place; el: HTMLElement; below: boolean } | { remove: true }

interface Drag {
  dragged: Dragged
  ghost: HTMLElement
  marker: HTMLElement
  target: Target | null
  x: number
  y: number
  frame: number | null
}

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

function middleOf(el: Element): number {
  const rect = el.getBoundingClientRect()
  return rect.top + rect.height / 2
}

/**
 * The two versions of a note and the note put together from them, as git's merge tools
 * have it (the user, 2026-11-18): this device's version on the left, the other on the
 * right, the result in the middle. Both versions stand whole, line beside line (2026-11-21):
 * what both have on the same rows and already in the middle, lines that resemble each other
 * side by side, a gap opposite a line only one side has. Every passage that differs starts
 * empty and is brought in one at a time - either side, both in the order taken, or written by
 * hand. Since 0.9.32 lines are dragged, as cards on a board (the user, 2026-11-27): a version's
 * lines by their number into the middle, wherever they belong - between lines both have too -,
 * several selected first with a click each; the middle's by a handle, to elsewhere in it or out
 * of it onto a side. Pointer events, not the browser's drag and drop, which a finger does not
 * reliably start: the numbers and handles take no scrolling, the rest of the window does.
 * Whatever is applied replaces the note on every device, as an edit the history can undo; the
 * note is backed up first. *Done* leaves the note as the merge made it.
 */
export class ReviewModal extends Modal {
  private readonly draft: MergeDraft
  private progressEl: HTMLElement | null = null
  private hintEl: HTMLElement | null = null
  private applyButton: HTMLButtonElement | null = null
  private listEl: HTMLElement | null = null
  private readonly passages: Array<{ el: HTMLElement; render: () => void; middle: () => void }> = []
  /** The column a text selection began in: copying takes that version's lines alone. */
  private selecting: Side | null = null
  /** Lines chosen to be dragged together, in one column: a version's by their number, the middle's by their id. */
  private selected: { column: Column; keys: Set<number> } | null = null
  /** The line clicked last: where a Shift-click selects from. */
  private anchor: number | null = null
  /** A line's number or handle pressed, not yet moved far enough to be a drag. */
  private press: { column: Column; key: number; x: number; y: number } | null = null
  private drag: Drag | null = null
  /** Stops following the pointer after a press. */
  private unlisten: (() => void) | null = null
  /** A drag just ended: the click its release makes selects nothing. */
  private swallowClick = false
  /** The passage whose middle is a text field right now. */
  private editing: number | null = null
  /** The lines of each version in the middle, wherever they were put: marked as taken. */
  private placedLines: Record<Side, Set<number>> = { mine: new Set(), theirs: new Set() }

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
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: `${
        this.review.kind === 'no-base'
          ? `This note said different things on your devices when they met (${at}), and nothing told which side changed what, so it was merged keeping every line of both.`
          : `This note was changed in the same place on two devices (${at}), and both changes were kept.`
      } Both versions stand here whole, line beside line; what both have is in the middle already. Put each passage that differs together: Take brings a side in. Or drag a line by its number into the middle, to where it belongs - between lines both have too; click numbers first to drag several together (Shift-click: every line between). In the middle, drag a line by its handle to move it, or onto a side to take it out again; click into it to write. Or press Done if the note is right as it is.`
    })

    const bar = contentEl.createDiv({ cls: 'mycel-merge-bar' })
    this.progressEl = bar.createSpan({ cls: 'mycel-merge-progress' })
    const all = bar.createDiv({ cls: 'mycel-merge-all' })
    const allButton = (label: string, run: () => void): void => {
      all.createEl('button', { text: label }).addEventListener('click', run)
    }
    allButton('Next open passage', () => this.nextOpen())
    allButton(`All from ${this.names.mineWords}`, () => this.everywhere('mine'))
    allButton('All from the other', () => this.everywhere('theirs'))
    allButton('Empty again', () => this.everywhere(null))
    this.hintEl = contentEl.createDiv({ cls: 'mycel-merge-hint' })

    const list = contentEl.createDiv({ cls: 'mycel-merge-list' })
    this.listEl = list
    list.addEventListener('pointerdown', (event) => this.startSelecting(event))
    list.addEventListener('copy', (event) => this.copy(event))
    list.addEventListener('keydown', (event) => this.keyed(event))
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

  /** The three columns, drawn anew whenever lines went somewhere - where they were scrolled to. */
  private renderList(): void {
    const list = this.listEl
    if (!list) return
    const scrolled = list.scrollTop
    list.empty()
    this.passages.length = 0
    this.refreshPlaced()
    const head = list.createDiv({ cls: 'mycel-merge-head' })
    head.createDiv({ cls: 'is-mine', text: this.names.mine })
    head.createDiv({ cls: 'is-result', text: 'The note will say' })
    head.createDiv({ cls: 'is-theirs', text: this.names.theirs })
    const runs = this.draft.runs
    let index = 0
    runs.forEach((run, at) => {
      if (run.same) this.renderSame(list, run, at, at === 0, at === runs.length - 1)
      else this.renderPassage(list, index++)
    })
    list.scrollTop = scrolled
    this.showSelection()
    this.updateProgress()
  }

  private refreshPlaced(): void {
    this.placedLines = { mine: this.draft.placed('mine'), theirs: this.draft.placed('theirs') }
  }

  /** What both versions have, row for row in all three columns; a long run folds its middle away. */
  private renderSame(parent: HTMLElement, run: SameRun, runIndex: number, first: boolean, last: boolean): void {
    const group = parent.createDiv({ cls: 'mycel-merge-same' })
    const count = run.mineTo - run.mineFrom
    const row = (k: number): void => {
      this.line(group, 'mine', run.mineFrom + k).createSpan({ cls: 'mycel-merge-text', text: lineText(this.draft.aligned.mine[run.mineFrom + k] ?? '') })
      // Where lines dropped between these go: before this one, or after it.
      const middle = group.createDiv({ cls: 'mycel-merge-line is-result', attr: { 'data-run': String(runIndex), 'data-at': String(k) } })
      middle.createSpan({ cls: 'mycel-merge-text', text: lineText(this.draft.aligned.mine[run.mineFrom + k] ?? '') })
      this.line(group, 'theirs', run.theirsFrom + k).createSpan({ cls: 'mycel-merge-text', text: lineText(this.draft.aligned.theirs[run.theirsFrom + k] ?? '') })
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
      this.showSelection()
    })
    for (let k = count - below; k < count; k += 1) row(k)
  }

  /** A line of a version, its number to drag it by - into the middle - and to select it with. */
  private line(parent: HTMLElement, side: Side, line: number): HTMLElement {
    const cell = parent.createDiv({ cls: `mycel-merge-line is-${side}`, attr: { 'data-line': String(line) } })
    cell.toggleClass('is-picked', this.placedLines[side].has(line))
    const number = cell.createEl('button', {
      cls: 'mycel-merge-num',
      text: String(line + 1),
      attr: { 'aria-label': `Line ${line + 1}: drag it into the middle, to where it belongs. A click selects it, to drag several together.` }
    })
    this.handle(number, side, line)
    return cell
  }

  /** One passage that differs, or a place opened between lines both have: each side's way into the middle, its rows, and the middle beside them. */
  private renderPassage(parent: HTMLElement, index: number): void {
    const el = parent.createDiv({ cls: 'mycel-merge-passage' })
    let middleEl: HTMLElement | null = null
    const middle = (): void => {
      if (middleEl) this.renderMiddle(middleEl, el, index)
    }
    const render = (): void => {
      el.empty()
      const passage = this.draft.passage(index)
      el.toggleClass('is-open', !this.draft.decided(index))
      el.toggleClass('is-inserted', passage.inserted === true)
      if (passage.inserted) {
        // Neither version has a line here: a gap on both sides, as long as the middle.
        el.setCssStyles({ gridTemplateRows: 'auto' })
        el.createDiv({ cls: 'mycel-merge-line is-mine is-gap' })
        middleEl = el.createDiv({ cls: 'mycel-merge-result' })
        middle()
        el.createDiv({ cls: 'mycel-merge-line is-theirs is-gap' })
        return
      }
      // A row per line, and one more that takes whatever height the middle needs beyond them.
      el.setCssStyles({ gridTemplateRows: `auto repeat(${passage.rows.length}, auto) 1fr` })
      this.takeCell(el, index, 'mine')
      middleEl = el.createDiv({ cls: 'mycel-merge-result' })
      middle()
      this.takeCell(el, index, 'theirs')
      passage.rows.forEach((row, at) => {
        const changes = row.paired && row.mine !== null && row.theirs !== null ? lineChanges(lineText(this.draft.aligned.mine[row.mine] ?? ''), lineText(this.draft.aligned.theirs[row.theirs] ?? '')) : null
        this.passageLine(el, 'mine', row, at + 2, changes?.mine ?? null)
        this.passageLine(el, 'theirs', row, at + 2, changes?.theirs ?? null)
      })
    }
    this.passages.push({ el, render, middle })
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
    // Decided when clicked: text written in the middle meanwhile may have changed what is taken.
    button.addEventListener('click', () => {
      if (this.draft.taken(index, side)) this.draft.remove(index, side)
      else this.draft.take(index, side)
      this.changed(index)
    })
  }

  /** The middle of a passage: its lines, each with a handle - or, once clicked into, a field to write in. */
  private renderMiddle(middleEl: HTMLElement, passageEl: HTMLElement, index: number): void {
    middleEl.empty()
    middleEl.setAttr('data-passage', String(index))
    if (this.editing === index) this.writing(middleEl, passageEl, index)
    else this.slotLines(middleEl, index)
    if (!this.draft.decided(index)) return
    const clear = middleEl.createEl('button', { cls: 'clickable-icon mycel-merge-clear', attr: { 'aria-label': 'Empty this passage again' } })
    setIcon(clear, 'eraser')
    // Pressed while writing, the field keeps the focus: losing it first drew the middle anew under the click.
    clear.addEventListener('mousedown', (event) => event.preventDefault())
    clear.addEventListener('click', () => {
      this.editing = null
      this.draft.clear(index)
      this.clearSelection(false)
      this.renderList()
    })
  }

  private slotLines(middleEl: HTMLElement, index: number): void {
    const slot = this.draft.slots[index]
    if (!slot) return
    const box = middleEl.createDiv({
      cls: 'mycel-merge-slot',
      attr: { tabindex: '0', 'aria-label': `Passage ${index + 1}: what the note will say. Click or Enter to write in it.` }
    })
    if (slot.items.length === 0) box.createDiv({ cls: 'mycel-merge-placeholder', text: 'Empty - Take a side, drag lines here, or click to write' })
    slot.items.forEach((item, at) => {
      const row = box.createDiv({
        cls: `mycel-merge-item ${'typed' in item ? 'is-typed' : `is-from-${item.side}`}`,
        attr: { 'data-id': String(item.id), 'data-at': String(at) }
      })
      const grip = row.createEl('button', {
        cls: 'mycel-merge-grip',
        attr: { 'aria-label': 'Drag this line to move it, or onto a side to take it out again. A click selects it, to move several together.' }
      })
      setIcon(grip, 'grip-vertical')
      this.handle(grip, 'result', item.id)
      row.createSpan({ cls: 'mycel-merge-text', text: lineText(this.draft.itemText(item)) })
    })
    box.addEventListener('click', (event) => {
      if (this.swallowClick || (event.target as Element | null)?.closest?.('.mycel-merge-grip')) return
      this.startEditing(index)
    })
    box.addEventListener('keydown', (event) => {
      if (event.target !== box || event.key !== 'Enter') return
      event.preventDefault()
      this.startEditing(index)
    })
  }

  private writing(middleEl: HTMLElement, passageEl: HTMLElement, index: number): void {
    const area = middleEl.createEl('textarea', {
      cls: 'mycel-merge-slot',
      attr: { placeholder: 'Empty - write what the note says here', 'aria-label': `Passage ${index + 1}: what the note will say`, spellcheck: 'false' }
    })
    area.value = shown(this.draft.text(index))
    const fit = (): void => {
      area.setCssStyles({ height: 'auto' })
      area.setCssStyles({ height: `${Math.max(area.scrollHeight, 40)}px` })
    }
    area.addEventListener('input', () => {
      this.draft.edit(index, area.value.length > 0 ? `${area.value}\n` : '')
      passageEl.toggleClass('is-open', !this.draft.decided(index))
      fit()
      this.updateProgress()
    })
    area.addEventListener('blur', () => this.stopEditing(index))
    window.requestAnimationFrame(fit)
  }

  private startEditing(index: number): void {
    if (this.editing !== null && this.editing !== index) this.stopEditing(this.editing)
    this.clearSelection()
    this.editing = index
    this.passages[index]?.middle()
    const area = this.passages[index]?.el.querySelector('textarea')
    area?.focus()
    area?.setSelectionRange(area.value.length, area.value.length)
  }

  /** Written: the middle shows its lines again. Only it is drawn anew - a button clicked to leave the field must stay where it was pressed. */
  private stopEditing(index: number): void {
    if (this.editing !== index) return
    this.editing = null
    if (this.draft.tidy()) {
      this.renderList()
      return
    }
    this.refreshPlaced()
    this.passages[index]?.middle()
    for (const cell of Array.from(this.listEl?.querySelectorAll<HTMLElement>('.mycel-merge-line[data-line]') ?? [])) {
      const side: Side = cell.classList.contains('is-mine') ? 'mine' : 'theirs'
      cell.classList.toggle('is-picked', this.placedLines[side].has(Number(cell.getAttribute('data-line'))))
    }
    this.updateProgress()
  }

  /** A line of a passage, or a gap where this side has none. */
  private passageLine(el: HTMLElement, side: Side, row: Row, gridRow: number, changes: Array<[number, number]> | null): void {
    const line = side === 'mine' ? row.mine : row.theirs
    if (line === null) {
      el.createDiv({ cls: `mycel-merge-line is-${side} is-gap` }).setCssStyles({ gridRow: String(gridRow) })
      return
    }
    const cell = this.line(el, side, line)
    cell.setCssStyles({ gridRow: String(gridRow) })
    const text = lineText(this.draft.lines(side)[line] ?? '')
    const textEl = cell.createSpan({ cls: 'mycel-merge-text' })
    if (changes) marked(textEl, text, changes)
    else textEl.setText(text)
  }

  private changed(index: number): void {
    if (this.selected?.column === 'result') this.clearSelection(false)
    this.refreshPlaced()
    this.passages[index]?.render()
    this.updateProgress()
    this.showSelection()
  }

  // --- selecting and dragging lines (0.9.32) ---------------------------------------------------

  /** A line's number or handle: a click selects, a press that moves drags. */
  private handle(el: HTMLElement, column: Column, key: number): void {
    el.addEventListener('pointerdown', (event) => this.pressed(event, column, key))
    // Shift held, the browser would select the text between the last click and this one.
    el.addEventListener('mousedown', (event) => event.preventDefault())
    el.addEventListener('click', (event) => {
      if (this.swallowClick) return
      this.select(column, key, event.shiftKey)
      // Focused, Delete reaches the list.
      el.focus({ preventScroll: true })
    })
  }

  private pressed(event: PointerEvent, column: Column, key: number): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    // A finger's press must not be the start of a text selection either; a mouse's would select text as it moves.
    if (event.pointerType !== 'touch') event.preventDefault()
    // Grabbing a line ends writing in the middle.
    if (this.editing !== null) (this.contentEl.ownerDocument.activeElement as HTMLElement | null)?.blur?.()
    this.unlisten?.()
    this.press = { column, key, x: event.clientX, y: event.clientY }
    const doc = this.contentEl.ownerDocument
    const move = (moved: PointerEvent): void => this.pointerMoved(moved)
    const up = (): void => {
      this.unlisten?.()
      this.released()
    }
    const cancel = (): void => {
      this.unlisten?.()
      this.cancelDrag()
    }
    doc.addEventListener('pointermove', move)
    doc.addEventListener('pointerup', up)
    doc.addEventListener('pointercancel', cancel)
    this.unlisten = () => {
      doc.removeEventListener('pointermove', move)
      doc.removeEventListener('pointerup', up)
      doc.removeEventListener('pointercancel', cancel)
      this.unlisten = null
    }
  }

  private pointerMoved(event: PointerEvent): void {
    const drag = this.drag
    if (drag) {
      event.preventDefault()
      drag.x = event.clientX
      drag.y = event.clientY
      this.aim()
      return
    }
    const press = this.press
    if (!press || Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_AFTER) return
    this.beginDrag(press, event.clientX, event.clientY)
  }

  /** The line pressed - and every line selected with it, when it is one of them. */
  private beginDrag(press: { column: Column; key: number }, x: number, y: number): void {
    const list = this.listEl
    if (!list) return
    const selected = this.selected
    const chosen = selected?.column === press.column && selected.keys.has(press.key) ? [...selected.keys] : [press.key]
    const dragged: Dragged = press.column === 'result' ? { ids: this.inOrder(chosen) } : { side: press.column, lines: chosen.sort((a, b) => a - b) }
    const ghost = list.ownerDocument.body.createDiv({ cls: 'mycel-merge-ghost' })
    const marker = list.createDiv({ cls: 'mycel-merge-drop' })
    this.drag = { dragged, ghost, marker, target: null, x, y, frame: null }
    list.addClass('is-dragging')
    for (const el of this.elementsOf(dragged)) el.classList.add('is-dragging')
    this.aim()
    this.scrollWhileDragging()
  }

  /** Lines of the middle in the order they stand there. */
  private inOrder(ids: number[]): number[] {
    const order = this.draft.items().map((item) => item.id)
    return [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b))
  }

  private elementsOf(dragged: Dragged): Element[] {
    const list = this.listEl
    if (!list) return []
    const selectors = 'ids' in dragged ? dragged.ids.map((id) => `.mycel-merge-item[data-id="${id}"]`) : dragged.lines.map((line) => `.mycel-merge-line.is-${dragged.side}[data-line="${line}"]`)
    return selectors.length > 0 ? Array.from(list.querySelectorAll(selectors.join(','))) : []
  }

  /** Where the pointer is: what a release there would do, drawn. */
  private aim(): void {
    const drag = this.drag
    const list = this.listEl
    if (!drag || !list) return
    drag.ghost.setCssStyles({ left: `${drag.x + 14}px`, top: `${drag.y + 10}px` })
    const target = this.targetAt(drag.x, drag.y, 'ids' in drag.dragged)
    // Between columns or rows the last place stays: the marker does not flicker away.
    if (target !== undefined) drag.target = target
    for (const el of Array.from(list.querySelectorAll('.mycel-merge-result.is-drop'))) el.classList.remove('is-drop')
    const aimed = drag.target
    const removing = aimed !== null && 'remove' in aimed
    drag.ghost.toggleClass('is-removing', removing)
    drag.ghost.setText(removing ? 'Take out of the middle' : this.ghostText(drag.dragged))
    if (!aimed || 'remove' in aimed) {
      drag.marker.setCssStyles({ display: 'none' })
      return
    }
    const rect = aimed.el.getBoundingClientRect()
    const box = list.getBoundingClientRect()
    drag.marker.setCssStyles({
      display: 'block',
      top: `${(aimed.below ? rect.bottom : rect.top) - box.top + list.scrollTop - 1}px`,
      left: `${rect.left - box.left + list.scrollLeft}px`,
      width: `${rect.width}px`
    })
    aimed.el.closest('.mycel-merge-result')?.classList.add('is-drop')
  }

  private ghostText(dragged: Dragged): string {
    const count = 'ids' in dragged ? dragged.ids.length : dragged.lines.length
    if (count !== 1) return `${count} lines`
    let text = ''
    if ('ids' in dragged) {
      const item = this.draft.items().find((each) => each.id === dragged.ids[0])
      text = item ? lineText(this.draft.itemText(item)) : ''
    } else {
      text = lineText(this.draft.lines(dragged.side)[dragged.lines[0] ?? -1] ?? '')
    }
    return text.trim().length > 0 ? text : '(empty line)'
  }

  /**
   * What lies under the pointer: a place in a passage's middle, between its lines by their
   * height; one between lines both have - before the line or after it, by which half -; for
   * lines of the middle, a version, which takes them out. Null outside the list, undefined
   * where nothing is meant (between columns).
   */
  private targetAt(x: number, y: number, fromMiddle: boolean): Target | null | undefined {
    const list = this.listEl
    if (!list) return null
    const doc = list.ownerDocument
    const hit = typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(x, y) : null
    if (!hit || !list.contains(hit)) return null
    const middle = hit.closest<HTMLElement>('.mycel-merge-result')
    if (middle) {
      const passage = Number(middle.getAttribute('data-passage'))
      const items = Array.from(middle.querySelectorAll<HTMLElement>('.mycel-merge-item'))
      const last = items[items.length - 1]
      if (!last) return { place: { passage, at: 0 }, el: middle.querySelector<HTMLElement>('.mycel-merge-slot') ?? middle, below: false }
      const at = items.findIndex((item) => y < middleOf(item))
      return at < 0 ? { place: { passage, at: items.length }, el: last, below: true } : { place: { passage, at }, el: items[at] as HTMLElement, below: false }
    }
    const shared = hit.closest<HTMLElement>('.mycel-merge-same .mycel-merge-line.is-result')
    if (shared) {
      const run = Number(shared.getAttribute('data-run'))
      const at = Number(shared.getAttribute('data-at'))
      const below = y >= middleOf(shared)
      return { place: { run, at: below ? at + 1 : at }, el: shared, below }
    }
    if (fromMiddle && hit.closest('.mycel-merge-line.is-mine, .mycel-merge-line.is-theirs, .mycel-merge-take-cell, .mycel-merge-head .is-mine, .mycel-merge-head .is-theirs')) return { remove: true }
    return undefined
  }

  /** Near the list's top or bottom edge, a drag scrolls it - the place it aims at moving along. */
  private scrollWhileDragging(): void {
    const view = this.listEl?.ownerDocument.defaultView
    if (!view) return
    const step = (): void => {
      const drag = this.drag
      const list = this.listEl
      if (!drag || !list) return
      const box = list.getBoundingClientRect()
      if (box.height > 0) {
        const by = drag.y < box.top + SCROLL_EDGE ? -SCROLL_STEP : drag.y > box.bottom - SCROLL_EDGE ? SCROLL_STEP : 0
        const before = list.scrollTop
        if (by !== 0) list.scrollTop += by
        if (list.scrollTop !== before) this.aim()
      }
      drag.frame = view.requestAnimationFrame(step)
    }
    if (this.drag) this.drag.frame = view.requestAnimationFrame(step)
  }

  private released(): void {
    const drag = this.drag
    this.press = null
    if (!drag) return
    // The release makes a click, on the number pressed for a finger: it is not one.
    this.swallowClick = true
    window.setTimeout(() => {
      this.swallowClick = false
    }, 0)
    this.endDrag()
    const target = drag.target
    const { dragged } = drag
    if (!target) return
    if ('remove' in target) {
      if (!('ids' in dragged)) return
      this.draft.drop(dragged.ids)
    } else if ('ids' in dragged) {
      this.draft.move(dragged.ids, target.place)
    } else {
      this.draft.put(dragged.side, dragged.lines, target.place)
    }
    this.clearSelection(false)
    this.renderList()
  }

  private endDrag(): void {
    const drag = this.drag
    if (!drag) return
    this.drag = null
    if (drag.frame !== null) this.listEl?.ownerDocument.defaultView?.cancelAnimationFrame(drag.frame)
    drag.ghost.remove()
    drag.marker.remove()
    const list = this.listEl
    if (!list) return
    list.removeClass('is-dragging')
    for (const el of Array.from(list.querySelectorAll('.is-dragging, .is-drop'))) el.classList.remove('is-dragging', 'is-drop')
  }

  private cancelDrag(): void {
    this.press = null
    this.endDrag()
  }

  /** A click selects a line or lets it go; Shift-click selects every line from the one clicked before. One column at a time. */
  private select(column: Column, key: number, range: boolean): void {
    if (this.selected?.column !== column) {
      this.selected = { column, keys: new Set() }
      this.anchor = null
    }
    const keys = this.selected.keys
    if (range && this.anchor !== null) {
      for (const each of this.between(column, this.anchor, key)) keys.add(each)
    } else if (keys.has(key)) {
      keys.delete(key)
    } else {
      keys.add(key)
    }
    this.anchor = key
    if (keys.size === 0) this.clearSelection(false)
    this.showSelection()
  }

  /** Every line from one to the other: a version's by number, the middle's in the order they stand. */
  private between(column: Column, from: number, to: number): number[] {
    if (column !== 'result') {
      const lines: number[] = []
      for (let line = Math.min(from, to); line <= Math.max(from, to); line += 1) lines.push(line)
      return lines
    }
    const ids = this.draft.items().map((item) => item.id)
    const a = ids.indexOf(from)
    const b = ids.indexOf(to)
    return a < 0 || b < 0 ? [to] : ids.slice(Math.min(a, b), Math.max(a, b) + 1)
  }

  private clearSelection(show = true): void {
    this.selected = null
    this.anchor = null
    if (show) this.showSelection()
  }

  /** The lines selected, marked, and what to do with them said. */
  private showSelection(): void {
    const list = this.listEl
    const selected = this.selected
    if (list) {
      for (const el of Array.from(list.querySelectorAll('.is-selected'))) el.classList.remove('is-selected')
      const selectors = selected
        ? [...selected.keys].map((key) => (selected.column === 'result' ? `.mycel-merge-item[data-id="${key}"]` : `.mycel-merge-line.is-${selected.column}[data-line="${key}"]`))
        : []
      if (selectors.length > 0) for (const el of Array.from(list.querySelectorAll(selectors.join(',')))) el.classList.add('is-selected')
    }
    const hint = this.hintEl
    if (!hint) return
    hint.empty()
    if (!selected) return
    const count = plural(selected.keys.size, 'line', 'lines')
    hint.createSpan({
      text:
        selected.column === 'result'
          ? `${count} of the middle selected: drag one of them to move them all, or onto a side to take them out again (Delete does that too). `
          : `${count} of ${selected.column === 'mine' ? this.names.mineWords : 'the other version'} selected: drag one of them into the middle, to where they belong. `
    })
    hint.createEl('button', { cls: 'mycel-merge-unselect', text: 'Unselect' }).addEventListener('click', () => this.clearSelection())
  }

  /** Delete or Backspace takes the middle's selected lines out of it. */
  private keyed(event: KeyboardEvent): void {
    const selected = this.selected
    if (!selected || selected.column !== 'result' || (event.key !== 'Delete' && event.key !== 'Backspace')) return
    if ((event.target as Element | null)?.closest?.('textarea')) return
    event.preventDefault()
    this.draft.drop([...selected.keys])
    this.clearSelection(false)
    this.renderList()
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
    this.editing = null
    this.clearSelection(false)
    // Either way, the places opened between lines both have go.
    if (side) this.draft.takeAll(side)
    else this.draft.reset()
    this.renderList()
  }

  private nextOpen(): void {
    const index = this.draft.slots.findIndex((_slot, at) => !this.draft.decided(at))
    const el = index >= 0 ? this.passages[index]?.el : null
    if (!el) {
      new Notice('Every passage is decided.')
      return
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.querySelector<HTMLElement>('.mycel-merge-slot')?.focus({ preventScroll: true })
  }

  private updateProgress(): void {
    const total = this.draft.total
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
    this.unlisten?.()
    this.cancelDrag()
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
