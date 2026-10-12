# Obsidian Connect for Obsidian

End-to-end encrypted, CRDT-based (Yjs) vault synchronization and live
collaboration.

Keeps a vault in sync across your own devices - notes, pictures, PDFs, canvases -
and lets you share single notes with other people for live editing with cursors,
in Obsidian's own editor. The server you run only ever sees ciphertext. See
`CLAUDE.md` for the architecture, `docs/PHASE2.md` for keys and sharing,
`docs/PHASE3.md` for accounts without names, contacts, the end of a share and
surviving the server, `docs/PHASE4.md` for attachments, `docs/SERVER.md` for
running the server and `docs/CHANGELOG.md` for what each version changed.

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
themselves instead. Everything else — the other account commands, what the
server can and cannot see — is in `docs/SERVER.md`.

Without Docker, with npm, from the repository root:

```bash
npm install
npm run start:server          # reads the .env in the repository root, if there is one
npm run cli -- invite         # in a second terminal: a code for one new account
```

The running server accepts the code at once. Server and CLI keep their data in
`packages/server/data` - set `OBSIDIAN_CONNECT_DATA_DIR` for both, or neither.
The other account commands work the same way: `npm run cli -- user list`,
`npm run cli -- user remove <accountId>`.

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

The password never leaves the device, and nobody can reset it — not even the
server's admin. What gets you back in is the **recovery code** the plugin shows
when the account is made (older accounts make one in the settings): it opens the
account on its own, and you choose a new name and password with it. Keep it
apart from your password. Without either, the encrypted notes on the server are
lost to you; your devices keep their files. The password needs to be strong (the
plugin checks, and offers to generate one); the server never learns your name
either — it knows accounts only by random ids.

Changing the password, or recovering the account, signs out every other device:
they sign in again with the new password.

**Two-factor sign-in** is optional: turned on in the settings, signing in on a
device also asks for a code from an authenticator app (Aegis, 2FAS, Google
Authenticator, …). It guards the sign-in to the server; your notes stay encrypted
with your password either way. A lost phone is what the recovery code is for, and
the server's admin can turn it off too.

Every markdown note is synced automatically; there is no per-note switch. So is
every other file (see *Attachments* below). Settings under *All your devices*
(exclusions, conflict markers, retention, share folder) are the same on every
device; the ones under *This device* are not.

Commands: *Show sync status*, *Open version history* (a note's or a file's),
*Browse backups*, *Deleted notes and files…*, *Notes with two versions…*, *Force
resync of this note*, *Reconnect and rescan the vault*, *Copy the log*, and the
sharing commands below. Sharing, access, history and comparing versions are also
in every file's "…" menu and right-click menu, in a section of their own under
*Obsidian Connect*.

The cloud in the status bar shows where the note or file in front of you stands:
green when the server has everything written here, red while it does not yet,
grey while the server has not answered, orange for a file too large for the
server. Clicking it opens the plugin's menu for that file. Beside it, an icon
says whether the note is shared - a lock when you may only read it, which also
appears in the note's header (phones have no status bar).

**Two versions of a note.** Whatever you type in a note's editor merges with the
other devices' changes by itself, offline too. Both versions are kept only when a
note changes as a *file* - another program or plugin writes it, a device meets
another with a different copy (two existing vaults paired for the first time) -
and both sides changed the same lines, or nothing tells which side changed what.
*Compare versions* shows them side by side, passage by passage: keep this
device's, the other one's, or both. It appears on the device that kept both.

### Attachments

Every file that is not a note - pictures, PDFs, canvases - is synced as an
encrypted, immutable copy per version. A phone downloads files up to 10 MB by
default (*This device* in the settings) and the rest when a note that embeds them
is opened, or with *Download attachments* in the note's menu. A file changed on
two devices at once is kept twice, as `name (conflict <date time>).ext`. Deleted
files go to the same trash as notes, and a file's *Version history* keeps its
earlier versions for the history retention, with a preview for pictures. The
server takes files up to 100 MB by default (`docs/SERVER.md`); a larger one stays
on its device.

