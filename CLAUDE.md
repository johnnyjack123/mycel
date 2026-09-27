# Obsidian Connect

Obsidian plugin plus a small self-hosted server. Two features, one mechanism:

1. **Vault sync** across the owner's own devices. This is the primary purpose.
2. **Live collaboration** on single notes shared with other people. Secondary.

Both run on Yjs CRDTs, end-to-end encrypted: the server stores and relays
ciphertext and cannot read a note. Every markdown note is CRDT-backed
permanently — there is no per-note on/off switch, because leaving CRDT territory
is what makes merging impossible and destroys data.

```
packages/
  shared/   protocol, types, text diff and three-way merge; `shared/crypto` for E2E
  server/   Fastify + accounts + an encrypted log per room + JWT + admin CLI
  plugin/   the Obsidian plugin
```

The design of accounts, keys, sharing and the encrypted transport is specified in
**`docs/PHASE2.md`**; running the server in **`docs/SERVER.md`**.

## Non-negotiable invariants

Violating any of these has already caused data loss once, or would expose
someone's notes. Treat them as rules, not preferences.

1. **Never act on a document state the server never sent.** Seeding or merging
   against an unknown state duplicates notes or deletes the other side's work.
   `DocHandle.whenRemoteReady()` returning `false` means *unknown*, not *empty*.
2. **Never delete text without a backup first.** Every branch in
   `DocStore.applyOutcome` that can remove content writes to `BackupStore` first.
3. **Without a base, never delete.** "Missing here" and "added there" are
   indistinguishable without the last agreed text. `Reconciler` falls back to an
   additive union, which can duplicate but cannot destroy.
4. **Conflicts keep both sides.** Duplication is recoverable, deletion often is
   not. `threeWayMerge` never picks a winner.
5. **Document ids are derived, never random — and never reused.** An HMAC of
   `path` and `generation` under the vault key (`deriveDocId`): the same on every
   device of the account, unguessable for anyone else. Random ids let two devices
   mint different ids for the same file and sync past each other — the bug that
   looked exactly like "sync is broken". But the id a path derives usually
   belongs to an earlier note: Obsidian creates every note as "Untitled" and it
   is renamed afterwards, and deleted notes leave tombstones. `ensure` takes the
   first generation the index does not know; taking the known one handed a new
   note the other note's text.
6. **Never dispatch a CodeMirror transaction from a ViewPlugin constructor.**
   CodeMirror catches the exception and silently deactivates the plugin forever,
   so the editor reports success and then ignores every keystroke. Defer with
   `queueMicrotask`.
7. **Only one writer per file, and only one binding per note.** While an
   editor is bound, Obsidian saves that buffer and nothing else writes the file
   — `DocStore.setEditorOwned`. Writing anyway made Obsidian reload the open
   buffer, which the binding read back as a user edit; two devices doing that
   concurrently doubled the text on every round trip. `EditorSync` binds only
   the first editor showing a note: Obsidian mirrors a note between its panes
   itself, and a second binding applies every remote change twice.
8. **While an editor is bound, never reconcile its file against the
   document.** Obsidian takes the text for a save before writing it, so the
   save lags whatever was typed meanwhile. Merging that lagging copy back in
   saw "both sides changed this line" on every save and kept both — the text
   duplicated itself, travelled to the other device and came back. This was the
   escalation that filled a note with `t`s. `reconcileFile` only records
   agreement for an owned note.
9. **A change whose result already equals the document is not an edit.**
   `applyLocalChanges` returns early in that case. Obsidian replaces the whole
   buffer on reload even when the text is identical, and taken literally that
   becomes "delete everything, insert everything". Larger replacements are
   turned into a diff against the document for the same reason.
10. **Bind an editor only to a settled note** — `DocStore.settle`, file and
    document agreed with the server state known. Binding to an empty document
    the server had not sent yet put keystrokes at positions that did not exist
    and then seeded the room with a second copy of the note. And only once the
    buffer holds that note: Obsidian names the new file before it has read it,
    and binding in between took the previous note's text for edits to the new
    one (`contentPending`).
