# Phase 6 — the backup server (0.7)

Agreed with the user on 2026-10-15; the specification the implementation follows.
The order of work, each step with its tests and a commit, is at the end.

A backup of a vault, for the people who own it: a small server of its own - the
**backup server** - pulls a vault from the sync server, decrypts it in memory and
hands it to restic, which encrypts it again into repositories wherever the user said.
It is meant for a few private people (a household, a few friends), not for backing up
many people at scale.

The sync server stays what it is: it never holds a key (invariant 14). To it the
backup server is one more device of the account, one that only reads.

The server operator's backup - the data directory as it is, ciphertext only - is not
part of 0.7; it may come later.

## Decided with the user

- **A backup server of its own**, a Docker image for headless Linux, restic inside.
- **Several vaults, several accounts per backup server.** Whoever knows a backup
  server's code can connect their vaults to it.
- **Set up in the plugin, nothing typed on the backup server.** The backup server has a
  code of its own; whoever enters it in the plugin is connected to it, through the sync
  server, over a connection encrypted between the two ends. Paths, passwords, the
  schedule, the trusted copy - all of it is set in the plugin. The sync server learns
  where the backup server can be reached, never its code.
- **One vault, one backup key, any number of destinations.** A run pulls and decrypts
  once and writes into every restic repository of that vault, each with its own
  location, password and retention.
- **A password change and a recovery end every backup key**, as they sign out every
  other device.
- **A run is started by the schedule or by hand from the plugin.** It fetches only what
  changed and checks afterwards that the backup reads back.
- **restic encrypts everything** with a password per repository; that is the main
  backup. Locations are restic's: a path in the container, or any backend restic knows
  (S3, B2, a REST server, SFTP, rclone). A cloud folder can also simply be mounted on
  the host and given as a path.
- **The trusted copy, optional:** a path where the newest version of everything lies
  decrypted, brought up to date by every run - for when the restic password is lost.
- **Contents:** the notes and files of the vault, the notes others share with the
  account (as they lie in the vault), the trash, the account-wide settings. Notes as
  Markdown, not Yjs documents: a Yjs document keeps no history (deleted text is
  collected), it is unreadable without this software, and restic's snapshots are the
  history - coarser than the plugin's, but kept as long as the retention says.
- **Notes as a folder, files as a stream** (asked by the user): notes are small and
  lie in memory as a folder, so restic sees each note as a file of its own - which
  notes changed between two backups (`restic diff`), one note restored on its own,
  browsing with `restic mount`. Attachments travel as a tar stream instead, one file
  in memory at a time: pictures would fill the memory otherwise. Canvases go with the
  notes: small, edited like notes.
- **A backup server registers on the sync server without anything** - no account, no
  invite. The sync server relays only to signed-in accounts, so it is no open relay.

## The parts

```
plugin ──(account token)──► sync server ◄──(backup token, read only)── backup server ──► restic repositories
   │                           ▲   relay                                        │        trusted copy
   └──── encrypted session ────┘─────────────────────────────────────────────────┘
```

- **Sync server:** backup keys per vault and a token scope that reads one vault; a
  relay that forwards opaque frames between a plugin and a backup server.
- **Backup server** (`packages/backup`, image `obsidian-connect-backup`): its identity
  and code, the session, the encrypted cache, the run, restic.
- **Plugin:** a "Backups" section in the settings.

## The backup server's code

On its first start the backup server makes 16 random bytes - its **code** - and prints
it (and again with `docker exec … obsidian-connect-backup code`). Thirty characters in
six groups of five, with a check against typos, like the recovery code. It lies in
the backup server's data volume.

```
code ── HKDF "backup-route" ──► routeToken    sent to the sync server when the backup server registers
         routeId = SHA-256(routeToken)        what the sync server - and the plugin - address it by
code ── HKDF "backup-pair"  ──► psk           never sent; the handshake proves both ends know it
```

