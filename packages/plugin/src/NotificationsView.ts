import { ItemView, TFile, setIcon, type WorkspaceLeaf } from 'obsidian'
import { notices, type NoticeEntry } from './notices.js'
import type { RollbackRecord } from './sync/AccountSettings.js'

// The notification center (`docs/TIMEMACHINE.md`, U5): what the plugin said, by
// day, the newest first - the notices that vanish after a few seconds, kept.
// Beside it, under a tab of its own, every rollback and restore of the account,
// which no clearing takes away: each opens the Time Machine of what it took
// back, at the moment before it (the user, 0.8.16). Titled with the plugin's
// name, since it holds more than notices (the user, 0.8.17).

export const NOTIFICATIONS_VIEW = 'mycel-notifications'

export interface NotificationsHost {
  /** Every rollback and restore of the account, on any of its devices, newest first. */
  rollbacks(): RollbackRecord[]
  onRollbacks(listener: () => void): () => void
  /** Opens the Time Machine of what it took back, at the moment before it. */
  undo(record: RollbackRecord): void
}

type Tab = 'notices' | 'rollbacks'

function dayOf(at: number): string {
  const day = new Date(at)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 24 * 60 * 60_000)
  const same = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()
  if (same(day, today)) return 'Today'
  if (same(day, yesterday)) return 'Yesterday'
  return day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
}

function when(at: number): string {
  return new Date(at).toLocaleString()
}

function plural(count: number, what: string): string {
  return count === 0 ? '' : `${count} ${what}${count === 1 ? '' : 's'}`
}

/** What a rollback took back, in words. */
export function rollbackTitle(record: RollbackRecord): string {
  if (record.kind === 'note') return `The note ${record.folder.slice(record.folder.lastIndexOf('/') + 1).replace(/\.md$/, '')} back to ${when(record.to)}`
  return `${record.folder ? `The folder ${record.folder}` : 'The vault'} back to ${when(record.to)}`
}

