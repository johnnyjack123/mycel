# Phase 7 — sharing a folder (0.8)

Decided with the user and signed off on 2026-10-22; the specification the
implementation follows. The order of work is at the end. Besides the folder,
0.8 carries the small fixes from `docs/PROGRESS.md`, "Roadmap" (last section here).

A folder is shared with someone the way a note is, and everything in it goes along -
including whatever is added to it later, by either side. Its structure travels: a new
note, a rename or move inside it, a delete, made by anyone who may write, reaches
everyone in it.

## Decided with the user

The numbers are the ones the options were discussed under.

- **E0 - the folder is a room of its own.** Not a machine that shares note by note
  with today's mechanism: that could not carry renames (paths never travel after the
  title), could not take the notes the others add (they would be theirs, shared back,
  landing in the owner's share folder), and would revoke note by note, a rotation and a
  fork each.
- **E1 - a note added to the folder is shared at once.** The share dialog warns that
  everything added later goes along with the same people. The file explorer marks a
  shared folder.
- **E2.1 - an existing note its owner moves into the folder** is shared only after a
  window over everything asked: "'X' becomes visible to B and C - [Share] [Move back]".
  Nothing leaves the device before. Its history in the folder starts where it joins.
- **E2.2 - a note the owner moves out of the folder** leaves the share: everyone else
  keeps it as a note of their own (a fork, invariant 20).
- **E2.3 - a note a participant moves out of their copy of the folder** stays shared;
  it only lies elsewhere for them and no longer follows renames in the folder.
- **Structure:** only who may write changes the folder's structure - renames and moves
  inside it, for everyone. What anyone does outside it, or as a reader, is their own
  layout.
- **E3 - renaming or moving the folder** changes nothing for the others: their copy has
  the place and the name they gave it. A folder inside a shared folder, or one holding
  one, cannot be shared. A shared folder moved into another one later stays its own
  share, and the outer one leaves it out (the innermost wins), with a notice.
- **E4.1 - a note or file deleted in the folder by the owner or a writer is deleted for
  everyone,** with a notice right away that says so and offers to undo. Every device
  keeps the protections it has between one's own devices, and the folder's trash brings
  it back for everyone. This replaces "no remote delete" inside a shared folder only
  (CLAUDE.md, Sharing); a note shared on its own keeps it.
- **E4.2 - a reader deleting a note** declines it for their account; restoring it from
  their trash brings it back.
- **E4.3 - the owner deleting the folder ends the share;** everyone keeps the whole
  folder as their own (forks), the owner's notes go to the owner's trash. A participant
  deleting their copy leaves the share; nobody else notices.
- **E5 - revoking someone is one step:** the folder moves to a new epoch and every note
  in it with it; their devices fork the whole folder, the notes they wrote into it
  included. Content in their store that the folder names is copied into the owner's.
- **E6 - a note in the folder that is also shared on its own:** with someone else (C),
  access is the union and C gets each new key sealed on its own. With the same person
  (B had it on its own before the folder came), it stays where B has it, counts as part
  of the folder, takes the higher of the two roles, and ends only when both have ended.
- **E7.1 - a note a writer creates in the folder belongs to the folder's owner,** as the
  text one writes into a shared note does.
- **E7.2 - a participant moving a note of their own into the folder** copies it in,
  after the same window as E2.1: a new note of the owner's, without its history. Their
  own note ends, and their other devices fold what they hold into the copy.
- **E7.3 - a reader's new note in the folder** stays their own and does not join; a
  notice says so once.
- **E8 - every file inside the folder belongs to it** and lies at the same place for
  everyone. Files outside the folder that its notes embed or link travel the way a
  shared note's do, into the share folder's `Attachments/` - if the dialog said so.
  The dialog also offers, once, the notes outside the folder that its notes link to,
  as a note's dialog does; they land in the share folder.

## What exists, and what a folder adds

A note today (`docs/PHASE2.md`): a room `doc:<docId>` on the server, owned by whoever
subscribed first - its owner -, with members (role, `fromSeq`, a sealed title,
`acceptedInto`) and their sealed epoch keys. Every epoch key derives from the owner's
vault key; a member gets each one sealed to their pinned public key. The member's
vault index points at the room under a path of its own, below the share folder; the
title travels once and paths never again. A share that ends is forked
(`server/src/forks.ts`, `Sharing.endShare`).

A folder keeps every bit of that and adds one level above the notes: a room that holds
the folder's structure, one key per folder epoch that opens every note in it, and the
server granting access to a note through the folder it is in.

```
owner's vault index                     folder room  fld:<F>                  B's vault index
folders  F  -> { path: "Projects/X" }    meta   { name, linkedFiles }          folders  F  -> { path: "Shared/X", owner, role }
files    d1 -> { path: "Projects/X/        notes  d1 -> { path: "Plan.md" }      files    d1 -> { path: "Shared/X/Plan.md",
                  Plan.md", folder: F }    files  f1 -> { path: "img/a.png",                     owner, role, folder: F }
attachments a1 -> { …/img/a.png }                       hash, blob, key … }    attachments b1 -> { …/img/a.png, folder: F }
                    \                              |                              /
                     `---- doc:d1, doc:d2 …: rooms of the owner, `folder: F` in their meta ----'
```

## The folder room

- **`fld:<folderId>`**, a fourth kind of room next to `doc`, `idx` and `set`. Owned by
  the folder's owner, with members exactly like a note room - role, `fromSeq`, sealed
  keys, `revoked`, `acceptedInto` - and epochs of its own.
- **Its document** is a small vault index for the folder, with paths relative to it:
  - `notes: docId -> FolderNote { path, updatedAt, deletedAt?, leftAt?, by? }` -
    `leftAt` for a note its owner moved out (E2.2): the others fork it rather than
    delete it.
  - `files: fileId -> FolderFile { path, hash, size, prev?, updatedAt, deletedAt?, account, vault, blob, key, by }` -
    a shared note's `SharedAttachment` plus its place.
  - `versions` as in the vault index, the lineage invariant 24 decides by.
  - `meta`: the owner's name for the folder (shown, never a path) and `linkedFiles`.
- **The folder id** is derived like a docId (invariant 5): an HMAC under the vault key
  of the folder's path and a generation, the first one the index does not know. Never
  random, never reused - a folder shared again after its share ended gets the next one.
- It is kept on every device in IndexedDB like the vault index, so everything below
  works offline and is sent once the server answers.

## Keys

```
vaultKey     ── HKDF "fld:<F>:<f>"         ──► folder key of folder epoch f   (the owner derives it; a member gets it sealed)
folderKey[f] ── HKDF "doc:<docId>:<e>"     ──► key of note epoch e, an epoch the note spent in the folder at folder epoch f
folderKey[f] ── HKDF "ids"                 ──► the key new notes and files of the folder take their ids under
```

- **The owner derives everything,** as now. **A member gets each folder epoch's key
  sealed once** - not one per note: with it they read every note in the folder, one
  added tomorrow included, and nobody has to seal anything when a note is added.
- **A note keeps its own epoch counter.** Every epoch it spends in the folder is tied
  to a folder epoch, and the server keeps that tie in the room's meta
  (`folder.epochs: noteEpoch -> folderEpoch`) and hands it out with the keys. The
  epochs before a note joined stay under the owner's vault key; a member who got the
  folder with history gets those sealed per note when it is shared.
- **One function gives a note's key for an epoch, whatever its source** (`KeyRing`),
  and every user of keys takes it from there: `DocHandle`, the compactor, the history,
  the rollback, the fork. The ties are kept in `localStorage` with the sealed keys, so a
  device starts offline. The backup server's `keys.ts` derives the same way, from code
  shared in `shared/crypto`.
- **A tie that goes backwards is refused.** A server tying a new note epoch to an old
  folder epoch would have members encrypt under a key a revoked person holds. The
  client accepts only ties that never decrease. That a server can hand a member a key
  of its choosing at all - sealing needs no proof of who sealed - holds for single
  notes too and is for 0.9's audit (signatures per author).
- **Ids under the folder.** A note or file created inside a shared folder, by the owner
  or a writer, takes its id as an HMAC under the folder's id key of its path relative
  to the folder and a generation - not under the vault key. Every device of everyone in
  the folder derives the same id for the same new path, so two people creating
  `Plan.md` at once arrive at one note and the same seed (invariants 5, 18). The id key
  changes with the epoch, so a person revoked cannot compute the ids of notes still to
  come and claim their rooms first. A device that creates a note while it still knows
  only an older epoch derives another id; the folder's duplicate merge folds the two,
  additively, as `mergeDuplicates` does in a vault.

## Access on the server

- A note room in a folder carries `folder: { id, fromSeq, from?: { [account]: fromSeq }, epochs }`
  in its meta. Whoever is a member of the folder room has access to it with the
  folder's role, from `from[account]` or else `fromSeq` (where the note joined; 0 for
  one born in the folder). Its own members keep theirs as now; reached both ways, the
  higher role and the earlier `fromSeq` count (E6).
- Revoked from the folder and without a membership of its own: `revoked`, so the
  devices fork.
- **New rooms for the folder.** `subscribe` carries an optional folder id. A missing
  room is then created owned by the folder's owner, in the owner's vault, with
  `folder` set and epoch 0 tied to the folder's current epoch - if the caller is the
  owner or a writer of that folder, and refused otherwise. Without a folder id a room is
  created as today, owned by whoever subscribes first.
- Only the owner compacts (invariant 17), the rooms writers created included: they are
  the owner's.
- Blobs: `attachBlobs` works on folder rooms; reading someone else's blob through
  `?room=fld:<F>`; purging spares every blob a folder room names (`isAttached`).

## The mirror between folder and vault

- **Every vault index gets a map `folders`** - a map of its own, like `attachments`,
  so an older device does not take its entries for notes: one's own folder
  `F -> { path }`, someone else's `F -> { path, owner, role }`, where `path` is where
  it lies in this vault (the mount); tombstones say `endedAt` or `leftAt`. Entries of
  notes and files in a folder carry `folder: F`, and `folderPath`: the path relative to
  the folder this vault last followed.
- **A mirror** (`share/Folders.ts`, the folder document in `sync/FolderIndex.ts`) keeps
  each folder room and the vault index entries below the folder's place in this vault
  in step - the folder's own path for the owner, the mount for a member. One mechanism
  for both: to the owner, the mount is the folder itself.
  - **Folder to vault:** a note the folder has and the vault does not becomes an entry at
    mount + path, and `DocStore` pulls it like any note. A new path in the folder
    renames the entry - if its file lies where the folder had it (`folderPath`); one
    lying elsewhere stays (E2.3). A tombstone deletes the entry, and `DocStore` applies
    it as it applies a delete from another device: only to a file this device agreed on
    and that is unchanged since, after a backup (invariant 2); a file changed here keeps
    the note - and revives it in the folder too, for a writer.
  - **Vault to folder:** what the user does inside the mount on this device - a new
    note, a rename, a move, a delete - becomes a change of the folder, for the owner and
    writers. A reader's changes stay their layout.
- **Who decides.** A change that reaches the others is decided by the device where it
  happened, from the vault event - never by another device reading the vault index, and
  never from a remote change. The device waits two seconds before deciding: Obsidian
  reports a folder renamed or deleted as an event for the folder and one per file, in no
  fixed order, and sometimes the folder alone. Only if the folder is still in its place
  afterwards is it a note that moved out or was deleted; otherwise it was the folder.
- **After a crash in between,** the device finds folder and vault disagreeing on its
  next start and takes the side that loses nothing for the others: a note deleted in the
  vault but live in the folder comes back; a note of the owner's lying outside the folder
  while still in it is asked about in a window ("'X' lies outside the shared folder but
  is still shared - [End its share] [Move it back]"); a note of the owner's inside it
  that the folder does not have is asked about as moved in (E2.1).

## The cases

### Sharing a folder (E1)

- The folder's menu gets **"Share folder…"**. The dialog: a contact, read or write, with
  or without history, and
  - the warning: "Everything in this folder is shared with them, and everything added
    to it later - by you or by anyone who may write. A note deleted in it is deleted for
    everyone.";
  - what goes along: so many notes, so many files and their size; notes of others in
    it and notes excluded from sync stay out, listed;
  - **"Files outside the folder that its notes embed or link"**, on by default and
    lasting - the folder's `linkedFiles`, so a file linked later goes along too;
  - **"Also share the notes outside the folder that its notes link to"**, off by
    default, listed, once - `share/LinkedNotes.ts` over every note of the folder;
  - refused, with the reason: a folder inside a shared folder, one holding a shared
    folder, someone else's folder.
- **The first share** creates the folder room, puts every note and file in it and makes
  each note join (below). A file is published as a shared note's is: attached to the
  folder room, its entry with the content's key.
- **With history:** the folder keys `0..f` sealed to the person, and per note the epoch
  keys from before it joined.
- **Without history:** the folder moves to a new epoch and every note with it; the
  owner's device then uploads a starting snapshot of each note - and of the folder room
  - at its head, in the background. The button stays busy (`busy`) with the progress
  until the last one is in, then a notice says it is done. Until a note's snapshot is
  there, the person's devices wait for it: unknown is not empty (invariant 1).
- **A note joins** (the owner's device): one request moves it to a new epoch tied to
  the folder's current one, with a snapshot at its head - its history in the folder
  starts there (E2.1) - and the new key sealed for its own members, and sets `folder`
  on the room. The folder room gets its entry after that.
- **Accepting** works like a note: automatically when the account has one vault, else
  offered; one notice for the whole folder. It lands at `<share folder>/<name>`
  (`<name> 2` when taken).
- **The explorer mark:** every shared folder is marked - one's own, and one someone
  shared, told apart - through a stylesheet the plugin keeps current
  (`.nav-folder-title[data-path="…"]`), so nothing of Obsidian's own elements is
  touched. A note in a shared folder keeps the mark the status bar has for a shared note.
- **The folder's menu:** "Who has access" (members, roles, revoke - the owner;
  the people in it - a member), and for a member "Make my own copy" (a fork of the whole
  folder) and "Leave".

### A new note (E1, E7.1, E7.3)

- **Owner or writer:** its id from the folder (Keys). The folder room gets its entry
  the moment the vault index does, on the same device - offline too - and the room is
  created on the server with the folder id.
- **Reader:** an ordinary note of their own, its id under their vault key, not in the
  folder. A notice once per folder: "You can only read 'X'; this note stays yours."

### Moving in (E2.1, E7.2)

- **The owner moves a note of their own in:** the window. [Share] makes it join;
  [Move back] moves it back. The window shows on every device of the owner until it is
  answered on one - live - and again after a restart while unanswered. A note someone
  else owns moved into the folder stays out, with a notice.
- **A writer moves a note of their own in:** the same window, worded for a copy ("becomes
  a note of <owner>'s and visible to …"). [Copy in] makes a new note of the folder at
  that place: its first frame is the old note's Yjs state, not its frames (Yjs keeps no
  deleted text, so no history goes along), and the old entry's tombstone names the new
  one (`forkedTo`), so the participant's other devices fold what they hold into it - the
  mechanism of `DocStore.forkInto`. The old note goes to the trash like any deleted one.
- **A reader:** stays their own (E7.3).

### Moving out (E2.2, E2.3)

- **The owner moves a note out:** one request takes it out of the folder: a new epoch
  under the owner's vault key again, sealed for its own members; the server keeps what
  each member of the folder could read for their fork (`keepForFork`), tells them
  (`share-removed`, the existing end of a share) and drops `folder`. The folder entry gets
  `leftAt` - a tombstone would make the others delete it. A notice: "'X' is no longer in
  the shared folder; B and C keep their copy." Moving it back in is a move in (E2.1),
  and the others then have it twice: their fork and the note.
- **A member moves a note out of the mount:** nothing changes for anyone else; for them
  the note lies elsewhere and no longer follows renames. A writer moving it back in
  renames it inside the folder.

### Renaming and moving inside (structure)

- **Inside the folder, by the owner or a writer:** the folder's path for the note or file
  changes, and every device moves it - if it lies where the folder had it - with
  `vault.rename` (invariant 22), in rounds (invariant 27).
- **The folder itself (E3):** the owner's `folders[F].path` follows, nothing reaches the
  others. A member moving or renaming the mount changes their `folders[F].path`. Taken
  from the folder's own rename event, before the events of its files are weighed.

### Deleting (E4)

- **The owner or a writer deletes a note or file in the folder:** its folder entry becomes
  a tombstone (who, when), and every other device applies it as a delete from another
  device. Right after, the device that deleted says so: "'X' was deleted for everyone in
  'F' (B, C). [Undo]" - several deletes in a row make one notice. Undo restores it for
  everyone.
- **The folder's trash:** "Deleted notes and files…" on the folder's menu lists the
  folder's tombstones for the owner and writers; restoring revives the folder entry and,
  through it, the note everywhere, from the room the owner still has. After the
  retention the owner's trash pass purges it like any deleted note: the owner's vault
  index holds its tombstone.
- **A reader deletes:** `declined` for their account (`${F}:${id}` in the vault index),
  so no device of theirs pulls it again; restoring it from their trash removes the record.
- **The owner deletes the folder:** the share ends for everyone first (below), then the
  notes go to the owner's trash; every member forks the whole folder.
- **A member deletes the mount:** they leave; nothing is kept for them on the server. Their
  files went to Obsidian's trash and to the plugin's backups like any deleted file.

### Revoking, leaving, ending (E4.3, E5)

- **Revoke** (the owner): one request with the folder's new epoch sealed for everyone who
  stays, and for every note in the folder that has members of its own the note's new key
  sealed for those (E6). The server, before anything is awaited (invariant 16): the folder
  epoch moves, every note room in the folder moves to a new epoch tied to it, `rekey` to
  everyone subscribed. Then, per room, what the person could read goes into their folder
  (`forks.ts`, one record per note, with the folder keys they held and the ties), and their
  devices hear `revoked`.
- **Their devices fork the whole folder:** each note as a shared note forks today
  (`Sharing.endShare`), where it lies; the files they hold - copies in their own store
  already - become their own; `folders[F]` gets `endedAt`; the mount is an ordinary folder.
  The notes they wrote into the folder fork like the rest.
- **Changing a role** is one request for the whole folder.
- **"Make my own copy"** (a member) is the same fork, started by them. **"Leave"** - and
  deleting the mount - keeps nothing.
- **The owner ends it** - deleting the folder, or "Stop sharing" for everyone: every member
  forks, the folder room is closed.
- **A removed account** (the sweep): an owner's folder ends as above; a member's
  membership goes as if they had left.
- **Content in a leaving member's store** that the folder names: the owner's device copies
  it into its own store and the entry names the copy; the server keeps it readable for the
  folder meanwhile, as it does for a fork.

### A note shared on its own as well (E6)

- **With C:** sharing it works as now. While it is in the folder its keys come from the
  folder's, sealed to C one by one; a revoke in the folder carries C's new key (above).
- **With B, who is in the folder too:** B's vault has the note once, where B had it; the
  mirror finds it outside the mount and leaves it there, as in E2.3. The server gives B the
  higher role; ending one share keeps the other; B forks only once neither is left. The
  share dialog lists such notes: "already shared with B; stays where B has it."

### Files (E8)

- **Every file inside the folder is an entry of the folder's `files`,** published by
  whoever has it: the content in their own store, attached to the folder room, its key in
  the entry. Every other vault copies it into its own store - as `SharedFiles` does for a
  shared note - and names it at mount + path with `folder: F`, so a link resolves as it
  does for the owner.
- **The rules are `SharedFiles`' and invariants 23 and 24:** a base per file per vault
  (`folderBases` in the vault index, the vault's and not a device's), `prev` on every
  entry, a version that never saw this vault's is a conflict and both are kept, a file is
  replaced or trashed only once the server holds its content.
- **Readers never publish;** a change of theirs stays and meets the next version as a
  conflict.
- **Canvases are files:** two people changing one at once get two of them.
- **Files outside the folder:** with `linkedFiles` on, every note of the folder carries the
  files it embeds or links as a shared note does (`SharedFiles`, into
  `<share folder>/Attachments/<link>`) - except links resolving to a file inside the
  folder, which travels with the folder already and must not come in twice.
- Each member's copies count against their own quota; the download limit applies as to
  any file.

## Server

- **`fld:` rooms** in `rooms.ts`: subscribe (the owner's vault connection, or a member's),
  push (owner and writers), `log`, `keys`, `snapshot` (the owner compacts), sealed keys,
  members, `revoked`, `acceptedInto`.
- **`MUX.subscribe`** gets a trailing optional `varString folder`; an older client sends
  none, so notes keep syncing between versions. `PROTOCOL_VERSION` 5, so the settings of
  a device say which side to update (`account/probe.ts`).
- **REST, sketched** (the shapes are settled while building, in `shared/types.ts`):
  - `POST /folders/share` - first share and every later person: folder id, account, role,
    with or without history, the sealed name, sealed folder keys or the rotation, the
    per-note keys from before joining.
  - `POST /folders/:id/notes/join` and `/notes/leave` - a note in or out (E2).
  - `POST /folders/:id/revoke`, `/role`, `/accept`, `/detach`, `/leave`, `/end`.
  - `POST /log/:room/start-snapshot` - a member's starting snapshot of a note, for a share
    without history.
  - Incoming folders in the answer to `GET /shares/incoming`, with a kind.
- **Notifications:** `folder-added`, `folder-changed`, `folder-removed`; per note
  `share-removed` as now. Older plugins ignore kinds they do not know.
- **Backups:** `belongsTo` counts a folder room and the notes in it for the vault of
  everyone who accepted it, and the owner's.
- **The sweep:** an owner removed ends their folders; a member removed leaves.
- **Forks:** a record per note as now, plus the folder keys the person held and the ties,
  so the device can read what was kept.

## Around it

- **Backups:** a member's backup holds the mount as it lies in their vault, the owner's the
  folder. `packages/backup` reads folder keys and ties.
- **Rolling back:** one's own folder goes back for everyone, as one's own shared notes do;
  someone else's stays. A rollback that would move a note out of one's shared folder ends
  its share as a move by hand would, and the plan says so before it runs.
- **Presence:** every note of a shared folder is `shared`; carets as in a shared note.
- **Exclusions:** the owner's decide what is in the folder. A member's keep a note of it out
  of their vault only - not pulled, like any excluded note.
- **Size:** a member's devices hold the folder's notes like their own, so
  `maxLoadedDocuments` applies; 0.9 lifts that.
- **Empty folders** do not travel; a subfolder appears with the first thing in it.
- **Every device needs 0.8, and the server first** - a plugin on 0.8 against an older
  server says the server is too old to share folders. A member's device on 0.7 sees the
  folder's notes as shared notes whose keys it lacks; they wait. A device of the owner on
  0.7 registers a new note in the folder under the vault key, and a device on 0.8 then asks
  about it as moved in - nothing is shared without the window.

## Only on a device

The explorer mark (Obsidian's DOM, desktop and phone), the windows and the undo in the
notice, the real order of Obsidian's events when a folder is renamed, moved or deleted.

## The small fixes

From `docs/PROGRESS.md`, "Roadmap"; investigated on 2026-10-22 (line numbers as of
`cebac26`). None needs a decision of the user's; each gets its test.

1. **Typing while sync restarts loses keystrokes.** `stopSync` lets every editor go
   as if for good (`main.ts:1120`, `EditorSync.ts:55`), the new `DocStore` starts with
   no `editorOwned` and no `held`, and settling the open note reconciles Obsidian's
   lagging save against the document and writes the file (`DocStore.ts:747`, `:763`).
   Obsidian reloads the editor, and what was typed meanwhile is gone - before the
   binding's `align`, which would have merged it, ever runs. Fix: a note shown in an
   editor is Obsidian's even while no binding holds it - the new store asks
   `EditorSync` (`shownInEditor`), settles such a note without writing its file, and
   leaves the merge of buffer and document to the binding (`resolveEditorEdits`,
   backups first); the old store's `held` passes to the new one for the same vault
   (invariant 25). A plugin reloaded loses the binding's `released` too; the worst
   left there is a duplication (invariant 4), never a loss. Test: `test:vault`, a
   device restarting with its views kept while two people type, every keystroke
   once, no backup, no review.
   **Built in 0.8.2.** Refined: nothing writes the file of a note shown but not bound
   (`writeToFile` skips it too), and the file is brought level once its editor closes.
   Where both typed across the restart the binding's merge takes its backups - a
   merge of two people's typing, as any (invariant 2); "no backup" holds where only
   the other one typed.
2. **Content uploaded but never named stays on the server.** A crash, stop, delete or
   rename between the upload and the index entry (`AttachmentStore.ts:539`, also
   `:578`, `:1050`, `:1331`) leaves a blob nothing names, and no route lists a vault's
   blobs. Two hazards next to it: content the server has already is never uploaded
   again, so its grace period is not renewed (`Blobs.ts:60`, `blobs.ts:137`), and a
   purge drops an upload still in progress without any grace (`blobs.ts:265`). Fix:
   an owner-only listing of a store's blobs (complete ones with their last touch,
   partial ones with their last chunk), a `touch` when an upload finds the content
   there, the grace for partial uploads too; the device then lets go of blobs no entry,
   tombstone, version, shared base or running upload names - only after the index
   synced this session, only those older than the retention (several days at least; a
   retention of 0 keeps everything). Shared notes' and folders' blobs stay protected
   on the server (`isAttached`). Invariant 23. Test: `test:recovery`.
   **Built in 0.8.3.** Refined: a touch answers which blobs are there, so content a
   purge took a moment before is uploaded again instead of named (`Blobs.keep`, used
   wherever a device skips an upload because the server has the content); uploads
   that never ended are let go of with the same age rule.
3. **A purged note's local copy stays on the other devices.** Only the purging device
   clears it (`Trash.ts:59`, `DocStore.forgetDeleted`); the others had dropped the note
   without clearing it (`DocStore.ts:1047`) and never open its database again. Fix: the
   trash pass, which runs on every device, clears the local copy of every tombstone with
   `purgedAt` that is not loaded, and remembers it did (`StateStore`) so no database is
   opened - and so created - again. The text was backed up when the file was trashed
   (invariant 2). Test: `test:vault`, after a purge B holds neither the note's database
   nor its history.
   **Built in 0.8.4**, as specified.
4. **A device's own socket comes back slowly after turning 2FA on** - a hypothesis to
   confirm with timestamps first. The server closes the account's sockets with `4401`;
   `Session.stillSignedIn` waits for the device's own request and then refreshes once
   more (`Session.ts:569`), and the socket then reconnects through the ordinary backoff
   of at least a second (`VaultSocket.ts:236`). A password change takes the same path.
   Fix: a token just confirmed reconnects at once with the backoff reset, and the extra
   refresh is skipped when the device's own request succeeded. Test: `test:account`,
   connected again within half a second after turning 2FA on and after a password change.
   **Built in 0.8.5.** Confirmed first: 1016 ms and 1011 ms from the close to the next
   connect. Refined: the refresh is skipped once per own request, within ten seconds
   of it - a second close is somebody else's -, and a server that could not be asked
   keeps the backoff, so a failing refresh never turns into a loop.
5. **A relay session survives signing the devices out.** `RoomHub.disconnect` closes
   vault sockets only (`rooms.ts:253`); the relay does not know a device's connection by
   account at all (`relay.ts:69`), and the token is checked only at the upgrade. Fix: the
   relay keeps devices' connections per account and closes them with `4401` on the same
   hook the vault sockets close on (all four triggers: password, recovery, 2FA, a removed
   account); the device closes its sessions before reconnecting its backup servers
   (`main.ts:669`). Test: `test:rooms` (the relay with fake sockets) and `test:backup`.
   **Built in 0.8.6**, as specified.
6. **Planning a rollback reads every note's log.** The server keeps no time of a room's
   last frame (`log.ts:49` has only the oldest), so `Rollback.ts:317` loads a history
   per note. Fix: an owner route like `compactable` listing the rooms of a vault with a
   frame at or after a moment; the time is the one held in memory on append, or the
   modification time of `log.bin` - never less than the truth, without writing `meta.json`
   for every frame. Planning then skips a live note whose path did not change and which
   is not listed, with an hour's margin: the server's clock is not the author's clock the
   rollback goes by. Test: `test:rooms` (across a restart and a compaction), `test:rollback`
   (the same plan with fewer reads).

## Tests

- **`test:merge`:** the folder key, the id key and ids, ties refused when they go back.
- **`test:rooms`:** a folder room's access; a note joining and leaving; subscribing with a
  folder creating a room owned by the folder's owner, refused for a reader and a stranger;
  the union of both ways in; revoke moving every epoch before anything is awaited and
  keeping a fork per note; role; end; purge sparing a folder's blobs; the sweep.
- **`test:vault`:** the owner with two devices, B (write) with two, C (read):
  - sharing with and without history, accepting, everything at its place in the mounts;
  - a new note by the owner, by B (the owner's, B's second device too), by C (C's own);
  - renames and moves inside, the folder renamed (nothing reaches the others), a member
    moving a note out (it stays, no longer follows);
  - the owner moving a note in (the window answered by a stub) and out (B and C fork it);
    B moving a note of their own in (a copy; B's second device folds into it);
  - B deleting a note: gone at the owner and C, undone; C deleting: declined; a note
    changed on C's device while B deleted it: kept;
  - revoking B: both of B's devices fork everything, the notes B wrote included;
  - E6: a note B had on its own stays where it was, both ways count;
  - files: published, delivered, a conflict kept twice, a canvas, a linked file outside
    the folder landing in `Shared/Attachments/`;
  - the owner deleting the folder: everyone forks;
  - after a crash: a note deleted in the vault without the folder's decision comes back.
  The fake vault learns to rename and delete a folder the way Obsidian reports it - an
  event for the folder and one per file, in either order.
- **`test:backup`:** a member's backup holds the mount.
- **`test:recovery`:** a folder room on a server restored from a backup is a room like any
  other (invariant 19).

## Order of work

Each step built with its tests, committed and pushed; a version for every build the user
installs.

1. `shared`: types, the folder key, ties and ids; `server`: folder rooms, access through
   the folder, the folder API, the sweep, backups; `test:rooms`, `test:merge`.
2. The plugin's keys (one function per note key) and the folder document; the mirror,
   without a dialog yet; `test:vault` for share, accept, new notes, renames.
3. Moving in and out, deleting, revoking, leaving, ending, with the windows and the
   notice; the dialogs, menus and the explorer mark.
4. Files in the folder, and linked files and notes outside it.
5. The backup server reading folders; `test:backup`.
6. The small fixes.

Steps 1 to 3 are **0.8.0** on `feat/folder-share`, merged once green so that the server
image the user needs is built; 4 and 5 are 0.8.1 and 0.8.2 on branches of their own; the
small fixes 0.8.3 onwards.

Taken into 0.8.0 while building (2026-10-23): the backup server reading folder notes
with the folder's keys. Without it, the first backup of a vault with a shared folder
would have failed as soon as 0.8.0 ran: a frame under a key that does not fit threw out
of the run. What stays for 0.8.2 is a backup server's own tests of members' folders over
time, and anything the files of 0.8.1 need.

Step 5 (2026-10-23) needed no code, only its tests: `test:backup` follows A's and B's
folders over time - what B writes and adds to A's folder, a note added to B's folder
later, a note A takes out and writes on, A revoking B, B ending its folder for A - and
after each a run restores exactly A's vault, every change readable, the decrypted copy
too. Nothing the user installs changed, so it took no version; the small fixes start
at 0.8.2.

Built in 0.8.1 (2026-10-23): step 4. Refined while building, without changing a
decision:
- Both versions of a file kept by someone who may write go into the folder as two
  files, so everyone keeps both - not only the account where the two met. A reader's
  second version stays theirs.
- Files outside the folder that its notes link: off unless the folder says so
  (`linkedFiles`); the dialog has it on by default, as the note's dialog has.
- The files need nothing of the backup server: every vault copies a folder's files into
  its own store, so a backup reads them as files of its own.
- A file deleted for everyone and brought back from someone's own trash comes back for
  everyone when they may write - as the folder's trash does for a note.
- What lay in a folder when it was shared goes in with the share and is never asked
  about as moved in (`sharedAt`); before, every device of the owner asked about each
  note while the share took it in.
- A delete another device of the account made in a folder is left to that device for
  half a minute before it counts as never decided on (the crash case of invariant 29):
  its decision travels a moment behind the delete itself.
