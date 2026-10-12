# Progress

_Last updated: 2026-10-12 · **0.5.7 on `feat/accounts`: milestone 0.5 (attachments) built and accepted by the user. Next: milestone 0.6, recovery codes and 2FA - to be designed with the user first.**_

## Where we are

Monorepo (`npm` workspaces): `packages/shared`, `packages/server`, `packages/plugin`.
**Read `CLAUDE.md` first** - invariants (24 of them, each from a real bug), the
architecture, the version roadmap to 1.0.0 and the conventions. Designs:
`docs/PHASE2.md` (keys, sharing), `docs/PHASE3.md` (accounts without names,
contacts, forks, trash, surviving the server), `docs/PHASE4.md` (attachments);
`docs/SERVER.md` for running the server; `docs/CHANGELOG.md` for every version and
how its fixes were verified.

Branch `feat/accounts`, pushed, CI green up to `9c22501` (0.5.7). Not merged to
`main` - merging is what first builds and publishes the Docker image. The user
runs the server with npm on the laptop (port 1234, `packages/server/data` - never
touch either; see CLAUDE.md, Gotchas) and installs the plugin by copying
`main.js`, `manifest.json`, `styles.css`. Server code unchanged since 0.5.4.

Confirmed on the user's devices: sign-in and account creation, note sync, sharing
and live editing, attachments syncing with conflict copies, restoring notes and
files from the trash, the version history with rendered Markdown, linked notes
(2026-10-12). On 2026-10-12 the user said that with 0.5.7's changes (plugin menu
section, cloud for files, read-only mark) milestone 0.5 is done. 0.5.7 itself has
not been seen on a device yet.

## Next step

**Milestone 0.6: recovery codes and 2FA** (version 0.6.0). Nothing is designed
yet. Do it the way 0.5 went: talk it through with the user (AskUserQuestion; the
user writes German, decides product questions themselves and wants to be asked),
write `docs/PHASE5.md`, then build in steps with tests.

1. Read: CLAUDE.md "Accounts and keys"; `docs/PHASE2.md` "Keys", "Accounts";
   `docs/PHASE3.md` "Accounts without names". Code: plugin `src/account/Session.ts`
   (register, login, unlock), `KeyRing.ts`, `api.ts`, `PasswordModal.ts` (the
   password change re-wraps the account secret and private key - a recovery path
   would be a second wrapping of the same two), `settings.ts` (account screens);
   server `src/accounts.ts`, `auth.ts`, `throttle.ts`, `cli.ts`.
2. Questions to settle with the user - none decided:
   - What a recovery code restores: access after a forgotten password (a second
     wrapping of account secret + private key under a key from the code, and a
     second login credential the server checks), then a new password.
   - One code or several single-use ones; shown once at account creation or also
     made later in the settings; what existing accounts get.
   - 2FA: in an end-to-end design it can only guard the server login (the token
     and the wrapped key bundle; the password is still needed to decrypt). TOTP
     (the server holds the secret) or WebAuthn/passkeys (support in Obsidian
     mobile unknown). Do devices already signed in stay signed in? Losing the
     second factor - recovery codes, or the admin CLI by account id?
3. Constraint from invariant 14: the password and anything derived from it that
   unlocks keys never leave the device; the server knows accounts only by id.

## In flight / half-finished

Nothing. Everything is committed and pushed (last: the handoff, `5f1e2a0`).

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
- Later wishes, not designed: sharing a whole folder; plugin and settings sync (0.7,
  snapshots from a chosen device, never through the CRDT - reasons in CLAUDE.md).

## Open questions for the user

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
- No password recovery, no 2FA (0.6 - next).
- Frames authenticated by the note's key, not signed per author (0.9,
  `docs/PHASE3.md`).
- Local copies of a purged note stay in IndexedDB on the devices that did not
  purge it.
- The plugin name contains "Obsidian", which the community catalogue forbids (0.9).
- The Docker image has never been built (CI builds it on `main` only).

## Verification state

At `9c22501` (0.5.7), run 2026-10-12: `typecheck` and `build` pass; `test:merge`
130, `test:load` 12, `test:rooms` 156, `test:sync` 26, `test:recovery` 56 - all
pass (run after the 0.5.7 commit). Against a scratch server on 1235: `test:socket`
19, `test:vault` 224 - all pass (run before the commit, same code). Bug-back checks
per version: `docs/CHANGELOG.md`. Not verified: 0.5.7 on a device, the Docker
image.

How to run the end-to-end suites without touching the user's server: CLAUDE.md,
Gotchas ("Never test on port 1234"). `test:socket` and `test:vault` default to
1234 when no URL is given - always pass `ws://localhost:1235`.

---

## Log

### 2026-10-12
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