- The backup server only ever connects outward: one WebSocket to the sync server
  (`/relay`), on which it registers `routeToken`. No port of its own, nothing to open
  in a router. The sync server keeps `routeId` and learns `routeToken` at registration;
  neither leads back to the code, and neither opens a session - that takes `psk`.
- The plugin derives `routeId` from the code and asks the sync server for a session
  with it.

### Why the code is never sent, not even encrypted

Encrypting the code to the backup server's public key would need that key from
somewhere, and the only place is the sync server: a sync server handing out a key of
its own would decrypt the code and could then pose as the backup server for good.
So instead both ends prove that they know the code, and the session key depends on
it - a pre-shared key, as WireGuard and Noise (`NNpsk0`) use one:

```
psk = HKDF(code, "obsidian-connect backup-pair")
plugin → backup:  eP, nP                           ephemeral P-256 key, 16 random bytes
backup → plugin:  eB, nB, macB = HMAC(psk, "backup" ‖ transcript)
plugin:           checks macB - whoever answered knows the code
both:             keys = HKDF(ECDH(eP, eB) ‖ psk, "obsidian-connect backup-session" ‖ transcript), one per direction
plugin → backup:  AES-GCM { macP = HMAC(psk, "plugin" ‖ transcript), ... }
backup:           checks macP - whoever asked knows the code
then:             AES-GCM frames, a counter per direction as the nonce
```

`transcript = eP ‖ nP ‖ eB ‖ nB`. The relay sees ephemeral keys and ciphertext. It
cannot read a frame, cannot forge one, and cannot complete either side of the
handshake without the code. Fresh ephemeral keys per session: a code that leaks later
does not open sessions recorded earlier. A backup server answers failed handshakes
more and more slowly.

### What a session may do

- **With the code:** connect a vault (below), and ask what the backup server offers -
  its backup root, free space, restic's version.
- **For a vault already connected** - start a run, ask its status, check a destination,
  disconnect - the request also proves the vault's key: a MAC under
  `HKDF(vaultKey, "backup-control")`. Whoever has the code can use the backup server
  for their own vaults and never touch anyone else's.

## Connecting a vault

In the plugin, *Settings → Backups → Connect a backup server…*: the code and the
password.

1. The handshake.
2. The plugin makes a **backup key** for this vault on the sync server (password
   needed, as for the recovery code): 32 random bytes the server keeps only the hash
   of, bound to the account and this one vault.
3. Over the session: the backup key, the sync server's address, account id, vault id,
   the vault's name and key, and the account's private key (below).
4. The backup server signs in with the backup key once and answers whether it can read
   the vault. The plugin stores the code in the vault's settings, so every device of
   the account sees the backup server and can start it.

**Why the private key goes along:** notes others share with the account have keys
sealed to the account's key pair. Without it the backup could not include them.
The sync server still hands the backup token nothing outside this vault, but whoever
holds the backup server's data volume holds the key pair.

**A password change or a recovery ends every backup key** on the sync server. The
device making the change has the password at that moment, so it makes new backup keys
for every backup server the vault is connected to and sends them over a session at
once; a backup server that is not reachable then shows "access ended" until a device
connects it again.

**Disconnecting** deletes the backup key on the sync server - from then on the backup
server reads nothing - and tells the backup server to forget the vault, its cache and
its keys. Its restic repositories and the trusted copy stay where they are.

## What the backup token reads

Scope `backup`, one vault: its index and settings, the notes in it (its own and those
shared into it, `acceptedInto`), their sealed keys, the vault's blobs and the blobs its
shared notes name. Every route that writes refuses it. It carries the session
generation, so a token handed out before a password change stops at once. Two
additions for fetching only what changed:

- the vault's rooms with their head seq, in one request;
- a room's log after a seq, with the fingerprint of the frame there (invariant 19:
  a seq alone does not identify a log position).

