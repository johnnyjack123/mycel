import { Facet } from '@codemirror/state'
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'

export const yTextFacet = Facet.define<Y.Text, Y.Text | null>({
  combine: (values) => values[0] ?? null
})

export const awarenessFacet = Facet.define<Awareness, Awareness | null>({
  combine: (values) => values[0] ?? null
})
