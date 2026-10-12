# Changelog

Newest first. What each version changed and, where it fixed a bug, how the fix was
verified. `docs/PROGRESS.md` holds only the current state.

"Checked by putting the bug back" means: the old behaviour was restored in the source,
the suite run, the new checks seen failing (and nothing else), the fix restored.

## 0.5 - attachments (2026-10-10 to 12, spec `docs/PHASE4.md`)

- **0.5.7** (2026-10-12) - the plugin's items in every file menu sit in a section of
  their own under a label with the plugin's name (`MENU_SECTION`, `setIsLabel`;
  submenus are not public API). Clicking the cloud opens the same menu, plus the
  trash and incoming shares. The cloud shows for attachments too
  (`AttachmentStore.fileState`; `local` for a file the server does not take). Beside
  it a mark for a shared note - a lock when only to read - and a lock in the header
  of every view of a read-only note, for phones (`markReadOnlyViews`). "Earlier
  versions" became "Version history", one command for notes and files. `test:vault`
  224.
- **0.5.6** (2026-10-11) - the share dialog says when the person has the note
  already, starts from their access and reads "Share again": sharing again is how
  the server changes their access, and the default "Can edit" turned a reader into
  an editor without a word.
- **0.5.5** (2026-10-11) - "Also share the notes it links to" (`share/LinkedNotes.ts`):
  the notes a note reaches through links, listed with the reason when one cannot go
  along, shared once with the same choices, landing below the share folder at their
  link's path (the sealed title carries folders; `DocStore.freePath`). A note the
  person has already is skipped. Incoming shares are taken one pass at a time, one
  notice for several; notices name contacts instead of account ids. Checked by
  putting the bug back: a title's folders flattened (`Shared/Ideas Roadmap.md`) and a
  note the person had shared again (their access overwritten) - four checks failed.
- **0.5.4** (2026-10-11) - shared notes carry their files, both ways, by the owner's
  choice per note (`share/SharedFiles.ts`), copied into each account's own store,
  landing in `<share folder>/Attachments/`; deleting a received file leaves it for
  good. Fixed on the way: compaction up to exactly a device's last frame was taken
  for a server restored from a backup, so every note untouched for longer than the
  retention would have been held and asked about (from about 2026-10-18 on).
  Checked by putting the bug back (B held every old note). The shared files'
  conflict and lineage paths are covered but were not each checked with the bug back.
- **0.5.3** (2026-10-11) - the trash in every folder's menu and in the settings; a
  note's version history renders each version, pictures deleted since shown from
  the trash with a Restore button.
- **0.5.2** (2026-10-11) - the trash and earlier versions of files, a preview for
  images, restore and save as a copy, cleaning up the server's blobs in the trash
  pass (10-minute grace on the server), the account's usage in the settings. Checked
  by putting the bug back: a clean-up that forgets what the server kept (trash entry
  lost) and one that purges content a live file needs (the server lost the scan).
- **0.5.1** (2026-10-10) - canvas card names that never left the device, and a
  conflict copy without the latest save: the base recorded the stat after the
  upload, and a conflict overwrote a file without checking it still held what was
  read (invariant 23). Events always read now, a scan every minute catches missed
  events, a view saving over another device's version keeps that version as a
  second file. All five old behaviours put back at once: each of the five new checks
  failed, nothing else.
- **0.5.0** (2026-10-10) - attachments between one's own devices: blobs encrypted in
  chunks, the server's blob store, `AttachmentStore`, conflicts as two files, the
  download limit, self-healing; a note renamed to another extension no longer comes
  back. Checked by putting the bug back: two racing writes of one attachment without
  the lineage rule (one version lost - invariant 24), healing only on start, a note
  renamed to `.txt` (pulled back in).

## 0.4 - the first device run (2026-09-27 to 10-10)

- **0.4.2** - another device's rename is applied with `vault.rename` (invariant 22):
  `fileManager.renameFile` rewrote links a second time (`[[RenamedRenamed]]`).
  Reproduced in `test:vault` by holding back both devices' note changes; fails with
  the old code.
- **0.4.1** - carets only of other people: the owner is told when the last
  participant leaves, and the awareness state names the account, not the name.
- **0.4.0** - "Compare versions" for notes kept in two versions; a log file per day;
  the note cloud; sharing in the note menus; friend codes listed and deletable;
  account screens; show-password eye; carets redrawn robustly. Version numbers
  introduced. A bundle built during a `git stash` check shipped old code;
  `test:load` now fails when a source is newer than `main.js`.

## Before version numbers

- **Phase 3** (2026-09-24 to 26, `docs/PHASE3.md`) - surviving a server that lost or
  rolled back data, accounts without names, contacts by one-time code, forking a
  share with its history, removing accounts, the trash; Docker image built by CI.
- **Phase 2** (2026-09-23, `docs/PHASE2.md`) - accounts, end-to-end encryption,
  sharing by person, Docker; fixes from the first device run of Phase 1.
- **Phase 1** (2026-09-18 to 22) - vault-wide CRDT sync, multiplexed transport, file
  bridge, three-way reconcile with backups, vault index, history. Found the
  ViewPlugin CodeMirror silently deactivated (invariant 6) and the text doubling
  between devices (invariants 7-9).
