# CRDT Sync for Obsidian

CRDT-based (Yjs) vault synchronization and live collaboration.

Phase 0 is a technical spike: it validates whether we can bind a Yjs `Y.Text` to
Obsidian's own CodeMirror 6 editor (with remote cursors), with a dedicated
collaboration view as fallback. See `PLAN.md`.

## Requirements

- Node.js 20+ (includes npm; npm workspaces is used)
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
npm run start:server      # in another terminal
npm run ws-test           # does the server relay Yjs updates?
npm run test:sync         # does the editor binding actually sync? (jsdom)
```

`test:sync` drives the real `MainEditorCollabAdapter` against the running server:
initial reconcile, both directions, concurrent edits, deletions, re-attaching
after Obsidian rebuilds the editor state, and rejoining a persisted room.

## Try it

1. Start the server.
2. In Obsidian settings -> CRDT Sync, set the server URL (default
   `ws://localhost:1234`). Leave the token empty in dev mode.
3. Open a markdown note and run the command
   **CRDT Sync: Toggle collaboration on the current note**.
4. Open the same note on a second client (same vault ID) and type.

To test with two separate vaults, share the same **Vault ID** between them
(settings field) so both derive the same room name.

## Phase 0 limitations

- Background file synchronization is Phase 1 and not implemented yet. Phase 0
  streams live edits through the editor and persists them on the server, but does
  **not** write them back to the `.md` file. Close the note only after it has been
  synced elsewhere, or the file may look stale until the next session pulls the
  server state.
- The main-editor integration uses Obsidian-internal CodeMirror APIs
  (`(editor as any).cm`) and may break on Obsidian updates. Use the dedicated
  collaboration view as the stable fallback.
- Obsidian discards the injected CodeMirror extension whenever it rebuilds the
  editor state (file switch inside a leaf, edit/preview mode change). The plugin
  re-attaches on `layout-change`, `active-leaf-change` and `file-open`, and the
  shared document wins the reconcile — so edits made in that editor while it was
  detached are discarded.
- The access token from `/auth/dev-token` is only for testing.
