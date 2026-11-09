# Mycel

Obsidian plugin plus a small self-hosted server. Two features, one mechanism:

1. **Vault sync** across the owner's own devices. This is the primary purpose.
2. **Live collaboration** on single notes shared with other people. Secondary.

Both run on Yjs CRDTs, end-to-end encrypted: the server stores and relays
ciphertext and cannot read a note. Every markdown note is CRDT-backed
permanently — there is no per-note on/off switch, because leaving CRDT territory
is what makes merging impossible and destroys data. Every other file of the
vault (images, PDFs, `.canvas`) is an **attachment**: an encrypted, immutable
blob per version, named in the vault index (`docs/PHASE4.md`).

```
packages/
  shared/   protocol, types, text diff and three-way merge; `shared/crypto` for E2E
  server/   Fastify + accounts + an encrypted log per room + JWT + admin CLI
  plugin/   the Obsidian plugin
  backup/   the backup server (0.7): reads a vault with a backup key, decrypts it in memory, hands it to restic
```

The design of accounts, keys, sharing and the encrypted transport is specified in
**`docs/PHASE2.md`**, Phase 3 in **`docs/PHASE3.md`**, attachments (0.5) in
**`docs/PHASE4.md`**, recovery codes and 2FA (0.6) in **`docs/PHASE5.md`**; running
the server in **`docs/SERVER.md`**. Where the work stands and what is next:
**`docs/PROGRESS.md`**; what each version changed and how its fixes were verified:
**`docs/CHANGELOG.md`**. The backup server (0.7) is specified in **`docs/PHASE6.md`**,
running it in **`docs/BACKUP.md`**; sharing a folder and the small fixes of 0.8 in
**`docs/PHASE7.md`**; the Time Machine (0.8.11, the user's decisions T1 to T8; its
second round, 0.8.13, U1 to U5, V1 to V6, W1 to W3) in **`docs/TIMEMACHINE.md`**.
A new milestone gets its design document written with the user before it is built: 0.9's
is **`docs/PHASE8.md`** (decided 2026-11-03; being built, its order in `docs/PROGRESS.md`).
The security audit (0.9.8) and its residual risks closed in 0.9.9 - every finding, its fix,
its check, and what is known and not fixed - is **`docs/AUDIT.md`**.
Licence: AGPL-3.0-or-later (`LICENSE.md`, the user, 2026-11-03).

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
   agreement for an owned note - and for a note an editor shows that no binding
   holds yet (sync restarted under it) it writes nothing at all (`settleShown`):
   the reload that followed dropped what was typed since the last save. The
   binding merges buffer and document as it binds.
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
    that was away took them for frames it had. Every cursor keeps two
    fingerprints of its last frame - its bytes, and what it says (author, time,
    change) for when replacing an account's keys wrote it anew - and every
    subscribe asks for that frame again (`afterSeq = lastSeq - 1`); gone or
    different means the log is another one; other bytes it cannot open yet
    mean nothing (`unreadable`: nothing sent, caught up again). Never compare
    by what it says alone: that needs its key, and a key missing for a moment
    left rooms unconfirmed and unsent (0.9.6) - except that a snapshot reaching up to or past it is
    compaction, which folded the frame in: one ending exactly at the last
    frame (a note untouched for longer than the retention) was once taken for
    another server, and every old note was held and asked about. So is a
    start snapshot made anew under another epoch at the place this device
    stood on: sharing again without history asked a member who had left
    whether the server lost data. The room is then caught up from zero, merged, and **held** —
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
22. **Another device's rename is applied with `vault.rename`, never
    `fileManager.renameFile`.** The latter rewrites the links in other notes,
    which the renaming device has already done and sent along with those
    notes. When both rewrote before seeing each other's edit, every link came
    out twice (`[[RenamedRenamed]]`, reproduced in `test:vault`). Applying the
    rename plainly also keeps the renaming user's choice about links.
23. **An attachment entry names only content the server has confirmed, and a
    file is replaced or trashed only once the server holds its own content.**
    Upload, then write the entry; before overwriting or trashing a file, ask
    whether the server has its blob and upload it if not. The blob is the
    backup — invariant 2 for files. And check right before writing that the
    file still holds what was read (`stillHolds`): a canvas saving while the
    other version downloaded was overwritten and lost. mtime and size only
    ever let a scan skip work; they decide nothing, and a base records the
    stat the file had *when read* — recording the later one made a canvas
    saved during its upload look sent, and its card names never left.
24. **Take another device's version of a file only if it knew yours.** An
    attachment entry is replaced whole, so of two devices writing at once one
    write simply vanishes from the index, and its device would take the other
    version for news and overwrite its own file. Every entry names what it
    replaced (`prev`), every replacement leaves a version record, and
    `AttachmentIndex.replaced` decides: a version that never saw this device's
    content is a conflict, and both files are kept. The same for a delete.
25. **A text the document already held is an older copy, never an edit.**
    Obsidian saves a bound editor whenever it likes, so its file lags the
    document, and an editor that let go lags it too. When an editor bound again
    while someone typed on another device, both were merged in as edits made
    here, against an older base - conflict markers on a device nobody typed on.
    `DocStore.heldBefore` knows every text a note with an editor had, and a
    binding starts again from what it and the document said when it let go
    (`released`). Meanwhile the file stays Obsidian's (`EditorSync.rebinding`):
    writing it made Obsidian reload the editor and drop what was typed in between.
26. **Nothing of the plugin outlives its unload, or a stop.** A start waits for
    the server and the disk; a plugin turned off and on again meanwhile kept the
    old start going, and it built a second, unseen copy of the plugin - its own
    connection, no editor, a closed log - that took the live copy's editor saves
    for edits and merged them with conflict markers. Every stop bumps `syncRun`,
    `openSync` checks it after every wait, and an unloaded plugin never starts.
27. **Renames from other devices are applied in rounds, and a swap via a name
    nobody claims.** Two notes or files that swapped names elsewhere each waited
    for the place the other held, forever; a restart's scan then took each file
    for an edit of the other note. `DocStore.applyRemoteRenames` and
    `AttachmentStore.followRenames` move one of the two to a free name first
    (`aside`), which neither the index, a rename event nor a scan may take for a
    note or file of its own. Rolling back renames closes such cycles often.
