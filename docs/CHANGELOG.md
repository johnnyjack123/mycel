# Changelog

Newest first. What each version changed and, where it fixed a bug, how the fix was
verified. `docs/PROGRESS.md` holds only the current state.

"Checked by putting the bug back" means: the old behaviour was restored in the source,
the suite run, the new checks seen failing (and nothing else), the fix restored.

## 0.9 - hardening (from 2026-11-03, spec `docs/PHASE8.md`)

- **0.9.8** (2026-11-07) - **the security audit** (`docs/PHASE8.md`, A; every finding with its
  fix and its check in **`docs/AUDIT.md`**, the attacks kept as `npm run test:security`).
  Server: one malformed or oversized WebSocket message - to `/relay?role=backup`, no token
  needed - ended the whole process (every socket has an `error` listener now); without
  `MYCEL_JWT_SECRET` tokens were signed with a secret from the sources (now a random one kept
  in the data folder; a configured one needs 32 characters, or the server does not start);
  behind a proxy ten wrong passwords from anyone blocked everybody's sign-in
  (`MYCEL_TRUST_PROXY`); bodies of 64 MiB were parsed before any token was looked at; friend
  codes' answers without size or number could make contacts.json unreadable for everyone;
  titles, keys and attachment lists of any size went into a room's metadata; frames of
  100 MiB were taken; another account's vault id could be registered. Plugin: paths in a
  shared folder's document wrote outside the folder - `../../.obsidian/plugins/mycel/main.js`,
  code that runs at the next start - and every file operation now passes a gate that allows
  the vault's own files and the plugin's folder only (`guard.ts`, invariant 31); a folder's
  document naming another note of the victim took it over and deleted it; a link typed into a
  shared note had the other devices publish their own files of that name (now only links
  typed here, a note shared from here with its files, or the user's yes); a friend code did
  not bind its creator's account; keys were sealed to whoever the server listed, taken from
  any contact, and written under any folder tie the server named (invariant 32); a caret's
  colour went into a style attribute as it came. Backup server: a task's environment reached
  restic whole (`LD_PRELOAD`, `RCLONE_CONFIG` - code on the backup server), and an `sftp:` or
  `rclone:` location starting with `-` was an option to ssh or rclone. **Friend codes made
  before 0.9.8 no longer redeem; every device and the server need 0.9.8 together.** Checked
  by putting the bugs back (S1 to S9, P1, P3, P4 in `docs/AUDIT.md`): the old server failed 17
  checks and exited on the relay message, the old plugin wrote the plugin's `main.js` through
  the folder and deleted the victim's note; every other suite passes with the fixes and with
  the gate in front of the test devices.

- **0.9.7** (2026-11-06) - **the name: Mycel** (`docs/PHASE8.md`, N; the user, 2026-11-05).
  Since the user starts once afresh, everything is renamed, the internal names included -
  nothing has to stay readable: the plugin (id `mycel`, name *Mycel*, its folder
  `.obsidian/plugins/mycel/`), the packages (`@mycel/shared`, `@mycel/server`, `@mycel/plugin`,
  `@mycel/backup`), the environment variables (`OBSIDIAN_CONNECT_*` → `MYCEL_*`), the images
  (`ghcr.io/<owner>/mycel-server`, `mycel-backup`), the command lines (`mycel`, `mycel-backup`),
  every key derivation's label (`mycel salt`, `mycel login`, …), the `localStorage` keys and
  IndexedDB names, the tokens' issuer, the server's `/health` answer, restic's host and tag,
  the log prefix `[mycel]`, the CSS classes (`mycel-…`), the notification center's title. The
  historical design documents keep the names they were written with only where they discuss
  the choice of a name; this changelog keeps them for everything before 0.9.7. The repository
  on GitHub keeps its name until the user renames it. Checked by every suite, run under the
  new names. Also: **a starting point no longer has to reach past a frame that never landed**
  - a folder shared without history right after a note in it was made failed now and then in
  CI with "the starting point does not fit the log (epoch from #2, head #1)", since 0.9.2: the
  server had counted a frame still being written when the note's epoch moved, and that frame
  is not in the log. A starting point now has to hold every frame of an earlier epoch and every
  counted one that landed (`docs/PROGRESS.md`, known issues, for what is still unexplained).

- **0.9.6** (2026-11-05) - ***Replace all keys*** (`docs/PHASE8.md`, S2, as the user decided
  on 2026-11-05). A new password signs every other device out, but whoever had the keys
  before could still read what they got of the notes. A button in the account's settings now
  replaces **every key**: the password, the account secret, the identity (sealing and signing
  key), every vault's key, the recovery code - on the server in one step (`POST
  /auth/replace`), every other device signed out and every backup key ended. Then **every
  room the account owns is written anew in place** (`GET /log/:room/whole`, `POST
  /log/:room/rewrite`, under a vault lock of kind `replace`): every frame at its seq and in
  its epoch, every snapshot, every key a member holds sealed anew - the account's own frames
  signed with the new key, a writer's keeping their signature under a new certificate,
  anything no signature holds for an empty change; a room others write in moves on to a new
  epoch with it, so nothing under a key from before is taken any more. **Every file is
  uploaded anew** under the new key and the content before purged (without the 10 minutes'
  grace, for the replacement under way only). The account secret before stays, wrapped under
  a key from the new one, until the vaults are written anew (`KeyReplacement` in the bundle):
  whichever device of the account gets there next carries it on, a room already written anew
  is marked (`rewrittenBy`), a room a crash left half written is read with both kinds of keys.
  A vault keeps its id: devices find it by its sealed name now. **A device knows the frame its
  cursor ends at by its bytes, and - when they differ - by what it says** (author, time,
  change; only a key holder can make them): written anew, the log is still the one it knew,
  and such a frame it cannot open yet confirms nothing and refutes nothing (`unreadable`:
  nothing sent, caught up again once a key comes) instead of holding the note for the user. The
  first build of this compared what the frames say only, which needs their key - a frame whose
  key was missing for a moment would have left a room unconfirmed and unsent; comparing the
  bytes first, as before, is what every case outside a replacement does again. The CI failures
  seen meanwhile (`test:backup` "the starting point does not fit the log", `test:folders` "no
  file at Shared/X/Sub/byPia.png") turned out to be older races, seen in CI before 0.9.6 too
  (`docs/PROGRESS.md`, known issues). **Contacts:** the server tells them
  (`contact-replaced`); their devices then seal nothing to the account and take nothing in its
  name until a **new friend code** confirmed the new keys - redeemed either way, it replaces
  the pinned ones, and their device seals what it shares with the account anew and moves it to
  a new epoch (`Sharing.renewFor`, `Folders.renewFor`; kept in the settings until done, by
  whichever device). Keys sealed to a key the account no longer has, or ones whose owner
  sealed them anew, are asked for again instead of failing the room. **Backup servers** are
  taken off before (their pairing lay in settings the keys before opened); their task is kept
  and carried on by the next one invited. Checked in `test:replace` (new): two devices and a
  contact, a shared note both ways, a shared folder, a file - nothing of a note opens with the
  keys before afterwards, everything with the new; history, the old password and recovery code,
  the second device signing in, nobody asked whether the server lost data, the contact paused
  and then confirming, both ways, the folder; and a replacement that broke off right after the
  server's step, carried on by the other device. `test:rooms` checks the routes.

- **0.9.5** (2026-11-05) - **a clean slate** (protocol 9). Nothing runs in production yet, and
  the user will start once afresh (the user, 2026-11-05): every path that only served data
  or devices from before is gone, and a server, device or backup server of 0.9.5 reads
  nothing an earlier version wrote. **Contacts pin both keys from the start**: a friend code
  carries the fingerprint of the creator's *identity* - sealing and signing key together
  (`identityFingerprint`) - and the two introductions carry both keys, MAC'd with the code;
  attestations, their routes and `contact-key` are gone. Redeeming a code from someone who is
  a contact already replaces the keys pinned for them (how 0.9.6 confirms a contact who
  replaced their keys). Every account has its signing key from registration (the server
  refuses one without). **No unsigned frame is read anywhere**: the legacy mark and
  `packFrame` are gone; a frame that does not unpack is dropped like a forged one, never
  stopping the room; the histories - Time Machine, rollback, a note's versions - take only
  what the live room would take, as the fork and compaction already did; a compaction never
  folds a snapshot that is not the owner's into its own. **Roles come from the owner's record
  alone**, never the server's word (nobody unrecorded writes), and **every change of role moves
  the note or folder to a new epoch** (`POST /shares/rotate` for a note): made a writer, the
  certificate is in the new epoch's key before the server lets them write - resealing the
  current one left a device that had asked for it once without it until a restart. Sharing
  again with history, from writer to reader, rotates too. Removed besides: the fallbacks for
  servers without attachments, recovery codes, 2FA, blob touching or listing, the Time
  Machine's frame times or the rollback's changed notes; a vault lock without a scope; tokens
  without a session generation; the backup schedule's single `weekday`, its counts without
  files and its status without a version; keys sealed without a signature on the backup
  server. Checked in `test:merge` (identity fingerprints, a code whose signing key the server
  swapped, frames cut short), `test:rooms` (no account without a signing key, the rotation
  route, a token without a generation refused) and every other suite.

- **0.9.4** (2026-11-04) - **signed frames** (`docs/PHASE8.md`, S-b; protocol 8). A frame named no
  author: everyone holding a note's key could write what every other holder took - a reader
  through a server that let them, a writer as someone else. Now every frame and snapshot of a
  note or folder is **signed by its author inside the encryption** (the server sees no author
  and cannot take the signature off). Whoever is not the room's owner adds the owner's
  **writer's certificate** - the owner's signature over the room or folder, the epoch, the
  writer and the writer's signing key - which comes with the key sealed to them; a reader gets
  none. A device takes a frame only when its author is the owner, or carries such a
  certificate, and the signature holds; snapshots and starting points only from the owner. A
  frame that fails is dropped (logged as an error), one whose key is not known yet waits and
  the room is caught up again. The owner issues certificates by its **own record of roles**
  (in the account's settings), not by the server's word; made a reader, a member's note or
  folder moves to a new epoch, so the certificate they held stops counting; made a writer, they
  get one for the current epoch. **Frames from before** pass up to the owner's signed **legacy
  mark** (`POST /keys/:room/mark`), set once per room before anyone else reads it - when it is
  shared or its folder is, and once for the shares of 0.9.3 by the owner's first device on
  0.9.4 (with the writers' certificates). A share that ends keeps only what passes (the fork
  checks the kept log the same way), and the owner's compaction folds in only what passes.
  A writer whose certificate has not come yet keeps what it writes until it has one. Every
  frame grows by about 90 bytes (the owner's) or 220 (a writer's). Checked in `test:merge`
  (signatures, certificates, marks) and `test:vault` (a member's frame signed as the owner,
  one without a certificate, one unsigned: none reaches the owner, nor the member's own copy
  when the share ends, while what she writes properly does).

- **0.9.3** (2026-11-04) - **signed keys** (`docs/PHASE8.md`, S-a; protocol 7). A server could
  hand a member of a share a key of its own, sealed to them, and frames under it: nothing told
  them the owner had not sealed it. Now every account has a **signing key** (ECDSA P-256, made
  at registration, or by the first device of an older account; wrapped under a key from the
  account secret, so a password change or a recovery leaves it as it is). Contacts learn it
  from an **attestation**: a MAC under the secret their two pinned sealing keys share, which
  only the two of them can make - no new friend code, for contacts old and new. Every key the
  owner seals for a note or folder carries **the owner's signature** over room, epoch,
  recipient and the sealed box; a device opens only a key signed by itself or by a contact
  whose signing key it pinned, and asks the server again once when the one it kept does not
  hold. **Keys sealed before** are sealed anew and signed once per vault by the owner's first
  device on 0.9.3, for exactly the epochs each member holds (`GET /keys/:room/sealed`,
  `POST /keys/:room/reseal`; the server refuses any epoch a member did not hold). Sharing
  vouches for the signing key to the recipient first, so a contact made a moment before can
  check the key at once. A frame there was no key for no longer lets the frames after it move
  the cursor past it: the room is caught up again a little later, three times at most.
  Checked in `test:merge` (signatures, a box swapped under one, attestations), `test:rooms`
  (the routes) and `test:vault` (a key the server swapped for one without the owner's
  signature is refused; sealed anew, it opens again). The backup server reads signed keys
  without checking the signature - it holds no contact list. A contact's attestation is
  announced as `contact-key`, which reads only the attestations: announced as `contact`, every
  device of the other account read its contact inbox again on each one.
  Also: **a room let go while a frame was still being written** - someone subscribed, pushed and
  left while the room was being closed for being idle - was read again from the disk before
  that frame was there; its next frame took a seq already used, and the epoch it moved to
  started after a frame it never knew (`test:folders` once: "the starting point does not fit
  the log", seen in 0.9.1's CI too). A room is let go only once nothing is being written, and
  loading one waits for what its predecessor still writes.

- **0.9.2** (2026-11-03) - **every note live** (`docs/PHASE8.md`, L). A device holds at most
  *Documents kept in memory* notes open (500); a note beyond it heard of nothing until it was
  opened or the next start, and its file stayed old. Now a note let go is **watched**: the
  device names it to the server with the seq it knows (`watch`, protocol 6 - an older server
  or plugin is refused with "update the server/plugin"), the server says `changed` when its log
  is further on - at once, and whenever a frame lands - and the device opens it for a moment
  the normal way (catch-up, the check of invariant 19, the file through the reconcile), at
  most eight at once, and lets it go again when the limit needs the room. The server reads a
  head it does not hold from the log's frame headers, once, and keeps it; nothing about the
  content travels, and only for notes the account may read. Fixed on the way: **letting go no
  longer drops a note whose change the server has not acknowledged** (it was stored, not sent,
  until opened again, and the cloud said *synced*) **nor one held** for the user's decision;
  **a note opened while it was being let go** waits for its database to close; **reconnecting
  catches up the notes let go before** (the watch is named again). A note's cloud says
  *waiting* while a change is on its way to a note let go. A shared note caught up this way has
  its files compared again. Checked in `test:vault` (a device holding two of five notes open:
  every change of another device reaches all five files, an unacknowledged change keeps its
  note open, changes made while the connection was down arrive after it; the first and last
  fail with watching taken out) and `test:rooms` (heads, access, after a restart).

- **0.9.1** (2026-11-03) - **durable writes on the sync server** (`docs/PHASE8.md`, D; asked for
  by the user, 2026-10-18). Server only - the plugin's version moves along.
  - **A change is acknowledged once it is on the disk:** written, synced, and only then in the
    room's log in memory, acknowledged and sent to the others. Before, an acknowledgement meant
    the operating system had it - a power cut on the Pi lost frames the device had already
    dropped from its outbox. A frame nobody could read before it was written can no longer come
    back under its seq with another content after a crash, and a write that failed leaves
    nothing behind in memory or in the file (cut back to the last whole frame, the connection
    closed so the device sends it again). The first build acknowledged without holding up the
    connection's next message; its CI run failed in `test:backup` (a folder shared without
    history right after a note was created there: the owner's starting point never reached
    the epoch's start within the retries), so a connection's messages are handled in order
    again, and a starting point waits for this device's own last change to be acknowledged.
  - **A frame torn by a crash is cut off** when the log is read - frames follow seq by seq;
    whatever does not ends the log. Before, the next push was appended behind it and the room
    read as garbage from there on (checked by putting the bug back). A frame written twice by
    the next bug is read once.
  - **A push during a compaction was written twice**; a compaction now writes snapshot,
    metadata, log - in the order a crash between them survives - from what is on the disk.
  - **Every other file** (metadata, snapshots, forks, blobs and their chunks, accounts,
    contacts) is synced before its rename and its folder after; `server.json` - every salt
    depends on it - is created whole or not at all.
  - **The CLI and the server no longer overwrite each other's `accounts.json`** - an
    invitation made with the CLI during a sign-in could vanish, a removed account come back
    (checked by putting the bug back). A change that changes nothing writes nothing: most 2FA
    attempts and backup logins wrote the whole file.
  - **One server per data folder** (`server.lock`); shutting down waits for every write.
  - **The vault lock outlives a restart of the server** (D1, `locks.json`) for as long as its
    lease. Checked in `test:rooms` (a torn frame and the push after it, a push during a
    compaction, a crash between its steps, the lock over a restart, the CLI and the server at
    once, a second server).

- **0.9.0** (2026-11-03) - **a key is sealed only to a pinned key** (`docs/PHASE8.md`, S finding
  1). When a note or folder moved to a new epoch, the owner's device sealed the new key to
  every member the server listed, and for one who was no contact it took the key the server
  gave: a server that listed a member of its own would have received every later key, and
  read the share. Now every key comes from the contact list; a member who is not a contact -
  once the contacts are surely here, the settings caught up - stops the whole rotation before
  anything is sealed (`Sharing.memberKeys`), and a window over everything says so and offers
  to take that member out (`UnknownMembersModal`), with the reason kept in the notification
  center. The server's route that handed out anyone's public key by account id is gone - the
  plugin was its only reader. Checked in `test:folders` (a revocation with a member the
  owner's device no longer knows stops, the folder keeps its epoch, the window is asked
  for). The licence: AGPL-3.0-or-later, in `LICENSE.md` (the user). Plugin and server.

## 0.8 - sharing a folder (from 2026-10-22, spec `docs/PHASE7.md`)

- **0.8.17** (2026-11-03) - **the notification center is called *Connect*** (the user: it holds
  more than notifications now) - its tab, the bell's tooltip, the command (*Open Connect:
  notifications and rollbacks*, the same id, so a hotkey stays) and every text that pointed to
  it. The *Rollbacks* tab says that *Undo…* backs up first like every restore. Plugin only.
- **0.8.16** (2026-11-02) - **the Time Machine's fourth round** (`docs/TIMEMACHINE.md`, the
  user's try of 0.8.15). Plugin only.
  - **The rollbacks in the notification center**, under a tab of their own, as the user drew
    it: every rollback and every note restored from the Time Machine, on any device, the last
    50, not cleared with the notices. *Undo…* opens the Time Machine of what it took back at
    the moment before it, from anywhere; *Restore this version* there undoes it. A rollback's
    notice carries the same *Undo…*. The overview's list of earlier rollbacks is gone: it
    showed every rollback, a folder's in the vault's too, and undone from there the whole
    vault went back.
  - **A lock that ended while a device was away** stayed on there: the device asked only when
    it started, and believing the vault locked it sent nothing until Obsidian restarted. Every
    reconnect asks now (checked by putting the bug back).
  - **What was written after the lock was taken is kept:** lifted on another device and typed
    into there, the note's text was overwritten by the restore. A restore - of a note, or a
    rollback's of each note - now takes back what the note said when the lock was taken and
    merges in what came after, both kept where the two changed the same lines. With nothing
    written meanwhile, the note is exactly the version chosen. The rollback's window names the
    notes merged.
  - **The timeline:** the moment shown is a thick bar in the accent on a band of its own, long
    whatever the pointer does; the moments before earlier rollbacks are cyan and dashed - they
    were purple, the accent of Obsidian's own theme, so the moment shown hid among them. Only
    a place's own rollbacks are marked on it, a note's restores on a note's. The bar above says
    what the colors mean.
  - **Under another device's lock:** a bar at the top of a locked note's editor with the
    reason and *Unlock…*, the view framed in reading mode too; the status bar says *locked -
    sending waits* instead of *synced*.
  - A rollback in a shared folder: the notes it moved to the trash get one notice that the
    rollback did it, instead of an *Undo* per note.
  - Tests: `test:timemachine` 89 (was 66), `test:rollback` 78 (was 72). `test:recovery`
    waits for the sweep to delete a removed account's folder: the participant's fork is
    written first, and CI checked in between.

- **0.8.15** (2026-11-01) - **the Time Machine's third round** (`docs/TIMEMACHINE.md`,
  the user's first try of 0.8.13, X1 to X4 decided as recommended). Sync server, backup
  server and plugin; the sync server first.
  - **Abort** instead of *Back to now*; **Restore this version** for a folder and the vault
    too, instead of *Apply…*.
  - **A restore under the lock:** the backup while the past is still shown, then the files
    back and the sync started with this device writing under the lock it took - the server
    lets a lock's holder write whatever its kind -, and the lock let go only once the
    restore reached the server. The note showed its old text for seconds and could be typed
    into, and what was typed there or on another device meanwhile the restore overwrote: the
    backup ran after the lock was let go. *Restore this version* of a folder or the vault
    hands the lock on to the rollback's window.
  - **Read-only on every device:** what the Time Machine shows, or a rollback changes, is
    read-only in the editor on this device and on the other devices (the lock seals what it
    covers). The editor's read-only lost to Obsidian's own, given first, and could be typed
    into - reproduced with Obsidian's facets in front, checked by putting the bug back;
    typing is now also dropped by a transaction filter. The lock can be lifted from a note's
    header, the cloud's menu and *This device* once its window was closed.
  - **The explorer** stays inside what the Time Machine shows, caught before Obsidian's own
    handlers; outside is greyed. Links, the quick switcher and a search go back too.
  - **The timeline** at the left, in a column of its own, a fixed distance between bars and
    scrolling, a gap where a day begins (the longer bars were that, unexplained). The moment
    before an earlier rollback is a place on it; clicking the rollback in the overview goes
    there, and *Restore this version* undoes it - no *Undo…* button.
  - **Notices with a button** reached the notification center empty and were dropped:
    Obsidian takes a fragment's nodes into its notice, and the text was read after that
    (checked by putting the bug back). Read before now, and the button is kept and works
    from the center, once, after a restart too.
  - **Backups:** a run with nothing changed since the last one starts no restic and is done
    at once; restic's check of the whole repository once a day instead of every run; the
    time of each step in the log; the device asks every half second at first. So the rule is
    simply: a backup before the past is shown and before every restore. `test:backup` found
    a changed retention not forgetting when nothing else changed; it is part of the
    comparison.
  - Tests: `test:timemachine` 66 (was 48), `test:rooms` 401, `test:backup` 231, `test:load`
    16 (the explorer's guard installed).

- **0.8.14** (2026-10-31) - the Time Machine's bar and timeline, from the user's first try
  on a device. Plugin only.
  - **The bar lay in the row of the tabs**, and on Windows the window's own buttons sit at
    the right end of that row, over everything: they hid *Apply…* and *Back to now* and
    cut *Changes: shown* in half, so there seemed to be no way back. The bar now lies under
    the tabs of the top row, whose editors move down by its height, so it covers neither
    the tabs nor the editors; the timeline starts under it and ends above the status bar.
  - **Two tooltips on the timeline:** Obsidian shows a tooltip of its own for every
    element with an `aria-label`, and the strip and each bar had one besides the moment's
    own. They are named by hidden text now.
  - Only verifiable on a device (`test:load` and `test:timemachine` pass).

- **0.8.13** (2026-10-30) - **the Time Machine's second round** (`docs/TIMEMACHINE.md`,
  the user's decisions U1 to U5, V1 to V6, W1 to W3). Wants the sync server of 0.8.13 (the
  vault lock): with an older one the Time Machine and the rollback refuse and say so.
  - **The past in the files themselves:** the explorer and the normal editor show the
    moment, read-only; the sync stops on the device, the vault is locked on the others.
    Every file is copied into the plugin folder with a journal line before it is
    replaced, and put back from there byte for byte with its times - after a crash
    before the sync may start (CLAUDE.md, invariant 30). The structure at once, the
    contents in the background, the note in front first, large files when opened.
    Someone writing over the past meanwhile is kept aside, not lost. The tab and its
    slider of 0.8.11 are gone; the overview of what differs stays, beside the explorer.
  - **A timeline as in macOS:** upright at the right edge of the editors, a bar per
    moment, growing towards the pointer like a wave, the moment under it to the second.
    Its fineness chosen on the device: as usual, every change, a minute, five, an hour, a
    day. A bar above the editors: the moment, the changes shown or hidden, *Apply…* or
    *Restore this version*, *Back to now*.
  - **A note's changes in its editor:** lines there then and not now highlighted, lines
    there now and not then struck through between them.
  - **The vault lock** (server and plugin): while it holds, the server answers the
    account's pushes into the vault with `locked` and the devices keep them; under a
    rollback only the connection that holds it writes. It lapses after two minutes
    unrenewed; any device can lift it in the window every other device shows. A rollback
    takes it too.
  - **Backups:** before the past is shown, a backup when the last one is older than the
    last change; before a single restore, always. A rollback's copy goes when the backup
    holds the same, by hash; otherwise, and when a restore's backup is only local, a
    window says it lies on this device alone, for *Keep backups for*.
  - **A synced file carries the time its change was made**, not the time it arrived:
    *Update time on Edit* (the user's plugin, read from its source) took the arrival for
    an edit, stamped it and sent the stamp back; two devices stamping at once garbled the
    date.
  - **The notification center:** every notice is kept on the device (`notices.json`, 500
    or 30 days), a bell counts the unseen and opens the list.
  - Tests: `test:timemachine` 48, new (the past written and put back, also after a crash,
    nothing of it reaching the other device, a folder, a note's editor read-only with its
    marks, the lock against the other device and for a rollback, a synced file's time,
    the notices, the timeline's wave); `test:rooms` (the lock: who hears it, what it
    refuses, the holder under a rollback, lifting, lapsing, the routes); `test:load` 16
    (the views, the commands, both editor extensions).

- **0.8.12** (2026-10-29) - the Time Machine's fixes from the user's first test
  (`docs/TIMEMACHINE.md`, "How it is built"). Plugin only.
  - **After *Restore this version*, *now* showed the text the restore replaced** until
    the file was written a moment later: what a note says now was read from its file,
    which follows the document. It is the document now wherever that is ahead - a change
    still to be written, or an editor Obsidian saves when it likes
    (`DocStore.currentText`; the rollback's plan reads it too). The view moves to *now*
    at once and reads the past again, quietly, once the server has the restore
    (`DocStore.whenSent`); the vault's or a folder's view stays at its tick.
  - **The newest tick always equalled *now*:** a tick shows the state after its
    changes. It is left out when it shows what now shows, and *now* says when the last
    change was. A note's version that left its text as it was is no tick either.
  - ***Changed since* was the server's word only**, so a note restored to its text of a
    tick was marked changed at that tick. The notes it names are compared by their text
    then and now, up to 200 per tick; beyond that the view says so.
  - The Time Machine's button moved from *All devices* to *Backups*.
  - Checked by putting the bugs back: with the file read first and versions without a
    change of text kept, exactly the two new checks fail. Tests: `test:rollback` 72
    (seven new: the text now right after a restore, its file following, the restore on
    the server, a restored note equal then and now though the server's minutes say
    changed, the newest tick's text, a change beside the text making no tick).

- **0.8.11** (2026-10-27) - **the Time Machine** (`docs/TIMEMACHINE.md`, the user's
  decisions of 2026-10-27). Wants the sync server of 0.8.11 (`GET /times`) - with an
  older one only notes and files added, moved or deleted make ticks, and the view says
  so -; *Backups too* needs the backup server of 0.8.11 (`backupTimes`).
  - **A tab of its own** for the vault, a folder or a note (the note's or folder's menu,
    two commands, *All devices*): a slider over the past with a tick per version of a
    note, or per change of a folder or the vault - those less than five minutes apart
    as one -, *earlier*/*later*/*Now*. Sliding changes nothing in the vault. The vault
    or a folder shows its tree as it was, by default only what differs from now
    (*deleted since*, *added since*, *moved*, *changed*); a note is shown rendered -
    its pictures as they were then -, as text, or as its changes against now; a
    picture as it was.
  - **Apply…** is the rollback of 0.7.8 to the tick's moment, with its list, its backups
    and its gate (`history/ApplyModal.ts`, what is left of `RollbackModal`); *Restore
    this version* for a note (a backup of its text first); *Restore just this note* /
    *this file* in the vault's or a folder's view; the earlier rollbacks with *Undo…*.
    Someone else's folder can be looked at, not applied; a note shared to read only
    cannot be restored.
  - **Backups too** (a switch, off unless turned on, kept on the device): the backup
    server's backups older than the history are ticks of their own, read by path.
  - **The ticks without reading every note:** the server lists per note room the
    minutes its frames arrived in, only frames the caller may read, from memory or the
    headers of `log.bin` (`RoomHub.frameTimes`); the device walks the vault index's
    history once into events (`VaultTimeline`). A note's text at a moment is replayed
    forward from where it stood and back from a checkpoint (`Replay`), not from the
    start each time.
  - **Replaced** (the user: not in productive use yet): *Version history* of a note and
    *Roll back…* are gone; a file's *Version history* stays.
  - Tests: `test:rooms` 379 (the minutes, who may hear them, from disk after a restart),
    `test:merge` 174 (the replay against one from the start, forward and back, from a
    snapshot), `test:rollback` 65 (the entries at a moment, ticks of the vault and of a
    folder, where a note was, edited since, a note's text forward and back, a server
    without `/times`), `test:backup` 229 (when the vault was backed up), `test:load` 15
    (the view and its commands registered). The view itself only on a device.

- **0.8.10** (2026-10-25) - the notes a note links to go along when it moves into a
  shared folder, and a share's end is announced once.
  - **Moving a note into a shared folder offers the notes it links to** (the user's
    decision: shared on their own, as E8 has it, not moved in). The window lists every
    note outside the folder it reaches through links, the notes those link to included,
    each that cannot go along with the reason - and with the switch on, they are shared
    once with everyone in the folder who is a contact of the mover: each with the access
    they have in the folder, the owner to edit, without earlier versions, as the note
    itself went in. They stay where they are and land in the others' share folder at the
    path of their link. The window says how many in the folder are not contacts and get
    none of them (`Folders.shareAlong`).
  - **The end of a share was announced twice** on the revoked person's device: the
    server says it as a message and as a notice, and both said so. For a folder, every
    note of it said so as well. One of them announces it now, and a folder's notes leave
    it to the folder (`Sharing.onRevoked`). Checked by putting the bug back: "and says
    so once" (`test:vault`) and "the reader is told once, for the folder"
    (`test:folders`) failed.
  - **Deleting someone's shared folder** announced on that very device that the share had
    ended and the copy was kept as notes of one's own - the server's word came before its
    answer to the leave. Leaving and keeping a copy are no news on the device that did
    it, and another device of the account no longer says a copy was kept when nothing
    was. Checked by putting the bug back.
  - The window asking about a note moved in counted nobody as a stranger: 0.8.9 took
    `Contacts.name`, which falls back to the id, for "is a contact".
  - **A rollback left someone else's shared folder's notes alone, but not its files**:
    planned on a member's device, a picture that came into the folder after the moment
    was to be trashed - for everyone, from a writer. Files of a folder whose record has
    an owner, then or now, are counted as left alone, as that folder's notes are
    (`Rollback.planFromHistory`). Found while reading the code for the Time Machine's
    design; checked by putting the bug back ("leaves someone else's shared folder
    alone, its files too" failed: the picture was to be trashed).
  - Tests: `test:vault` 243, `test:folders` 121, `test:rollback` 55.

- **0.8.9** (2026-10-25) - what the user found testing 0.8 on their devices.
  - **Carets no longer flicker while someone types.** The letters and the typist's
    caret travel apart, either first. Text first, the caret sat in front of each new
    letter until the caret came; caret first, it named a letter not here yet and
    vanished. Now the caret of whoever typed a change moves along with it, and one that
    cannot be placed yet stays where it was drawn (`EditorBinding.buildCursors`). The
    authors are read from the transaction: a Y.Text event's `changes.added` is always
    empty. `test:sync` 31 (5 new) - the check "behind the letter as soon as it is
    there" failed before (9 instead of 10).
  - **Moving a note into a shared folder asks at once**, not once the move's events
    settled (2 s), since a note from outside cannot be part of the folder moving. The
    window names everyone the folder is shared with - contacts by name, others counted -
    says plainly that the earlier versions do not go along, and lists the files outside
    the folder the note embeds that go along with it.
  - **Sharing a folder again with someone who deleted their copy** asked on their
    devices whether the server had lost data. They had stood on the start snapshot of
    the first share; the new one, of the same state at the same place but under the new
    epoch, differed in its bytes. A snapshot made anew under another epoch is taken for
    what it is (`VaultSocket.applySnapshot`); a server restored from a backup hands its
    snapshot back as it was. Single notes shared again without history had the same
    problem. And the folder came back as `X 2`: the empty folder the delete had left on
    the member's other device counted as taken. Both reproduced in a new `test:folders`
    scenario before the fixes.
  - The window asking about a server with other data **names the notes**.
  - **The owner is told when someone leaves** a shared folder (`left` in the folder's
    notice).
  - **Restoring a note from its history backs up what it said first** (invariant 2): the
    history undoes a restore only as long as it reaches back.
  - A note copied into someone's folder at once could leave its old file behind on the
    account's other device, which had not applied the rename yet; the fork moves it
    along (`DocStore.forkInto`). The window coming at once made that race likely.
  - A rollback on a participant's device says why it lists nothing: notes others share
    are rolled back by their owner, for everyone.
  - The shared-folder mark in the file explorer is grey, like the explorer's own icons.
  - **Files reach the others sooner.** The device that typed a link names its file at
    once instead of after 10 s - that wait is for the other devices, so a file of the
    same name of theirs never gets there first -, and a file copied in from someone's
    store is written from the bytes just fetched instead of being downloaded again.
  - Tests: `test:sync` 31, `test:vault` 242, `test:folders` 105, `test:recovery` 72.

- **0.8.8** (2026-10-23) - planning a rollback reads only the notes that changed since
  the moment (PHASE7, small fix 6). It read every note's log, since the server kept no
  time of a room's last frame. The server now lists the rooms of a vault that took a
  frame at or after a moment (`GET /changed`): the time is the loaded log's last frame,
  or when `log.bin` was last written - never earlier than the truth, and nothing is
  written per frame for it. Planning skips a note that stayed where it was and is not
  listed, with an hour's margin, since the server's clock is not the authors' clock the
  rollback goes by. A server before 0.8.8 lists nothing, and every note is read as
  before.
  - Tests: `test:rooms` 374 (2 new: listed after a compaction, and after a restart
    before the log is loaded), `test:rollback` 53 (the same plan, reading fewer notes).
  - With this the six small fixes of PHASE7 are done.

- **0.8.7** (2026-10-23) - a note whose share ended while a device was away no longer
  keeps the words that device replaced meanwhile. `test:recovery`'s check "carries on
  in the same note, and what it wrote while away reaches P1" failed again (once on
  2026-10-16, now once more), and its log said why: the device came back, and the
  index change of the fork - the old note's tombstone and the new note, one change -
  arrived after it had applied the remote deletes but before its scan reached the
  file. The scan reconciled the file against the new note, which had no base on this
  device - the device that forked moves the base along, this one had not yet -, so
  replaced text was merged as a union. A note without a base now takes the base of the
  note it carries on (`DocStore.baseFor`, the tombstone's `forkedTo`), wherever a base
  is read: the scan, the write-back and the binding's merge.
  - A race: not reproduced on demand, and not put back. Before the fix it failed now
    and then - twice since 2026-10-16, over many runs -, so five passing runs with it
    show little; the log line `merge (no common base, union)` is the sign to look for.

- **0.8.6** (2026-10-23) - signing the account's devices out ends their sessions with
  backup servers too (PHASE7, small fix 5). The relay checked a device's token only
  when its connection opened, and did not know a device's connection by its account, so
  a session opened before a password change, a recovery, turning 2FA on or the account's
  removal went on. The relay now keeps the devices' connections per account and closes
  them with `4401` on the same hook that closes the vault sockets (`RoomHub.onDisconnect`,
  `Relay.signOut`); a device that changed the password itself closes its sessions before
  it reaches its backup servers again with the new token.
  - Server only, and the device's order of closing; a 0.8.5 plugin opens new sessions
    the same way after the close.
  - Tests: `test:rooms` 372 (2 new, the relay with fake sockets), `test:backup` 228
    (a session opened before a password change ends with it). Checked by putting the
    bug back: without the hook in `server.ts`, `test:backup`'s new check fails, and
    nothing else.

- **0.8.5** (2026-10-23) - the device that changes the password or turns two-factor
  sign-in on is connected again at once (PHASE7, small fix 4). The hypothesis was
  confirmed first with timestamps in `test:account`: from the server's `4401` close to
  the socket's next connect took 1016 ms after a password change and 1011 ms after
  turning 2FA on - the reconnect's backoff of a second, plus a `refresh` the device
  asked although its own request had just brought the new token. A token known to hold
  now reconnects at once with the backoff reset (`VaultSocket.reconnect`), and a close
  within ten seconds of the device's own request moving the session generation is
  taken for that request's, once, without asking (`Session.stillSignedIn`). A server
  that could not be asked still means the backoff.
  - Tests: `test:account` 52 (2 new: connected again within half a second after a
    password change and after turning 2FA on - both failed at a second before the fix).

- **0.8.4** (2026-10-23) - a note purged on one device is cleared on every device of
  the account (PHASE7, small fix 3). Only the purging device cleared its local copy -
  the note's database and its decrypted history; the others had dropped the note
  without clearing it and never opened its database again, so they kept it for good.
  The trash pass, which runs on every device, now clears the copy of every purged
  tombstone that is not loaded (`DocStore.clearPurged`), once: `StateStore` remembers
  it (`cleared.json`), so no database is opened - and so made - again. The text was
  backed up when the file went to the trash (invariant 2).
  - Checked by putting the bug back: with the trash pass not clearing, the two new
    checks fail (the other device still holds the database and history), and nothing
    else.
  - Tests: `test:vault` 241 (2 new).

- **0.8.3** (2026-10-23) - content uploaded but never named no longer stays on the
  server for good (PHASE7, small fix 2). A crash, stop or delete between an upload and
  its index entry - the order invariant 23 demands - left a blob nothing names, and
  nothing could find it. The server lists a store to its owner (`GET
  /blobs/:account/:vault/list`: complete blobs with their size and last touch, uploads
  under way with their last chunk), and the trash pass lets go of what no entry,
  tombstone, version or shared base names and was untouched for longer than the
  retention - a week at least; a retention of 0 still keeps everything. Two hazards
  next to it, fixed too: content a device found on the server was named without
  touching it, so a device cleaning up could delete it under the new name - now every
  reuse touches it (`POST .../touch`, `Blobs.keep`) and uploads it again if a purge was
  first; and a purge dropped an upload still under way, with no grace - now it keeps
  one whose last chunk is recent.
  - Server: the two routes; a 0.8.2 plugin never calls them, a 0.8.3 plugin against an
    older server treats them as absent (no listing, reuse as before).
  - Tests: `test:rooms` 370 (8 new: the listing, a touch, an upload under way kept and
    then dropped, the routes for the owner only), `test:recovery` 71 (7 new: unnamed
    content kept while new and for a week, gone past the retention, nothing a file
    names touched, content a purge took uploaded again before it is named).

- **0.8.2** (2026-10-23) - typing into an open note while sync restarts (signing out
  and in, a changed setting) no longer loses keystrokes (PHASE7, small fix 1). The new
  store settled the note against what Obsidian had last saved and wrote the file;
  Obsidian reloaded the editor, and whatever was typed since that save was gone. A note
  an editor shows is now Obsidian's to write even while no binding holds it
  (`DocStore.watchEditors`, `settleShown`): the store makes the server's state known
  and seeds an empty document as every device does, and leaves buffer and document to
  the binding, which merges them against what both said when it let go (`released`,
  backups first). Nothing writes such a file meanwhile; once its editor closes, the file
  is brought level. The texts the stopped store's editors held pass to the next store
  of the same vault (invariant 25).
  - Checked by putting the bug back: `test:vault`'s new restart with both people typing
    failed (`ABCDsFGHIJ…tart` - B's keystrokes and A's text mixed), and passes with the
    fix. The check for a restart where only the other person types passes either way:
    the held texts passed on are not shown to matter by a test.
  - Tests: `test:vault` 239 (9 new); the harness restarts sync with its views kept
    (`shutdown({ keepViews })`).
  - The backup server's tests for shared folders over time came before it, without a
    version (`test:backup` 227).

- **0.8.1** (2026-10-23) - the files of a shared folder (E8): every file inside it
  belongs to it, lies at the same place for everyone and follows the rules of the
  notes - a writer's new file, rename, new version and delete are everyone's (the
  delete in the same notice with Undo), a reader's stay theirs, an existing file
  moved in is asked about in the same window as a note. Each vault copies a file into
  its own store and keeps it as a file of its own, linked to the folder's; versions
  follow the rules of a shared note's files (invariants 23, 24): a base per file, the
  version each entry replaced, both kept when both sides changed - and the second
  version goes into the folder too when it was made by someone who may write, so
  everyone keeps both. Content in the store of someone who left is taken over by the
  owner's.
  - The share dialog asks about files outside the folder that its notes embed or link
    (on by default, the folder's choice for everyone, as a shared note's): they land
    in each share folder's `Attachments`. And it offers to share, once, the notes
    outside the folder its notes link to, as the note's dialog does - inside the folder
    nothing is listed, that goes along anyway.
  - A conflict copy the plugin makes is now announced as a file new on this device,
    as one the user made is - otherwise it never reached a shared folder.
  - A file deleted for everyone and brought back from one's own trash comes back for
    everyone (from someone who may write; a reader keeps it as their own) - the
    folder's next pass deleted it again at once.
  - Three bugs of 0.8.0 that files made visible, all three fixed for notes too:
    - Sharing a folder asked about every note and file already in it as moved in -
      on the sharing device and the owner's others -, while the share was taking them
      in: on a device a window per note. What lay in the folder when it was shared
      (`VaultFolder.sharedAt`) is never asked about now.
    - Another device of the account brought a note or file back that a writer's device
      was still deleting for everyone: it saw the delete in the vault index before the
      folder's decision. A delete there is left to its device for `decideMs` (30 s)
      before it counts as never decided on.
    - A file published from one device arrived on the account's other device before its
      link in the vault index, which then fetched it a second time (`pic 2.png`). The
      link goes first now, and a file of the vault's own with that content at that place
      is taken for the folder's.
    Each made `test:folders` fail in one of the runs before its fix - the first showed
    as a file published twice, the window answered by the harness. Its own check ("no
    window for what the folder held") came with the fix and was checked by putting the
    bug back: it alone failed, the owner's device asking about `Plan.md`, `Sub/Deep.md`
    and `pic.png`. The other two are races and were not put back.
  - Tests: `test:folders` 88 (25 new: a file reaching every device, a writer's new
    file, the owner's version, a reader's version staying, both sides changed with the
    writer away, rename, delete with Undo, a reader's delete, a file moved in, deleted
    and brought back from the trash, a file outside embedded by a folder note, no window
    for what the folder held when shared).
- **0.8.0** (2026-10-23) - a folder is shared with people, everything added to it later
  included, as the user decided it (E0 to E8 in `docs/PHASE7.md`). The folder's menu
  shares it - the dialog says first that whatever is added later goes along and that a
  delete in the folder is a delete for everyone -, shows who has it, changes access,
  removes someone and stops sharing; a member makes a copy of their own there. The
  folder is a room of its own on the server, whose members reach every note in it;
  one key per folder epoch, sealed to each member once, opens them all, so a note
  added tomorrow needs nothing sealed. It lands in the share folder of everyone it is
  shared with and is marked in the file explorer.
  - Notes added by anyone who may write belong to the folder's owner and take their id
    from the folder, the same for everyone. A reader's own note stays theirs.
  - A rename or delete inside the folder by the owner or a writer is everyone's; a
    delete says so in a notice that undoes it, and the folder's trash brings it back. A
    reader deleting lets the note go for their account only. The owner moving a note
    out ends its share there (everyone keeps a fork); a member moving one out only puts
    it elsewhere. An existing note moved in is asked about in a window over everything
    on every device of the account until one answers - a participant's own is copied in
    as the owner's. Revoking someone, the owner deleting the folder and a member leaving
    end the share; every note is forked, one shared on its own as well stays shared.
  - Single shares of a note in a folder take each new key from the folder's epoch, and
    the backup server reads folder notes with the folder's keys - a frame it cannot
    open is now a problem of that note, never a failed run.
  - Two bugs found on the way, both now invariants (28, 29): a note's folder epochs
    were kept with its membership of the folder and lost when it left, so its owner
    could no longer read them; and a note another device of the owner placed at a
    folder's old place while the folder moved brought the folder back there, the move
    then read as every note moving out - each share would have ended.
    `test:folders` reproduced the second before its fix (two failures) and passes
    since; the first is checked in `test:rooms` (the ties after leaving).
  - Server: protocol 5 - the folder routes, a subscribe that creates a note in a
    folder, the folder epoch in `caughtUp` and `rekey`, trailing so a 0.7 plugin reads
    both as before. Every device needs 0.8, the server first.
  - Tests: `test:rooms` 362 (72 new: access, joining and leaving, rotations, revoking
    with forks, ending, the sweep, restart, the routes), `test:merge` 171 (the folder
    keys, ids and ties), `test:folders` 63 (new), `test:backup` with an own and a
    shared-in folder restored exactly.

## 0.7 - the backup server (from 2026-10-15, spec `docs/PHASE6.md`)

- **0.7.19** (2026-10-21) - the schedule looks better (asked for by the user, the
  time above all): *On these days* with a button per day, Monday first - all seven
  are every day, and workdays only or one day a week are a click away -, the time as
  an hour and a minute in Obsidian's own dropdowns instead of the browser's time
  field, and the next backup said under it ("Next backup: tomorrow, 03:00
  (Europe/Berlin)"), the server's line no longer repeating it. A few clicks on the
  days are saved as one change. The schedule holds several days now (`weekdays`);
  0.7.18's single day is still read. The notice for an overdue backup waits for the
  longest gap between the days - three days over a weekend for workdays. Asked on
  the way: the trash does not count for the guard, only what is in the vault.

  And a held decrypted copy can no longer go unseen (the user tried the guard: only
  a row at the very bottom said so, and after *Follow anyway* it stayed, so nobody
  knew whether it had worked). A window over everything asks about it - opened when
  the settings open, whatever the tab, and live when a run holds the copy while they
  are open; the backup notice opens it with a click. It says what vanished in
  numbers ("Notes: 9 now - 24 at most in the week before, 63 % gone"), and offers
  *Deleted notes…*, *Not now* and *Let the copy follow*. Letting it follow is waited
  for to the end: the button spins, the window says what goes on, and it closes only
  once the run is done, with a notice of what was written and removed - or it says
  why not. Meanwhile the row in the Backups tab says that the copy follows, and
  nothing asks again. *Not now* is kept until the copy waits for another reason or
  the plugin starts again. The backup server's report carries the numbers
  (`trusted.shrunk`). `test:backup`: the copy held after twenty notes deleted -
  however the deletions reach the backup server -, the numbers on the device, "not
  now" kept for that hold only, nothing asking while the copy follows, and following
  waited for to the end.
  `test:backup`: the next workday across the weekend and the change of the clocks,
  the same night midweek, the days read sorted and once, a week of days as every
  day, 0.7.18's single day, the longest gap.

- **0.7.18** (2026-10-20) - when the backup server backs up, rclone, the password
  (asked for by the user after the first backups on the Pi; `docs/PHASE6.md`, "When it
  backs up, rclone, the password"). A backup at a time of day - every night at three
  unless set otherwise, or weekly on one day - by the clock of the device that set it,
  summer time included; every hour, every 6 hours and only by hand stay. A scheduled
  backup that is due waits until the vault's notes and files stayed as they were for
  five minutes, at most an hour; a device merely connected holds nothing up, and *Back
  up now* never waits. The first backup runs as soon as a task is saved. The image has
  rclone (1.75.1, checksum pinned), so a repository can lie in any cloud rclone knows
  (`rclone:<remote>:<path>`); `rclone config` in the container keeps its remotes in the
  data folder and runs as the backup server's user even through `docker exec`. The
  repository password is shown behind an eye instead of copied - a clipboard history
  would keep it. `test:backup` 187: the next time across both changes of the clocks,
  weekly, in another zone and in one not known; the backup that waits while someone
  writes, runs after five quiet minutes, and after an hour of writing all the same; the
  default of three by this device's clock. CI makes and lists a restic repository
  through rclone in the image, and checks that `rclone config` through `docker exec`
  leaves the configuration to user 1000.

  Two bugs the user found the same day, fixed in 0.7.18 before it went out:
  - **The guard let a large loss through in two steps.** The user deleted more than
    half of a vault and backed up at once; the first attempt said the backup server
    could not be reached, the second backed up - and the decrypted copy followed
    the loss. The guard measured each run only against the last run the copy
    followed: a loss that reached the backup server over two runs - deletions still
    on their way during the first, or a run started just as its answer got lost -
    passed in two halves, each below the limit. It now measures against the most
    the vault had at the runs the copy followed in the week before the newest; only
    *Follow anyway*, or following with the guard off, starts that afresh, and
    nothing is counted while the copy waits. The deleted notes were not lost: they
    are in the copy's hidden trash, in the repository and in the vault's trash.
    `test:backup` 201: a third of the notes deleted and backed up, then as many
    again - each step below half of the run before, together more than half - holds
    the copy; checked by putting the bug back (measuring by the last run): exactly
    the three new checks failed.
  - **The relay connection went every minute behind a reverse proxy.** The vault
    socket was always pinged by the server, the relay never: nginx closes a WebSocket
    on which the server sent nothing for a minute, so a backup server waiting for
    devices lost its connection - and every route with it - every minute, and a
    device asking in that moment heard "the backup server is not connected". The
    backup server called each such closing "the WebSocket on /relay was refused".
    The server now pings every relay connection every 30 s and lets go of one that
    stops answering; the backup server says "closed after it worked" for a connection
    that worked, and asks over HTTP only for one that never opened. `test:rooms`: a
    backup server's and a device's connection pinged and kept, one that stops
    answering let go with its routes. The sync server needs the update too.
  - And one CI found on the way: disconnecting a vault held its route back until
    the answer was out (0.7.9), but the backup server works its routes out again
    every tick, and a tick in between dropped the route - and, with no other left,
    the relay connection - first, so the device heard "the other side went away".
    The route now stays among the pairings until announced, and is announced even
    when no answer got out.

- **0.7.17** (2026-10-18) - one backup task per vault, and the backup server picks
  the paths (decided with the user after the first real test, `docs/PHASE6.md`, "One
  backup task per vault"). The test had set up a decrypted copy on its own - a backup
  without a repository and without history, not what the user meant: now there is
  always a restic repository, and *trusted* adds a decrypted copy beside it. The task
  says where the repository lies - *on the backup server* or *in a cloud* (a location
  restic reaches, with credentials) -, its password, retention and schedule, and
  whether to keep the copy, with its guard. Nobody types a path any more: the backup
  server has three folders, each a bind mount set in `.env` (`SERVER_DATA` at `/data`,
  `ENCRYPTED_VAULTS` at `/encrypted`, `DECRYPTED_VAULTS` at `/decrypted`), and keeps a
  vault's repository in `encrypted/<vault id>/` and its copy in
  `decrypted/<account name>/<vault name>/` - a second account of the same name gets
  its id added. The copy holds the vault at its top, so it opens in Obsidian; its
  trash and settings lie in the hidden `.obsidian-connect/`. It follows only once the
  repository took the run. A vault has one backup server: connecting another replaces
  it, its backups staying where they are. A task is checked before it is saved, the
  repository on the backup server taken up again with its password when the vault
  comes back, another password refused, saying so. `vaults` names vault and account
  and lists both folders. The image gets openssh-client for `sftp:`; `rclone:` is no
  longer offered (no rclone in the image). Settings of 0.7.16 do not carry over.
  `test:backup` 168: the task read and refused as it should, the folders by id and by
  name, the name taken by another account, the copy staying put while the repository
  refuses a run, a repository from before taken up with its password and another
  refused, the copy's folder refused when someone else filled it, a second backup
  server replacing the first. CI starts the image with all three folders bind-mounted
  and checks that each is handed over.

- **0.7.16** (2026-10-18) - the user's backup server, given the same `wss://` address
  as the devices that sync fine through a reverse proxy, reported "HTTP 403 on
  /health - is it the sync server?": something in front of the sync server refused
  it. The status now says so, with the usual reasons - the proxy's access list, a
  filter on the user agent, or a container resolving the name to another address
  (Docker falls back to public DNS when the host's resolver is 127.0.0.1, as on a
  Pi-hole). `check` shows the address the name resolves to inside the container and
  who answered (the `Server` header). `docs/BACKUP.md` gives the ways out: the
  container's `dns:`, `extra_hosts:`, the proxy's access list. `test:backup` 154: a
  proxy answering 403 recognised as such by `check`.

- **0.7.15** (2026-10-18) - no more `chown` by hand (asked for by the user: "other
  containers manage that too"). Both images start as root only long enough to hand
  their data folder - and the backup server its backup folder itself, not what lies in
  it - to the user they run as, `PUID`:`PGID` (1000:1000 unless set), and then run as
  that user (`docker/entrypoint.sh`, `su-exec`), as many images do. `docker exec` goes
  past an entrypoint and runs as root; the `obsidian-connect` and
  `obsidian-connect-backup` commands therefore drop to the same user themselves - an
  `accounts.json` or an invitation written as root could not be written or read by the
  running server afterwards. Started with `user:` in compose, nothing is handed over,
  and 0.7.14's check says what to do. CI now starts both images on a bind-mounted
  folder that is someone else's - the runner's - and checks that it is taken over,
  that what the commands write through `docker exec` belongs to user 1000, that the
  program does not run as root, and that the backup server still answers an invitation
  made that way; and that started as another user, an unwritable folder is refused.

- **0.7.14** (2026-10-18) - the sync server checks at start that it can write its
  data folder. With the compose file's bind mount, a `data` folder Docker made
  belongs to root while the image runs as user 1000: the user's server started,
  failed on the first request that wrote (`EACCES ... /data/server.json`), and the
  plugin only said it "answers, but not as expected". Now it stops at once, saying to
  give the folder to user 1000. `docs/SERVER.md` and the README make and hand over the
  folder before the first start, and say what a reverse proxy must pass on (`/vault/`
  and `/relay` as WebSockets). CI's smoke test of the server image checks the refusal.

- **0.7.13** (2026-10-18) - with `ws://192.168.168.67:1234` the user's backup server
  still said only "closed (1006)": the container does not reach the host's LAN
  address, as on many hosts where the sync server runs too. And the status could
  not tell an old image from a new one, and lost 0.7.12's explanation with every new
  attempt. Now: `status` names the running version; what asking over HTTP found stays
  beside every new attempt; common failures are said plainly (no answer - a firewall;
  refused - nothing listens there; a name that does not resolve); and `check` tries the
  way to the relay from inside the container, now, step by step, with what works on
  one host - both compose files in one folder and `ws://obsidian-connect:1234`, or
  `network_mode: host` and `ws://127.0.0.1:1234`. `test:backup` 153: `check` against
  a port nothing listens on and against the sync server, the plain explanation kept.

- **0.7.12** (2026-10-18) - 0.7.11's `status` on the user's Pi said "NOT connected:
  the connection closed (1006)" for `wss://192.168.168.67:1234`: TLS to the sync
  server's own port, which speaks plain `ws://` - and 1006 says nothing more. A
  connection that fails without a reason now makes the backup server ask the sync
  server's `/health` over HTTP and over TLS, and say what it found: no TLS on that
  port (use `ws://`), TLS where `ws://` was given (use `wss://`), or a server that
  answers while its proxy does not pass `/relay` on as a WebSocket. The backup
  server's data folder in `docker-compose.backup.yml` is `./backup-data` (asked for by
  the user), so it can lie next to the sync server's compose file, whose is `./data`.
  `test:backup` 150: a backup server given `wss://` for the test server's port says to
  use `ws://`.

- **0.7.11** (2026-10-17) - the backup server says whether it reaches the sync
  server. The user's first connect on a Pi failed with "the backup server is not
  connected", and nothing on the backup server said why: the running server only
  logged "cannot be reached", without a reason. Now it keeps how its relay
  connection stands - connected since when, or not, and the reason the last attempt
  gave (`ECONNREFUSED`, a name that does not resolve, a proxy's close code) - and
  writes it for the command line (`status.json` in the data folder). New:
  `obsidian-connect-backup status` (the connection, every open invitation answered or
  not); `invite` waits until the running backup server answers the new invitation and
  says so, or why not, with what to look at - on the same host as the sync server the
  public address often does not work from a container. An address without its
  scheme, which failed silently, and a data folder it cannot write - a bind mount
  Docker made as root - stop it at start, saying what to do. The device says what
  "not connected" means for an invitation. `test:backup` 149: the status of a
  backup server that reaches the sync server and of one that does not, `invite` and
  `status` run as the operator runs them. CI now starts the image against a real
  sync server and checks that it registers its invitation, and that it refuses a
  data folder it cannot write.

- **0.7.10** (2026-10-17) - a fix the user ran into deploying the server on a Pi:
  signed in, the server set up again from scratch, the device signed out by the new
  one - and then stuck. The device still pinned the old server's id, so signing in
  and creating an account both said "sign out first", and there was nothing to sign
  out of. The settings now see that the server at the address has another id, say
  so - with a warning that someone may be posing as the server otherwise - and offer
  "Use this server", signed out only; signing in and creating an account wait for
  that choice instead of failing. The error, when it still comes, names the way out.
  `test:recovery` 64: exactly that sequence, ending in a new account on the new
  server that the vault's notes go to and a second device finds. Checked by putting
  the bug back: with "Use this server" letting go of nothing, the device stayed stuck
  where the user was.

- **0.7.9** (2026-10-17) - rolling back further than the history reaches, from restic
  (decided with the user: "history first, restic where it no longer reaches - a
  manual restore would be a nuisance"). The backup server reads a vault's own backups
  back over its pairing, read only: the newest backup at or before a moment, what it
  holds by path with SHA-256, and the paths asked for, in pieces. A rollback takes
  what the history no longer reaches from there - a note's text, a file's content
  the sync server let go of -, and when the vault index itself is out of reach, the
  whole vault by path. Content the sync server still has comes from there; only what
  it lost is read back and uploaded before an index entry names it. The backup a
  rollback makes first forgets no snapshot, so the one it reads from next is still
  there. The dialog says where content comes from. And a fix: the backup server
  sealed session messages concurrently, so a message could overtake another and end
  the session at the device (a run finishing during a request could do it; a stream
  of pieces made it likely) - its sends are in order now. `test:backup` 144: a vault
  rolled back by name from a real backup with its history compacted away - texts,
  a note that came later, one deleted since, a picture whose content only the backup
  still had, a note someone else shares in kept -; one note filled from the backup
  while the other comes from the history; a repository not the vault's refused.
  Checked by putting the bugs back: with the fresh backup forgetting as usual, the
  rollback from the backup failed - its snapshot was gone - and with any repository
  accepted, the refusal check failed; nothing else. CI on the branch then found a
  race the development machine never lost: disconnecting a backup server's last
  vault dropped its last route, its relay connection closed, and that overtook the
  answer to `disconnect` - "the other side went away". The route now goes only once
  the answer is out, as a spent invitation's does (0.7.6).

- **0.7.8** (2026-10-17) - rolling back, from the history (asked for by the user, with
  a backup of everything first). *Roll the vault back…* (command, *All devices*, the
  root folder's menu) or *Roll this folder back…*: choose a moment, see per kind what
  changes - texts, what came later and goes to the trash, what comes back, renames
  undone, files likewise -, which of them are shared with others, and what the
  history no longer reaches. Before anything changes, every backup server makes a
  fresh, checked backup; if one fails, nothing changes unless the person says so. A
  copy of everything that changes goes into the plugin folder, `rollbacks/<date
  time>/`, and a record into the account's settings, from which every device offers
  "Undo…". Then the plan is applied as changes a person could make, so every device
  follows. Others' shared notes stay as they are. A compaction now stamps its snapshot
  with the time of the newest change it holds, so the history reaches as far as it
  can. And a sync bug the new test found: two notes, or files, that swapped names on
  one device never swapped on the others - each rename waited for the place the other
  held - and a restart's scan then took each file for an edit of the other note
  (invariant 27). `test:rollback` 52 (new, in CI): the plan, the gate refusing before
  anything changes, the vault as it was on every device and for the person a note is
  shared with, the copy, the trash, undoing the rollback, a folder alone, a note
  compacted past the moment out of reach and left alone only when agreed, the index
  compacted past it. `test:backup` 126: a fresh backup started and waited for. Checked
  by putting the bugs back: without the swap via a free name, without the gate in the
  core, and with the compaction stamped with its own time, exactly those checks
  failed, plus those that follow from a rollback the gate let through. The dialog is
  for a device.

- **0.7.7** (2026-10-17) - the settings in tabs (Account, Contacts, Backups, This
  device, All devices; signed out, Account and This device), asked for by the user as
  the one long page grew. A destination can be changed afterwards (the pencil next to
  it): a repository's retention - a preset or numbers of one's own per rule - and
  credentials, checked by the backup server before they are saved; the trusted copy's
  guard. Each row says what it keeps or when it waits. **The guard counts notes and
  files, apart:** the trusted copy waits when more than its share (50 % unless set, 10
  to 90 %, or never) of the notes, or of the files, vanished since it last followed -
  counted together, a vault of many pictures could lose all its notes unnoticed. And a
  fix the new check found on its first run: after a change of retention a backup
  started right away went by the settings before it - the device waited only until the
  backup server listed the same destinations, and the ids had not changed (the
  repository kept 4 snapshots where `last 1` should have left 2). The status now
  carries a hash of the settings the backup server read for its route, and the device
  waits for the hash of its own. `test:backup` 125: the guard's arithmetic (notes and
  files apart, the limits, off, too few to count), its value as read from the
  settings, the settings hash the same on both ends, pictures vanishing holding the
  copy and naming the files, a guard turned off following at once, a retention changed
  from the settings taking effect with the next backup. The tabs and the dialog are
  for a device.

- **0.7.6** (2026-10-17) - invitations, and a pairing per vault, instead of one code
  per backup server (asked for by the user: one code for everyone could not be taken
  from one person without taking it from all, and let anyone with it use the disk).
  The operator invites per person (`obsidian-connect-backup invite [name]`, `invites`,
  `revoke`, `vaults`, `disconnect`); an invitation connects one vault, once, within a
  week. Connecting gives the vault a secret of its own with the backup server, kept in
  the account's encrypted settings; a session on it reaches that vault and nothing
  else, and the backup server keeps whose vault it is, so another account cannot take
  it over. A password change hands out a new key over the pairing - no new invitation;
  connecting the same vault again replaces its pairing and keeps its destinations. The
  relay keeps many routes per connection (an invitation, every vault) and ends a
  route's sessions when it goes; the backup server's code and `code` command are gone.
  Two orderings the first run of the test found: the invitation was spent before the
  answer, so the relay ended the session before the device heard its pairing; and a
  vault connected again named its new route as the one replaced, so its destinations
  stayed behind. `test:rooms` 284 (routes, unregistering, limits), `test:merge` 164,
  `test:backup` 103: invitations made, mistyped, expired, made and withdrawn on the
  command line, spent; a vault's pairing, someone with only its route turned away,
  another account neither connecting nor rekeying someone else's vault, the operator
  disconnecting one vault while the others carry on, the password change, connecting
  again. Checked by putting the protections back out: without spending an invitation,
  and without the check that a grant belongs to the paired vault, the checks for them
  failed, and one more that follows from the takeover (Ben's destination check then
  ran against Anna's vault), nothing else. CI's smoke test makes and lists an invitation in the data volume.
  The dialogs are for a device.

- **0.7.5** (2026-10-16) - a backup server whose key ended - a password change while it
  could not be reached - or which lost what it knew of the vault shows "Connect
  again…" in the settings: the code is filled in, the password gives it a new key,
  its destinations stay. Before, it had to be disconnected and connected anew. Only
  for a device to see; `test:backup` covers the connecting again underneath (0.7.3).
  And a fix CI's first start of the image found: with the sync server not answering,
  the backup server ended quietly a second after starting - between two attempts
  nothing kept the process alive (every timer was unref'd, and waiting for a signal
  does not count). The schedule's timer now does. Checked by CI's smoke test, which
  failed on 0.7.4 with "the backup server stopped".

- **0.7.4** (2026-10-16) - the backup server as an image, `obsidian-connect-backup`
  (`Dockerfile.backup`: restic 0.19.1 from its release, checked per architecture,
  amd64 and arm64), with `docker-compose.backup.yml` (the data volume, the backup
  folder, the RAM disk) and `docs/backup.env`; `docs/BACKUP.md` for running it,
  setting it up in Obsidian and restoring with restic. CI's new `docker-backup` job
  builds and starts the image on every push - restic runs, the code is made and kept
  in the data volume as the unprivileged user, the server keeps running when the sync
  server does not answer - and publishes it from `main`. The backup server logs when
  it cannot reach the sync server. Milestone 0.7 is built.

- **0.7.3** (2026-10-16) - backups in the plugin's settings. *Settings → Backup
  servers*: connect one with its code and the password, add destinations - a restic
  repository (a folder below the backup server's backup folder or a cloud location,
  its password made on request, credentials, how long backups are kept) or the
  trusted copy -, each checked by the backup server before it is saved; choose how
  often; start a backup; see how the last one went per destination; let a waiting
  trusted copy follow; disconnect (from any device, which deletes its key). A
  password change and a recovery give every backup server a new key at once. A notice
  when a backup failed, the trusted copy waits, or there has been no good backup for
  twice the schedule - also when the backup server cannot be reached. A command backs
  up on every backup server. `test:backup` 91: the settings' side against a real
  backup server - connected, a repository made, a folder outside refused before it
  is saved, the schedule, a run, a password change ending the key and the device that
  made it handing out a new one, another device of the account seeing and
  disconnecting it. The dialogs, the settings section and the notice are for a device.

- **0.7.2** (2026-10-15) - the backup server reachable from a device, through the sync
  server; no settings screen yet (0.7.3). The sync server has a relay (`/relay`): a
  backup server registers under the hash of a token from its code, a signed-in device
  opens a session to it, and the frames pass unread. The backup server makes its code
  on its first start (`npm run start:backup`, or `obsidian-connect-backup code`). The
  session's key depends on the code, which never travels: the backup server proves it
  knows the code before the device says anything but an ephemeral key, and the device
  proves it in turn (`shared/crypto.ts`). Over the session a device connects a vault
  (the grant), checks a destination, starts a run and hears how it went, asks the
  status, disconnects; everything about a connected vault needs that vault's key
  shown for the session. The backup server reads where to back up from the vault's
  settings (`backupTarget:`, `backupSchedule:`), keeps local folders below its backup
  folder and out of other vaults' folders, and runs on its schedule. `test:merge` 163
  (the code, the handshake against a relay posing as the backup server, messages
  tampered with, replayed, reordered, reflected), `test:rooms` 278 (the relay),
  `test:backup` 76 (a backup server in the process, reached with its code: a wrong
  code reaches nothing, someone who knows only the route is turned away, another
  account can neither see nor start nor claim the vault nor write into its folder,
  the schedule, disconnecting). Checked by taking three protections out - the vault
  shown per session, the vault's proof, other vaults' folders -: exactly their four
  checks failed.

- **0.7.1** (2026-10-15) - the backup run, in a new package `packages/backup`; not
  reachable from the plugin yet (that comes with the relay, 0.7.2, and the settings,
  0.7.3). A device grants a backup server one vault (`Session.makeBackupGrant`: a
  backup key and the vault's keys); a run fetches what changed into an encrypted cache,
  decides from the index what the backup holds - the vault, the trash, the settings
  without contacts -, lays the notes and canvases out in a RAM disk for restic and
  streams the attachments to it as a tar, per destination, checks the snapshots back,
  and brings the trusted copy level (details under "As built (0.7.1)" in
  `docs/PHASE6.md`). New `test:backup` (55, with a real restic 0.19.1; CI installs it):
  restored with restic and the system's tar, the vault is all there; a run without
  changes fetches nothing and makes no files snapshot; `restic diff` names exactly the
  notes that changed; a deleted note moves to the backup's trash; the trusted copy
  follows and waits when half the vault vanishes; a sync server restored from an old
  copy is noticed and its note backed up whole; a deleted backup key ends the backups.
  Checked by taking three protections out at once - restic killed before a failing
  stream ends, the trusted copy waiting, the frame compared at a partial fetch -: their
  checks failed (plus one that follows from the third), nothing else. `test:load` now
  compares the version of every package, not only the plugin's.

- **0.7.0** (2026-10-15) - the sync server's side of backups; nothing for the user to
  see yet. A **backup key** reads one vault: made by a signed-in device with the
  current password (`POST /account/backup-keys`), listed in the account bundle,
  deleted from a device (`/delete`), and ended with every other by a password change,
  a recovery and the account's removal. `POST /auth/backup` signs a backup server in
  with it (paced and guarded like a sign-in) and answers a token of scope `backup`,
  valid an hour: it reads the vault's index, settings, notes - its own and those
  shared into it - their sealed keys and the vault's blobs, and nothing else; every
  route that writes refuses it, and the key is looked up on every request, so deleting
  it ends its tokens at once. For fetching only what changed: `GET /backup/rooms` (the
  vault's rooms with a tag that changes with the log, from the metadata and the log's
  size - no log loaded) and `GET /log/:room?from=<seq>` (the frames from that seq on,
  that frame included, while it is still there; the whole log otherwise). `/auth/config`
  names the feature `backup`; `user list` counts backup keys. `test:rooms` 268 (32
  new). Checked by taking the protections out: without the vault check on reading
  routes, and without a password change ending the keys, exactly their checks failed.

## 0.6 - recovery codes and two-factor sign-in (from 2026-10-12, spec `docs/PHASE5.md`)

- **0.6.8** (2026-10-14) - an open settings tab shows what changed on another device,
  without a restart. Asked by the user: 2FA turned off on one device still showed as
  on elsewhere, and so did every setting of all devices. Those settings were applied
  live all along (they are a synced document); only the tab was not drawn again - now
  it is, on every change from elsewhere (`AccountSettings.onChange(…, remote)`). The
  account's state - 2FA, the recovery code - lives on the server: it now tells the
  account's devices (`account-changed`) when 2FA is turned off or a recovery code
  made or deleted, and a device asks again on reconnecting and whenever the tab
  opens (`refreshAccount`). A field being typed in is not rebuilt under the cursor:
  the tab waits until it loses the focus. Turning 2FA on, a password change and a
  recovery sign the other devices out, as before. Server and plugin both change; an
  older plugin ignores the notice. `test:rooms` 236, `test:account` 50, `test:merge`
  150. Checked by putting the bug back: without the server's notice, the two new
  checks in `test:rooms` and the two in `test:account` failed, and nothing else.

- **0.6.7** (2026-10-14) - every button that waits for the server or the disk greys
  out and spins the moment it is clicked, and takes no second click meanwhile
  (`busy`, `src/busy.ts`; `.connect-busy` in `styles.css`). Asked by the user: clicks
  in the settings often showed nothing for seconds. The settings (sign in, create,
  recover, sign out, switch vault, contacts, check the server, download, copy log),
  the password, recovery-code and 2FA dialogs - Enter spins the button it stands
  for - and sharing, access, incoming shares, the trash, backups, version history and
  "Compare versions". `test:merge` 149. Seen only in tests with a stand-in button;
  how it looks is for a device.

- **0.6.6** (2026-10-14) - turning two-factor sign-in off takes the password alone.
  Asked by the user: it is what someone does whose phone is gone while a device is
  still signed in, and the code added no security - device and password already make
  a new recovery code, and a recovery with it turns 2FA off. Server and plugin both
  change: `/account/totp/off` ignores a code, the dialog is the password prompt, and
  a plugin talking to an older server that still wants a code says to update it.
  `test:rooms` 233, `test:account` 48. With the 0.6.5 server code, the new steps of
  both suites failed.

- **0.6.5** (2026-10-13) - the cause of the conflict markers the user saw (invariant
  26). The user had typed on one device; on the other the note was only open, and no
  third device was online. That other computer had loaded 0.6.3 at 19:59:47 and was
  unloaded 12 s later without having connected: its start was still waiting, went on
  after the unload and built a whole second copy of the plugin - connection, store,
  documents - with no editor and a log already closed. That copy wrote the file on
  every change from the typing device and took Obsidian's saves of the editor of the
  live copy, a few keystrokes behind, for edits made there: two merges, nested
  conflict markers, and no merge in any log file. It was the third client in
  `3 present` - one that renewed its presence in all three shared notes at the same
  moment, never with a caret. 0.6.4's fix covers a rebinding editor, not this, since
  that copy never had an editor. Now every stop bumps a run number (`syncRun`), a
  start checks it after every wait and builds nothing once it moved, and an unloaded
  plugin never starts again (`onLayoutReady` calls it back too). A stop during
  `store.start()` no longer leaves `started` set for the next start. `test:load` 14.
  Checked by putting the bug back: with the 0.6.4 `main.ts`, the start went on after
  the unload and built a socket, and both new checks failed.

- **0.6.4** (2026-10-13) - conflict markers on a device nobody typed on, and keystrokes
  lost while an editor bound again (invariant 25). Reported by the user: two devices
  online, fast typing on one, and the note came out with nested `<<<<<<<` blocks.
  When an editor binds again while someone types elsewhere - the note shared or
  unshared, its access changed, the editor letting go - the file Obsidian last saved
  lags the document by a few keystrokes, and so does the editor. Both were taken for
  edits made on that device and merged three ways against an older base, which saw
  both sides change the same line. Now a text the document already held is an older
  copy, never an edit (`DocStore.heldBefore`: fingerprints of every text a note with
  an editor had), and a save the document went past counts as an agreement. An editor
  binding again compares itself with what it and the document said when it let go
  (`released`), and the file stays Obsidian's meanwhile (`EditorSync.rebinding`):
  writing it made Obsidian reload the editor, and whatever was typed in between was
  gone. The log: a note or file kept in two versions is an error, "Copy log" puts
  errors and warnings first, presence and carets are logged only when they change, an
  editor binding again is logged, and a signed-out device's file transfers no longer
  log an error with a stack. "Detailed logging" is a setting of its own, apart from
  "Log". `test:vault` 230, `test:merge` 145. Checked by putting the bug back: with the
  0.6.3 sources, the three new checks of A typing while the note is shared and
  unshared and B's editor binds again failed (conflict markers, characters lost), and
  nothing else. Neither of the user's two logs shows the merge that happened; the
  third client present in the note turned out to be a second copy of the plugin
  (0.6.5).

- **0.6.3** (2026-10-12) - a recovery can keep two-factor sign-in. Asked by the user
  after trying 0.6.2: a forgotten password meant a new entry in the authenticator app.
  `/auth/recover` now says whether the account has 2FA, and the plugin asks
  (`askKeepTotp`): a current code from the app keeps it with the same secret,
  "Turn it off" does what 0.6.2 did, closing cancels the recovery. The code travels
  with `/auth/recover/commit` (`totpCode`). It is checked like a sign-in code: its
  step is spent, and a wrong one counts against the account and changes nothing,
  so the recovery code is not spent and the plugin asks again. Once codes are
  blocked, the dialog offers only to turn it off. A 0.6.2 plugin sends no code and
  gets the old behaviour. `test:rooms` 233, `test:account` 46. Checked by putting
  the bug back: with the recovery always turning 2FA off, the 12 new checks in
  `test:rooms` and 5 in `test:account` failed, and nothing else.

- **0.6.2** (2026-10-12) - two-factor sign-in with TOTP, optional per account. The
  settings turn it on in three steps (`TotpSetupModal`): the password, checked on the
  device against its master key; whether the recovery code is at hand, offering a
  new one (or making the first); then a QR code (`qrcode-generator` 2.0.4, drawn as
  an SVG of its own, dark on light), an `otpauth://` link for a phone running
  Obsidian, the key to type, and a first code checked on the device before the
  server is asked. Turning it on signs out every other device. Signing in is two
  steps: the right password answers `403` with a challenge token of scope `2fa`
  (5 minutes), `/auth/login/totp` takes it with the code (`askTotpCode`). A used
  time step is spent; five wrong codes block codes for that account for 15 minutes,
  on top of the address throttle. Off with password and a current code, by a
  recovery (which offers to turn it on again), or by the admin
  (`obsidian-connect user 2fa-off <accountId>`); `user list` shows `2fa`. A 0.5 or
  0.6.0/0.6.1 plugin signing in to such an account shows a message to update.
  `test:merge` 142 (RFC 6238 vectors, RFC 4648 key, the link), `test:rooms` 220,
  `test:account` 40. Checked by putting the bug back: without `lastStep` the server
  took a code twice - four checks failed.

- **0.6.1** (2026-10-12) - the recovery code. Every new account gets one, shown once
  (`RecoveryCodeModal`: copy, "I have written it down"); the settings show whether
  the account has one and make a new one or delete it, asking for the password
  (`PasswordPromptModal`). "Use a recovery code…" on the sign-in screen opens the
  account with the code alone and sets a new name and password; the code is spent,
  the new one shown, every other device signed out. 30 characters in six groups,
  128 random bits and a 22-bit check, so a typo is caught on the device
  (`encodeRecoveryCode`); the server finds the account by the hash of a key from
  it (`recoveries` in `accounts.json`) and keeps a second wrapping of private key
  and account secret, which only the code opens. Every new wrapping is checked to
  open again before it is sent. `user list` shows which accounts have a code.
  `test:merge` 138, `test:rooms` 190, `test:account` 27.

- **0.6.0** (2026-10-12) - a password change signs out every other device on the
  server, not only the honest ones. Every account has a session generation, every
  token carries it (`gen`; tokens from before count as 0, so the update signs
  nobody out), and a token of an older generation is refused by every route, the
  refresh and the socket upgrade. The server closes the account's open sockets with
  `4401` (`CLOSE_SIGNED_OUT`); a stale or invalid token at the upgrade is closed the
  same way rather than refused, which a browser WebSocket would only retry forever.
  The plugin asks the server on `4401` (`Session.stillSignedIn`) and either carries on
  with its token or stops and says to sign in again; files and unsent edits stay. A
  removed account's devices are closed the same way instead of seeing every note of
  theirs revoked. New suite `test:account` (in-process server), `test:rooms` 165.
  Checked by putting the bug back: without waiting for its own password change
  (`Session.moving`), the device that changed the password read the server closing
  its socket as being signed out and signed itself out, 3 of 3 runs.

## 0.5 - attachments (2026-10-10 to 12, spec `docs/PHASE4.md`)

- **0.5.7** (2026-10-12) - the plugin's items in every file menu sit in a section of
  their own under a label with the plugin's name (`MENU_SECTION`, `setIsLabel`;
  submenus are not public API). Clicking the cloud opens the same menu, plus the
  trash and incoming shares. The cloud shows for attachments too
  (`AttachmentStore.fileState`; `local` for a file the server does not take). Beside
  it a mark for a shared note - a lock when only to read - and a lock in the header
  of every view of a read-only note, for phones (`markReadOnlyViews`). "Earlier
  versions" became "Version history", one command for notes and files. `test:vault`
  224.
- **0.5.6** (2026-10-11) - the share dialog says when the person has the note
  already, starts from their access and reads "Share again": sharing again is how
  the server changes their access, and the default "Can edit" turned a reader into
  an editor without a word.
- **0.5.5** (2026-10-11) - "Also share the notes it links to" (`share/LinkedNotes.ts`):
  the notes a note reaches through links, listed with the reason when one cannot go
  along, shared once with the same choices, landing below the share folder at their
  link's path (the sealed title carries folders; `DocStore.freePath`). A note the
  person has already is skipped. Incoming shares are taken one pass at a time, one
  notice for several; notices name contacts instead of account ids. Checked by
  putting the bug back: a title's folders flattened (`Shared/Ideas Roadmap.md`) and a
  note the person had shared again (their access overwritten) - four checks failed.
- **0.5.4** (2026-10-11) - shared notes carry their files, both ways, by the owner's
  choice per note (`share/SharedFiles.ts`), copied into each account's own store,
  landing in `<share folder>/Attachments/`; deleting a received file leaves it for
  good. Fixed on the way: compaction up to exactly a device's last frame was taken
  for a server restored from a backup, so every note untouched for longer than the
  retention would have been held and asked about (from about 2026-10-18 on).
  Checked by putting the bug back (B held every old note). The shared files'
  conflict and lineage paths are covered but were not each checked with the bug back.
- **0.5.3** (2026-10-11) - the trash in every folder's menu and in the settings; a
  note's version history renders each version, pictures deleted since shown from
  the trash with a Restore button.
- **0.5.2** (2026-10-11) - the trash and earlier versions of files, a preview for
  images, restore and save as a copy, cleaning up the server's blobs in the trash
  pass (10-minute grace on the server), the account's usage in the settings. Checked
  by putting the bug back: a clean-up that forgets what the server kept (trash entry
  lost) and one that purges content a live file needs (the server lost the scan).
- **0.5.1** (2026-10-10) - canvas card names that never left the device, and a
  conflict copy without the latest save: the base recorded the stat after the
  upload, and a conflict overwrote a file without checking it still held what was
  read (invariant 23). Events always read now, a scan every minute catches missed
  events, a view saving over another device's version keeps that version as a
  second file. All five old behaviours put back at once: each of the five new checks
  failed, nothing else.
- **0.5.0** (2026-10-10) - attachments between one's own devices: blobs encrypted in
  chunks, the server's blob store, `AttachmentStore`, conflicts as two files, the
  download limit, self-healing; a note renamed to another extension no longer comes
  back. Checked by putting the bug back: two racing writes of one attachment without
  the lineage rule (one version lost - invariant 24), healing only on start, a note
  renamed to `.txt` (pulled back in).

## 0.4 - the first device run (2026-09-27 to 10-10)

- **0.4.2** - another device's rename is applied with `vault.rename` (invariant 22):
  `fileManager.renameFile` rewrote links a second time (`[[RenamedRenamed]]`).
  Reproduced in `test:vault` by holding back both devices' note changes; fails with
  the old code.
- **0.4.1** - carets only of other people: the owner is told when the last
  participant leaves, and the awareness state names the account, not the name.
- **0.4.0** - "Compare versions" for notes kept in two versions; a log file per day;
  the note cloud; sharing in the note menus; friend codes listed and deletable;
  account screens; show-password eye; carets redrawn robustly. Version numbers
  introduced. A bundle built during a `git stash` check shipped old code;
  `test:load` now fails when a source is newer than `main.js`.

## Before version numbers

- **Phase 3** (2026-09-24 to 26, `docs/PHASE3.md`) - surviving a server that lost or
  rolled back data, accounts without names, contacts by one-time code, forking a
  share with its history, removing accounts, the trash; Docker image built by CI.
- **Phase 2** (2026-09-23, `docs/PHASE2.md`) - accounts, end-to-end encryption,
  sharing by person, Docker; fixes from the first device run of Phase 1.
- **Phase 1** (2026-09-18 to 22) - vault-wide CRDT sync, multiplexed transport, file
  bridge, three-way reconcile with backups, vault index, history. Found the
  ViewPlugin CodeMirror silently deactivated (invariant 6) and the text doubling
  between devices (invariants 7-9).
