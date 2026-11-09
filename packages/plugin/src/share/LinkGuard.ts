import { RangeSetBuilder, StateEffect, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { Workspace } from 'obsidian'
import type { LinkOwner, LinkVerdict } from './LinkClaims.js'
import { log } from '../log.js'

// What someone else's link in a shared note does here (`LinkClaims`): it opens
// their note where this vault has it, and nothing where it does not - neither a
// note of this vault's of that name nor a new, empty one, which Obsidian makes
// for a link that resolves nowhere. Such a link is marked in the editor and in
// the reading view. Obsidian still resolves links by name everywhere else - the
// graph, backlinks -, and rewriting the text would break the link for the
// person who typed it: everyone reads the same text.

type Theirs = Extract<LinkOwner, { kind: 'theirs' }>
type TheirLink = LinkVerdict & { owner: Theirs }

export interface LinkGuardHost {
  /** The note at a path, when this vault syncs one there. */
  docIdFor(path: string): string | null
  linksOf(docId: string): LinkVerdict[]
  onChange(listener: (docId: string) => void): () => void
  /** Someone else's link was opened, and this vault has nothing it means. */
  leadsNowhere(link: TheirLink): void
}

export type PathOf = (state: EditorState) => { path: string } | null

function theirs(link: LinkVerdict): link is TheirLink {
  return link.owner.kind === 'theirs'
}

/** What a link of someone else's says when pointed at. */
export function describeTheirs(link: TheirLink): string {
  const what = link.owner.target === 'file' ? 'file' : 'note'
  return link.owner.path ? `${link.owner.name}'s ${what}` : `${link.owner.name}'s ${what} - not shared with you`
}

/** A link's path and what follows it, for opening another path with the same heading or block. */
function split(linktext: string): { ref: string; subpath: string } {
  const cut = linktext.search(/[#^]/)
  return cut < 0 ? { ref: linktext, subpath: '' } : { ref: linktext.slice(0, cut), subpath: linktext.slice(cut) }
}

function sameRef(a: string, b: string): boolean {
  if (a === b) return true
  try {
    return decodeURI(a) === b
  } catch {
    return false
  }
}

/** Where an editor was last clicked: a link opened right after is the link under it. */
let lastClick: { path: string; pos: number; at: number } | null = null
const CLICK_MS = 2_000

const refresh = StateEffect.define<null>()

function marksFor(host: LinkGuardHost, state: EditorState, path: string | null): DecorationSet {
  const docId = path ? host.docIdFor(path) : null
  if (!docId) return Decoration.none
  const builder = new RangeSetBuilder<Decoration>()
  for (const link of host.linksOf(docId)) {
    // The editor and the document agree while it is bound; a link elsewhere in a lagging editor is left unmarked.
    if (!theirs(link) || link.end > state.doc.length || state.doc.sliceString(link.start, link.end) !== link.text) continue
    builder.add(
      link.start,
      link.end,
      Decoration.mark({ class: link.owner.path ? 'mycel-link-theirs' : 'mycel-link-dead', attributes: { title: describeTheirs(link) } })
    )
  }
  return builder.finish()
}

/** Marks someone else's links in a shared note's editor, and remembers where it was clicked. */
export function linkGuardExtension(host: LinkGuardHost, pathOf: PathOf): Extension {
  const marks = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      private path: string | null
      private readonly unwatch: () => void

      constructor(readonly view: EditorView) {
        this.path = pathOf(view.state)?.path ?? null
        this.decorations = marksFor(host, view.state, this.path)
        this.unwatch = host.onChange((docId) => {
          if (!this.path || host.docIdFor(this.path) !== docId) return
          // Never from inside an update, and never from the constructor (invariant 6).
          queueMicrotask(() => {
            if (this.view.dom.isConnected) this.view.dispatch({ effects: refresh.of(null) })
          })
        })
      }

      update(update: ViewUpdate): void {
        const path = pathOf(update.state)?.path ?? null
        const refreshed = update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(refresh)))
        if (!update.docChanged && !refreshed && path === this.path) return
        this.path = path
        try {
          this.decorations = marksFor(host, update.state, path)
        } catch (error) {
          // Never out of `update`: CodeMirror would drop the plugin for good.
          log.warn('marking the links of a shared note failed', error)
          this.decorations = Decoration.none
        }
      }

      destroy(): void {
        this.unwatch()
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      eventHandlers: {
        mousedown(event, view) {
          const path = pathOf(view.state)?.path
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
          lastClick = path && pos !== null ? { path, pos, at: Date.now() } : null
          return false
        }
      }
    }
  )
  return marks
}

