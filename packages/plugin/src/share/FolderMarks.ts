// A shared folder is marked in the file explorer, in the explorer's own muted
// grey - a colour of its own stood out more than the user wanted. Obsidian
// offers no API for that, so the plugin keeps a stylesheet naming each folder
// by its path - the explorer's own elements are never touched, and a folder
// the explorer draws later is marked as well.

// Lucide's "users", as a mask the theme's colours fill.
const ICON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'/%3E%3Ccircle cx='9' cy='7' r='4'/%3E%3Cpath d='M22 21v-2a4 4 0 0 0-3-3.87'/%3E%3Cpath d='M16 3.13a4 4 0 0 1 0 7.75'/%3E%3C/svg%3E\")"

function quoted(path: string): string {
  return `"${path.replace(/["\\]/g, '\\$&')}"`
}

export class FolderMarks {
  private style: HTMLStyleElement | null = null
  private last = ''

  /** `own`: folders this vault shares; `theirs`: folders shared into it - marked alike. */
  render(own: string[], theirs: string[]): void {
    const rule = (path: string, colour: string): string =>
      `.nav-folder-title[data-path=${quoted(path)}] .nav-folder-title-content::after{content:'';display:inline-block;width:0.9em;height:0.9em;margin-left:0.4em;vertical-align:-0.1em;background-color:${colour};-webkit-mask-image:${ICON};mask-image:${ICON};-webkit-mask-size:contain;mask-size:contain;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat}`
    const css = [...own, ...theirs].map((path) => rule(path, 'var(--text-muted)')).join('\n')
    if (css === this.last) return
    this.last = css
    this.style ??= document.head.createEl('style', { attr: { id: 'obsidian-connect-folder-marks' } })
    this.style.textContent = css
  }

  destroy(): void {
    this.style?.remove()
    this.style = null
    this.last = ''
  }
}
