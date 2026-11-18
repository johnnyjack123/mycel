# Progress

_Last updated: 2026-11-18 · **The repository is to go public (the user's decision: the private one's Actions minutes are used up, and CI has not run since `2522f02`, 0.9.20). Its history was rewritten for that with `git filter-repo` (the user agreed, 2026-11-18): every commit's address is the GitHub noreply one, the host names, subnets, a local path and a first name in the docs are placeholders, and commit hashes quoted in the docs were mapped to the new ones; the old history is in a bundle beside the project folder (`mycel-history-before-rewrite-2026-11-18.bundle`). Still to do before it goes public: delete the old Actions runs and the old `latest-build` release - both name old commits, which GitHub keeps reachable by their hash. 0.9.23 (the user's design of 2026-11-18): "Compare versions" puts a note together as git's merge tools do - this device's version, the result, the other version, each differing passage brought into the middle one at a time, both in the order taken, or written by hand. 0.9.22 (the user's wishes of 2026-11-17): the joining window says before the choice what merging does - how much needs nothing, which notes become the longer version, which keep text of both, which files are kept twice -, every merged note is marked in the file explorer until "Compare versions" and *Done*. 0.9.21 fixes the Time Machine's *Abort* hanging for good - greyed out, the vault locked everywhere - while the moment on screen was still being read from the server (found by the user). 0.9.20 fixes the copy before connecting, which the gate refused on every device (also the copy before a rollback and the Time Machine's keeping aside; the tests now run with the real plugin folder behind the gate), and says on the wizard's first page that only notes merge. 0.9.19 (the user's design of 2026-11-13): a device meeting a vault on the server for the first time compares before it touches anything and asks - merge both, take the server's version, or not now -, after a copy of the whole vault (invariant 34, `test:join`); for the user to try on devices while starting afresh. Before that: 0.9 built, the audit done: 0.9.0 seals keys only to pinned keys, 0.9.1 makes the server's writes durable, 0.9.2 keeps every note live, 0.9.3 signs the keys sealed to members, 0.9.4 signs every frame, 0.9.5 removes everything kept for data from before, 0.9.6 replaces every key on request, 0.9.7 renames the project to Mycel, 0.9.8 is the security audit (`docs/AUDIT.md`: 23 findings fixed, each kept as an attack in `npm run test:security`), 0.9.9 closes its residual risks (R1 to R9) and adds a setup wizard, 0.9.10 fixes three of the races seen only in CI (two remain, below), 0.9.11 resolves links in shared notes by who typed them (signed claims; P11 and S11 fixed), and fixes a change lost before it was sent and a share taken in before its sharer's contact record (both found that day, by the benchmark and in CI), 0.9.12 fixes a shared folder's move taken for every note moving out (CI), 0.9.13 keeps every backup after a suspicious run until confirmed, 0.9.14 makes typing offline as quick as online, 0.9.15 a start open only what changed, 0.9.16 has the tests run the plugin's own wiring (`SyncSession`), 0.9.17 makes one rule of three pairs of copies and fixes the stale-lock race and the backup's settings copy, 0.9.18 moves the server's vault lock out of `rooms.ts`. The list the user agreed on 2026-11-10 is done; open are the benchmark's remaining findings (Known issues) and the device run before 1.0.0. The user updates server, backup server and every device together (friend codes from before 0.9.8 no longer redeem), sets `MYCEL_TRUST_PROXY`, starts afresh once (below, "Starting afresh"); publishing comes last.**_

## Where we are

Monorepo (`npm` workspaces): `packages/shared`, `packages/server`, `packages/plugin`,
`packages/backup`. **Read `CLAUDE.md` first** - 30 invariants, each from a real bug or a risk the user named,
the architecture, the roadmap to 1.0.0 and the conventions (a branch per milestone,
push after every commit, a version for every change the user installs). Designs:
`docs/PHASE2.md` (keys, sharing), `docs/PHASE3.md` (accounts without names, contacts,
forks, trash, surviving the server), `docs/PHASE4.md` (attachments), `docs/PHASE5.md`
(recovery codes, 2FA), `docs/PHASE6.md` (the backup server, with every decision of
0.7.6 to 0.7.19 and what was taken without asking); running them: `docs/SERVER.md`,
`docs/BACKUP.md`; every version and how its fixes were verified: `docs/CHANGELOG.md`.

What works, confirmed by the user: account, sign-in, 2FA and recovery code; note
sync, sharing and live editing; attachments with conflict copies; trash and version
history; linked notes (0.6.8, 2026-10-14). The backup server (0.7.19, 2026-10-21):
connecting with an invitation, a task with the repository on the backup server and
the decrypted copy, backups by hand and on schedule, the day buttons and the time, and
the guard holding the copy with its window ("das hat super geklappt"). Not tried on a
device yet: a cloud repository (S3/B2, `rclone:`, `sftp:` with a mounted key), the RAM
disk's size with a large vault, restoring with restic by hand, a rollback on a test
folder, opening the decrypted copy as a vault.

**The user's setup** (matters when something fails between the hosts):
- Sync server: Docker on a machine in a subnet of its own, behind Nginx Proxy
  Manager with TLS (`wss://sync.example.org` - the user's host name, not
  renamed with the project). Its access list
  admits the home network and the Pi's subnet address. Needs 0.7.18 or newer - the
  relay's ping, without which NPM closed the backup server's connection every minute.
- Backup server: Docker on a Raspberry Pi 5 that routes the subnet (iptables script
  with `PI5-FWD` in `DOCKER-USER`, DNAT of 443 on `eth0` only) and runs Pi-hole.
  Its compose file pins the sync server's name with `extra_hosts` to the sync server's address;
  the user added an `ESTABLISHED,RELATED` accept for answers from the subnet.
- The plugin is installed by copying `main.js`, `manifest.json`, `styles.css`.
- `packages/server/data` and port 1234 on the development machine are the user's
  old local server: never touch either (CLAUDE.md, Gotchas).

## Next step

**Milestone 0.9: hardening** (`docs/PHASE8.md`; the user's answers of 2026-11-03 are in its
"Decided" section). The user left S1, S2, D1, L1 and the order to the recommendations, asked
for no backward compatibility ("noch läuft das nicht in Production"), gave the audit (A) to a
separate agent with fresh context, chose AGPL-3.0 and wants the rename (N) only after hearing
an opinion on their two names, *Seemless* and *Mycel* (given: Mycel). Publishing (P) last.

1. **0.9.0** - S finding 1: keys sealed only to pinned keys (`feat/seal-pinned-only`),
   `LICENSE.md`. Merged, CI green, both images published.
2. **0.9.1** - D: durable writes on the sync server, the vault lock over a restart (D1)
   (`feat/durable-writes`). Not measured on the Pi yet: how long a push takes with a sync
   per frame on its SD card. Its first CI run failed (`test:backup`, CHANGELOG); fixed on
   `main` (`9781071`), CI green, both images published.
3. **0.9.2** - L: every note live (`watch`), the eviction fixes (`feat/live-notes`). Merged,
   CI green, both images published.
4. **0.9.3** - S-a: signing keys, attestations between contacts, signed sealed keys, the
   one-time resealing (`feat/signatures`). Merged, CI green, both images published.
5. **0.9.4** - S-b: signed frames, writers' certificates (`feat/signed-frames`). Merged, CI
   green, both images published.
6. **0.9.5** - a clean slate: everything kept for data from before removed, contacts pin both
   keys with the friend code, every change of role a new epoch (`feat/clean-slate`). Merged,
   CI green, both images published.
7. **0.9.6** - S2, *Replace all keys*, as the user decided on 2026-11-05 (`docs/PHASE8.md`, S2a
   to S2c): a new identity (contacts confirm again with a new friend code), every room written
   anew, every file uploaded anew, the backup server invited again (`feat/replace-keys`).
   Merged, CI green.
8. **0.9.7** - N: the rename to *Mycel*, everywhere, the internal names included (the user,
   2026-11-05; `feat/mycel`).
9. **0.9.8** - A: the security audit, done in a chat of its own on 2026-11-07 (`docs/AUDIT.md`,
   `fix/security-audit`). Server: a crash from anyone through one WebSocket message, the
   built-in token secret, the sign-in throttle behind a proxy (`MYCEL_TRUST_PROXY`), bodies read
   before tokens, unbounded contact messages, titles, keys, attachments and frames, foreign vault
   ids. Plugin: paths from a shared folder's document written anywhere (the gate, `guard.ts`,
   invariant 31), a folder taking over and deleting another note, files pulled out through
   links, friend codes not binding the account, keys sealed to or taken from whoever the
   server named (invariant 32), a caret's colour as CSS. Backup server: a task's environment
   and `-` locations running code. To try on devices: sharing a note with its files (the
   pictures go along from the device that shares; on another device of the owner a notice asks),
   a link someone else types into a shared note to a file of yours (the notice, *Share …*), a
   friend code between two 0.9.8 devices, the server behind NPM with `MYCEL_TRUST_PROXY`.
10. **0.9.9** - the audit's residual risks closed, as the user asked on 2026-11-07 (R1 to R9 in
    `docs/AUDIT.md`, `fix/audit-residuals`): epochs only forward (invariant 33), the quota over
    rooms, the token as a WebSocket subprotocol, signed presence and titles, the backup server
    checking signatures and staying out of its own network, a writer's clock, signed contact
    removals; and the setup wizard (`feat/setup-wizard`, built by a separate agent). To try on
    devices: the wizard on a fresh install (desktop and phone), carets between two people who
    are contacts (the name shown is the one you gave them), the sync through NPM with the token
    in the header (NPM passes `Sec-WebSocket-Protocol` on), a backup server paired before 0.9.9
    getting the signing key (its log: "its frames are checked against their signatures").
11. Then the user starts once afresh (below); P last.
12. **Wanted, to be built only once the user says so** (2026-11-13): the other direction of
    0.9.19's joining choice - *overwrite the server with this vault*, for when something went
    wrong: what differs takes this vault's version, what only the server has is deleted there
    (restorable from the trash and the history), the other devices following. Not started.

**Starting afresh** (nothing written before 0.9.5 is read, and nothing named before 0.9.7 is
found):
- Sync server: the image is `ghcr.io/johnnyjack123/mycel-server` now; a new, empty data folder;
  the `.env` with every variable renamed (`OBSIDIAN_CONNECT_JWT_SECRET` → `MYCEL_JWT_SECRET`,
  and so on - `docs/server.env` lists them); the CLI is `mycel` (`docker exec <container> mycel
  invite`). The proxy's host name can stay as it is.
- Backup server: the image is `mycel-backup`, its variables `MYCEL_*` (`docs/backup.env`), its
  data folder emptied; it is invited again from a device.
- Every device: the old plugin folder `.obsidian/plugins/obsidian-connect/` deleted (it holds
  the old token and keys), the new one `.obsidian/plugins/mycel/` installed; the vault's
  `localStorage` and IndexedDB entries of the old plugin are not read any more (they are named
  `obsidian-connect…`) and can be cleared with the browser tools or left. New accounts are
  registered, contacts made anew with friend codes, notes and folders shared anew.
- The repository on GitHub keeps its name until the user renames it (GitHub forwards the old
  address); the images are published under the new names from the next push to `main` on.
- Since 0.9.19 every device asks before its first sync (invariant 34). The user wants to see
  whether it tells the cases apart on real vaults: the first device (*Upload*), an empty vault
  (*Download*), a copy of the same state (*Connect*), an older copy (*Take the server's version*),
  another vault. The old backup server's data folder is best kept aside rather than emptied: its
  `decrypted/` holds the vault as plain files.

Worth watching on devices: the joining window (comparing with progress, the table and lists,
the copy's folder in `.obsidian/plugins/mycel/backups/`, *Not now* and the status bar bringing
it back, after the setup guide closes); a share right after making a contact; a writer made a reader and
back (each moves the note to a new epoch); *Replace all keys* on a test account (its notice
while the vault is written anew, a contact's notice, the new friend code, the backup server
invited again); the log for "not signed by someone who may write here".

**Milestone 0.8: sharing a folder, and the small fixes** (`docs/PHASE7.md`, signed off
2026-10-22; the decisions E0 to E8, the order of work at its end).

0.8.0 is built: the folder room and its keys, access through the folder, the folder
API (server); the plugin's keys with folder ties, the folder document and its mirror,
moving in and out, deleting for everyone, revoking, leaving, ending; the dialogs, the
move-in window, the delete notice with undo, the explorer mark, the trash; the backup
server reading folder notes. What is next:

1. 0.8.0 is merged (`22746b7`) and CI on `main` is green, both images published.
2. 0.8.1 is merged (`322a919`): files inside the folder (the folder document's `files`
   map, `folderBases`, `share/FolderFiles.ts`), files and notes outside it from the
   share dialog; three races of 0.8.0 fixed on the way (CHANGELOG).
3. The backup server's tests for folders over time: merged (`test:backup` 227, 13
   new), no code needed, so no version of their own.
4. The small fixes (PHASE7, "The small fixes"), one at a time, each with its test:
   1 (keystrokes lost when sync restarts) is 0.8.2, 2 (content never named) 0.8.3,
   3 (local copies of purged notes) 0.8.4, 4 (slow reconnect after 2FA, confirmed:
   a second) 0.8.5, 5 (relay sessions on sign-out) 0.8.6, the known race in the fork
   on return 0.8.7, 6 (the rollback's last-change listing) 0.8.8. With that, 0.8 is
   built.
5. The user said on 2026-10-23 they cannot test right now and will test everything at
   once; the list went to them with 0.8.8 - **server first** (protocol 5, the new
   routes), then every device. To try: sharing a folder with a second account, a note
   and a picture added on each side, a rename and a delete inside (the notice, *Undo*),
   moving a note and a file in (the window) and out, a picture changed on both sides
   (two files), a file outside embedded by a folder note (`Shared/Attachments`), the
   explorer mark on desktop and phone, revoking; typing into an open note while signing
   out and in again (0.8.2); turning 2FA on or changing the password - this device is
   back at once (0.8.5); a rollback's plan on a large vault (0.8.8). Their findings come
   first, then 0.9's design document.
6. The user tested on 2026-10-24/25 (sharing a folder works, the explorer mark works,
   files come along). Fixed in 0.8.9: flickering carets, the move-in window's delay and
   text, the false "server has other data" after sharing again, the owner not told
   when someone leaves, files arriving late, the participant's empty rollback, a grey
   mark. The user's answers on 2026-10-25 (cursors work with 0.8.9):
   - **A:** linked notes on moving in are shared once with the folder's people, not
     moved in (as recommended, E8) - built in 0.8.10, with the share's end announced
     once (it came twice on the revoked person's device).
   - **B:** the "Time Machine" (a slider over every state, a live preview, *Apply*) for
     the vault, a folder and a note: the idea as proposed - a view of its own, never the
     real files, the note's preview read-only, *Apply* the rollback or restore with its
     backups - and **before 0.9**, which stays hardening only. Its design document comes
     first, written with the user: `docs/TIMEMACHINE.md`.
7. The user decided T2 to T8 on 2026-10-27 (`docs/TIMEMACHINE.md`, "Decided"): five
   minutes, the server route, *Restore just this note*, backups as ticks behind a switch,
   the old windows replaced at once. Built as 0.8.11 in one go (the user tests it as a
   whole). To try, **sync server and backup server first** (`/times`, `backupTimes`),
   then every device: the Time Machine of a note (slide, *Text*, *Changes against now*,
   *Restore this version*), of a folder and of the vault (the tree, *Only what differs*,
   a picture as it was, *Restore just this note*, *Apply…* with its list and backups,
   *Undo…*), *Backups too*, a shared folder of someone else (looked at, not applied),
   the view on the phone, and the tab staying open over a restart of Obsidian.
8. The user tested 0.8.11 on 2026-10-29: it works, a folder and the vault rolled back
   fine. Fixed in 0.8.12: *now* kept showing the text a restore had replaced (read from
   the file, which follows the document a moment later); the newest tick always equalled
   *now*; a note restored to what it said at a tick was marked *changed since*; the
   button moved from *All devices* to *Backups*. Asked for besides, and proposed for the
   user to decide (`docs/TIMEMACHINE.md`, "The second round", U1 to U5): an upright
   timeline at the right edge with bars that grow towards the pointer as in macOS; a
   note's past in its own tab, read-only, over its editor; a folder's or the vault's
   past written into the explorer while sync pauses on the device, undone from a journal
   before sync starts again; a notification center. Nothing of it is built before the
   user decided.
9. The user decided most of it the same day (`docs/TIMEMACHINE.md`, "Decided"): the
   strip with a label on the bar under the pointer; a note's past in its own file and
   editor rather than a layer, the sync away from that file meanwhile; a folder's
   structure at once and a note's content when opened; a backup on the backup server
   besides the local copy; notices keep popping up; the order. New: ticks as fine as
   one chooses. Open: V1 to V6 there.
10. On 2026-10-30 the user decided V1 to V6 ("Decided (the user, 2026-10-30)"): the
   vault locked on every device whenever the past is shown in the files or applied,
   liftable by hand; a window when a backup exists only on this device. Their
   frontmatter plugin, *Update time on Edit*, read from its source: an extra version
   per edit across a minute's edge, a garbled date when two devices stamp at once -
   proposed: files written with the time the change was made. Open: W1 to W3 (a layer
   for a note alone after all, since the file would lock the vault for every look; the
   lock's reach; the modification time).
11. The user decided W1 to W3 the same day (the file for a note too - one system; the
   lock as proposed; the modification time) and asked for everything at once: built as
   0.8.13. To try, **sync server first** (the lock; the backup server is unchanged),
   then every device: the Time Machine of a note (the timeline, its wave and labels,
   the note read-only in its editor with its changes marked, *Changes: shown/hidden*,
   *Restore this version*), of a folder and of the vault (the explorer showing the past,
   the overview, a picture as it was, *Restore just this note*, *Apply…*, *Undo…*), the
   ticks' fineness, *Backups too*, the window on the other devices while it runs and
   *Unlock…* there, writing on another device meanwhile (it arrives afterwards), Obsidian
   closed while the past is shown (the next start puts it back), the bell and its list,
   and - with *Update time on Edit* installed - that receiving devices no longer stamp.
12. The user's first try of 0.8.13 (2026-10-31): *Back to now* could not be found - the
   bar lay in the tabs' row, under Windows' own window buttons - and the timeline showed
   two tooltips. Fixed in 0.8.14 (the bar under the tabs, the editors moved down; one
   tooltip). The rest of item 11 still to try.
13. The user's further try of 0.8.14 (2026-11-01): the restore showed the old text for
   seconds and could be typed into, the editor's read-only did not hold, other devices could
   type after closing the lock window, the explorer let one leave, the timeline was too dense
   with many changes, the rollback entries said little, a notice's *Undo* vanished, backups
   were slow. Proposed as X1 to X4 and the rest in `docs/TIMEMACHINE.md`, decided as
   recommended, built as 0.8.15. To try, **sync server first** (a lock's holder writes), then
   the **backup server** (a run with nothing changed is done at once), then every device:
   *Restore this version* of a note (the new text at once, not typable before), of a folder
   (the rollback's window, the vault locked until it is done), *Abort*; typing into a note
   under the Time Machine, here and on another device (both refused, the lock in the header);
   *Unlock…* from the header, the cloud and *This device*; the explorer and a link outside
   the note or folder shown; the timeline on the left with many changes, scrolling, the day
   gaps; an earlier rollback clicked in the overview; a delete for everyone's *Undo* from the
   bell; how long a backup takes now, and the steps the backup server's log names.
14. The user tried 0.8.15 on 2026-11-02: the lock, the restore at once, a folder's rollback,
   undoing it, the explorer's guard and links, a dense timeline all work. Found: the marks
   purple like the moment shown, which was hard to see; no *Undo* for a rollback in the
   center; the overview's rollbacks out of scope; a device offline while the lock ended stayed
   locked (and sent nothing); *synced* under a lock; a locked note not marked in its editor;
   typed after lifting the lock, lost to the restore. The user's design: a tab of rollbacks in
   the notification center, each opening the Time Machine before it. Built as 0.8.16 (plugin
   only; `docs/TIMEMACHINE.md`, "The fourth round", also what was taken without asking -
   above all that a restore keeps what was written after the lock). To try: the moment shown
   on the timeline, a rollback's mark (cyan, dashed) and the bar's legend; *Undo…* from the
   center's *Rollbacks* tab, from outside the Time Machine, for a folder and a note; a
   rollback in a shared folder (one notice, no per-note *Undo*); a device offline while the
   lock is lifted, then online (it writes again at once); the status bar and the editor's bar
   with *Unlock…* on another device under a lock; lifting the lock there and typing into the
   note, then restoring - the typed text stays.
15. The user tried 0.8.16 on 2026-11-03 and went on without findings; not tried yet: a device
   offline while the lock is lifted, the bars under a lock, typing after lifting it. Asked for:
   the notification center titled *Connect* - 0.8.17. Asked whether *Undo…* backs up: it does,
   as every restore (the Time Machine backs up as it opens, again before *Restore this
   version*; a rollback keeps its copy in `rollbacks/` besides). What 0.8.16 took without
   asking was not commented on. 0.9's design drafted the same day (`docs/PHASE8.md`), with
   what reading the code for it turned up (Known issues).

Open in 0.8.0, known: two notes created under one path in a folder at once on devices
that knew different folder epochs get two ids and stay as `X.md` and `X 2.md` (no
loss; PHASE7 planned a merge of such duplicates, not built). A note of the vault
moved into a folder on a 0.7 device of the owner is asked about as moved in.

## Roadmap

Ordered by the user on 2026-10-14 (the table is in CLAUDE.md, Conventions).

- **0.8 - sharing a folder, and the small fixes.** Besides the folder, every fix that
  has to be in before 0.9:
  - ~~Typing into an open note while sync itself restarts can lose the keystrokes of
    that moment~~ - fixed in 0.8.2.
  - ~~Content uploaded but never named in the index is never cleaned up from the
    server~~ - fixed in 0.8.3.
  - ~~Local copies of a purged note stay in IndexedDB on the devices that did not purge
    it~~ - fixed in 0.8.4.
  - ~~After a device turns 2FA on, its own socket took seconds to connect again~~ -
    fixed in 0.8.5 (a second: the backoff).
  - Left from 0.7: ~~a device's relay connection is not closed when the account's
    devices are signed out~~ - fixed in 0.8.6; ~~planning a rollback reads one log per
    note~~ - fixed in 0.8.8.
- **0.9 - hardening and a security audit.** Durable writes on the sync server (asked
  for by the user, 2026-10-18): `fsync` the log before the ack and the atomic writes
  before their rename - a power cut on a Pi's SD card otherwise loses acknowledged
  frames -, and a lock so the admin CLI and the server never write `accounts.json`
  at once. Frames signed per author (`docs/PHASE3.md`). Every note live without all
  of them in memory (CLAUDE.md, "Not built yet"). A name and plugin id without
  "Obsidian" (the community directory refuses it; plugin folder, `data.json` and the
  `localStorage` keys move with the id, so it needs a migration) - the user's
  proposal, 2026-10-30: "Connect", free in the directory then. A review of the
  cryptography and the server's API, including that signing out does not replace the
  account secret (`docs/PHASE5.md`). For the community directory besides: a public
  repository, a `LICENSE`, a release tagged `x.y.z`, the README saying a server and an
  account are needed - whether to publish at all is the user's decision.
- **1.0.0** - all of the above done and verified on devices.
- **Later:** syncing plugins and their settings (direction in CLAUDE.md); the
  operator's backup of the data directory, ciphertext only (moved out of 0.7 by the
  user on 2026-10-15); **merging a canvas three ways** (the user, 2026-11-17: "das ist
  was für nach 1.0.0"). Today a canvas changed on two devices at once is kept twice
  (`name (conflict date time).canvas`). Instead: merged per node and per edge by their
  `id` against the version both devices last agreed on (the version history holds it) -
  added on one side taken, deleted on one side and untouched on the other dropped,
  changed on both merged field by field (position from one, text from the other; a text
  node's text through the notes' merge), fields of other plugins kept, the result always
  valid JSON. Only the same field changed two ways is a real conflict: both kept (a
  second node beside it, invariant 4), and chosen in "Compare versions" - the canvas
  there too, in the git-like window notes have since 0.9.23.

## In flight / half-finished

Nothing. `feat/seal-pinned-only` (0.9.0), `feat/durable-writes` (0.9.1), `feat/live-notes` (0.9.2), `feat/signatures` (0.9.3), `feat/signed-frames` (0.9.4), `feat/clean-slate` (0.9.5), `feat/replace-keys` (0.9.6) and `feat/mycel` (0.9.7) are merged.
`debug/start-race` on the remote holds only temporary logging from chasing a CI failure of
0.9.6 (CHANGELOG); nothing of it is in `main`, and it can go. Every branch of 0.8
(`feat/folder-share`, `feat/folder-files`, `feat/backup-folders`, `fix/restart-keystrokes`,
`fix/orphan-blobs`, `fix/purged-copies`, `fix/2fa-reconnect`, `fix/relay-signout`,
`fix/fork-base`, `fix/rollback-listing`, `feat/move-in-linked`, `feat/time-machine`,
`fix/time-machine-feedback`, `feat/time-machine-2`, `feat/time-machine-3`) is merged into `main`
and holds nothing `main` lacks; they are still on the remote - deleting them is the
user's call, as with the earlier branches.

## Decisions made (not visible in the code)

- Per milestone the decisions taken with the user, and what was taken without asking,
  are in its design document: attachments `docs/PHASE4.md`, recovery and 2FA
  `docs/PHASE5.md`, the backup server `docs/PHASE6.md` (up to 0.7.19).
- The user's way of working: they shape the architecture themselves when shown the
  mechanics; they want states that guard data shown where they cannot be missed (a
  window over everything, not a row at the bottom) and every action to say when it
  is done; and they test on real devices and hosts and report back.
- Menus: our items stay in Obsidian's file menus (the only place on a phone), grouped
  under a label with the plugin's name; no submenus (not public API).
- The log: a note or file kept in two versions is logged as an error, as the user
  asked, although nothing failed - it is what someone has to look at.
- The settings tab is not rebuilt while one of its fields has the focus.
- The roadmap order, a branch per milestone merged when done, and pushing after every
  commit are the user's.

## Open questions for the user

- **Which read hung the Time Machine's *Abort*** (2026-11-17, fixed in 0.9.21 whatever it
  was). The log the user sent (2026-11-18) covers that day and the next on a device still on
  0.9.20: only a normal start, no journal left behind - the hang happened earlier or on another
  device. The day's file in `.obsidian/plugins/mycel/logs/` would say; low priority.
- "Compare versions" on a note (2026-10-12): on which device it appeared, and the date
  the dialog names - then that device's log of the day. Not answered; low priority.
- Whether the user's loss through the guard on 2026-10-20 was two runs in a row
  (`docker compose logs mycel-backup | grep "backup of"` around 20:46).
  Not needed any more: both possible causes are fixed in 0.7.18.

## Known issues / debt

- **Open after 0.9.11 (2026-11-09):**
  - ~~*The backup's retention after a suspicious run*~~ - built in 0.9.13: such a run forgets no
    backup until confirmed. Not tried on a device yet: the window titled *Every backup is kept*.
  - *The code review's proposals* (`docs/CHANGELOG.md`, 0.9.11): ~~the composition root out of
    `main.ts` shared with the harness~~ (0.9.16, `SyncSession`), ~~one frame-signature rule for
    plugin and backup server, one decision for a shared file's version, one rename-rounds
    helper; the stale-lock race in `server/src/durable.ts`; the backup's settings copy keeping
    the account's records~~ (0.9.17), ~~the vault lock out of `rooms.ts`~~ (0.9.18). `Folders.ts`
    stays whole on purpose (`docs/CHANGELOG.md`, 0.9.18): split, a dozen private helpers would
    become public. The review's proposals are done.
  - *A flake seen once (2026-11-11, `test:backup`, 1 of 4 runs):* "only the rooms that changed are
    fetched" and "restic diff ... names exactly the notes that changed" failed together - by every
    sign the account's settings changed between the first and the third run (the trusted copy
    still wrote exactly the two notes). Not reproduced; its detail lines were not kept.
  - *The benchmark's findings* (`docs/PERFORMANCE.md`): ~~the outbox rewritten whole on every
    keystroke offline~~ (0.9.14), ~~a restart opening every note~~ (0.9.15), each
    subscribe downloading a note's last frame again, O(n) work per change in eviction and the
    indexes. And, read and not reproduced: `DocStore.evict` can let go of a note an editor just
    bound (its re-check misses the pinned and editor-owned tests); a vault index slower than
    `syncTimeoutMs` at a start says the server does not answer.

- **Left by the audit (`docs/AUDIT.md`, "Not fixed")**, as of 0.9.8 - closed in 0.9.9 (R1 to
  R9) and 0.9.11 (P11): a server moving a room back to an earlier epoch is followed; no quota
  for rooms and log bytes; the token in the WebSocket URL; presence and titles unsigned; the
  backup server checks no frame signatures and may be pointed at addresses in its own network.

- **Found while drafting 0.9 (2026-11-03, `docs/PHASE8.md`, each checked in the code; not
  fixed yet):**
  - ~~A rotation of a shared note's or folder's key seals it to every member the server
    lists, and for one who is no contact to the key the server gives - a server could
    list itself and read on (S, finding 1)~~ - fixed in 0.9.0.
  - ~~The sync server never `fsync`s; a frame torn by a crash is never cut off and garbles
    the next; a push during a compaction is written twice; a compaction writes the log
    before its metadata; the CLI and the server can overwrite each other's
    `accounts.json` (D)~~ - fixed in 0.9.1.
  - ~~A note let go beyond `maxLoadedDocuments` may still hold an unsent change or be held
    for recovery; reconnecting does not catch up notes let go (L)~~ - fixed in 0.9.2.
- **Only on a device** (untestable headless): menus, modals, the settings tab, the
  status bar marks, the header lock, `requestUrl` with binary bodies on mobile, binary
  file events, `file-open` fetching, memory with large files on a phone, the Time
  Machine on screen (0.8.13: the timeline and its wave, the bar, the overview, the
  explorer and editors showing the past, the marks in live preview, a large vault's
  structure written per tick, the windows on the other devices), the bell and its tabs,
  the bar at the top of a locked note's editor in Obsidian's own editor (0.8.16).
- Under another device's lock, what is written anywhere in the vault waits, not only in
  what the lock covers: the server knows rooms, not paths. Letting the rest through would
  need the lock to name its rooms (a note's own, a folder's notes and the index) - not
  asked for.
- A rollback's notes whose text then comes from a backup are restored without the text at
  the lock: what was written into them after the lock is overwritten there (it stays in
  the history and in the rollback's copy).
- The Time Machine's ticks of a folder or the vault go by the server's minutes for edits
  (rounded down, by its clock) and by the authors' clocks for the rest, so an edit made
  in the minute a note moved into a folder can make a tick of that folder, and a tick
  whose edits left every text as it was is still one. The overview compares texts as a
  moment's contents are filled in.
- A folder's past shows a note that moved out of it since both there (as it was) and
  where it is now: outside the folder nothing is touched.
- Plugins that stamp a note on every `modify`, such as *Update time on Edit*: since
  0.8.13 a file another device's change wrote carries that change's time, which leaves
  only an editor open on two devices at a minute's edge (Obsidian saves it with its own
  time). With that plugin, its minimum minutes between saves at 5 closes even that.
- Every start still opens every note once (L1, not in 0.9 - the user left it to the
  recommendation): a vault of thousands of notes takes minutes to start. A start that skips
  notes whose file and log did not move would need the scan to trust mtime and size.
- Shared notes are still compared with their files once a minute (`SharedFiles.scheduleAll`),
  which opens each: beyond `maxLoadedDocuments` shared notes, they go in and out of memory.
- *Replace all keys* (0.9.6) has limits: a contact's device learns of it from the server
  (`contact-replaced`) - a server that keeps quiet lets them go on sealing to the keys before
  until they exchange a new friend code; a member who replaced their own keys and was not
  confirmed again yet gets this account's rewritten keys sealed to the key pinned for them -
  the one before; one who is no contact stops the replacement until taken out; files of this account's
  named in someone else's shared note's list stay under the key before until this account's
  device next lists them; forks kept for someone whose share ended before the replacement are
  signed with the signing key before. The plugin's own progress shows in a notice; a vault of
  thousands of notes has not been measured.
- The plugin id contains "obsidian", which the community directory refuses (0.9).
- `test:recovery`'s check "carries on in the same note, and what it wrote while away
  reaches P1" failed on 2026-10-16 and 2026-10-23: a race in the fork on return, fixed
  in 0.8.7 (CHANGELOG). If it fails again, its log shows `merge (no common base,
  union)` for `Shared/Shared.md` - then the base did not move along some other way.
  It failed again in CI on `main` on 2026-11-06 (0.9.7's merge; passed on rerun), without
  that line: P2, back, logs "adopt-local, file 48 chars, note 19, base 19" and "carries on
  as 8bff2dba, 128 B held here", then "merged 1 duplicate(s)" twice - and P1 keeps "from
  anna\nand more\n" while P2 has its own "and less" text. **Still open** (looked into on
  2026-11-08, `fix/ci-races`): the failing log shows P2 starting from a vault index without
  P1's fork ("vault index arrived: 1 notes, 0 deleted"), its scan waiting the full 4 s
  (`syncTimeoutMs`) on the old note's revoked room before "adopt-local", the end of the share
  carried out twice ("another device forked it already" at +0 and +140 ms - so the first
  `carryOn` finished without moving anything), and the second duplicate merge waiting 4 s too:
  the old note's entry was live again at the path of the new one on some device, and a
  duplicate merge keeps the sorted-first id, which may be the old, revoked one. What revives the
  tombstone was not found; `VaultIndex.rename` revives one (`live()`) and is a candidate. The
  test now holds P1's index frames back until P2 has started, the order of the failing log; it
  passes with that alone (twice locally), so another timing is needed as well.
- **Fixed on `fix/ci-races` (2026-11-08)**, each reproduced first in a test by holding back one
  device's frames, uploads, blob touches or backup writes (`slowed` in the harness), and checked
  by putting the bug back (CHANGELOG, "Unreleased"):
  - `test:folders` "a file brought back from the trash is back for everyone in the folder"
    (CI on `main` 2026-10-29, 2026-11-02, 2026-11-03): not `decideMs` - the owner's other device,
    still carrying out the delete, trashed its file after the restore had arrived and took its
    own trash event for a delete made there. Fixed in `AttachmentStore.applyDelete`/`onDelete`;
    the same for notes in `DocStore` (a restore undone on every device; `test:vault`).
  - A writer's offline version of a shared folder's file ending up only in its version history
    (CI 2026-11-06): not another device's adoption - the writer's own folder pass decided
    "unchanged here" while its scan held the file's lock to take in the version written away,
    then `adopt` set the owner's version over it and recorded the writer's as replaced knowingly.
    `adopt` now checks under the lock that the index still names the version the source
    replaced (`FolderFiles` and `SharedFiles` agree only then).
  - `test:folders` "no file at Shared/X/Sub/byPia.png" (2026-11-06, 2026-11-07): the base was
    ahead of the folder's document on the writer's other device - the vault index and the
    folder's room are applied apart (`VaultSocket` keeps one chain per room) - and the older
    document was taken for a rename back. The same for a note's `folderPath`. Bases and
    `folderPath` now name the folder's write they come from (`FolderWrite`), and a document
    that does not hold it decides nothing. Limit: a folder write the server never takes leaves
    that file or note unfollowed on the account's other devices until the folder's entry is
    written again and a device of the account agrees with it.
- **Seen only in CI, never locally** (for the audit; before 0.9.6 too):
  - `test:backup` "the starting point (#1) does not fit the log (epoch from #2, head #1)"
    (0.9.2, 0.9.3, three times for 0.9.6/0.9.7): a note created and its folder shared without
    history a moment later; the server moved the note's epoch while counting a frame still
    being written (`epochSince` 2), and later its head is 1 - the device's `lastSeq` is 1 too,
    nothing of it unacknowledged, so the share failed with "try again" five times over. Since
    0.9.7 a starting point has to hold every frame of an earlier epoch on the disk and every
    one counted when the epoch moved that did land (`min(epochSince, head)`); a server that
    finds its epoch beginning after its head says so in its log ("its epoch began after"). Why
    a counted frame does not land is not found: server-side logs (`debug/start-race`) caught no
    failing run; passing runs show the creation frame written under the old epoch while the
    note joined its folder, and sent again under the new one after the `rekey`. Looked into
    again on 2026-11-08 (`fix/ci-races`), not reproduced: no failure since 0.9.7's change
    (every CI run from 2026-11-06 20:08 on). `RoomLog.appendAll` counts a frame in `pending`
    only once the push passed the epoch check, and always takes it off again, written or
    failed (the write queue chains on a promise that never rejects); a room is let go only
    when `idle`, and a reload waits for the room's queued writes. So a counted frame that never
    landed means a write that failed - which logs "a frame could not be written" - or a
    `headOf` taken from another `RoomLog` than the one the frame went to. Neither was seen.
- The development machine is short of memory (often 1.6 GB free of 15.6 GB): a
  `test:backup` run takes four to ten minutes, and twice died at its start (restic,
  then Node out of memory); rerun before suspecting the code.
- The Docker images are private like the repository: pulling needs `docker login
  ghcr.io` with a token that may read packages.

## Verification state

restic on the development machine: `%USERPROFILE%\tools\restic\restic_0.19.1_windows_amd64.exe`
(the official release, checksum checked, put there with the user's consent on
2026-10-15). `test:backup` needs
`MYCEL_RESTIC="$HOME/tools/restic/restic_0.19.1_windows_amd64.exe"`.
rclone runs only in the image (CI).

At 0.8.16, run 2026-11-02 on `feat/time-machine-4`: `typecheck` and `build` pass;
`test:merge` 174, `test:load` 17, `test:rooms` 401, `test:sync` 31, `test:recovery` 72,
`test:account` 52, `test:rollback` 78, `test:timemachine` 89, `test:backup` 231, and on
a scratch server started fresh from 0.8.16 `test:socket` 19, `test:vault` 243,
`test:folders` 121 - all pass.

At 0.8.15, run 2026-11-01 on `feat/time-machine-3`: `typecheck` and `build` pass;
`test:merge` 174, `test:load` 16, `test:rooms` 401, `test:sync` 31, `test:recovery` 72,
`test:account` 52, `test:rollback` 72, `test:timemachine` 66, `test:backup` 231, and on
a scratch server started fresh from 0.8.15 `test:socket` 19, `test:vault` 243,
`test:folders` 121 - all pass.

At 0.8.13, run 2026-10-30 on `feat/time-machine-2`: `typecheck` and `build` pass;
`test:merge` 174, `test:load` 16, `test:rooms` 399, `test:sync` 31, `test:recovery` 72,
`test:account` 52, `test:rollback` 72 (its rollbacks now under the lock),
`test:timemachine` 48, `test:backup` 229, and on a scratch server started fresh from
0.8.13 `test:socket` 19, `test:vault` 243, `test:folders` 121 - all pass.

At 0.8.12, run 2026-10-29 on `fix/time-machine-feedback`: `typecheck` and `build` pass;
`test:merge` 174, `test:load` 15, `test:rooms` 379, `test:sync` 31, `test:recovery` 72,
`test:account` 52, `test:rollback` 72, `test:backup` 229, and on a scratch server started
fresh from 0.8.12 `test:socket` 19, `test:vault` 243, `test:folders` 121 - all pass.

At 0.8.11, run 2026-10-27 on `feat/time-machine`: `typecheck` and `build` pass;
`test:merge` 174, `test:load` 15, `test:rooms` 379, `test:sync` 31, `test:recovery`
72, `test:account` 52, `test:rollback` 65, `test:backup` 229, and on a scratch
server started fresh from 0.8.11 `test:socket` 19, `test:vault` 243, `test:folders` 121 -
all pass. `test:backup` failed three of the guard's checks once, run right after the
other suites (memory, see Known issues; nothing of the guard changed) - alone it passed.

At 0.8.10, run 2026-10-25 on `feat/move-in-linked`: `build` passes; `test:merge`,
`test:load` 14, `test:rooms`, `test:sync`, `test:recovery`, `test:account`,
`test:rollback` 55, `test:backup` 228, and on a scratch server started fresh from 0.8.10
`test:socket`, `test:vault` 243, `test:folders` 121 - all pass (the unchanged suites at
their 0.8.9 counts).

At 0.8.8, run 2026-10-23 on `fix/rollback-listing`: `build` passes; `test:merge` 171,
`test:load` 14, `test:rooms` 374, `test:sync` 26, `test:recovery` 71, `test:account` 52,
`test:rollback` 53, `test:backup` 228, and on a scratch server started fresh from 0.8.8
`test:socket` 19, `test:vault` 241, `test:folders` 88 - all pass.

At 0.8.7, run 2026-10-23 on `fix/fork-base`: `build` passes; `test:merge` 171,
`test:load` 14, `test:rooms` 372, `test:sync` 26, `test:recovery` 71 (and five runs in a
row before), `test:account` 52, `test:rollback` 52, `test:backup` 228, and on a scratch
server of 0.8.6 `test:socket` 19, `test:vault` 241, `test:folders` 88 - all pass.

At 0.8.6, run 2026-10-23 on `fix/relay-signout`: `build` passes; `test:merge` 171,
`test:load` 14, `test:rooms` 372, `test:sync` 26, `test:account` 52, `test:rollback` 52,
`test:backup` 228, and on a scratch server started fresh from 0.8.6 `test:socket` 19,
`test:vault` 241, `test:folders` 88 - all pass. `test:recovery` failed once (70 of 71:
the known race in the fork on return, see Known issues) and passed twice after.

At 0.8.5, run 2026-10-23 on `fix/2fa-reconnect`: `build` passes; `test:merge` 171,
`test:load` 14, `test:rooms` 370, `test:sync` 26, `test:recovery` 71, `test:account` 52,
`test:rollback` 52, `test:backup` 227, and on a scratch server of 0.8.3 `test:socket` 19,
`test:vault` 241, `test:folders` 88 - all pass.

At 0.8.4, run 2026-10-23 on `fix/purged-copies`: `build` passes; `test:merge` 171,
`test:load` 14, `test:rooms` 370, `test:sync` 26, `test:recovery` 71, `test:account` 50,
`test:rollback` 52, `test:backup` 227, and on a scratch server of 0.8.3 `test:socket` 19,
`test:vault` 241, `test:folders` 88 - all pass.

At 0.8.3, run 2026-10-23 on `fix/orphan-blobs`: `build` passes; `test:merge` 171,
`test:load` 14, `test:rooms` 370, `test:sync` 26, `test:recovery` 71, `test:account` 50,
`test:rollback` 52, `test:backup` 227; `test:socket` 19, `test:vault` 239 and
`test:folders` 88 against a scratch server of 0.8.2 (no touch route: the fallback) and
again against one started fresh from 0.8.3 - all pass.

At 0.8.2, run 2026-10-23 on `fix/restart-keystrokes`: `build` passes; `test:merge` 171,
`test:load` 14, `test:rooms` 362, `test:sync` 26, `test:recovery` 64, `test:account` 50,
`test:rollback` 52, `test:backup` 227, and on a scratch server on 1235 `test:socket` 19,
`test:vault` 239, `test:folders` 88 - all pass.

At 0.8.1, run 2026-10-23 on `feat/folder-files`: `typecheck` and `build` pass;
`test:merge` 171, `test:load` 14, `test:rooms` 362, `test:sync` 26, `test:recovery` 64,
`test:account` 50, `test:rollback` 52, `test:backup` 214, and against a scratch server
on 1235 `test:socket` 19, `test:vault` 230 and `test:folders` 88 (twice) - all pass.
The scratch server once logged `EPERM` renaming a blob's `.json.tmp` while it was read:
Windows only, as with `contacts.json` before; the Docker server runs on Linux.

At 0.8.0, run 2026-10-23 on `feat/folder-share`: `typecheck` and `build` pass;
`test:merge` 171, `test:load` 14, `test:rooms` 362, `test:sync` 26, `test:recovery` 64,
`test:account` 50, `test:rollback` 52, `test:backup` 214, and against a scratch server
on 1235 (started fresh from this code) `test:socket` 19, `test:vault` 230 and
`test:folders` 63 - all pass. `test:folders` runs in CI after `test:vault` from now on.
Once on Windows the scratch server failed to rename `contacts.json` (`EPERM`, a file
held open); the harness now catches that as `main.ts` does, and the rerun passed - not a
problem of the Docker server.

At 0.7.19 the user installed and confirmed it on 2026-10-21 (CI green, both images
published as `latest`).

Earlier versions: what ran for each is in `docs/CHANGELOG.md` and in this file's git
history. How to run the end-to-end suites without touching the user's server:
CLAUDE.md, Gotchas - `test:socket` and `test:vault` default to 1234, so always pass
`ws://localhost:1235`.

---

## Log

### 2026-11-02
- The user tried 0.8.15 and drew the rollbacks' tab: built as 0.8.16 on `feat/time-machine-4`
  with what else they found (item 14). The lock that ended while a device was away was a
  real bug - the device sent nothing until a restart -, checked by putting it back.

### 2026-11-01
- The user's further try of the Time Machine: X1 to X4 proposed and decided as recommended,
  built as 0.8.15 on `feat/time-machine-3` - a restore under the lock, the editors read-only
  everywhere (Obsidian's own read-only came first), the explorer guarded, the timeline on
  the left, rollbacks as moments, notices with a button, backups with nothing changed done
  at once.

### 2026-10-31
- The user's first try of the 0.8.13 Time Machine: the bar's buttons hidden under the
  window's own, two tooltips on the timeline. 0.8.14 fixes both.

### 2026-10-30
- The user decided V1 to V6 and W1 to W3 of the Time Machine's second round and asked for
  all of it at once: built as 0.8.13 on `feat/time-machine-2` - the vault lock (server and
  plugin), the past in the files with its journal and copies, the timeline, the bar, the
  overview, a note's marks, backups before, the notification center, synced files' times.
  New suite `test:timemachine`.

### 2026-10-29
- The user tested the Time Machine (0.8.11): it works. 0.8.12 fixes what they found;
  both new checks seen failing with the old behaviour put back. Their larger wishes are
  proposed as U1 to U5 in `docs/TIMEMACHINE.md`, for them to decide.

### 2026-10-24 to 27
- 0.8.9 (the user's first test of 0.8), 0.8.10 (linked notes on moving in), the Time
  Machine designed with the user (T1 to T8) and built as 0.8.11.

### 2026-10-23
- The six small fixes of PHASE7, each with its test and a version (0.8.2 to 0.8.6,
  0.8.8), and the race in the fork on return that `test:recovery` showed again (0.8.7).
  Three of them checked by putting the bug back (1, 3, 5); the 2FA reconnect measured
  first (a second, the backoff), its new checks failing before the fix.
- `test:backup` follows shared folders over time (13 checks, all passed at once).
- 0.8.1 built on `feat/folder-files`: files in shared folders, the share dialog's
  options for files and notes outside the folder; three races of 0.8.0 found by the
  new checks and fixed (windows while sharing, a delete undone by another device of
  the account, a file fetched twice).
- 0.8.0 built on `feat/folder-share`: server (folder rooms, access, API, ties), plugin
  (keys, folder document, mirror, moves, deletes, revoking, ending, UI), backup server
  keys for folder notes. Two bugs found and fixed on the way (CLAUDE.md invariants 28,
  29). New suite `test:folders`.

### 2026-10-22
- 0.8 designed with the user: how sharing a note works laid out, options per case,
  the user chose (a folder room of its own; a window before an existing note joins;
  deletes in the folder for everyone, with a notice; files inside the folder belong to
  it, linked ones outside travel as a note's). `docs/PHASE7.md` written and signed off;
  the small fixes investigated and specified in it.

### 2026-10-21
- 0.7.18 merged (a time of day, waiting while someone writes, rclone, the password
  shown; and two bugs from the user's test - the guard let a loss over two runs
  through, the relay had no ping behind the proxy).
- 0.7.19: the schedule's day buttons and hour and minute dropdowns, as the user chose;
  a held decrypted copy asked about in a window over everything, letting it follow
  waited for to the end. The trash does not count for the guard. Merged; the user
  confirmed it and considers 0.7 done.

### 2026-10-20
- 0.7.17 on the Pi, backups by hand work. Asked about rclone, the copyable password,
  backups while someone writes, the guard on runs by hand; built 0.7.18.

### 2026-10-18
- The backup server's 403 was the user's network (Docker's DNS, the DNAT on `eth0`
  only, the `PI5-FWD` drop of answers from the subnet), fixed without a new image.
  First real test; decided together: one backup task per vault, paths picked by the
  backup server, one backup server per vault - 0.7.17.
- 0.7.12 to 0.7.16: diagnostics of the backup server, its data folder, the images
  handing their folders over.

### 2026-10-17
- 0.7.6 to 0.7.9 (invitations and pairings, settings in tabs, rolling back from the
  history and from restic), merged. 0.7.10 "Use this server"; 0.7.11 the backup
  server's `status`.

### Before
- 2026-10-15/16: 0.7 designed with the user (`docs/PHASE6.md`) and built as 0.7.0 to
  0.7.5. 2026-10-12 to 14: 0.6 (signing out, recovery code, 2FA) and 0.6.4 to 0.6.8;
  `feat/accounts` merged into `main`. 2026-10-10/11: 0.5 (attachments). Older:
  `docs/CHANGELOG.md`.
