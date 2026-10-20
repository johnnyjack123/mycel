# Progress

_Last updated: 2026-10-20 · **Milestone 0.7 - a backup server of its own (`docs/PHASE6.md`, running it: `docs/BACKUP.md`) - was built as 0.7.0 to 0.7.5 and merged into `main`. After it the user asked for more, decided on 2026-10-16 (`docs/PHASE6.md`, "After the first build"): 0.7.6 to 0.7.9, merged. 0.7.10 to 0.7.16 came from setting it up on the user's network. 0.7.17 (2026-10-18): one backup task per vault, paths picked by the backup server, one backup server per vault - merged; backups by hand work on the user's Pi. 0.7.18 (2026-10-20): a time of day, waiting while someone writes, rclone, the password shown - on `feat/backup-schedule`. Next: the user checks the scheduled backup; then 0.8. 0.6.8 is the last version confirmed on the user's devices.**_

## Where we are

Monorepo (`npm` workspaces): `packages/shared`, `packages/server`, `packages/plugin`,
`packages/backup`.
**Read `CLAUDE.md` first** - invariants (27 of them, each from a real bug), the
architecture, the version roadmap to 1.0.0 and the conventions. Designs:
`docs/PHASE2.md` (keys, sharing), `docs/PHASE3.md` (accounts without names,
contacts, forks, trash, surviving the server), `docs/PHASE4.md` (attachments),
`docs/PHASE5.md` (recovery codes, 2FA), `docs/PHASE6.md` (the backup server);
`docs/SERVER.md` for running the server, `docs/BACKUP.md` for a backup server;
`docs/CHANGELOG.md` for every version and how its fixes were verified.

Everything up to 0.6.8 was built on one branch, `feat/accounts`, and merged into
`main` on 2026-10-14, which also built the Docker image for the first time (see
"Verification state"). From now on every milestone gets a branch of its own from
`main`, merged when it is done (CLAUDE.md, Conventions). The user
runs the server with npm on the laptop (port 1234, `packages/server/data` - never
touch either; see CLAUDE.md, Gotchas) and installs the plugin by copying
`main.js`, `manifest.json`, `styles.css`. 0.6 changes the server too: the user's
server needs restarting with it (tokens from before stay valid, nobody is signed
out by the update).

Confirmed on the user's devices: sign-in and account creation, note sync, sharing
and live editing, attachments syncing with conflict copies, restoring notes and
files from the trash, the version history with rendered Markdown, linked notes
(2026-10-12). On 2026-10-12 the user said that with 0.5.7's changes (plugin menu
section, cloud for files, read-only mark) milestone 0.5 is done. 0.5.7 itself has
not been seen on a device yet.

## Next step

**Milestone 0.6 is built** (`docs/PHASE5.md`, decided with the user on
2026-10-12): 0.6.0 signing out the other devices, 0.6.1 the recovery code, 0.6.2
two-factor sign-in, 0.6.3 a recovery keeping 2FA. The user tried 0.6.2 on a device
and found it working well, except that a recovery meant a new entry in the
authenticator app - 0.6.3 answers that. What only a device can show is listed under
"To verify on a device" in `docs/PHASE5.md`.

**0.6.4** (2026-10-13): while testing, the user typed fast on one device with another
online, and the note came out with nested conflict markers. Reproduced in `test:vault`:
an editor binding again while someone types elsewhere merged Obsidian's lagging save
and its own lagging text in as edits (invariant 25); the typing device also lost the
keystrokes typed during its own rebind. Fixed, and the log made easier to read
(conflicts as errors, errors and warnings first when copied).

**0.6.5** (2026-10-13): the user said nothing happened on the other device and no
third one was online. The third client was a second copy of the plugin on that other
computer: loaded at 19:59:47, unloaded 12 s later while its start still waited, and
the start went on and built everything after the unload (invariant 26). Fixed and
checked in `test:load`. The user installs 0.6.5 (plugin only; the server is unchanged
since 0.6.3) and **restarts Obsidian fully** on every device - a copy left running by
0.6.3 survives turning the plugin off and on - then tries fast typing again.

