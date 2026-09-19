# CRDT Sync for Obsidian

CRDT-based (Yjs) vault synchronization and live collaboration.

Phase 0 is a technical spike: it validates whether we can bind a Yjs `Y.Text` to
Obsidian's own CodeMirror 6 editor (with remote cursors), with a dedicated
collaboration view as fallback. See `PLAN.md`.

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
- `CRDT_SYNC_JWT_SECRET` (`dev-insecure-secret-change-me`)
- `CRDT_SYNC_DATA_DIR` (`./data`)
- `CRDT_SYNC_DEV` (`true`, anonymous connections allowed)
- `CRDT_SYNC_TOKEN_TTL` (`86400` seconds)

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
<vault>/.obsidian/plugins/crdt-sync/
```

Required files: `manifest.json`, `main.js`, `styles.css` (add `versions.json` for
release). Then enable **CRDT Sync** in Obsidian's community plugins settings.

For development with rebuild-on-save:

```bash
npm run dev:plugin
```

### Prebuilt downloads

`.github/workflows/build.yml` builds and tests the plugin on every push:

- Every push to `main` refreshes the **`latest-build`** pre-release with
  `crdt-sync-<version>.zip` (unzip it into `<vault>/.obsidian/plugins/`) plus the
  loose `main.js`, `manifest.json` and `styles.css`.
- Pushing a tag publishes a normal release with the same assets.
- Pushes on other branches only upload a build artifact, no release.

## Tests

```bash
npm run test:merge        # merge and reconcile logic (no server, no DOM)
npm run test:load         # does the built bundle import cleanly?
npm run start:server      # in another terminal, for everything below
npm run ws-test           # does the server relay Yjs updates?
npm run test:socket       # many documents over one multiplexed socket
npm run test:history      # versions, replay and rollback
npm run test:sync         # does the editor binding actually sync? (jsdom)
```

`test:merge` covers the only code path able to delete a user's text.
`test:sync` drives the real `MainEditorCollabAdapter` against the running server:
initial reconcile, both directions, concurrent edits, deletions, re-attaching
after Obsidian rebuilds the editor state, and rejoining a persisted room.

## Try it

1. Start the server.
2. In Obsidian settings -> CRDT Sync, set the server URL (default
   `ws://localhost:1234`). Leave the token empty in dev mode.
3. Copy the **Vault ID** to the second device so both join the same vault.
4. Edit a note on either device.

Every markdown note is synced automatically; there is no per-note switch. Use
**Exclude** in the settings to keep folders out.

Commands: *Show sync status*, *Open version history for this note*,
*Browse backups*, *Force resync of this note*, *Reconnect and rescan the vault*.

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
  `CRDT_SYNC_HISTORY_DAYS` (default 30).

## Limitations

- **Attachments are not synced.** Binary files do not travel through Yjs; only
  markdown notes do.
- **Documents beyond `maxLoadedDocuments` stop receiving live updates** until
  opened again. They catch up on the next load, but a note you have not touched
  in a while is not live.
- **No accounts or per-document sharing yet** (Phase 2). Anyone who can reach the
  server in dev mode can read and write every room.
- **Conflicts keep both versions rather than resolving them.** That is
  deliberate - duplication is recoverable, deletion often is not - but it means
  a conflicted note needs manual cleanup.
- The main-editor integration uses Obsidian-internal CodeMirror APIs
  (`(editor as any).cm`) and may break on Obsidian updates. Use the dedicated
  collaboration view as the stable fallback.
- Obsidian discards the injected CodeMirror extension whenever it rebuilds the
  editor state (file switch inside a leaf, edit/preview mode change). The plugin
  re-attaches on `layout-change`, `active-leaf-change` and `file-open`, and the
  shared document wins that reconcile — so edits made in that editor while it
  was detached are discarded.
- The access token from `/auth/dev-token` is only for testing.

## Configuration

Server environment variables, defaults in parentheses:

- `HOST` (`0.0.0.0`), `PORT` (`1234`)
- `CRDT_SYNC_JWT_SECRET` (`dev-insecure-secret-change-me`)
- `CRDT_SYNC_DATA_DIR` (`./data`)
- `CRDT_SYNC_DEV` (`true`, anonymous connections allowed)
- `CRDT_SYNC_TOKEN_TTL` (`86400` seconds)
- `CRDT_SYNC_HISTORY_DAYS` (`30`, individually restorable versions)
