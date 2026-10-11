# Progress

_Last updated: 2026-10-11 · **0.5.6 on `feat/accounts`: milestone 0.5 built - attachments between one's own devices, the trash and earlier versions, shared notes carrying their files and the notes they link to (`docs/PHASE4.md`). Next: the user tests all of 0.5 on devices; then 0.6.**_

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

2026-10-10, 0.5.0 on devices: attachments sync, canvas conflicts give two files. Seen:
a canvas card named right after it was created arrived without its name until the
next change; once a conflict copy lacked a card's name typed offline. 0.5.1 fixes the
causes found (see PHASE4, "Hardened in 0.5.1"); not confirmed on devices yet.

**0.5.0 needs the server restarted with the new code** (blob routes) - the user's
server on 1234 runs whatever they started last. An old server makes the plugin sync
notes only (it logs "the server does not store attachments"). Behind nginx, request
bodies need at least 8 MB (`docs/SERVER.md`).

## Next step

**Milestone 0.5: attachments**, spec in **`docs/PHASE4.md`**, three steps:

1. **Own devices - built, 0.5.0, hardened in 0.5.1.** Confirmed on devices: files
   arrive, conflict copies. Still to confirm: canvas card names (0.5.1), the phone's
   10 MB limit and "Download attachments".
2. **Trash and earlier versions - built, 0.5.2; 0.5.3 after the first look.** Seen
   on devices: the trash was hard to find, a version preview showed pictures as text.
   To confirm: the trash from a folder's menu and the settings, the rendered version
   preview with deleted pictures, "Earlier versions" in a file's menu (image
   preview, restore, save as a copy), the usage line in the settings.
   Restoring notes and files from the trash confirmed on devices (2026-10-11).
3. **Shared notes' files - built, 0.5.4; the notes they link to - built, 0.5.5.**
   To confirm on devices: the toggle in the share dialog and in "Who has access" (a
   note shared before 0.5.4 counts as off), a picture arriving in
   `Shared/Attachments/`, a change going back to the owner's own file, deleting a
   received picture keeping it away; "Also share the notes it links to" - the list
   with the reasons a note cannot go along, the linked notes landing in folders below
   `Shared/` and their links resolving there, one notice for several notes; sharing
   a note again with someone who has it (0.5.6: the hint, their access preselected,
   "Share again").

**Next:** the user tests all of 0.5 on devices (2026-10-12 onwards). Then 0.6,
recovery codes and 2FA.

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
- Decided while building step 3, without asking: files that come in through a share
  are copied into the receiving account's own store (twice the space on the server,
  everything of steps 1-2 unchanged); the base per shared file belongs to the vault,
  not the device; a note shared before 0.5.4 does not share its files until the
  owner turns it on in "Who has access".
- Decided for linked notes (0.5.5), without asking: a linked note the person already
  has is skipped, since sharing it again would overwrite their access; a linked note
  shared before keeps its own choice about files; links are followed only through
  notes that go along.
- Found while building, decided without asking (invariant 24): an attachment entry is
  replaced whole, so two devices writing at once lose one write silently. Entries name
  what they replaced (`prev`) and every replacement leaves a version record; a version
  that never saw a device's content is a conflict there, both files kept.

Earlier:
- Plugin and settings sync (0.7) only as snapshots from a chosen device, never through
  the CRDT - reasons in `CLAUDE.md`, "Not built yet".
- A note's presence is for other people only: a note nobody else is in is not shared,
  and carets of the same account are never drawn (account id in the awareness state).
- Reviews ("Compare versions") are device-local and only for merges without a base or
  with conflicts; two devices seeding different texts at the same moment produce no
  review (rare, the note then holds both texts).

## Open questions for the user

None open. To check on a device: Obsidian resolving links by the end of their path
(`[[Ideas/Roadmap]]` finding `Shared/Ideas/Roadmap.md`, `![[diagram.png]]` finding
`Shared/Attachments/diagram.png`), and which file wins when two share a name.

## Known issues / debt