**The log** lives in the plugin folder (`logs/`, a week of it) and never contains
the text of a note. *Copy the log* is for bug reports; *Detailed logging* in the
settings adds every change sent and received.

**Deleted notes and files…** (also in every folder's menu and the settings) lists
what was deleted on any of your devices and brings it back. Deleted notes and
files stay restorable for the history retention; after that the server deletes
them, unless a note is still shared with someone.

If the server ever lost data or was restored from an older backup, the plugin
notices, syncs nothing for the affected notes and asks once whether this device
or the server is right. The answer holds for all your devices; a backup of this
device's text is made before the server's older state is taken.

### Contacts

Notes are shared with contacts only. Under *Settings → Obsidian Connect →
Contacts*, one of you creates a friend code and sends it by any other channel;
the other enters it. A code works once and for 7 days. It carries a fingerprint
of its creator's key, so the server cannot slip in a key of its own. Names are
exchanged encrypted and can be changed locally. Removing a contact ends every
share between the two of you; each keeps their copies.

### Sharing a note

1. Open the note and run **Share this note…**. Pick a contact, *can edit* or
   *can read*, and whether they get the note's history or only what is written
   from now on. If they have the note already, the dialog says so, and *Share
   again* changes their access.
2. **Share its attachments** (on by default): the files the note embeds or links
   go along, both ways, and land in each share folder's `Attachments/`. A change
   to such a file reaches the other side; deleting a file that came in this way
   keeps it away for good, and restoring it from the trash brings it back.
3. **Also share the notes it links to** (off by default) lists every note the note
   reaches through links and shares them along, once, with the same choices. They
   land below the share folder at the path of their link, so the links keep
   working.
4. The note appears in their share folder (`Shared/` by default) and stays live
   between you, with each other's cursors. **Notes shared with me** lists what
   others shared with you.
5. **Who has access to this note** changes a person's role, removes them, and
   turns the attachments on or off. Removing someone moves the note to a new key.
6. As the one it was shared with, deleting the note leaves the share, and
   **Make this shared note my own copy** detaches it.

However a share ends — removed, detached, a contact removed, the owner's account
deleted — the other person keeps the note as their own, with the history they
could read and whatever they had not sent yet.

## Tests

```bash
npm run test:merge        # merge, reconcile, identity and crypto (no server, no DOM)
npm run test:load         # does the built bundle load, start and unload cleanly?
npm run test:rooms        # accounts, access, key epochs, sharing, compaction, restart
npm run test:sync         # does the editor binding actually sync? (jsdom)
npm run test:recovery     # a server that lost data or was rolled back, a removed account, cleaning up files (in-process server)
npm run test:account      # signing the other devices out, the recovery code, two-factor sign-in (in-process server)
# against a running server with open registration:
npm run test:socket       # the encrypted transport, two devices of one account
npm run test:vault        # three devices and a collaborator, end to end, notes and attachments
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
once, offline edits on both sides, contacts, sharing with and without history,
read-only access, revoking and detaching with the history kept, the trash,
restoring an old version and compaction, attachments with their conflicts,
versions and trash, shared notes' files and linked notes — and checks that
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
- Attachments do not travel through Yjs. Each version of a file is an encrypted
  blob, named by a keyed hash of its content and uploaded in 4 MiB chunks; the
  vault index names which blob a file holds. A file is replaced or trashed only
  once the server holds its current content.

## Limitations

- **A file shared through a note is stored once per account** on the server: what
  comes in is copied into the receiving account's own store.
- **Documents beyond `maxLoadedDocuments` stop receiving live updates** until
  opened again. They catch up on the next load, but a note you have not touched
  in a while is not live.
- **A forgotten password without the recovery code cannot be recovered.** No one
  can reset it, by design.
- **The server still sees metadata:** which account ids, vault ids and note ids
  exist, who is whose contact and shares with whom, and when and how much was
  written. No names, no titles, no text.
- **Conflicts keep both versions rather than resolving them.** That is
  deliberate — duplication is recoverable, deletion often is not — but it means
  a conflicted note needs manual cleanup.
