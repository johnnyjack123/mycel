import { Menu, setIcon } from 'obsidian'
import type { TickChoice } from './TimeMachine.js'

// The bar above the editors while the Time Machine shows the past: what it
// shows, how far filling in the moment got, and the two ways out - *Restore this
// version*, and *Abort*, which puts everything back as it was. Over everything
// else on purpose: the vault is not as it is while it stands there (the user:
// states that guard data are shown where they cannot be missed).

export interface BarState {
  title: string
  moment: string
  detail: string
  /** Filling in contents: how far. */
  progress: string | null
  /** Whether *Restore this version* can be done here. */
  restore: boolean
  marks: boolean
  ticks: TickChoice
  backups: boolean | null
  busy: string | null
  /** Which colors the timeline uses besides its own: what they mean is said here (0.8.16). */
  legend: { marks: boolean; backups: boolean }
}

export interface BarHandlers {
  apply(): void
  backToNow(): void
  toggleMarks(on: boolean): void
  setTicks(choice: TickChoice): void
  setBackups(on: boolean): void
  overview(): void
}

const CHOICES: Array<[TickChoice, string]> = [
  ['auto', 'As fine as usual (a note: versions; a folder: five minutes)'],
  ['change', 'Every change'],
  ['minute', 'A minute apart'],
  ['five', 'Five minutes apart'],
  ['hour', 'An hour apart'],
  ['day', 'A day apart']
]

export class TimeMachineBar {
  readonly el: HTMLElement
  private readonly title: HTMLElement
  private readonly moment: HTMLElement
  private readonly detail: HTMLElement
  private readonly legend: HTMLElement
  private readonly buttons: HTMLElement
  private state: BarState | null = null

  constructor(
    parent: HTMLElement,
    private readonly handlers: BarHandlers,
    overview: boolean
  ) {
    this.el = parent.createDiv({ cls: 'mycel-tm-bar-top' })
    const icon = this.el.createSpan({ cls: 'mycel-tm-bar-icon' })
    setIcon(icon, 'history')
    const text = this.el.createDiv({ cls: 'mycel-tm-bar-text' })
    this.title = text.createDiv({ cls: 'mycel-tm-bar-title' })
    const line = text.createDiv({ cls: 'mycel-tm-bar-line2' })
    this.moment = line.createSpan({ cls: 'mycel-tm-bar-moment' })
    this.detail = line.createSpan({ cls: 'mycel-tm-bar-detail' })
    this.legend = line.createSpan()
    this.buttons = this.el.createDiv({ cls: 'mycel-tm-bar-buttons' })
    if (overview) {
      const list = this.buttons.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'What differs from now' } })
      setIcon(list, 'list-tree')
      list.onclick = () => this.handlers.overview()
    }
    const more = this.buttons.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Ticks and backups' } })
    setIcon(more, 'sliders-horizontal')
    more.onclick = (event) => this.menu(event)
  }

  set(state: BarState): void {
    this.state = state
    this.title.setText(state.title)
    this.moment.setText(state.moment)
    this.detail.setText([state.detail, state.busy ?? state.progress ?? ''].filter(Boolean).join(' · '))
    this.legend.empty()
    const swatch = (cls: string, text: string): void => {
      const item = this.legend.createSpan({ cls: 'mycel-tm-legend' })
      item.createSpan({ cls: `mycel-tm-legend-swatch ${cls}` })
      item.appendText(text)
    }
    if (state.legend.marks) swatch('is-mark', 'before an earlier rollback or restore')
    if (state.legend.backups) swatch('is-backup', 'a backup')
    this.buttons.querySelectorAll('.mycel-tm-bar-action').forEach((el) => el.remove())
    const marks = this.buttons.createEl('button', { cls: 'mycel-tm-bar-action', text: state.marks ? 'Changes: shown' : 'Changes: hidden' })
    marks.toggleClass('is-active', state.marks)
    marks.onclick = () => this.handlers.toggleMarks(!state.marks)
    if (state.restore) {
      const restore = this.buttons.createEl('button', { cls: 'mycel-tm-bar-action mod-warning', text: 'Restore this version' })
      restore.disabled = state.busy !== null
      restore.onclick = () => this.handlers.apply()
    }
    const abort = this.buttons.createEl('button', { cls: 'mycel-tm-bar-action mod-cta', text: 'Abort', attr: { 'aria-label': 'Put every file back as it was, unlock the vault and sync again' } })
    abort.disabled = state.busy !== null
    abort.onclick = () => this.handlers.backToNow()
  }

  private menu(event: MouseEvent): void {
    const state = this.state
    if (!state) return
    const menu = new Menu()
    for (const [choice, label] of CHOICES) {
      menu.addItem((item) =>
        item
          .setTitle(label)
          .setChecked(state.ticks === choice)
          .onClick(() => this.handlers.setTicks(choice))
      )
    }
    if (state.backups !== null) {
      menu.addSeparator()
      menu.addItem((item) =>
        item
          .setTitle('Backups too, further back than the history')
          .setChecked(state.backups === true)
          .onClick(() => this.handlers.setBackups(!state.backups))
      )
    }
    menu.showAtMouseEvent(event)
  }

  destroy(): void {
    this.el.remove()
  }
}