11. **Map a Yjs delta onto CodeMirror in pre-change coordinates**
    (`deltaToChanges`): advance over retained and deleted text, not over
    inserted text. Getting this wrong shifts every later part of a multi-part
    change, keeps the length right and so goes unnoticed while editor and
    document drift apart.
12. **Never sync a file object that has left the vault** (`DocStore.exists`).
    An editor keeps its `TFile` after the note is deleted underneath it;
    syncing it registered the note again and it came back, empty, everywhere.
13. **A rename event looks up the new path first.** Applying another device's
    rename fires one here too, and by then the old path may belong to a new
    note — looking that up first moved the wrong one.
14. **Nothing readable leaves the device.** Frames, snapshots, presence, titles
    and keys are encrypted before they reach the socket or the REST API, and
    every ciphertext is bound to its room and epoch through the associated data
    (`frameAad`, `snapshotAad`, `awarenessAad`). The password never leaves the
    device; the server gets a key derived from it for login only, and the master
    key derived next to it wraps everything else.
15. **A local edit is not stored until it is in the outbox.** `y-indexeddb`
    writes the document at once; the outbox (`RoomCursor.persist(true)`) must
    not lag behind it, or a crash in between leaves an edit that is on the
    device and never sent — and every later edit built on it undecodable
    elsewhere.
16. **An epoch moves before anything is awaited.** Sharing without history and
    revoking bump `meta.epoch` synchronously, so no push under the old key lands
    after the snapshot or the revocation. Pushes under any other epoch are
    answered with `rekey` and re-encrypted by the client.
17. **Only the owner compacts, and the server drops no frame before a snapshot
    supersedes it.** A participant with a shorter retention would otherwise
    shorten everyone's history, silently.
18. **Seeding a note from its file is the same insertion on every device**
    (`sync/seed.ts`: client id from docId and text). Two devices starting at
    once with the same existing notes both saw empty documents and both
    inserted the file under their own client ids — every note came out twice.
    If the same seed was applied and deleted before, Yjs ignores it, so
    `seedDocument` inserts the text itself then; without that a device with an
    old copy emptied its file, with no backup. And whatever arrived while the
    seed waited is kept as a union, never replaced. Seeding depends on whether
    the document *ever* carried anything (`DocHandle.pristine`), not on text or
    base: a note emptied on purpose is empty too.
19. **A seq number alone does not identify a log position.** A server restored
    from a backup numbers new frames from where the backup ended, and a device
    that was away took them for frames it had. Every cursor keeps the
    fingerprint of its last frame, and every subscribe asks for that frame
    again (`afterSeq = lastSeq - 1`); gone or different means the log is
    another one. The room is then caught up from zero, merged, and **held** —
    nothing is sent until the user decided (`Recovery`), because uploading
    would undo a restore made on purpose and taking the server's state would
    drop what the devices wrote since. Index and settings always keep the
    union; only note contents can be rolled back, and only with a backup.
20. **A share that ends is forked, never dropped** — revoked, detached, a
    contact removed, the owner's account removed. The participant's note
    carries on as their own, with the history they could read and what they
    had not sent yet. The server keeps that history for them until one of
    their devices forked, and keeps the record after that as a tombstone, so
    a device returning later hears "ended" instead of finding a missing room
    to wait for or to claim.
21. **The server deletes only accounts marked as removed.** `user remove`
    lists the account under `removed` in `accounts.json`; the sweep clears
    exactly those. An account that is merely missing — a damaged or
    half-restored file — must never take its folder with it.

## Architecture

### Accounts and keys

- **The server knows no names.** An account is a random id; `accounts.json`
  finds it by the hash of a **login key**. Accounts come from an invite code
  (`obsidian-connect invite`, naming nobody) or, with
  `OBSIDIAN_CONNECT_REGISTRATION=open`, from anyone.
- Salt = hash of the server's random id (`server.json`, public, pinned by the
  plugin per address) and the name — derived, never stored or secret. Password
  → Argon2id with parameters pinned in the code (`KDF_VERSIONS`, not taken from
  the server) → HKDF into the login key (sent) and the **master key** (never
  sent). Names are therefore not unique; name *and* password find an account.
- The master key wraps the ECDH P-256 private key and a random **account
  secret**. Vault ids (HMAC of the name), vault names (encrypted) and vault keys
  hang off the account secret, so a password change re-wraps two things.
