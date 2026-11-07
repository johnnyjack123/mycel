# Running the server

## With Docker

CI builds the image on every push to `main`, once all tests have passed, starts it
once as a smoke test and publishes it as `ghcr.io/johnnyjack123/mycel-server`
(`latest`, plus `sha-<commit>` for every build), for amd64 and arm64.

On the server you only need two files from this repository, `docker-compose.yml` and
`docs/server.env`:

```bash
cp server.env .env           # then edit it
docker compose up -d
docker compose exec mycel mycel invite
```

The data folder `./data` next to `docker-compose.yml` needs no preparing: the image
starts as root only long enough to hand it to the user the server runs as -
`PUID`:`PGID`, 1000:1000 unless set in `.env` - and runs the server as that user. The
`mycel` command runs as that user too, also through `docker compose exec`.
Started as another user instead (`user:` in compose), it hands nothing over; the
server then stops at start if it cannot write the folder, saying so.

Updating: `docker compose pull && docker compose up -d`. The data folder stays.

Behind a reverse proxy with TLS, devices are given `wss://<your domain>`. The proxy
must pass WebSocket upgrades on `/vault/` and on `/relay` (backup servers) to port
1234; plain `ws://` on the port itself is what the server speaks.

GitHub makes a package private when the repository is. Either set the package to
public (*GitHub → Packages → mycel-server → Package settings*), or sign
the server in once with a token that may read packages:
`docker login ghcr.io -u johnnyjack123`.

To build the image yourself instead: `docker build -t mycel-server .` in the
repository root, and point `image:` in `docker-compose.yml` at that name.

`invite` prints a code that lets one person create one account. In Obsidian:
*Settings → Mycel → Create a new account*, with a name, the code and a
password. The server never learns the name or the password: it finds an account by a
key derived from both together, and knows accounts only by random ids. Losing the
password means losing access to the encrypted notes (the devices keep their files).

Data lives in the `data` folder next to `docker-compose.yml`. Everything in it is
ciphertext or a random id. What the server can tell: which account ids exist, which note ids, who is
whose contact and who shares with whom by id, and when and how much was written.
Attachments - images, PDFs, every file that is not a note - lie encrypted under
`users/<account>/<vault>/blobs/`, named by a keyed hash of their content: the server
sees how many there are and how large, never a name or a byte of them.
`contacts.json` holds the contact pairs, open friend codes (as a hash) and messages
waiting for a device; without it, contacts would have to exchange codes again.

Backups of the notes themselves - decrypted, in restic repositories - are what a
backup server is for, which every account sets up for its own vaults: `docs/BACKUP.md`.
The sync server only relays to it (`/relay`) and hands it a read-only key.

**Back up the whole data folder, and keep `server.json` with `accounts.json`.** It holds
the server's id, which is part of every account's salt: a server with another id opens
no account, even with the right name and password.

**What the server answered for is on the disk** (0.9.1): a change is acknowledged to a
device only once it is synced to the disk, not merely handed to the operating system - on
an SD card a power cut otherwise lost changes the device had already let go of. Every
other file is written whole under another name and renamed. Beside the data:

- `server.lock` - the one server running on this folder, kept fresh every ten seconds. A
  second server on the same folder does not start; one left by a server that was killed
  is waited out (half a minute) and taken over, so a restart right after a crash just
  takes a little longer.
- `accounts.lock` - for a moment, while the server or the CLI changes `accounts.json`: the
  CLI waits for the server and the server for the CLI, so neither undoes the other.
- `locks.json` - the vaults locked by the Time Machine on a device: a lock outlives a
  restart of the server for as long as its lease, two minutes, unless its device renews it.

## `.env`

A template sits in `docs/server.env`:

| Variable | Default | Meaning |
|---|---|---|
| `MYCEL_JWT_SECRET` | — (required with Docker) | Signs access tokens. `openssl rand -base64 48`. At least 32 characters, or the server does not start (0.9.8): every account holds a token, and a short secret falls to an offline search from it. Unset outside Docker, the server makes a random one and keeps it in its data folder (`jwt-secret`). |
| `MYCEL_TRUST_PROXY` | none | The reverse proxy's address as the server sees it (`10.0.0.1`), a subnet (`10.0.0.0/24`), a list (`10.0.0.1,10.0.0.2`) or `loopback` for one on the same machine. Its `X-Forwarded-For` then names the client: without it every request seems to come from the proxy, and ten wrong passwords from anyone block everybody's sign-in for 15 minutes. Never set it without a proxy in front: anyone could then write the header. |
| `MYCEL_REGISTRATION` | `invite` | `invite`: accounts only with a code from `invite`. `open`: anyone who reaches the server can create one. |
| `MYCEL_TOKEN_TTL` | `2592000` | Seconds a device stays signed in without being used. |
| `MYCEL_LOG_UPDATES` | `false` | A log line per document frame. |
| `MYCEL_MAX_FILE_MB` | `100` | The largest attachment taken. Larger files stay on their device. |
| `MYCEL_QUOTA_MB` | none | What one account may store: its attachments and, since 0.9.9, the rooms it owns - every note's log and snapshots, index, settings, folders, each room counted with 4 KB more. Past it a device keeps what it writes and offers it again later. Set it with open registration (the server warns at its start otherwise): a stranger could fill the disk. |
| `MYCEL_PURGE_GRACE_S` | `600` | How long an attachment's content survives being cleaned up after its last upload. Leave it. |
| `PORT` | `1234` | Published port. |

