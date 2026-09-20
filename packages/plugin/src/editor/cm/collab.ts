import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { awarenessFacet, yTextFacet } from './facets'
import { yTextBinding, type YTextBinding } from './binding'
import { remoteCursors } from './cursors'

export interface MainEditorCollab {
  extension: Extension
  // Exposed so the caller can verify the plugin really came up: CodeMirror
  // swallows an exception thrown while a view plugin is constructed and just
  // deactivates it, which would otherwise look exactly like a working session.
  // It is also how the caller notices that Obsidian has rebuilt the editor
  // state and dropped the extension.
  binding: YTextBinding
}

export function mainEditorCollab(
  ytext: Y.Text,
  awareness: Awareness | null,
  isSessionEditor: () => boolean,
  onException?: (error: unknown) => void
): MainEditorCollab {
  const binding = yTextBinding(ytext, awareness, isSessionEditor)
  // CodeMirror swallows an exception thrown while a view plugin is built and
  // only logs it. Without a sink the caller sees "the plugin did not start"
  // and has to go digging for the real cause in the console.
  const sink = onException ? [EditorView.exceptionSink.of(onException)] : []
  return {
    binding,
    extension: awareness
      ? [...sink, yTextFacet.of(ytext), awarenessFacet.of(awareness), binding, remoteCursors()]
      : // Sync only: no presence facet, no cursor decorations.
        [...sink, yTextFacet.of(ytext), binding]
  }
}
