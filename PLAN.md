# CRDT Sync for Obsidian — Plan

CRDT-based (Yjs) vault synchronization and live collaboration for Obsidian.

## Goals

- Sync notes across all devices without manual merge conflicts.
- Live, Google-Docs-style collaboration on a single note, including remote cursors.
- Share a note with other users of the same server (optionally later with people who
  do not run Obsidian, via a slim web frontend).
- Avoid writing our own auth/security-critical service where possible, but accept a
  small custom server because live collaboration and sharing require it.

## Core decision: where does merging happen?

CRDTs have **no server-side merge**. Yjs updates are commutative, associative and
idempotent. Every client applies the updates it receives and converges locally.
The server is a **dumb relay + store**; it never resolves conflicts because none
exist at that layer.

There are three distinct layers, and most "conflict" pain lives in layers 2 and 3:

1. **CRDT layer (Yjs)** — always converges, no conflicts.
2. **Persistence layer (`Y.Doc` <-> `.md` file)** — file writes, echo loops, renames.
3. **Editor layer (CodeMirror 6 <-> `Y.Text`)** — needed for live concurrent editing.

## Backend decision

CouchDB (as used by Self-hosted LiveSync) cannot do bidirectional push or
cross-user sharing, so it cannot support live collaboration. It is therefore **not
the foundation**. Instead:

- Own small server: Fastify (HTTP) + `y-websocket` server utilities (sync + awareness).
- Auth: JWT (short-lived access token; refresh and OAuth later).
- Storage: append-only Yjs updates; disk persistence in Phase 0, pluggable later.
- CouchDB/S3 can become optional storage backends behind a provider interface.

## Sharing model

- One `Y.Doc` per note, plus a future vault-index `Y.Doc` for tree/renames/deletes.
- **Phase 0/1 shortcut:** room name = `vaultId::notePath` (URL-encoded). Two vaults
  that set the same vault ID and have the note at the same path join the same room.
  This is only a testing/personal-sync mechanism.
- **Target (Phase 2):** identify a note by a stable `docId` (UUID) persisted next to
  the note, not by its path. Room = `docId`. The vault-index doc maps `path <-> docId`
  and absorbs renames. Sharing a note grants user B access to `docId`, so it works
  even when B stores the note under a different path.
- Users are server-side accounts with a stable ID; display name/color are cosmetic
  and travel through awareness. "One unique name per vault" is not enough: sharing
  is an ACL on a document, and the same user may hold access to many documents.
- Server holds ACLs (`user -> docId`); share links carry signed, expiring tokens.
- Presence/cursors via `y-protocols/awareness`.

## Bootstrap / seeding note

The initial note content must be seeded into an empty room exactly once. Seeding
from the file separately on several clients creates independent Yjs item sequences
and therefore duplicated text, so seeding now happens in `CollabSession.ready()`,
only when the room is empty, with a short grace period. A fully race-free bootstrap
(server-side initializer or a deterministic seed document) is a Phase 1 item.

## Repo layout

```
packages/
  shared/   protocol constants and shared types
  server/   Fastify + y-websocket + JWT + disk persistence
  plugin/   Obsidian plugin (the actual product)
```

## Phases

### Phase 0 — Validate the hard part (current)

Prove or kill the main-editor CodeMirror 6 injection before building anything else.

Deliverables:
- Monorepo scaffold (npm workspaces, TypeScript everywhere).
- `@crdt-sync/shared` protocol types.
- `@crdt-sync/server`: health endpoint, dev/ login token endpoints, JWT auth for
  WebSocket upgrades, `y-websocket` room handling, disk persistence.
- `@crdt-sync/plugin`: connect a note to a room, seed the `Y.Doc` from the file,
  attach a lightweight `Y.Text` <-> CodeMirror binding plus remote cursor
  decorations to Obsidian's own editor, with a dedicated collaboration view as a
  guaranteed fallback.

Findings to record after testing (fill in):
- Does `(editor as any).cm` exist across desktop/mobile?
- Does `StateEffect.appendConfig` survive file switches / editor recreation?
- Does the custom binding coexist with Obsidian's Live Preview without feedback loops?
- How do undo/redo and external file changes behave?

Fallback: the dedicated collaboration view using `y-codemirror.next`'s `yCollab`.

### Phase 1 — Background sync

Own `Y.Doc` per note, vault-index doc, auth flow, offline queue, and the
persistence path only (file writes through the Vault API while a note is not in a
live session). No editor patching required for this phase.

### Phase 2 — Live sharing

ACLs, share tokens, live sessions, awareness UI, and the editor path.

### Phase 3 — Robustness

Mobile, history/diff, attachments, recovery UX, rename/delete handling.

### Phase 4 — Guest web frontend

Reuse the same Yjs room and awareness protocol in a slim browser editor/viewer.

## Known risks

1. **Obsidian CM6 injection** — no public API for CM6 extensions; internal API is
   version-fragile. Mitigated by the adapter interface and the fallback view.
2. **File <-> CRDT binding** — deriving markdown from a `Y.Doc`, initializing a
   `Y.Doc` from markdown, renames/deletes, echo loops.
3. **First sync bootstrap** — importing an existing vault into Yjs consistently.
4. **Mobile limits** — memory/performance, IndexedDB persistence.
5. **Attachments** — binary files do not travel through Yjs; separate store needed.
