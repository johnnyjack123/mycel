# Phase 3 — accounts without names, contacts, surviving the server

Agreed with the user between 2026-09-24 and 2026-09-26; the specification the
implementation follows. Order of work: surviving the server, accounts without names,
contacts, ending a share, trash. Sections marked *(built)* are done.

The rule behind all of it: the server is assumed compromisable. Nothing it stores or
sees may reveal names, content, or credentials, and nothing it does may destroy text
on a device.

## Surviving a server that lost or rolled back data (built)

- **Deleting ciphertext cannot delete notes.** A deletion is itself an encrypted
  update, which the server cannot produce. Frames that are missing are never read as
  deletions: a device only ever applies what it receives and keeps its own state.
- **Detection (built):** comparing seq numbers is not enough — a restored server's log
  grows past a device's position again, and the device would skip frames whose seq it
  thinks it has. Every cursor keeps the fingerprint of the frame it ends at, and every
  subscribe asks for that frame once more; missing or different means another log.
  The room is caught up from zero, merged into the local state, and held.
- **Following (built):** a device follows a recorded decision if it was made after the
  device last saw those notes in a log it recognised (`syncedAt`); otherwise it asks.
- **Index and settings keep the union (built):** structure is never rolled back. Only
  note contents are, with a backup; a note the restored server does not know is seeded
  again from its file, so nothing that exists on a device disappears.
- **Never automatic.** The user chooses, once per vault:
  - *this device is right*: re-upload its state and its local history;
  - *the server is right*: back up this device's newer text first, then adopt the
    server's state (the only way to deliberately roll a server back).

  The decision is recorded in the account settings document, so every other device of
  the account follows it without asking again. Until it is made, the affected notes
  are not synced — nothing is uploaded and nothing overwritten.
- **Every device keeps the history it received, decrypted** — the Yjs updates with
  their seq, time and epoch — within the history retention: for re-upload after a
  loss, for the history view, and for forking a share. Not encrypted on purpose (the
  user's decision): the vault files are plaintext on disk anyway, and a device that
  lost its credentials can still recover every version. Re-uploading means
  encrypting again, which is rare. Stored in Obsidian's local storage next to the
  note, not in the vault.
- The decision is written into an encrypted frame like everything else, so a
  compromised server cannot fake "the user chose the server" to trigger a rollback.
- **To verify and fix:** a note someone emptied on purpose must not be re-seeded by a
  device that had agreed on its text before. `reconcile` returns `seed` for any empty
  document. But "has no base" is the wrong test: a device that lost its local store,
  against a server that lost everything, has a base and an empty document too — and
  must keep its file. The right test is whether the document has *ever* carried
  anything (its state vector): empty text with history was emptied on purpose, and
  with a base the file follows, backed up; a document without any history is seeded.

## Accounts without names (built)

- `salt = H("obsidian-connect" ‖ serverId ‖ username)`. `serverId` is 128 random
  bits the server draws on its very first start and keeps in its data directory —
  derived from nothing, so it moves with the data when the server moves. Public via
  `/auth/config`, and pinned by the plugin on first
  contact — a changed id is a warning, not a silent re-salt. The salt is not secret;
  it only keeps one precomputed table from attacking every account or every server.
  Two people with the same name share a salt on the same server; with the password
  rule that costs nothing.
- `stretched = Argon2id(password, salt)`, 64 MiB, t = 4, p = 1 (128 MiB if a phone
  stays under about 2 s). The parameters carry a version per account and are upgraded
  after a successful login.
- From `stretched`: a **login key** — the server stores only its hash and finds the
  account by it — and the **master key**, never sent. Names are therefore not unique.
  Identical name *and* password are refused at registration; that tells the person
  nothing they would not learn by signing in with them.
- The master key wraps the private key, a random **account secret** (stable across
  password changes), the vault keys, and the vault names.
- `vaultId = HMAC(accountSecret, vaultName)`; vault names are stored encrypted.
- `accountId`: random, 128 bits, shown in the plugin settings for debugging. Tokens
  carry the account id, never a name.
- Admin CLI: `invite` (a code, no name), `user list` (ids, status, created, number of
  vaults), `user remove <accountId>`.
- Passwords: at least 12 characters and at least 10¹² estimated guesses (zxcvbn),
  checked in the plugin only — a client that skips it only harms itself. A generator
  suggests 20 random letters and digits without look-alikes (0/O, 1/l/I), in groups
  of five joined by dashes that are part of the password — about 117 bits, and
  typeable on a phone.
- Sign-in and registration answer after exactly one second, whatever happened, so
  timing reveals nothing. Repeated failures block an IP for a while. There is no
  per-account throttle, by design: a wrong password is a different login key, so the
  server cannot tell which account is being tried — and nobody can lock someone out.
- No names in logs.

## Storage on the server

```
data/
  server.json                   the server's id - part of every salt, never to be lost
  accounts.json                 keyed by account id, plus the login-key hash index
  contacts.json                 contact pairs, open friend codes (hashed), inboxes
  users/<accountId>/<vaultId>/
    index/                      vault index room
    settings/                   account settings room
    notes/<docId>/              meta.json, log.bin, snap-*.bin
  users/<accountId>/forks/      what the account could read of shares that ended
```

A note lives in its owner's folder. A recipient's index only references it; the
recipient's own copy exists only after a fork.

## Contacts (built)

`share/Contacts.ts`, `server/src/contacts.ts`. The server keeps codes (only the hash
of the redeem key), pairs and an inbox per account in `contacts.json`. The code is 28
bytes - 16 of secret, 12 of fingerprint - in Crockford base32, groups of five.

- A **one-time friend code**, valid 7 days: code id, a random secret, the creator's
  account id, and the fingerprint of the creator's public key. It travels outside the
  server (mail, chat).
- From the secret: a **redeem key**, sent to the server, which stores and compares only
  its hash; and a **MAC key**, which never leaves a device.
- B redeems A's code: sends the code id and the redeem key, plus — sealed to A's key —
  B's name, account id and public key, authenticated with a MAC under the MAC key.
  B checks A's key against the fingerprint in the code.
- A's device checks the MAC, remembers the code as used (a second redemption is
  refused even if the server let it through), pins B's key, and answers with A's name
  sealed to B, also MAC'd. No prompt on A's side: A handed out the code.
