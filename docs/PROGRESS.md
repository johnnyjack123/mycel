# Progress

_Last updated: 2026-09-23 · **Phase 2 built: accounts, end-to-end encryption, sharing with a person (read or write), revoke.** Headless tests only so far — next: on-device run._

## Where we are

Monorepo (`npm` workspaces): `packages/shared`, `packages/server`, `packages/plugin`.
Architecture and invariants live in **`CLAUDE.md`** — read that first. The Phase 2 design
is in `docs/PHASE2.md`, running the server in `docs/SERVER.md`.

Branch `feat/accounts` (Phase 2), pushed, on top of `fix/vault-sync` (the sync rebuild
and the fixes from the first device run). The user tests it on the laptop before a PR
to `main`; merging to `main` is what builds and publishes the Docker image.

## Next step

**Phase 3, in progress** — specified in `docs/PHASE3.md`, built in its order:
surviving the server, accounts without names, contacts, ending a share, trash. Each
step lands as its own commits on `feat/accounts`; everything is pushed at the end.

Still open from Phase 2, for when the user tests on devices:

1. **On-device run of Phase 2.** Start fresh: the server from `docker compose`, a new
   data volume, and on every device the plugin's old state is obsolete (old vault ids,
   old document ids, plaintext). Sign in on each device with the same account and
   vault name.
2. Check on device what the tests cannot: `requestUrl` against the real server,
   Argon2 speed on mobile, `localStorage` surviving a restart, the settings tab, the
   share / access / incoming dialogs, a read-only editor, and presence on a shared note.
3. The fixes of 2026-09-23 still need their device check: delete a note on one device
   while it is open on the other; create several new notes in a row; open a new note
   in a tab that showed another one; type exactly at someone's caret.

## Built on 2026-09-23: Phase 2

- **Accounts.** `obsidian-connect user add|invite|list|remove` in the container;
  `OBSIDIAN_CONNECT_REGISTRATION=open|invite`. Password → Argon2id → an auth key for
  the server and a master key that never leaves the device.
- **End-to-end encryption.** The server is an ordered log of ciphertext frames per
  room with fanout; no `Y.Doc`, no plaintext. Document ids are HMACs under the vault
  key. Key epochs per note; the owner derives all of them, others get them sealed.
- **Vault ids derived** from account and vault name: a new device pairs by signing in.
- **Sharing with a person**, read or write, with or without history; revoke (a
  protocol message plus a new epoch, the other person keeps their copy as their own);
  change role; leave by deleting; detach with history.
- **Account-wide settings** in their own encrypted document: exclusions, conflict
  markers, history and backup retention, share folder. The rest stays per device.
- **History on the client**: decrypted and replayed locally; restore travels as an
  edit. Compaction by the owner's device only, after the account's retention.
- **Docker image** and compose file. CI builds it on every push to `main` after the
  tests, smoke-tests it and publishes it to `ghcr.io/johnnyjack123/obsidian-connect-server`
  (amd64, arm64). Never built yet: there is no Docker on the development machine, so
  the first push to `main` is the first build.

## Known issues / debt

- **Attachments are not synced.**
- **Notes beyond `maxLoadedDocuments` (500) stop receiving live updates** until
  opened again or the next restart.
- **No password recovery**, no 2FA, no key fingerprint check between people.
- **No rate limiting** on login.
- Rooms nobody references any more are never deleted from the server.
- **Conflicts keep both versions** — deliberate, but needs manual cleanup.
- The plugin name contains "Obsidian", which the community catalogue forbids.

## Verification state

- `typecheck`, `build:plugin`: pass.
- Against a scratch server on 1235 with open registration: `test:merge` (63),
  `test:load` (9), `test:rooms` (56), `test:sync` (22), `test:socket` (17),
  `test:vault` (91) — all pass, `test:socket` and `test:vault` twice in a row.
- Mutation checks for Phase 2, each bug put back on its own and the matching check
  failing: a reader pushing, anyone reading any note, a revoked member keeping
  access, stale epochs accepted, anyone compacting, compaction under an old epoch,
  a share without history handing over the history, a join snapshot behind the head,
  a wrong login key, a token alone changing the password, a password change leaving
  a vault behind, claiming another account's vault rooms, opening another account's
  vault socket, presence between your own devices, read-only edits being sent, a
  revoked copy staying in the shared room, the client ignoring the history choice or
  a rekey, compaction claiming a frame it did not fold in, the outbox stored late.
- **Not verified at all:** the Docker image (first built by CI on `main`), anything
  on a device.

## Log

### 2026-09-23
- First on-device run: sync and sharing work. Fixed the four bugs it surfaced, each
  reproduced in `test:vault` first: a deleted note respawning from an open editor, a
  new note taking another note's text (reused ids; binding before the buffer loaded),
  remote renames moving the wrong note, carets pushed along by text typed at them.
- Built Phase 2 (accounts, E2E, sharing by person, Docker). Removed the legacy relay,
  server-side history and share links. Testing it found a revocation handled twice
  (as a message and as a notice) that minted a second copy of the note; fixed, with a
  check.

### 2026-09-24
- Creating an account asks for the password twice; signing in and creating an account
  are separate forms.
- The settings ask the server before anyone signs in (reachable, an Obsidian Connect
  server, the same protocol, open or invite-only) and grey out the forms until it fits.
- The server and the CLI read the `.env` in the repository root when run with npm; a
  byte order mark no longer swallows its first line.
- **Fixed: two devices starting at once with the same existing notes doubled every
  note.** Reproduced in `test:vault` first. Seeding is now the same insertion on every
  device; found alongside: a seed that raced an arriving update replaced it.

### 2026-09-22
- Diagnosed why vault sync never worked and live editing escalated; rebuilt the file
  bridge, the editor binding and the socket's sync tracking; added sharing by link;
  fixed server history; added `test:vault` and `test:rooms`.

### 2026-09-20
- Renamed to Obsidian Connect; made document ids deterministic; fixed the index-sync hang;
  removed dead and dangerous history code; added the flat update zip; wrote `CLAUDE.md`.
- Agreed the Phase 2 design: account-derived vault ids, the share/detach/revoke rules, and the
  end-to-end encryption scheme with key epochs.

### 2026-09-19
- Built Phase 1: vault-wide CRDT sync, multiplexed transport, local persistence, file bridge,
  three-way reconcile with backups, vault index, server history with rollback, history and
  backup UI.

### 2026-09-18
- Diagnosed "connected but no sync": the CodeMirror view plugin dispatched from its constructor,
  which CodeMirror answers by silently deactivating the plugin. Fixed and regression-tested.