*As built (0.7.0):* the rooms come with a `tag` made of epoch, compaction point, the
newest snapshot and the size of `log.bin`, so listing them loads no log; a frame still
being written shows in the next listing. The log from a seq answers the frame at that
seq and every one after it (`from` set in the answer), so the caller compares that
frame with its own; a seq the log no longer has, or never had, gets the whole readable
log. The backup token lives an hour and names its key (`kid`), which every request
looks up. Making a key needs the password, deleting one only the signed-in device -
it only takes access away. At most 32 keys per account.

## Where the settings live

In the vault's account-wide settings document (`set:<vaultId>`), encrypted under the
vault key and synced to every device of the account - so the restic passwords and the
cloud credentials are not lost with a device, and every device can change them. The
backup server reads them with its backup token at every run and when the plugin says
they changed. One key per entry, like contacts, so two devices editing different
destinations do not overwrite each other:

- `backupServer:<routeId>` - the code, a label, when it was connected;
- `backupTarget:<id>` - which backup server, the kind (restic or trusted copy), the
  location, the restic password, environment variables (credentials), the retention;
- `backupSchedule:<routeId>` - when it runs.

The session only carries what cannot wait for the document: connecting, "back up now",
status and progress, checking a destination ("not writable", "wrong password").

## The backup server's paths

Every local path lies under the backup root, `/backup` in the container; the operator
bind-mounts what should be reachable there (`/mnt/nas/obsidian:/backup/nas`). The
backup server refuses a path outside it, and a path inside a destination of another
vault - two vaults writing into one repository or one trusted copy would destroy each
other's. A vault's name only names the folder inside its own destinations, so two
vaults with the same name do not collide.

## A run

One at a time per vault; destinations one after the other, so one that fails (a cloud
that is down) does not hold up the others.

1. **Fetch.** Sign in with the backup key, ask for the rooms' heads, fetch the frames
   after what the cache has, and every blob it lacks. The **cache** on the backup
   server's disk is ciphertext, as the sync server has it: without it every run would
   download every attachment again, since restic needs the whole vault each time. A
   log that is another one (the sync server was restored) is fetched again from zero.
2. **Check what came.** Every room caught up, nothing refused. If half the notes or
   more vanished since the last run, the run still goes to restic - an older snapshot
   holds them - but leaves the trusted copy alone and reports it: the sync server may
   have lost data, and the trusted copy must not follow it.
3. **Decrypt and lay out, in memory.** Notes replayed from their logs into Markdown,
   written into a folder in a RAM disk (`tmpfs`); attachments decrypted from the cache
   one at a time, straight into the tar stream.
4. **restic, per destination.**
   - `restic backup --host obsidian-connect-backup --tag <vault> <ramdisk>/<vault>`:
     the notes snapshot. A fixed host and path, so restic finds the last snapshot and
     reads only notes that changed.
   - If any attachment changed since this destination's last files snapshot:
     `restic backup --stdin --stdin-filename "<vault> files.tar" --tag <vault>,files`,
     fed by the backup server. When producing the stream fails, restic is killed before
     the stream ends - an ended stream would be saved as a truncated backup.
   - `restic forget` with the destination's retention; `prune` once a week.
5. **Check.** `restic check`; the new snapshot's list of files and sizes against what
   was written; a few files read back with `restic dump` and compared by hash. Once a
   week a part of the data is read in full (`check --read-data-subset`).
6. **The trusted copy**, if there is one: brought level with the run - changed files
   written (to a temporary name, then renamed), files gone deleted - never emptied and
   written again, so a run that breaks off leaves a whole copy. It deletes only files
   it wrote itself (it keeps a list), and it starts only in an empty folder or one it
   wrote before.
7. **Status** - when, what, whether it checked out, per destination - kept on the
   backup server; the plugin asks for it.

### Layout

```
<Vault>/                     the vault: notes, canvases, attachments, shared notes in the share folder
<Vault> (trash)/             what the trash still has, under its last path
<Vault> settings.json        the account-wide settings, without contacts and without the backup settings
```

In restic the vault is split in two snapshots per run: the notes snapshot holds
`<Vault>/` (notes and canvases), the trash's notes and the settings; the files snapshot
holds the attachments under the same relative paths. Restoring a whole vault:

