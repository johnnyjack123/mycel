# Running the server

## With Docker

CI builds the image on every push to `main`, once all tests have passed, starts it
once as a smoke test and publishes it as `ghcr.io/johnnyjack123/obsidian-connect-server`
(`latest`, plus `sha-<commit>` for every build), for amd64 and arm64.

On the server you only need two files from this repository, `docker-compose.yml` and
`docs/server.env`:

```bash
cp server.env .env           # then edit it
docker compose up -d
docker compose exec obsidian-connect obsidian-connect invite
```

Updating: `docker compose pull && docker compose up -d`. The data volume stays.

GitHub makes a package private when the repository is. Either set the package to
public (*GitHub → Packages → obsidian-connect-server → Package settings*), or sign
the server in once with a token that may read packages:
`docker login ghcr.io -u johnnyjack123`.

To build the image yourself instead: `docker build -t obsidian-connect-server .` in the
repository root, and point `image:` in `docker-compose.yml` at that name.

`invite` prints a code that lets one person create one account. In Obsidian:
*Settings → Obsidian Connect → Create a new account*, with a name, the code and a
password. The server never learns the name or the password: it finds an account by a
key derived from both together, and knows accounts only by random ids. Losing the
password means losing access to the encrypted notes (the devices keep their files).

Data lives in the `obsidian-connect-data` volume. Everything in it is ciphertext or a
random id. What the server can tell: which account ids exist, which note ids, who is
whose contact and who shares with whom by id, and when and how much was written.
`contacts.json` holds the contact pairs, open friend codes (as a hash) and messages
waiting for a device; without it, contacts would have to exchange codes again.

**Back up the whole volume, and keep `server.json` with `accounts.json`.** It holds
the server's id, which is part of every account's salt: a server with another id opens
no account, even with the right name and password.

## `.env`

A template sits in `docs/server.env`:

| Variable | Default | Meaning |
|---|---|---|
| `OBSIDIAN_CONNECT_JWT_SECRET` | — (required with Docker) | Signs access tokens. `openssl rand -base64 48`. |
| `OBSIDIAN_CONNECT_REGISTRATION` | `invite` | `invite`: accounts only with a code from `invite`. `open`: anyone who reaches the server can create one. |
| `OBSIDIAN_CONNECT_TOKEN_TTL` | `2592000` | Seconds a device stays signed in without being used. |
| `OBSIDIAN_CONNECT_LOG_UPDATES` | `false` | A log line per document frame. |
| `PORT` | `1234` | Published port. |

## Accounts

```bash
docker compose exec obsidian-connect obsidian-connect invite                    # a code for one new account
docker compose exec obsidian-connect obsidian-connect user list                 # account ids, created, vaults
docker compose exec obsidian-connect obsidian-connect user remove <accountId>
```

There are no names to list: everyone finds their account id in the plugin's settings,
under *Signed in as*. A code works once. Sign-in and registration always answer after
one second, and an address that keeps failing is turned away for 15 minutes.

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

Data goes to `packages/server/data`, or `OBSIDIAN_CONNECT_DATA_DIR`. Without
`OBSIDIAN_CONNECT_JWT_SECRET` the server uses a built-in secret and says so at
startup — fine on a laptop, never on a reachable server. `HOST` defaults to
`0.0.0.0`.

Put TLS in front of it (a reverse proxy) as soon as it leaves your own network:
the notes are encrypted either way, but the access token is not.
