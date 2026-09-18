# Progress

_Last updated: 2026-09-18 · Root cause of "connected but nothing syncs" found and fixed. Verified headlessly end-to-end; **not yet confirmed on two real Obsidian devices**. Git repo setup still open._

## Where we are

Monorepo (`npm` workspaces) for a Yjs-based Obsidian sync plugin plus a small custom server.
Live sharing now works in an automated end-to-end test that drives the real CodeMirror binding
against the real server (`npm run test:sync`): two clients reconcile to the room content, edits
propagate both ways, concurrent edits converge, and a rejoining client gets the persisted state.

### The bug

`yTextBinding`'s view plugin called `view.dispatch()` from its **constructor**. CodeMirror forbids
dispatching while an update is in progress, and the plugin is constructed from inside the very
transaction that installs it (`StateEffect.appendConfig`). The dispatch threw, CodeMirror caught the
exception, logged `CodeMirror plugin crashed` and **permanently deactivated the plugin** — so
`update()` never ran again and local typing never reached `Y.Text`. `attach()` reported success and
the status bar said "connected", which is why it looked like a transport problem.

It only triggered when the editor text differed from the room text (the initial reconcile returns
early when they are equal), so it reproduced reliably once the server held any room state — such as
the duplicated content left behind by the earlier seeding bug.

## Next step

1. Copy `packages/plugin/main.js` (rebuilt, contains the fix) into
   `<vault>/.obsidian/plugins/crdt-sync/` on **both** devices and reload Obsidian.
2. Start the server (`npm run start:server`). `packages/server/data/` was deleted, so rooms start clean.
3. Type in one client, watch the other. Console filter `[crdt-sync]`.
4. Then the requested git setup: push to `https://github.com/johnnyjack123/obsidian-connect.git`.

## Fixes in this session

- **`editor/cm/binding.ts`** — initial reconcile deferred to a microtask instead of dispatching from
  the view-plugin constructor. Also: never blank the editor when `Y.Text` is empty (the room is just
  unseeded); fall back to a full resync if a remote delta cannot be applied; clamp cursor indices to
  `ytext.length` so `publishSelection` cannot throw out of `update()`.
- **`editor/cm/collab.ts` + `MainEditorCollabAdapter`** — `mainEditorCollab` now also returns the
  view plugin, and `attach()` asserts `view.plugin(binding) !== null`. A crashed plugin now throws
  and falls back to the collab view instead of pretending to work.
- **`main.ts`** — refuses to start a session when the server was never reached (seeding a room whose
  state we never received is what creates duplicated notes); attaches to the MarkdownView of the
  session's own file rather than whatever is active after the up-to-6.5 s `ready()` await.
- **`CollabSession.ready()`** — returns `false` instead of seeding blind on sync timeout.
- **`server/rooms.ts` + `server/index.ts`** — `ensureLoaded(room)` awaits the stored state before the
  socket joins (y-websocket never awaits `bindState`, so clients used to sync against an empty doc
  while the `.bin` was still being read, then seeded a second copy); rooms are now saved debounced on
  update, not only when the last client disconnects.
- **Re-attach after Obsidian rebuilds the editor state.** `MainEditorCollabAdapter` now takes a
  resolver instead of a fixed `Editor`, exposes `ensureAttached()`, and `main.ts` calls it on
  `layout-change`, `active-leaf-change` and `file-open`. The binding also takes an `isSessionEditor`
  predicate and drops local edits when the view no longer shows the session's note, so a file switch
  inside a leaf cannot push the next note's text into the room.
- **New `npm run test:sync`** (`packages/plugin/scripts/binding-selftest.mts`, jsdom) — the
  regression test for all of the above, 21 checks. Verified it fails when the constructor dispatch
  is restored.
- **New `.github/workflows/build.yml`** — typecheck, build, then both self-tests against a server
  started in the job. Every push to `main` refreshes the `latest-build` pre-release
  (`crdt-sync-<version>.zip` + loose `main.js`/`manifest.json`/`styles.css`); a tag publishes a
  normal release; other branches only get a build artifact.

## In flight / half-finished