**0.6.6 to 0.6.8** (2026-10-14), after the user tested 2FA in depth and found it
working: turning 2FA off takes the password alone (0.6.6, server and plugin); every
button that waits greys out and spins (0.6.7); the open settings tab shows changes
from other devices - the account-wide settings and the account's 2FA and recovery
code - without a restart (0.6.8, server and plugin). The user installed 0.6.8 and
said it works as expected (2026-10-14).

**Milestone 0.7: the backup server** - designed with the user on 2026-10-15
(`docs/PHASE6.md`, the decisions at its top; the user shaped the architecture
themselves: a server of its own, set up from the plugin through a relay, restic
plus an optional trusted plaintext copy). Built on `feat/backup-api` in the steps
listed at the end of `docs/PHASE6.md`: 0.7.0 the sync server's backup keys and read
scope, 0.7.1 the run, 0.7.2 the relay and the session, 0.7.3 the plugin, 0.7.4 the
image, 0.7.5 "Connect again…" and a fix CI's first start of the image found. Every
version's details and checks: `docs/CHANGELOG.md`.

**After 0.7.5** (2026-10-16) the user asked how the trusted copy's guard decides, for
the settings in tabs, whether the schedule runs with every device offline (yes - the
backup server pulls on its own), pointed out that one code per backup server for
everyone is a weakness, and asked for rolling a vault back, with a backup of
everything first. Decided with the user and written down in `docs/PHASE6.md`, "After
the first build", in four steps on `feat/backup-rollback`. **Built:** 0.7.6
invitations and a pairing per vault; 0.7.7 the settings in tabs, destinations
editable, the guard over notes and files apart; 0.7.8 rolling the vault or a folder
back from the history, with fresh backups and a local copy first, undoable - and a
fix for two notes or files swapping names on another device (invariant 27); 0.7.9
rolling back further than the history reaches, from the backups on a backup server,
without anything to restore by hand.

**0.7.10 to 0.7.16** (2026-10-17/18) came from setting it up on the user's network:
"Use this server", the backup server's `status`/`check`, the data folders handed over
by the images. **0.7.17** (2026-10-18), after the first real test: one backup task per
vault - always a restic repository, the decrypted copy beside it on request -, the
paths picked by the backup server in three bind-mounted folders, one backup server per
vault (`docs/PHASE6.md`, "One backup task per vault"). The user set 0.7.17 up on the
Pi and backs up by hand (2026-10-19). **0.7.18** (2026-10-20): a time of day, waiting
while someone writes, rclone in the image, the password shown instead of copied
(`docs/PHASE6.md`, "When it backs up, rclone, the password"). With it the user
considers 0.7 nearly done.

**What the user does next:**

1. Install 0.7.18 on the devices; `docker compose pull && docker compose up -d` on
   the Pi. The sync server is unchanged since 0.7.15 apart from its version. The task
   from 0.7.17 carries on; its schedule ("every 24 hours") stays until changed to a
   time in the settings.
2. Check that a scheduled backup runs on its own - and that it waits while writing.
   Not tried yet: a cloud location (S3/B2, `rclone:`, `sftp:` with a mounted key),
   the RAM disk size.
3. Restore once with restic as `docs/BACKUP.md` shows, open the decrypted copy as a
   vault, and try a rollback on a test folder (*Roll this folder back…*, then
   *Undo…*).
What only a device shows: the settings section and both dialogs, the notice, the
WebSocket to `/relay` from Obsidian on desktop and on a phone, "Connect again…", the
settings tabs, the rollback dialog (the date and time field, the lists) and the
folder menu's "Roll this folder back…".

## Roadmap

Ordered by the user on 2026-10-14 (the table is in CLAUDE.md, Conventions).

- **0.7 - the backup server.** Built, 0.7.0 to 0.7.9; see "Next step". Left for
  later, noticed while building: a device's relay connection is not closed
  when the account's devices are signed out (it reaches only backup servers whose
  pairing it has); planning a rollback reads one log per note, since the server keeps
  no last-change time per room (`docs/PHASE6.md`, as built 0.7.8).