28. **A note's key comes from one place, and an epoch spent in a shared folder
    is the folder's.** Its key derives from that folder epoch's key
    (`folderKeys.doc`), and the server keeps for good which epoch belongs to
    which folder epoch (`ties`, also after the note left the folder - kept with
    the membership, the owner lost the epochs the note had spent there). Every
    reader of a note's log takes its key from `KeyRing.noteKey`/`noteCrypto`,
    and the server says the tie of the current epoch in `caughtUp` and `rekey`
    before anything is sent under it: a device that knew of a note joining a
    folder only from the vault index encrypted under the note's own key, which
    nobody in the folder holds.
29. **What reaches everyone in a shared folder is decided on the device where it
    happened, once its events settled - and nothing follows the folder
    meanwhile.** Obsidian reports a folder moved or deleted as an event per
    file, sometimes without one for the folder. A note another device placed at
    the folder's old place during a move brought the folder back there, the
    move was then read as every note moving out, and the owner's device ended
    the share of each. `Folders` waits `settleMs`, defers its own pass while
    changes are pending, and takes notes turning up together elsewhere for the
    folder moving. The account's other devices see a delete in the vault index
    before its decision reaches the folder: one of them brought a file back that
    a writer's device was still deleting for everyone. Such a delete is left to
    its device for `decideMs` (`Folders.undecided`) and only then taken for one
    never decided on. And what lay in a folder when it was shared goes in with
    the share (`sharedAt`): asked about as moved in, every device of the owner
    opened a window per note and file while the share took them in. The vault index and
    the folder's document are two rooms, applied apart: whatever a vault records from a
    folder names the Yjs item it came from (`FolderWrite`), and a folder document that
    does not hold that item yet decides nothing about it (`FolderIndex.holds`) - the
    vault's record arriving first was taken for a rename back (0.9.10). A device carrying
    out a delete made elsewhere checks it still stands right before trashing, and never
    takes its own trashing for a delete made here (`trashing`).
30. **The past is written into the files only while the sync is stopped, and
    taken out before it starts again.** The Time Machine shows a moment in the
    vault's own files (`docs/TIMEMACHINE.md`); the sync would read every one of
    them as an edit and send the past to every device and person. So: the vault
    locked on the server first, the sync stopped, a copy of each file and a
    journal line *before* it is replaced (`PastFiles`), and on the way back
    every file restored and checked by its hash before `startSync` may run
    (`TimeMachineControl.blocksSync`). A start that finds a journal puts the
    files back first (`recoverAtStart`, before `startSync` in `onLayoutReady`);
    anything that could not be put back keeps the sync off. Never write the past
    into a file any other way, and never let the sync start around this.
31. **A path someone else wrote is checked before it names a file, and the plugin
    touches nothing but the vault's own files and its own folder.** A shared
    folder's document, a shared note's links, a sealed title come from other people
    and from the server: `../../.obsidian/plugins/mycel/main.js` in a folder's
    document was written there, and would have run at the next start (0.9.8,
    `docs/AUDIT.md`). Every such path passes `vaultPathProblem` (`shared/paths.ts`)
    where it is read, and every file operation passes the gate (`plugin/src/guard.ts`:
    `onload` replaces `app` with one whose vault, adapter and file manager check each
    path - vault paths that are not hidden, and the plugin's folder). Never go around
    the gate (`window.require('fs')`, an `app` kept from before `onload`), and never
    let it refuse what a vault really holds: Obsidian lists no hidden file.
32. **Only what this account decided goes out, and only a room's owner seals its
    keys.** The server's lists decide nothing alone: a key is sealed only to a member
    this account recorded giving the note or folder to (`recordRole`, `memberKeys`),
    a folder's share covers only notes this vault's index has in it (`ownNotesIn`), a
    note is written under a folder's key only when the index has it in that folder
    (`tieAgrees`), a key is taken only when the room's owner sealed it (`openSealed`),
    and a file of this vault goes into a shared note's list only for a link this account
    claimed, or a note shared from here with its files (`SharedFiles.approve`). A link is
    someone's only by its claim (`LinkClaims`, 0.9.11): signed, written by the device whose
    own edit - the editor's or the file's - made it; never by its letters, which a writer
    can assemble from someone else's by deleting between them (P11), and never for a
    change of someone else's. Someone else's link opens what it means in their vault, or
    nothing - never a note of this vault of that name (`LinkGuard`).
    A folder's document moves, revives or deletes only notes that are in that folder.
    A friend code binds its creator's account id with the keys. Nothing anyone else
    shows this device is taken on the server's word either (0.9.9): presence is signed
    by its sender and drawn only for this account, a contact or a certified writer,
    under the name this account knows them by (`checkPresence`); a share's title is
    signed by its owner (`openTitle`); a contact goes only on their signed word
    (`Contacts.forget`); someone else's change counts as made no earlier than an hour
    before the server took it (`changeTime`); the backup server checks every frame's
    signature as a device does.
33. **A room's epoch only goes forward.** No device writes under an epoch below the
    highest one it, any device of its vault (`AccountSettings.epochFloor`) or a key
    sealed to the account knew (`KeyRing.epochFloor`, `epochHolds`): a server moving a
    note back had new text written under a key someone revoked still holds. The
    owner's device moves the room past it (`catchUpEpoch`, a jump the server accepts,
    `isLaterEpoch`); everyone else waits. Every new epoch is `KeyRing.nextEpoch` -
    past the server's and past the floor -, never the server's plus one.

## Architecture

### Accounts and keys

- **The server knows no names.** An account is a random id; `accounts.json`
  finds it by the hash of a **login key**. Accounts come from an invite code
  (`mycel invite`, naming nobody) or, with
  `MYCEL_REGISTRATION=open`, from anyone.
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
- **Signing the other devices out** (`docs/PHASE5.md`): every token carries the
  account's session generation (`sessions` in `accounts.json`, `gen` in the token;
  a token without one is refused), and only the current one is accepted. A password change moves it and
  the server closes the account's sockets with `4401`, also its own device's: the
  close arrives before the new token, so `Session.stillSignedIn` waits for the
  device's own request (`Session.move`) before asking whether it is signed out - and
  after its own request does not ask at all, once - and a token that holds reconnects
  at once, without the backoff (0.8.5).