```
restic restore <notes snapshot> --target /tmp/restore
restic dump <files snapshot> "/<Vault> files.tar" | tar -x -f - -C /tmp/restore
```

The trusted copy holds all of it as one folder.

*As built (0.7.1),* in `packages/backup/src` (`run.ts` drives it), taken without
asking:

- **The cache** keeps a room as the sync server's answer, extended - a starting
  snapshot, the frames after it, sealed keys - one JSON file per room; blobs exactly
  as the sync server stores them. A room the sync server stops listing (a share that
  ended) is kept and used as it was, marked held, until the index stops naming it.
  Once a week every room is fetched again from its last frame, not only those whose
  tag changed. A sync server that answers with another frame at that seq gave
  another log: the room is fetched whole, and the run reports it.
- **A blob** is checked against the index's hash while it arrives, hashed chunk by
  chunk. One the sync server lacks, or one that does not decrypt to its hash, is left
  out and reported; the run goes on - a backup without one picture beats none.
- **The notes folder** is written afresh into the RAM disk on every run and removed
  after it; restic reads every note again (they are in memory, and few megabytes)
  instead of trusting times and sizes. Notes get the time the sync server took their
  last change, attachments their index time.
- **The files snapshot** is skipped while the files' paths, hashes and times are as
  at the destination's last one and that snapshot is still in the repository.
- **The check**, every run: `restic check`, the notes snapshot's listing against every
  note's path and size, the three newest notes read back with `restic dump`, and the
  stream's length. Once a week per destination, deep: `check --read-data-subset=5%`,
  and the whole files stream read back and every file hashed (`TarHasher`). `forget`
  only with a retention set; then `prune` once a week.
- **restic** gets the repository's password and credentials in the environment of
  that one call; nothing of the backup server's own `RESTIC_*` or `OBSIDIAN_CONNECT_*`
  passes. A stream whose producer fails kills restic before the stream ends -
  checked: ended instead, restic stored the stream cut short.
- **The trusted copy** keeps `.obsidian-connect-backup.json` - its files and their
  hashes - and refuses a folder that is neither empty nor its own, or another vault's.
  Deletions go first (a file may stand where a folder has to go), files are written
  under a temporary name and renamed. A note that could only be read in part, and a
  file the sync server lacks, keep what the copy had. With at least ten notes at the
  last copy and less than half of them now, the copy waits until the person confirms
  (`acceptShrink`; the plugin asks from 0.7.3).
- **The sync client** sends a request again when the network failed under it: a sync
  server that restarted leaves pooled connections that reset on first use. Every
  request of a backup token only reads.
- **restic 0.19.1**, pinned: CI installs the release checked against its checksum.

## The plugin

*Settings → Backups*, per vault:

- each backup server: reachable or not, its destinations with their last run (when,
  result, checked), "Back up now", the schedule, "Disconnect";
- a destination: restic (location, password - with "Make one" and "Show" -, environment
  variables, retention) or a trusted copy (a path);
- a notice when a vault's last good backup is older than twice its schedule, or its
  last run failed - asked on start and every few hours, since nobody looks at a backup
  until it is needed.

