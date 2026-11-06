import type { LockScope } from '../sync/VaultLock.js'

// The file explorer while something is locked (`docs/TIMEMACHINE.md`, the third
// round). Its events are caught before Obsidian's own handlers see them - on the
// document, in the capture phase -, so what it refuses never happens, however the
// explorer is folded, scrolled or sized: the entries carry their paths, nothing
// is measured. What lies outside the Time Machine's scope is greyed by a rule on
// those paths, which also covers entries Obsidian draws later.

export interface ExplorerPolicy {
  /** Opening a file here would leave what the Time Machine shows; null lets it open. */
  refuseOpen(path: string): string | null
  /** Its menu, dragging or renaming here would change something locked; null lets it. */
  refuseChange(path: string): string | null
  /** What stays as it is, everything else greyed; null greys nothing. */
  dimOutside: LockScope | null
}

const EXPLORER = '.workspace-leaf-content[data-type="file-explorer"]'
const ENTRY = '.nav-file-title, .nav-folder-title'

/** A CSS string: quotes and backslashes escaped. */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function ancestors(path: string): string[] {
  const found: string[] = []
  for (let slash = path.indexOf('/'); slash >= 0; slash = path.indexOf('/', slash + 1)) found.push(path.slice(0, slash))
  return found
}

/** The rule greying every entry outside `scope`; the folders on the way to it stay as they are. */
export function dimRule(scope: LockScope): string {
  if (scope.kind === 'vault') return ''
  const keep = (path: string): string => `:not([data-path=${quoted(path)}])`
  const below = scope.kind === 'folder' ? `:not([data-path^=${quoted(`${scope.path}/`)}])` : ''
  const files = `${EXPLORER} .nav-file-title${keep(scope.path)}${below}`
  const folders = `${EXPLORER} .nav-folder-title${keep(scope.path)}${below}${ancestors(scope.path).map(keep).join('')}`
  return `${files}, ${folders} { opacity: 0.35; }\n${files} { cursor: not-allowed; }\n`
}

export class ExplorerGuard {
  private readonly style: HTMLStyleElement
  private shown = ''

  constructor(
    private readonly doc: Document,
    private readonly policy: () => ExplorerPolicy | null,
    private readonly refused: (why: string) => void
  ) {
    this.style = doc.head.createEl('style', { attr: { id: 'mycel-explorer-guard' } })
  }

  /** Starts catching; the function returned stops it and greys nothing any more. */
  install(): () => void {
    const opening = (event: MouseEvent): void => this.onOpen(event)
    const changing = (event: Event): void => this.onChange(event)
    this.doc.addEventListener('click', opening, true)
    this.doc.addEventListener('auxclick', opening, true)
    this.doc.addEventListener('contextmenu', changing, true)
    this.doc.addEventListener('dragstart', changing, true)
    this.doc.addEventListener('dblclick', changing, true)
    return () => {
      this.doc.removeEventListener('click', opening, true)
      this.doc.removeEventListener('auxclick', opening, true)
      this.doc.removeEventListener('contextmenu', changing, true)
      this.doc.removeEventListener('dragstart', changing, true)
      this.doc.removeEventListener('dblclick', changing, true)
      this.style.remove()
    }
  }

  /** Greys what the policy says now. */
  refresh(): void {
    const scope = this.policy()?.dimOutside ?? null
    const rule = scope ? dimRule(scope) : ''
    if (rule === this.shown) return
    this.shown = rule
    this.style.textContent = rule
  }

  private entry(event: Event): { path: string; folder: boolean } | null {
    const target = event.target
    if (!(target instanceof Element)) return null
    const entry = target.closest(ENTRY)
    if (!entry || !entry.closest(EXPLORER)) return null
    const path = entry.getAttribute('data-path')
    return path === null ? null : { path, folder: entry.classList.contains('nav-folder-title') }
  }

  private refuse(event: Event, why: string): void {
    event.preventDefault()
    event.stopImmediatePropagation()
    this.refused(why)
  }

  private onOpen(event: MouseEvent): void {
    const policy = this.policy()
    const entry = policy ? this.entry(event) : null
    // A folder only folds or unfolds; the way to what is shown goes through them.
    if (!policy || !entry || entry.folder) return
    const why = policy.refuseOpen(entry.path)
    if (why) this.refuse(event, why)
  }

  private onChange(event: Event): void {
    const policy = this.policy()
    const entry = policy ? this.entry(event) : null
    if (!policy || !entry) return
    // A double click on a folder's name renames nothing; on a file it may, with some plugins.
    if (event.type === 'dblclick' && entry.folder) return
    const why = policy.refuseChange(entry.path)
    if (why) this.refuse(event, why)
  }
}
