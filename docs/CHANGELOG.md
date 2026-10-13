# Changelog

Newest first. What each version changed and, where it fixed a bug, how the fix was
verified. `docs/PROGRESS.md` holds only the current state.

"Checked by putting the bug back" means: the old behaviour was restored in the source,
the suite run, the new checks seen failing (and nothing else), the fix restored.

## 0.6 - recovery codes and two-factor sign-in (from 2026-10-12, spec `docs/PHASE5.md`)

- **0.6.4** (2026-10-13) - conflict markers on a device nobody typed on, and keystrokes
  lost while an editor bound again (invariant 25). Reported by the user: two devices
  online, fast typing on one, and the note came out with nested `<<<<<<<` blocks.
  When an editor binds again while someone types elsewhere - the note shared or
  unshared, its access changed, the editor letting go - the file Obsidian last saved
  lags the document by a few keystrokes, and so does the editor. Both were taken for
  edits made on that device and merged three ways against an older base, which saw
  both sides change the same line. Now a text the document already held is an older
  copy, never an edit (`DocStore.heldBefore`: fingerprints of every text a note with
  an editor had), and a save the document went past counts as an agreement. An editor
  binding again compares itself with what it and the document said when it let go
  (`released`), and the file stays Obsidian's meanwhile (`EditorSync.rebinding`):
  writing it made Obsidian reload the editor, and whatever was typed in between was
  gone. The log: a note or file kept in two versions is an error, "Copy log" puts
  errors and warnings first, presence and carets are logged only when they change, an
  editor binding again is logged, and a signed-out device's file transfers no longer
  log an error with a stack. "Detailed logging" is a setting of its own, apart from
  "Log". `test:vault` 230, `test:merge` 145. Checked by putting the bug back: with the
  0.6.3 sources, the three new checks of A typing while the note is shared and
  unshared and B's editor binds again failed (conflict markers, characters lost), and
  nothing else. Neither of the user's two logs shows the merge that happened; a third
  client was present in the note (`3 present`), and its log is asked for.

- **0.6.3** (2026-10-12) - a recovery can keep two-factor sign-in. Asked by the user
  after trying 0.6.2: a forgotten password meant a new entry in the authenticator app.
  `/auth/recover` now says whether the account has 2FA, and the plugin asks
  (`askKeepTotp`): a current code from the app keeps it with the same secret,
  "Turn it off" does what 0.6.2 did, closing cancels the recovery. The code travels
  with `/auth/recover/commit` (`totpCode`). It is checked like a sign-in code: its
  step is spent, and a wrong one counts against the account and changes nothing,
  so the recovery code is not spent and the plugin asks again. Once codes are
  blocked, the dialog offers only to turn it off. A 0.6.2 plugin sends no code and
  gets the old behaviour. `test:rooms` 233, `test:account` 46. Checked by putting
  the bug back: with the recovery always turning 2FA off, the 12 new checks in
  `test:rooms` and 5 in `test:account` failed, and nothing else.

- **0.6.2** (2026-10-12) - two-factor sign-in with TOTP, optional per account. The
  settings turn it on in three steps (`TotpSetupModal`): the password, checked on the
  device against its master key; whether the recovery code is at hand, offering a
  new one (or making the first); then a QR code (`qrcode-generator` 2.0.4, drawn as
  an SVG of its own, dark on light), an `otpauth://` link for a phone running
  Obsidian, the key to type, and a first code checked on the device before the
  server is asked. Turning it on signs out every other device. Signing in is two
  steps: the right password answers `403` with a challenge token of scope `2fa`
  (5 minutes), `/auth/login/totp` takes it with the code (`askTotpCode`). A used
  time step is spent; five wrong codes block codes for that account for 15 minutes,
  on top of the address throttle. Off with password and a current code, by a
  recovery (which offers to turn it on again), or by the admin
  (`obsidian-connect user 2fa-off <accountId>`); `user list` shows `2fa`. A 0.5 or
  0.6.0/0.6.1 plugin signing in to such an account shows a message to update.
  `test:merge` 142 (RFC 6238 vectors, RFC 4648 key, the link), `test:rooms` 220,
  `test:account` 40. Checked by putting the bug back: without `lastStep` the server
  took a code twice - four checks failed.

- **0.6.1** (2026-10-12) - the recovery code. Every new account gets one, shown once
  (`RecoveryCodeModal`: copy, "I have written it down"); the settings show whether
  the account has one and make a new one or delete it, asking for the password
  (`PasswordPromptModal`). "Use a recovery code…" on the sign-in screen opens the
  account with the code alone and sets a new name and password; the code is spent,
  the new one shown, every other device signed out. 30 characters in six groups,
  128 random bits and a 22-bit check, so a typo is caught on the device
  (`encodeRecoveryCode`); the server finds the account by the hash of a key from
  it (`recoveries` in `accounts.json`) and keeps a second wrapping of private key
  and account secret, which only the code opens. Every new wrapping is checked to
  open again before it is sent. `user list` shows which accounts have a code.
  `test:merge` 138, `test:rooms` 190, `test:account` 27.

- **0.6.0** (2026-10-12) - a password change signs out every other device on the
  server, not only the honest ones. Every account has a session generation, every
  token carries it (`gen`; tokens from before count as 0, so the update signs
  nobody out), and a token of an older generation is refused by every route, the
  refresh and the socket upgrade. The server closes the account's open sockets with
  `4401` (`CLOSE_SIGNED_OUT`); a stale or invalid token at the upgrade is closed the
  same way rather than refused, which a browser WebSocket would only retry forever.
  The plugin asks the server on `4401` (`Session.stillSignedIn`) and either carries on
  with its token or stops and says to sign in again; files and unsent edits stay. A
  removed account's devices are closed the same way instead of seeing every note of
  theirs revoked. New suite `test:account` (in-process server), `test:rooms` 165.
  Checked by putting the bug back: without waiting for its own password change
  (`Session.moving`), the device that changed the password read the server closing
  its socket as being signed out and signed itself out, 3 of 3 runs.

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
