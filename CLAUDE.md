# Obsidian Connect

Obsidian plugin plus a small self-hosted server. Two features, one mechanism:

1. **Vault sync** across the owner's own devices. This is the primary purpose.
2. **Live collaboration** on single notes shared with other people. Secondary.

Both run on Yjs CRDTs. Every markdown note is CRDT-backed permanently — there is
no per-note on/off switch, because leaving CRDT territory is what makes merging
impossible and destroys data.

```
packages/
  shared/   protocol constants, types, text diff and three-way merge
  server/   Fastify + own room layer + append-only history + JWT
  plugin/   the Obsidian plugin
```

## Non-negotiable invariants

Violating any of these has already caused data loss once. Treat them as rules,
not preferences.

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
5. **Document ids are derived, never random.** `stableDocId(vaultId, path)`.
   Random ids let two devices mint different ids for the same file and sync past
   each other — the bug that looked exactly like "sync is broken".
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
    and then seeded the room with a second copy of the note.
11. **Map a Yjs delta onto CodeMirror in pre-change coordinates**
    (`deltaToChanges`): advance over retained and deleted text, not over
    inserted text. Getting this wrong shifts every later part of a multi-part
    change, keeps the length right and so goes unnoticed while editor and
    document drift apart.

## Architecture

### Identity

- A note is a **document id**, not a path. `stableDocId` = SHA-256 of
  `vaultId::path`, first 128 bits, hex.
- The **vault index** (`idx:<vaultId>`, a Y.Doc holding a `Y.Map` of
  `docId -> { path, updatedAt, deletedAt? }`) maps ids to paths per vault. A
  rename updates the entry; the id and its history survive.
- Deletes are tombstones, so an offline peer learns a note is gone instead of
  re-creating it from its own copy.
- Note rooms are `doc:<docId>` and are global, not vault-scoped. That is what
  makes sharing possible later without new machinery: two vaults can hold the
  same docId under different paths.

### Transport

One WebSocket per vault (`/vault/<vaultId>`), multiplexed — a socket per note
does not survive a real vault. Frames are
`[varUint type][varString room][varUint8Array payload]`; see `MUX` in
`shared/protocol.ts`. The legacy single-room endpoint (`/<room>`) speaks plain
`y-websocket` and exists for the relay self-test.

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

### Editor

One ViewPlugin (`editor/binding.ts`), installed through
`registerEditorExtension`, so Obsidian itself carries it into every Markdown
editor and across file switches and mode changes. It identifies its note through
`editorInfoField` and gets the `Y.Text` from `EditorSync`, which settles the note
first and claims the file for Obsidian as the only writer. Edits typed before
the binding started are merged in (`resolveEditorEdits`, with backups), remote
changes stay out of the undo history, and Obsidian reloading a file this device
wrote just before is recognised and not taken as an edit (`recentWrite`).

### History

Per room: `snapshot.bin` plus an append-only `log.bin` of raw Yjs updates
(`[8B BE timestamp][4B BE length][update]`). Replaying to a timestamp
reconstructs the note as it was then. A Y.Doc alone cannot do this — with GC on,
deleted content is unrecoverable from the document.

**Restore edits the live document** (`textEdits` + `applyTextEdits`) rather than
replacing it, so the rollback travels the normal sync path to every client and
is itself recorded as a version. A restore can be undone.

`prune(retentionDays)` folds frames older than the cutoff into the snapshot and
keeps newer ones. No content is lost; only the granularity of old states.
Default 30 days, `OBSIDIAN_CONNECT_HISTORY_DAYS`.

**The snapshot holds only what `prune` folded out of the log.** Replaying starts
from it, so a snapshot of the current state — written on idle close until
2026-09-22 — made every older version read as the latest and every restore a
no-op.

## Testing

Nothing that touches Obsidian's API can be tested headlessly. Everything else is
covered, and all of it must stay green.

```bash
npm run test:merge     # merge/reconcile/identity/share links — no server, no DOM
npm run test:load      # the built bundle imports, onload/start/unload run, Obsidian stubbed
npm run test:rooms     # server history across idle close and restart, in-process
npm run start:server   # needed for the ones below
npm run ws-test        # legacy relay
npm run test:socket    # multiplexed transport
npm run test:history   # versions, replay, rollback
npm run test:sync      # the editor binding in real CodeMirror, jsdom
npm run test:vault     # two devices + a collaborator: DocStore, EditorSync, binding
```

