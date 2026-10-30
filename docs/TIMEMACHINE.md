# The Time Machine (0.8.11, before 0.9)

Asked for on 2026-10-24 after testing 0.8.9; on 2026-10-25 the user agreed to the idea
as proposed below and asked for it before 0.9, which stays hardening only. On
2026-10-27 the user decided T2 to T8 ("Decided" below) and asked for it to be built.
On 2026-10-29 the user tested it and asked for a second round: fixes, built as 0.8.12
("How it is built"), and a timeline as in macOS, the past in the note and in the
explorer, and a notification center - proposed under "The second round", for the user
to decide.

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
*Settings → Backups* (0.8.12; *All devices* before).

**Now and the newest tick** (0.8.12). A tick shows the state after its changes, so the
newest one showed exactly what *now* shows - the user saw two identical places at the
end of every slider. The newest tick is left out when it shows what now shows (a note:
its newest version is its text now; the vault or a folder: nothing differs from now in
the index), and *now* names when that last change was. A note's version that left its
text as it was (a change beside the text, such as its shared files) is no tick either.

**Changed since, exact** (0.8.12). The server's minutes say only that a note took a
change after a tick; a note restored to what it said then took changes and says the same.
The notes they name are compared by their text at the tick against their text now (up to
200 per tick, six read at once, each history read once while the view is open); beyond
200 the view says the marks are the server's word. The text *now* is the note's document
where that is ahead of its file - a change still to be written, or an editor Obsidian
saves when it likes: read from the file, the restore showed the text it had replaced.

**After a restore** (0.8.12): a note's Time Machine moves to *now* at once and shows the
restored text; the vault's or a folder's stays at its tick, so more can be restored. Once
the server has the restore, the past is read again quietly - what is shown stays until
then.

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

## The second round (proposal, 2026-10-29 - the user decides U1 to U5)

The user tested 0.8.11: it works, rolling back a folder and the vault went through.
Fixed at once in 0.8.12: the preview of *now* after a restore, the button moved to
*Backups*, the newest tick that equalled now, *changed since* compared by text. Asked
for besides:

- **A timeline as in macOS** (a sketch in `reference/`, not in the repository): upright,
  at the right edge of the note; a bar per tick, labelled with date and time; a click
  goes there; the bars grow towards the pointer as in the Dock, like a wave.
- **A note:** no tab of its own - the note's own view turns read-only and shows the
  past, the changes visible in the normal editor.
- **A folder or the vault:** the same timeline, and the past applied in the explorer
  itself, the folder or the vault locked meanwhile and backed up first, locally too -
  to walk through the real vault as it was, read-only, which is easier to picture than
  a tree. The view of 0.8.11 stays as the overview of what differs, opened beside it.
- **A notification center:** the notices that vanish after a few seconds, kept in a view
  of the plugin.

### What Obsidian allows

- A plugin draws what it likes inside its own views, may lay elements over another
  view's content, and gives every editor CodeMirror extensions of its own (the binding,
  the read-only editor of a note shared to read).
- **The explorer shows only files that exist.** There is no API for a file that is not
  there or for another state of a file: the past in the explorer means the past
  written into the files.
- **There are no file locks.** A plugin can make editors read-only and switch a view to
  reading mode, and hears every create, change, rename and delete - afterwards. It
  cannot stop the explorer's rename, delete or drag, or another plugin writing.
- **A text in an editor is saved to its file** by Obsidian when it likes, so the past
  shown in the editor itself is the past written to disk.
- **A file written while sync runs is an edit**, sent to every device and to everyone
  the note is shared with - T1's reason, and the one danger of everything below.

### U1 - The timeline

An upright strip at the right edge. A bar per tick, the oldest at the top and *now* at
the bottom, as in macOS. At rest a bar is a short line; within about 120 px of the
pointer the bars grow in length and thickness, falling off smoothly with the distance -
the wave -, and the one under the pointer shows its label: date, time, what changed. A
click goes there, the arrow keys step, *Esc* goes back to now. On a phone a finger
drawn along the strip magnifies the bar under it, lifting it goes there. Backups (the
switch of T6) in a colour of their own above the history's ticks.

Bars are spaced by order, not by time: by time, a busy hour crowds into a line and
quiet weeks leave the strip empty. Where more bars than fit (4 px each at the least),
the strip scrolls. *Recommended:* that, with a label only on the bar under the pointer
and its neighbours as they grow, and a small date wherever a day begins ("Today",
"Yesterday", "27 Oct") - two hundred labelled bars do not fit. The horizontal slider
goes.

