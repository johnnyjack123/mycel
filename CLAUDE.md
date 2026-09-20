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
`mtime`/`size` so startup can skip unchanged files without reading them, plus
the **base text** per note: the last text where file and document agreed. The
base is what lets `Reconciler` tell an addition from a deletion.

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

## Testing

Nothing that touches Obsidian's API can be tested headlessly. Everything else is
covered, and all of it must stay green.

```bash
npm run test:merge     # merge/reconcile/identity — no server, no DOM
npm run test:load      # the built bundle imports with Obsidian stubbed
npm run start:server   # needed for the three below
npm run ws-test        # legacy relay
npm run test:socket    # multiplexed transport
npm run test:history   # versions, replay, rollback
npm run test:sync      # the real editor binding in jsdom
```

**Untested, because it only runs inside Obsidian:** `DocStore`, `DocHandle`
(y-indexeddb), the startup scan, vault events, file write-back, and both modals.
Changes there need on-device verification.

## Gotchas

- **Node 22+ required.** jsdom 30 does not support Node 20, and Node 20 is EOL.
  CI builds on 24, which is also the development baseline.
- **`y-websocket` falls back to a global `WebSocket`**, which Node only has from
  v22. The self-tests pass `WebSocketPolyfill` explicitly.
- **Obsidian drops `StateEffect.appendConfig` extensions** whenever it rebuilds
  the EditorState (file switch inside a leaf, edit/preview toggle). The adapter
  re-attaches on `layout-change`, `active-leaf-change` and `file-open`, and the
  binding refuses local edits while the view shows a different note — otherwise
  a file switch pushes the next note's text into the shared room.
- **`main.js` is CommonJS inside a `"type": "module"` package.** Obsidian
  evaluates it itself; Node needs a `.cjs` copy (see `load-selftest.mjs`).
- **Never put raw control characters in source.** A NUL sentinel in the glob
  matcher survived two rewrites unnoticed.

## Planned — Phase 2

Decided with the user, not yet implemented.

### Accounts

- **`vaultId` must become derived, not random:** `username + vault name`. One
  vault per name per user, so a new device pairs by signing in instead of
  copying a UUID. Today it is a generated UUID the user copies by hand.

### Sharing

Granting account B access to `doc:<docId>` plus an entry in B's vault index.
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
- **Key epochs:** a revoke rotates the document key. Handing over only the newest
  epoch also gives "history from the share point onward" — but the recipient then
  needs a **snapshot re-encrypted under the current epoch key**, because the text
  itself was built in earlier epochs. Default is to share all epochs (full
  history) with a notice.
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
