# Progress

_Last updated: 2026-09-20 · Phase 1 built, renamed to **Obsidian Connect**, two pairing bugs fixed. Everything testable headlessly is green; **the in-Obsidian path has still never completed a successful two-device run**._

## Where we are

Monorepo (`npm` workspaces): `packages/shared`, `packages/server`, `packages/plugin`.
Architecture, invariants and the Phase 2 plan live in **`CLAUDE.md`** — read that first.

Phase 1 is implemented end to end: every markdown note is permanently CRDT-backed, one
multiplexed WebSocket per vault, local persistence via `y-indexeddb`, file write-back with
agreement detection, three-way reconcile with backups, rename/delete through the vault index,
and server-side version history with rollback.

## Next step

**The user is about to run the first real two-device test.** Nothing else should be built until
that passes.

The plugin id changed, so a clean install is required:

1. Delete `.obsidian/plugins/crdt-sync/`, install into `.obsidian/plugins/obsidian-connect/`
2. Delete `packages/server/data/` (old rooms are path-keyed leftovers)
3. **Set the identical Vault ID on both devices** — the vault *name* is irrelevant
4. Status bar reads `Connect: <state> · loaded/tracked`. `0/0` means nothing was adopted,
   which is an index problem, not a sync problem

Scenario that matters most, because it is the bug everything started with: both devices offline,
edit the same note on both, bring the server back. Both texts must survive; backups land in
`.obsidian/plugins/obsidian-connect/backups/`.

## Fixed in this session

- **Pairing was broken because document ids were random.** `crypto.randomUUID()` was minted by
  whichever device saw a file first, so two devices scanning before either had received the
  other's index created two documents for one note and then synced faithfully past each other.
  Ids are now `stableDocId(vaultId, path)`. `duplicatePaths()` + `mergeDuplicates()` fold
  together any pair that still diverges, keeping the lower id and merging the other's text
  additively.
- **`DocStore.start()` waited on the vault index forever.** With the server unreachable the
  plugin looked loaded, reported a connection and tracked nothing. Now: timeout, a notice, and a
  retry when the socket reconnects.
- **The status bar now shows `loaded/tracked`**, so "nothing was adopted" is visible at a glance.
- **Removed `HistoryStore.compact()` and `logBytes()`** — dead code, and `compact()` deleted the
  whole log, i.e. every rollback point, if anyone had ever called it.
- **Removed a raw NUL byte** used as a placeholder in the glob matcher; the matcher moved to
  `sync/glob.ts` so it can be tested without importing Obsidian.
- **Renamed to Obsidian Connect** throughout: plugin id, display name, log prefix
  `[obsidian-connect]`, CSS classes, workspace scope `@obsidian-connect/*`, env vars
  `OBSIDIAN_CONNECT_*`.
- **CI produces a second, flat zip** (`<id>-<version>-update.zip`) holding just `main.js`,
  `manifest.json` and `styles.css` at the root, for overwriting an existing install.

## Known issues / debt

- **Attachments are not synced.** Binary files do not travel through Yjs.
- **Notes beyond `maxLoadedDocuments` (500) stop receiving live updates** until opened again.
- **No accounts or ACLs yet.** Dev mode lets anyone who can reach the server read and write every
  room, and anyone who knows a Vault ID reads that whole vault. Do not expose it to the internet.
- **Conflicts keep both versions** rather than resolving them — deliberate, but a conflicted note
  needs manual cleanup.
- **Edits made while the editor is detached are discarded** when it re-attaches; the shared
  document wins that reconcile.
- Main-editor integration uses the Obsidian-internal `(editor as any).cm`; version-fragile, with
  the dedicated collab view as fallback.
- The plugin name contains "Obsidian", which the community catalogue forbids. Irrelevant while
  self-hosted, blocking for a later submission.

## Verification state

- `npm run typecheck`, `npm run build:plugin`: pass.
- `test:merge` 33, `test:load` 4, `ws-test` 1, `test:socket` 7, `test:history` 7, `test:sync` 21 —
  all pass, in the working tree and in a fresh clone with its own server.
- `.github/workflows/build.yml`: YAML parses, every `run` block passes `bash -n`, the packaging
  step and all release paths were executed locally against a stubbed `gh`.
- **On-device Obsidian test: still outstanding.** `DocStore`, `DocHandle`, the startup scan, vault
  events, file write-back and both modals have never run.

## Log

### 2026-09-20
- Renamed to Obsidian Connect; made document ids deterministic; fixed the index-sync hang;
  removed dead and dangerous history code; added the flat update zip; wrote `CLAUDE.md`.
- Agreed the Phase 2 design: account-derived vault ids, the share/detach/revoke rules, and the
  end-to-end encryption scheme with key epochs. All recorded in `CLAUDE.md`.

### 2026-09-19
- Built Phase 1: vault-wide CRDT sync, multiplexed transport, local persistence, file bridge,
  three-way reconcile with backups, vault index, server history with rollback, history and
  backup UI. Added `test:merge`, `test:socket`, `test:history`, `test:load`.
- `test:merge` immediately caught a real bug: the no-base union spliced local text into the
  middle of a remote line because a minimal character replacement ignores line boundaries.

### 2026-09-18
- Diagnosed "connected but no sync": the CodeMirror view plugin dispatched from its constructor,
  which CodeMirror answers by silently deactivating the plugin. Fixed and regression-tested.
- Hardened seeding, editor targeting, server-side room loading and saving; added re-attach after
  Obsidian rebuilds the editor state; added the build/release GitHub Action.
- Fixed CI: the self-tests relied on a global `WebSocket` (Node 22+) and jsdom 30 does not support
  the Node 20 the workflow pinned. Baseline is now Node 22+, CI builds on 24.
