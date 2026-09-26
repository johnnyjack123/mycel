# Obsidian Connect for Obsidian

End-to-end encrypted, CRDT-based (Yjs) vault synchronization and live
collaboration.

Keeps a vault in sync across your own devices, and lets you share single notes
with other people for live editing with cursors — in Obsidian's own editor. The
server you run only ever sees ciphertext. See `CLAUDE.md` for the architecture,
`docs/PHASE2.md` for accounts, keys and sharing, and `docs/SERVER.md` for running
the server.

## Requirements

- Node.js 22+ (includes npm; npm workspaces is used). Node 20 is end-of-life and
  jsdom, used by the self-tests, does not support it.
- Obsidian 1.7.2+ (desktop or mobile)
- Docker, for the easy way to run the server

## Run the server

CI publishes the server image as `ghcr.io/johnnyjack123/obsidian-connect-server` on
every push to `main`. On the server, next to `docker-compose.yml`:

```bash
cp server.env .env           # from docs/; set OBSIDIAN_CONNECT_JWT_SECRET
docker compose up -d
docker compose exec obsidian-connect obsidian-connect invite
```

`invite` prints a code that lets one person create one account. With
`OBSIDIAN_CONNECT_REGISTRATION=open` in `.env`, people can create accounts
themselves instead. Everything else — without Docker, the other account
commands, what the server can and cannot see — is in `docs/SERVER.md`.

## Build the plugin

```bash
npm install
npm run build:plugin
```

Output is `packages/plugin/main.js`. Copy the plugin folder into your vault:

```
<vault>/.obsidian/plugins/obsidian-connect/
```

Required files: `manifest.json`, `main.js`, `styles.css` (add `versions.json` for
release). Then enable **Obsidian Connect** in Obsidian's community plugins settings.

For development with rebuild-on-save:

```bash
npm run dev:plugin
```

### Prebuilt downloads

`.github/workflows/build.yml` builds and tests the plugin on every push:

- Every push to `main` refreshes the **`latest-build`** pre-release with two zips
  plus the loose `main.js`, `manifest.json` and `styles.css`:
  - `obsidian-connect-<version>.zip` contains the plugin folder — unzip it into
    `<vault>/.obsidian/plugins/` for a **first install**.
  - `obsidian-connect-<version>-update.zip` contains the three files at the root
    — unzip it straight into `<vault>/.obsidian/plugins/obsidian-connect/` and
    overwrite to **update** an existing install. Settings and local state stay.
- Pushing a tag publishes a normal release with the same assets.
- Pushes on other branches only upload a build artifact, no release.
- Pushes to `main` also build the server image, start it once as a smoke test and
  publish it to the GitHub container registry.

## Use it

1. *Settings → Obsidian Connect*: enter the server URL (`ws://…` or `wss://…`).
2. **Create account** with your name, the invite code and a password — or
   **Sign in** if the account exists. The vault name defaults to the Obsidian
   vault's name.
3. On every other device: sign in with the same account and the same vault name.
   That is the whole pairing.

The password never leaves the device, and nobody can reset it: losing it means
losing access to the encrypted notes on the server. Your devices keep their
files.

Every markdown note is synced automatically; there is no per-note switch.
Settings under *All your devices* (exclusions, conflict markers, retention, share
folder) are the same on every device; the ones under *This device* are not.

Commands: *Show sync status*, *Open version history for this note*,
*Browse backups*, *Force resync of this note*, *Reconnect and rescan the vault*,
and the sharing commands below.

### Sharing a note

1. Open the note and run **Share this note…**. Pick a person with an account on
   the same server, *can edit* or *can read*, and whether they get the note's
   history or only what is written from now on.
2. The note appears in their share folder (`Shared/` by default) and stays live
   between you, with each other's cursors. **Notes shared with me** lists what
   others shared with you.
3. **Who has access to this note** changes a person's role or removes them.
   Removing someone moves the note to a new key; what they already have stays
   with them, as their own note.
4. As the one it was shared with, deleting the note leaves the share, and
   **Make this shared note my own copy** detaches it with the history you could
   read.

## Tests

```bash
npm run test:merge        # merge, reconcile, identity and crypto (no server, no DOM)
npm run test:load         # does the built bundle load, start and unload cleanly?
npm run test:rooms        # accounts, access, key epochs, sharing, compaction, restart
npm run test:sync         # does the editor binding actually sync? (jsdom)
# against a running server with open registration:
npm run test:socket       # the encrypted transport, two devices of one account
npm run test:vault        # three devices and a collaborator, end to end
```

Run the server for tests on its own port and data directory, never against the
one you use:

```bash
PORT=1235 OBSIDIAN_CONNECT_REGISTRATION=open OBSIDIAN_CONNECT_DATA_DIR=/tmp/oc-test-data npm run start:server
npm run test:vault -- ws://localhost:1235
```

`test:merge` covers the only code path able to delete a user's text.
`test:vault` runs the real accounts, keys, sync layer and editor binding against
an in-memory vault whose editor saves and reloads files the way Obsidian does:
pulling a vault onto a new device, renames, deletes, both devices typing at
once, offline edits on both sides, sharing with and without history, read-only
access, revoking, restoring an old version and compaction — and checks that
nothing on the server is readable.

## How it works

- Every note is a Yjs document, identified by an id derived from the vault key
  and its path. The **vault index** document maps ids to paths, so a rename
  keeps a note's history instead of starting an empty one.
- Every change is encrypted on the device before it is sent. The server keeps an
  ordered log of those ciphertext frames per note and relays them; it cannot
  merge or read them. Your password unlocks the keys, and a note shared with
  someone gets its key sealed to theirs.
- One WebSocket carries the whole vault. A connection per note does not scale.
- Documents are stored locally (IndexedDB) before anything touches the network,
  so offline edits survive closing Obsidian, and so do edits the server has not
  confirmed yet.
- The file on disk is a projection of the document. When they disagree — a file
  edited outside Obsidian, a device whose local state was lost — a **three-way
  merge** against the last agreed text reconciles them, and both sides are
  backed up first. Regions both sides changed keep both versions.
- Version history is decrypted and replayed on your device. After the history
  retention (default 30 days, an account-wide setting) your own device folds
  older versions into an encrypted snapshot.

## Limitations

- **Attachments are not synced.** Binary files do not travel through Yjs; only
  markdown notes do.
- **Documents beyond `maxLoadedDocuments` stop receiving live updates** until
  opened again. They catch up on the next load, but a note you have not touched
  in a while is not live.
- **A forgotten password cannot be recovered** (no recovery codes yet).
- **The server still sees metadata:** account and vault names, which notes
  exist, who shares with whom, and when and how much was written.
- **Conflicts keep both versions rather than resolving them.** That is
  deliberate — duplication is recoverable, deletion often is not — but it means
  a conflicted note needs manual cleanup.
