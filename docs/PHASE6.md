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
restic dump <files snapshot> "/<Vault> files.tar" | tar -x -C /tmp/restore
```

The trusted copy holds all of it as one folder.

## The plugin

*Settings → Backups*, per vault:

- each backup server: reachable or not, its destinations with their last run (when,
  result, checked), "Back up now", the schedule, "Disconnect";
- a destination: restic (location, password - with "Make one" and "Show" -, environment
  variables, retention) or a trusted copy (a path);
- a notice when a vault's last good backup is older than twice its schedule, or its
  last run failed - asked on start and every few hours, since nobody looks at a backup
  until it is needed.

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
