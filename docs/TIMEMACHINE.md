# The Time Machine (0.8.11, before 0.9)

Asked for on 2026-10-24 after testing 0.8.9; on 2026-10-25 the user agreed to the idea
as proposed below and asked for it before 0.9, which stays hardening only. On
2026-10-27 the user decided T2 to T8 ("Decided" below) and asked for it to be built.

## What the user asked for

- A slider over the past of **the vault, a shared folder, or a note**, a tick for every
  state in between, as in macOS's Time Machine. Moving it shows that state at once.
  **Apply** takes it over.
- A note's past is **read only** until applied.
- **Before anything is overwritten there is a backup**: for the vault on the backup
  server first, if one is set up, otherwise locally.
- Whether a note needs a backup of its own at all, since its document keeps its whole
  history: yes - the history reaches back only as far as the retention (30 days by
  default) and a compaction, and a restore is an edit like any other. Built in 0.8.9.

## What exists (facts, 0.8.10)

**A note's history** (`history/NoteHistory.ts`). `load()` fetches the note's whole
readable log (`GET /log/:room`: the newest snapshot and every frame after it),
decrypts it, and orders the changes by the author's clock, which lies inside each
encrypted frame. A **version** is a stretch of changes ended by a pause of more than a
minute (`SESSION_GAP_MS`); everything folded into the snapshot is one version.
`textAt(seq)` replays from the snapshot on every call, with nothing cached.
`HistoryModal` lists up to 200 versions, renders the chosen one (embeds fetched if the
vault lost them), and restores it after a local backup (0.8.9).

