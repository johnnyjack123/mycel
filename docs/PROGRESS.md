# Progress

_Last updated: 2026-11-27 · **Phase: the device run before 1.0.0.** 0.9 - hardening and the
security audit - is built. The user started afresh on 2026-11-13 and is trying everything on
real devices. Each thing they find or ask for becomes the next patch: 0.9.19 to 0.9.32 so far.
Current version: **0.9.32** (branch `feat/merge-drag`; 0.9.31 is `latest-build`).
1.0.0 follows once everything is verified on devices, then publishing, if the user wants it._

## Where we are

Monorepo (`npm` workspaces): `packages/shared`, `packages/server`, `packages/plugin`,
`packages/backup`. **Read `CLAUDE.md` first.** It has:
- 36 invariants, each from a real bug or a risk the user named;
- the architecture;
- the roadmap to 1.0.0;
- the conventions: a branch per milestone, push after every commit, a version for every change
  the user installs.

Designs: `docs/PHASE2.md` (keys, sharing), `docs/PHASE3.md` (accounts without names, contacts,
forks, trash, surviving the server), `docs/PHASE4.md` (attachments), `docs/PHASE5.md` (recovery
codes, 2FA), `docs/PHASE6.md` (the backup server), `docs/PHASE7.md` (shared folders),
`docs/TIMEMACHINE.md` (the Time Machine), `docs/PHASE8.md` (0.9). The audit is in
`docs/AUDIT.md`. Running them: `docs/SERVER.md`, `docs/BACKUP.md`. Every version and how its
fixes were verified: `docs/CHANGELOG.md`.

### The phase: the device run before 1.0.0

The roadmap's last step before 1.0.0 is "all of the above done and verified on devices"
(CLAUDE.md, Conventions). Everything planned for 1.0.0 is built:
- **0.8** - shared folders, the small fixes, the Time Machine.
- **0.9** - built and audited from 2026-11-03 to 2026-11-12 (CHANGELOG):
  - signing: keys sealed only to pinned contacts (0.9.0), signed sealed keys and frames (0.9.3,
    0.9.4);
  - durable writes on the server (0.9.1);
  - every note live (0.9.2);
  - a clean slate (0.9.5);
  - *Replace all keys* (0.9.6);
  - the name Mycel (0.9.7);
  - the security audit and its residual risks (0.9.8, 0.9.9, `docs/AUDIT.md`);
  - the setup wizard (0.9.9);
  - CI races, link claims, the benchmark's findings and the code review's proposals (0.9.10 to
    0.9.18).

**The fresh start** came on 2026-11-13. Nothing written before 0.9.5 is read, and nothing named
before 0.9.7 is found. The steps are below, kept for a device or host set up later. Since then
the user runs the new setup and reports back. Each finding or wish was a version of its own:

| Version | Date | What |
|---|---|---|
| 0.9.19 | 11-13 | The user's design: a device new to a vault on the server compares first and asks - merge both, take the server's version, or not now (invariant 34). |
| 0.9.20 | 11-13 | Found on the first device of the fresh start: the copy before connecting was refused by the gate. |
| 0.9.21 | 11-17 | Found by the user: the Time Machine's *Abort* hung. |
| 0.9.22 | 11-17 | The user's wishes: the joining window says what merging does, and merged notes are marked in the explorer. |
| 0.9.23 | 11-18 | The user's design: "Compare versions" as git's merge tools. |
| 0.9.24 | 11-21 | The user's decisions: a vault can be deleted on the server (invariant 35). |
| 0.9.25 | 11-21 | The CLI takes the vault's id alone. |
| 0.9.26 | 11-21 | The user's design: both versions line beside line, and the setup guide's live comparison. |
| 0.9.27 | 11-24 | Found by the user: a rollback from the Time Machine failed on Windows (EPERM while removing the copies). |
| 0.9.28 | 11-25 | Found by the user, the cause found with them over ssh: Google Drive made every folder of the PC's vault read-only, Windows refused to remove them, and the start, opening and leaving the Time Machine waited a minute each; the Time Machine took its own lock for another device's. |
| 0.9.29 | 11-26 | The user's findings and decisions: notes to compare on every device, no conflict markers, the Time Machine's marks, resetting a device's sync, one Obsidian vault per vault of the server, a device's name, the status bar's count, the vault's rows under All devices. |
| 0.9.30 | 11-26 | Found by the user: the reset waited and failed half done (the local history held its database open). Their decision: *Disconnect this vault* - signed out, nothing of the sync left on the device - instead of the reset. |
| 0.9.31 | 11-27 | Found by the user: a note one side only added to was not always listed to compare (one open in an editor while its device joined). Their decision: a range of lines in "Compare versions", across what both have. |
| 0.9.32 | 11-27 | Found by the user: the range worked but was unintuitive. Their design: lines dragged in "Compare versions", as cards on a board - anywhere in the middle, several at once. |

