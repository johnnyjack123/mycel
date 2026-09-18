# Progress

_Last updated: 2026-09-18 · Phase 0 spike built and typechecks; live sync across two devices is NOT working yet and is instrumented for debugging. Git repo setup requested but not started._

## Where we are

Monorepo (`npm` workspaces) for a Yjs-based Obsidian sync plugin plus a small custom server.
`packages/server` runs (`tsx`), `packages/plugin` compiles. Two Obsidian clients do connect to the
**same room** (verified via `/rooms`: 1 room, `connections: 2`) and disconnecting one drops it to 1,
so the WebSocket transport and room logic work. **But document updates are not propagating between
the devices** — typing in one client does not appear in the other, and `/rooms.chars` behaviour was
not yet confirmed. A previous bug (note content duplicated on every attach) was fixed by moving
seeding into the session; that fix and the debug instrumentation have **not been tested on device
yet** because the plugin build was not re-rotated.

## Next step

1. Rebuild and rotate the plugin: `npm run build:plugin`, copy `main.js` into
   `<vault>/.obsidian/plugins/crdt-sync/`, reload Obsidian on **both** devices, restart the server.
2. Isolate server vs plugin with the self-test: `node packages/server/scripts/ws-selftest.mjs ws://<server-ip>:1234`.
   `PASS` = server relays correctly → bug is in the plugin binding; `FAIL` = server side.
3. Collect console logs (`Ctrl+Shift+I`) from both clients while typing in client A
   (filter `[crdt-sync]`) and the `/rooms` output before/after typing. See interpretation table in
   the last chat message / below.
4. Then do the requested git setup: `git init`, commit, push to
   `https://github.com/johnnyjack123/obsidian-connect.git` (see "In flight").

## In flight / half-finished

- **Git repo not initialised.** User asked to init and push to
  `https://github.com/johnnyjack123/obsidian-connect.git`. Blockers: `gh` is not installed, no git
  `user.name`/`user.email` configured, and the credential-helper/token probe was interrupted
  (user rejected the tool call). A push will need auth (PAT or `gh auth login`). `.gitignore` exists
  and covers `node_modules/`, `dist/`, `main.js`, `*.log`, `.env`, `packages/server/data/`.
- **Debug instrumentation added, unverified:** server `/rooms` + upgrade logs
  (`packages/server/src/index.ts`), plugin doc-update/attach/remote-apply logs
  (`packages/plugin/src/collab/CollabSession.ts`, `.../editor/MainEditorCollabAdapter.ts`,
  `.../editor/cm/binding.ts`).
- **`packages/server/data/` holds a polluted room state** from the duplication bug
  (file `29814afa-…-Test.md.bin`). Delete it before a clean test. It is gitignored.

## Decisions made this session

- **Own server, not CouchDB.** Live sharing + awareness + cross-user ACLs need bidirectional push;
  CouchDB cannot. `packages/server` = Fastify + `y-websocket` + JWT; storage is pluggable
  (disk now, CouchDB/S3 later).
- **Merging is local, never server-side.** Yjs updates are commutative/associative/idempotent.
- **npm workspaces, not pnpm**, because only node/npm is installed.
- **Pin `@codemirror/*` to Obsidian's exact peers** (`state 6.5.0`, `view 6.38.6`) via root
  `overrides`; `obsidian@1.13.1` declares those as exact peers and npm nests an extra copy otherwise.
- **Server loads yjs as CJS** (`createRequire`, `packages/server/src/yjs.ts`), because
  `y-websocket/bin/utils.cjs` does, and mixing ESM+CJS yjs triggers "Yjs was already imported".
- **Seeding is centralised in `CollabSession.ready()`**, only when the room is empty, after sync.
  Seeding per client created independent Yjs item sequences → duplicated text.
- **Sharing model = global accounts + per-document ACL + stable `docId`** (not per-vault names,
  not path-keyed rooms). `vaultId::path` is only a Phase 0/1 testing/personal-sync shortcut.
  Recorded in `PLAN.md`.

## Open questions for the user

- Why is nothing syncing despite same room + 2 connections? Need the logs/tests from "Next step".
- Git identity to use for the commit, and auth method for the push (PAT vs `gh auth login`).

## Known issues / debt

- **Phase 0 does not write edits back to `.md` files** (Phase 1). Testing must look at the other
  client's *editor*, not the file on disk.
- Main-editor integration uses Obsidian-internal `(editor as any).cm`; version-fragile, dedicated
  collab view exists as fallback.
- Seeding race if two clients join an empty room simultaneously (documented in `PLAN.md`).
- Two Obsidian clients on the same machine may also sync via `BroadcastChannel` (y-websocket
  default), masking server issues. Prefer two real devices.

## Verification state

- `npm run typecheck`: passed after the `@codemirror` pinning fix (user-reported). **Not re-run after
  the latest instrumentation edits.**
- Server: starts; `/health` and `/rooms` respond; `connections: 2` observed for room
  `29814afa-2d50-440b-b97d-6c08c9ee3565%3A%3ATest.md`.
- Plugin: compiled and loaded in Obsidian (no load errors). Live update propagation: **not working,
  not yet diagnosed.**
- `ws-selftest.mjs`: written, never run.

---

## Log

### 2026-09-18
- Scaffolded monorepo: `packages/shared` (protocol/types), `packages/server`, `packages/plugin`.
- Server: Fastify + `y-websocket` + JWT + disk persistence + `/health`, `/auth/dev-token`, `/auth/login`, `/rooms`.
- Plugin: `CollabSession`, `MainEditorCollabAdapter` (CM6 injection), custom `Y.Text` binding +
  remote cursors, `CollabView` fallback via `y-codemirror.next`, settings incl. editable Vault ID.
- Fixed `@codemirror` duplicate-instance typecheck failures (root `overrides` to Obsidian's peers).
- Fixed "Yjs was already imported" by loading yjs as CJS on the server.
- Fixed note duplication by centralising seeding in `CollabSession.ready()`.
- Added debug instrumentation and `ws-selftest.mjs`; opened the "connected but no sync" investigation.
