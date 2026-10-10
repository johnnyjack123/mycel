# Phase 4 — attachments (0.5)

Agreed with the user on 2026-10-10; the specification the implementation follows.
Order of work, each step with its tests and a commit:

1. Attachments between one's own devices.
2. The trash and earlier versions of attachments.
3. Attachments of shared notes, and sharing the notes a note links to.

The first build the user installs is 0.5.0, every later one a patch.

The rules are the ones that hold for notes: the server learns nothing it does not have
to, and nothing it does can destroy a file on a device. What the server can see:
how many blobs there are, their sizes and when they come and go, and which blobs
belong to which shared note. It sees no names, paths or content.

## What is synced

- Every file in the vault that is not Markdown: images, PDFs, audio, video, `.canvas`,
  anything else. Markdown stays on the CRDT. Everything else is an immutable,
  encrypted **blob**. `.canvas` is JSON, and two edits of it cannot be merged
  safely, so it is a blob like the rest.
- Not synced: what the exclude globs match (the same list as for notes), Obsidian's
  config folder and everything else Obsidian hides (dot folders; plugins and their
  settings are 0.7), and files over the server's limit.
- A file over the limit stays on the device, and the log says so once. *(A mark in
  the file's menu is not built yet.)*

## Identity: the vault index

The index document gets two maps next to `files`. They are separate because a device
on 0.4 treats every entry of `files` as a note.

```ts
// ATTACHMENTS_FIELD: fileId -> AttachmentEntry
interface AttachmentEntry {
  path: string
  /** SHA-256 of the content, hex. A device compares its file against this. */
  hash: string
  size: number
  updatedAt: number
  /** The content this one replaced, as its writer knew it. */
  prev?: string
  deletedAt?: number
  purgedAt?: number
  /** The file came in through a shared note, under this link. Absent for the vault's own. (step 3) */
  via?: { docId: string; ref: string }
  /**
   * Where the content lives while it is someone else's blob: until the file is
   * changed here or the share ends. Absent once the content is in this vault's store.
   */
  remote?: { account: string; vault: string; blob: string; key: string }
}

// VERSIONS_FIELD: `${fileId}:${hash}` -> { fileId, hash, size, since, at }
```

- **`fileId`** = HMAC(vaultKey, `file::<path>::<generation>`), taking the first
  generation the index does not know. This is `deriveDocId` with a label of its own,
  and invariant 5 holds for it the same way. Two devices adopting the same file reach
  the same id, and a rename keeps it.
- **The blob of a file of the vault's own** follows from its hash (below), so the entry
  stores only the hash. An entry with `remote` points into someone else's store until
  the file is changed here or the share ends.
- **Earlier versions** are kept in a map of their own, with one key per version and
  nothing else written there. Two devices recording versions at once therefore never
  overwrite each other, which they would if the versions were a list inside the
  entry. Every replacement is recorded by the device that made it, with `since` (when
  that content became current) and `at` (when it was replaced). Whether its content
  is kept is step 2's business: a version that was current for less than 10 minutes
  is not, so a file a program rewrites every few seconds does not fill the store.
- **An entry is replaced whole.** Of two devices writing the same file at once, one
  write is simply gone from the index, and its device would take the other version
  for news and overwrite its own. So every entry names what it replaced (`prev`), and
  the version records double as the file's lineage: a device takes another version
  only if that version replaced its base knowingly - `prev` or a version record says
  so. Otherwise both are kept. The same holds for a delete: a file goes only if
  whoever deleted it had seen this device's content. *(As built; found while
  building, checked in `test:vault` by holding back both devices' index changes.)*
- Deleting writes a tombstone, as for notes.

## Blobs

```
hash     = SHA-256(plaintext)
blobId   = HMAC(HKDF(vaultKey, "obsidian-connect blob-id"), hash)    128 bits, hex
blobKey  = HKDF(vaultKey, "obsidian-connect blob:<blobId>")
```

- **Content-addressed:** the same content gives the same blob. Uploading again changes
  nothing, two devices adding the same file upload it once between them, and a device
  can tell from the index alone whether its file is the version the index names. The
  id is keyed, so the server cannot test whether a vault holds a file it knows.
- **The key is derived,** so nothing is stored. It leaves the vault only inside a
  shared note's attachment list (step 3).
- **Format:** the plaintext is cut into 4 MiB chunks; the last one is shorter, and an
  empty file is a single empty chunk. Chunk *i* of *n* is AES-256-GCM under a fresh IV
  with associated data `blob:<blobId>#<i>/<n>`, so a dropped, reordered or swapped
  chunk fails to decrypt. On the server the chunks lie end to end, each
  `iv(12) ++ ciphertext ++ tag(16)`, so chunk *i* starts at `i × (4 MiB + 28)`.
- **After downloading,** the device checks the plaintext's hash against the entry
  (or, for a shared one, against the list).
- **Memory:** Obsidian reads a file whole, and WebCrypto hashes it whole, so a file
  sits in memory a few times over while it is hashed and encrypted. That is one
  reason for the size limit. Downloads and re-encryption go chunk by chunk, and at
  most 64 MB of file content is in hand at once; a larger file runs on its own.

### New invariants

- **An entry never names content the server has not confirmed.** Upload first, then
  write the entry, like the outbox for notes. A device that sees an entry can always
  fetch it.
- **A local file is overwritten or trashed only once the server holds its content.**
  This is invariant 2 for files: the blob is the backup, restorable for the
  retention. Before replacing or trashing a file, the device asks whether the server
  has its blob and uploads it if not. That covers a server that lost data.
- **Without a base, never delete; conflicts keep both** (invariants 3 and 4,
  unchanged). For a file, "keeping both" means two files.

## Server

```
users/<account>/<vault>/blobs/<blobId>           the chunks, end to end
users/<account>/<vault>/blobs/<blobId>.json      size, created, the rooms it is attached to
users/<account>/<vault>/blobs/.upload/<blobId>   an upload in progress
```

Routes. They all need a token, and every one names whose store and which vault, so
reading someone else's store in step 3 needs no new ones. The vault must be the
caller's unless stated otherwise *(as built)*:

- `POST /blobs/:account/:vaultId/have {ids}`: which of these are complete.
- `GET /blobs/:account/:vaultId/:blobId`: `{ complete, count, received, size }` - for
  an upload under way, how many chunks arrived, so it can resume.
- `PUT /blobs/:account/:vaultId/:blobId/:chunk?count=n`: one chunk, raw
  `application/octet-stream` (not base64 JSON). Chunks arrive in order; one the
  server has already is acknowledged again. Every chunk but the last has exactly the
  full size, which keeps the offsets computable. The last chunk completes the blob.
  If the blob is already complete, the first chunk is answered "complete".
- `GET /blobs/:account/:vaultId/:blobId/:chunk`: one chunk. With `?room=doc:<docId>`
  allowed to anyone who may read that room, if the blob is attached to it, and to
  someone whose share of that room ended and who has not forked yet (step 3).
- `POST /log/:room/attachments {attach, detach}`, each a list of
  `{ account, vault, blob }`: which blobs a shared note's list names. Attaching is
  allowed for one's own blobs in a room the caller may write to. Detaching is allowed
  to the blob's account and to the room's owner. The room's `meta.json` and the
  blob's `.json` both record it.
- `POST /blobs/:account/:vaultId/purge {ids}`: deletes those blobs and keeps every one
  still attached to a room. Answers which ones went.
- `.env`:
  - `OBSIDIAN_CONNECT_MAX_FILE_MB`: default 100, shown in `/auth/config` so the
    plugin does not try larger files.
  - `OBSIDIAN_CONNECT_QUOTA_MB`: per account, default none. With open registration,
    this is what keeps a stranger from filling the disk.
  - Over a limit the server answers 413 or 507. The device keeps the file, says so
    once, and tries again later.
- Purging a room detaches its blobs. The account sweep deletes the folder with
  everything in it, and invariant 21 is unchanged.

## Step 1: one's own devices *(built, 0.5.0)*

`sync/AttachmentStore.ts`, next to `DocStore` and not inside it, with
`sync/AttachmentIndex.ts` (the two maps) and `sync/Blobs.ts` (transfers). It has one
lock per `fileId`, the way `DocStore` has one per note, and takes memory only after
the lock and never nested.

**Per device,** `StateStore` keeps `fileId -> { path, mtime, size, hash }`: the
version this device last saw its file and the index agree on. This is the **base**,
like the base text for notes. `mtime` and `size` save hashing an unchanged file on
every start.

**Something changed here** (create or modify, 2 s after the last write since
programs write in pieces; or the scan finds `mtime` or `size` different from the
state):

1. Read the file and hash it. If the hash equals the entry's, record agreement. That
   covers the device's own write coming back and a mere touch.
2. Upload it, unless the server already has it.
3. Under the lock, look at the entry again:
   - **No entry:** `ensure` a `fileId` and write the entry.
   - **The entry still has the base's hash:** write the new hash with `prev`, and
     record the replaced version.
   - **The entry moved on** (another device changed the file too), or there is no
     base: this is a conflict. The index's version is downloaded first - if that
     fails, nothing has changed and nothing is left behind to duplicate. Then this
     device's content becomes a new file `<name> (conflict <YYYY-MM-DD HHmm>).<ext>`
     next to the original, with an entry of its own (it is uploaded already), and the
     original path gets the index's version. A notice names both files.
   - **The entry is a tombstone:** an edit here wins over a delete there, as for
     notes, so the entry is revived with this content.

**Something changed elsewhere** (an index change, the same pass as for notes):

- **A live entry with no file here and no state:** pull it if it is within this
  device's download limit, otherwise leave it until a note needs it (below). A file
  that is not here was not deleted, as with notes today.
- **The entry's hash differs from the base:**
  - The file here still has the base's hash, and the new version replaced that base
    knowingly: download the new version, check it, `modifyBinary`, record the new
    base.
  - The file changed here too, or the new version never saw this device's: the same
    conflict as above.
- **A rename:** `vault.rename`, never `fileManager.renameFile`. The links in notes
  have already been rewritten on the device that renamed the file, and those edits
  travel with the notes. Rewriting them here again would insert them twice.
- **A tombstone:** if the file here still has the base's hash, it goes to the trash
  with `fileManager.trashFile`, so the user's trash setting applies. If it changed
  here, it is revived with this device's content, and a notice says so.
- **Two vaults meeting for the first time,** with the same path and different
  content: there is no base, so both are kept. The index's version takes the path,
  and this device's becomes the conflict copy.
- **Two ids at one path** (a rename racing between devices): with the same hash, the
  sorted-first id stays and the other gets a tombstone; with different hashes, the
  other becomes a conflict copy.
- **A deleted folder** sweeps its attachments, like `onDeleteFolder` for notes.
- **A file gone without an event** - deleted while Obsidian was closed - is fetched
  again, as a note is, rather than deleted everywhere.
- **A note renamed to another extension** (`Draft.md` to `Draft.txt`) is a deleted
  note and a new file. Before, the note's entry stayed and was pulled back in next to
  the file. *(As built; `DocStore.onRename`.)*

**The download limit** is set per device in `data.json` as
`attachmentDownloadLimitMb` - in the settings an empty field, stored as -1, means
everything, and 0 only what a note needs. The default is everything on desktop and
10 MB on a phone (`Platform.isMobile`).

- Larger files come when a note that embeds or links them is opened. The note's
  unresolved links are matched against the index by exact path, path suffix and name.
- The note's menu offers "Download attachments", and the settings offer "Download
  everything now".
- Files created on a device are always uploaded, whatever its limit.

**Self-healing:** on start and on every reconnect - a server that comes back may be
one restored from a backup - each device sends one `have` with the blobs of every
file it holds, and uploads what the server lacks. A server that lost blobs therefore
gets them back from any device that still has the file (`test:recovery`). A download
that finds no blob is tried again 30 s later. Invariant 19 is unchanged for the
index: structure keeps the union.

**A server from before attachments** says no `maxFileBytes` in `/auth/config`; the
plugin then syncs notes only and says so in the log.

**The status bar** shows transfers while they run, for example `↑2 ↓1`.

## Step 2: the trash and earlier versions

- **"Deleted notes…" becomes "Deleted files…"** and lists notes and attachments, with
  the same history retention. Restoring an attachment revives its entry at its path,
  or as `<name> (restored).<ext>` if the path is taken, and downloads it.
- **"Earlier versions…"** is in an attachment's menu. It lists the versions within the
  retention, with a preview for images. Each can be restored, which is an edit, so
  the current version becomes a version in turn, or saved as a copy next to it.
- **Cleaning up** runs on any device of the account, in the trash pass:
  - A blob of the vault's store goes when none of these still names it: a live
    entry, a tombstone within the retention, or a version within the retention. The
    server keeps whatever is attached to a room.
  - Version records past the retention leave the map, and tombstones get `purgedAt`.
  - A retention of 0 keeps everything.
- **Space:** a 20 MB PDF annotated in ten sittings keeps ten versions, 200 MB, for
  the retention. The settings show the account's total as the server reports it.

## Step 3: shared notes

### The attachment list

Every shared note's document carries, next to its `content`, a `Y.Map`
(`NOTE_ATTACHMENTS_FIELD`). Each link that appears in the note maps to:

```ts
interface SharedAttachment {
  /** Whose store holds the content. */
  account: string
  vault: string
  blob: string
  /** The blob's key, base64. Readable to whoever can read the note, and to no one else. */
  key: string
  hash: string
  size: number
  updatedAt: number
  /** The account that set this version. */
  by: string
}
```

The note's settings sit in a second small map, holding for now only `attachments:
boolean`. It is the owner's choice per note, not per person: everyone in a note
reads the same document. The share dialog sets it, and "Access…" changes it later.

Because the list lives in the note's document, it is encrypted under the note's
epoch key and has the note's history. Revoking and forking apply to it with no extra
work, and the server needs only the attach records. The list is never written into
a pristine document. Doing so would stop the note's file from being seeded
(invariant 18).

- **A ref is the link path** as Obsidian's metadata cache reports it (embeds, and
  links to files that are not Markdown), without `#…` and `|…`, and decoded for
  Markdown-style links. Links to notes are not attachments.
- **Publishing:** a device with write access to the note publishes a ref when the
  link resolves, in its own vault, to a file whose content differs from the list's
  and the file changed here since this device last agreed with the list. In that
  case it uploads the content to its own store, attaches the blob to the room and
  writes the entry. If the list is what changed, it applies the list instead. This
  is the same three-way rule as in step 1, with a base per (note, ref) kept on the
  device.
- **Delivering:** a ref with no file behind it here becomes an entry with `via` and
  `remote`, at
  `<share folder>/Attachments/<ref>` with leading `./` and `../` removed. Obsidian
  also resolves a link by the end of its path, so `![[Assets/diagram.png]]` finds
  `Shared/Attachments/Assets/diagram.png`. This applies to everyone, owners
  included: whatever came in through a share lands in one place. If that path is
  already taken by something else, the file goes to
  `<share folder>/Attachments/<note title>/<ref>`. Afterwards
  `getFirstLinkpathDest(ref, notePath)` checks that the link really resolves to
  this file. If a file of the user's own with the same name wins instead, the log
  and a notice say so. Links are never rewritten, because that would change
  everyone's text.
- **A delivered file belongs to the vault** like any other. It is in the account's
  index, so the account's other devices see it, and the download limit applies. Its
  content stays in the sharer's store (`remote`) until the file is changed here.
  Changes are always uploaded to one's own store, and the entry then drops `remote`
  and keeps `via`. This mirrors notes: a shared note lives in its owner's folder,
  and the recipient's index only points at it.
- **Read access only:** the device never publishes. An edit stays local, and the next
  version from the list is a conflict, so both are kept.
- **Removing a link** from the note: a writer's device drops the ref from the list.
  The files others received stay with them; there is no remote delete. The owner's
  device detaches blobs that have not been in the list for longer than the retention.

### Deleting means leaving that file

Deleting a file that a shared note's list names, whether the file was delivered or
is one's own, records `<docId>:<ref>` in the index under `declined`.
No device of the account delivers or applies that ref again, not even a new version.
The file stays with everyone else, and the note stays shared. Restoring the file from
the trash removes the record, and the file follows the list again.
For a delivered file, the list's entry and the tombstone's `via` say which ref it
was. For a file of one's own, the device checks the lists of the shared notes that
link to it (`metadataCache.resolvedLinks`).

### When a share ends

Invariant 20 extends to files. The forking device copies every delivered attachment
of that note still pointing into someone else's store into its own: download a
chunk, decrypt, encrypt under its own key, upload. The hash is known from the
list, so the new `blobId` is known before reading anything, and no file has to fit
in memory. The server keeps those blobs readable for the former member until their
fork is done, as it keeps the frames. Files above a device's limit are copied all the
same; the copy goes to the store, not to the disk.

### The share dialog

- **"Share the attachments"** is on by default. The description gives the count and
  size, for example: "3 files (4.2 MB) this note embeds or links go along, and
  whatever the other side adds comes to you. Applies to everyone the note is shared
  with."
- **"Also share the notes it links to"** is off by default and appears when the note
  links to other notes. It names how many there are and lists them, following links
  recursively; notes that cannot be shared are listed as such (someone else's,
  excluded, not synced yet). It acts once, when the share is created, and shares
  each listed note with the same person, access, history and attachment choice.
  Links added later are not shared automatically, because that would share notes
  without anyone having seen the list.
- **Linked notes land below the share folder at their link path,** so links between
  them resolve: `[[Projects/Plan]]` becomes `Shared/Projects/Plan.md`. For that, the
  sealed title may carry folders.

## Tests

- `test:merge`: blob encryption (chunks, a chunk dropped, reordered or swapped, the
  last chunk dropped, an empty file), deriving ids.
- `test:rooms`: the blob routes, limits and quota, access through a room, purge
  sparing attached blobs, the sweep.
- `test:vault`: the fake vault gets binary files (`readBinary`, `createBinary`,
  `modifyBinary`) and, for step 3, a small metadata cache. Covered there:
  - create, modify, rename and delete across three devices;
  - a conflict, two vaults meeting, the download limit;
  - a remote delete of a file changed here;
  - for step 3: publishing, delivering, declining, read access, and the fork copy.
- `test:recovery`: a server that lost its blobs gets them back.

## To verify on a device

- Obsidian resolving a link by the end of its path, and which file wins when two
  share a name.
- Binary writes and the events they fire, `requestUrl` with binary bodies on mobile,
  and memory with large files on a phone.
