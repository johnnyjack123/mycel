# Progress

_Last updated: 2026-09-23 · First on-device run went well: device sync and sharing work. Three bugs it turned up are fixed. **Next: accounts (Phase 2).**_

## Where we are

Monorepo (`npm` workspaces): `packages/shared`, `packages/server`, `packages/plugin`.
Architecture, invariants and the Phase 2 plan live in **`CLAUDE.md`** — read that first.

Branch `fix/vault-sync`, not pushed.

## Next step

1. Re-test on device the three fixes below: delete a note on one device while it is
   open on the other; create several new notes in a row (each starts as "Untitled");
   open a new note in a tab that showed another one; type exactly at someone's caret.
2. Then **accounts** — Phase 2 in `CLAUDE.md`: derived vault ids, per-person shares,
   revoke as a protocol message, server-side access control. Open questions for the
   user before building: how accounts come to exist (sign-up, admin, invite); whether
   end-to-end encryption comes with them or after (it changes what the server
   stores, so building accounts on plaintext first means migrating later); read-only
   shares; starting fresh versus migrating existing vaults.

The server data was wiped on 2026-09-23 at the user's request (test data only). Devices
still hold their old documents in IndexedDB and push them back on connect; a fresh
start needs a new Vault ID on every device.

## Fixed on 2026-09-23 (from the first on-device run)

- **A note deleted while open on another device came back, empty, everywhere.** The
  open editor re-acquired the note from its deleted `TFile`, which registered a new
  index entry. Deleted file objects are never synced now (`DocStore.exists`).
- **A new note could take on another note's text.** Two causes, both reproduced:
  a new "Untitled" note derived the id of an earlier one that had been renamed or
  deleted and inherited its document; and opening a new note in a used tab bound it
  while the buffer still held the previous note. Ids now skip every generation the
  index knows, and the binding waits for the note's text (`contentPending`).
- **Applying a remote rename could move the wrong note**: the rename event here was
  looked up by the old path, which a new note had taken meanwhile.
- **Typing exactly at someone's caret pushed it along** on everyone else's screen but
  not on theirs. Carets are anchored the way CodeMirror maps selections. A caret
  moving with text typed before it is correct and unchanged.

## Fixed on 2026-09-22

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
  `test:sync` (19), `test:vault` (74), `test:merge` (48) — all pass, the timing-based
  ones repeatedly.
- Mutation checks: reinstating each of the old bugs (merging a bound note's save,
  the old delta mapping, binding before settling, remote changes in undo, no
  wholesale diff, no echo filter, reused ids, syncing a deleted file, binding before
  the note loaded, old-path-first renames, right-anchored carets) makes the matching
  check fail.
- **On-device:** sync between two devices and sharing work (user, 2026-09-23). The
  fixes of 2026-09-23 are verified headlessly only.

## Log

### 2026-09-23
- First on-device run: sync and sharing work. Fixed the four bugs it surfaced, each
  reproduced in `test:vault` first. Wiped the server's test data on request.

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
