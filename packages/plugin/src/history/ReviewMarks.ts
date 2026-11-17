// A note merged without anyone choosing - two versions that met with nothing to tell
// which side changed what (joining a vault), or a change in the same place on two
// devices - is marked in the file explorer until the person has looked at it:
// "Compare versions" in its menu, then *Done* or *Apply* (the user, 2026-11-17). The
// merge may well be right; the mark only says it was made. A folder holding such a
// note gets a dot, so a closed folder does not hide it. As with the shared folders'
// marks (`FolderMarks`), a stylesheet names each by its path: the explorer's own
// elements are never touched, and a note the explorer draws later is marked as well.

// Lucide's "git-compare", as a mask the theme's accent fills.
const ICON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='18' cy='18' r='3'/%3E%3Ccircle cx='6' cy='6' r='3'/%3E%3Cpath d='M13 6h3a2 2 0 0 1 2 2v7'/%3E%3Cpath d='M11 18H8a2 2 0 0 1-2-2V9'/%3E%3C/svg%3E\")"

function quoted(path: string): string {
  return `"${path.replace(/["\\]/g, '\\$&')}"`
}

/** The stylesheet marking these notes, and every folder above them. */
export function reviewMarkCss(paths: string[]): string {
  const notes = Array.from(new Set(paths)).sort()
  const folders = new Set<string>()
  for (const path of notes) {
    for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/', slash - 1)) folders.add(path.slice(0, slash))
  }
  const note = (path: string): string =>
    `.nav-file-title[data-path=${quoted(path)}] .nav-file-title-content::after{content:'';display:inline-block;width:0.9em;height:0.9em;margin-left:0.4em;vertical-align:-0.1em;background-color:var(--text-accent);-webkit-mask-image:${ICON};mask-image:${ICON};-webkit-mask-size:contain;mask-size:contain;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat}`
  const folder = (path: string): string =>
    `.nav-folder-title[data-path=${quoted(path)}] .nav-folder-title-content::before{content:'';display:inline-block;width:0.45em;height:0.45em;margin-right:0.35em;vertical-align:0.1em;border-radius:50%;background-color:var(--text-accent)}`
  return [...notes.map(note), ...Array.from(folders).sort().map(folder)].join('\n')
}

export class ReviewMarks {
  private style: HTMLStyleElement | null = null
  private last = ''

  render(paths: string[]): void {
    const css = reviewMarkCss(paths)
    if (css === this.last) return
    this.last = css
    this.style ??= document.head.createEl('style', { attr: { id: 'mycel-review-marks' } })
    this.style.textContent = css
  }

  destroy(): void {
    this.style?.remove()
    this.style = null
    this.last = ''
  }
}
