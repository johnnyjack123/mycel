# Progress

_Last updated: 2026-10-13 · **0.6.4 on `feat/accounts`: milestone 0.6 (recovery codes and 2FA, `docs/PHASE5.md`) built; 0.6.4 fixes conflict markers the user saw on a device nobody typed on (invariant 25) and makes the log easier to read. Next: the user installs 0.6.4 and checks it; then milestone 0.7 (plugins and their settings) is designed with the user.**_

## Where we are

Monorepo (`npm` workspaces): `packages/shared`, `packages/server`, `packages/plugin`.
**Read `CLAUDE.md` first** - invariants (25 of them, each from a real bug), the
architecture, the version roadmap to 1.0.0 and the conventions. Designs:
`docs/PHASE2.md` (keys, sharing), `docs/PHASE3.md` (accounts without names,
contacts, forks, trash, surviving the server), `docs/PHASE4.md` (attachments),
`docs/PHASE5.md` (recovery codes, 2FA);
`docs/SERVER.md` for running the server; `docs/CHANGELOG.md` for every version and
how its fixes were verified.

Branch `feat/accounts`, pushed, CI green up to `354c1c4` (0.6.4). Not merged to
`main` - merging is what first builds and publishes the Docker image. The user
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
(conflicts as errors, errors and warnings first when copied). The user installs 0.6.4
(plugin only; the server is unchanged since 0.6.3) on every device, including any
third one (see the open questions), and tries fast typing again.

Then **milestone 0.7: syncing plugins and their settings** - not designed yet. The
direction the user gave is in CLAUDE.md ("Not built yet"): snapshots from a chosen
device, never through the CRDT, per plugin opt-in. Design it with the user first
(AskUserQuestion; the user writes German and decides product questions), write
`docs/PHASE6.md`, then build in steps with tests.

## In flight / half-finished

Nothing. Everything is committed and pushed.

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
- Later wishes, not designed: sharing a whole folder; plugin and settings sync (0.7,
  snapshots from a chosen device, never through the CRDT - reasons in CLAUDE.md).

## Open questions for the user

0. **The conflict markers of 2026-10-13: which device merged?** The device that
   typed (detailed logging, `ws://localhost:1234`) received the conflict as frames
   #248 (121 B) and #249 (224 B) at 20:03:22.66 from another client, which sent
   presence 30 ms before them - consistent with an editor letting go and binding
   again. Neither that log nor the other computer's (INFO only, last line 20:00:16)
   shows a `merge (...)` or `two versions kept` line, which every merge logs. But
   the note had `3 present` - three clients, where the user counted two devices.
   Asked: which third Obsidian (another vault, a phone, the contact the note is
   shared with) was open, and its log. The mechanism is reproduced and fixed either
   way; the log would show what made that editor bind again.
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
  cleaned up from the server.
- Notes beyond `maxLoadedDocuments` (500) stop receiving live updates until opened
  (0.9).
- Signing out takes the server from a device, not the keys it unwrapped: the account
  secret is never replaced (`docs/PHASE5.md`, "Known limit").
- Frames authenticated by the note's key, not signed per author (0.9,
  `docs/PHASE3.md`).
- Local copies of a purged note stay in IndexedDB on the devices that did not
  purge it.
- Typing into an open note while sync itself restarts (signing out and in, the
  plugin reloaded) can still lose the keystrokes of that moment: the new store
  settles the note by writing its file, and Obsidian reloads the editor. 0.6.4 keeps
  the file Obsidian's only while the same store binds the editor again
  (`EditorSync.rebinding`); a new store has to settle against the server first.
- The plugin name contains "Obsidian", which the community catalogue forbids (0.9).
- The Docker image has never been built (CI builds it on `main` only).

## Verification state

At 0.6.4, run 2026-10-13 before its commit: `typecheck` and `build` pass;
`test:merge` 145, `test:load` 12, `test:rooms` 233, `test:sync` 26, `test:recovery`
56, `test:account` 46 - all pass. Against a scratch server on 1235: `test:socket`
19, `test:vault` 230 - all pass (the user's server on 1234 was not running, before
or after). The test scripts' own `tsc` (against the Obsidian stub) shows the same 8
errors in `scripts/` as before. CI green up to 0.6.4. Bug-back checks per version:
`docs/CHANGELOG.md`. Seen on a device by the user: 0.6.2 (recovery and 2FA). Not
verified: 0.6.3's question in the recovery on a device, 0.6.4 on a device, the
Docker image.

How to run the end-to-end suites without touching the user's server: CLAUDE.md,
Gotchas ("Never test on port 1234"). `test:socket` and `test:vault` default to
1234 when no URL is given - always pass `ws://localhost:1235`.

---

## Log

### 2026-10-13
- The user asked whether closing the recovery's 2FA question spends the code: no,
  the code is spent only by `/auth/recover/commit`, which closing never sends.
- 0.6.4: the user saw nested conflict markers after typing fast with a second device
  online. Reproduced (an editor binding again while someone types elsewhere), fixed
  (invariant 25), together with keystrokes lost during the typing device's own
  rebind; the log restructured as asked.

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