- **0.8 - sharing a folder, and the small fixes.** Sharing a whole folder,
  including what is added to it later (not designed yet). Besides, every fix that
  has to be in before 0.9:
  - Typing into an open note while sync itself restarts (signing out and in, the
    plugin reloaded) can lose the keystrokes of that moment (details under "Known
    issues").
  - Content uploaded but never named in the index (a crash between the two) is
    never cleaned up from the server.
  - Local copies of a purged note stay in IndexedDB on the devices that did not
    purge it.
  - To investigate: after a device turns 2FA on, its own socket took seconds to
    connect again in `test:account` (A4 still disconnected) - find out whether a
    device shows that too and why.
  - Whatever the open questions below turn up, and anything the user finds on the
    devices until then.
- **0.9 - hardening and a security audit.** Durable writes on the sync server,
  asked for by the user (2026-10-18): a frame is acknowledged once the operating
  system took it, not once it is on the disk - `fsync` the log before the ack (and
  the atomic writes before their rename), so a power cut on a Pi with an SD card no
  longer ends in devices being asked about notes the server lost; and a lock file, so
  the admin CLI - a second process - and the server never write `accounts.json` at
  once (one of two writes could be lost now). Frames signed per author, not only
  authenticated by the note's key (`docs/PHASE3.md`); every note live without all
  of them in memory - the device watches every note's room without loading it,
  the server announces new frames, and the note is loaded briefly, written and let
  go (direction in CLAUDE.md, "Not built yet"); a name and plugin id without
  "Obsidian" (the community directory refuses an id containing `obsidian`; the
  plugin folder, `data.json` and the `localStorage` keys move with the id, so it
  needs a migration); a review of the cryptography and the server's API, including
  the known limit that signing out does not replace the account secret
  (`docs/PHASE5.md`). What the community directory asks for besides (checked
  2026-10-14; submission through community.obsidian.md, reviewed automatically
  within minutes): a public repository (it is private, and new closed-source
  plugins are refused), a `LICENSE` (there is none), a release tagged `x.y.z`
  (CI makes one per tag), and the README saying that the plugin needs a server
  and an account. Whether to publish at all is the user's decision.
- **1.0.0** - all of the above done and verified on devices.
- **Later:** syncing plugins and their settings (moved back by the user; the
  direction is in CLAUDE.md); the operator's backup of the data directory,
  ciphertext only (moved out of 0.7 by the user on 2026-10-15).

## In flight / half-finished

Nothing. `feat/backup-rollback` (0.7.6 to 0.7.9) is merged into `main` and still exists.

## Decisions made (not visible in the code)

- Attachments: the decisions taken with the user are in `docs/PHASE4.md` (top and
  "As built" notes per step). Taken without asking and accepted since: shared files
  are copied into each account's own store (server space once per account); the
  base per shared file belongs to the vault, not the device; a note shared before
  0.5.4 shares no files until the owner turns it on; a linked note the person has
  already is skipped; links are followed only through notes that go along.
- Menus: our items stay in Obsidian's file menus (the only place on a phone, which
  has no status bar), grouped under a label with the plugin's name; the cloud opens
  the same menu on desktop. Submenus were not used: not public API.
- Recovery codes and 2FA: the decisions taken with the user are at the top of
  `docs/PHASE5.md`. Taken without asking: the code has 30 characters, not the 26
  the question named - four more carry a check that catches typos on the device; a
  removed account's sockets are closed as signed out too; the 2FA setup checks the
  password on the device first; the QR code comes from `qrcode-generator` 2.0.4.
  Not built: a "sign out all other devices" button of its own (offered in the
  questions, not chosen - the mechanism is there if it is wanted). 0.6.3: the user
  asked whether a recovery could keep 2FA without a security tradeoff; built as a
  question in the recovery. Keeping needs a current code from the app (no plain
  "keep" switch), so nobody keeps a factor they no longer have. Closing the
  question cancels the recovery.
- The log (0.6.4, asked for by the user): a note or file kept in two versions is
  logged as an error, as the user asked, although nothing failed - it is what
  someone has to look at. Taken without asking: "Copy log" gathers errors and
  warnings ahead of the log, presence and carets are logged only when they change
  (the renewal every 15 s and every caret move buried the frames), and "Detailed
  logging" moved to a row of its own.
- 0.6.6 to 0.6.8, asked for by the user: 2FA off with the password alone (no security
  given up - device and password make a recovery code anyway); spinners on buttons;
  live settings. Taken without asking: the settings tab is not rebuilt while a field
  in it has the focus (it waits for the blur), the account is asked again on every
  reconnect and when the tab opens, and the server's notice is a new kind
  (`account-changed`) that older plugins ignore. Toggles have no spinner (they take
  effect at once, except "Sync this vault").
