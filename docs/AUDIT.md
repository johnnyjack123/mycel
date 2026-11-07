# Security audit (0.9.8, 2026-11-07)

The audit the 0.9 milestone ends with (`docs/PHASE8.md`, A): the sync server, the
plugin and the backup server read through, every finding tried as a real attack against
running code, and every attack kept as a check that fails should it work again:

```bash
npm run test:security   # the server's interfaces, then the plugin's paths, links, folders, contacts and the backup task
```

- `packages/server/scripts/security-selftest.mts` - a server in-process on a port of its
  own, attacked over HTTP and WebSocket: without an account, as one account against
  another, as a contact against the people they share with.
- `packages/plugin/scripts/security-selftest.mts` - the path checks, the gate in front of
  every file the plugin touches, the backup server's task, and two real devices against an
  in-process server: a contact who shares a folder with the victim and may write in a note
  the victim shared.

S1 to S9, P1, P3 and P4 were checked by putting the bug back: the old source restored, the
new checks seen failing, the fix restored. P2, P10 and B1 to B3 have checks of their own
against the functions that decide. P5 to P9 need a server that lies, which no suite plays:
they were traced in the code, and their fixes are covered by every suite still passing with
them. The attacker each one needs is named: *anyone* on
the internet, an *account* (anyone invited, or anyone with open registration), a *contact*
(someone the victim exchanged a friend code with), a *member* of a share, the *server*
(a compromised or malicious sync server), or a person *paired* with a backup server.

## Findings, fixed in 0.9.8