### U2 - A note: in its own tab

The note's tab stays. Over its editor lies a layer of the plugin's, in the same place:
the note at the tick, rendered as Obsidian's reading view renders it, or its text with
the changes against now marked in it (struck through: there now, would go; marked
green: there then, would come back), the strip at its right edge, and a bar above with
the moment, *Restore this version* and *Done* (or *Esc*). The editor beneath is made
read-only for that note by the plugin's editor extension, and nothing is written - so
nothing syncs. *Done*, or another note opened in the tab, ends it.

Not the editor itself: the past put into the editor is saved to the file by Obsidian
and sent by the sync, so every tick slid over would reach every device. The layer looks
like the note and touches nothing. Its limit: Obsidian's live preview (the editing mode
with rendered Markdown) cannot be made by a plugin for a text that is not the file, so
the layer renders like the reading view, or as text.

*Recommended:* this is a note's Time Machine from then on, opened from the note's menu,
the command, and a clock in the note's header; the tab of 0.8.11 stays for folders and
the vault.

### U3 - A folder or the vault: in the explorer

In this order:

1. **Ask**, in a window over everything: the folder shows its state of that moment in
   the explorer; sync pauses on this device until the Time Machine closes; the folder
   is read-only meanwhile.
2. **Pause the sync on this device, entirely** - as if it were offline. The other
   devices go on. Entirely, because the sync must not see the files of the past:
   teaching each of its parts (notes, files, shared folders, trash, renames, the scan
   every minute) to look away from one folder is many places, and one missed is the
   damage T1 avoids. Paused, the device is one that went offline, and afterwards it
   catches up the way every device does after being offline - a path that runs every
   day.
3. **Copy first.** Everything the preview replaces, hides or moves is copied into the
   plugin folder (`timemachine/`), with a journal of every step, written *before* the
   step. Nothing reaches a server: the past comes from the history, and the present
   stays in the notes' documents and in the copy. This copy is the "backup first,
   locally too"; the backup server runs before *Apply*, as now.
4. **Write the past** through Obsidian's vault, so explorer, search, graph and links
   show it: notes get their text then, files their content then (from the server),
   what was deleted since is created, what came later moves into the copy and leaves
   the explorer, what was moved goes back. Another tick changes only what differs
   between the two ticks.
5. **Read-only:** every note in the folder opens in reading mode and its editor refuses
   typing; what gets past that - a rename, delete or move in the explorer, another
   plugin writing - is noticed and put back at once, with a notice.
6. **Beside it** the overview (the tab of 0.8.11: what differs, and why), the strip at
   the right edge of the editor area, and a bar at the top: the folder, the moment,
   *Apply…*, *Back to now*.
7. **Back to now:** every step of the journal undone from the copy, the newest first;
   the files are then as they were, byte for byte. Only then does the sync start
   again: it finds every file as it left it and takes in what the other devices did
   meanwhile.
8. **Apply…** is *Back to now* and then the rollback as it is - its list, the backup
   server, the copy in `rollbacks/`, the gate.
9. **Obsidian closed or crashed meanwhile:** the next start finds the journal *before*
   the sync starts, undoes the past first, and only then starts the sync. Should the
   undoing fail, the sync does not start and a window over everything says why.
   Started first, the sync would take the past in the files for edits made here and
   send it everywhere; this order is the rule the whole of U3 rests on.

What it costs:
- While it shows the past, this device syncs nothing: what is written elsewhere in the
  vault meanwhile waits and goes afterwards, and shared notes do not move here.
- Each tick writes every note and file that differs: months back in a large vault,
  hundreds of files per step and old versions of files downloaded - seconds per tick,
  not at once like the view. Files over the device's download limit (10 MB on a phone)
  stay as they are now, marked.