- Wishes not designed yet: sharing a whole folder (0.8); plugin and settings sync
  (after 1.0.0, snapshots from a chosen device, never through the CRDT - reasons in
  CLAUDE.md).
- The roadmap order (2026-10-14) and the rule of a branch per milestone, merged when
  done, are the user's.

## Open questions for the user

0. **The conflict markers of 2026-10-13 - answered by 0.6.5.** The device that
   typed received the conflict as frames #248 and #249 at 20:03:22.66 from another
   client. Neither log file shows a merge, and the note had `3 present` while the
   user had two devices online (the account it is shared with had its vault
   closed). Of the two others, one renewed its presence in all three shared notes
   at the same moment and never had a caret - the copy of 0.6.3 on the other
   computer that outlived its unload at 19:59:59; the other matches that computer's
   live copy, loaded at 20:00:16, with the note open. Not confirmed on the device:
   if Obsidian on that computer was not restarted since, its developer console
   would show the copy's `merge (...)` lines - offered to the user as a check.
1. **"Compare versions" on a note (2026-10-12).** The user asked whether an editor
   is not bound locally, so offline edits merge cleanly. Answer: yes - typing in a
   bound editor, offline too, goes into the CRDT and merges without a review. A
   review comes only from a note changing as a file outside a bound editor (another
   plugin or program, typing before the binding settled, a device without a base)
   with both sides changing the same lines (`conflict`) or no base (`no-base`); it
   appears only on the device that merged (`sync/Reviews.ts` is device-local). The
   log the user pasted (one device, 2026-10-10 23:02 to 10-12 09:06) has no
   `merge (...)` or `two versions kept` line. Asked: on which device it appeared and
   the date the dialog names; then that device's log of that day.
2. **The user's server dropped out on 2026-10-12.** Their device lost
   `ws://localhost:1234` at 08:54:07Z, 3 s after a scratch server was started on
   1235 (08:54:04.716Z), and was still retrying at 09:06. No mechanism found: the
   scratch server listened only on 1235 with its own data directory, no test used
   1234, the user's `start:server` runs `tsx src/index.ts` without watch, and
   nothing then changed server or shared sources (only `package.json` versions).
   Asked the user what their server's console showed. If it recurs when a scratch
   server starts, find out why before running the end-to-end tests again.

To check on a device: 0.5.7's menu section, the cloud on a canvas and its menu, the
lock for a read-only note (status bar and note header, also on a phone); Obsidian
resolving `[[Ideas/Roadmap]]` to `Shared/Ideas/Roadmap.md` and `![[x.png]]` to
`Shared/Attachments/x.png`, and which file wins when two share a name.

## Known issues / debt

- **On a device only** (untestable headless): menus, modals, the settings tab, the
  status bar marks, the header lock, `requestUrl` with binary bodies on mobile,
  binary file events, `file-open` fetching, memory with large files on a phone.
- Content uploaded but never named in the index (a crash between the two) is never
  cleaned up from the server (0.8).
- Notes beyond `maxLoadedDocuments` (500) stop receiving live updates until opened
  or the next start, when every note is loaded once (0.9). Raising the setting
  above the number of notes is the workaround; measured with Yjs alone, a loaded
  note of 3000 characters takes about 6 KB seeded and 32 KB typed key by key with
  revisions, plus an IndexedDB database and a subscription each.
- Signing out takes the server from a device, not the keys it unwrapped: the account
  secret is never replaced (`docs/PHASE5.md`, "Known limit"; the audit in 0.9).
- Frames authenticated by the note's key, not signed per author (0.9,
  `docs/PHASE3.md`).
- Local copies of a purged note stay in IndexedDB on the devices that did not
  purge it (0.8).
- Typing into an open note while sync itself restarts (signing out and in, the
  plugin reloaded) can still lose the keystrokes of that moment (0.8): the new store
  settles the note by writing its file, and Obsidian reloads the editor. 0.6.4 keeps
  the file Obsidian's only while the same store binds the editor again
  (`EditorSync.rebinding`); a new store has to settle against the server first.
