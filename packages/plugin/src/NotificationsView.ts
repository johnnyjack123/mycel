import { ItemView, TFile, setIcon, type WorkspaceLeaf } from 'obsidian'
import { notices, type NoticeEntry } from './notices.js'

// The notification center (`docs/TIMEMACHINE.md`, U5): what the plugin said, by
// day, the newest first - the notices that vanish after a few seconds, kept.

export const NOTIFICATIONS_VIEW = 'obsidian-connect-notifications'

function dayOf(at: number): string {
  const day = new Date(at)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 24 * 60 * 60_000)
  const same = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()
  if (same(day, today)) return 'Today'
  if (same(day, yesterday)) return 'Yesterday'
  return day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
}

export class NotificationsView extends ItemView {
  private unwatch: (() => void) | null = null

  constructor(leaf: WorkspaceLeaf) {
    super(leaf)
  }

  getViewType(): string {
    return NOTIFICATIONS_VIEW
  }

  getDisplayText(): string {
    return 'Obsidian Connect notifications'
  }

  getIcon(): string {
    return 'bell'
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('connect-notices')
    this.unwatch = notices.onChange(() => this.render())
    // Shown: what it lists counts as seen - also while it stays open.
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.seeIfShown()))
    this.render()
  }

  async onClose(): Promise<void> {
    this.unwatch?.()
    this.unwatch = null
    this.contentEl.empty()
  }

  private seeIfShown(): void {
    if (this.containerEl.isShown()) notices.markSeen()
  }

  private render(): void {
    const el = this.contentEl
    el.empty()
    const head = el.createDiv({ cls: 'connect-notices-head' })
    head.createEl('h4', { text: 'Notifications' })
    const entries = notices.list()
    if (entries.length > 0) {
      const clear = head.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Clear all' } })
      setIcon(clear, 'trash-2')
      clear.onclick = () => notices.clear()
    }
    if (entries.length === 0) {
      el.createEl('p', { cls: 'connect-notices-quiet', text: 'Nothing yet. What Obsidian Connect tells you shows up here too, and stays for 30 days.' })
      return
    }
    let day = ''
    for (const entry of entries) {
      const label = dayOf(entry.at)
      if (label !== day) {
        day = label
        el.createDiv({ cls: 'connect-notices-day', text: label })
      }
      this.renderEntry(el, entry)
    }
    window.setTimeout(() => this.seeIfShown(), 0)
  }

  private renderEntry(el: HTMLElement, entry: NoticeEntry): void {
    const row = el.createDiv({ cls: `connect-notices-entry is-${entry.kind}` })
    if (notices.isNew(entry)) row.addClass('is-new')
    setIcon(row.createSpan({ cls: 'connect-notices-icon' }), entry.kind === 'error' ? 'alert-triangle' : 'info')
    const body = row.createDiv({ cls: 'connect-notices-body' })
    body.createDiv({ cls: 'connect-notices-text', text: entry.text })
    body.createDiv({ cls: 'connect-notices-time', text: new Date(entry.at).toLocaleTimeString() })
    const file = entry.path ? this.app.vault.getAbstractFileByPath(entry.path) : null
    if (file instanceof TFile) {
      row.addClass('is-link')
      row.setAttr('aria-label', `Open ${file.path}`)
      row.onclick = () => void this.app.workspace.getLeaf(false).openFile(file)
    }
  }
}
