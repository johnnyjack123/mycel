import type { Extension } from '@codemirror/state'
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
  awareness: Awareness,
  isSessionEditor: () => boolean
): MainEditorCollab {
  const binding = yTextBinding(ytext, awareness, isSessionEditor)
  return {
    binding,
    extension: [
      yTextFacet.of(ytext),
      awarenessFacet.of(awareness),
      binding,
      remoteCursors()
    ]
  }
}
