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
docker compose exec obsidian-connect obsidian-connect user add alice
```

Updating: `docker compose pull && docker compose up -d`. The data volume stays.

GitHub makes a package private when the repository is. Either set the package to
public (*GitHub → Packages → obsidian-connect-server → Package settings*), or sign
the server in once with a token that may read packages:
`docker login ghcr.io -u johnnyjack123`.

To build the image yourself instead: `docker build -t obsidian-connect-server .` in the
repository root, and point `image:` in `docker-compose.yml` at that name.

`user add` prints an invite code. In Obsidian: *Settings → Obsidian Connect → Create
account*, with the same name, the code and a password of your choice. The password
never reaches the server; losing it means losing access to your encrypted notes (your
devices keep their files).

Data lives in the `obsidian-connect-data` volume. Everything in it is ciphertext
except the metadata: account names, vault names, which note ids exist, who shares
with whom, and when and how much was written.

## `.env`

A template sits in `docs/server.env`:

| Variable | Default | Meaning |
|---|---|---|
| `OBSIDIAN_CONNECT_JWT_SECRET` | — (required) | Signs access tokens. `openssl rand -base64 48`. |
| `OBSIDIAN_CONNECT_REGISTRATION` | `invite` | `invite`: accounts only from `user add`. `open`: anyone who reaches the server can create one. |
| `OBSIDIAN_CONNECT_TOKEN_TTL` | `2592000` | Seconds a device stays signed in without being used. |
| `OBSIDIAN_CONNECT_LOG_UPDATES` | `false` | A log line per document frame. |
| `PORT` | `1234` | Published port. |

## Accounts

```bash
docker compose exec obsidian-connect obsidian-connect user add <name>      # prints an invite code
docker compose exec obsidian-connect obsidian-connect user invite <name>   # new code, account not yet claimed
docker compose exec obsidian-connect obsidian-connect user list
docker compose exec obsidian-connect obsidian-connect user remove <name>
```

An invited name needs its code even when registration is open.

## Without Docker

```bash
npm install
OBSIDIAN_CONNECT_JWT_SECRET=… npm run start:server
npm run cli -- user add <name>
```

Data goes to `./data` next to the server package, or `OBSIDIAN_CONNECT_DATA_DIR`.
Without `OBSIDIAN_CONNECT_JWT_SECRET` the server uses a built-in secret and says
so at startup — fine on a laptop, never on a reachable server. `HOST` defaults to
`0.0.0.0`.

Put TLS in front of it (a reverse proxy) as soon as it leaves your own network:
the notes are encrypted either way, but the access token is not.