*As built (0.7.3):* *Settings → Backup servers*, between Contacts and This device
(`plugin/src/backup/Backups.ts` keeps the sessions and the backup servers' state,
`BackupModals.ts` the two dialogs). Per backup server: a line on its last backup and
the next, "Back up now", "Disconnect" (asks once more), how often ("Only when started
here", every hour, 6 hours, day, week), each destination with its last outcome, a key
button copying a repository's password and a trash button removing it, "Follow
anyway" while the trusted copy waits, and what it refused and why. Taken without
asking:

- A backup server connected from the settings backs up every day until told
  otherwise; a restic destination keeps the last 3, one a day for a week, a week for 5
  weeks, a month for a year and a year for 3 years, unless "a day for a month" or
  "everything" is chosen.
- The notice comes a minute after sync starts and every six hours after: a last run
  that failed, a trusted copy that waits, or no good backup for twice the schedule
  (three days without one) - also when the backup server cannot be reached, the case
  that matters most. It stays until clicked away. Each device remembers when it last
  saw a good backup (`backupLastGood` in `data.json`).
- The server entry holds its backup key's id, so any device disconnecting it deletes
  the key. A command, "Back up this vault now, on every backup server", for phones.

## The relay

`/relay` on the sync server, a WebSocket.

- A backup server registers with `routeToken`. One registration per route id; a second
  one replaces the first only with the same token.
- A signed-in device opens a session to a route id; the sync server forwards frames
  both ways and nothing else, limited in size and number per account.
- Registering takes no account: the backup server has none, and the code is what
  keeps it private. A relay to anyone but a signed-in account is not offered, so the
  sync server is no open relay.
- The sync server learns: that a backup server exists, when it is connected, which
  accounts open sessions to it and how much flows. Never the code, a key, a path, a
  password or a byte of a note.

*As built (0.7.2):* the relay (`server/src/relay.ts`) speaks JSON frames
(`RelayFrame` in `shared/types.ts`); a session's data is a JSON string the relay
passes on unread - `{hello}`, `{answer}`, then only `{c: sealed}`. The handshake and
the session cipher are in `shared/crypto.ts` (`openSession`, `answerSession`,
`finishSession`, `SessionCipher`); the device's side in `plugin/src/backup/BackupLink.ts`,
the backup server's in `backup/src/sessions.ts`. Requests: `info`, `connect`
(`{grant}`), `authorize` (`{vaultId, proof}`), `status`, `refresh` (read the settings
again), `run` (`{acceptShrink?}`; answers at once, and a `finished` event follows on
every session that showed the vault), `check` (a destination before it is saved:
folder rules, writable, and for restic the repository opened - or made - with its
password), `disconnect`. Taken without asking:

- The backup server reads the vault from the sync server it is registered at
  (`OBSIDIAN_CONNECT_SERVER`), not from the address in the grant: a device may reach
  the sync server by another address than the backup server does.
- Limits: 8 sessions per device connection, 64 per backup server, 16 backup servers
  per address, a frame at most 1 MiB, ten seconds to register. Failed handshakes are
  answered 250 ms later for each one within the last minute, up to five seconds.
- A relative location is taken below the backup folder; `local:` and a drive letter
  count as local. Environment variables naming the repository, its password or
  restic's cache are dropped from a destination's credentials.
- The schedule is "every n hours" (`backupSchedule:<routeId>`, 0 for by hand only),
  counted from the start of the last run; the settings are read again before every
  run and at most an hour after the last time. One run at a time over all vaults.
- A device's relay connection is checked when it opens; a password change does not
  close it (it reaches nothing but backup servers whose code it has).

## Security, in short

- The sync server stays blind: everything the backup server gets travels inside the
  session, and everything it reads is ciphertext.
- **Whoever runs the backup server can read every vault on it**: its data volume holds
  the backup keys, the vault keys, the key pairs and the cache; restic passwords pass
  through it; the trusted copy is plaintext by definition. That is the point of it, and
  the reason it is for a few people who trust whoever runs it.
- The code lets anyone connect their own vaults - and use the backup server's disk. It
  is kept like a password; a new one is a later addition.
- A backup key reads, it never writes: a stolen backup server cannot damage the vault.

## Order of work

1. **0.7.0 - the sync server's side.** Backup keys per vault: made with the password,
   listed in the account bundle, deleted from a device; ended by a password change, a
   recovery and the account's removal. `POST /auth/backup`, the `backup` token reading
   one vault, the vault's rooms with their heads, a log from a seq.
2. **0.7.1 - the run** (`packages/backup`): signing in, the encrypted cache, decrypting
   and laying out, restic per destination, the check, the trusted copy, the status -
   configured directly, without the relay yet.
3. **0.7.2 - the relay and the session:** `/relay` on the sync server; the backup
   server's code and its registration; the handshake; connecting a vault, starting a
   run and asking its status over the session; the schedule.
4. **0.7.3 - the plugin:** *Settings → Backups*, the settings entries, connecting again
   after a password change, the notice.
5. **0.7.4 - the image:** `obsidian-connect-backup` with restic, a compose file with
   the RAM disk, CI building and starting it, `docs/BACKUP.md`.

## Tests

- `test:rooms` (0.7.0): a backup key needs the password and is bound to its vault; its
  token reads that vault's index, settings, notes (own and shared into it) and blobs,
  and nothing of another vault or account; every write refuses it; deleting the key, a
  password change, a recovery and removing the account end it, tokens already handed
  out included; the rooms with their heads; a log from a seq, and from a seq the
  compaction folded in.
- `test:backup`, new (0.7.1 on): an in-process sync server, devices from
  `scripts/harness.mts` writing notes, files, shared notes, deleting some, and a real
  restic. A run into a local repository; restored with restic and compared with the
  vault; a second run fetching only what changed and backing up only changed notes; no
  files snapshot when no file changed; the trusted copy brought level and never
  emptied; a stream that fails leaving no snapshot; a sync server restored from an old
  copy; half the notes vanishing leaving the trusted copy alone. From 0.7.2: the
  handshake against a relay that tampers, a wrong code, a second vault's owner trying
  to start another's run.
- restic runs in the tests: CI installs a pinned release; on the development machine
  the same release lies in a folder outside the repository, named by
  `OBSIDIAN_CONNECT_RESTIC`.

## After the first build (0.7.6 to 0.7.9)

Decided with the user on 2026-10-16, after 0.7.5, on `feat/backup-rollback`. The user
pointed out that one code per backup server, for everyone it serves, cannot be taken
from one person without taking it from all, and lets anyone who has it use the
backup server's disk; asked for the settings in tabs; for the trusted copy's guard to
count files too, with a limit of one's own; and for rolling a vault back.

### Invitations and a pairing per vault *(0.7.6)*

Decided: no code shared by everyone any more. The operator invites per person, the
invitation works once, and from then on the vault and the backup server share a
secret of their own.

- **Inviting:** `obsidian-connect-backup invite [label]` on the backup server prints a
  one-time invitation - 30 characters like a recovery code, with a check of its own
  kind, so neither passes for the other - valid seven days. `invites` lists the open
  ones, `revoke <id>` withdraws one. They lie in the data volume (`invites.json`); the
  running backup server takes a new one up within seconds.
- **Routes:** every open invitation and every paired vault is a route of its own at
  the relay, derived from its secret as the code's was (route token, route id, the
  handshake's key). The relay keeps many routes per connection.
- **Connecting:** the device opens a session on the invitation's route and hands over
  the grant. The backup server checks it (the backup key signs in, for this vault and
  this account), makes a **pairing secret** for this vault, sends it inside the
  session, and spends the invitation - its route is dropped. The device keeps the
  pairing secret in the vault's settings (`backupServer:<routeId>`), so every device
  of the account reaches the backup server for this vault.
- **A session on a pairing's route belongs to that vault.** Only devices of the
  account know its secret, so nothing else needs proving. A session on an
  invitation's route can ask `info` and `connect`, nothing else.
- **Bound to the account:** a vault paired once is never taken over by an invitation
  of another account; the same account connecting it again with a new invitation
  replaces the pairing.
- **A password change or a recovery** still ends every backup key of the account -
  only that account's. The pairing stands: a device with the password hands the
  backup server a new key over the pairing's session (`rekey`), at once or any time
  later ("Connect again…" asks for the password only).
- **Disconnecting** from a device as before, or by the operator,
  `obsidian-connect-backup disconnect <vaultId>`: pairing, grant and cache go, the
  route is dropped; the devices are told the backup server no longer has the vault.
  `vaults` lists the paired vaults: id, account, label, last run.
- The backup server's own code (`code`, `identity.json`) goes.

**As built (0.7.6).** One point turned out differently, two had to be ordered:

- *A vault the operator disconnected is not said to be gone.* Its route goes with it,
  and an unanswered route looks the same to the device as a backup server that is
  down - which is all the sync server could tell it either. The device shows "cannot
  be reached" and, once the last good backup is overdue, a notice; *Disconnect* still
  works then (it forgets the backup server here). "No longer has this vault" is said
  only in the moment between the vault going and its route.
- *The invitation is spent after the answer.* Spending drops its route, and the relay
  ends a session whose route goes - spent first, the device never heard its pairing.
- *The answer waits for the pairing's route.* The device opens a session on the new
  route right after connecting; `connect` answers once the relay has registered it
  (at most 10 s).
- A vault paired again keeps nothing of the settings read under the old route; the
  device moves destinations and schedule to the new one and has them read at once.

### The settings in tabs, destinations editable, the guard *(0.7.7)*

- Tabs: **Account · Contacts · Backups · This device · All devices**; signed out,
  Account and This device.
- A destination can be changed afterwards: how long restic keeps backups - the
  presets, or numbers of one's own per rule - and the credentials; for the trusted
  copy its guard. Location and password stay: another location or password is
  another repository, added anew.
- **The guard counts notes and files.** It holds the trusted copy when more than a
  share of them vanished since the copy last followed - 50 % unless set otherwise
  for that copy (10 to 90 %, or off).

**As built (0.7.7).**

- *Notes and files are counted apart*, each against the limit: counted together, a
  vault of a thousand pictures could lose all of its fifty notes and stay below it.
  Fewer than ten of a kind when the copy last followed are not counted, as before;
  files are counted from the first time the copy follows under 0.7.7.
- *A changed destination is read before it is used.* The device used to wait until
  the backup server listed the same destinations and schedule; a change of retention
  keeps every id, so a run started right after saving went by the settings before it.
  The status now carries a hash of what the backup server read for its route
  (`backupSettingsText`, the same text on both ends), and the device waits for its own.
- New credentials are checked by the backup server before they are saved, as a new
  destination is. Retention: three presets or one's own numbers per rule; all empty
  keeps every backup.
- The tabs keep their place while the plugin runs. Signing in, creating an account and
  recovering are forms on the Account tab; switching tabs leaves the form, forgetting
  the passwords typed.

### Rolling back *(0.7.8 from the history, 0.7.9 from restic)*

Decided:

- **The vault, or a folder**, back to a moment: the vault from the settings, a folder
  from its menu.
- **Notes others share are left alone;** own notes shared with others are rolled back
  too, and the confirmation lists them - it changes them for the others as well.
- **Before anything changes:** a fresh backup on every connected backup server, run
  and checked; if one fails, no rollback - unless the person confirms explicitly. And
  always a local copy of everything the rollback is about to change or remove, in the
  plugin's folder (`rollbacks/<time>/`), kept as long as the merge backups.
- **Where it comes from:** the history on the sync server, as far as it reaches; where
  it does not, the newest restic snapshot at or before that moment on a backup
  server - without the person having to do anything.

How:

- **The vault at T:** the index replayed to T - paths, live or deleted, the files'
  contents by hash -, and every note's text at T from its history, ordered by author
  time as the history view orders it.
- **Applied as changes, never by rewinding a log:** a note gets its text at T as an
  edit (the way a restored version is); a note that did not exist at T, or was deleted
  then, goes to the trash; one deleted since comes back; a rename since T is undone;
  a file gets its content at T as an earlier version does; files that came later go
  to the trash, files deleted since come back. Every device follows as with any edit;
  one that was offline adds what it wrote meanwhile on top.
- **It can be undone:** the rollback is part of the history, and the settings record
  it (`rollback:<id>` - when, to when, what) before it starts. "Undo the rollback of …"
  rolls the same scope back to the moment before it - also for one that broke off.
- **How far the history reaches:** a note's history knows T when it holds no snapshot,
  or T lies at or after its snapshot's content. From 0.7.8 a compaction stamps its
  snapshot with the time of the newest change it folds in; an older snapshot only
  says when the compaction ran, and its content is then taken to be older than that
  minus the retention. A file's content at T is there while the server keeps it.
- **From restic** (0.7.9): the device asks every backup server of the vault for the
  newest notes snapshot at or before T and the newest files snapshot at or before
  that; the backup server reads the paths asked for from them and sends their content
  over the session in pieces - it still only reads. A rollback before anything the
  history knows takes the whole vault from the snapshot: what it holds is the vault at
  T, by path.
- **Neither reaches** a note or file: the confirmation names it, and the rollback goes
  on without it only if the person agrees.

**As built (0.7.8).** Taken without asking, beyond the decisions above:

- *Where it lives:* the command "Roll the vault back to an earlier moment…", *All
  devices → Roll back…*, and every folder's menu ("Roll this folder back…"; the root
  folder's rolls back the vault). The dialog chooses the moment (a date and time, or an
  hour, a day, a week ago), shows how far the history reaches, lists what changes per
  kind, the shared notes among them and what is out of reach, and offers "Undo…" for
  the last five rollbacks.