- Passwords need 12 characters and 10¹² estimated guesses (zxcvbn, checked in
  the plugin only); sign-in answers after a fixed second, and an address that
  keeps failing is blocked (`server/src/throttle.ts`). There is no per-account
  limit, by design: a wrong password is another login key.
- The owner derives every room key from the vault key — index, settings, and
  each note per epoch — so nothing needs storing. People a note is shared with
  receive epoch keys **sealed** to their public key.
- The device keeps the token in `data.json`, the master key, the account bundle
  and sealed keys in Obsidian's per-vault `localStorage`, so it starts offline.

### Identity

- A note is a **document id**, not a path (see invariant 5).
- The **vault index** (`idx:<vaultId>`, a Y.Doc holding a `Y.Map` of
  `docId -> { path, updatedAt, deletedAt?, shared?, owner?, role? }`) maps ids to
  paths per vault. A rename updates the entry; the id and its history survive.
  It is persisted on the device like every note.
- Deletes are tombstones, so an offline peer learns a note is gone instead of
  re-creating it from its own copy.
- Note rooms are `doc:<docId>` and are global: two vaults hold the same docId
  under paths of their own when a note is shared.
- Account-wide settings (exclusions, conflict markers, retentions, share folder)
  live in `set:<vaultId>`; device-local ones in `data.json`.

### Transport

One WebSocket per vault (`/vault/<vaultId>?token=`), multiplexed — a socket per
note does not survive a real vault. The server holds an **ordered log of
ciphertext frames** per room and fans them out; it has no `Y.Doc`. A client
subscribes with the last seq it applied and gets a snapshot if needed, the
frames after it and `caughtUp`; it sends `push(ref, epoch, data)` and keeps the
payload until `ack`. See `MUX` in `shared/protocol.ts` and `VaultSocket`.

### File <-> document

The file on disk is a **projection** of the document, not the source of truth.

Disagreement is detected by comparing the file text against the document text
directly — no "who wrote last" bookkeeping, which also removes the echo problem
(our own write-back reads back identical and is ignored). `StateStore` keeps
`mtime`/`size` per note, plus the **base text**: the last text where file and
document agreed. The base is what lets `Reconciler` tell an addition from a
deletion.

Every file operation on a note runs under a per-document lock in `DocStore`
(scan, vault events, write-back, pull, deletes, editor settling). The index
drives the vault: notes it knows but the vault lacks are **pulled** (created,
folders included); remote renames are applied; a remote delete is applied only
to a file this device agreed on and that is unchanged since — an edit here wins
over a delete there and revives the note. Renames and deletes that happen before
the index arrives are queued and replayed.

A merge without a base (typically two existing vaults meeting for the first
time), a base-less adopt that pulled the other side's lines in, and a merge that
kept conflicts are recorded as a **review** (`sync/Reviews.ts`, device-local in
the plugin folder): "Compare versions" in the note's menu shows the two
versions passage by passage and lets the user keep this device's, the other's
or both. `DocStore.applyReview` backs up, then applies the choice as an edit —
merged three ways into the note if it changed since. Choosing "both"
everywhere is exactly the merge that happened (checked in `test:merge`).

### Around the notes

- **The log** (`src/log.ts`): every `log.*` call also goes to a file per day in
  the plugin folder's `logs/`, a week of them; "Copy the log" puts two days on
  the clipboard. Never note text — paths, ids, sizes, outcomes. `log.debug`
  (every frame, every caret) only with "Detailed logging" on.
- **The cloud** in the status bar is `DocStore.noteState` for the active note,
  polled: `unsent` while anything this device holds is unconfirmed, `waiting`
  while the server's state is unknown, `held` during a recovery.
- **The note's menus** (its "…" menu, the file explorer, the editor's right
  click) carry sharing, access, detaching, history and "Compare versions".

### Editor