`test:vault` runs the real sync layer against `scripts/stubs/fake-vault.ts`: an
in-memory vault and a Markdown view that save the way Obsidian does (text taken
first, written a moment later, periodically while typing) and reload wholesale
when something else writes the file. That model is what makes the doubling bug
reproducible; a fake that saves instantly passes with the bug in place. `obsidian`
is replaced through `paths` in `scripts/tsconfig.json`.

**Still only verifiable on a device:** `editorInfoField` and the real timing of
Obsidian's saves and reloads, IndexedDB, the modals, and the protocol handler.

## Gotchas

- **Node 22+ required.** jsdom 30 does not support Node 20, and Node 20 is EOL.
  CI builds on 24, which is also the development baseline.
- **`y-websocket` falls back to a global `WebSocket`**, which Node only has from
  v22. The self-tests pass `WebSocketPolyfill` explicitly.
- **Never add the editor extension with `StateEffect.appendConfig`.** Obsidian
  drops such extensions whenever it rebuilds the EditorState (file switch inside
  a leaf, edit/preview toggle), and re-attaching from workspace events while it
  was still laying out crashed CodeMirror and opened fallback panes. Use
  `registerEditorExtension`. The binding still compares the note on every update
  and lets go when it changes — otherwise a file switch pushes the next note's
  text into the shared room.
- **`main.js` is CommonJS inside a `"type": "module"` package.** Obsidian
  evaluates it itself; Node needs a `.cjs` copy (see `load-selftest.mjs`).
- **Never put raw control characters in source.** A NUL sentinel in the glob
  matcher survived two rewrites unnoticed.
- **Never test on port 1234 and never delete `packages/server/data/`.** That is
  the user's server and the user's history. Assuming otherwise has, three times,
  meant killing their server, wiping its data while it ran, and writing test
  rooms into it — and because `npm run start:server` then fails with
  `EADDRINUSE` while the tests happily keep going, it looks like everything
  passed.

  Always use a separate port and a scratch data directory:

  ```bash
  PORT=1235 OBSIDIAN_CONNECT_DATA_DIR="$TMPDIR/oc-test-data" npm run start:server
  npm run test:socket -- ws://localhost:1235
  ```

  Check the server log for `EADDRINUSE` before trusting a green run, and stop
  it afterwards with PowerShell — `pkill` from Git Bash does not kill Windows
  processes:

  ```powershell
  Get-NetTCPConnection -LocalPort 1235 -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
  ```

## Planned — Phase 2

Decided with the user, not yet implemented.

### Accounts

- **`vaultId` must become derived, not random:** `username + vault name`. One
  vault per name per user, so a new device pairs by signing in instead of
  copying a UUID. Today it is a generated UUID the user copies by hand.

### Settings: account-wide vs device-local

Some settings must be identical on every device of an account, others must not.
Syncing all of them would be wrong.

- **Account-wide** (belongs in a settings document next to the vault index):
  history retention, backup retention, exclude globs, conflict markers.
- **Device-local** (must stay in `data.json`): the access token, and anything
  that legitimately differs per machine — `maxLoadedDocuments` (lower on
  mobile), `writeDebounceMs`, and the server URL, which may differ between a
  LAN address and a VPN one.

History retention in particular *has* to be account-wide: pruning is
client-driven, so a device with a shorter setting silently prunes for all the
others.

### Retention on a shared document

Same failure mode across accounts, and the answer is a rule, not a negotiation:
**the owner's retention governs the shared log, and only the owner's client may
instruct compaction.** Without that, whichever participant has the shortest
retention destroys history for everyone, silently.

A participant who wants more can keep more: every client fetches and holds the
frames locally anyway, so a longer *local* archive is always possible. What a
participant cannot do is change how long the shared log lives.

### Sharing