export class NotificationsView extends ItemView {
  private unwatch: (() => void) | null = null
  private unwatchRollbacks: (() => void) | null = null
  private tab: Tab = 'notices'

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: NotificationsHost
  ) {
    super(leaf)
  }

  getViewType(): string {
    return NOTIFICATIONS_VIEW
  }

  getDisplayText(): string {
    return 'Mycel'
  }

  getIcon(): string {
    return 'bell'
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('mycel-notices')
    this.unwatch = notices.onChange(() => this.render())
    this.unwatchRollbacks = this.host.onRollbacks(() => {
      if (this.tab === 'rollbacks') this.render()
    })
    // Shown: what it lists counts as seen - also while it stays open.
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.seeIfShown()))
    this.render()
  }

  async onClose(): Promise<void> {
    this.unwatch?.()
    this.unwatch = null
    this.unwatchRollbacks?.()
    this.unwatchRollbacks = null
    this.contentEl.empty()
  }

  /** Shows a tab - the rollbacks when *Undo…* is looked for. */
  show(tab: Tab): void {
    this.tab = tab
    this.render()
  }

  private seeIfShown(): void {
    if (this.tab === 'notices' && this.containerEl.isShown()) notices.markSeen()
  }

  private render(): void {
    const el = this.contentEl
    el.empty()
    const tabs = el.createDiv({ cls: 'mycel-notices-tabs', attr: { role: 'tablist' } })
    const tabButton = (tab: Tab, text: string): void => {
      const button = tabs.createEl('button', { cls: 'mycel-notices-tab', text, attr: { role: 'tab', 'aria-selected': String(this.tab === tab) } })
      button.toggleClass('is-active', this.tab === tab)
      button.onclick = () => this.show(tab)
    }
    tabButton('notices', 'Notifications')
    tabButton('rollbacks', 'Rollbacks')
    if (this.tab === 'rollbacks') this.renderRollbacks(el)
    else this.renderNotices(el)
  }

  private renderNotices(el: HTMLElement): void {
    const entries = notices.list()
    if (entries.length > 0) {
      const head = el.createDiv({ cls: 'mycel-notices-head' })
      head.createDiv({ cls: 'mycel-notices-quiet', text: `${entries.length} kept on this device` })
      const clear = head.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Clear all' } })
      setIcon(clear, 'trash-2')
      clear.onclick = () => notices.clear()
    }
    if (entries.length === 0) {
      el.createEl('p', { cls: 'mycel-notices-quiet', text: 'Nothing yet. What Mycel tells you shows up here too, and stays for 30 days.' })
      return
    }
    let day = ''
    for (const entry of entries) {
      const label = dayOf(entry.at)
      if (label !== day) {
        day = label
        el.createDiv({ cls: 'mycel-notices-day', text: label })
      }
      this.renderEntry(el, entry)
    }
    window.setTimeout(() => this.seeIfShown(), 0)
  }

  private renderEntry(el: HTMLElement, entry: NoticeEntry): void {
    const row = el.createDiv({ cls: `mycel-notices-entry is-${entry.kind}` })
    if (notices.isNew(entry)) row.addClass('is-new')
    setIcon(row.createSpan({ cls: 'mycel-notices-icon' }), entry.kind === 'error' ? 'alert-triangle' : 'info')
    const body = row.createDiv({ cls: 'mycel-notices-body' })
    body.createDiv({ cls: 'mycel-notices-text', text: entry.text })
    body.createDiv({ cls: 'mycel-notices-time', text: new Date(entry.at).toLocaleTimeString() })
    // A notice's button - *Undo* - as long as it was not pressed: the notice itself was gone after a few seconds.
    const action = entry.action
    if (action && notices.canAct(entry)) {
      const button = body.createEl('button', { cls: 'mycel-notices-action mod-cta', text: action.label })
      button.onclick = (event) => {
        event.stopPropagation()
        button.disabled = true
        void notices.act(entry).then(
          () => {
            if (action.again) button.disabled = false
          },
          () => {
            button.disabled = false
          }
        )
      }
    } else if (action?.done) {
      body.createDiv({ cls: 'mycel-notices-time', text: `${action.label}: done` })
    }
    const file = entry.path ? this.app.vault.getAbstractFileByPath(entry.path) : null
    if (file instanceof TFile) {
      row.addClass('is-link')
      row.setAttr('aria-label', `Open ${file.path}`)
      row.onclick = () => void this.app.workspace.getLeaf(false).openFile(file)
    }
  }

  private renderRollbacks(el: HTMLElement): void {
    el.createEl('p', {
      cls: 'mycel-notices-quiet',
      text: 'Every rollback and every note restored from the Time Machine, on any of your devices - kept, the last 50. "Undo in the Time Machine…" opens the Time Machine and goes straight to the moment before it; Restore this version there takes it back, backed up first like every restore.'
    })
    const records = this.host.rollbacks()
    if (records.length === 0) {
      el.createEl('p', { cls: 'mycel-notices-quiet', text: 'None yet.' })
      return
    }
    for (const record of records) {
      const row = el.createDiv({ cls: 'mycel-notices-entry mycel-rollback-entry' })
      if (record.state === 'failed') row.addClass('is-error')
      setIcon(row.createSpan({ cls: 'mycel-notices-icon' }), record.kind === 'note' ? 'file-clock' : 'history')
      const body = row.createDiv({ cls: 'mycel-notices-body' })
      body.createDiv({ cls: 'mycel-notices-text', text: rollbackTitle(record) })
      const changed = [plural(record.notes, 'note'), plural(record.files, 'file')].filter(Boolean).join(' and ') || 'nothing'
      const state = record.state === 'done' ? '' : record.state === 'failed' ? ` - with problems: ${record.error ?? ''}` : ' - it broke off, or still runs'
      body.createDiv({ cls: 'mycel-notices-time', text: `${when(record.startedAt)} · ${record.kind === 'note' ? 'restored' : `${changed} changed`}${state}` })
      const button = body.createEl('button', { cls: 'mycel-notices-action', text: 'Undo in the Time Machine…' })
      button.setAttr('aria-label', 'Opens the Time Machine at the moment before it; Restore this version there takes it back')
      button.onclick = () => this.host.undo(record)
    }
  }
}