One ViewPlugin (`editor/binding.ts`), installed through
`registerEditorExtension`, so Obsidian itself carries it into every Markdown
editor and across file switches and mode changes. It identifies its note through
`editorInfoField` and gets the `Y.Text` from `EditorSync`, which settles the note
first and claims the file for Obsidian as the only writer. Edits typed before
the binding started are merged in (`resolveEditorEdits`, with backups), remote
changes stay out of the undo history, and Obsidian reloading a file this device
wrote just before is recognised and not taken as an edit (`recentWrite`).
Remote carets are anchored the way CodeMirror maps a selection — a caret stays
in front of text inserted exactly at it — so everyone sees a caret where its
owner has it. A caret moving along with text typed *before* it is correct. A
note shared to read only gets a read-only editor. Remote carets are redrawn on
any update once their version moved, not only by the refresh the awareness
change dispatches — typing redraws them anyway, which is why only carets that
merely move showed the difference. Announcing and drawing carets never throw
out of `update` (invariant 6's reason applies to every exception there).

### Sharing

Per note, in the UI: "Share this note…" picks a contact, read or write, with or
without history (`share/Sharing.ts`, `docs/PHASE2.md`). The recipient's plugin
adds the note to its own index under the share folder.

- **Only contacts, and their keys are pinned.** Two accounts become contacts
  when one redeems the other's one-time friend code (`share/Contacts.ts`,
  `server/src/contacts.ts`), which travels outside the server and carries the
  fingerprint of its creator's key. The code yields a redeem key (the server
  keeps its hash) and a MAC key that never leaves a device, so the server can
  pass the sealed names back and forth but not forge them. Keys are taken from
  the contact list, never fetched again from the server when sealing. The
  server refuses a share with anyone else. Removing a contact ends every share
  between the two.
Presence (cursors, selections) follows from a note being shared: the `shared`
flag on the index entry, and `DocHandle` only registers awareness while it is
set. Syncing your own devices never broadcasts a caret. There is no global
"collaboration on/off" switch — that was built once and was wrong.

- A share folder is only a **default landing spot**. Moving a note out keeps it
  shared; the link lives in the index.
- **Revoke is a protocol message** (`revoked`), also answered to a later
  subscribe, and moves the note to a new epoch.
- **Every end of a share is a fork** (invariant 20). The server writes what the
  participant could read — frames, their starting snapshot, their sealed keys —
  into *their* folder (`server/src/forks.ts`), so the owner's folder can go at
  once: without a limit while the owner exists, 90 days after the owner's
  account was removed. The device (`Sharing.endShare`) imports that plus its
  own history (`sync/History.ts`) into a new note of its own at the same path,
  the rest of its local Yjs state last — unsent edits included —, and
  `DocStore.forkInto` hands the file over. The old index entry's tombstone
  names the new note (`forkedTo`); every other device of the account folds
  what it holds of the old note into it as Yjs state. The new note was built
  from the same changes, so that adds only what is missing and duplicates
  nothing. The base text moves along, so a file edited offline merges three
  ways.
- **Removing an account** (`user remove`) only marks it (invariant 21). The
  running server's sweep (`RoomHub.sweep`, on start and every few minutes)
  ends its shares as above, ends its memberships, forgets its contacts and
  deletes its folder.
- **Deleting is asymmetric.** A participant deleting leaves the share. The owner
  deleting removes the note from the owner's vault only.
- **No remote delete.** Participants already hold the content, and destroying
  what they wrote after the share has unbounded downside. The share dialog says
  that copies remain.

### History and retention

On the client, because only the client can read the log: `NoteHistory` decrypts
and replays, ordered by the author's time inside each frame — not the server's
seq or clock, which re-uploaded history would scramble and which the server
could fake. Restore edits the live document, so the rollback travels like any
edit and can itself be undone. Every device also keeps the history it saw,
decrypted, in its own IndexedDB (`sync/History.ts`) — to upload it again after
the server lost it. Retention is account-wide; the owner's
`Compactor` folds frames older than it into a snapshot under the current epoch
and uploads it; the server drops those frames only then, and keeps a member's
join snapshot while it is still their starting point.

The retention is also the **trash** (`sync/Trash.ts`, "Deleted notes…"): a
deleted note of one's own stays restorable for that long, on any device —
restoring revives its index entry and pulls it from its document, next to a
note that took its name meanwhile. After that the owner's device asks the
server to delete the room (`POST /log/:room/purge`), which it refuses while the
note is still shared, and marks the tombstone `purgedAt`. A retention of 0 keeps
everything, deleted notes included. Local copies of a purged note are cleared
only on the device that purged it; the others keep their IndexedDB copy.