**Interim, built 2026-09-22 until accounts exist:** a share link
(`obsidian://connect-share?id=<docId>&title=…`, `shareLink`/`parseShareLink`).
"Share this note live" sets `shared` on the note's index entry and copies the
link; "Open a shared note" or clicking the link adds the docId to the
recipient's own index under the share folder, and the normal pull creates the
file. Presence is exchanged exactly for index entries with `shared`. There is no
access control — anyone with the link and the server can edit, as with every
room in dev mode — and "Stop sharing" only turns presence off; it cannot revoke.

The target design: granting account B access to `doc:<docId>` plus an entry in
B's vault index.

**Sharing is per document and lives in the UI, not in the settings.** The flow
is: open a note, "Share this note", pick a person the server knows, done. There
must be no global "collaboration on/off" switch — that was built once and was
wrong. Presence (cursors, selections) follows from a document being shared: the
`shared` flag on the index entry is the seam, and `DocHandle` only registers
awareness with the socket while it is set (`setShared` switches it live). Syncing
your own devices never broadcasts a caret.

Agreed rules:

- A dedicated share folder is only a **default landing spot**, never the source
  of truth. Moving a note out must not unshare it; the link lives in the index.
- **Detaching re-keys the document.** B's copy gets a new docId in B's own
  namespace, otherwise B's personal sync keeps writing into the shared room.
  The history is copied along with it.
- **Deleting is asymmetric.** A participant deleting = leaving the share. Only
  the owner deletes the document.
- **Revoke needs its own protocol message,** not a connection error, or a client
  that was offline retries forever and looks broken.
- **No remote delete.** Explicitly rejected: no security benefit (participants
  already hold the content) and unbounded downside (destroying text the other
  person wrote after the share). A notice when the share is created states that
  copies remain.

### Encryption (approved design)

End-to-end, server sees ciphertext only.

```
password + salt -> Argon2id -> master key   (never leaves the device)
master key                  -> wraps the account private key and the vault key
private key                 -> receives document keys wrapped for this account
document key                -> symmetric, one per document, per epoch
```

- Derive a **separate auth verifier** for the server; the wrapping key must never
  be sent.
- Documents are **not** encrypted with the password-derived key directly, so a
  password change only re-wraps the master key instead of the whole vault.
- **Key epochs.** There is no "document" next to the log — the current state *is*
  the result of applying every update. A snapshot is only a compaction artifact.
  So:
  - One key, never rotated: works, no epochs, no snapshot. But anyone who ever
    held the key can read future updates too if they can reach the frames, which
    makes access control purely server-enforced — exactly what E2E is meant to
    avoid.
  - **Rotating on revoke** is therefore the real reason epochs exist.
  - **Rotating on share** additionally hides the prior history from the new
    participant. It requires handing them a **snapshot re-encrypted under the
    new epoch key**: the newer frames are deltas against a base they cannot
    read, so without it they get a broken document, not a shorter history.
  - The owner keeps every epoch key and therefore always sees the full history.
  - Sharing every epoch instead (full history, with a notice) needs no snapshot
    at all: hand over both keys and nothing special happens.

  **This is a per-share choice, not a global default.** The share dialog asks
  whether to include the history:
  - *with history* — hand over every epoch key. No rotation, no snapshot.
  - *without history* — rotate to a new epoch, hand over only the new key plus
    a snapshot re-encrypted under it.

  Two consequences worth surfacing in the dialog: "without history" only hides
  what came before, not what the participant sees from then on; and producing
  the snapshot needs the owner's client to have the document loaded, so an
  owner who is offline cannot create that kind of share.
- Later: recovery codes, strength estimation instead of composition rules, 2FA.

**What E2E costs, concretely:** the server can no longer maintain a `Y.Doc`, so
the state-vector sync in `RoomManager` goes away and the server becomes an
ordered encrypted log with fanout; clients fetch "everything after sequence N"
and merge locally (correct, because Yjs updates are commutative and idempotent).
Server-side `restore`, `/history/:room/text`, the `chars` field and `prune` all
need plaintext and must move to the client — **the server must never drop a frame
until a client has supplied a snapshot that supersedes it.** Metadata (which
docIds, which accounts, update sizes and timing) stays visible.

## Conventions

- Commit messages, comments and identifiers in English; the user writes German.
- Conventional Commits, `Co-Authored-By` trailer — see the `git-flow` skill.
- Never push without being asked.
- Comments explain *why*, never narrate *what*.