## Accounts

```bash
docker compose exec mycel mycel invite                    # a code for one new account
docker compose exec mycel mycel user list                 # account ids, created, vaults, recovery code, 2fa, backup keys
docker compose exec mycel mycel user remove <accountId>
docker compose exec mycel mycel user 2fa-off <accountId>  # a lost phone, no recovery code
```

There are no names to list: everyone finds their account id in the plugin's settings,
under *Signed in as*. A code works once. Sign-in and registration always answer after
one second, and an address that keeps failing is turned away for 15 minutes.

The admin cannot reset a password: the server holds no key that could open an
account. A forgotten password is what the account's **recovery code** is for - made
with every new account, and in the plugin's settings for older ones. It is checked
like a password, and an address trying unknown codes is turned away the same way.

Two-factor sign-in is the account's own choice, in the plugin's settings. Someone
who lost their phone and has no recovery code needs `user 2fa-off`: it lowers the
sign-in back to name and password, which are still needed - the admin gets no way
into anyone's notes from it. Five wrong codes block codes for that account for 15
minutes.

`user remove` stops the account from signing in at once. The running server then ends
everything it shared, within a few minutes: everyone a note was shared with keeps it
as a note of their own, with the history they could read. The server holds that part
for them for 90 days if none of their devices is online meanwhile. Then it deletes the
account's data. Only accounts removed this way are ever deleted.

## Without Docker

```bash
copy docs\server.env .env      # Windows; cp on Linux/macOS. Then edit it.
npm install
npm run start:server
npm run cli -- invite
```

Both read the `.env` in the repository root, so the CLI writes to the same data
directory the server uses. Variables set in the shell win over the file, and a byte
order mark at its start (Windows PowerShell 5.1 writes one) is ignored.

Data goes to `packages/server/data`, or `MYCEL_DATA_DIR`. Without
`MYCEL_JWT_SECRET` the server makes a random secret on its first start and keeps
it in the data folder as `jwt-secret`, readable by its own user only (before 0.9.8
it used one built into the sources, which anyone could read). `HOST` defaults to
`0.0.0.0`.

Put TLS in front of it (a reverse proxy) as soon as it leaves your own network:
the notes are encrypted either way, but the access token is not. The proxy has to
pass WebSocket upgrades on `/vault/…` (the devices) and `/relay` (backup servers,
and devices talking to them). The server pings every connection on both every 30
seconds, so a proxy's idle timeout (nginx's is a minute) closes none of them; before
0.7.18 it did on `/relay`, and the backup server lost its connection every minute.
Let the proxy pass
request bodies of at least 8 MB - attachments travel in chunks of 4 MB, and nginx
refuses anything over 1 MB unless told otherwise (`client_max_body_size 64m;`, which
also covers large note snapshots). Set `MYCEL_TRUST_PROXY` to the proxy's address, so
that a sign-in that keeps failing blocks its sender and not everyone behind the proxy.
Since 0.9.9 a device sends its access token as a WebSocket subprotocol
(`Sec-WebSocket-Protocol`), a header no access log writes; before, it was in the URL, and the
server still reads it there from older plugins - as long as one of those is in use, keep the
proxy's access log off for `/vault/` and `/relay`, or out of anyone else's reach (Nginx Proxy
Manager keeps one per host under `/data/logs`). A proxy has to pass that header on, as every
WebSocket proxy does.

What the server takes is bounded (0.9.8, `docs/AUDIT.md`): requests without a valid
token are turned away before their body is read, signing in takes 64 KB at most, a
socket message 32 MiB, a share's title 16 KB and each key sealed with it 4 KB, a
note's list of attachments 4096 names, open friend codes 50 per account. A malformed
or oversized WebSocket message ends that connection, never the server.