/**
 * Which link of someone else's opening `linktext` from `sourcePath` means: the
 * one just clicked, or - from the reading view or a key - the only kind there
 * is. Null when it is this account's, nobody's, or not to be told apart.
 */
export function theirLinkOpened(host: LinkGuardHost, linktext: string, sourcePath: string, now = Date.now()): TheirLink | null {
  const docId = host.docIdFor(sourcePath)
  if (!docId) return null
  const { ref } = split(linktext)
  const links = host.linksOf(docId).filter((link) => sameRef(ref, link.ref))
  if (links.length === 0) return null
  const click = lastClick && lastClick.path === sourcePath && now - lastClick.at < CLICK_MS ? lastClick.pos : null
  const clicked = click === null ? undefined : links.find((link) => link.start <= click && click <= link.end)
  if (clicked) return theirs(clicked) ? clicked : null
  const first = links[0] as LinkVerdict
  if (!theirs(first)) return null
  const all = links.every((link) => theirs(link) && link.owner.account === first.owner.account && link.owner.path === first.owner.path)
  return all ? first : null
}

/**
 * Obsidian opens every link through `openLinkText` - a click in the editor or
 * the reading view, a key. Someone else's link opens what it means here, or
 * nothing. Undone when the plugin unloads; another plugin wrapping it after
 * this one keeps working, this one's wrapper only stepping aside.
 */
export function guardLinkOpening(workspace: Workspace, host: LinkGuardHost): () => void {
  type Open = (this: unknown, linktext: string, sourcePath: string, ...rest: unknown[]) => Promise<void>
  const target = workspace as unknown as { openLinkText?: Open }
  const original = target.openLinkText
  if (typeof original !== 'function') return () => undefined
  const own = Object.prototype.hasOwnProperty.call(target, 'openLinkText')
  let active = true
  const wrapper: Open = function (this: unknown, linktext, sourcePath, ...rest) {
    if (active && typeof linktext === 'string' && typeof sourcePath === 'string') {
      try {
        const link = theirLinkOpened(host, linktext, sourcePath)
        if (link?.owner.path) return original.call(this, `${link.owner.path}${split(linktext).subpath}`, sourcePath, ...rest)
        if (link) {
          host.leadsNowhere(link)
          return Promise.resolve()
        }
      } catch (error) {
        log.warn('telling whose a link is failed; opened as Obsidian does', error)
      }
    }
    return original.call(this, linktext, sourcePath, ...rest)
  }
  target.openLinkText = wrapper
  return () => {
    active = false
    if (target.openLinkText !== wrapper) return
    if (own) target.openLinkText = original
    else delete target.openLinkText
  }
}

/** The same marks in the reading view, for a link whose every place in the note is someone else's. */
export function markRendered(host: LinkGuardHost, el: HTMLElement, sourcePath: string): void {
  const docId = host.docIdFor(sourcePath)
  if (!docId) return
  const links = host.linksOf(docId)
  if (!links.some(theirs)) return
  const mark = (node: Element, href: string): void => {
    const { ref } = split(href)
    const same = links.filter((link) => sameRef(ref, link.ref))
    const first = same[0]
    if (!first || !theirs(first) || !same.every((link) => theirs(link) && link.owner.path === first.owner.path)) return
    node.classList.add(first.owner.path ? 'mycel-link-theirs' : 'mycel-link-dead')
    node.setAttribute('title', describeTheirs(first))
  }
  for (const node of Array.from(el.querySelectorAll('a.internal-link'))) mark(node, node.getAttribute('data-href') ?? '')
  for (const node of Array.from(el.querySelectorAll('.internal-embed'))) mark(node, node.getAttribute('src') ?? '')
}