| # | Severity | Where | Who | What |
|---|---|---|---|---|
| S1 | critical | server | anyone | One malformed or oversized WebSocket message ended the server process |
| S2 | critical | server | anyone who learns an account id | Without `MYCEL_JWT_SECRET`, tokens were signed with a secret from the sources |
| P1 | critical | plugin | a folder's owner or writer | Paths in a shared folder's document wrote anywhere: outside the folder, into `.obsidian/plugins`, outside the vault |
| S3 | high | server | an account | A short JWT secret was accepted; any account's own token is enough to search for it |
| S4 | high | server | anyone | Behind a proxy, ten wrong passwords from anyone blocked everybody's sign-in; sixteen relay connections blocked every backup server |
| S5 | high | server | anyone | Bodies of 64 MiB were parsed before any token was looked at |
| S6 | high | server | an account | Answers to friend codes without size or number: contacts.json grew past what the server can read, and contacts and shares stopped for everyone |
| P2 | high | plugin | a member who may write | A backslash in a link of a shared note passed the `..` filter (Windows) |
| P3 | high | plugin | a folder's owner or writer | A folder's document naming another note of the victim (by its id) handed it to the folder's owner and deleted it on every device |
| P4 | high | plugin | a member who may write, or the owner | A link typed into a shared note (`![[passport.pdf]]`) had every other device in it publish its own file of that name |
| P5 | high | plugin | server + a contact | A friend code did not bind its creator's account id: the server could name another contact and have that contact's pinned keys replaced |
| P6 | high | plugin | server + a contact | Keys were sealed to whoever the server listed as member, if a contact; a folder share sealed keys - and wrote starting points under the folder's key - for every note the server listed in the folder |
| B1 | high | backup server | a paired person | A backup task's environment went to restic whole: `LD_PRELOAD`, `RCLONE_CONFIG`, `AWS_SHARED_CREDENTIALS_FILE` - code on the backup server, every other vault on it readable |
| B2 | high | backup server | a paired person | An `sftp:` or `rclone:` location starting with `-` is an option to ssh or rclone (`-oProxyCommand=…`) |
| S7 | medium | server | a contact | Titles, sealed keys and attachment lists of any size went into a room's metadata, rewritten whole and read at every start; keys of epochs a note never had were taken |
| S8 | medium | server | an account | WebSocket frames of up to 100 MiB were stored, and held in memory whenever their room is open |
| S9 | medium | server | an account that learns a vault id | Another account's vault id could be registered, and the vault's index room claimed before its owner's first device did |
| P7 | medium | plugin | server + a contact | A sealed key was taken when any pinned contact had signed it, not only the room's owner |
| P8 | medium | plugin | server + a folder member | The server's tie of a note's epoch to a folder decided which key this device wrote under: a private note could be written, and compacted, under a folder's key |
| P9 | medium | plugin | server + a contact | A fork checked what was kept against the owner the server named |
| P10 | medium | plugin | any member, a reader too | A caret's colour went into a style attribute as it came: a picture over the editor, a beacon telling who looks at the note |
| B3 | low | backup server | a paired person | On a Windows host, `\` and trailing dots in a path could climb out of the decrypted copy |
| S10 | low | server | other users of the host | The data folder's files were written with the default umask: `accounts.json` - every TOTP secret, every login hash - readable by everyone on the host |

### What changed

- **S1** - every WebSocket the server accepts has an `error` listener (`heard`, `server.ts`),
  and so has the raw socket during an upgrade (Node removes its own). Reproduced: before, one
  2 MiB message to `/relay?role=backup` - no token needed - and the process exited.
- **S2, S3** - no built-in secret. Unset, the server makes one and keeps it in `jwt-secret`
  in its data folder (mode 0600); set, it needs 32 characters or the server does not start.
- **S4** - `MYCEL_TRUST_PROXY` names the reverse proxy; its `X-Forwarded-For` then counts, for
  sign-ins and for the relay's backup servers per address. Unset, the header is ignored.
- **S5** - every route but sign-in, registration, recovery and the backup server's sign-in
  checks the token's signature in an `onRequest` hook, before the body is read; those take
  64 KiB at most.
- **S6** - introductions are 16 KiB at most, a redemption has one answer (a new one replaces
  it), an account has 50 friend codes open at most.
- **S7** - a title 16 KiB, a sealed key 4 KiB, keys only of epochs the room had and only for
  its members, 256 attachments per request and 4096 per note.
- **S8** - 32 MiB per socket message; a larger one closes that connection (1009).
- **S9** - a vault id is refused when another account has it.
- **P1, P2** - `vaultPathProblem` (`shared/paths.ts`): a vault path is relative, `/`
  separated, without empty, `.`, `..` or hidden segments (Obsidian lists no dot-file), none
  Windows reads as one after dropping trailing dots and spaces, no backslash, no control
  character, no drive. The folder mirror (`Folders.reconcile`, `FolderFiles.reconcileOne`)
  leaves out every entry whose path is no note's or no file's; a shared note's files land
  only at such a path (`SharedFiles.deliveryPath`); titles and folder names lose leading and
  trailing dots. **And one gate behind all of them** (`plugin/src/guard.ts`): `onload`
  replaces the plugin's `app` with one whose vault, adapter and file manager check every
  path first - vault paths that are not hidden, and the plugin's own folder, nothing else; the
  test harness runs every suite behind it.
- **P3** - a note this vault knows is the folder's to move, revive or re-own only when it is
  in that folder, or the folder owner's own note shared on its own, now joining it.
- **P4** - a device publishes a file of its own for a link only when every letter of the
  link was typed on it this session, when the note (or folder) is being shared from it with
  its files, or when the user says yes to a notice naming the note and the file.
- **P5** - the fingerprint in a friend code covers the account id with both keys. On the
  creator's side, a redemption naming an existing contact with other keys is dropped unless
  that contact replaced theirs. Codes made before 0.9.8 no longer redeem.
- **P6** - `Sharing.memberKeys` takes only members this account recorded giving the note or
  folder to (`recordRole`, synced to every device of the account); anyone else stops the
  rotation as a stranger does (`UnknownMembersModal`). A folder's share, rotation and starting
  points cover only notes this vault's own index has in the folder (`Folders.ownNotesIn`), and
  a starting point is written under a folder key only for that folder.
- **P7** - `KeyRing.openSealed` takes a key only when its sealer is the room's owner as the
  index has it (`setRoomOwners`).
- **P8** - a note's epoch tied to a folder is written under that folder's key only when the
  index has the note in that folder (`KeyRing.tieAgrees`); otherwise what was written waits.
  The compactor asks the same.
- **P9** - a fork is checked against the owner the index recorded.
- **P10** - colours are hex or the default, names 64 characters at most (`presentUser`).
- **B1** - only named credentials reach restic (`CREDENTIALS`, `config.ts`): the keys of S3,
  B2, Azure, Google, OpenStack Swift and restic's REST server, nothing that loads, runs or
  points to a file; `rclone:` remotes are configured by the operator in `rclone.conf`.
- **B2** - `locationProblem`: no control character or space, nothing after the scheme, or
  after `user@`, starting with `-`.
- **B3** - `safePath` splits on `\` too and maps a segment of dots and spaces to `__`.
- **S10** - the server and its CLI run with `umask 077`: what they write is their user's alone.
  Files written before keep their mode until they are next replaced (`chmod -R go= data`).

## The residual risks, fixed in 0.9.9

What 0.9.8 left open, closed in the round after it. Each has a check in `test:security`
(R5's in `test:merge`), and R1, R4 and R6 were seen failing with the fix taken out.

| # | Who | What it was | What changed |
|---|---|---|---|
| R1 | server + someone revoked | The plugin followed the epoch the server named, downwards too: new text written under a key the revoked person still holds | No device writes under an epoch below the highest one it, any device of its vault (the settings document) or a key sealed to the account knew (`KeyRing.epochFloor`); the owner's device moves the room past it (`catchUpEpoch`), and the server accepts such a jump. A server restored from a backup gets the same, so nothing stays stuck |
| R2 | anyone with open registration | The number of rooms and the bytes of their logs had no limit | `MYCEL_QUOTA_MB` covers an account's rooms too, each with a fixed charge; a frame past it is answered `full` (kept, offered again), a new room `denied full`. With open registration and no quota the server warns at its start |
| R3 | whoever reads the proxy's log | The access token travelled in the WebSocket URL | It goes as a subprotocol (`mycel.token.<jwt>`), which no access log writes; the server still reads the URL's from plugins before 0.9.9 |
| R4 | any member, a reader too | Presence was not signed: a caret in any account's name | Signed by its sender (`packSignedPresence`); drawn only for this account, a contact - under the name this account calls them - or a writer the owner certified, and only for client ids naming the signer |
| R5 | the server | Titles were sealed, not signed: the server chose the name a share landed under | The owner signs the sealed title; anything else lands under a plain name |
| R6 | server, or someone with a key | The backup server took every frame that opened | It checks signatures as the devices do: the account's signing key comes with the grant (an older pairing gets it over the pairing), the contacts' from the settings |
| R7 | a paired person | A cloud location in the backup server's own network (`rest:http://192.168.…`, `169.254.169.254`) | Refused before every start of restic, by name and by what the name resolves to, unless the operator allows the host (`MYCEL_BACKUP_ALLOW_HOSTS`). A name that resolves elsewhere a moment later is beyond this: a firewall on the way out is not |
| R8 | a writer | The author's clock ordered the history: a change dated back into every rollback's past | Someone else's change counts as made no earlier than an hour before the server took it (`changeTime`); this account's own keep their time. A compaction's stamp is never later than the server took its newest frame |
| R9 | the server | `contact-removed` took a contact - and every share between the two - away on the server's word | The remover signs it; the other device forgets the contact only on that signature, and not on one from before they became contacts |