- **On a device only:** the caret fix of 0.4.1, the review dialog, the note cloud, the
  note menus, the trash dialog, the log file - all untestable headless. For 0.5.0:
  `readBinary`/`createBinary`/`modifyBinary` and their events, `requestUrl` with binary
  bodies on mobile, `file-open` fetching, memory with large files on a phone.
- A file over the server's limit is only logged; no mark in its menu yet.
- Content uploaded but never named in the index (a crash between the two) is never
  cleaned up from the server.
- Notes beyond `maxLoadedDocuments` (500) stop receiving live updates until opened (0.9).
- No password recovery, no 2FA (0.6).
- Frames authenticated by the note's key, not signed per author (0.9, `docs/PHASE3.md`).
- Local copies of a purged note stay in IndexedDB on the devices that did not purge it.
- The plugin name contains "Obsidian", which the community catalogue forbids (0.9).

## Verification state

2026-10-11, 0.5.6 (the share dialog only): `typecheck`, `build`, `test:load` and
`test:merge` pass; the dialog itself is untestable headless. 0.5.5: `typecheck` and `build` pass; `test:merge` (130), `test:load` (12),
`test:rooms` (156), `test:sync` (26), `test:recovery` (56), and against a scratch
server on 1235 `test:socket` (19) and `test:vault` (222) - all pass. For 0.5.5 checked
by putting the bug back: a title's folders flattened (`Shared/Ideas Roadmap.md`) and
a note the person had shared again (their access overwritten) - four checks failed,
nothing else. For 0.5.4 also
checked by putting the bug back: a snapshot ending exactly at a device's last frame
taken for another server (B held every old note). Shared files' conflict and
lineage paths are covered (two people changing a picture at once; A's other device
seeing A's change before the note) but were not each checked with the bug back. Checked by putting
the bug back: the link doubling of 0.4.2 (`[[RenamedRenamed]]`), two racing writes of
one attachment without the lineage rule (one version lost), healing only on start
(the server's lost blob never came back), a note renamed to `.txt` (pulled back in);
for 0.5.1 all five old behaviours at once - each of its five new checks failed,
nothing else; for 0.5.2 a clean-up that forgets what the server kept (trash entry
lost) and one that purges content a live file needs (the server lost the scan).
Not verified: anything on a device beyond what the user reported, and the Docker
image (built by CI only on `main`).

---

## Log

### 2026-10-11
- 0.5.6: the share dialog says when the person has the note already, starts from
  their access and reads "Share again" - sharing again is how the server changes
  their access, and the dialog's default "Can edit" turned a reader into an editor
  without a word.
- 0.5.5: "Also share the notes it links to" in the share dialog - the notes a note
  reaches through links, listed with the reason when one cannot go along, shared once
  with the same choices and landing below the share folder at their link's path. A
  note the person has already is left as it is. Incoming shares are taken one pass at
  a time, with one notice for several; notices name contacts instead of account ids.
- 0.5.4: shared notes carry their files, both ways, by the owner's choice per note -
  copied into each account's own store, landing in `<share folder>/Attachments/`;
  deleting a received file leaves it for good. Found and fixed on the way: compaction
  up to exactly a device's last frame was taken for a server restored from a backup,
  so every note untouched for longer than the retention would have been held and
  asked about (the first frames turn 30 days old around 2026-10-18).
- 0.5.3: the trash in every folder's menu and in the settings; a note's version
  history renders each version, pictures deleted since shown from the trash with a
  Restore button.
- 0.5.2: the trash and earlier versions of files - "Deleted notes and files…",
  "Earlier versions" with an image preview, restore and save as a copy, cleaning up
  the server's blobs in the trash pass (with a 10-minute grace on the server), the
  account's usage in the settings.

### 2026-10-10
- 0.5.1: canvas card names that never left the device, and a conflict copy without
  the latest save - the base recorded the stat after the upload, and a conflict
  overwrote a file without checking it was still what had been read. Events now always
  read, a scan every minute catches missed events, and a view saving over another
  device's version keeps that version as a second file.
- 0.5.0: attachments between one's own devices - blobs encrypted in chunks, the
  server's blob store, `AttachmentStore`, conflicts as two files, the download limit,
  self-healing; a note renamed to another extension no longer comes back.
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