**Next:**
1. **The second audit** (the user, 2026-11-27): a fresh agent, in a worktree of its own, tests
   the whole project for what could expose someone's notes or lose data - attacking it, putting
   it into strange situations, trying to break and exploit it - and reports each finding with a
   reproduction; it fixes nothing. No more features are planned for 1.0.0 (the user: "von meiner
   Seite für v1.0 ready").
2. The findings fixed with the user, then everything since 0.9.32 (branch `fix/cosmetics`) built
   as 0.9.33 and tried on the devices ("Still to try on devices").
3. Then 1.0.0. What it needs besides is the user's call: publishing, item 12 (a release tagged
   `x.y.z`, the README, the Docker images still private).

### Confirmed on devices

**Before the fresh start:**
- Account, sign-in, 2FA and recovery code; note sync, sharing and live editing; attachments with
  conflict copies; trash and version history; linked notes (0.6.8, 2026-10-14).
- The backup server (0.7.19, 2026-10-21): connecting with an invitation; a task with the
  repository on the backup server and the decrypted copy; backups by hand and on schedule; the day
  buttons and the time; the guard holding the copy with its window.
- Sharing a folder, its explorer mark, files coming along (0.8.8, 2026-10-24/25); carets with
  0.8.9.
- The Time Machine (0.8.15, 2026-11-02): the lock, a restore at once, a folder's rollback and
  undoing it, the explorer's guard and links, a dense timeline. 0.8.16 was tried the next day
  without findings.

**In this run:**
- "Compare versions" of 0.9.26: the user called it much better, and a note merged with it went
  well (2026-11-24).
- 0.9.24's deletion through the CLI was tried; the question it raised became 0.9.25.
- *Disconnect this vault* of 0.9.30 "seems to work well" (2026-11-27), and a note merged on
  meeting again was put together in "Compare versions" - which found what became 0.9.31.
- The range of lines of 0.9.31 worked with Shift-click (2026-11-27), but was unintuitive and
  hard to follow - which became 0.9.32.
- Lines dragged in "Compare versions" of 0.9.32 "sieht jetzt wirklich schon sehr gut aus"
  (2026-11-27); two cosmetic findings became part of 0.9.33.
- A rollback and a restore from the Time Machine on the PC (0.9.32, 2026-11-27) - the three
  findings around them (the window without a backup server, a mark beside the same state, undo
  not saying where it goes) became part of 0.9.33. *Disconnect this vault* and *Replace all keys*
  tried too (2026-11-27), and shared notes and folders with a second account long before.

### Still to try on devices

What only a device can show (CLAUDE.md, Testing) and nobody has tried yet, newest first:
- **0.9.33** (once built): *Overwrite the server with this vault* in the joining window (a
  device after *Disconnect this vault*), its second question, and the other device following;
  "Backed up on this device" after a rollback or restore without a backup server; *Undo in the
  Time Machine…* and its window, landing at the moment before; a restore's mark no longer beside
  the same version; the legend in the bar; the line under the buttons of "Compare versions" not
  moving.
- **0.9.32:** on a phone, dragging by the number with a finger while the rest still scrolls, and
  a tap selecting (not seen in the emulation: it made no click from a tap on any button).
- **0.9.31:** a note only one side added to, open in an editor on the device that joins and
  shorter there: marked in the explorer and listed in "Compare versions" afterwards (on the PC:
  if not, its log says `editor held text the note did not; adopt-remote … base none` for the
  note). (The range of lines of 0.9.31 is replaced by 0.9.32.)
- **0.9.30** (*Disconnect this vault* itself tried, 2026-11-27): Obsidian closed during a
  disconnect - the next start finishes it, nothing syncs meanwhile.
- **0.9.29:**
  - notes to compare showing on the other device, put together there, gone on both;
  - the name of a device in the window, the list and a lock's window;
  - the marks on the Time Machine's strip, and the hint when notes still wait to be compared;
  - a second Obsidian vault on one computer naming the same vault: the window, taking over, the
    first one stopping;
  - the status bar's count and tooltip; the vault's rows under All devices; no *Conflict markers*.
- **0.9.28:**
  - on the PC with its read-only `timemachine\copies`: a start connecting within seconds of
    `loaded`, opening and aborting the Time Machine at once, no second window beside its own (a
    restore and a rollback there worked, 2026-11-27);
  - on a device whose folders may go, `timemachine/` and old backups cleared as before.
- **0.9.27:** Obsidian restarted while the past is shown (the rollback on Windows worked).
- **0.9.26:**
  - "Compare versions" on a phone (the passages one below the other);
  - copying a selection from one version in Obsidian;
  - the setup guide's live comparison on a newly connected vault.
