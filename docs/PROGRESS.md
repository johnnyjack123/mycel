# Progress

_Last updated: 2026-10-21 · **Milestone 0.7 (the backup server) is done: 0.7.0 to 0.7.19 built, merged into `main` (`13c12b3`, CI green, images published), and confirmed by the user on their devices and hosts. Next: milestone 0.8 - first its design document `docs/PHASE7.md`, written with the user.**_

## Where we are

Monorepo (`npm` workspaces): `packages/shared`, `packages/server`, `packages/plugin`,
`packages/backup`. **Read `CLAUDE.md` first** - 27 invariants, each from a real bug,
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
  Manager with TLS (`wss://sync.example.org`). Its access list
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

**Milestone 0.8: sharing a folder, and the small fixes.** Nothing of it is designed
yet. CLAUDE.md asks for the design document first, with the user (`docs/PHASE7.md`),
and the user shapes the architecture: explain the mechanics concretely, then refine
what they choose rather than replace it.

1. Read how one note is shared today: `share/Sharing.ts` (share, revoke, fork on the
   end of a share - invariant 20), `share/LinkedNotes.ts` (sharing what a note links
   to, which is the nearest thing to a folder), `share/SharedFiles.ts`, the index
   entries (`shared`, `owner`, `role`), the server's rooms and members
   (`server/src/rooms.ts`, `server/src/http.ts`), and `docs/PHASE2.md`.
2. Lay out for the user what "a folder, including what is added to it later" asks
   for, concretely: who decides that a new note belongs to the share (the owner's
   device, when it lands in the folder), how the other side learns of it, what
   happens on a move into or out of the folder, a rename of the folder, a note
   inside that is shared on its own as well, deleting, revoking one person, the
   recipient's own notes put into the shared folder, attachments inside it.
3. Write `docs/PHASE7.md` with the decisions, then the small fixes listed under
   Roadmap below, then build on `feat/<name>` from `main`, as 0.8.0 onwards.

## Roadmap

Ordered by the user on 2026-10-14 (the table is in CLAUDE.md, Conventions).

- **0.8 - sharing a folder, and the small fixes.** Besides the folder, every fix that
  has to be in before 0.9:
  - Typing into an open note while sync itself restarts (signing out and in, the
    plugin reloaded) can lose the keystrokes of that moment (see Known issues).
  - Content uploaded but never named in the index (a crash between the two) is never
    cleaned up from the server.
  - Local copies of a purged note stay in IndexedDB on the devices that did not purge
    it.
  - To investigate: after a device turns 2FA on, its own socket took seconds to
    connect again in `test:account`.
  - Left from 0.7: a device's relay connection is not closed when the account's
    devices are signed out (it reaches only backup servers whose pairing it has);
    planning a rollback reads one log per note, since the server keeps no last-change
    time per room.
- **0.9 - hardening and a security audit.** Durable writes on the sync server (asked
  for by the user, 2026-10-18): `fsync` the log before the ack and the atomic writes
  before their rename - a power cut on a Pi's SD card otherwise loses acknowledged
  frames -, and a lock so the admin CLI and the server never write `accounts.json`
  at once. Frames signed per author (`docs/PHASE3.md`). Every note live without all
  of them in memory (CLAUDE.md, "Not built yet"). A name and plugin id without
  "Obsidian" (the community directory refuses it; plugin folder, `data.json` and the
  `localStorage` keys move with the id, so it needs a migration). A review of the
  cryptography and the server's API, including that signing out does not replace the
  account secret (`docs/PHASE5.md`). For the community directory besides: a public
  repository, a `LICENSE`, a release tagged `x.y.z`, the README saying a server and an
  account are needed - whether to publish at all is the user's decision.
- **1.0.0** - all of the above done and verified on devices.
- **Later:** syncing plugins and their settings (direction in CLAUDE.md); the
  operator's backup of the data directory, ciphertext only (moved out of 0.7 by the
  user on 2026-10-15).

## In flight / half-finished

Nothing. Only `main` exists: every earlier branch was merged and, checked to hold
no commit `main` lacks, deleted with the user's consent on 2026-10-21.

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

- "Compare versions" on a note (2026-10-12): on which device it appeared, and the date
  the dialog names - then that device's log of the day. Not answered; low priority.
- Whether the user's loss through the guard on 2026-10-20 was two runs in a row
  (`docker compose logs obsidian-connect-backup | grep "backup of"` around 20:46).
  Not needed any more: both possible causes are fixed in 0.7.18.

## Known issues / debt

- **Only on a device** (untestable headless): menus, modals, the settings tab, the
  status bar marks, the header lock, `requestUrl` with binary bodies on mobile, binary
  file events, `file-open` fetching, memory with large files on a phone.
- Typing into an open note while sync itself restarts can lose the keystrokes of that
  moment (0.8): the new store settles the note by writing its file, and Obsidian
  reloads the editor. `EditorSync.rebinding` keeps the file Obsidian's only while the
  same store binds again; a new store has to settle against the server first.
- Content uploaded but never named in the index is never cleaned up (0.8).
- Local copies of a purged note stay in IndexedDB on the other devices (0.8).
- Notes beyond `maxLoadedDocuments` (500) get no live updates until opened or the next
  start (0.9). Raising the setting is the workaround: about 6 to 32 KB per loaded note
  of 3000 characters, plus an IndexedDB database and a subscription each.
- Signing out does not replace the account secret; frames are authenticated by the
  note's key, not signed per author (both 0.9).
- The plugin id contains "obsidian", which the community directory refuses (0.9).
- `test:recovery`'s check "carries on in the same note, and what it wrote while away
  reaches P1" failed once on 2026-10-16 and passed since. If it fails again, look at
  "deleted on another device, moved to the trash here" just before - perhaps a race
  in the fork on return (0.8).
- The development machine is short of memory (often 1.6 GB free of 15.6 GB): a
  `test:backup` run takes four to ten minutes, and twice died at its start (restic,
  then Node out of memory); rerun before suspecting the code.
- The Docker images are private like the repository: pulling needs `docker login
  ghcr.io` with a token that may read packages.

## Verification state

restic on the development machine: `%USERPROFILE%\tools\restic\restic_0.19.1_windows_amd64.exe`
(the official release, checksum checked, put there with the user's consent on
2026-10-15). `test:backup` needs
`OBSIDIAN_CONNECT_RESTIC="$HOME/tools/restic/restic_0.19.1_windows_amd64.exe"`.
rclone runs only in the image (CI).

At 0.7.19, run 2026-10-21 on `feat/schedule-days` before its commit: `typecheck` and
`build` pass; `test:merge` 164, `test:load` 14, `test:rooms` 286, `test:sync` 26,
`test:recovery` 64, `test:account` 50, `test:rollback` 52, `test:backup` 212, and
against a scratch server on 1235 `test:socket` 19 and `test:vault` 230 - all pass. CI
green on the branch and on `main` after the merge (`13c12b3`): the tests, the `docker`
job (server image) and `docker-backup` (the image with restic, rclone, ssh, its three
bind-mounted folders taken over, an invitation answered at a real sync server); both
images published as `latest`. The user installed 0.7.19 and confirmed it on
2026-10-21.

Earlier versions: what ran for each is in `docs/CHANGELOG.md` and in this file's git
history. How to run the end-to-end suites without touching the user's server:
CLAUDE.md, Gotchas - `test:socket` and `test:vault` default to 1234, so always pass
`ws://localhost:1235`.

---

## Log

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