## Testing

Nothing that touches Obsidian's API can be tested headlessly. Everything else is
covered, and all of it must stay green.

```bash
npm run test:merge     # merge/reconcile/identity and the crypto — no server, no DOM
npm run test:load      # the built bundle imports, onload/start/unload run, Obsidian stubbed; current and versioned
npm run test:rooms     # accounts, access, epochs, sharing, compaction, restart — in-process
npm run test:sync      # the editor binding in real CodeMirror, jsdom, in-process relay
npm run test:recovery  # a server that lost its data, and one restored from a backup — in-process server
# needs a server that lets tests create accounts:
npm run test:socket    # the encrypted transport, two devices of one account
npm run test:vault     # three devices + a collaborator: accounts, DocStore, binding, sharing
```

The end-to-end tests share their devices through `scripts/harness.mts`.
`test:recovery` starts the server in-process (`startServer` in
`server/src/server.ts`) so it can stop it, take its data away or restore an old
copy, and start it again on the same port.

`test:vault` runs the real sync layer against `scripts/stubs/fake-vault.ts`: an
in-memory vault and a Markdown view that save the way Obsidian does (text taken
first, written a moment later, periodically while typing) and reload wholesale
when something else writes the file. That model is what makes the doubling bug
reproducible; a fake that saves instantly passes with the bug in place. `obsidian`
is replaced through `paths` in `scripts/tsconfig.json`.

**Still only verifiable on a device:** `editorInfoField` and the real timing of
Obsidian's saves and reloads, IndexedDB, `requestUrl`, `localStorage`, the
modals and the settings tab.

## Gotchas

- **Node 22+ required.** jsdom 30 does not support Node 20, and Node 20 is EOL.
  CI builds on 24, which is also the development baseline. Node's own
  `WebSocket` and WebCrypto are what the tests use.
- **TypeScript 5.9 types `Uint8Array` by its buffer.** WebCrypto wants
  `Uint8Array<ArrayBuffer>` (`Bytes` in `shared/crypto`); Yjs and lib0 hand out
  `Uint8Array<ArrayBufferLike>`. Convert with `bytes()`.
- **`shared/crypto` is not in the package index.** The server compiles the
  shared sources without DOM types and never encrypts; import it as
  `@obsidian-connect/shared/crypto`.
- **Never add the editor extension with `StateEffect.appendConfig`.** Obsidian
  drops such extensions whenever it rebuilds the EditorState (file switch inside
  a leaf, edit/preview toggle), and re-attaching from workspace events while it
  was still laying out crashed CodeMirror and opened fallback panes. Use
  `registerEditorExtension`. The binding still compares the note on every update
  and lets go when it changes — otherwise a file switch pushes the next note's
  text into the shared room.
- **There is no Docker on the development machine.** The image is only ever
  built in CI: the `docker` job in `build.yml` runs after the tests, on `main`
  only, starts the image once (health check, `invite` through the CLI) and
  publishes it to `ghcr.io/johnnyjack123/obsidian-connect-server`. A broken
  `Dockerfile` shows up there and nowhere earlier.
- **`main.js` is CommonJS inside a `"type": "module"` package.** Obsidian
  evaluates it itself; Node needs a `.cjs` copy (see `load-selftest.mjs`).
- **Never put raw control characters in source.** A NUL sentinel in the glob
  matcher survived two rewrites unnoticed, and a byte order mark written as its
  `\u` escape in an edit landed as the invisible character itself. Write such characters by code
  (`0xfeff`, `String.fromCharCode`). To look for them, read the files with Node:
  `grep -P` in Git Bash has no UTF-8 locale and fails, which with `2>/dev/null`
  looks exactly like "nothing found".
- **The server reads the `.env` in the repository root** (`loadEnvFile`), for
  npm and the CLI alike; compose reads the same file. Shell variables win, so a
  local `.env` cannot redirect the self-tests. Writing `.env*` is blocked by a
  permission rule — the user creates it.
