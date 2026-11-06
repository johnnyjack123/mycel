# Phase 2 — accounts, sharing with people, end-to-end encryption

Decided with the user on 2026-09-23:

- Accounts are created on the server with `docker exec … mycel user add <name>`.
  `.env` decides whether people may also register themselves
  (`MYCEL_REGISTRATION=open`) or only redeem an invite (`invite`, default).
- End-to-end encryption ships together with accounts.
- A share grants **read** or **write**.

This document is the specification the implementation follows. `CLAUDE.md` keeps the
invariants; this keeps the design.

## Keys

```
password + salt ── Argon2id ──► stretched (64 B)
stretched ── HKDF "auth"   ──► authKey    sent to the server, which stores HMAC(salt, authKey)
stretched ── HKDF "master" ──► masterKey  never leaves the device
masterKey ── AES-GCM wrap ──► private key (ECDH P-256), every vault key
vaultKey  ── HKDF "idx"    ──► key of the vault index room
vaultKey  ── HKDF "set"    ──► key of the account settings room
vaultKey  ── HKDF "doc:<docId>:<epoch>" ──► key of one note, per epoch
vaultKey  ── HMAC "doc::<path>::<generation>" ──► the note's docId
```

- The owner can derive every epoch key of every note, so "the owner keeps every epoch
  key" needs no storage. Rotating is incrementing the epoch.
- Participants receive epoch keys **sealed** to their public key: ephemeral ECDH P-256,
  HKDF, AES-GCM, with the room and epoch as associated data. The server stores the
  sealed blobs and hands each account its own.
- docIds are an HMAC under the vault key: deterministic across the owner's devices, and
  unguessable for everyone else — nobody can claim a room before its owner, and the
  server cannot recover paths from ids.
- Argon2id parameters are stored with the account (default m = 19 MiB, t = 2, p = 1).

## Accounts

- `vaultId = sha256("vault::" + username + "::" + vaultName)`, first 128 bits. One vault
  per name per user; a new device pairs by signing in and naming the same vault.
- Server stores per account: status (`pending` with an invite hash, or `active`), KDF
  salt and parameters, the auth verifier, public key, the private key wrapped under the
  master key, and each vault's key wrapped under the master key.
- `prelogin` answers unknown names with a deterministic fake salt, so it does not reveal
  which accounts exist.
- The device keeps the access token in `data.json` and the master key in Obsidian's
  per-vault `localStorage` (not in the vault). It caches the account bundle there too,
  so a device starts offline.
- Tokens last `MYCEL_TOKEN_TTL` (default 30 days) and are refreshed on start.
- Password change re-wraps the private key and the vault keys; documents are untouched.

## Transport: an encrypted log

The server cannot read documents, so it no longer holds a `Y.Doc`. Every room is an
ordered log of opaque frames.

- A frame is `(seq, ts, epoch, ciphertext)`. `seq` is assigned by the server, `ts` is
  the server's clock. The plaintext is the author's clock (8 bytes, float64 big-endian)
  followed by the Yjs update (`packFrame`).
- Ciphertext is AES-256-GCM, `iv ++ ct`, associated data `room + "#" + epoch`, so the
  server cannot move a frame into another room or epoch.
- Client → server: `subscribe(room, afterSeq)`, `unsubscribe`, `push(ref, epoch, data)`,
  `awareness(epoch, data)`.
- Server → client: `snapshot(uptoSeq, epoch, data)` when needed, then `frame`s, then
  `caughtUp(headSeq, epoch)`; afterwards live `frame`s, `ack(ref, seq)`,
  `awareness`, `rekey(epoch)` (a push used an old epoch, or the epoch moved),
  `revoked`, `denied`, and per-account `notify(kind, json)`.
- The client keeps per room: `lastSeq`, the current epoch, and an outbox — local updates
  not yet acknowledged, in two slots (`sending`, `outbox`), persisted with the document.
  Yjs updates are idempotent, so resending after a lost ack only costs log space.
- Outgoing updates are batched for 40 ms.

## Rooms and access

- `idx:<vaultId>` and `set:<vaultId>` belong to the account owning the vault, and only
  travel over that vault's own connection, which only its account may open. Vault ids
  can be computed by anyone, so without that check someone could claim a vault's rooms
  before its owner.
- `doc:<docId>` belongs to the account that first subscribed to it. Members have a role
  (`read` | `write`) and `fromSeq`: the first frame they may read (0 = with history).
- The server enforces: only the owner and members subscribe; only the owner and `write`
  members push; pushes must use the current epoch; only the owner compacts.

## Sharing

- **With history:** the owner seals every epoch key `0..current` for the recipient.
- **Without history:** the owner moves to `current + 1`, seals the new key for every
  member and the recipient, and uploads a snapshot of the note encrypted under it, taken
  at the server's head (`uptoSeq` must equal `headSeq`, or the server refuses and the
  client retries). The recipient's `fromSeq` is `uptoSeq + 1`.
- The recipient's plugin adds the note to its own index under the share folder and
  marks it `owner`, `role`, `shared`. The title travels sealed. With a single vault
  the share is accepted automatically; otherwise it is offered.
- **Revoke:** the server drops the member, remembers the revocation and tells them
  (`revoked`, also answered to any later `subscribe`). The owner moves to a new epoch
  sealed for the remaining members. The revoked device keeps its copy: the note is
  re-keyed into its own vault.
- **Leave:** a participant deleting the note leaves the share.
- **Detach:** a participant turns the note into their own — new docId, the readable
  history copied along.
- **No remote delete.** The owner deleting the note removes it from the owner's vault
  only.
- Read-only notes: the editor is not editable, and local file edits are overwritten by
  the document (with a backup).

## History and retention, on the client

- `GET /log/:room` returns what the caller may read: the right snapshot and the frames.
  The history modal decrypts and replays them; restore edits the live document.
- Retention is an account-wide setting. The owner's client compacts: it replays every
  frame up to the cutoff, encrypts that state under the current epoch and uploads it as
  a snapshot; the server then drops those frames. The server never drops a frame before
  a snapshot supersedes it, and keeps a member's join snapshot until one does.
- Snapshot choice for a caller with `fromSeq F` asking after `A`: nothing if
  `A >= max(compactedUpTo, F - 1)`; otherwise the latest snapshot with `uptoSeq >= F - 1`,
  then the frames after it.

## Settings

- Account-wide, in `set:<vaultId>`: exclude globs, conflict markers, history retention,
  backup retention, share folder.
- Device-local, in `data.json`: server URL, username, token, vault name, sync on/off,
  documents kept in memory, write debounce, sync timeout.

## Server

- `.env`: `MYCEL_JWT_SECRET` (required outside development),
  `MYCEL_REGISTRATION` (`invite` | `open`), `PORT`, `HOST`,
  `MYCEL_DATA_DIR`, `MYCEL_TOKEN_TTL`.
- CLI (`mycel` in the image): `user add <name>` prints an invite code,
  `user invite <name>` a new one for an account not claimed yet, `user list`,
  `user remove <name>`.
- Data: `accounts.json`; per room `meta.json`, `log.bin`, `snap-<uptoSeq>.bin`.
- The plaintext relay, server-side history text, restore and prune are gone.

## Not in this step

Recovery codes, 2FA, password strength estimation, key fingerprints to verify a
recipient's public key, rate limiting, deleting rooms nobody references any more.