**The vault's or a folder's past** (`history/RoomHistory.ts`, `sync/Rollback.ts`).
The vault index replayed to a moment (`stateAt(ts)`) gives every note's and file's
path, whether it existed, and each file's content hash. A note's text then comes from
its own history. `Rollback.plan(moment, folder)` reads only the notes the server saw
change since then (`GET /changed`, with an hour's margin), each in full, six at a time.
Whatever the history no longer reaches is filled from the newest backup at or before
the moment, by path, over the backup server's relay session. `apply` does these steps
in order:

1. a fresh run on every backup server (`keepAll`);
2. a copy of everything it will change into the plugin's `rollbacks/`, refused
   without the copy unless agreed;
3. a `rollback:<id>` record;
4. trashing, moving back, reviving and editing, the way a person would, so every device
   follows and it can be undone.

`RollbackModal` takes a moment to the minute, lists the plan and gates the button.

**Files' past.** The index's `versions` map holds every content a file had. A file's
state at a moment is its hash in the replayed index, shown if the server still holds
that blob.

**The server** stamps every frame with its own clock when it arrives. The author's time
is inside the ciphertext. Per-frame times sit in each frame's header on disk, but no
route serves them without the content.

**Obsidian views.** The plugin has none yet: every window is a `Modal`.

## The proposal (T1 to T8, with a recommendation each - the user decides)

**T1 - A view of its own, never the real files.** An Obsidian tab (`ItemView`), on a
phone a full screen. Opened from a note's menu, a folder's menu, the command palette
and *Settings → All devices*. Nothing in the vault changes until *Apply*. Changing the
real files while sliding would send every intermediate state to every device and every
person the folder is shared with, and take it back a second later.
*Agreed in principle on 2026-10-25.*

**T2 - What a tick is.**
- *A note:* a version as the history has them: typing ended by a pause of a minute.
- *A folder or the vault:* a moment when anything in it changed - a note's text, a
  note or file added, renamed or deleted - with changes less than **five minutes**
  apart taken as one tick.

A tick per change would be a tick per few keystrokes. The slider snaps to ticks, and
*earlier* / *later* step through them. *Recommended: the two pauses above; to decide:
the five minutes.*

**T3 - Finding the ticks of a folder or the vault without reading every note.** The
slider needs every note's change times before anything is shown. Reading every note's
log for that is what 0.8.8 took out of the rollback: minutes and much traffic on a
large vault.

*Recommended:* a new server route lists, per room of the vault, the times its frames
arrived (`GET /times?vaultId&since`, rounded to the minute, nothing else). The server
knows these times already, so this tells the account's own devices nothing new. Only
the note you look at is read in full.

One difference to know: an edit made offline gets the time it reached the server, not
the time it was written. The preview of a tick goes by the authors' clocks, as the
rollback does. *Needs a server update, like 0.8.8's `/changed`.*

**T4 - The preview.** *Recommended:*
- **Left:** the tree as it was at the tick, from the index replayed. It is replayed
  forward step by step while sliding, so it follows the slider at once after a single
  download. Each entry is marked against now: *would come back*, *would go*, *moved*,
  *changed*.
- **Right:** the chosen note as it was, rendered, read only, with a toggle to its
  source, and to the changes against now. Its history is loaded when it is chosen and
  kept while the view is open, and texts are replayed incrementally, not from the
  start each time. A picture or PDF shows the version of the tick, if the server still
  has it.

**T5 - Apply.** *Recommended:*
- **The vault or a folder:** the existing rollback to the tick's moment. Its list of
  what changes comes first, as a step in the view. Then the backups (the backup server
  if set up, then the copy in `rollbacks/`), then the rollback, which every device
  follows and which can be undone. The user's rule - always a backup first - is
  already that rollback's gate and stays it.
- **A note:** the restore, with its local backup first.
- **In the vault's or a folder's view, one note alone:** *Restore just this note* next
  to *Apply*. *To decide.*

**T6 - Before the history reaches.** The history reaches back as far as the retention
(30 days by default). Further back, each backup run could be a tick of its own, drawn
differently. Its preview would be read from the backup server by path: slower (it lists
the whole backup first), and with nothing between two backups. *Recommended: a last
step of its own, optional; to decide whether wanted at all.*

**T7 - The existing windows.** *Version history* (a note) and *Roll back…* (the vault,
a folder) do what the Time Machine does, in a list. *Recommended:* both stay until the
Time Machine has worked on the user's devices, then it replaces them.

**T8 - Shared notes.** *Recommended:*
- **A participant** sees the past of notes others share, as far as their history
  reaches. *Apply* leaves those notes alone, and the view says so: the owner rolls them
  back, for everyone (the rule since 0.7.8).
- **A note shared to read only** cannot be applied.

## Decided (the user, 2026-10-27)

- **T1, T4, T8** as recommended.
- **T2:** a note's ticks are its versions (a pause of a minute), a folder's or the
  vault's are changes less than five minutes apart taken together.
- **T3:** the server route, `GET /times`.
- **T5:** *Restore just this note* (and *this file*) next to *Apply*.
- **T6:** backups as ticks, behind a switch in the view the user turns on when wanted -
  off unless turned on, remembered on the device.
- **T7:** the old windows go at once - the user does not use the plugin productively
  yet. *Version history* of a note and *Roll back…* are replaced; a file's *Version
  history* (an image's earlier contents) stays, it is not a tick of a document.
- Built as one version, 0.8.11: the user tests it as a whole.

## How it is built

**The server: `GET /times?vaultId&since`** (`RoomHub.frameTimes`). Per note room of the
vault, the minutes (`floor(ts / 60 000)`, ascending, each once) in which frames arrived
at or after `since`, by the server's clock. Only frames the caller may read: from their
start in the note (`fromSeq`). A loaded log answers from memory; any other is read from
`log.bin`, headers only, and only when the file changed since `since`.

**The backup server: `backupTimes`** (a session call). The times of the vault's notes
snapshots, over its repositories, ascending. A tick's backup is then `backupAt(time)`.

**The timeline** (`history/Timeline.ts`, `history/NoteHistory.ts`, `history/RoomHistory.ts`):
- `NoteHistory` - one note's history: its versions as ticks, and the text at any
  moment, replayed forward from where it stood and from a checkpoint every 200 changes
  when going back (`Replay`).
- `VaultTimeline` - the vault index's history walked once into a list of entry events
  (a note or file added, moved, deleted, its content changed), the minutes from
  `/times`, and the ticks of the vault or one folder from both: every moment a note or
  file in it changed, its path then decided by the events; moments less than five
  minutes apart are one tick, which shows the state two minutes after its last change,
  before the next tick's first (the server's minutes are rounded down, and an author's
  clock may run ahead). The entries at any moment are the events replayed - no document
  is replayed for a tick. Whether a note changed after a moment comes from the minutes.
  A server before 0.8.11 answers `/times` with 404: then only the index's events make
  ticks, and the view says so.
- Text at a tick goes by the authors' clocks, as the rollback does.

**The view** (`history/TimeMachineView.ts`, an `ItemView`): a slider over the ticks with
*now* as its last place, *earlier*/*later*, the moment and how much changed in it. For
the vault or a folder, on the left the tree at the tick, by default only what differs
from now (*would come back*, *would go*, *moved*, *changed*), on the right the chosen
note or file; for a note, the note alone. The note is rendered, as source, or as its
changes against now. *Restore this version* for a note; for the vault or a folder,
*Apply…* (the rollback's list, its backups and its gate, `history/ApplyModal.ts`, which is
what is left of `RollbackModal`), *Restore just this note/file*, and the earlier
rollbacks with *Undo…*. Opened from a note's and a folder's menu, the command palette and
*Settings → All devices*.

**Backups as ticks** (the switch): the backup runs further back than the history
reaches, drawn apart. The tree comes from the backup's listing, by path, a note's text
from the backup; *Apply* is the rollback to that moment, which reads the backup itself.
A note's own Time Machine reads its backups by the path the note has now.

Tested: `/times` in `test:rooms`, `backupTimes` in `test:backup`, the timeline -
ticks of the vault and of a folder, entries and texts at a tick, a note's ticks - in
`test:rollback`. The view only on a device.

## Found on the way

`Rollback.planFromHistory` left alone files a shared *note* brought (`via`), but not
the files of someone else's shared *folder*. A member's rollback would have trashed a
picture that came into the folder after the moment, and in a folder a writer's delete
is everyone's. Fixed in 0.8.10, with a test, before the Time Machine builds on it.
