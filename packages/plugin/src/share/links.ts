import type * as Y from 'yjs'

// The links in a note's text, found the same way on every device: positions in
// the text and the Yjs ids of their first characters, which name one link
// whatever is typed before it. Obsidian's own link cache describes the file,
// which lags the document while an editor holds it; this reads the document.

export interface LinkAt {
  start: number
  end: number
  /** The path as written, without heading, block or alias; empty for a link into the note itself. */
  ref: string
  embed: boolean
}

const WIKI = /(!?)\[\[([^\]\n]+?)\]\]/g
const MARKDOWN = /(!?)\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g
const FENCE = /^ {0,3}(`{3,}|~{3,})/

function wikiRef(inner: string): string {
  const path = inner.split('|')[0] ?? ''
  const hash = path.indexOf('#')
  return (hash === -1 ? path : path.slice(0, hash)).trim()
}

function markdownRef(target: string): string | null {
  let path = target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target
  // Somewhere else, not a file of a vault.
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null
  const hash = path.indexOf('#')
  if (hash !== -1) path = path.slice(0, hash)
  try {
    path = decodeURI(path)
  } catch {
    // Not URL-encoded after all.
  }
  return path.trim()
}

/** The ranges of inline code on a line: a link inside one is no link to Obsidian either. */
function codeSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  for (let at = line.indexOf('`'); at !== -1; ) {
    let run = 1
    while (line[at + run] === '`') run += 1
    const fence = '`'.repeat(run)
    const close = line.indexOf(fence, at + run)
    if (close === -1) break
    spans.push([at, close + run])
    at = line.indexOf('`', close + run)
  }
  return spans
}

/** Every link of a text, in order. Fenced code and inline code hold none. */
export function linksIn(text: string): LinkAt[] {
  const found: LinkAt[] = []
  let fence: string | null = null
  let offset = 0
  for (const line of text.split('\n')) {
    const opens = FENCE.exec(line)
    if (fence !== null) {
      if (opens && opens[1]?.[0] === fence[0] && (opens[1]?.length ?? 0) >= fence.length) fence = null
    } else if (opens) {
      fence = opens[1] ?? null
    } else {
      const code = codeSpans(line)
      const outside = (at: number): boolean => !code.some(([from, to]) => at >= from && at < to)
      for (const match of line.matchAll(WIKI)) {
        const at = match.index ?? 0
        if (!outside(at)) continue
        found.push({ start: offset + at, end: offset + at + match[0].length, ref: wikiRef(match[2] ?? ''), embed: match[1] === '!' })
      }
      for (const match of line.matchAll(MARKDOWN)) {
        const at = match.index ?? 0
        const ref = markdownRef(match[2] ?? '')
        if (ref === null || !outside(at)) continue
        found.push({ start: offset + at, end: offset + at + match[0].length, ref, embed: match[1] === '!' })
      }
    }
    offset += line.length + 1
  }
  return found.sort((a, b) => a.start - b.start)
}

/**
 * The Yjs id of the character at each position, as `client:clock`, in one walk
 * over the text; null past its end. `positions` ascending.
 */
export function idsAt(ytext: Y.Text, positions: number[]): Array<string | null> {
  const ids: Array<string | null> = positions.map(() => null)
  let next = 0
  let index = 0
  for (let item = ytext._start; item && next < positions.length; item = item.right) {
    if (item.deleted || !item.countable) continue
    while (next < positions.length && (positions[next] as number) < index + item.length) {
      ids[next] = `${item.id.client}:${item.id.clock + (positions[next] as number) - index}`
      next += 1
    }
    index += item.length
  }
  return ids
}

/**
 * The positions a change touched, in the text after it: what was inserted, and
 * where something was deleted. From a Y.Text event's delta.
 */
export function touchedBy(delta: Array<{ retain?: number; insert?: unknown; delete?: number }>): Array<[number, number]> {
  const touched: Array<[number, number]> = []
  let at = 0
  for (const op of delta) {
    if (op.retain !== undefined) {
      at += op.retain
    } else if (op.insert !== undefined) {
      const length = typeof op.insert === 'string' ? op.insert.length : 1
      touched.push([at, at + length])
      at += length
    } else if (op.delete !== undefined) {
      touched.push([at, at])
    }
  }
  return touched
}

/** Whether a change touched a link: inserted into it, or deleted inside it. Typing right after it does not. */
export function touches(link: LinkAt, touched: Array<[number, number]>): boolean {
  return touched.some(([from, to]) => (from === to ? from > link.start && from < link.end : from < link.end && to > link.start))
}

/** The links on the lines a change touched - the ones it may have made, changed or unmade. */
export function linksNear(text: string, touched: Array<[number, number]>): LinkAt[] {
  const found = new Map<number, LinkAt>()
  for (const [from, to] of touched) {
    const lineStart = text.lastIndexOf('\n', Math.max(0, from - 1)) + 1
    const lineEnd = text.indexOf('\n', to)
    const slice = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
    for (const link of linksIn(slice)) {
      const shifted = { ...link, start: link.start + lineStart, end: link.end + lineStart }
      if (touches(shifted, touched)) found.set(shifted.start, shifted)
    }
  }
  return Array.from(found.values())
}