- **Never test on port 1234 and never delete `packages/server/data/`.** That is
  the user's server and the user's data. Assuming otherwise has, three times,
  meant killing their server, wiping its data while it ran, and writing test
  rooms into it — and because `npm run start:server` then fails with
  `EADDRINUSE` while the tests happily keep going, it looks like everything
  passed. (The user once asked for their test data to be wiped; that was a
  one-off, not a licence.)

  Always use a separate port and a scratch data directory, with registration
  open so the tests can create accounts:

  ```bash
  PORT=1235 OBSIDIAN_CONNECT_REGISTRATION=open OBSIDIAN_CONNECT_DATA_DIR="$TMPDIR/oc-test-data" npm run start:server
  npm run test:vault -- ws://localhost:1235
  ```

  Check the server log for `EADDRINUSE` before trusting a green run, and stop
  it afterwards with PowerShell — `pkill` from Git Bash does not kill Windows
  processes:

  ```powershell
  Get-NetTCPConnection -LocalPort 1235 -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
  ```

## Phase 3

Built: surviving a server that lost or rolled back data, accounts without
names, contacts by one-time friend code, forking a share with its history,
removing accounts, the trash. Specified in **`docs/PHASE3.md`**, which also
names what is known and left for later (signatures per author).

## Not built yet

Recovery codes, 2FA, notes beyond `maxLoadedDocuments` staying live,
attachments (they need an encrypted blob store of their own; today the plugin
ignores every non-Markdown file, it does not break on them).

**Syncing plugins and their settings (wanted, optional).** Not through the
CRDT: a plugin's `data.json` is JSON, not text two people edit, many plugins
rewrite it on every start (ping-pong between devices), a merge of two edits
can be invalid JSON, and some of it is per device (paths, window state, our
own token). Instead snapshots with an explicit source: "take the plugins and
settings of *this* device" uploads them encrypted; another device shows what
differs and applies it on request, after a backup of its own. Per plugin
opt-in, this plugin's own `data.json` never included, plugin code and its
settings only together (a `data.json` for another version can break it). An
edit on two devices before either applied the other's is then a choice
between two snapshots, never a merge.

**Backup API (wanted).** A secured endpoint a backup tool such as restic can
pull snapshots from on a schedule, in two forms:

- *Encrypted:* the data directory as it is — ciphertext only — authenticated with
  a dedicated, revocable backup token rather than an account.
- *Decrypted:* the notes as Markdown. Decryption must happen outside the server,
  or the server would hold the keys: a small command-line client on the backup
  machine signs in with the account's credentials, pulls the ciphertext through
  the API, decrypts locally and writes the files restic then snapshots.

## Conventions

- Commit messages, comments and identifiers in English; the user writes German.
- Conventional Commits, `Co-Authored-By` trailer — see the `git-flow` skill.
- **Push right after every commit** — the user asked for that (2026-09-27);
  it replaces "never push without being asked" for this repository.
- Comments explain *why*, never narrate *what*.
- **Every change the user installs gets a new version**, so the version
  Obsidian shows tells whether a device is current. One version for
  everything: `manifest.json`, `versions.json` (plus its entry), and every
  `package.json` via `npm version <v> --workspaces --include-workspace-root
  --no-git-tag-version`; `test:load` fails when they differ. A fix is a patch
  (`0.4.1`), a milestone below the minor:

  | Version | Milestone |
  |---|---|
  | 0.1 | Phase 1: vault sync (before versions were kept) |
  | 0.2 | Phase 2: accounts, end-to-end encryption, sharing |
  | 0.3 | Phase 3: surviving the server, accounts without names, contacts, forks, trash |
  | 0.4 | the first device run: comparing versions, the log, the note cloud, menus |
  | 0.5 | attachments, in an encrypted blob store |
  | 0.6 | recovery codes and 2FA |
  | 0.7 | syncing plugins and their settings |
  | 0.8 | the backup API |
  | 0.9 | hardening: signatures per author, every note live, a name without "Obsidian" |
  | 1.0.0 | all of the above done and verified on devices |
- **Rebuild after anything that swaps the sources.** A bundle built during a
  `git stash` check held the older settings screen and went to the user as
  the new one; `test:load` now fails when a source is newer than `main.js`.
