# Changelog

Newest first. What each version changed and, where it fixed a bug, how the fix was
verified. `docs/PROGRESS.md` holds only the current state.

"Checked by putting the bug back" means: the old behaviour was restored in the source,
the suite run, the new checks seen failing (and nothing else), the fix restored.

## 0.7 - the backup server (from 2026-10-15, spec `docs/PHASE6.md`)

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