- *The reach is decided per room and errs on the safe side:* a moment is reachable when
  every frame is readable and the moment lies at or after the snapshot's time. Old
  snapshots carry their compaction time, so their notes reach less far than they
  could; from now on a compaction stamps the newest change it folds in (`Compactor`).
  The vault index's reach bounds the whole vault: before it, nothing can be planned
  (0.7.9 takes restic then).
- *A folder* is what lies in it now and what lay in it then: a note moved out of it
  since moves back in, one moved in since moves back out.
- *Left alone:* notes others share in (an `owner` then or now), files that came with
  such a note (`via`), and paths the exclusions name. Notes of the account that were
  forked from a share are left alone too.
- *What "now" is:* the note's text on the server, which the same log gives. A note
  whose text there equals its text then is not touched, even if this device holds an
  unsent edit of it.
- *Order:* first what came later goes to the trash (it frees paths), then moves - in
  rounds, a swap via a free name -, then what comes back from the trash (next to its
  old place when that is taken), then texts and contents. A text is applied only
  against the document the server sent (`DocStore.rollBackText`, invariant 1); a file's
  content is replaced like restoring a version, and a file is trashed only once the
  server holds what it holds (invariant 23). What fails on its own is listed and the
  rest goes on; the record says `failed` then.
- *The gate is in the core,* not only in the dialog: `Rollback.apply` refuses a plan
  whose backups did not all go through, or with parts out of reach, unless the consent
  says otherwise. With no backup server connected only the copy is taken.
