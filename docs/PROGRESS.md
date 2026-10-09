# Progress

_Last updated: 2026-10-09 · **0.4.1 on `feat/accounts`: Phases 1-3 plus the fixes from the first device run. Next milestone: 0.5, attachments - design first.**_

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

**Milestone 0.5: attachments.** Today the plugin ignores every non-Markdown file. They
need an encrypted blob store of their own - not the CRDT. Design it with the user
before building; open questions below. Then, as for every phase: spec in
`docs/PHASE4.md`, build step by step with tests and a commit each, bump to 0.5.0.

1. Read how the vault index, `DocStore` and the server's folders work
   (`sync/VaultIndex.ts`, `sync/DocStore.ts`, `server/src/log.ts` `roomDir`).
2. Agree the design (questions below), write `docs/PHASE4.md`.
3. Build: blob encryption in `shared/crypto`, server blob routes and storage under
   `users/<account>/<vault>/blobs/`, the plugin side (upload on create/modify, pull
   missing, deletes into the trash), tests in `test:rooms` and `test:vault`.

## In flight / half-finished

Nothing.

## Decisions made this session

- Plugin and settings sync (0.7) only as snapshots from a chosen device, never through
  the CRDT - reasons in `CLAUDE.md`, "Not built yet".
- A note's presence is for other people only: a note nobody else is in is not shared,
  and carets of the same account are never drawn (account id in the awareness state).
- Reviews ("Compare versions") are device-local and only for merges without a base or
  with conflicts; two devices seeding different texts at the same moment produce no
  review (rare, the note then holds both texts).

## Open questions for the user

For attachments (0.5):
- Which files - everything that is not Markdown, or a list (images, PDFs)? A size limit?
- Should a note shared with someone carry the attachments it embeds?
- Deleted attachments: into the same trash as notes, with the same retention?
- Mobile: download every attachment, or only when a note that embeds it is opened?
- A conflicting edit of a binary file cannot be merged: keep both as two files
  (`name (other device).png`)?

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