- **The recovery code** is a second wrapping of private key and account secret,
  under a key from 128 random bits; the server finds the account by the hash of
  another key from them (`recoveries`). The code alone opens the account and sets
  a new name and password; using it spends it and signs out every other device.
  Making, replacing or deleting one needs the current password, never a token
  alone: a planted code would let its holder replace the account's keys.
- ***Replace all keys*** (0.9.6, `docs/PHASE8.md` S2; `account/KeyReplacement.ts`): after
  a suspected theft, the password, account secret, identity, signing key, every vault
  key and the recovery code are replaced on the server in one step (`POST
  /auth/replace`, the current password required, every device signed out). Then every
  room the account owns is **written anew in place** under the new keys (`/log/:room/whole`,
  `/log/:room/rewrite`, under a vault lock of kind `replace`): each frame at its seq and
  epoch - the account's own signed anew, a writer's re-certified, anything no signature
  holds for an empty change, anything no key opens stops it all -, every snapshot, every
  member's keys sealed anew; a room others write in moves to a new epoch at that moment.
  Every file is uploaded anew and the content before purged. Until a device finished, the
  bundle carries `replacing` (the old secret wrapped under the new), and any device of the
  account signing in carries it on before anything syncs; a room done is marked
  `rewrittenBy`. A vault keeps its id - devices find it by its sealed name. Contacts hear
  `contact-replaced`, trust nothing in its name and seal nothing to it until a new friend
  code confirmed the new keys (`Contacts.markReplaced`, `pin`); their device then reseals
  and rotates what it shares with it (`renewFor`, kept as `renewNeeded` until done).
- **Two-factor sign-in** (TOTP, optional) guards the sign-in only - nothing is
  encrypted with it, and it cannot be: six digits that change every 30 seconds,
  checked by the server. The right password answers `403` with a challenge (a token
  of scope `2fa`), the code turns it into a session. Turning it on signs out the
  other devices. A recovery keeps it when given a current code from the app, the
  same entry going on working, and turns it off otherwise; so can the admin
  (`user 2fa-off`), and a signed-in device with the password alone - a code would
  add nothing there, since device and password can make a recovery code.

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
payload until `ack`. See `MUX` in `shared/protocol.ts` and `VaultSocket`. The
server acknowledges a frame only once it is synced to the disk, and nobody reads it
before (`RoomLog.append`, 0.9.1; `headSeq` counts frames still being written,
`writtenSeq` does not); every other file it writes through `server/src/durable.ts`.
One server per data folder (`server.lock`), and `accounts.lock` between it and the CLI.