- Contacts live in the account settings document, on every device of the account, and
  can be renamed locally. Sharing is only possible with contacts; the server enforces
  it too. Removing a contact ends every share between the two, each keeping a copy.

## Ending a share (built)

- Revoking, the owner deleting their account, and a participant leaving but keeping
  the note all end the same way: the participant's device **forks** — a new note in
  its own vault (its folder on the server), at the same path, with the history it
  could read re-encrypted under its own key, and its unsent edits.
- The server keeps the part of the log the participant could read until one of their
  devices has forked: without a limit while the owner's account exists, 90 days after
  the owner deleted it. The 90 days bound only this pickup; a fork keeps its history.
- With every device keeping its frames, a fork mostly works from the local copy.
- As built: the kept part lives in the **participant's** folder
  (`users/<account>/forks/<docId>.json` and `.log.json`), not the owner's, so the
  owner's folder goes the moment their account does. The record stays as a tombstone
  once the history is picked up or has expired: a later subscribe to the old room is
  answered with `revoked`, never with a missing room the device would wait for or
  claim.
- The first device that forks decides the new note (`POST /forks/:docId/done`); the
  old index entry's tombstone names it (`forkedTo`), and every other device of the
  account merges what it holds into it as Yjs state — same changes, so nothing
  doubles.
- `user remove` marks the account as removed; the server's sweep ends its shares,
  its memberships and its contacts and deletes its folder. Only marked accounts are
  ever deleted.

## Known limit, for later

Frames are authenticated by the note's key (AES-GCM), not signed per author. Everyone
who can read a shared note holds that key, so a *read-only* member could produce a
valid edit — today only the server refusing their pushes stops it. A compromised
server together with a read-only member could therefore inject edits. The fix is a
signature per frame with the author's key, checked by every device against the
members and roles the owner signed.

## Trash (built)

- A deleted note stays restorable for the history retention. Then the owner's device
  asks the server to delete its room; refused while it is shared or a fork is pending.
- Deleting an account ends every share as above (built, see *Ending a share*).
- As built: "a fork is pending" does not hold a purge up any more - what the
  participant could read was copied into their folder when the share ended, so the
  room is not needed for it. Still shared means refused (409), and the device asks
  again next time. A purged note's tombstone gets `purgedAt`, so no device offers it
  for restoring. A retention of 0 keeps deleted notes forever. Restoring puts a note
  back at its path, or next to the note that took it (`Name (restored).md`).
- Left for later: other devices keep their local IndexedDB copy of a purged note;
  only the device that purged it clears its own.
