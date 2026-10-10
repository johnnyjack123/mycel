# Progress

_Last updated: 2026-10-10 · **0.4.2 on `feat/accounts`: Phases 1-3 plus the fixes from the first device run. Next milestone: 0.5, attachments - designed in `docs/PHASE4.md`, step 1 in progress.**_

## Where we are

Monorepo (`npm` workspaces): `packages/shared`, `packages/server`, `packages/plugin`.
**Read `CLAUDE.md` first** - invariants, architecture, the version roadmap to 1.0.0
and the conventions (push after every commit, bump the version for every change the
user installs). Designs: `docs/PHASE2.md` (keys, sharing), `docs/PHASE3.md` (accounts
without names, contacts, forks, trash, surviving the server); running the server:
`docs/SERVER.md`.

Branch `feat/accounts`, pushed, CI green. Not merged to `main` yet - merging is what
builds and publishes the Docker image for the first time. The user runs the server
with npm on the laptop (port 1234, `packages/server/data` - never touch either) and
installs the plugin by copying `main.js`, `manifest.json`, `styles.css`.

On the user's devices (2026-10-09): sign-in and account creation, sync, sharing and
live editing work. The account screens of 0.4.0 are confirmed. Carets between one's
own devices were the last thing reported; 0.4.1 fixes them, not confirmed yet.

## Next step

**Milestone 0.5: attachments.** Designed with the user on 2026-10-10:
**`docs/PHASE4.md`** is the spec. Build it in its three steps, each with tests and a
commit; the first build the user installs is 0.5.0.

1. **Own devices:** blob encryption and ids in `shared/crypto` (+ `test:merge`), the
   server's blob store and routes (+ `test:rooms`), `sync/AttachmentStore.ts` with the
   fake vault learning binary files (+ `test:vault`), self-healing (+ `test:recovery`).
2. **Trash and earlier versions:** "Deleted files…", "Earlier versions…", cleaning up.
3. **Shared notes:** the attachment list in the note's document, attach records on
   the server, delivering to `<share folder>/Attachments/`, declining by deleting,
   the fork copy, the share dialog (attachments toggle, sharing linked notes).

## In flight / half-finished

Nothing.

## Decisions made this session

Attachments (2026-10-10, details in `docs/PHASE4.md`):
- Every non-Markdown file is a blob (`.canvas` too); excluded globs apply; 100 MB per
  file by default (`OBSIDIAN_CONNECT_MAX_FILE_MB`), optional quota per account.
- Download limit per device, set on each device: everything on desktop, 10 MB on a
  phone by default; larger files come when a note that needs them is opened.
- A conflicting edit keeps both, as two files (`name (conflict <date time>).ext`).
- Deleted attachments go into the same trash as notes, and replaced versions are kept,
  both for the history retention.
- Shared notes carry their attachments in both directions, automatically, with a
  toggle in the share dialog (on by default, per note). Embeds and links to files
  count; links to notes do not, but the dialog offers to share the linked notes too
  (recursively, once, at share time).
- Everything that comes in through a share lands in `<share folder>/Attachments/`,
  for owners as well.
- Deleting a file a shared note brings means leaving that file: it never comes back
  by itself, not even with a new version; restoring it from the trash rejoins.
- Sharing a whole folder: wanted for later, noted in `CLAUDE.md`.

Earlier:
- Plugin and settings sync (0.7) only as snapshots from a chosen device, never through
  the CRDT - reasons in `CLAUDE.md`, "Not built yet".
- A note's presence is for other people only: a note nobody else is in is not shared,
  and carets of the same account are never drawn (account id in the awareness state).
- Reviews ("Compare versions") are device-local and only for merges without a base or
  with conflicts; two devices seeding different texts at the same moment produce no
  review (rare, the note then holds both texts).

## Open questions for the user

None open. To check on a device during step 3: Obsidian resolving links by the end of
their path, and which file wins when two share a name.

## Known issues / debt

- **On a device only:** the caret fix of 0.4.1, the review dialog, the note cloud, the
  note menus, the trash dialog, the log file - all untestable headless.
- Notes beyond `maxLoadedDocuments` (500) stop receiving live updates until opened (0.9).
- No password recovery, no 2FA (0.6).
- Frames authenticated by the note's key, not signed per author (0.9, `docs/PHASE3.md`).
- Local copies of a purged note stay in IndexedDB on the devices that did not purge it.
- The plugin name contains "Obsidian", which the community catalogue forbids (0.9).

## Verification state

2026-10-09, 0.4.1: `typecheck` and `build` pass; `test:merge` (120), `test:load` (12),
`test:rooms` (117), `test:sync` (26), `test:recovery` (42), and against a scratch
server on 1235 `test:socket` (19) and `test:vault` (150) - all pass. Every fix since
0.4.0 was also checked by putting its bug back and seeing its check fail (a deleted
contact code honoured, redeemed codes listed, "both" in the wrong order, carets drawn
only on text changes, the cloud ignoring unsent edits, merges without a review, own
carets drawn, the owner not told someone left). Not verified: anything on a device
beyond what the user reported, and the Docker image (built by CI only on `main`).

---

## Log

### 2026-10-10
- Attachments (0.5) designed with the user: `docs/PHASE4.md`.
- 0.4.2: another device's rename is applied with `vault.rename` (invariant 22).
  `fileManager.renameFile` rewrote the links a second time, and when both devices did
  so before seeing each other's edit every link came out twice - reproduced in
  `test:vault` by holding back both devices' note changes, failing with the old code.

### 2026-10-09
- 0.4.1: carets only of other people - the owner is told when the last participant
  leaves, and the awareness state names the account, not the name.

### 2026-09-27
- 0.4.0, from the first run of Phase 3 on devices: "Compare versions" for notes kept
  in two versions; a log file per day; the note cloud in the status bar; sharing in the
  note menus; friend codes listed and deletable; account screens; show-password eye;
  carets redrawn robustly. Version numbers introduced, with a roadmap to 1.0.0.
- A bundle built during a `git stash` check shipped the old settings screen;
  `test:load` now fails when a source is newer than `main.js`.

### 2026-09-24 to 26
- Phase 3: surviving a server that lost or rolled back data, accounts without names,
  contacts by one-time code, forking a share with its history, removing accounts, the
  trash. Docker image built and published by CI on `main`.

### 2026-09-23
- Phase 2 (accounts, end-to-end encryption, sharing by person, Docker) and the fixes
  from the first device run of Phase 1.

### 2026-09-18 to 22
- Phase 1: vault-wide CRDT sync, multiplexed transport, file bridge, three-way
  reconcile with backups, vault index, history. Found and fixed the ViewPlugin that
  CodeMirror silently deactivated, and the text doubling between devices.