- **Git repo not initialised for the remote.** User asked to push to
  `https://github.com/johnnyjack123/obsidian-connect.git`. Blockers: `gh` is not installed, push
  needs auth (PAT or `gh auth login`). `.gitignore` covers `node_modules/`, `dist/`, `main.js`,
  `*.log`, `.env`, `packages/server/data/`.

## Decisions made earlier

- **Own server, not CouchDB.** Live sharing + awareness + cross-user ACLs need bidirectional push.
- **Merging is local, never server-side.** Yjs updates are commutative/associative/idempotent.
- **npm workspaces, not pnpm**, because only node/npm is installed.
- **Pin `@codemirror/*` to Obsidian's exact peers** (`state 6.5.0`, `view 6.38.6`) via root
  `overrides`, and keep them `external` in the esbuild config so the plugin uses Obsidian's copies.
- **Server loads yjs as CJS** (`createRequire`, `packages/server/src/yjs.ts`), because
  `y-websocket/bin/utils.cjs` does; mixing ESM+CJS yjs triggers "Yjs was already imported".
- **Seeding is centralised in `CollabSession.ready()`**, only when the room is empty, after sync.
- **Sharing model = global accounts + per-document ACL + stable `docId`.** `vaultId::path` is only a
  Phase 0/1 testing shortcut. Recorded in `PLAN.md`.

## Known issues / debt

- **Phase 0 does not write edits back to `.md` files** (Phase 1). Testing must look at the other
  client's *editor*, not the file on disk.
- **Edits made while the editor is detached are discarded.** After Obsidian rebuilds the editor
  state, the re-attach reconciles the editor to the shared document, which wins. Harmless in Phase 0
  (nothing is written to disk), but it has to be revisited once the file path exists.
- Main-editor integration uses Obsidian-internal `(editor as any).cm`; version-fragile, dedicated
  collab view exists as fallback.
- Seeding race if two clients join a genuinely empty room simultaneously (documented in `PLAN.md`).
- Two Obsidian clients on the same machine may also sync via `BroadcastChannel` (y-websocket
  default), masking server issues. Prefer two real devices. `test:sync` passes `disableBc: true`.

## Verification state

- `npm run typecheck`: passes for all three workspaces.
- `npm run build:plugin`: passes; `packages/plugin/main.js` rebuilt 2026-09-18 (the previous one was
  from 2026-09-15 and predated both the seeding fix and this one).
- `node packages/server/scripts/ws-selftest.mjs ws://localhost:1234`: **PASS** (server relays).
- `npm run test:sync`: **21/21 PASS** against a locally running server.
- `.github/workflows/build.yml`: YAML parses, every `run` block passes `bash -n`, the packaging step
  and all three `gh release` paths were executed locally against a stubbed `gh`. **Never run on
  GitHub yet** — the repo has no remote.
- **On-device Obsidian test: still outstanding.**

---

## Log

### 2026-09-18 (later)
- Diagnosed "connected but no sync": view plugin crashed during construction and was silently
  deactivated by CodeMirror. Reproduced headlessly, fixed, regression-tested.
- Hardened seeding, editor targeting, and server-side room loading/saving.
- Added `npm run test:sync`; deleted the polluted `packages/server/data/`; rebuilt `main.js`.
- Added re-attach after Obsidian rebuilds the editor state, plus the guard that keeps a detached
  editor from writing into the room.
- Added the build/release GitHub Action.

### 2026-09-18
- Scaffolded monorepo: `packages/shared` (protocol/types), `packages/server`, `packages/plugin`.
- Server: Fastify + `y-websocket` + JWT + disk persistence + `/health`, `/auth/dev-token`, `/auth/login`, `/rooms`.
- Plugin: `CollabSession`, `MainEditorCollabAdapter` (CM6 injection), custom `Y.Text` binding +
  remote cursors, `CollabView` fallback via `y-codemirror.next`, settings incl. editable Vault ID.
- Fixed `@codemirror` duplicate-instance typecheck failures (root `overrides` to Obsidian's peers).
- Fixed "Yjs was already imported" by loading yjs as CJS on the server.
- Fixed note duplication by centralising seeding in `CollabSession.ready()`.
- Added debug instrumentation and `ws-selftest.mjs`; opened the "connected but no sync" investigation.