- The plugin id contains "obsidian", which the community directory refuses (0.9).
- `test:recovery`'s check "carries on in the same note, and what it wrote while away
  reaches P1" failed once on 2026-10-16 and passed in the next two runs. Its log showed
  "Shared/Shared.md: deleted on another device, moved to the trash here" on the device
  coming back just before. If it fails again, find out whether that move to the trash
  is a race in the fork on return (0.8).
- The Docker image is private, like the repository: pulling it needs `docker login
  ghcr.io` with a token that may read packages. Both images run on the user's hosts
  (2026-10-18); a backup into a repository of the backup server was seen working,
  0.7.17's layout not yet.

## Verification state

restic on the development machine: `%USERPROFILE%\tools\restic\restic_0.19.1_windows_amd64.exe`
(the official release, checksum checked, put there with the user's consent on
2026-10-15; nothing on the PATH). `test:backup` needs
`OBSIDIAN_CONNECT_RESTIC="$HOME/tools/restic/restic_0.19.1_windows_amd64.exe"`.
It takes about three minutes here.

At 0.7.18, run 2026-10-20 on `feat/backup-schedule` before its commit: `typecheck`
and `build` pass; `test:merge` 164, `test:load` 14, `test:rooms` 284, `test:sync` 26,
`test:recovery` 64, `test:account` 50, `test:rollback` 52, `test:backup` 187, and
against a scratch server on 1235 `test:socket` 19 and `test:vault` 230 - all pass.
rclone in the image and its wrapper run only in CI.

At 0.7.17, run 2026-10-18 on `feat/backup-task` before its commit: `typecheck` and
`build` pass; `test:merge` 164, `test:load` 14, `test:rooms` 284, `test:sync` 26,
`test:recovery`, `test:account`, `test:rollback`, `test:backup` 168, and against a
scratch server on 1235 `test:socket` 19 and `test:vault` 230 - all pass. The new
compose layout and the folders' handover run only in the image (CI).

At 0.7.16, run 2026-10-18 before its commit (straight to `main`): `typecheck` and
`build` pass; `test:merge`, `test:load`, `test:rooms` and `test:backup` 154 pass.

At 0.7.15, run 2026-10-18 before its commit (straight to `main`): `typecheck` and
`build` pass; `test:merge`, `test:load`, `test:rooms` and `test:backup` 153 pass;
`docker/entrypoint.sh` passes `sh -n`. The entrypoint itself runs only in the images,
so only CI's smoke tests show it working (no Docker on the development machine).

At 0.7.14, run 2026-10-18 before its commit (straight to `main`): `typecheck` and
`build` pass; `test:merge`, `test:load`, `test:rooms` pass; the server's entry stopped
with the folder message on an unwritable data folder and, on a scratch server on 1235,
started normally (`test:socket` 19).

At 0.7.13, run 2026-10-18 before its commit (straight to `main`): `typecheck` and
`build` pass; `test:merge`, `test:load`, `test:rooms` and `test:backup` 153 - all pass.

At 0.7.12, run 2026-10-18 before its commit (straight to `main`): `typecheck` and
`build` pass; `test:merge`, `test:load`, `test:rooms` and `test:backup` 150 - all pass.

At 0.7.11, run 2026-10-17 before its commit (straight to `main`): `typecheck` and
`build` pass; `test:merge` 164, `test:load` 14, `test:rooms` 284, `test:backup` 149 -
all pass. Two earlier `test:backup` runs died at the start, before anything 0.7.11
touches - restic in Go's runtime, then Node "out of memory" - with 1.6 GB of 15.6 GB
free on the development machine (other programs); the third, unchanged, passed. If it
recurs, look at free memory before the code.

At 0.7.10, run 2026-10-17 before its commit (straight to `main`, a small fix):
`typecheck` and `build` pass; `test:merge` 164, `test:load` 14, `test:sync` 26,
`test:account` 50, `test:recovery` 64, `test:rollback` 52 - all pass; against a
scratch server on 1235, `test:socket` 19 passes. Only the sign-in path changed;
`test:rooms`, `test:backup` and `test:vault` are untouched by it and ran green at 0.7.9.

