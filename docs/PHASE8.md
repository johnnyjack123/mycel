# Phase 8 - hardening and a security audit (0.9)

Written 2026-11-03 after 0.8.17 as a draft; the user decided the same day (below, "Decided").
0.9 is hardening only (the user, 2026-10-25): no new features, the roadmap's items in
`docs/PROGRESS.md`, "Roadmap":

- **D** - durable writes on the sync server (asked for by the user, 2026-10-18).
- **L** - every note live without all of them in memory.
- **S** - who wrote what and who may hold a key: frames signed per author, and what a
  server could do to a share today.
- **A** - a review of the cryptography and the server's API.
- **N** - a name and plugin id without "Obsidian" (the user's proposal: "Connect").
- **P** - what publishing in the community directory would take; whether to publish at
  all is the user's decision.

Each part says what exists (read from the code, file:line), what is wrong with it, what
is proposed, and what only the user can decide. The questions are gathered at the end.

## D - durable writes on the sync server

### What exists

- A room is a folder (`users/<owner>/<vault>/notes/<docId>/` and the like) with
  `meta.json`, `log.bin` and a `snap-<seq>.bin` per snapshot still needed. A frame in
  `log.bin` is `[8B seq][8B ts][4B epoch][4B length][ciphertext]` (`server/src/log.ts:81-90`).
- A push: `RoomLog.append` assigns the seq, puts the frame into the room's list in
  memory **at once**, and queues `appendFile` (`log.ts:264-275`); `RoomHub.push` awaits
  that and only then sends the `ack` and the frame to the others. All writes of one room
  run through one queue (`log.ts:145-160`).
- Every other file is written as `<name>.tmp`, then renamed (`log.ts:119-123`, forks,
  blobs, `accounts.json`, `contacts.json`).
- **Nothing is ever synced to the disk** - no `fsync` anywhere in the server. An `ack`
  means "the operating system has it", not "the SD card has it". A power cut on the Pi
  can lose acknowledged frames; the device has dropped them from its outbox by then.
- `accounts.json` is written by the server (registering, a password change, every
  backup login, every 2FA attempt, the sweep) and by the admin CLI (`invite`,
  `user remove`, `user 2fa-off`) - two processes, each reading, changing and renaming
  the file, with no lock between them (`server/src/accounts.ts:213-232`).

### What is wrong besides (found reading it, each checked in the code)

1. **A frame torn by a crash is never cut off.** Loading stops reading at it
   (`log.ts:101-103`), but the file keeps it, and the next push is appended behind the
   torn bytes. The load after that reads the torn frame's length across the new one: from
   there on the room's log is garbage.
2. **A compaction can write a frame twice.** It rewrites `log.bin` from the list in
   memory (`log.ts:306-307`), which already holds a frame pushed after the compaction was
   queued but not yet written (`log.ts:266`); that frame's own append then adds it a
   second time. Needs no crash - only a push during a compaction.
3. **A compaction writes the log before its metadata** (`log.ts:307`, then `315`). A crash
   in between leaves a log without the frames the snapshot folded in and metadata that
   names neither the snapshot nor the new start: the frames are gone for every device
   that catches up from before them.
4. **A frame can be read before it is on disk** (`log.ts:265-266`): a device subscribing
   meanwhile receives it. After a crash the same seq carries another frame; that device's
   check (invariant 19) then reports "the server has other data" - safe, but a false alarm.
   And a failed append stays in memory.
5. **The CLI and the server can overwrite each other's `accounts.json`**: an invitation
   made with the CLI while someone signs in with 2FA can vanish; a `user remove` racing a
   backup login can bring the account back, with its `removed` mark gone, so the sweep
   never clears it.
6. `server.json` (the server id every account's salt depends on) is written in place
   (`accounts.ts:250`); a crash while it is written leaves a file that never parses.
7. Shutting down waits for the open rooms' writes only, not for accounts, contacts, forks,
   blobs or the metadata of rooms that are not open (`rooms.ts:1775-1781`).
8. Nothing stops a second server from running on the same data folder.

### Proposed

- **A frame is acknowledged once it is on the disk:** written, `fdatasync`ed, and only
  then in the room's list, acknowledged and sent to the others (fixes 4). Each open room
  keeps its `log.bin` open. One sync per push: the device keeps one push per note in
  flight and merges what is typed meanwhile into the next (`VaultSocket.ts:625-676`), so a
  slower acknowledgement means fewer, larger frames, not a queue.
- **Loading checks the log**: frames must follow seq by seq, with a plausible length;
  at the first one that does not, the file is cut back to the last whole frame, with a
  warning in the log (fixes 1, and garbage a power cut leaves at the end of a file).
- **A compaction rewrites what is on disk only, in the order snapshot, metadata, log**
  (fixes 2, 3: loading drops frames up to `compactedUpTo` already).
- **Every atomic write syncs**: the temporary file before its rename, the folder after
  it (on Linux; Windows cannot sync a folder, the development machine ignores that).
  `server.json` written the same way (6).
- **A lock between the CLI and the server** (5): a lock file in the data folder taken
  for every change of `accounts.json` (and `contacts.json`), created exclusively, given
  up after the write; a lock older than 30 seconds is taken for a crashed holder's. The
  CLI waits for it a few seconds. Writes that change nothing are skipped - today every 2FA
  attempt and every backup login rewrite the whole file.
- **One server per data folder** (8): the running server holds `server.lock`, renewed
  every 30 seconds; a second one refuses to start while it is fresh. By its age, not its
  process id - in a container the id after a restart is the same small number.
- **Shutting down waits for every queue** (7).
- **The vault lock outlives a restart of the server** (only if the user wants it, D1):
  today it lives in memory (`rooms.ts:111`), and a restart ends it - the other devices
  write again while the Time Machine still shows the past. Kept in a file, it would
  last until its lease ran out, unless its holder renews it after reconnecting.

What it costs: an `fdatasync` on an SD card takes a few to some tens of milliseconds;
pushes of different notes still run side by side, those of one note one after another.
Measured on the Pi only - the development machine is no guide.

Tests (`test:recovery` runs the server in-process and can stop it): a torn last frame
and a push after it; a push during a compaction; a crash between compaction steps
(simulated by writing the files as a crash would leave them); the CLI and the server
changing `accounts.json` at once; a second server refused.

## L - every note live

### What exists

- A device keeps at most `maxLoadedDocuments` notes open (500 by default,
  `settings.ts:136`); each holds its document, its IndexedDB database and a subscription.
  The server sends a note's frames **only to connections subscribed to it**
  (`rooms.ts:562-567`), and keeps a subscribed note's whole log in memory.
- Beyond the limit, the least recently used note is let go (`DocStore.ts:564-594`). From
  then on it hears of nothing until something opens it: an editor, a change of its file,
  the index, the next start. The start loads every note once anyway, 8 at a time
  (`DocStore.ts:489-503`), and lets the oldest go as it goes.
- **What a device knows of a note it let go:** its index entry (no seq, no hash) and its
  base text. Its cursor - last seq and the fingerprint of the last frame - lies inside the
  note's own IndexedDB database and is only read by opening it, which loads the document.

### What is wrong besides (each checked in the code)

1. **Letting go does not wait for the server.** A note whose last change is still
   unacknowledged, or one held because the server had other data (invariant 19), can be
   let go (`DocStore.ts:567-575` checks neither). The unsent change is stored, not sent,
   until the note is opened again - and the cloud says *synced*. A held note is no longer
   seen by the recovery window.
2. **Reconnecting catches up only notes not yet agreed in this session**
   (`DocStore.ts:450-459`): a note let go before the connection dropped hears of nothing.
3. A note opened again while it is being let go opens its database a second time before
   the first has written its cursor (`DocStore.ts:589-593`: out of the map before
   `destroy` is awaited).
4. Shared notes are loaded regularly for their files (`SharedFiles.sync`, `share/SharedFiles.ts:231-245`),
   so beyond the limit they already go in and out of memory.

### Proposed: watching without loading

- **A new message, `watch`:** the device names every note room it knows, with the seq
  it last saw. The server answers with the rooms whose log is further on (`changed: room,
  headSeq`), and from then on sends `changed` whenever a frame lands in one of them - no
  content, no keys, nothing it does not send today. It answers only for rooms the account
  may read.
- **The server needs no log in memory for that:** a note's head seq is kept in a small
  table, filled when the room is first asked about (by reading `log.bin`'s headers, as
  `/times` does, `log.ts:207-221`) and moved on with every push.
- **The device then loads the note briefly** the normal way - subscribe with its real
  cursor, catch up, the check of invariant 19, write the file through `reconcileFile`
  (invariants 1, 7, 8, 10 unchanged) - and lets it go again after half a minute without
  changes. At most 8 at once, as the start does. A shared note loaded this way announces
  no presence: nobody sees someone appear who is not there.
- **The seq a device last saw** is kept outside the notes too, in one small store per
  vault, updated whenever a cursor is. It is only a hint for `watch`: wrong, it costs a
  needless load or - never lower than the truth - nothing. The check of invariant 19 still
  runs on the real cursor.
- **Letting go waits** until a note's changes are acknowledged, never lets go a held note,
  and opening one that is being let go waits for that (1, 3). Reconnecting sends `watch`
  again (2).
- The shared notes' regular loads for their files become a load on `changed` (4).
- The limit stays, as a cap on memory alone: every note is live whatever it says.

Tests (`test:vault`): a limit of 2 with 5 notes, every one changed on another device -
all five files follow, at most 2 (+8 briefly) documents open; a note let go with an
unsent change sends it; a reconnect after letting go; a shared note beyond the limit.

**L1 (for the user): a faster start.** Today every start opens every note. With `watch`,
a note whose file is as this device last wrote it and whose log has not moved could be
skipped - for a vault of thousands of notes the start would take seconds instead of
minutes. But a scan that skips relies on the file's time and size, which today only
the attachments do (and there they decide nothing). Proposed: not in 0.9 unless starts
are slow for the user.

## S - who wrote what, and who may hold a key

### What exists

- A frame is encrypted and authenticated with the note's key (AES-GCM, `shared/src/crypto.ts:254-270`),
  bound to its room and epoch (`frameAad`, `shared/src/protocol.ts:253-255`). Inside: the
  author's clock and the Yjs update - no author.
- Everyone who holds a note's key can write a frame every other holder accepts. Only the
  server stops a reader from writing (`rooms.ts:537-568`), and it records nobody as a
  frame's author.
- An account has one key pair, ECDH P-256, for sealing keys to it - no signing key.
  Contacts pin each other's key through the friend code's fingerprint.
- A sealed key says nothing about who sealed it (`crypto.ts:314-346`).
- Own notes are safe from all of this: their keys derive from the vault key, which no
  other account and no server ever holds.

### Found (checked in the code)

1. **A server could get a share's key.** When a note or folder moves to a new epoch -
   sharing without history, revoking, a folder's rotation - the owner's device seals the
   new key to every member **the server lists** (`api.members`, `api.folderState`;
   `share/Sharing.ts:200-222, 287-295`, `share/Folders.ts:1288-1293, 1559-1564`). For a
   member who is not a contact it takes the public key **the server gives**
   (`Sharing.ts:118-123`), with a warning in the log only. A server that lists one more
   member, with a key of its own, receives every later key of that note or folder - and
   reads it. Sharing only ever adds contacts, and removing a contact ends every share
   between the two, so a member who is no contact is one the server made up - or one a
   device does not know yet, because the account's settings with its contacts have not
   arrived (`this.contacts?` in `Sharing.ts:119`).
   **Proposed at once, whatever else is decided:** never seal to a key that is not pinned.
   A rotation waits until the contacts are there; a member they do not know gets nothing,
   and the device says so in a window over everything, not in the log.
2. **A server could forge a shared note for its members** - not read it: it hands a
   member a key of its own, sealed to them, and frames under it. Nothing tells them the
   owner did not seal it.
3. **A reader could write**, given a server that lets them, and **a writer could pose as
   another** - nobody is named in a frame.
4. Within an epoch the server can replay or drop frames; a replayed one changes nothing
   (Yjs), a dropped one is caught by the device that sent it (it keeps it until the ack).

### Proposed

- **S-a, the keys:** every account gets a signing key pair (ECDSA P-256 - it runs in
  every WebCrypto, Obsidian's mobile apps included), kept like the ECDH key. The owner
  signs every key it seals - room, epoch, recipient, the sealed key - and the list of
  members with their roles per epoch. A device takes a key only with the owner's
  signature, checked against the owner's pinned key. Fixes 2, and makes 3 checkable.
  Existing contacts have pinned only the ECDH key; the new signing key reaches them with a
  MAC under the secret their two pinned ECDH keys share (static Diffie-Hellman) - nothing
  to do for the user, no new friend code. New friend codes carry both keys.
- **S-b, the frames:** in shared notes and folders every frame carries its author and a
  signature over room, epoch, the author's clock and the ciphertext; every device drops a
  frame whose author may not write by the owner's signed list (fixes 3). Own notes stay as
  they are - only the account holds their keys. What a signature cannot survive:
  - a compaction folds many authors' frames into the owner's snapshot - the owner signs
    it, and who wrote what before it is gone after the retention, as the frames are;
  - a fork re-encrypts a note's history under a new note's key - the forker signs it,
    it is their note from then on;
  - a device that is right after a server lost data (`keepLocal`) sends others' changes
    again - signed as its own, which in a shared note an owner's device may do.
- Every frame 64 bytes larger, a signature per push and a check per frame received and
  per frame the Time Machine replays (a fraction of a millisecond each).
- **Compatibility:** a device before 0.9 neither signs nor checks. During the change, a
  frame without signature is taken from a device of the same account and from members
  until the owner's devices are all on 0.9 and say so; then never again. Every member of
  every share needs 0.9 then - for the user, their own few people.

**S1 (for the user): how far.** (a) only finding 1 - small, fixes the one way to read; (b)
also S-a - nobody can hand out a key in the owner's name; (c) also S-b - every frame
signed, the roadmap's item. Recommended: (c), in that order, (a) first and on its own.

**S2 (for the user): replacing the account's keys.** Signing the other devices out takes
the server away from a stolen password, not the keys it opened (`docs/PHASE5.md`, known
limit): whoever had the password can still decrypt whatever they get from the server
later. Replacing the keys means a new account secret and vault key, every note and folder
moved to a new epoch under them, the old keys kept (encrypted under the new) so the
history stays readable, and every share sealed anew - an operation of minutes for a large
vault, under the vault lock. Proposed: an explicit button for after a suspected theft,
*Replace all keys*, in 0.9 - or left for later.

## A - the review

Not a feature: reading through what exists with the attacker's eyes, each finding fixed or
written down as accepted, here, with its test. Two such findings are above (S 1, and
D 5). What is gone through:

- **The cryptography:** the key derivations and their labels, Argon2id's parameters,
  random IVs per key (AES-GCM's limit of about 2^32 messages per key: per note and epoch,
  far off), what each AAD binds, sealing, the friend code, the recovery code, 2FA, the
  backup pairing and its sessions.
- **The server's API:** every route and socket message against every kind of caller -
  no token, another account, a member who may only read, a removed member, a backup
  token, a token of another session generation - as a test of its own (`test:access`,
  in-process, a table of route x caller x expected answer), so a new route without a
  check fails it. Ids in paths (`isHexId`), sizes and quotas, the relay.
- **The plugin:** nothing readable in a log or a notice, `innerHTML` nowhere, what lands
  in `data.json` and `localStorage`.
- **Also hardening, from `docs/PROGRESS.md`:** the race in `test:folders` (a delete for
  everyone deciding after a restore from the trash, invariant 29), seen twice on `main`.

## N - the name

### What moves, what stays

- **Moves with the plugin id** - Obsidian keeps a plugin under `.obsidian/plugins/<id>/`:
  `data.json` (the server, the token), the sync state (`state.json`, `base/`), the backups
  of merged notes, the reviews, the rollbacks' copies, the Time Machine's journal and
  copies, `notices.json`, the logs. In Obsidian's own settings: whether it is turned on,
  its hotkeys, its open views.
- **Stays, whatever the name** - it is part of keys, ids or data that exist: the
  `localStorage` keys (`obsidian-connect:master` and the like) and the IndexedDB names
  (`obsidian-connect/<vault>/<note>`), every label of every key derivation (the password's
  salt says `obsidian-connect salt` - changed, nobody could sign in), the tokens' issuer,
  the server's `/health` answer the plugin checks, the backup server's restic host and
  tag (its snapshots are found by them) and the decrypted copy's marker file. None of
  them is ever shown. They keep their spelling for good.
- **"Connect", id `connect`**, is free in the community directory today (9855 plugins,
  checked 2026-11-03). Close by: *Connections*, *Smart Connections*, *Canvas Connect* and
  some twenty *... Connect*/*Connector*.

### Proposed

- The new plugin, at its first start, finds the old folder: while the old plugin is still
  turned on it does nothing but say so in a window (*Turn off Obsidian Connect*); once it
  is off, it copies the old folder's data (not its code) into its own - the Time Machine's
  journal before anything else looks at the files -, starts, and says the old plugin can
  be deleted. Both running at once would share the keys and the databases.
- Hotkeys: listed in a notice to set again (they live in Obsidian's settings, which the
  plugin does not write).
- The server and the backup server: the names the user sees (CLI, images) can follow -
  the new ones and the old ones side by side for a while, the environment variables read
  under both names (otherwise a missing `OBSIDIAN_CONNECT_JWT_SECRET` silently signs
  everyone out and a missing `..._DATA_DIR` starts an empty server).

**N1 (for the user): the name and the id** - "Connect" / `connect`, or something more
distinct (with the twenty others in mind).
**N2 (for the user): the server side too** - its images, CLI and variables renamed with
the old names kept for a while, or left as they are (they are never seen in Obsidian).

## P - publishing

What the community directory asks for (when the user wants it): a public repository, a
`LICENSE`, a GitHub release tagged `x.y.z` with `main.js`, `manifest.json`, `styles.css`, a
README that says a server and an account are needed and what goes over the network, the id
without "obsidian" (N). Its review also looks for private API - the plugin uses some (the
explorer's guard, the editor's internals, turning a plugin off for N's migration) - and for
`innerHTML`.

**P1 (for the user):** publish at all, and when - after 1.0.0, or earlier. **P2:** the
licence - MIT (anyone may do anything, also closed copies of the server) or AGPL-3.0 (a
changed server run for others must publish its changes).

## Order of work (proposed)

1. **S finding 1** (never seal to an unpinned key) - plugin only, small: first, as
   0.9.0, whatever S1 says.
2. **D** - server only, no protocol change.
3. **L** - a protocol addition (`watch`): server first, then the devices.
4. **S-a, S-b** as S1 decides - a protocol change: every device of every member.
5. **A** - the review over everything, with `test:access`.
6. **N** - last, because it moves the plugin's folder; then **P** if the user wants it.

Each step its own branch and version, tested by the user before the next where it
touches a device.

## To decide

- **S1** - signatures: (a) the seal fix only, (b) also signed keys, (c) also signed frames.
  Recommended (c), (a) first.
- **S2** - *Replace all keys* in 0.9, or later. Recommended: in 0.9.
- **D1** - the vault lock kept over a restart of the server. Recommended: yes.
- **L1** - a start that skips unchanged notes. Recommended: not in 0.9.
- **N1** - the name and id. **N2** - the server side renamed too.
- **P1** - publish, and when. **P2** - the licence.
- The order above.

## Decided (the user, 2026-11-03)

- **S finding 1 at once, as 0.9.0** - built: `Sharing.memberKeys` seals only to pinned keys,
  a member who is no contact stops the rotation, `UnknownMembersModal` says so over
  everything and offers to take that member out (one at a time: the server's revocation
  names one account, so with two strangers neither can go - which no removed contact
  explains, and the window says to distrust the server). The route that gave anyone's public
  key by account id is gone.
- **No backward compatibility** ("noch läuft das nicht in Production"): what changes the
  protocol changes it cleanly - the protocol version moves, an older device or server is
  refused - instead of carrying both ways for a while. S-b's compatibility plan is dropped.
- **S1, S2, D1, L1 and the order: as recommended** ("Entscheide du bei S, welche Variante die
  bessere ist") - (c) with (a) first; *Replace all keys* in 0.9; the vault lock over a
  restart; no faster start in 0.9; the order of work above.
- **A, the review, goes to a separate agent with fresh context**, after the rest is built.
- **N:** "Connect" is too common. The user's two favourites from an AI's list, *Seemless* and
  *Mycel*; asked for an opinion before deciding. Given: *Mycel* - unique (no plugin of that
  name among 9873; *Cerebro Mycelium* is a graph animation), the picture fits (a network
  under the ground connecting separate plants), the description in the directory says what
  it does. *Seemless* reads as a misspelling of *seamless*, which is a common adjective (42
  descriptions in the directory, two plugins named *Seamless ...*) and Grubhub's registered
  mark. The rename waits for the user's choice.
- **P:** publishing comes at the very end. **P2: AGPL-3.0** - `LICENSE.md`, every package
  `AGPL-3.0-or-later`. The user asked whether they may still run a closed instance
  themselves: yes, a licence binds those who receive the code, not its author (with code
  others contributed, theirs needs their consent).

## Built

- **0.9.0** - S finding 1 (above).
- **0.9.1** - D as proposed, D1 included (`server/src/durable.ts`, `RoomLog`). Beyond the
  proposal: a frame the old compaction bug wrote twice is read once rather than taken for the
  end of the log, so the user's existing data loses nothing; `contacts.json` takes no lock
  between processes, since the CLI never writes it; a failed write closes the pushing
  connection, so its device sends the frame again; a starting point waits for the device's own
  last change to be acknowledged. Not measured on the Pi yet.
