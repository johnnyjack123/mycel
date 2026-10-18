# Backing up a vault

A **backup server** is a small server of your own - on a NAS, a home server, a
Raspberry Pi - that pulls a vault from the sync server, decrypts it in its memory
and hands it to [restic](https://restic.net), which encrypts it again into a
repository - on the backup server, or in a cloud. Every backup is kept for as long
as you say, and restic shows which notes changed between two of them. Optionally a
**decrypted copy** (*trusted*) - the newest version of everything, decrypted, on the
backup server - is kept up to date as well, for the day the repository password is
lost.

It is set up from the plugin. On the backup server itself you only start it.

How it is built and why: `docs/PHASE6.md`.

## What it can and cannot do

- **It reads, it never writes.** A vault is connected with a backup key that reads
  that one vault and nothing else. A stolen backup server cannot change or delete
  a note.
- **Whoever runs it can read every vault connected to it.** Its data volume holds the
  keys of those vaults, restic passwords pass through it, and the decrypted copies are
  plaintext. It is for you, or a household - not a service for strangers.
- **A vault has one backup server.** Connecting another replaces it; the first one's
  backups stay where they are.
- **The sync server learns nothing new.** It only relays between your device and the
  backup server, and what it relays is encrypted between the two with a key that
  depends on a secret only the two know, which never leaves either.
- **A vault is connected with an invitation, once.** The operator makes one per
  person (`obsidian-connect-backup invite`); it connects one vault, once, within a
  week. From then on the vault has a secret of its own with the backup server - kept
  in the account's encrypted settings, so all its devices and nobody else reach it -
  and the backup server knows which account the vault belongs to. Nobody else can see
  it, start it, change where it goes or take it over, not even with an invitation of
  their own.

## Running it

You need Linux with Docker, and a sync server the backup server can reach. Two files
from this repository: `docker-compose.backup.yml` and `docs/backup.env`.

```bash
cp backup.env .env                    # then edit it: the sync server, its three folders
docker compose -f docker-compose.backup.yml up -d
docker compose -f docker-compose.backup.yml exec obsidian-connect-backup obsidian-connect-backup invite Anna
```

The last line prints an invitation for Anna; pass it on as you would a password. It
waits until the running backup server answers the invitation at the sync server and
says so - or says why not. The image is private while the repository is; sign in once
with `docker login ghcr.io -u johnnyjack123` and a token that may read packages.

**Its three folders**, each set in `.env`:

| `.env` | In the container | What lies there |
|---|---|---|
| `SERVER_DATA` (`./backup-data`) | `/data` | Its invitations, the keys of the vaults connected to it, their encrypted cache. |
| `ENCRYPTED_VAULTS` | `/encrypted` | The restic repositories of the vaults that keep theirs on the backup server: `<vault id>/`. |
| `DECRYPTED_VAULTS` | `/decrypted` | The decrypted copies: `<account name>/<vault name>/`. |

The backup server names the folders in them itself; nobody types a path. A vault's
id says nothing about it - `vaults` lists which id is which vault of whom. An account
name is not unique: a second account of the same name gets its account's id added
(`anna (3f2a9c01)/Notes`). The decrypted copy holds the vault itself at its top, so it
opens in Obsidian as a vault; its trash and settings lie beside the notes, in the
hidden `.obsidian-connect/`. Every backup brings it up to date and overwrites what was
changed in it - copy a note out before you edit it.

The encrypted folder may be a NAS share or a mounted cloud folder: restic encrypts
everything in it. The decrypted folder is plaintext: only a disk you trust - and if
you mount a cloud folder there, only a cloud that is your own, since its provider can
read every note otherwise.

No folder needs preparing: the image starts as root only long enough to hand each of
them - the folder itself, not what already lies in it - to the user it runs as
(`PUID`:`PGID`, 1000:1000 unless set), and runs as that user; so do its commands
through `docker compose exec`. Its data folder is `./backup-data` unless set, so the
file can lie next to the sync server's `docker-compose.yml`, whose is `./data`.

The operator's commands, all through `docker compose -f docker-compose.backup.yml exec obsidian-connect-backup obsidian-connect-backup …`:

| Command | What it does |
|---|---|
| `invite [name]` | An invitation for one person to connect one vault, once, within 7 days. |
| `status` | Whether it reaches the sync server - and why not -, and which invitations it answers. |
| `check` | Tries the way to the sync server's relay from inside the container, now, step by step. |
| `invites` | The invitations not used yet. |
| `revoke <id>` | Withdraws an invitation. |
| `vaults` | The vaults connected: id, vault and account name, the invitation's name, the last backup, their two folders. |
| `disconnect <vault>` | Forgets a vault: its keys go, it is backed up no more. Its repository and decrypted copy stay. |

The running backup server takes each of them up within seconds.

Updating: `docker compose -f docker-compose.backup.yml pull && docker compose -f docker-compose.backup.yml up -d`.

| Variable | Default | Meaning |
|---|---|---|
| `OBSIDIAN_CONNECT_SERVER` | — (required) | The sync server, `wss://…` as devices are given it - or any address this container reaches it by (see "When connecting fails"). |
| `OBSIDIAN_CONNECT_BACKUP_NAME` | the host name | What devices are shown it as. |
| `SERVER_DATA` | `./backup-data` | Its own data, mounted at `/data`. |
| `ENCRYPTED_VAULTS` | `./encrypted-vaults` | The repositories kept on the backup server, mounted at `/encrypted`. |
| `DECRYPTED_VAULTS` | `./decrypted-vaults` | The decrypted copies, mounted at `/decrypted`. |
| `RAM_DISK` | `1g` | The memory a vault's notes may take during a backup. |
| `OBSIDIAN_CONNECT_BACKUP_DEBUG` | `false` | More in the log. |
| `PUID`, `PGID` | `1000` | The user and group it runs as; the image hands its folders to them at every start. |

The container's own paths, if you run it some other way: `OBSIDIAN_CONNECT_BACKUP_DATA`
(`/data`), `OBSIDIAN_CONNECT_BACKUP_ENCRYPTED` (`/encrypted`),
`OBSIDIAN_CONNECT_BACKUP_DECRYPTED` (`/decrypted`), `OBSIDIAN_CONNECT_BACKUP_WORK`
(`/run/obsidian-connect-backup`, the RAM disk), `OBSIDIAN_CONNECT_RESTIC` (restic).

**Memory.** Notes and canvases lie in the RAM disk during a run, decrypted; pictures,
PDFs and other files never do - they stream into restic one at a time. A vault of
5000 notes takes a few dozen megabytes. A vault bigger than the RAM disk fails its
backup with "no space left"; give it more.

**The data folder** holds the invitations, the keys and secret of every vault
connected and an encrypted cache of them (so a backup fetches only what changed).
Back it up only if you want to keep the connections; losing it means connecting the
vaults again with new invitations, nothing more - the repositories are not in it. A
vault connected again finds its repository in its folder and carries on with it,
given the password it had.

### When connecting fails

"No backup server answers this invitation" in Obsidian means the sync server knows no
backup server for it. `obsidian-connect-backup status` on the backup server says why:

- **NOT connected**, with a reason: the container does not reach the sync server at
  `OBSIDIAN_CONNECT_SERVER`; `check` tries it step by step. On the same host as the
  sync server, a container often reaches neither the public address (the router does
  not loop it back) nor the host's LAN address (a firewall such as ufw drops traffic
  from Docker's networks). What works there:
  - both compose files in one folder - one compose project, one network - and
    `OBSIDIAN_CONNECT_SERVER=ws://obsidian-connect:1234`, the sync server's container;
  - or `network_mode: host` for the backup server in `docker-compose.backup.yml` and
    `OBSIDIAN_CONNECT_SERVER=ws://127.0.0.1:1234`. It needs no port of its own, so
    nothing else changes.

  On another machine, use an address it reaches the sync server by, such as
  `ws://192.168.1.10:1234`. It does not have to be the address your devices use; it
  only has to be the same server. **`ws://`, not `wss://`, on the sync server's own port:** it speaks no TLS
  there - `wss://` is for an address with TLS in front of it, a reverse proxy. The
  backup server asks the sync server over HTTP when a connection fails without a
  reason, and `status` then says which it is. Behind a reverse proxy, `/relay` must
  be passed on as a WebSocket, like `/vault/`.
- **HTTP 403** (or 401) on `/health`: something in front of the sync server refuses the
  backup server - the sync server itself never answers so. `check` shows the address the
  name resolves to inside the container and who answered. A container often resolves
  differently from your devices: Docker falls back to public DNS when the host's
  resolver is `127.0.0.1` (a Pi running Pi-hole), so it reaches the public address
  and takes another way. Give the container your DNS (`dns: [<Pi-hole's LAN
  address>]` in the compose file) or pin the name (`extra_hosts:
  ["sync.example.com:<the proxy's address>"]`), and let the proxy's access list admit
  the address the container comes from. A filter on the user agent would see `node`.
- **connected**, but the invitation **NOT answered**: the running backup server has
  not taken it up - made with another data folder than the one it runs with, or
  already used or withdrawn (`invites` lists the open ones).
- No status at all: the backup server has not run with this data folder.

## Setting it up in Obsidian

*Settings → Obsidian Connect → Backups*:

1. **Connect a backup server…** - the invitation and your password. Your other
   devices find it in the settings by themselves. A vault has one backup server:
   connecting another replaces it.
2. **Back up this vault** - its backup task, asked for right after connecting:
   - **The repository**: *on the backup server* - in its folder for encrypted vaults,
     under the vault's id - or *in a cloud*: a location restic reaches,
     `s3:s3.amazonaws.com/bucket/obsidian`, `b2:bucket:obsidian`,
     `rest:https://…`, `azure:…`, `gs:…`, `sftp:user@host:/backups/obsidian`, with the
     credentials it needs (`AWS_ACCESS_KEY_ID`, …). For `sftp:` the backup server needs
     an SSH key: mount it with a `known_hosts` at `/home/node/.ssh` (for `PUID` 1000).
   - **The repository password**: "Make one" makes a strong one. It is kept in your
     account's settings, encrypted, so every device can show it - **write it down as
     well**: without it nobody can read the repository.
   - **How long backups are kept**: a preset, or numbers of your own - the last so
     many, and the newest of each of so many hours, days, weeks, months, years.
   - **Decrypted copy (trusted)**: also the newest version of everything, decrypted, in
     the backup server's folder for decrypted vaults - whether the repository lies
     there or in a cloud. It follows only once the repository took the backup, so
     what it deletes is in a snapshot first.
3. **How often** (daily unless you choose otherwise), and **Back up now** whenever
   you like.

The pencil changes the task afterwards: how long backups are kept, the credentials,
the decrypted copy and when it waits. The repository's place and password stay - for
another repository, remove the task (the bin; the repository stays where it is) and
set up a new one. A repository kept on the backup server is always the vault's folder
there: a new task finds the one from before and takes it up again with its password,
and refuses another password.

The backup server checks the task before it is saved: whether it can write its
folders, whether the repository opens with that password (it is made where there is
none), whether the copy's folder is empty or its own. It shows how each backup went;
Obsidian tells you when a backup failed, when the decrypted copy waits, when it was
never given a task, or when there was no good backup for a while - also when the
backup server cannot be reached.

**After a password change** the device that made it hands every backup server a new
key at once, over the vault's own connection; a password change ends the old keys,
as it signs out every other device. One that was not reachable then says so in the
settings: *Connect again…* asks for the password - no new invitation is needed. Only
a backup server that lost the vault (its operator disconnected it, or its data volume
is gone) needs a new invitation; until then it looks like one that cannot be reached.

**Connecting the same vault again** with a new invitation replaces its connection;
its task carries on.

**The decrypted copy waits** when more than half of the vault's notes, or more than
half of its files, are gone since the copy last followed: the sync server may have
lost data, and the copy must not follow that. Notes and files are counted apart, so a
vault of many pictures that lost its notes is caught too; fewer than ten of either
are not counted. The share is the copy's own setting - 10 to 90 %, or never. The
restic backups go on as always. If you deleted them on purpose, *Follow anyway*.

## What a backup holds

```
<Vault>/                     the vault: notes, canvases, pictures, PDFs, the notes others share with you
<Vault> (trash)/             what the trash can still restore, under its last path
<Vault> settings.json        the account-wide settings (without contacts, without backup settings)
```

restic keeps it as two snapshots per backup: one of the notes (`<Vault>/` with its
notes and canvases, the trash's notes, the settings), and one stream of all other
files, `<Vault> files.tar`, made only when a file changed. The decrypted copy holds
all of it in one folder: the vault at its top, the trash in `.obsidian-connect/trash/`,
the settings in `.obsidian-connect/settings.json`.

Every backup is checked: restic's own check, every note's path and size in the new
snapshot, the newest notes read back byte for byte; once a week a part of the stored
data is read in full, and every file of the files snapshot is read back and compared
by its hash.

## Rolling back from Obsidian

*Roll the vault back…* in the plugin (or *Roll this folder back…* in a folder's menu)
takes the vault back to a moment from the history on the sync server - and where
that no longer reaches, from the newest backup at or before that moment on a backup
server, read back over the same encrypted connection; nothing to restore by hand.
Before anything changes, the backup server makes a fresh backup (forgetting no older
one this time, so the backup rolled back from stays). See the README.

## Restoring

With restic on any computer (or in a container: `docker run --rm -it -v …:/repo restic/restic …`):

```bash
export RESTIC_REPOSITORY=/srv/obsidian-backups/encrypted/<vault id>   # or the cloud location
export RESTIC_PASSWORD='the repository password'
restic snapshots                                   # every backup; tags "notes" and "files"
restic diff <older notes snapshot> <newer one>     # which notes changed in between
restic restore <notes snapshot> --target ~/restore
restic dump <files snapshot> "/<Vault> files.tar" | tar -x -f - -C ~/restore
```

A single note: `restic restore <snapshot> --target ~/restore --include "/<Vault>/Folder/Note.md"`.
A single picture: `restic dump <files snapshot> "/<Vault> files.tar" | tar -x -f - -C ~/restore "<Vault>/Pictures/x.png"`.

`~/restore/<Vault>` can be opened in Obsidian as a vault of its own. To bring notes
back into the vault that syncs, copy them in one by one: copying an old version over
a note makes that old version the newest everywhere.

## Without Docker

For trying it on a laptop: restic on the PATH (or `OBSIDIAN_CONNECT_RESTIC`), then

```bash
OBSIDIAN_CONNECT_SERVER=ws://localhost:1234 OBSIDIAN_CONNECT_BACKUP_DATA=./backup-data \
OBSIDIAN_CONNECT_BACKUP_ENCRYPTED=./encrypted-vaults OBSIDIAN_CONNECT_BACKUP_DECRYPTED=./decrypted-vaults \
npm run start:backup
# in a second terminal:
OBSIDIAN_CONNECT_BACKUP_DATA=./backup-data node packages/backup/bin/obsidian-connect-backup.mjs invite me
```

Outside Linux there is no RAM disk; the notes then lie in the system's temporary
folder during a backup.