At 0.7.9, run 2026-10-17 before its commit: `typecheck` and `build` pass; `test:merge`
164, `test:load` 14, `test:rooms` 284, `test:sync` 26, `test:recovery` 56,
`test:account` 50, `test:rollback` 52, `test:backup` 144 - all pass; against a scratch
server on 1235, `test:socket` 19 and `test:vault` 230 pass. CI on the branch failed
once in `test:backup` - a race in `disconnect` the development machine never lost
(`docs/CHANGELOG.md`, 0.7.9) -, fixed in `5f6e46a`, then green. The merge into `main`
(`2219f5e`, 2026-10-17): CI green - the tests, the `docker` job (server image) and
`docker-backup`, which published both images; the `latest-build` pre-release holds
0.7.9. Not on a device.

At 0.7.8, run 2026-10-17 before its commit: `typecheck` and `build` pass; `test:merge`
164, `test:load` 14, `test:rooms` 284, `test:sync` 26, `test:recovery` 56,
`test:account` 50, `test:rollback` 52 (new), `test:backup` 126 - all pass; against a
scratch server on 1235, `test:socket` 19 and `test:vault` 230 pass. CI on the branch
was green for 0.7.7. Not merged, not on a device.

At 0.7.7, run 2026-10-17 before its commit: `typecheck` and `build` pass; `test:merge`
164, `test:load` 14, `test:rooms` 284, `test:sync` 26, `test:recovery` 56,
`test:account` 50, `test:backup` 125 - all pass; against a scratch server on 1235,
`test:socket` 19 and `test:vault` 230 pass. CI on the branch was green for 0.7.6,
`docker-backup` with the invitation smoke test included. Not merged, not on a device.

At 0.7.6, run 2026-10-17 before its commit: `typecheck` and `build` pass; `test:merge`
164, `test:load` 14, `test:rooms` 284, `test:sync` 26, `test:recovery` 56,
`test:account` 50, `test:backup` 103 - all pass; against a scratch server on 1235,
`test:socket` 19 and `test:vault` 230 pass (the user's server on 1234 was not
touched). Not merged, not on a device.