- *The copy* lies in `rollbacks/<date time>/` in the plugin's folder: every note and
  file that changes or goes, as this device has it, at its path, and `rollback.json`
  with the plan. Pruned with the merge backups. The records (`rollback:<id>`) keep the
  newest 20.
- *Reading the history* takes one request per note in scope that existed then: the
  server keeps no "changed since" per room. Fine for a vault of hundreds of notes,
  slow for many thousands; a server-side last-change time per room would let the plan
  skip what did not change.
- *A sync bug the test found:* two notes - or files - that swapped names on one device
  never swapped on the others: each rename waited for a place the other held, and a
  restart's scan then took each file for an edit of the other note. Renames from other
  devices are applied in rounds now, one of two that swapped waiting at a free name the
  index and the scan never claim (invariant 27). A rollback undoing renames closes such
  cycles often.

### Order of work

6. **0.7.6** - invitations and pairings: relay with many routes per connection, the
   backup server's invitations and pairings, `connect`/`rekey`, the operator's commands,
   the plugin connecting with an invitation and rekeying over the pairing.
7. **0.7.7** - the tabs, editing a destination, the guard over notes and files with
   its limit.
8. **0.7.8** - rolling back from the history: the vault or a folder, the backups and
   the local copy first, the record and undoing it; the compaction's content time.
9. **0.7.9** - rolling back from restic where the history does not reach.