And P4 more precisely: a link typed on another device of the same account - its signed frames
say which Yjs clients are the account's - counts as typed here; any other account's frame
using a client id takes it out of that for good.

## Not fixed - known, and why

- **What a server can always do:** withhold frames, delay them, deliver them to some and not
  others, refuse service, hand an older snapshot (which only adds), see who talks to whom and
  when, and how large each change is. Withholding includes the settings document: a device
  that never received a revocation does not know of it.
- **A reader nobody knows draws no caret.** Presence is shown only for someone this device
  can tell (R4); a reader who is no contact of yours has no certificate to show. Their text
  is not affected - readers write none.
- **DNS rebinding against the backup server** (R7): restic resolves the name again itself.
- **A writer's offline edits** show in the history from an hour before they reached the
  server, not from when they were made (R8) - the price of not taking their clock's word.

## Updates of the plugin

The gate (`guard.ts`) protects against the plugin being misled - by the server, by the
people it shares with. It cannot protect against the plugin itself: a community plugin runs
inside Obsidian with every right Obsidian has (on a desktop: Node's `fs`, `child_process`,
the network), and an update of it replaces the gate along with everything else. No code
inside the plugin can bind a later version of it. What keeps an update honest is outside it:

- **The server cannot send code.** The plugin loads nothing at run time: no `eval`, no
  `new Function`, no `import()` of anything, no script from the network (checked in the
  sources). Its code changes only when someone installs a new `main.js`.
- **Install by hand, and check what is installed.** CI builds `main.js` from `main`; a
  release could carry its SHA-256 and a build attestation (GitHub's `attest-build-provenance`,
  Sigstore), and the user compare it before copying the file. Obsidian's community directory
  installs updates unasked only for plugins that are listed there.
- **Guard the repository.** Two-factor sign-in on GitHub, `main` protected, the lockfile
  committed and installed with `npm ci`, updates of dependencies looked at before they are
  taken: the bundle contains every dependency.
- **Contain Obsidian.** Only the operating system can stop Obsidian itself: a separate user
  account, or a sandbox (Flatpak with file access limited to the vault, a container).

## Open from `docs/PROGRESS.md`

The races seen only in CI (the fork on return in `test:recovery`, delete against restore in
`test:folders`, a writer's offline file version, a rename going back and forth, the starting
point in `test:backup`) are availability and consistency problems, not security ones, and
were not looked into in this audit or in 0.9.9. One of them hides data: a writer's offline
version of a shared folder's file can end up only in the file's version history - still on
the server and restorable from there, but not as a file. They need a round of their own.