**Every note live** (0.9.2): a device holds at most `maxLoadedDocuments` notes open; one it
lets go (`DocStore.evict`, never with an unacknowledged change, never held) is **watched**
(`VaultSocket.watch`, `MUX.watch`) with the seq it knows, the server answers `changed` when the
log is further on and whenever a frame lands (`RoomHub.watch`, heads of notes it does not hold
read from the log's headers once), and the device opens it for a moment the normal way
(`DocStore.remoteChanged`, eight at once) and lets it go again when the limit needs the room.
The watch is named again on every connection.

While a vault is **locked** (`sync/VaultLock.ts`, `RoomHub.takeLock`; 0.8.13) the
server answers the account's pushes into it with `locked` instead of `ack`; the device
keeps them, as offline, and sends them once a `vault-lock` notice says the lock ended.
Only the connection that named the lock's id writes - a rollback's, or a restore from the
Time Machine before it lets go (0.8.15; before, only under a rollback's). The lock
seals what it covers (`LockPurpose.scope`: the vault, a folder, a note), and on the other
devices that is read-only meanwhile (`history/EditLocks.ts`), a bar at the top of its
editor saying so (0.8.16): typed into, a restore overwrote it. What is written all the same
- the lock lifted, someone in a shared note - a restore keeps, merged against what the note
said when the lock was taken (`DocStore.rewind`, 0.8.16). The lock lapses two minutes after
its holder stopped renewing it - kept in the server's `locks.json`, it outlives a restart of
the server for that long (0.9.1) -, and any device of the account can lift it - its window, the
editor's bar, the lock in a note's header, the cloud's menu, *This device*. Every reconnect
asks whether it still holds: a device that was away when it ended never heard so, and sent
nothing until a restart (0.8.16). Other people in shared notes are not locked.

A file written because of another device's change carries the time that change was
made (the author's time in the frame, `VaultSocket.applyingAuthorTs`), not the time it
arrived: plugins that stamp a note on every change (*Update time on Edit*) took the
arrival for an edit here and sent their stamp back (0.8.13).

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

### Attachments

Every file that is not Markdown (`sync/AttachmentStore.ts`, `AttachmentIndex.ts`,
`Blobs.ts`; spec in `docs/PHASE4.md`). Here the **file is the source of truth**
and the server holds immutable blobs of its versions:

- The index document has two more maps: `attachments` (`fileId -> { path, hash,
  size, prev, deletedAt? }`, ids derived like docIds under the label `file::`)
  and `versions` (`fileId:hash`, the lineage and the earlier versions). Maps of
  their own, because 0.4 devices take every entry of `files` for a note.
- A blob is named `HMAC(vault-derived key, SHA-256 of the content)` and keyed
  from the vault key, so the same content is one blob and nothing is stored. It
  is encrypted in 4 MiB chunks bound to blob, index and count, and travels raw
  over REST (`/blobs/:account/:vaultId/...`), resumable; the server keeps it under
  `users/<account>/<vault>/blobs/`.
- The device keeps a **base** per file (`StateStore.attachment`: path, mtime,
  size, hash): what file and index last agreed on. Changed here and there, or no
  base, means both are kept as two files (`name (conflict <date time>).ext`).
- Remote renames use `vault.rename` (invariant 22); a remote delete trashes only
  an unchanged file whose content the deleter had seen (invariant 24).
- A per-device download limit (`attachmentDownloadLimitMb`, 10 MB on a phone)
  leaves larger files on the server until a note that needs them is opened
  (`fetchFor`, on `file-open`).
- Every start and reconnect sends one `have` for all held files and uploads
  what the server lost. At most 64 MB of file content is in memory at once.
- An event always means "read it"; a scan every minute catches what raised no
  event. A view that saves what it held right after another device's version
  was written into it (within 5 s, file open in a leaf) is not taken as an
  edit on top: that version is kept next to it (`keepTheirsAside`).
- The trash lists notes and files (command, settings, every folder's menu); a
  file's menu has "Version history" (its earlier contents); a note's Time Machine renders
  each version, pictures deleted since shown from the trash. The trash pass also cleans up:
  content no live entry, recent tombstone or lasting version names goes, and
  only what the server confirms gone leaves the index.
  The server keeps a blob 10 minutes past its last upload whatever it is asked, and a
  device that finds content there and names it touches it first (`Blobs.keep`) - a
  purge that was first means uploading it again. Content no entry, version or shared
  base names (a crash between upload and entry) goes once untouched for longer than the
  retention, a week at least (`letGoOfUnnamed`, the store listed to its owner).
- **Shared notes carry their files** (`share/SharedFiles.ts`), both ways, when
  the owner chose so (`share.attachments` in the note's document). The note's
  document holds a list `link -> { account, vault, blob, key, hash, prev }`;
  what comes in is copied into this vault's own store at once and lands in
  `<share folder>/Attachments/<link>` with `via`, an ordinary file from then
  on. The base per link is the vault's (`sharedBases` in the index), so every
  device of an account decides the same. Deleting such a file declines it for
  the account (`declined`); the trash rejoins. The server lets a note's
  members read the blobs its list names and never purges those.
- A shared folder's files are the folder's (0.8.1, "Shared folders" below).
- Built: own devices (step 1), the trash and versions (step 2), shared notes'
  files and the notes they link to (step 3).

### Backups

A **backup server** of the user's own (`packages/backup`, image
`mycel-backup`; spec `docs/PHASE6.md`, running it `docs/BACKUP.md`)
pulls a vault, decrypts it in memory and hands it to restic. For a few private
people: whoever runs it can read the vaults on it.

- **It reads, never writes.** A **backup key** per vault (made on a device with the
  password, `POST /account/backup-keys`) signs it in for a token of scope `backup`
  that the reading routes accept for that one vault (`reader`/`roomReader` in
  `http.ts`). A password change, a recovery and removing the account end every key;
  the device that changed the password hands out new ones at once.
- **Reached only through the sync server, on a secret per route.** The backup
  server registers at `/relay` one **route** per secret it holds - the hash of a
  token derived from it (`backupRouteKeys`) -, all on one connection. A secret is
  an operator's one-time **invitation** (`invites.ts`, 7 days) or a vault's
  **pairing**. A session's key depends on the route's secret, which never travels:
  each end proves it knows it (`openSession`/`answerSession`/`finishSession`,
  `SessionCipher` in `shared/crypto`), so the relay can neither read nor pose as
  either end. A device's relay connection is closed with `4401` whenever the vault
  sockets of its account are (`RoomHub.onDisconnect`, `Relay.signOut`): its token was
  checked only when it opened. On an invitation's route a session can only `connect`: the device
  hands over a **grant** - backup key, vault key, the account's key pair (shared
  notes are sealed to it) - and gets the vault's pairing secret back, kept in the
  vault's settings (`backupServer:<routeId>`); the invitation is spent, *after* the
  answer (spending drops its route, and the relay ends the session with it). On a
  pairing's route a session reaches that vault and nothing else, and a vault
  paired with one account is never taken over by another. A password change
  `rekey`s over the pairing; only a lost vault needs a new invitation. The relay
  pings every connection, as the vault socket always did (`heartbeat`): behind
  nginx a backup server waiting quietly lost its connection every minute.
- **One backup server per vault, one task** (0.7.17, `docs/PHASE6.md`, "One backup
  task per vault"). Connecting another backup server replaces it. The task lives in
  the vault's settings document (`backupServer:<routeId>`, `backupTask:<routeId>`),
  which the backup server reads with its key: the restic repository *on the backup
  server* or *in a cloud* (a restic location and credentials), its password,
  retention, schedule, and whether a **decrypted copy** (*trusted*) is kept besides.
  There is always a repository; the copy never stands alone. Nobody types a path:
  the backup server keeps a repository in `encrypted/<vault id>/` and a copy in
  `decrypted/<account name>/<vault name>/` (another account of that name gets its id
  added), picked once at pairing (`decryptedFolder`). After a change the device waits
  until the backup server's status carries the hash of the same settings
  (`backupSettingsText`) - comparing ids let a run go by the settings before an edit
  of retention.
- **When** (0.7.18): every so many hours, or at a time of day (`at`: on the days in
  `weekdays`, every day without them; 0.7.18's single `weekday` still read) by the
  IANA zone of the device that set it - a container runs in UTC
  (`schedule.ts`, both changes of the clocks tested). A scheduled run that is due
  waits until the vault's room tags stayed as they were for five minutes, at most an
  hour (`BackupService.stillBusy`): a device merely connected holds nothing up. Runs
  asked for - *Back up now*, the backup before a rollback - never wait. rclone is in
  the image for `rclone:` repositories, behind a wrapper that drops to `PUID`:`PGID`,
  its remotes in `/data/rclone/rclone.conf`.
- **A run** (`run.ts`): what changed into an encrypted cache (rooms by their tag, a log
  from its last frame, compared - invariant 19), the layout from the index (vault,
  trash, settings without contacts), notes and canvases into a RAM disk for restic,
  every other file as a tar stream (killed before it ends when producing it fails),
  every snapshot checked back, and only then - once the repository took the run - the
  copy brought level: the vault at its top so it opens as a vault, trash and settings
  in its hidden `.mycel/`, never emptied, only its own files touched, held
  when more than its guard's share (50 % unless set) of the notes, or of the files,
  vanished - counted apart, and against the most of the week's followed runs
  (`guardReference`), not the last one: measured by the last, a loss split over two
  runs went through. Only a confirmation, or following with the guard off, starts it
  afresh; nothing is counted while the copy waits. A held copy is asked about in a
  window over everything (`CopyWaitsModal`) - with the settings, whatever the tab,
  and live -, and letting it follow is waited for to the end (`Backups.followCopy`):
  a row that only said "waits" and stayed after the click left the user guessing.
- **Nothing changed, nothing run** (0.8.15): when everything a run would hold - every
  path and content hash, what could not be had - and the retention are what the last
  successful run here held, restic is not started at all (`unchanged`): the Time Machine
  backs up before every restore, and ten starts of restic for nothing took seconds on a
  Pi. A run with changes reads its new snapshot back every time; restic's `check` of the
  whole repository runs once a day, the deep check once a week. The log says how long
  each step of a run took.

### Around the notes

- **The log** (`src/log.ts`): every `log.*` call also goes to a file per day in
  the plugin folder's `logs/`, a week of them; "Copy the log" puts two days on
  the clipboard, errors and warnings gathered first (`withSummary`). Never note
  text — paths, ids, sizes, outcomes. The levels say what to look at: `error`
  for a failure *and* for a note or file kept in two versions, `warn` for the
  unusual handled, `info` for what happened, `debug` (every frame; presence and
  carets when they change) only with "Detailed logging" on.
- **The cloud** in the status bar is `DocStore.noteState` for the active note,
  `AttachmentStore.fileState` for any other file, polled: `unsent` while
  anything this device holds is unconfirmed, `waiting` while the server's state
  is unknown (for a file: another device's version on its way), `held` during a
  recovery, `local` for a file too large for the server. Clicking it opens the
  plugin's menu for that file. Beside it a mark says whether the note is shared
  and whether only to read; a note shared to read only also gets a lock in the
  header of every view showing it - a phone has no status bar.
- **The notification center** (`notices.ts`, `NotificationsView.ts`; 0.8.13), titled
  *Mycel* for the user - it holds more than notices: the
  plugin's `Notice` is its own subclass of Obsidian's, which also keeps each notice -
  when, the text, a failure or not, the note it names - in the plugin folder's
  `notices.json` (500, or 30 days). A bell in the ribbon counts the unseen and opens the
  view. Import `Notice` from `notices.ts`, never from `obsidian`, or it is not kept. A
  notice with a button passes it as a `NoticeAction` (label, kind, data) and the plugin
  registers what the kind does (`notices.handle`): the button then works from the center
  too, once, after a restart as well (0.8.15) - a closure would not survive one. A second
  tab lists the account's rollbacks and restores, never cleared, each with *Undo…*, which
  opens the Time Machine at the moment before it (0.8.16).
- **The settings are in tabs** - Account, Contacts, Backups, This device, All
  devices; signed out only Account and This device.
- **The settings tab is live** (`settings.ts` `refresh`): a change of the
  account-wide settings from another device draws it again, and so does the
  account's state - 2FA, the recovery code - which the server announces with
  `account-changed` and a device also asks for on reconnecting and when the tab
  opens (`refreshAccount`). A field with the focus is never rebuilt under the
  cursor; the tab waits for it to lose the focus.
- **The note's menus** (its "…" menu, the file explorer, the editor's right
  click) carry sharing, access, detaching, the Time Machine and "Compare versions", in
  a section of their own under a label with the plugin's name (Obsidian's menus
  have no headings, and its submenus are not public API).

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
owner has it. A caret moving along with text typed *before* it is correct. Typing
and the typist's caret arrive apart, either first: the caret of whoever typed a
change moves along with it, and one naming a letter not here yet stays where it was
drawn - drawn by its anchor alone, it flickered on every keystroke (0.8.9). A Y.Text
event names no authors (`changes.added` is empty); the transaction's clocks do. A
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
  fingerprint of its creator's identity - sealing and signing key together
  (`identityFingerprint`). The code yields a redeem key (the server keeps its
  hash) and a MAC key that never leaves a device, so the server can pass the
  sealed introductions - name and both keys - back and forth but not forge them.
  Every account has an ECDSA P-256 **signing key** from its registration, wrapped
  under a key from the account secret. Every key sealed to a member carries
  its sealer's signature (`sealed.signer.signature`, `KeyRing.sealFor`/`openSealed`):
  a device opens only keys signed by itself or a pinned contact - a server handing
  out a key of its own is caught. **Signed frames**: every frame and snapshot of
  a note, folder, the index or the settings carries its author and signature inside
  the encryption (`packSignedFrame`, `KeyRing.packFor`/`checkFrame`,
  `RoomCrypto.pack`/`check`) - checked wherever a log is read: live, in a history,
  a fork, a compaction; anything else is dropped, never let to stop a room. Anyone
  but the owner adds the owner's writer's certificate, which comes with their
  sealed key (`sealed.signer.signature.cert`) and follows the owner's own record of
  roles (`AccountSettings.shareRole`) alone - nobody unrecorded writes; every change
  of role moves the note or folder to a new epoch (`Sharing.setRole`, `POST
  /shares/rotate`). Nothing written before 0.9.5 is read (protocol 9). Keys are taken from
  the contact list, never from the server - it has no route for anyone's key. A
  member the server lists who is no contact stops the rotation that would seal a
  key to them (`Sharing.memberKeys`, 0.9.0) and is asked about over everything
  (`UnknownMembersModal`): a server listing a member of its own would otherwise
  receive every later key. The server refuses a share with anyone else.
  Removing a contact ends every share between the two.
Presence (cursors, selections) follows from a note being shared: the `shared`
flag on the index entry, and `DocHandle` only registers awareness while it is
set. Syncing your own devices never shows a caret: a note nobody else is in
is not shared (the server tells the owner when the last one leaves, and
`Sharing.refreshShared` clears the flag), and in a shared note a caret of the
same account — the user's id in the awareness state is the account id, not
the name, which is not unique — is never drawn. There is no global
"collaboration on/off" switch — that was built once and was wrong.

- A share folder is only a **default landing spot**. Moving a note out keeps it
  shared; the link lives in the index.
- **"Also share the notes it links to"** (`share/LinkedNotes.ts`) shares, once
  and with the same choices, every note the note reaches through links. Each
  lands below the share folder at its link's path - the sealed title carries
  the folders - so the links between them resolve there. A note the person has
  already is left alone: sharing it again would overwrite their access. It
  follows only links that are not all someone else's.
- **Whose a link is** (`share/LinkClaims.ts`, `links.ts`, `LinkGuard.ts`; 0.9.11): a
  link means a note or file in the vault of whoever typed it. The device it was typed on
  writes a signed `LinkClaim` into the note's document (`links` map, keyed by the Yjs id
  of the link's first character) a moment after the typing stopped; sharing a note claims
  what it holds unclaimed. Someone else's link opens their note where this vault has it,
  else nothing (`openLinkText` wrapped, marks in the editor and reading view); a link to
  a note of one's own the people in the note lack is asked about once (`linkAsked:` in
  the settings), and a yes shares it with each, their access in the note, no history.
- **Sharing again with a member changes their access** on the server (role and
  title replaced, history never taken back). The share dialog therefore says
  when the person has the note, starts from their current access and reads
  "Share again".
- **Revoke is a protocol message** (`revoked`), also answered to a later
  subscribe, and moves the note to a new epoch. The server says a share ended as a
  message and as a notice, and a folder's end once more per note: one of them carries
  it out (`Sharing.ending`) and announces it, a folder's notes leave that to the folder,
  and an end this device asked for (leaving, keeping a copy) is no news here (0.8.10).
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
  ways - and a device that reconciles the new note before it has folded the old
  one in takes the old one's base (`DocStore.baseFor`).
- **Removing an account** (`user remove`) only marks it (invariant 21). The
  running server's sweep (`RoomHub.sweep`, on start and every few minutes)
  ends its shares as above, ends its memberships, forgets its contacts and
  deletes its folder.
- **Deleting is asymmetric.** A participant deleting leaves the share. The owner
  deleting removes the note from the owner's vault only.
- **No remote delete** - for a note shared on its own. Participants already hold
  the content, and destroying what they wrote after the share has unbounded
  downside. The share dialog says that copies remain. Inside a shared folder a
  delete is for everyone (below).

### Shared folders

A folder shared with people, everything added to it later included (0.8, spec
**`docs/PHASE7.md`**, the decisions E0 to E8 the user made).

- **A room of its own,** `fld:<folderId>` (`folderId` derived like a docId under the
  label `folder::`), owned by the folder's owner, with members like a note's. Its
  document (`sync/FolderIndex.ts`) holds the folder's notes by docId with their path
  relative to the folder, tombstones (`deletedAt`) and notes their owner took out
  (`leftAt`). The server grants the folder's members every note whose meta names the
  folder (`folder`), from `since` or their own start (`from`); reached both ways (a
  note shared on its own too), the higher role counts.
- **Keys:** one per folder epoch, derived from the owner's vault key, sealed to each
  member once; every note epoch spent in the folder derives from it (invariant 28).
  Revoking moves the folder's epoch and every note's along, before anything is
  awaited, and keeps a fork per note for whoever leaves.
- **New notes in a folder take their id from it** (`folderKeys.ids`, the path
  relative to the folder), the same for everyone, and a writer's new note is created
  on the server owned by the folder's owner (`subscribe` with a folder).
- **The mirror** (`share/Folders.ts`) keeps the folder's document and the vault
  index entries below the folder's place in step - the folder itself for its owner,
  the accepted copy (`<share folder>/<name>`) for everyone else; entries carry
  `folder` and `folderPath`, the vault index a map `folders`. A note follows renames
  in the folder while it lies where the folder had it. Changes are decided where they
  happened (invariant 29): inside, a writer's rename or delete is everyone's (a
  delete with a notice that undoes it, restorable from the folder's trash); a reader's
  delete declines the note for their account; the owner moving a note out ends its
  share there (everyone keeps a fork); a member moving one out only places it
  elsewhere. An existing note moved in is shared only after a window over
  everything (`MoveInModal`), asked the moment it is moved in (`askEarly`: a note
  from outside cannot be part of the folder moving) and naming the files that go
  along - a participant's own is copied in as the owner's. It also offers the notes
  outside the folder the note reaches through links (0.8.10): shared once, on their
  own, with everyone in the folder who is a contact of the mover, each with their access
  there, the owner to edit, without history; they stay where they are (E8). The
  owner deleting the folder ends the share; a member deleting it leaves.
- **Files** (0.8.1, `share/FolderFiles.ts`): every file inside the folder belongs to
  it. The folder's document holds them in `files` (`fileId -> SharedAttachment` plus
  `path`, `deletedAt`, `leftAt`), ids from the folder like a note's. Each vault copies
  a file into its own store and keeps it as a file of its own, linked to the folder's
  (`AttachmentEntry.folder`), with a base per file in the index (`folderBases`, the
  vault's, so every device of the account decides the same). They follow the notes'
  rules for where they lie and who decides, and a shared note's files' rules for
  their content (invariants 23, 24). Both versions kept from someone who may write go
  into the folder as two files: a conflict copy is announced as a file new here
  (`AttachmentStore.created`), as one the user made is. Files outside the folder that
  its notes link go along as a shared note's do when the folder says so
  (`linkedFiles`, on in the dialog) and land in `<share folder>/Attachments`; the
  dialog also offers, once, the notes outside it they link to.

`test:folders` runs it all with an owner, a writer and a reader, devices of each.

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

**The Time Machine** (0.8.11, its second round 0.8.13, its third 0.8.15, its fourth 0.8.16,
`docs/TIMEMACHINE.md`): the past of the vault, a folder or a note shown in the vault's own
files - in the explorer and the normal editor, read-only - while the sync is stopped on
this device and the vault locked on the others, what it shows read-only there too
(invariant 30; `history/TimeMachineControl.ts`, `TimeMachine.ts`, `PastFiles.ts`). A
timeline in a column of its own at the left of the editors (`history/Strip.ts`) has a bar
per tick - a version of a note, a change of a folder or the vault, as fine as chosen
(every change, a minute, five, an hour, a day) -, each the state after it, the newest
being *now*, a fixed distance apart and scrolling beyond what fits, a gap where a day
begins; the moment before each earlier rollback of exactly that place a place of its own,
where the notification center's *Undo…* opens it; and, behind a switch
kept on the device, the backups older than the history. A moment is written as its
structure at once and its contents in the background, the note in front first; a note's
editor marks its changes against now (`history/pastEditor.ts`); the overview beside the
explorer lists what differs (`history/TimeMachineView.ts`). The explorer and every other
way to open a file stay inside what it shows (`history/ExplorerGuard.ts`). The ticks come
without reading a note (`history/Timeline.ts`): the vault index's history walked once into
events, and the minutes in which the server took each note's frames (`GET /times`); a
note's text is replayed forward from where it stood and back from a checkpoint (`Replay`).
It changes the vault only through *Restore this version* (for a folder or the vault the
rollback below, `history/ApplyModal.ts`) or *Restore just this note/file*: a backup while
the past is still shown, every file back, and the restore made under the lock it took,
which goes only once the restore reached the server. *Abort* puts everything back.

**Rolling back** (`sync/Rollback.ts`, applied from the Time Machine, 0.7.8): the vault
or a folder back to a moment. The index replayed to it (`history/RoomHistory.ts`)
and each note's history give the plan; a fresh backup on the backup server
(`Backups.backUpFresh`) and a copy into the plugin's `rollbacks/` come first -
`apply` refuses otherwise, unless agreed -, the vault's lock (other devices wait,
0.8.13), a `rollback:<id>` record in the settings, then trashing, moving, restoring and
editing as a person would, so every device follows and it can be undone. Afterwards the
copy goes if the backup holds the same, by hash (`copyIsBackedUp`); otherwise a window
says it is only on this device. Others' shared notes stay, and so do the files of
others' shared folders (0.8.10); own shared notes go back for everyone. A moment before a snapshot's time is out of reach; a
compaction stamps the newest change it folds in. Out of reach is filled from the
newest backup at or before the moment (0.7.9, `backup/src/restore.ts`, read only
over the pairing); with the index itself out of reach the whole plan comes from it,
by path. Only notes the server saw change since the moment are read (`GET /changed`,
by the server's clock with an hour's margin; 0.8.8). The backup made first forgets nothing (`keepAll`), so the snapshot read
next is still there.

The retention is also the **trash** (`sync/Trash.ts`, "Deleted notes…"): a
deleted note of one's own stays restorable for that long, on any device —
restoring revives its index entry and pulls it from its document, next to a
note that took its name meanwhile. After that the owner's device asks the
server to delete the room (`POST /log/:room/purge`), which it refuses while the
note is still shared, and marks the tombstone `purgedAt`. A retention of 0 keeps
everything, deleted notes included. The purging device clears its local copy of the
note at once; every other device clears its own in its next trash pass
(`DocStore.clearPurged`), once - `StateStore` remembers it, so the database is never
opened, and so made, again.

## Testing

Nothing that touches Obsidian's API can be tested headlessly. Everything else is
covered, and all of it must stay green.

```bash
npm run test:merge     # merge/reconcile/identity and the crypto — no server, no DOM
npm run test:load      # the built bundle imports, onload/start/unload run, Obsidian stubbed; current and versioned
npm run test:rooms     # accounts, access, epochs, sharing, compaction, restart — in-process
npm run test:sync      # the editor binding in real CodeMirror, jsdom, in-process relay
npm run test:recovery  # a server that lost its data, one restored from a backup, cleaning up blobs — in-process server
npm run test:account   # the account with real devices: signing the other devices out, the recovery code, 2FA — in-process server
npm run test:rollback  # rolling a vault or folder back from the history, the gate, undoing it, swaps on other devices, the Time Machine's timeline — in-process server
npm run test:timemachine # the past in one device's files, put back byte for byte (after a crash too), the vault lock, a restore under it keeping what was written after it, a lock ended while a device was away, the editor read-only with its bar, a synced file's time, the notices — in-process server
npm run test:replace   # every key of an account replaced: the vaults and files written anew, the other device, a contact confirming again, a replacement carried on by another device — in-process server
npm run test:security  # every attack of the audit (docs/AUDIT.md): the server attacked over HTTP and WebSocket, the plugin's paths, links, folders and gate, the backup task — in-process servers
npm run test:backup    # the backup server's run with real devices and a real restic — in-process server
                       # restic on the PATH or named by MYCEL_RESTIC (where it lies here: docs/PROGRESS.md)
# needs a server that lets tests create accounts:
npm run test:socket    # the encrypted transport, two devices of one account
npm run test:vault     # three devices + a collaborator: accounts, DocStore, binding, sharing, attachments
npm run test:folders   # a shared folder: its owner, a writer and a reader, devices of each
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
Obsidian's saves and reloads, IndexedDB, `requestUrl` (binary bodies too, on
mobile), `localStorage`, the modals and the settings tab, Obsidian's binary
file events and link resolution, memory with large files on a phone, the QR code
scanned by an authenticator app and the `otpauth://` link opening one, the Time
Machine on screen (the timeline and its wave, the bar, the overview, the windows, the
explorer and the editors showing the past, the editor's marks in live preview, Obsidian's
own writes with a modification time; and since 0.8.15 the editors read-only in
Obsidian's own editor, the explorer's guard against Obsidian's handlers, the tab going
back, the editors moved aside for the bar and the timeline; and since 0.8.16 the bar at the
top of a locked note's editor in Obsidian's own editor), the notification center, its bell,
its tabs and its buttons; since 0.9.11 the marks of someone else's links in Obsidian's editor
and reading view, and opening them - Obsidian calling `workspace.openLinkText` for every
way a link is opened is assumed, not tested.

## Gotchas

- **Node 22+ required.** jsdom 30 does not support Node 20, and Node 20 is EOL.
  CI builds on 24, which is also the development baseline. Node's own
  `WebSocket` and WebCrypto are what the tests use.
- **TypeScript 5.9 types `Uint8Array` by its buffer.** WebCrypto wants
  `Uint8Array<ArrayBuffer>` (`Bytes` in `shared/crypto`); Yjs and lib0 hand out
  `Uint8Array<ArrayBufferLike>`. Convert with `bytes()`.
- **`shared/crypto` is not in the package index.** The server compiles the
  shared sources without DOM types and never encrypts; import it as
  `@mycel/shared/crypto`.
- **Never add the editor extension with `StateEffect.appendConfig`.** Obsidian
  drops such extensions whenever it rebuilds the EditorState (file switch inside
  a leaf, edit/preview toggle), and re-attaching from workspace events while it
  was still laying out crashed CodeMirror and opened fallback panes. Use
  `registerEditorExtension`. The binding still compares the note on every update
  and lets go when it changes — otherwise a file switch pushes the next note's
  text into the shared room.
- **There is no Docker on the development machine.** The images are only ever
  built in CI: the `docker` job in `build.yml` runs after the tests, on `main`
  only, starts the image once (health check, `invite` through the CLI) and
  publishes it to `ghcr.io/johnnyjack123/mycel-server`. A broken
  `Dockerfile` shows up there and nowhere earlier. The `docker-backup` job builds
  and starts `Dockerfile.backup` on every push (restic runs, an invitation is made
  and kept, ssh is there for `sftp:`, restic makes a repository through rclone, the
  server survives an unreachable sync server, takes over its three bind-mounted
  folders when they are not its own - and `rclone config` through `docker exec`
  leaves its file to user 1000 -, and registers its invitations at a real sync
  server) and publishes
  `mycel-backup` from `main` only. Every Dockerfile copies every
  workspace's `package.json` before `npm ci`.
- **Both images start as root and drop to `PUID`:`PGID` (1000:1000)** in
  `docker/entrypoint.sh`, after handing their data folder to that user - a
  bind-mounted folder Docker made is root's. `docker exec` bypasses the entrypoint
  and runs as root, so the `bin/*.mjs` wrappers drop to the same user themselves: a
  file the CLI wrote as root (`accounts.json`, an invitation) could not be written or
  read by the running server afterwards. Never put `USER` back into a Dockerfile.
- **restic for `test:backup`** is pinned (0.19.1, CI checks its checksum, and so
  does `Dockerfile.backup` per architecture). On the development machine it lies
  outside the repository; `docs/PROGRESS.md` says where. rclone is pinned the same
  way in `Dockerfile.backup` (1.75.1) and runs only in the image.
- **`main.js` is CommonJS inside a `"type": "module"` package.** Obsidian
  evaluates it itself; Node needs a `.cjs` copy (see `load-selftest.mjs`).
- **Never put raw control characters in source.** A NUL sentinel in the glob
  matcher survived two rewrites unnoticed, and a byte order mark written as its
  `\u` escape in an edit landed as the invisible character itself. Write such characters by code
  (`0xfeff`, `String.fromCharCode`). To look for them, read the files with Node:
  `grep -P` in Git Bash has no UTF-8 locale and fails, which with `2>/dev/null`
  looks exactly like "nothing found".
- **`MYCEL_JWT_SECRET` needs 32 characters**, or the server does not start (0.9.8);
  unset, it makes one in its data folder (`jwt-secret`). Every test that sets one sets
  a long one. Behind a reverse proxy, `MYCEL_TRUST_PROXY` names it - unset, every
  request seems to come from the proxy, and the sign-in throttle blocks everyone at once.
- **Every WebSocket the server accepts has an `error` listener** (`heard` in
  `server.ts`): one without took the whole process down on a single malformed message,
  from anyone (the relay takes backup servers without a token).
- **A device's token travels as a WebSocket subprotocol** (`socketProtocols`,
  `mycel.token.<jwt>`), never in the URL, which every reverse proxy logs (0.9.9). The
  server answers with `mycel` alone and still reads a URL token from older plugins.
- **`MYCEL_QUOTA_MB` covers rooms too** (0.9.9): `RoomHub.usageOf` counts an account's
  rooms from the disk now and then and adds what was written since; a push past it is
  answered `full`, a new room `denied full` - neither final, the device keeps what it wrote.
- **A backup task's cloud location never reaches the backup server's own network**
  (`backup/src/network.ts`, checked in `Restic.run` before every start), unless
  `MYCEL_BACKUP_ALLOW_HOSTS` names the host.
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
  PORT=1235 MYCEL_REGISTRATION=open MYCEL_DATA_DIR="$TMPDIR/oc-test-data" npm run start:server
  npm run test:vault -- ws://localhost:1235
  ```

  (No `MYCEL_JWT_SECRET` needed there: the server makes one in its scratch folder.)

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

In the order of the roadmap (Conventions); what goes into 0.8 and 0.9 besides
is listed in `docs/PROGRESS.md`, "Roadmap". (Recovery codes and 2FA: built in
0.6, `docs/PHASE5.md`.)

**The operator's backup (later).** The data directory as it is - ciphertext only -
pulled with a dedicated, revocable backup token rather than an account. Moved out of
0.7 by the user on 2026-10-15.

**Syncing plugins and their settings (wanted, optional, after 1.0.0).** Moved
back by the user on 2026-10-14. Not through the
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

## Conventions

- Commit messages, comments and identifiers in English; the user writes German.
- Conventional Commits, `Co-Authored-By` trailer — see the `git-flow` skill.
- **Push right after every commit** — the user asked for that (2026-09-27);
  it replaces "never push without being asked" for this repository.
- **A branch per milestone or larger feature, merged when it is done** — the
  user asked for that (2026-10-14). Start it from `main` without asking
  (`feat/<name>`, e.g. `feat/backup-api`). Once the feature is done - built,
  every test and CI green, the docs current - merge it into `main` without being
  asked (`git merge --no-ff`, pushed) and watch the CI run on `main`: only there
  are the Docker image and the `latest-build` release built, so a broken
  `Dockerfile` shows up nowhere else. Fixes found afterwards, and other small
  fixes, go straight to `main` or on a short `fix/<name>` branch. Everything up to
  0.6.8 was built on one branch, `feat/accounts`, and reached `main` only then.
- Comments explain *why*, never narrate *what*.
- **A button that waits for the server or the disk runs its work through `busy`**
  (`src/busy.ts`): greyed out and spinning at once, no second click. Without it a
  click that waited looked like one that went nowhere (asked for by the user).
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
  | 0.7 | the backup server (`docs/PHASE6.md`) |
  | 0.8 | sharing a folder, and the small fixes listed for it in `docs/PROGRESS.md`; then the Time Machine (`docs/TIMEMACHINE.md`, the user, 2026-10-25) |
  | 0.9 | hardening and a security audit: signatures per author, every note live, durable writes on the server (fsync before the ack, a lock against the admin CLI), a clean slate, replacing every key, a name without "Obsidian" (Mycel); the audit by a separate agent once all of it is built |
  | 1.0.0 | all of the above done and verified on devices |
  | later | syncing plugins and their settings (moved back by the user, 2026-10-14) |
- **Rebuild after anything that swaps the sources.** A bundle built during a
  `git stash` check held the older settings screen and went to the user as
  the new one; `test:load` now fails when a source is newer than `main.js`.