- Other plugins see the past as real files (a git plugin, a linter, Dataview's index),
  and Obsidian's *File recovery* may keep snapshots of them.

The alternative, safer and less of what was asked: the past as a read-only copy in a
folder of its own beside the real one (`⏱ Projects, 27 Oct 14:05/`), the sync untouched
(the copy excluded). But its links lead to today's notes, and search finds everything
twice.

*Recommended:* in place as above, built after U1 and U2 as a step of its own: it is the
part that can do harm, and the test vault can run all of it, a crash in the middle
included. *To decide:* in place or the copy folder; and whether the local copy is the
backup a preview needs (recommended) or the backup server runs before every preview too.

### U4 - Which views open

- A note: U2 in its own tab, nothing else.
- A folder or the vault: U3 in the explorer, the overview beside it.
- The overview alone, the explorer untouched, as today - for a phone or a large vault,
  where writing hundreds of files per tick is slow. *Recommended:* keep it, as *Look
  without the explorer* in the folder's menu.

### U5 - The notification center

Every notice of the plugin goes through one function that also records it: when, the
text, its kind (information, warning, error) and what it concerns - a note's path, so a
click opens the note. A view in the right sidebar (a bell) lists them, the newest first,
by day; the bell counts what was not seen yet; *Clear* empties it. Kept on the device in
the plugin folder (the last 500, or 30 days), not synced: most are about this device.
The notices still pop up as before. Windows over everything (the guard, moving in) stay
windows; what came of them is recorded.

Only the plugin's own notices: Obsidian lets no plugin read another's, short of
replacing its `Notice` for everyone, which breaks with Obsidian's updates.

*Recommended:* as above. *To decide:* whether only warnings and errors still pop up once
everything is in the center.

### Order

*Recommended:* 0.8.13 the strip, a note in its tab and the notification center (U1, U2,
U5); 0.8.14 the explorer (U3) alone. Each tried on the devices before the next.

### Decided (the user, 2026-10-29)

- **U1:** the strip as proposed; for a start the label - date and time to the second -
  only on the bar under the pointer.
- **U2, changed by the user:** no layer. The note's own file shows the past, in its own
  editor - exactly Obsidian's look, live preview included, every theme and update with
  it. What that needs instead of the layer:
  - the sync keeps away from that file while it shows the past (V2): nothing of it is
    read as an edit, and nothing from the server is written into it;
  - the editor is read-only (the plugin's editor extension, as for a note shared to
    read) and not bound to the document;
  - a copy of the file and a journal in the plugin folder *before* the file is
    replaced; *Back to now* writes the copy back, checked by its hash, and only then
    does the sync take the file again;
  - after a crash the next start undoes it before the sync starts (U3, step 9);
  - the changes against now marked in the editor itself: lines there then and not now
    highlighted, lines there now and not then shown struck through between them.
- **U3:** in place. Only the structure is replaced at once - what was deleted since
  comes back, what came later goes, what moved goes back -, a note's content when it is
  opened; *Apply* reads everything, as the rollback's plan does now.
- **Backups:** a local copy and a backup on the backup server; when none can be reached,
  going on only after a warning, by choice (V3, V4).
- **U5:** the notices keep popping up.
- **Order:** 0.8.13 the strip, a note and the notification center; 0.8.14 the explorer.
- `reference/` is ignored by git.

### Asked for besides: ticks as fine as one likes

How fine the past is kept: a note's history holds every frame its devices sent - while
online, a frame every 40 ms of typing plus the way to the server and back, so every few
keystrokes; offline, everything typed until the device came back is one frame, at the
time it was sent. Inside a frame no change carries a time of its own, so the frame is
the finest step. That holds for the retention (*Keep history for*, 30 days by default);
before it, a compaction folded everything into one state, the snapshot; further back
there are the backups, one per run.

The user's idea: one chooses from what pause on two changes are two ticks, and where the
history is folded, the next coarser step is taken - the snapshot, then the backups.
For a note this is its history alone. For a folder or the vault the server says when a
note was edited only to the minute (`/times`), so a minute is the finest there unless the
route says seconds - a server update, and more data on every load.

### Still open (V1 to V6)

- **V1 - where the fineness is chosen.** *Recommended:* a selector at the strip, kept on
  the device: every change, a minute, five minutes, an hour, a day; a note down to every
  change, a folder or the vault down to a minute.
- **V2 - what pauses while a note shows its past.** *Recommended:* only that note - its
  content, its rename and delete, from either side -, and the vault goes on syncing,
  live editing elsewhere included. For a folder or the vault the whole device pauses
  (U3, step 2): there the server's side touches many files at once (renames, new notes,
  deletes, files, a shared folder's mirror), each a way into the folder shown.
- **V3 - the backup server before a preview.** A run backs up what the server has, and a
  preview changes nothing there; what brings now back is the local copy and the notes'
  documents, which a preview never touches. A run takes a while each time.
  *Recommended:* before a preview a run only when the last backup is older than the
  vault's last change - otherwise that backup is current already; before *Apply* always
  (as now), and before *Restore this version* / *just this note* from now on too.
- **V4 - when the local copy goes.** The user's idea: once the backup server holds the
  same - each file's hash against the backup's listing, which has the hashes; a file this
  device had not sent yet does not match and stays. Without a backup server, today's rule
  takes them after *Keep backups for* (14 days). *To decide:* that rule, or only by hand
  then.
- **V5 - a folder's notes until opened.** With only the structure replaced, a note not
  opened yet holds today's text in the past's tree, and search, graph, backlinks and the
  hover preview read that. *Recommended:* a mark in the explorer on such notes until they
  show their past.
- **V6 - plugins that write on every change** (the user has one that stamps the
  frontmatter). Its name, to see what it listens to.

### Decided (the user, 2026-10-30)

- **V1** as recommended; a folder or the vault to the minute is fine.
- **V2: the vault is locked on every device** whenever the Time Machine shows the past
  in the files or applies it, to the user "for the cases nobody thought of yet" - and the
  lock can be lifted by hand, should a bug leave it in place. Mechanics below.
- **V3** as recommended. **V4:** fourteen days, and a window telling the user whenever a
  backup was made that exists only on this device.
- **V5:** a trade-off for speed; the user asks whether fetching the notes alone - most
  of a vault, and small - would do. Below.
- **V6:** the plugin is *Update time on Edit*. Below.
- **A name for 0.9:** "Connect" (the user) - nothing in the community directory has
  that id or name (9660 plugins, 2026-10-30); many are called "… Connect".

### The lock (proposed for V2)

On the server, so that it holds even against a device whose guard failed:
- A device takes it for the vault (`POST /vaults/:id/lock`, *preview* or *rollback*) and
  renews it every 30 seconds; not renewed for two minutes - a device that crashed or lost
  its connection -, it lapses.
- While it holds, the server takes no frame from the account's devices into the vault's
  rooms - index, settings, notes, folders -, but during a *rollback* from the connection
  that holds it. A refused push is kept on its device, as offline, and goes once the lock
  ends: what is written elsewhere meanwhile waits, nothing is lost.
- Every device shows it, in a window over everything: who holds it, since when, and
  *Unlock*, which asks first and lifts it on the server for all.
- Not locked: other people in shared notes and folders - they are not the account's
  devices, and their edits merge as always -, and restoring a single note, which is an
  edit like typing.
- A server update, like `/times`.

### V5 - the notes of a folder shown

Notes are small; what costs is reading each one's history from the server (a request and
decrypting, six at a time), not its size. *Recommended:* the structure at once, the open
note next, then every other note that differs filled in in the background, with its
progress shown - so search and links are right after seconds, not after each note was
opened. Other files (pictures, PDFs) only when opened, since they can be large. Moving to
another tick rewrites only what differs between the two, and every history read stays.