At 0.7.4 and 0.7.5, 2026-10-16: `typecheck`, `build`, `test:merge` 163, `test:load`
14, `test:rooms` 278, `test:backup` 91 pass (0.7.5 changes only the backup server's
timer and the plugin's settings over 0.7.3, whose full run is below). CI on the
branch: 0.7.4's tests green, its new `docker-backup` job built the image and found
it ending a second after starting (fixed in 0.7.5); 0.7.5 green. The merge into `main`
(`6c3de93`, 2026-10-16): CI green - the tests, the `docker` job (server image), and
`docker-backup`, which published `ghcr.io/johnnyjack123/obsidian-connect-backup`
(`latest`, `sha-6c3de93`) for the first time; the `latest-build` pre-release holds
0.7.5. `feat/backup-api` is merged and still exists.

At 0.7.3, run 2026-10-16 before its commit: `typecheck` and `build` pass; `test:merge`
163, `test:load` 14, `test:rooms` 278, `test:sync` 26, `test:account` 50, `test:backup`
91 - all pass; `test:recovery` 56 passed twice in a row after one run in which "carries
on in the same note, and what it wrote while away reaches P1" failed (P2 had the right
text; the condition was not met within its 15 s). That path - a shared note whose
owner's account was removed, and a device coming back - is untouched by 0.7; noted
under "Known issues" to watch. Against a scratch server on 1235, `test:socket` 19 and
`test:vault` 230 pass (the user's server on 1234 was not running, before or after).
Not merged, not on a device.

At 0.7.2, run 2026-10-16 before its commit: `typecheck` and `build` pass; `test:merge`
163, `test:load` 14, `test:rooms` 278, `test:sync` 26, `test:recovery` 56,
`test:account` 50, `test:backup` 76 - all pass; against a scratch server on 1235,
`test:socket` 19 and `test:vault` 230 pass (the user's server on 1234 was not running,
before or after). Not merged, not on a device.

At 0.7.1, run 2026-10-15 before its commit: `typecheck` and `build` pass; `test:merge`
150, `test:load` 14, `test:rooms` 268, `test:sync` 26, `test:recovery` 56,
`test:account` 50, `test:backup` 55 - all pass; against a scratch server on 1235,
`test:socket` 19 and `test:vault` 230 pass (the user's server on 1234 was not running,
before or after). Not merged, not on a device.

At 0.7.0, run 2026-10-15 before its commit: `typecheck` and `build` pass; `test:merge`,
`test:load`, `test:rooms` (268), `test:sync`, `test:recovery`, `test:account` pass;
against a scratch server on 1235, `test:socket` and `test:vault` (230) pass (the
user's server on 1234 was not running, before or after). 0.7.0 is not merged and has
not been on a device.

At 0.6.8, run 2026-10-14 before its commit: `typecheck` and `build` pass;
`test:merge` 150, `test:load` 14, `test:rooms` 236, `test:sync` 26, `test:recovery`
56, `test:account` 50 - all pass. Against a scratch server on 1235: `test:socket`
19, `test:vault` 230 - all pass (the user's server on 1234 was not running, before
or after). CI green up to 0.6.8. Bug-back checks per version: `docs/CHANGELOG.md`.
The merge into `main` (`b870381`, 2026-10-14): CI green, its `docker` job built
the image, started it (health check, `invite` through the CLI) and published
`ghcr.io/johnnyjack123/obsidian-connect-server:latest` and `:sha-b870381`; the
`latest-build` pre-release holds 0.6.8.
Seen on a device by the user: 0.6.2 (recovery and 2FA), 2FA in depth on 0.6.5
(2026-10-14), 0.6.8 - 2FA off with the password, spinners, live settings - "works as
expected" (2026-10-14). Not reported on a device: 0.6.3's question in the recovery,
0.6.4 and 0.6.5 with fast typing.

How to run the end-to-end suites without touching the user's server: CLAUDE.md,
Gotchas ("Never test on port 1234"). `test:socket` and `test:vault` default to
1234 when no URL is given - always pass `ws://localhost:1235`.

---

## Log

### 2026-10-20
- 0.7.17 runs on the Pi; backups by hand work. The user asked for rclone, for
  whether the copyable password is a risk (it is end-to-end encrypted in the
  settings; only the clipboard keeps it beyond that - now shown instead), whether a
  backup while someone writes is a problem (no: the log is read, not files being
  written), and whether the guard holds for runs started by hand (yes, for every run,
  and only for the copy). Asked for a time of day and for waiting while someone
  writes. Built as 0.7.18 on `feat/backup-schedule`.

### 2026-10-18
- The 403 was the network, not the backup server: the container resolved the name
  through Docker's DNS to the public address; with `dns:` it reached the Pi itself,
  where the DNAT to the HP applies only on `eth0`, not on Docker's bridges; with
  `extra_hosts` straight to the HP the HP's answers were dropped by the user's
  `PI5-FWD` rule (`-i eth1 -s 10.0.0.0/24 -j DROP`, in `DOCKER-USER`). An
  `ESTABLISHED,RELATED` accept before it and the Pi's subnet address in the proxy's
  access list fixed it - no image changed, as the user asked.
- First real test: the backup server connected; the user set up a decrypted copy on
  its own and found no repository - not what was meant. Decided together: always a
  restic repository, *trusted* adds the copy; paths picked by the backup server in
  three bind-mounted folders; one task per vault; one backup server per vault; no
  carrying over of 0.7.16's settings (`docs/PHASE6.md`, "One backup task per vault").
  Built as 0.7.17 on `feat/backup-task`.

### 2026-10-17
- 0.7.6: invitations and a pairing per vault, as decided the day before.
- 0.7.7: the settings in tabs, destinations editable, the guard over notes and files;
  a backup started right after a change of retention no longer goes by the old one.
- 0.7.8: rolling back from the history; two notes or files swapping names now swap on
  every device.
- 0.7.9: rolling back from restic where the history does not reach; the backup
  server's session messages go out in order.
- The user deployed the server on a Pi, set it up anew and was stuck signed out with
  the old server's id pinned; 0.7.10 offers "Use this server" in that state.
- The user decided against binding invitations to an account id (little gain), kept
  the compose files with bind mounts, and hit "the backup server is not connected"
  connecting the backup container on the Pi. 0.7.11 makes the backup server say
  whether it reaches the sync server and why not (`status`, `invite` waiting for it).
  Its `status` showed the cause (2026-10-18): `wss://` to the sync server's own port,
  which has no TLS - told to use `ws://192.168.168.67:1234`. 0.7.12 names that cause
  itself, and gives the backup server `./backup-data` as its folder, as the user asked.
  With `ws://` it still failed with 1006: the container does not reach the host's LAN
  address (most likely a firewall between Docker's networks and the host). Advised:
  `network_mode: host` and `ws://127.0.0.1:1234`, or the sync server's container name
  on a shared network; 0.7.13 adds `check` and keeps the explanation in `status`.
- The user then moved to the layout of later - the sync server on its own host
  behind a reverse proxy with TLS - and hit `EACCES` on `/data/server.json`: the
  bind-mounted `data` folder was root's. 0.7.14 checks that at start. The user also
  asked whether files instead of a database can lose data under concurrent requests;
  answered (writes per file are serialized and atomic; open: appends are not fsync'd
  before the ack, and the admin CLI writes `accounts.json` from a second process) -
  the user put both into 0.9's hardening (Roadmap). And asked for the folder to be
  taken over without a `chown` by hand: 0.7.15.
- The new sync server works for devices over `wss://` through the proxy; the backup
  server with the same address got HTTP 403 on `/health` - something in front of the
  sync server refusing it (the user's network: Pi with Pi-hole, iptables forwarding
  443 to the server in a subnet). Asked for `check`'s DNS line, `wget -S` and the
  proxy's log; 0.7.16 shows the resolved address and who answered. Waiting.

### 2026-10-16
- After 0.7.5 the user asked for invitations instead of one code, the settings in
  tabs, a guard over notes and files, and rolling back; decided together
  (`docs/PHASE6.md`, "After the first build"), started on `feat/backup-rollback`.
- Milestone 0.7 built: 0.7.2 the relay and the session, 0.7.3 the plugin's settings,
  0.7.4 the image, 0.7.5 "Connect again…" and the fix for a backup server that ended
  while the sync server did not answer (found by CI's first start of the image).

### 2026-10-15
- Milestone 0.7 designed with the user. First proposed: an encrypted form for the
  operator and a command-line client decrypting on the backup machine. The user
  chose instead a backup server of its own, set up from the plugin through a relay
  on the sync server, decrypting in memory into restic, with an optional trusted
  plaintext copy; notes as a folder, attachments as a stream. Written down as
  `docs/PHASE6.md`; the user agreed to it.

### 2026-10-14
- The user tested 2FA in depth and found it working. Asked for, and built: 2FA off
  with the password alone (0.6.6), spinners on every button that waits (0.6.7),
  settings and account state shown live on every device (0.6.8).
- The user confirmed 0.6.8, reordered the roadmap (0.7 backup API, 0.8 sharing a
  folder and the small fixes, 0.9 hardening and a security audit, plugin sync
  after 1.0.0), asked for a branch per milestone, merged when done, and had
  `feat/accounts` merged into `main`.

### 2026-10-13
- The user asked whether closing the recovery's 2FA question spends the code: no,
  the code is spent only by `/auth/recover/commit`, which closing never sends.
- 0.6.4: the user saw nested conflict markers after typing fast with a second device
  online. Reproduced (an editor binding again while someone types elsewhere), fixed
  (invariant 25), together with keystrokes lost during the typing device's own
  rebind; the log restructured as asked.
- 0.6.5: the user said nothing happened on the other device and no third one was
  online. The third client was a copy of the plugin that outlived its unload there
  (invariant 26); that was the cause. Fixed and checked in `test:load`.

### 2026-10-12
- Milestone 0.6 designed with the user (`docs/PHASE5.md`). 0.6.0: a password change
  signs out every other device on the server (session generation, `4401`). 0.6.1:
  the recovery code. 0.6.2: two-factor sign-in (TOTP) - milestone 0.6 built. 0.6.3,
  after the user tried 0.6.2: a recovery keeps 2FA with a code from the app.
- 0.5.7: the plugin's menu section, the cloud for files and as a menu, the shared /
  read-only mark and header lock, "Version history" for files.
- Docs brought up to date for a handoff: `docs/CHANGELOG.md` (new, the full version
  history), README (attachments, shared files, linked notes, menus), CLAUDE.md
  (doc index), PLAN.md (marked historical).

### 2026-10-11
- 0.5.4 to 0.5.6: shared notes carry their files; the compaction misread as a
  restored server fixed; linked notes; "Share again".

### 2026-10-10
- 0.5.0 to 0.5.3: attachments between own devices, hardened for canvases; the trash
  and earlier versions of files. Attachments designed with the user (`PHASE4.md`).

Older: `docs/CHANGELOG.md`.
