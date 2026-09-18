import type { Extension } from '@codemirror/state'
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { awarenessFacet, yTextFacet } from './facets'
import { yTextBinding } from './binding'
import { remoteCursors } from './cursors'

export function mainEditorCollab(ytext: Y.Text, awareness: Awareness): Extension {
  return [
    yTextFacet.of(ytext),
    awarenessFacet.of(awareness),
    yTextBinding(ytext, awareness),
    remoteCursors()
  ]
}