### V6 - Update time on Edit

Read from its source (`beaussan/update-time-on-edit-obsidian`): on every `modify` of a
note it sets `updated` to the file's modification time - when that time is more than the
*minimum minutes between saves* (1 by default) after the `updated` already there - and
writes it keeping that modification time. Its default format is to the minute.

With this plugin's sync that means:
- A device receiving an edit writes the file *now*: within the minute of the edit
  nothing happens; across a minute's edge it stamps once more, which goes back to the
  first device and stops there - no endless loop, but an extra version.
- A device that was offline stamps the time it came back, not the time of the edit.
- Two devices stamping the same line at once (three devices, two receiving at a
  minute's edge) are merged character by character, and the date comes out garbled -
  which the plugin takes for a missing date and stamps again. That can repeat.
- After a rollback the rolling-back device stamps today: arguably right, it was
  changed.

What helps:
- At once, without code: a higher *minimum minutes between saves* (5) in that plugin.
- *Recommended,* in the sync: a file written because of another device's change gets
  the time that change was made (the author's time in the frame), not the time it
  arrived, as its modification time - Obsidian lets a write set it. Such plugins then
  see nothing new on the receiving devices, and *sorted by modified* is right on every
  device. A file an editor holds is saved by Obsidian with its own time; there the
  plugin's minute still covers almost everything.

### Still open (W1 to W3)

- **W1 - a note alone: layer or the file.** With the lock, showing a note's past in its
  file locks the vault on every device each time someone looks at an earlier version of
  a note. A layer writes nothing and needs no lock. It is rendered by Obsidian itself, so
  it takes on themes, snippets, updates and other plugins' rendering - the reading view
  exactly, with the properties drawn by the plugin in Obsidian's style. *Recommended:*
  the layer for a note alone; a note opened while a folder or the vault shows its past
  shows it in its own editor, as decided.
- **W2 - the lock** as above: only the account's devices, and not for a single restore?
- **W3 - the modification time** written with the author's time, as recommended?
