# The Time Machine (0.8.x, before 0.9)

A draft, to be decided with the user before anything is built (CLAUDE.md: a milestone's
design is written with the user first). Asked for on 2026-10-24 after testing 0.8.9;
on 2026-10-25 the user agreed to the idea as proposed below and asked for it before
0.9, which stays hardening only.

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

## Order of work (if agreed)

1. **Server** `GET /times`. **Plugin:** a timeline layer - ticks, the state at a tick,
   incremental replay, a cache of notes' histories while open. Tested in
   `test:rollback` and `test:rooms`.
2. **The note's Time Machine:** the view with the slider over one note's versions, the
   preview (rendered, source, changes), *Apply* = restore. The smallest useful piece,
   to try on a device first.
3. **The vault's and a folder's Time Machine:** the tree, the preview, *Apply* through
   the rollback's list and gate, *Restore just this note*.
4. **Optional:** backups as ticks (T6). Then the old windows go (T7).

Each step is a version of its own (0.8.11 onward).

## Found on the way

`Rollback.planFromHistory` left alone files a shared *note* brought (`via`), but not
the files of someone else's shared *folder*. A member's rollback would have trashed a
picture that came into the folder after the moment, and in a folder a writer's delete
is everyone's. Fixed in 0.8.10, with a test, before the Time Machine builds on it.
