import { ItemView, setIcon, type WorkspaceLeaf } from 'obsidian'
import type { RollbackRecord } from '../sync/AccountSettings.js'
import type { PastItem, TimeMachineSession } from './TimeMachine.js'

// The overview beside the explorer while a folder or the vault shows its past
// (`docs/TIMEMACHINE.md`, U3 and U4): what differs from now and how - the files
// themselves are in the explorer, as they were. A click opens one; *Restore
// just this* takes one back alone; the earlier rollbacks can be undone.

export const TIME_MACHINE_VIEW = 'obsidian-connect-time-machine'

export interface OverviewHost {
  session(): TimeMachineSession | null
  onChange(listener: () => void): () => void
  open(path: string): void
  restore(item: PastItem): void
  rollbacks(folder: string): RollbackRecord[]
  undo(record: RollbackRecord): void
}

const TREE_MAX = 3_000
const ROLLBACKS_SHOWN = 5

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function when(ms: number): string {
  return new Date(ms).toLocaleString()
}

export class TimeMachineView extends ItemView {
  private unwatch: (() => void) | null = null
  private frame: number | null = null
  private onlyDiffering = true
  private selected: string | null = null
  private readonly folderOpen = new Map<string, boolean>()

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: OverviewHost
  ) {
    super(leaf)
  }

  getViewType(): string {
    return TIME_MACHINE_VIEW
  }

  getDisplayText(): string {
    return 'Time Machine'
  }

  getIcon(): string {
    return 'history'
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('connect-tm')
    this.unwatch = this.host.onChange(() => this.schedule())
    this.render()
  }

  async onClose(): Promise<void> {
    this.unwatch?.()
    this.unwatch = null
    if (this.frame !== null) window.cancelAnimationFrame(this.frame)
    this.contentEl.empty()
  }

  private schedule(): void {
    if (this.frame !== null) return
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null
      this.render()
    })
  }

  private render(): void {
    const el = this.contentEl
    const scrolled = el.querySelector('.connect-tm-tree')?.scrollTop ?? 0
    el.empty()
    const session = this.host.session()
    if (!session) {
      el.createEl('p', {
        cls: 'connect-tm-quiet',
        text: "The Time Machine is closed. Open it from a folder's menu, a note's menu, the command palette or Settings → Backups."
      })
      return
    }
    const position = session.position
    el.createEl('h4', { text: position?.tick ? session.describe(position) : 'Now' })
    if (!position?.tick) {
      el.createEl('p', {
        cls: 'connect-tm-quiet',
        text: 'Move along the timeline at the right edge: the explorer and every note show that moment, and this lists what differs from now.'
      })
      this.renderRollbacks(el, session)
      return
    }
    if (session.progress) el.createDiv({ cls: 'connect-tm-quiet', text: `Showing it: ${session.progress.done} of ${session.progress.of} notes and files filled in…` })
    const head = el.createDiv({ cls: 'connect-tm-tree-head' })
    const label = head.createEl('label', { cls: 'connect-tm-switch' })
    const toggle = label.createEl('input', { type: 'checkbox' })
    toggle.checked = this.onlyDiffering
    label.appendText(' Only what differs from now')
    toggle.onchange = () => {
      this.onlyDiffering = toggle.checked
      this.folderOpen.clear()
      this.render()
    }
    const items = session.items
    const differs = (item: PastItem): boolean => item.back || item.goes || item.moved || item.changed !== false
    const differing = items.filter(differs).length
    head.createDiv({ cls: 'connect-tm-quiet', text: `${differing} differ${differing === 1 ? 's' : ''} from now.` })
    const tree = el.createDiv({ cls: 'connect-tm-tree' })
    this.renderTree(tree, (this.onlyDiffering ? items.filter(differs) : items).slice(), session)
    tree.scrollTop = scrolled
    const chosen = this.selected ? items.find((item) => (item.pathThen ?? item.pathNow) === this.selected) : undefined
    if (chosen) this.renderChosen(el, chosen, session)
    this.renderRollbacks(el, session)
  }

  private renderTree(el: HTMLElement, shown: PastItem[], session: TimeMachineSession): void {
    if (shown.length === 0) {
      el.createEl('p', { cls: 'connect-tm-quiet', text: 'Everything here is as it is now.' })
      return
    }
    shown.sort((a, b) => (a.pathThen ?? a.pathNow ?? '').localeCompare(b.pathThen ?? b.pathNow ?? ''))
    interface Folder {
      folders: Map<string, Folder>
      items: PastItem[]
    }
    const root: Folder = { folders: new Map(), items: [] }
    const prefix = session.folder ? `${session.folder}/` : ''
    for (const item of shown.slice(0, TREE_MAX)) {
      const parts = (item.pathThen ?? item.pathNow ?? '').slice(prefix.length).split('/')
      parts.pop()
      let folder = root
      for (const part of parts) {
        let next = folder.folders.get(part)
        if (!next) {
          next = { folders: new Map(), items: [] }
          folder.folders.set(part, next)
        }
        folder = next
      }
      folder.items.push(item)
    }
    const draw = (folder: Folder, into: HTMLElement, at: string): void => {
      for (const [name, child] of Array.from(folder.folders).sort(([a], [b]) => a.localeCompare(b))) {
        const path = at ? `${at}/${name}` : name
        const details = into.createEl('details', { cls: 'connect-tm-folder' })
        details.open = this.folderOpen.get(path) ?? this.onlyDiffering
        details.addEventListener('toggle', () => this.folderOpen.set(path, details.open))
        const summary = details.createEl('summary')
        setIcon(summary.createSpan({ cls: 'connect-tm-icon' }), 'folder')
        summary.createSpan({ text: name })
        draw(child, details.createDiv({ cls: 'connect-tm-children' }), path)
      }
      for (const item of folder.items) this.renderItem(into, item)
    }
    draw(root, el.createDiv({ cls: 'connect-tm-list' }), '')
    if (shown.length > TREE_MAX) el.createEl('p', { cls: 'connect-tm-quiet', text: `… and ${shown.length - TREE_MAX} more.` })
  }

  private renderItem(into: HTMLElement, item: PastItem): void {
    const path = item.pathThen ?? item.pathNow ?? ''
    const row = into.createDiv({ cls: 'connect-tm-item' })
    if (this.selected === path) row.addClass('is-selected')
    if (item.goes) row.addClass('is-later')
    setIcon(row.createSpan({ cls: 'connect-tm-icon' }), item.kind === 'note' ? 'file-text' : 'file')
    row.createSpan({ cls: 'connect-tm-name', text: nameOf(path) })
    const mark = (cls: string, text: string, tip: string): void => {
      row.createSpan({ cls: `connect-tm-badge ${cls}`, text, attr: { 'aria-label': tip } })
    }
    if (item.back) mark('is-back', 'deleted since', 'Gone now; Apply brings it back')
    if (item.goes) mark('is-goes', 'added since', 'Not there then; Apply moves it to the trash')
    if (item.moved) mark('is-moved', 'moved', `Now at ${item.pathNow}; Apply moves it back`)
    if (item.changed === true) mark('is-changed', 'changed since', 'Apply gives it its content then')
    if (item.changed === null) mark('is-changed is-unsure', 'changed?', 'The server took changes since; being compared')
    if (item.unreadable) mark('is-foreign', item.unreadable, 'Shown as it is now')
    if (item.foreign) mark('is-foreign', 'shared with you', "Someone else's: Apply leaves it as it is")
    row.onclick = () => {
      this.selected = path
      // Not there then: nothing of it is in the explorer to open.
      if (!item.goes && item.pathThen) this.host.open(item.pathThen)
      this.render()
    }
  }

  private renderChosen(el: HTMLElement, item: PastItem, session: TimeMachineSession): void {
    const box = el.createDiv({ cls: 'connect-tm-actions' })
    box.createDiv({ cls: 'connect-tm-chosen', text: item.pathThen ?? item.pathNow ?? '' })
    const lines: string[] = []
    if (item.goes) lines.push('It did not exist then, so the explorer does not show it now.')
    if (item.back) lines.push('It is gone now; the explorer shows it as it was.')
    if (item.moved) lines.push(`It is at ${item.pathNow} now.`)
    if (item.foreign) lines.push("It is someone else's, shared with you: Apply leaves it as it is - its owner takes it back, for everyone.")
    for (const line of lines) box.createDiv({ cls: 'connect-tm-quiet', text: line })
    const restorable =
      !item.goes && item.pathThen !== null && (item.back || item.changed !== false) && !item.readOnly && !(item.foreign && item.pathNow === null)
    if (restorable && !session.folderOwner) {
      const button = box.createEl('button', { text: item.kind === 'note' ? 'Restore just this note' : 'Restore just this file' })
      button.onclick = () => this.host.restore(item)
      box.createDiv({ cls: 'connect-tm-quiet', text: 'Goes back to now first, then takes this one back alone - a backup of what it is now comes first.' })
    }
  }

  private renderRollbacks(el: HTMLElement, session: TimeMachineSession): void {
    if (session.folderOwner) return
    const records = this.host.rollbacks(session.folder).slice(0, ROLLBACKS_SHOWN)
    if (records.length === 0) return
    const details = el.createEl('details', { cls: 'connect-tm-rollbacks' })
    details.createEl('summary', { text: `Earlier rollbacks: ${records.length}` })
    for (const record of records) {
      const row = details.createDiv({ cls: 'connect-tm-rollback' })
      const state = record.state === 'done' ? 'done' : record.state === 'failed' ? `with problems: ${record.error ?? ''}` : 'broke off, or still running'
      row.createDiv({ text: `${record.folder || 'The vault'} back to ${when(record.to)}` })
      row.createDiv({ cls: 'connect-tm-quiet', text: `On ${when(record.startedAt)}: ${record.notes} notes, ${record.files} files - ${state}` })
      row.createEl('button', { text: 'Undo…' }).onclick = () => this.host.undo(record)
    }
  }
}
