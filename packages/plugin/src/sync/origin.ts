/**
 * Transaction origins shared between the editor binding and the sync layer.
 *
 * These used to be two separate constants with the same text - a Symbol in the
 * binding, a string in the store - so they never compared equal. The store
 * therefore treated every keystroke as a change it had to write back to disk,
 * which fed the editor, which fed the CRDT, which doubled the text on every
 * round trip.
 */

/** A change the editor binding pushed into the document. */
export const EDITOR_ORIGIN = 'obsidian-connect-editor'

/** A change the sync layer applied to the document (reconcile, merge, restore). */
export const SYNC_ORIGIN = 'obsidian-connect-sync'

