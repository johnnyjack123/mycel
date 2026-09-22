# Progress

_Last updated: 2026-09-22 · Vault sync and editor binding rebuilt, sharing by link added, history fixed. Everything headless is green, including a two-device end-to-end test; **the in-Obsidian run is still outstanding**._

## Where we are

Monorepo (`npm` workspaces): `packages/shared`, `packages/server`, `packages/plugin`.
Architecture, invariants and the Phase 2 plan live in **`CLAUDE.md`** — read that first.

Branch `fix/vault-sync`, not pushed.

## Next step

**On-device test with two devices**, then with a second person. Server restart needed
(history fix), plugin update on both devices.

1. Keep the Vault ID identical on both devices.
2. Open the same note on both, type on both at once — nothing may double.
3. Create, rename, delete a note on one device — the other follows.
4. Close one device, edit the same note on both, reopen — both edits survive.
5. "Share this note live", open the link on the other person's Obsidian — both see
   each other's cursor; the note appears in their `Shared/` folder.

If the editor does not bind (status: *Editors bound: 0* while a note is open), the
console will show why. The one assumption only a device can confirm: `editorInfoField`
already reports the new file when Obsidian loads it into a leaf.

## Fixed in this session

What the user saw — nothing syncing, fallback panes, an error on load, a note filling
itself with `t`s — came from these, all reproduced headlessly first:

- **Notes never reached a device that did not already have them.** Nothing created
  files from the index. `DocStore.pullMissing` now does, folders included.
- **The file was reconciled against the document while an editor was bound.**
  Obsidian's save lags the typing, the three-way merge saw a conflict in the same
  line and kept both — the text duplicated itself and bounced between devices. The
  escalation. A bound note's file is now only compared, never merged.
- **Editors were bound before their note was settled**, to an empty document the
  server had not sent yet: keystrokes at non-existent positions, then the note
  seeded a second time. `EditorSync` settles first.
- **Remote deltas were mapped onto CodeMirror in the wrong coordinates.** Every
  multi-part change after the first part landed shifted, with the length intact, so
  nothing noticed editor and document drifting apart.
- **The editor extension was injected with `appendConfig`** and re-attached from
  workspace events mid-layout — the crashes and the fallback panes. Replaced by one
  ViewPlugin through `registerEditorExtension`; the fallback view is gone.
- Remote changes no longer land in the undo history; a wholesale buffer reload
  becomes a diff; Obsidian reloading our own write is not taken as an edit.
- A remote delete is applied before the startup scan could revive the note, and only
  to an unchanged file; renames/deletes before the index arrived are replayed.
- One file operation per note at a time (per-document lock); a handle still loading
  is never handed out; stopping waits for running operations before saving state.
- `VaultSocket` forgets "synced" on disconnect, so a reconnect is waited for.
- **Server history**: an idle room wrote a snapshot of the current state, so every
  older version read as the latest and restore did nothing. Existing rooms keep the
  collapsed state they already have; new versions are fine.
- **Sharing (interim, until accounts):** share link carrying the docId, joining adds
  it to the recipient's own index, presence only for `shared` entries.

## Known issues / debt

- **Attachments are not synced.**
- **Notes beyond `maxLoadedDocuments` (500) stop receiving live updates** until
  opened again or the next restart.
- **No accounts or ACLs.** Anyone who reaches the server reads and writes every room;
  a share link cannot be revoked; "Stop sharing" only turns cursors off.
- **Conflicts keep both versions** — deliberate, but needs manual cleanup.
- Changing the display name takes effect for notes loaded afterwards.
- The plugin name contains "Obsidian", which the community catalogue forbids.

## Verification state

- `typecheck`, `build:plugin`: pass.
- `test:merge`, `test:load` (now runs onload, start and unload), `test:rooms`, and
  against a scratch server on 1235: `ws-test`, `test:socket`, `test:history`,
  `test:sync` (19), `test:vault` (55) — all pass, the timing-based ones repeatedly.
- Mutation checks: reinstating each of the old bugs (merging a bound note's save,
  the old delta mapping, binding before settling, remote changes in undo, no
  wholesale diff, no echo filter) makes the matching check fail.
- **On-device Obsidian test: outstanding.**

## Log

### 2026-09-22
- Diagnosed why vault sync never worked and live editing escalated; rebuilt the file
  bridge, the editor binding and the socket's sync tracking; added sharing by link;
  fixed server history; added `test:vault` and `test:rooms`.

### 2026-09-20
- Renamed to Obsidian Connect; made document ids deterministic; fixed the index-sync hang;
  removed dead and dangerous history code; added the flat update zip; wrote `CLAUDE.md`.
- Agreed the Phase 2 design: account-derived vault ids, the share/detach/revoke rules, and the
  end-to-end encryption scheme with key epochs. All recorded in `CLAUDE.md`.

### 2026-09-19
- Built Phase 1: vault-wide CRDT sync, multiplexed transport, local persistence, file bridge,
  three-way reconcile with backups, vault index, server history with rollback, history and
  backup UI. Added `test:merge`, `test:socket`, `test:history`, `test:load`.

### 2026-09-18
- Diagnosed "connected but no sync": the CodeMirror view plugin dispatched from its constructor,
  which CodeMirror answers by silently deactivating the plugin. Fixed and regression-tested.
