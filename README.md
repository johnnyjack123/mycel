# Obsidian Connect for Obsidian

CRDT-based (Yjs) vault synchronization and live collaboration.

Keeps a vault in sync across your own devices, and lets you share single notes
with other people for live editing with cursors - in Obsidian's own editor. See
`CLAUDE.md` for the architecture and `PLAN.md` for the history of the design.

## Requirements

- Node.js 22+ (includes npm; npm workspaces is used). Node 20 is end-of-life and
  jsdom, used by the sync self-test, does not support it.
- Obsidian 1.7.2+ (desktop or mobile)

## Install

```bash
npm install
```

## Run the server

```bash
npm run dev:server
```

Configuration is via environment variables (defaults in parentheses):

- `HOST` (`0.0.0.0`), `PORT` (`1234`)
- `OBSIDIAN_CONNECT_JWT_SECRET` (`dev-insecure-secret-change-me`)
- `OBSIDIAN_CONNECT_DATA_DIR` (`./data`)
- `OBSIDIAN_CONNECT_DEV` (`true`, anonymous connections allowed)
- `OBSIDIAN_CONNECT_TOKEN_TTL` (`86400` seconds)

The server starts on `ws://localhost:1234` (REST on the same port):

- `GET /health`
- `POST /auth/dev-token` with `{ "name": "alice" }` -> access token (dev mode)
- `POST /auth/login` with `{ "email": "you@example.com", "password": "..." }`

Dev mode allows anonymous WebSocket connections when no token is supplied.

## Build the plugin

```bash
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

## Tests

```bash
npm run test:merge        # merge and reconcile logic (no server, no DOM)
npm run test:load         # does the built bundle load, start and unload cleanly?
npm run test:rooms        # does history survive idle rooms and restarts?
npm run start:server      # in another terminal, for everything below
npm run ws-test           # does the server relay Yjs updates?
npm run test:socket       # many documents over one multiplexed socket
npm run test:history      # versions, replay and rollback
npm run test:sync         # does the editor binding actually sync? (jsdom)
npm run test:vault        # two devices and a collaborator, end to end
```

Run the server for tests on its own port and data directory, never against the
one you use:

```bash
PORT=1235 OBSIDIAN_CONNECT_DATA_DIR=/tmp/oc-test-data npm run start:server
npm run test:vault -- ws://localhost:1235
```

`test:merge` covers the only code path able to delete a user's text.
`test:vault` runs the real sync layer and editor binding against an in-memory
vault whose editor saves and reloads files the way Obsidian does: pulling a vault
onto a new device, renames, deletes, both devices typing at once, offline edits
on both sides, and sharing one note with another vault.

## Try it

1. Start the server.
2. In Obsidian settings -> Obsidian Connect, set the server URL (default
   `ws://localhost:1234`). Leave the token empty in dev mode.
3. Copy the **Vault ID** to the second device so both join the same vault.
4. Edit a note on either device.

Every markdown note is synced automatically; there is no per-note switch. Use
**Exclude** in the settings to keep folders out.

Commands: *Show sync status*, *Open version history for this note*,
*Browse backups*, *Force resync of this note*, *Reconnect and rescan the vault*.

### Sharing a note

1. Open the note and run **Share this note live**. A link is copied.
2. Send it. The other person clicks it, or runs **Open a shared note** and pastes
   it. The note appears in their `Shared/` folder (configurable) and stays live
   between you, with each other's cursors.
3. **Stop sharing this note** turns the cursors off again.

Until accounts exist, anyone with the link who uses the same server can edit the
note, and a link cannot be revoked. Copies the other person keeps stay with them.

## How it works

- Every note is a Yjs document, identified by a stable id. The **vault index**
  document maps ids to paths, so a rename keeps a note's history instead of
  starting an empty one.
- One WebSocket carries the whole vault. A connection per note does not scale.
- Documents are stored locally (IndexedDB) before anything touches the network,
  so offline edits survive closing Obsidian.
- The file on disk is a projection of the document. When they disagree - a file
  edited outside Obsidian, a device whose local state was lost - a **three-way
  merge** against the last agreed text reconciles them, and both sides are
  backed up first. Regions both sides changed keep both versions.
- The server appends every update to a per-room log, which is what makes
  point-in-time rollback possible. Older versions fold into a snapshot after
  `OBSIDIAN_CONNECT_HISTORY_DAYS` (default 30).

## Limitations

- **Attachments are not synced.** Binary files do not travel through Yjs; only
  markdown notes do.
- **Documents beyond `maxLoadedDocuments` stop receiving live updates** until
  opened again. They catch up on the next load, but a note you have not touched
  in a while is not live.
- **No accounts yet** (Phase 2). Anyone who can reach the server in dev mode can
  read and write every room, and sharing is by link without access control.
- **Conflicts keep both versions rather than resolving them.** That is
  deliberate - duplication is recoverable, deletion often is not - but it means
  a conflicted note needs manual cleanup.
- The access token from `/auth/dev-token` is only for testing.

## Configuration

Server environment variables, defaults in parentheses:

- `HOST` (`0.0.0.0`), `PORT` (`1234`)
- `OBSIDIAN_CONNECT_JWT_SECRET` (`dev-insecure-secret-change-me`)
- `OBSIDIAN_CONNECT_DATA_DIR` (`./data`)
- `OBSIDIAN_CONNECT_DEV` (`true`, anonymous connections allowed)
- `OBSIDIAN_CONNECT_TOKEN_TTL` (`86400` seconds)
- `OBSIDIAN_CONNECT_HISTORY_DAYS` (`30`, individually restorable versions)
- `OBSIDIAN_CONNECT_LOG_UPDATES` (`false`) — log a line per document update.
  Normal operation logs only HTTP requests and WebSocket upgrades, so silence
  while you type is expected; turn this on to see edits arriving.

`GET /rooms` is the quieter check: it lists each room with its character count
and number of versions.
