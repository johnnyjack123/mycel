import type { Position } from './TimeMachine.js'

// The Time Machine's timeline as in macOS (`docs/TIMEMACHINE.md`, U1): upright at
// the right edge of the editors, a bar per moment, the oldest at the top and now
// at the bottom. Near the pointer the bars grow, falling off with the distance -
// a wave -, and the one under it says when it is. A click goes there; on a phone
// a finger drawn along it does the same, and lifting it goes there.

/** How far around the pointer the bars grow, in pixels. */
const REACH_PX = 110
/** How much longer the bar under the pointer is than one at rest. */
const GROW = 3.2
const BAR_MIN_PX = 5
const BAR_MAX_PX = 26

/** How much a bar grows at this distance from the pointer: 1 at rest, `GROW` under it, a smooth wave between. */
export function barScale(distance: number, reach = REACH_PX, grow = GROW): number {
  const d = Math.abs(distance)
  if (d >= reach) return 1
  const wave = Math.cos((d / reach) * (Math.PI / 2)) ** 2
  return 1 + (grow - 1) * wave
}

export interface StripHandlers {
  /** A bar was chosen. */
  select(place: number): void
  label(position: Position): string
}

export class TimeMachineStrip {
  readonly el: HTMLElement
  private readonly list: HTMLElement
  private readonly tip: HTMLElement
  private bars: HTMLElement[] = []
  private positions: Position[] = []
  private place = 0
  private pointerY: number | null = null
  private frame: number | null = null
  private hovered: number | null = null
  private dragging = false

  constructor(
    parent: HTMLElement,
    private readonly handlers: StripHandlers
  ) {
    this.el = parent.createDiv({ cls: 'connect-tm-strip', attr: { tabindex: '0', role: 'listbox', 'aria-label': 'Time Machine timeline' } })
    this.list = this.el.createDiv({ cls: 'connect-tm-strip-bars' })
    this.tip = this.el.createDiv({ cls: 'connect-tm-strip-tip' })
    this.el.addEventListener('pointermove', (event) => this.point(event))
    this.el.addEventListener('pointerdown', (event) => {
      this.dragging = event.pointerType !== 'mouse'
      if (this.dragging) this.el.setPointerCapture(event.pointerId)
      this.point(event)
    })
    this.el.addEventListener('pointerup', (event) => {
      if (this.dragging) this.el.releasePointerCapture(event.pointerId)
      this.dragging = false
      const chosen = this.barAt(event.clientY)
      if (chosen !== null) this.handlers.select(chosen)
      if (event.pointerType !== 'mouse') this.leave()
    })
    this.el.addEventListener('pointerleave', () => {
      if (!this.dragging) this.leave()
    })
    this.el.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowUp') this.handlers.select(Math.max(0, this.place - 1))
      else if (event.key === 'ArrowDown') this.handlers.select(Math.min(this.positions.length - 1, this.place + 1))
      else if (event.key === 'End') this.handlers.select(this.positions.length - 1)
      else return
      event.preventDefault()
    })
  }

  /** Draws the moments; `place` is the one shown. */
  set(positions: Position[], place: number): void {
    const same = positions.length === this.positions.length && positions.every((position, i) => position.at === this.positions[i]?.at)
    const moved = !same || place !== this.place
    this.positions = positions
    this.place = place
    if (!same) this.build()
    this.bars.forEach((bar, i) => bar.toggleClass('is-current', i === place))
    if (moved) this.bars[place]?.scrollIntoView({ block: 'nearest' })
    this.paint()
  }

  private build(): void {
    this.list.empty()
    const count = this.positions.length
    // As many as fit, each at least a few pixels; more than that scrolls.
    const room = Math.max(120, this.el.clientHeight - 16)
    const height = Math.max(BAR_MIN_PX, Math.min(BAR_MAX_PX, Math.floor(room / Math.max(1, count))))
    this.list.style.setProperty('--connect-tm-bar', `${height}px`)
    let day = ''
    this.bars = this.positions.map((position, i) => {
      const bar = this.list.createDiv({ cls: 'connect-tm-bar', attr: { role: 'option', 'aria-label': this.handlers.label(position) } })
      if (!position.tick) bar.addClass('is-now')
      if (position.backup) bar.addClass('is-backup')
      // A day's first moment is drawn a little longer; the words only under the pointer (the user, U1).
      const label = position.tick ? new Date(position.at).toDateString() : 'now'
      if (label !== day) {
        day = label
        bar.addClass('is-day')
      }
      bar.createDiv({ cls: 'connect-tm-bar-line' })
      bar.dataset.place = String(i)
      return bar
    })
  }

  private point(event: PointerEvent): void {
    this.pointerY = event.clientY
    const at = this.barAt(event.clientY)
    if (at !== this.hovered) {
      this.hovered = at
      const position = at === null ? null : this.positions[at]
      this.tip.setText(position ? this.handlers.label(position) : '')
      this.tip.toggleClass('is-shown', position !== null && position !== undefined)
    }
    if (this.frame === null) this.frame = window.requestAnimationFrame(() => this.paint())
  }

  private leave(): void {
    this.pointerY = null
    this.hovered = null
    this.tip.removeClass('is-shown')
    if (this.frame === null) this.frame = window.requestAnimationFrame(() => this.paint())
  }

  private barAt(y: number): number | null {
    let best: number | null = null
    let distance = Number.POSITIVE_INFINITY
    this.bars.forEach((bar, i) => {
      const box = bar.getBoundingClientRect()
      const d = Math.abs(box.top + box.height / 2 - y)
      if (d < distance) {
        distance = d
        best = i
      }
    })
    return best
  }

  private paint(): void {
    this.frame = null
    const y = this.pointerY
    for (const bar of this.bars) {
      let scale = 1
      if (y !== null) {
        const box = bar.getBoundingClientRect()
        scale = barScale(box.top + box.height / 2 - y)
      }
      bar.style.setProperty('--connect-tm-scale', scale.toFixed(3))
    }
    if (this.hovered !== null) {
      const bar = this.bars[this.hovered]
      if (bar) {
        const box = bar.getBoundingClientRect()
        const host = this.el.getBoundingClientRect()
        this.tip.style.top = `${box.top - host.top + box.height / 2}px`
      }
    }
  }

  destroy(): void {
    if (this.frame !== null) window.cancelAnimationFrame(this.frame)
    this.el.remove()
  }
}