- **0.9.24:**
  - *Delete on the server…* in Settings → Account;
  - the window on every device: *Take it back*, *Upload this vault anew*, *Connect to another
    vault*, *Not now*.
- **0.9.22:** the explorer's marks of notes to look at, and *Done* taking them off.
- **0.9.19, the joining window on real vaults** - what a device shows when it meets the vault on
  the server for the first time (a new device, or one after *Disconnect this vault*). Merging both
  after a disconnect is tried; the other cases are covered by `test:join` and come up on a device
  only when it happens:
  - an empty vault (*Download*), a copy of the same state (*Connect*);
  - an older copy (*Take the server's version*), another vault;
  - *Not now* and the status bar bringing it back;
  - the copy in `.obsidian/plugins/mycel/backups/`.
- **0.9.13:** the window *Every backup is kept* after a suspicious run.
- **0.9.11:** links in shared notes - the marks of someone else's links in the editor and
  reading view, opening them, and a link to a note of yours that the people in the note lack.
- **0.9.9:**
  - the setup wizard on a phone;
  - carets between two people who are contacts (the name shown is the one you gave them);
  - the sync through Nginx Proxy Manager with the token as a WebSocket subprotocol.
- **0.9.8:**
  - sharing a note with its files;
  - a link someone else types into a shared note to a file of yours (the notice, *Share …*);
  - a friend code between two devices;
  - the server behind the proxy with `MYCEL_TRUST_PROXY`.
- **0.9.4/0.9.5:** a writer made a reader and back. Each moves the note to a new epoch, and the
  log should show no "not signed by someone who may write here".
- **0.9.1:** how long a push takes on the Pi's SD card with a sync per frame (not measured).
- **0.8.16:** a device offline while the lock is lifted; the bars under a lock; typing after
  lifting it.
- **0.7:**
  - a cloud repository (S3/B2, `rclone:`, `sftp:` with a mounted key);
  - the RAM disk's size with a large vault;
  - restoring with restic by hand;
  - opening the decrypted copy as a vault.

### The user's setup

This matters when something fails between the hosts.
- **Sync server:** Docker on a machine in a subnet of its own, behind Nginx Proxy Manager with
  TLS (`wss://sync.example.org` - the user's host name, not renamed with the project).
  - Its access list admits the home network and the Pi's subnet address.
  - It needs 0.7.18 or newer: without the relay's ping, NPM closed the backup server's
    connection every minute.
- **Backup server:** Docker on a Raspberry Pi 5 that routes the subnet and runs Pi-hole.
  - The Pi's iptables script puts `PI5-FWD` in `DOCKER-USER` and DNATs 443 on `eth0` only.
  - Its compose file pins the sync server's name to the sync server's address with
    `extra_hosts`.
  - The user added an `ESTABLISHED,RELATED` accept for answers from the subnet.
- **The plugin** is installed by copying `main.js`, `manifest.json` and `styles.css` from the
  `latest-build` release.
- `packages/server/data` and port 1234 on the development machine are the user's old local
  server: never touch either (CLAUDE.md, Gotchas).

### Starting afresh

Done on 2026-11-13. Kept for a device or host set up later.
- **Sync server:**
  - the image is `ghcr.io/johnnyjack123/mycel-server`, with a new, empty data folder;
  - the `.env` has every variable renamed (`OBSIDIAN_CONNECT_JWT_SECRET` → `MYCEL_JWT_SECRET`
    and so on; `docs/server.env` lists them);
  - the CLI is `mycel` (`docker exec <container> mycel invite`).
- **Backup server:** the image is `mycel-backup`, with its variables `MYCEL_*`
  (`docs/backup.env`) and its data folder emptied. It is invited again from a device.
  - The old data folder is best kept aside rather than emptied: its `decrypted/` holds the vault
    as plain files.
- **Every device:**
  - delete the old plugin folder `.obsidian/plugins/obsidian-connect/`, which holds the old
    token and keys;
  - install the plugin into `.obsidian/plugins/mycel/`;
  - the old plugin's `localStorage` and IndexedDB entries (named `obsidian-connect…`) are not
    read any more. They can be cleared with the browser tools or left;
  - register new accounts, make contacts anew with friend codes, share notes and folders anew;
  - every device asks before its first sync (invariant 34).

## Roadmap

Ordered by the user on 2026-10-14; the table is in CLAUDE.md, Conventions.

- ~~**0.8** - sharing a folder, the small fixes, the Time Machine~~ - done (0.8.0 to 0.8.17).
- ~~**0.9** - hardening and a security audit~~ - built (0.9.0 to 0.9.18, `docs/PHASE8.md`).
  Since 0.9.19: what the device run finds.
- **Now: the device run.** See "Still to try on devices" above.
- **1.0.0** - all of the above done and verified on devices.
- **Publishing** (P in `docs/PHASE8.md`) comes last, and whether to publish at all is the user's
  decision.
  - Done: the repository is public, `LICENSE.md`, and a name without "Obsidian".
  - Missing for the community directory: a release tagged `x.y.z`, and the README saying a
    server and an account are needed.
- **Later:**
  - syncing plugins and their settings (direction in CLAUDE.md);
  - the operator's backup of the data directory, ciphertext only (moved out of 0.7 by the user
    on 2026-10-15);
  - **merging a canvas three ways** (the user, 2026-11-17: "das ist was für nach 1.0.0").

**The canvas merge.** Today a canvas changed on two devices at once is kept twice
(`name (conflict date time).canvas`). Instead:
- It is merged per node and per edge, by their `id`, against the version both devices last
  agreed on; the version history holds it.
- What one side added is taken.
- What one side deleted and the other left untouched is dropped.
- What both sides changed is merged field by field: position from one, text from the other; a
  text node's text goes through the notes' merge.
- Fields of other plugins are kept, and the result is always valid JSON.
- Only the same field changed two ways is a real conflict. Both are kept, as a second node beside
  it (invariant 4), and chosen in "Compare versions" - the canvas there too, in the git-like
  window notes have since 0.9.23.

## In flight / half-finished

- **`fix/cosmetics`** (2026-11-27, pushed, not merged, no version yet - the user: no build needed
  at once). Everything of 0.9.33 in the CHANGELOG: *Overwrite the server with this vault*, a mark
  not shown twice beside a tick alike, the windows of a backup on this device alone and of undo,
  the hint line of "Compare versions" and the Time Machine's legend. Every suite it touches is
  green (merge, load, sync, join, timemachine, rollback). To go out with the second audit's
  fixes as 0.9.33.

Besides it, every branch on the remote is merged into `main`, except `debug/start-race`. It holds
only temporary logging from chasing a CI failure of 0.9.6 (CHANGELOG), and it can go. Deleting
the merged branches is the user's call.

## Decisions made (not visible in the code)

- Per milestone, the decisions taken with the user, and what was taken without asking, are in its
  design document:
  - attachments: `docs/PHASE4.md`;
  - recovery and 2FA: `docs/PHASE5.md`;
  - the backup server: `docs/PHASE6.md` (up to 0.7.19);
  - shared folders: `docs/PHASE7.md`;
  - the Time Machine: `docs/TIMEMACHINE.md`;
  - 0.9: `docs/PHASE8.md`.
- The user's way of working:
  - they shape the architecture themselves when shown the mechanics;
  - they want states that guard data shown where they cannot be missed: a window over
    everything, not a row at the bottom;
  - they want every action to say when it is done;
  - they test on real devices and hosts and report back.
- Menus: our items stay in Obsidian's file menus (the only place on a phone), grouped under a
  label with the plugin's name. No submenus: they are not public API.
- The log: a note or file kept in two versions is logged as an error, as the user asked. Nothing
  failed, but it is what someone has to look at.
- The settings tab is not rebuilt while one of its fields has the focus.
- The roadmap order, a branch per milestone merged when done, and pushing after every commit are
  the user's.
- **The repository is public since 2026-11-18.** The user decided this because the private
  one's Actions minutes were used up, and CI had not run since `2522f02` (0.9.20).
  - Its history was rewritten before that with `git filter-repo` (the user agreed): every
    commit's address is the GitHub noreply one; the host names, subnets, a local path and a
    first name in the docs are placeholders; commit hashes quoted in the docs were mapped to the
    new ones.
  - The old history is in a bundle beside the project folder
    (`mycel-history-before-rewrite-2026-11-18.bundle`).
  - The old Actions runs and the old `latest-build` release still name commits of the old
    history, which GitHub keeps reachable by their hash. The user chose to leave them.
  - Nothing personal goes into the docs: the repository is public.

## Open questions for the user

- **The plugin's folder on the test vault.** The 0.9.27 notice named
  `.obsidian/plugins/obsidian-connect/`, the folder from before the fresh start. The plugin takes
  its folder from Obsidian (`manifest.dir`), so it works there. Was it installed into the old
  folder on purpose? The fresh start's steps delete that folder, because it held the old plugin's
  token and keys.
- **Which read hung the Time Machine's *Abort*** (2026-11-17; fixed in 0.9.21 whatever it was).
  The log the user sent (2026-11-18) covers that day and the next, on a device still on 0.9.20,
  and shows only a normal start, no journal left behind. So the hang happened earlier or on
  another device. The day's file in the plugin folder's `logs/` would say; low priority.
- "Compare versions" on a note (2026-10-12): on which device it appeared, and the date the dialog
  names - then that device's log of the day. Not answered; low priority.

## Known issues / debt

**Open:**
- **The benchmark's remaining findings** (`docs/PERFORMANCE.md`):
  - each subscribe downloads a note's last frame again;
  - eviction and the indexes do O(n) work per change.
  - Read and not reproduced: `DocStore.evict` can let go of a note an editor just bound (its
    re-check misses the pinned and editor-owned tests).
  - Read and not reproduced: a vault index slower than `syncTimeoutMs` at a start says the server
    does not answer.
- **A flake seen once** (2026-11-11, `test:backup`, 1 of 4 runs). "Only the rooms that changed
  are fetched" and "restic diff ... names exactly the notes that changed" failed together. By
  every sign the account's settings changed between the first and the third run; the trusted copy
  still wrote exactly the two notes. Not reproduced; its detail lines were not kept.
- **`test:recovery`'s "carries on in the same note, and what it wrote while away reaches P1"**
  failed in CI on `main` on 2026-11-06 (0.9.7's merge; passed on rerun).
  - Its race in the fork on return was fixed in 0.8.7. If it fails again with `merge (no common
    base, union)` for `Shared/Shared.md` in the log, the base did not move along some other way.
  - In the 2026-11-06 failure that line was missing. P2, back, logged "adopt-local, file 48 chars,
    note 19, base 19" and "carries on as 8bff2dba, 128 B held here", then "merged 1 duplicate(s)"
    twice. P1 kept "from anna\nand more\n" while P2 had its own "and less" text.
  - **Still open** (looked into on 2026-11-08, `fix/ci-races`). The failing log shows:
    - P2 starting from a vault index without P1's fork ("vault index arrived: 1 notes, 0
      deleted");
    - its scan waiting the full 4 s (`syncTimeoutMs`) on the old note's revoked room before
      "adopt-local";
    - the end of the share carried out twice ("another device forked it already" at +0 and
      +140 ms), so the first `carryOn` finished without moving anything;
    - the second duplicate merge waiting 4 s too.
  - So the old note's entry was live again at the path of the new one on some device. A
    duplicate merge keeps the sorted-first id, which may be the old, revoked one. What revives
    the tombstone was not found; `VaultIndex.rename` revives one (`live()`) and is a candidate.
  - The test now holds P1's index frames back until P2 has started, the order of the failing
    log. It passes with that alone (twice locally), so another timing is needed as well.
- **Seen only in CI, never locally: `test:backup` "the starting point (#1) does not fit the log
  (epoch from #2, head #1)"** (0.9.2, 0.9.3, three times for 0.9.6/0.9.7).
  - The case: a note created, and its folder shared without history a moment later. The server
    moved the note's epoch while counting a frame still being written (`epochSince` 2), and later
    its head is 1. The device's `lastSeq` is 1 too and nothing of it is unacknowledged, so the
    share failed with "try again" five times over.
  - Since 0.9.7 a starting point has to hold every frame of an earlier epoch on the disk, and
    every one counted when the epoch moved that did land (`min(epochSince, head)`). A server that
    finds its epoch beginning after its head says so in its log ("its epoch began after").
  - Why a counted frame does not land is not found. Server-side logs (`debug/start-race`) caught
    no failing run. Passing runs show the creation frame written under the old epoch while the
    note joined its folder, and sent again under the new one after the `rekey`.
  - No failure since 0.9.7's change. `RoomLog.appendAll` counts a frame in `pending` only once
    the push passed the epoch check, and always takes it off again, written or failed. A counted
    frame that never landed therefore means either a write that failed - which logs "a frame
    could not be written" - or a `headOf` taken from another `RoomLog` than the one the frame
    went to. Neither was seen.
- **Two notes created under one path in a folder at once**, on devices that knew different folder
  epochs, get two ids and stay as `X.md` and `X 2.md`. Nothing is lost. PHASE7 planned a merge of
  such duplicates; it is not built.
- **Under another device's lock, what is written anywhere in the vault waits**, not only in what
  the lock covers: the server knows rooms, not paths. Letting the rest through would need the
  lock to name its rooms - a note's own, a folder's notes and the index. Not asked for.
- **A rollback's notes whose text comes from a backup** are restored without the text at the
  lock. What was written into them after the lock is overwritten there; it stays in the history
  and in the rollback's copy.
- **The Time Machine's ticks of a folder or the vault** go by the server's minutes for edits
  (rounded down, by its clock) and by the authors' clocks for the rest.
  - So an edit made in the minute a note moved into a folder can make a tick of that folder.
  - A tick whose edits left every text as it was is still one.
  - The overview compares texts as a moment's contents are filled in.
- **A folder's past shows a note that moved out of it since twice**: there, as it was, and where
  it is now. Outside the folder nothing is touched.
- **Plugins that stamp a note on every `modify`**, such as *Update time on Edit*. Since 0.8.13 a
  file another device's change wrote carries that change's time. That leaves only an editor open
  on two devices at a minute's edge, which Obsidian saves with its own time. Setting that plugin's
  minimum minutes between saves to 5 closes even that.
- **Shared notes are still compared with their files once a minute**
  (`SharedFiles.scheduleAll`), which opens each. Beyond `maxLoadedDocuments` shared notes, they
  go in and out of memory.
- ***Replace all keys* (0.9.6) has limits:**
  - A contact's device learns of it from the server (`contact-replaced`). A server that keeps
    quiet lets them go on sealing to the keys before, until they exchange a new friend code.
  - A member who replaced their own keys and was not confirmed again yet gets this account's
    rewritten keys sealed to the key pinned for them - the one before.
  - A member who is no contact stops the replacement until taken out.
  - Files of this account's named in someone else's shared note's list stay under the key before,
    until this account's device next lists them.
  - Forks kept for someone whose share ended before the replacement are signed with the signing
    key before.
  - The plugin's own progress shows in a notice; a vault of thousands of notes has not been
    measured.

**About the environment:**
- **The development machine is short of memory** (often 1.6 GB free of 15.6 GB).
  - A `test:backup` run takes four to ten minutes, and twice died at its start (restic, then Node
    out of memory).
  - On 2026-11-24 a `test:timemachine` run died the same way and ran through when started
    again.
  - Rerun before suspecting the code.
- **The Docker images are still private**, although the repository is public: a package keeps
  its own visibility. An anonymous pull is refused (checked on 2026-11-25). Pulling needs
  `docker login ghcr.io` with a token that may read packages, unless the user makes them public
  in the package settings.
- **What can only be verified on a device** is listed in CLAUDE.md, Testing.

## Verification state

restic on the development machine: `%USERPROFILE%\tools\restic\restic_0.19.1_windows_amd64.exe`.
It is the official release, checksum checked, put there with the user's consent on 2026-10-15.
`test:backup` needs `MYCEL_RESTIC="$HOME/tools/restic/restic_0.19.1_windows_amd64.exe"`.
rclone runs only in the image (CI).

**CI runs every suite on every push** - the end-to-end ones (`test:socket`, `test:vault`,
`test:folders`) against a server of its own - and builds and starts both images. It publishes
them, and the `latest-build` release, from `main` only.

At 0.9.27 (2026-11-24):
- Locally: `typecheck`, `build`, `test:merge`, `test:load` and `test:timemachine` pass. The new
  checks were seen failing with the old `PastFiles.ts`.
- CI is green on the branch (`de10d32`) and on `main` (`a238828`), and both images are published.
- `latest-build` is "Development build 0.9.27 (a238828)".

At 0.9.26 (2026-11-21): CI green on the branch and on `main` (`ea2d364`).

The last full local run listed here was at 0.8.16 (2026-11-02, on `feat/time-machine-4`). All
passed:
- `typecheck` and `build`;
- `test:merge` 174, `test:load` 17, `test:rooms` 401, `test:sync` 31, `test:recovery` 72,
  `test:account` 52, `test:rollback` 78, `test:timemachine` 89, `test:backup` 231;
- on a scratch server started fresh from 0.8.16: `test:socket` 19, `test:vault` 243,
  `test:folders` 121.

Earlier versions: what ran for each is in `docs/CHANGELOG.md` and in this file's git history.
How to run the end-to-end suites without touching the user's server is in CLAUDE.md, Gotchas.
`test:socket` and `test:vault` default to 1234, so always pass `ws://localhost:1235`.

---

## Log

### 2026-11-27
- 0.9.32 tried on the PC: dragging looks very good; two cosmetic findings, and three around a
  rollback and a restore there (the window without a backup server, a restore's mark beside the
  same version, undo not saying it goes through the Time Machine). The user asked for these and
  for *Overwrite the server with this vault* before the second audit - "von meiner Seite für v1.0
  ready". Built on `fix/cosmetics` as 0.9.33, not yet versioned. The window of a device meeting the
  vault was explained to them again: tried with merging after a disconnect, the rest left to
  `test:join` unless it comes up. Then the second audit was started: a fresh agent, a worktree of
  its own, finding and reproducing, fixing nothing.
- The user tried 0.9.31's range of lines: it works with Shift, but is unintuitive and hard to
  follow. Their idea, agreed: lines dragged as cards on a board - each on its own or several
  selected, anywhere in the middle, between lines already there too; *Take* stays. Settled with
  them: a click on a number only selects now (taking a single line is dragging it); lines both
  have stay fixed in the middle, things go between them (striking one out offered, not asked
  for). Built as 0.9.32: the middle a list of lines, lines put between lines both have opening a
  place of their own; pointer events, the numbers and handles taking no scrolling. Looked at in a
  headless Edge driven over the DevTools protocol (the Chrome extension was not connected).
- 0.9.30 seemed to work well on a device. The user's findings after it, built as 0.9.31: a note
  one side only added to should be marked and listed like any merged without a base - the code
  meant it to be, but a note open in an editor while its device joined, shorter there, was not
  (the editor's binding lacked the review; the user's own case could not be checked, the PC being
  off). And "Compare versions" could not put two blocks written in the same place one under the
  other: the lines both have (`---`, empty lines) cut them into passages. Proposed and agreed: a
  range of lines, from one number to another Shift-clicked, or with *Range of lines* on a phone,
  joining what it touches into one passage. Rejected: git's rule of joining passages separated by
  lines without letters or digits - each block's closing `---` would still stand once, after both.

### 2026-11-26
- 0.9.28 confirmed on the PC: fast again, and the stuck read-only folder of the Time Machine
  resolved by itself.
- The user's findings and wishes after it, decided together and built as 0.9.29: "synced 2/16"
  misread; the vault's id and its deletion in one row; conflict markers (removed, conflicts go
  into "Compare versions" as merges without a base do); notes to compare only on the device where
  they met (now on every device, named by the device); the Time Machine for such notes (a hint, not
  a lock); marks for important events in the Time Machine; a reset for testing a first connection
  again without a new account. Checking whether two Obsidian vaults on one computer get in each
  other's way found that they would, for the same vault of the server: one claims it now.
- The reset of 0.9.29 failed on the device: it waited and said `mycel-history/…` was still open,
  since the local history never closed its database. The user decided against a reset that keeps the
  device signed in: signed in should mean syncing, the switch is the pause, and a vault should be
  separable without a trace. Built as 0.9.30: *Disconnect this vault*, signing out and clearing
  everything of the sync on the device, the safety copies kept only when asked, the settings as
  new but for the server's address. The server knows no devices, so there is nothing to remove
  there. 0.9.29 is on `main` and `latest-build`; the read-only attribute is off the PC's test vault.

### 2026-11-25
- The docs were brought to the phase: this file's head, "Where we are", "Still to try on
  devices", the roadmap, known issues and the log; CLAUDE.md's pointer to 0.9.
- The user's PC (not the laptop, same versions): the plugin took a minute to start, half of the
  settings missing meanwhile; opening, aborting and restoring in the Time Machine took a minute
  each, with a second window beside its own. Found together, over ssh on the PC (allowed only
  inside the test vault): Google Drive for desktop synced that vault and made every folder in it
  read-only after ~7 s, Windows refuses to remove such a folder, and 0.9.27 waited for removing
  the copies' folder at all three places. 0.9.27's diagnosis (Windows holding the copies a
  moment) was wrong. The user took the vault out of Google Drive. Fixed as 0.9.28, with the lock
  the Time Machine took for another device's, seen in the same log.

### 2026-11-24
- The user: "Compare versions" of 0.9.26 is much better, and a merge went well.
- A rollback from the Time Machine on Windows did nothing. Removing the plugin folder's copies
  failed with EPERM after every file was back, and that failed the way out. Fixed as 0.9.27 -
  taken for Windows holding the copies a moment; it was a read-only folder (0.9.28).

### 2026-11-21
- 0.9.24: deleting a vault on the server, the user's decisions of the day.
- 0.9.25: the CLI takes the vault's id alone, the user's question after trying 0.9.24.
- 0.9.26: both versions line beside line in "Compare versions", and the setup guide's live
  comparison, the user's design.

### 2026-11-18
- The repository made public, its history rewritten first ("Decisions made").
- 0.9.23: "Compare versions" as git's merge tools, the user's design.

### 2026-11-17
- 0.9.21: the Time Machine's *Abort* hanging, found by the user.
- 0.9.22: the joining window's overview and the explorer's marks, the user's wishes.
- The canvas merge moved after 1.0.0.

### 2026-11-13
- The user's design of the joining choice, built as 0.9.19.
- The fresh start. Its first device found the copy before connecting refused by the gate:
  0.9.20.

### 2026-11-08 to 12
- 0.9.10: three CI races.
- 0.9.11: links in shared notes by who typed them, the user's decisions.
- 0.9.12: a shared folder's move.
- 0.9.13: every backup kept after a suspicious run.
- 0.9.14 and 0.9.15: the benchmark's first findings.
- 0.9.16 to 0.9.18: the code review's proposals.

### 2026-11-03 to 07
- 0.9 designed with the user (`docs/PHASE8.md`) and built: 0.9.0 to 0.9.7.
- The security audit by a separate agent (0.9.8, `docs/AUDIT.md`) and its residual risks closed
  (0.9.9), with the setup wizard.
- 0.8.17: the notification center's title.

### 2026-11-02
- The user tried 0.8.15 and drew the rollbacks' tab. Built as 0.8.16 on `feat/time-machine-4`,
  with what else they found. The lock that ended while a device was away was a real bug - the
  device sent nothing until a restart -, checked by putting it back.

### 2026-11-01
- The user's further try of the Time Machine: X1 to X4 were proposed and decided as recommended.
  Built as 0.8.15 on `feat/time-machine-3`:
  - a restore under the lock;
  - the editors read-only everywhere (Obsidian's own read-only came first);
  - the explorer guarded;
  - the timeline on the left;
  - rollbacks as moments;
  - notices with a button;
  - backups with nothing changed done at once.

### 2026-10-31
- The user's first try of the 0.8.13 Time Machine: the bar's buttons hidden under the window's
  own, two tooltips on the timeline. 0.8.14 fixes both.

### 2026-10-30
- The user decided V1 to V6 and W1 to W3 of the Time Machine's second round and asked for all of
  it at once. Built as 0.8.13 on `feat/time-machine-2`:
  - the vault lock (server and plugin);
  - the past in the files, with its journal and copies;
  - the timeline, the bar, the overview, a note's marks;
  - backups before;
  - the notification center;
  - synced files' times.
- New suite `test:timemachine`.

### 2026-10-29
- The user tested the Time Machine (0.8.11): it works. 0.8.12 fixes what they found; both new
  checks were seen failing with the old behaviour put back. Their larger wishes were proposed as
  U1 to U5 in `docs/TIMEMACHINE.md`, for them to decide.

### 2026-10-24 to 27
- 0.8.9 (the user's first test of 0.8), 0.8.10 (linked notes on moving in), the Time Machine
  designed with the user (T1 to T8) and built as 0.8.11.

### 2026-10-23
- The six small fixes of PHASE7, each with its test and a version (0.8.2 to 0.8.6, 0.8.8), and
  the race in the fork on return that `test:recovery` showed again (0.8.7).
  - Three of them were checked by putting the bug back (1, 3, 5).
  - The 2FA reconnect was measured first (a second, the backoff), its new checks failing before
    the fix.
- `test:backup` follows shared folders over time (13 checks, all passed at once).
- 0.8.1 built on `feat/folder-files`: files in shared folders, and the share dialog's options for
  files and notes outside the folder. The new checks found three races of 0.8.0, fixed: windows
  while sharing, a delete undone by another device of the account, a file fetched twice.
- 0.8.0 built on `feat/folder-share`:
  - server: folder rooms, access, API, ties;
  - plugin: keys, folder document, mirror, moves, deletes, revoking, ending, UI;
  - backup server: keys for folder notes.
  - Two bugs found and fixed on the way (CLAUDE.md invariants 28, 29). New suite
    `test:folders`.

### 2026-10-22
- 0.8 designed with the user. How sharing a note works was laid out, with options per case, and
  the user chose:
  - a folder room of its own;
  - a window before an existing note joins;
  - deletes in the folder for everyone, with a notice;
  - files inside the folder belong to it, and linked ones outside travel as a note's.
- `docs/PHASE7.md` written and signed off, with the small fixes investigated and specified in it.

### 2026-10-21
- 0.7.18 merged: a time of day, waiting while someone writes, rclone, the password shown. Also
  two bugs from the user's test: the guard let a loss over two runs through, and the relay had no
  ping behind the proxy.
- 0.7.19:
  - the schedule's day buttons and hour and minute dropdowns, as the user chose;
  - a held decrypted copy asked about in a window over everything, letting it follow waited for
    to the end;
  - the trash does not count for the guard.
  - Merged; the user confirmed it and considers 0.7 done.

### 2026-10-20
- 0.7.17 on the Pi; backups by hand work. Asked about rclone, the copyable password, backups
  while someone writes, the guard on runs by hand; built 0.7.18.

### 2026-10-18
- The backup server's 403 was the user's network - Docker's DNS, the DNAT on `eth0` only, the
  `PI5-FWD` drop of answers from the subnet. Fixed without a new image.
- First real test. Decided together: one backup task per vault, paths picked by the backup
  server, one backup server per vault - 0.7.17.
- 0.7.12 to 0.7.16: diagnostics of the backup server, its data folder, the images handing their
  folders over.

### 2026-10-17
- 0.7.6 to 0.7.9 (invitations and pairings, settings in tabs, rolling back from the history and
  from restic), merged. 0.7.10 "Use this server"; 0.7.11 the backup server's `status`.

### Before
- 2026-10-15/16: 0.7 designed with the user (`docs/PHASE6.md`) and built as 0.7.0 to 0.7.5.
- 2026-10-12 to 14: 0.6 (signing out, recovery code, 2FA) and 0.6.4 to 0.6.8; `feat/accounts`
  merged into `main`.
- 2026-10-10/11: 0.5 (attachments).
- Older: `docs/CHANGELOG.md`.
