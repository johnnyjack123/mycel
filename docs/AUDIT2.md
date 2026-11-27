# Second audit (0.9.33 before 1.0.0, 2026-11-27)

The audit asked for before 1.0.0 (`docs/PROGRESS.md`, Next 1): the whole project attacked from
every role - the internet, an account, a contact, a share member, a removed member, a malicious
sync server, a person paired with a backup server - and put into odd situations for data loss.
Done on `fix/cosmetics` at 75b73f4 (unreleased 0.9.33), in a worktree of its own. Nothing under
`src/` was changed; every reproduction is a script of its own:

```
packages/plugin/scripts/audit2/*.mts   real devices (harness.mts) against an in-process server
packages/server/scripts/audit2/*.mts   the server over HTTP and WebSocket
packages/backup/scripts/audit2/*.mts   the backup server's own functions, the pinned restic
```

Run a plugin one with `cd packages/plugin && npx tsx --tsconfig scripts/tsconfig.json scripts/audit2/<name>.mts`,
a server or backup one with `cd packages/<server|backup> && npx tsx scripts/audit2/<name>.mts`. Each
prints `FAIL` where the attack works; `EXPECTED SAFE` names what a fixed build must do, so the scripts
can become checks of `test:security` once fixed.

Status: **reproduced** - run, the attack seen working; **reasoned** - traced in the code, not run
(memory of this machine, or a malicious server's whole behaviour needed); **suspected** - depends on
behaviour outside the code (Obsidian, Windows, a library).

Attackers as in `docs/AUDIT.md`: *anyone*, an *account*, a *contact*, a *member* (reader or writer)
of a share, the *server*, a *paired* person (backup server).

## What became of it (0.9.33, branch `fix/audit2`, 2026-11-27)

Every reproduction was run once more before anything was fixed, and each attack worked. After the
fixes each script ends without a `FAIL`; together they are `npm run test:audit2`
(`scripts/test-audit2.mjs`), in CI after the backup self-test. Scripts whose attack now stops earlier
than it used to - a code refused, a replacement stopped - were adjusted to say so as a check.

| # | Fixed how |
|---|---|
| C1 | A snapshot id must be restic's hex (`snapshotId`, in `Restic` and `BackupService.repository`), and `--` ends restic's options before it. |
| C2 | The account's public keys are derived from its private keys at every unlock (`publicKeyOf`); a bundle naming others is logged. |
| C3 | Relay frames are parsed by type (`parse`), and a listener that throws closes only its connection (`guarded`). |
| H1 | *Replace all keys* seals only to accounts given the note or its folder (`recipient`), skips former holders, stops at a member nobody gave it to. |
| H2 | Once anyone else could write in a note (`AccountSettings.othersMayHaveWritten`, kept after the role goes), sharing again claims no link and approves no file. |
| H3 | A file never agreed on where someone else's written note lies is set aside as `Name (own copy).md`, outside a shared folder (`setAsideFor`); duplicates of different owners or folders are moved apart, not merged. |
| H4 | A frame no key of its epoch opens is an empty change - only where that key opens something else of the epoch; otherwise the replacement stops, nothing changed (a wrong tie would have emptied a history). |
| H5 | Presence at most 64 KiB, 30 a second after a burst of 500; a connection more than 64 MiB behind is closed (it catches up from the log); 48 connections per account. **Left:** logs are still read whole per request (`logResponse`, `GET /times`). |
| M1 | Files above the device's download limit are "left on the server" (`JoinPlan.heldBack`), never deleted by overwriting. |
| M2 | An unsent edit counts as a change here: the note is kept against a delete elsewhere, and sent. |
| M3 | Attempts are taken before they are checked (`AddressGuard.begin`/`end`): a burst is no more than one by one. |
| M4 | Keys someone sends are looked up as own entries only (`own`). |
| M5 | The network check before reading a backup back too; `s3://host`, `s3:host:port`, IPv4 in hex IPv6; a name that does not resolve is refused; only restic's schemes are cloud locations. |
| M6 | A compacted log counts only if its snapshot reaches the frame the cache followed; otherwise it is a divergence, which holds the retention. **Left:** withheld blobs and newly unreadable frames are not counted toward the hold. |
| M7 | Starting points and rewrites within the quota; unfinished uploads counted, at most 32 per vault, gone after a day untouched. |
| M8 | An epoch jumps by at most 1024; a share with history at most 4096 epochs, its keys counted against the quota. |
| M9 | An own note's epoch is read under a folder's key only when the index has it there (for the room's epoch and later; earlier ones are its past); held back, never dropped. |
| M10 | A frame below the highest epoch applied in its room is dropped (`RoomCursor.lastEpoch`; reset when another log is read from its start). |
| M11 | `Sharing.renewFor` skips rooms not given to that account. **Left:** `contact-replaced` is still the server's unsigned word - it can only make a contact confirm again. |
| M12 | The replacement's rings get the index's folders; every epoch keeps the tie it was read under, the current one must match the index. |
| L1 | Retention counts from the later of a delete and this device first seeing it (`StateStore.seenDeleted`). |
| L2 | Folder entries are read only as objects with a path (`entryOf`). |
| L3 | A room someone else made, still empty, goes to the folder whose writer makes a note of it (`unused`, `dropRoom`). |
| L4 | A share naming an id the index knows as another's is refused. |
| L5 | Overwriting leaves notes this account shares to the merge; the state is flushed before the join counts as done. |
| L6 | A vault copy cut short is removed. **Left:** free space is not checked first - the plugin cannot ask for it. |
| L7 | Files larger than the server takes are left out of the comparison. |
| L8 | Room names checked before they become cache files; one invitation pairs one vault; pax headers at most 1 MiB; snapshots tagged by vault and forgotten by that tag. **Left:** idle sessions, `checkTask` outside the queue, a pairing replaced on the sync server's word, `GOOGLE_APPLICATION_CREDENTIALS`. |
| L9 | Access asked again before a subscriber is added; no restore once a deleted vault's time is up; at most 100 vaults per account. **Left:** `user remove` drops `deletedVaults` (their ids could be taken again by someone who learned them); owner REST routes do not ask `deletedVaults`. |
| L10 | Paths a shared folder names must also hold on Windows (`portablePathProblem`); the epoch floor counts sealed keys only once their signature holds. **Left:** case-only and NFC/NFD collisions. |

**Known and left, besides those above:** a new device catching up from zero cannot tell a note's past
ties from forged ones - a malicious server and a folder's writer together could slip text into history
it reads for the first time (M9 holds for the epoch the room is in, M10 for later frames).

## Summary

| # | Severity | Where | Who | What | Status |
|---|---|---|---|---|---|
| C1 | critical | backup server | paired | A snapshot id from the device is a restic option: `--password-command` runs any command on the backup server | reproduced |
| C2 | critical | plugin | server | The account's public keys come from the server unchecked; friend codes vouch for the server's key, and the server reads what contacts share | reproduced |
| C3 | critical (open registration), else high | server | account | One relay message (`"d": {"toString": 0}`) ends the server process | reproduced |
| H1 | high | plugin | server + contact | *Replace all keys* seals a private note's keys to any contact the server lists (P6 again) | reproduced |
| H2 | high | plugin | writer | "Share again" claims a writer's links and hands over the victim's files (P11 again) | reproduced |
| H3 | high | plugin | contact, or chance | A private note merges into someone else's shared note when two devices used one path | reproduced |
| H4 | high | plugin | writer | One unreadable frame stops *Replace all keys* for good, and with it all sync | reproduced |
| H5 | high | server | account | Awareness of up to 32 MiB is copied to every subscriber with no backpressure: memory exhaustion | reasoned |
| M1 | medium | plugin (0.9.33) | - | *Overwrite the server* on a phone deletes every file above its download limit, everywhere | reproduced |
| M2 | medium | plugin | - | An edit made offline loses to a delete elsewhere, and never reaches the server | reproduced |
| M3 | medium | server | password holder | Wrong 2FA codes sent at once are all checked; the code limit and the address limit are races | reproduced |
| M4 | medium | server | account | `POST /vaults {replaces: "__proto__"}` pollutes `Object.prototype`: no deleted vault can be restored | reproduced |
| M5 | medium | backup server | paired | R7 does not hold: `backupList`/`backupRead` never check the network; `s3://`, `s3:host:port`, mapped IPv6 pass | reproduced |
| M6 | medium | backup server | server | Empty or unreadable logs and withheld files wear the backups away without the 0.9.13 hold | reasoned |
| M7 | medium | server | account | `MYCEL_QUOTA_MB` does not cover snapshots, starting points, rewrites or unfinished uploads | reasoned |
| M8 | medium | server | account + contact | Room metadata grows without bound (epoch jumps of 2^20, a key per epoch), read whole at every start | reasoned |
| M9 | medium | plugin | server + folder member | The server's folder tie decides the key and certificate a note is read with: a folder writer writes into a private note | reasoned |
| M10 | medium | plugin | server + removed writer | Frames under an epoch already left behind are applied: a revoked writer keeps writing | reasoned |
| M11 | medium | plugin | server + contact | `Sharing.renewFor` seals every shared note's keys to whoever the server lists | reasoned |
| M12 | medium | plugin | server + folder member | During *Replace all keys* the server's tie decides which key a private note is rewritten under | reasoned |
| L1 | low | plugin | - | A device clock behind by more than the retention purges its deletes from the server at once | reproduced |
| L2 | low | plugin | writer | A `null` entry in a folder's document stops the folder's mirror on every device | reasoned |
| L3 | low | server | folder reader | A reader claims the ids of notes not made yet: they never sync | reasoned |
| L4 | low | plugin | server + contact | An incoming share takes over the id of a note of one's own in the trash | reasoned |
| L5 | low | plugin (0.9.33) | - | *Overwrite the server* overwrites what collaborators wrote in one's own shared notes; a crash right after leaves conflict copies | reasoned |
| L6 | low | plugin | - | The joining copy of the whole vault checks no free space and leaves partial copies | reasoned |
| L7 | low | plugin | - | "Take the server's version" trashes files too large for the server | reasoned |
| L8 | low | backup server | server / paired | Server-named rooms become cache paths; one invitation pairs two vaults; pairing replaced on the server's word; a pax header of any size; open sessions; `GOOGLE_APPLICATION_CREDENTIALS` | reasoned / suspected |
| L9 | low | server | account | The sweep against a restore; a revoked member left subscribed; a deleted vault reachable by other routes | reasoned |
| L10 | low | plugin | writer / server | Paths with a trailing dot, `:` or a device name pass inside a shared folder; the epoch floor pushed to 2^53 | reasoned / suspected |

Attacked and found sound: see the last section. One claim of the reviews was **refuted**: an unknown
scheme (`xx:/../..`) as a backup location does not reach the disk - restic 0.19.1 refuses it.

---

## Critical

### C1 - a paired person runs any command on the backup server

- **Where:** `packages/backup/src/sessions.ts:184-193` hands `params.ref` on;
  `service.ts:408-414` (`repository`) checks only `typeof ref.notes?.id === 'string'` (and nothing of
  `ref.files.id`); `restore.ts:95,98,133,136` pass the ids to `Restic.dumpTo`; `restic.ts:241`
  spawns `['dump', snapshotId, path]` without `--`.
- **How:** restic reads an argument starting with `-` as an option and resolves
  `--password-command` in its root command's pre-run, before `dump` counts its arguments - the
  command runs, then restic says "no file and no snapshot ID specified". Seen with the pinned
  0.19.1 on this machine. `RESTIC_PASSWORD` in the environment does not stop it.
- **Impact:** code as the backup server's user, who holds every pairing's grant (vault key, the
  account's key pair, its signing key) and every decrypted copy. Every vault on the backup server is
  readable and every repository can be destroyed. The first audit's B1/B2 were this class through
  the environment and the location; this is the third door.
- **Reproduction:** `packages/backup/scripts/audit2/restic-snapshot-id-injection.mts` (needs
  `MYCEL_RESTIC`), through the backup server's own `listBackup`; the injected command writes a marker
  file. **Reproduced.**
- **Fix:** accept only `^[0-9a-f]{8,64}$` as a snapshot id (from the device, and in `ls`, `dump`,
  `forget`), and put `--` before positional arguments everywhere restic is started.

### C2 - the server chooses the key the account's friend codes vouch for

- **Where:** `packages/plugin/src/account/Session.ts:503-517` (`unlockWith`: `publicKey:
  fromBase64(bundle.publicKey)`), `:610-613` (`openSigningKey`: `publicKey:
  fromBase64(bundle.signingPublicKey)`); the bundle is fetched again at every start (`unlock`,
  `:629`). Only the private halves are unwrapped under the master key; nothing ties the public halves
  to them. `SyncSession.ts:303-312` builds `Contacts.me` from them; `Contacts.createCode`/`openCodes`
  (`Contacts.ts:215,220`) compute the fingerprint from them; `introduction()` sends them.
- **Attack (server alone):** hand the victim's device a bundle with the server's own ECDH public key
  (and, for signatures, its own signing key); answer the contact's `contactCode` lookup with the same.
  The fingerprint in the victim's code covers the server's key, so the contact's check in
  `Contacts.redeem` passes and the contact pins it. Every key the contact seals to the victim from
  then on opens with the server's key. (A real server also opens the contact's introduction with its
  key and seals it on to the victim's real one - its MAC needs no key of the server's.)
- **Impact:** breaks the end-to-end promise against the server for everything shared with the
  victim by contacts made while the server lied; with the signing key substituted, the server signs
  sealed keys, titles, presence and link claims as the victim toward that contact (P5/P7 void).
- **Reproduction:** `packages/plugin/scripts/audit2/server-substitutes-own-key.mts` - the contact
  pins the server's key, shares a note with the victim, and the "server" decrypts it:
  `"the contact writes this for the victim only\n"`. **Reproduced.**
- **Fix:** check the public halves against the private ones at every unlock (ECDH: derive or a
  seal/unseal round trip; ECDSA: sign and verify a nonce), or pin them on the device at registration
  and refuse a bundle that differs; better still, wrap them with the private halves.

### C3 - one relay message ends the sync server

- **Where:** `packages/server/src/relay.ts:210,217` forward `String(frame.d)`, `:220-227` (`end`)
  stringify a client's `reason`; the `message` listeners (`:103-109`, `:127-132`) have no try/catch,
  ws emits `message` synchronously from the socket's `data` event, and the process has no
  `uncaughtException` handler. S1 (0.9.8) added `error` listeners, which do not catch a throw in the
  server's own listener.
- **Attack:** any account opens `/relay`, a backup end (no token needed) registers a route, the
  account opens a session to it and sends `{"t":"data","s":S,"d":{"toString":0}}`
  (`TypeError: Cannot convert object to primitive value`). A deeply nested `reason` in a `close` frame
  does the same (`RangeError`). Repeatable after every restart.
- **Reproduction:** `packages/server/scripts/audit2/relay-crash.mts` - a real server process on
  port 1237 with a scratch folder; it exits with code 1 after the message. **Reproduced.**
- **Fix:** try/catch around both listeners; forward only `typeof d === 'string'` and a bounded
  `typeof reason === 'string'`; consider a process-level handler that logs and keeps serving.

## High

### H1 - *Replace all keys* seals a private note's keys to a contact the server names

- **Where:** `packages/plugin/src/account/KeyReplacement.ts:257-264` (`sealKeys`: every `holder` of
  the server's `wholeLog(room).keys`, every epoch listed), `:278-281` (the next epoch to every listed
  `member`), `:286-295` (`recipient`: a contact is enough; the role falls back to `read`). The check
  0.9.0 put into `Sharing.memberKeys` (P6: only members this account recorded) is missing here.
- **Attack (server + any contact):** during a replacement, answer `wholeLog` of a private note with
  `keys: { <contact>: [0..epoch] }`. The rewrite request carries the note's new keys sealed to the
  contact and signed by the victim; the contact reads the whole rewritten history. With C2 the server
  needs no contact. It happens exactly when the person reacts to a suspected theft.
- **Reproduction:** `packages/plugin/scripts/audit2/replace-keys-seals-to-listed.mts` - the contact
  opens the key and reads `"nobody else reads this\n"`. **Reproduced.**
- **Fix:** holders and members only where `settings.shareRole(room, account) !== null` (or the folder
  record for `fld:` rooms), anyone else stopping the replacement as a stranger does.

### H2 - "Share again" hands a writer the victim's file (P11 bypassed)

- **Where:** `packages/plugin/src/share/Sharing.ts:402-403` - every `share()`, also sharing again
  with the same person or with one more, runs `approveFiles(docId)` (with files) and
  `claimLinks(docId)`; `LinkClaims.claimAll` (`LinkClaims.ts:210-234`) claims every link without a
  holding claim; `SharedFiles.approve` (`SharedFiles.ts:366-375`) approves every link the note has.
  The share dialog starts from the note's current choice for its files.
- **Attack (a writer):** write `![[passport.pdf]]` into a note the victim shares with its files,
  claiming nothing (or delete the claim). The victim's device rightly shares nothing - until the
  victim shares the note again for any reason. Then the victim's `passport.pdf` is listed and lands in
  the writer's vault. `docs/AUDIT.md` says "a writer can delete claims; the links are then nobody's,
  and nothing is shared because of that".
- **Reproduction:** `packages/plugin/scripts/audit2/reshare-claims-foreign-link.mts`. **Reproduced.**
- **Fix:** claim on sharing only links no other account's change touched (Yjs client ids per signer,
  as `LinkClaims` already tracks), or ask by name for each file a link of nobody's would take along;
  approve only claimed links.

### H3 - a private note merges into someone else's shared note

- **Where:** `packages/plugin/src/sync/DocStore.ts:938-958` (`syncFile`: the id is whatever live entry
  the index has at the path), `:1026-1028` (no base: additive merge into that document),
  `:1525-1531` (`acceptShare`: `freePath` is free *on the accepting device*), `:1337-1360`
  (`mergeDuplicates`: folds any two live ids at one path into the sorted-first one, whoever owns it).
- **Situation:** one device of the victim takes in a share titled "Plan" at `Shared/Plan.md` - free
  there - while another device of the victim, offline, has a note of its own at that path. When that
  device starts, the scan takes the private file for the shared note's file, finds no base, and merges
  both into the sharer's document - the sharer reads it. A device that was running but offline gets
  two ids at one path instead, and `mergeDuplicates` folds into the sorted-first one; a sharer can
  pick a note whose id sorts low. The share folder can be the vault root (`settings.ts:1254`), which
  makes the collision likely. The same holds for an incoming shared folder landing on a folder an
  offline device has notes in. Breaks invariant 32 ("only what this account decided goes out").
- **Reproduction:** `packages/plugin/scripts/audit2/private-note-into-share.mts` - the sharer's note
  ends as `"mallory's plan\nPRIVATE: my bank PIN is 4711\n"`. **Reproduced** (the first variant; the
  duplicate variant is reasoned).
- **Fix:** never merge a file this device never agreed on into a note someone else owns, or one in a
  shared folder it did not know the file as part of: move the file aside to a free name (a note of
  its own) and pull the shared note next to it. `mergeDuplicates` must not fold across owners or
  across a folder boundary; rename one aside instead.

### H4 - one unreadable frame stops *Replace all keys* for good

- **Where:** `packages/plugin/src/account/KeyReplacement.ts:221-237` (`open`: "no key opens ...
  nothing of it was changed" throws); `main.ts:1446-1451`: "nothing syncs until they are", and every
  start carries the replacement on and meets the same frame.
- **Attack (a writer in any note or folder the victim owns):** push a frame of random bytes - the
  server stores ciphertext as it comes, every device drops it unnoticed. The next *Replace all keys*
  stops at it, and the account syncs nothing on any device from then on, with the old keys still
  opening every room not yet rewritten. A frame damaged on the server's disk, or one a past bug wrote
  under a key nobody holds, does the same without an attacker.
- **Reproduction:** `packages/plugin/scripts/audit2/replace-keys-blocked.mts` (also checks that the
  room itself goes on - it does). **Reproduced.**
- **Fix:** treat a frame no key opens as every device does: dropped, rewritten as an empty change
  (it has no signature to vouch for it), logged; stop only for keys that are missing (`unknown`).

### H5 - any account exhausts the server's memory through presence

- **Where:** `packages/server/src/rooms.ts:751-757` (`awareness`: no size limit, no rate, sent to every
  subscriber), `wshub.ts:84-90,124-129` (a copy per subscriber), `wshub.ts:14-21` (`bufferedAmount`
  never looked at), `server.ts:151` (32 MiB per message). Frames fan out the same way
  (`rooms.ts:746-748`). Whole logs are read into memory per request (`logResponse`, `GET /times`,
  `headOf` for watches) with no concurrency limit.
- **Attack:** an account opens about a hundred sockets on its own vault, subscribes them to one room
  of its own, lets 99 of them never read, and sends 32 MiB of presence: about 3 GiB allocated in one
  synchronous loop. A Raspberry Pi or a small VPS falls over; every user loses the server.
- **Status:** reasoned (code read; not run - this machine has about 1.6 GB free).
- **Fix:** presence a few KiB and rate-limited; skip or close subscribers above a `bufferedAmount`;
  connections per account capped; logs streamed.

## Medium

### M1 - *Overwrite the server* (0.9.33) on a phone deletes its large files everywhere

- **Where:** `packages/plugin/src/sync/Joining.ts:387-398` (every file "only the server has" is
  `markDeleted`), `:421-442` (`compare` counts the index's files, not what this device may download);
  `AttachmentStore.pullMissing` (`:1007-1018`) leaves files above `downloadLimitBytes` on the server,
  10 MB by default on a phone, set again after a disconnect (`main.ts:1318`).
- **Situation:** the way a device that synced before reaches the choice is *Disconnect this vault*.
  The phone's vault lacks every file above its limit, so the comparison finds "the same state, the
  server having more" - exactly when `JoinModal` offers *Overwrite the server* ("what it has besides
  may be what went wrong"), naming only a count. Chosen, every large PDF, video and scan is deleted on
  the server and trashed on every other device (they knew the content: invariant 24 lets it go).
  Restorable from the trash for the retention.
- **Reproduction:** `packages/plugin/scripts/audit2/overwrite-download-limit.mts`. **Reproduced.**
- **Fix:** leave out of "only there" what this device would not have pulled (above its limit,
  excluded) - and say so; name the files in the window.

### M2 - an edit made offline loses to a delete elsewhere, and is never sent

- **Where:** `packages/plugin/src/sync/DocStore.ts:1376-1415` (`applyRemoteDelete`: "changed here"
  means the file differs from the last agreement - an offline device agrees with its own document at
  once, so its unsent edit counts as agreed; then `dropHandle` unregisters the room with the edit still
  in the outbox - `evict` never lets go of an unacknowledged change, this does).
- **Situation:** a laptop on a train edits a note; meanwhile it is deleted on the desktop. On the
  laptop the delete is applied as soon as the index arrives: the note is trashed, its unsent change
  never leaves the outbox. Restored from the trash on the desktop, it comes back without the edit. The
  text survives only in the laptop's `backups/` and Obsidian's trash there. CLAUDE.md: "an edit here
  wins over a delete there and revives the note".
- **Reproduction:** `packages/plugin/scripts/audit2/offline-edit-vs-delete.mts`. **Reproduced.**
- **Fix:** a note with anything unsent (`state.isUnsent`, `!socket.isSettled(room)`) counts as changed
  here: revive it; and never drop a handle with an unsent outbox (send first, as `evict` waits).

### M3 - two-factor codes: a burst is checked in full

- **Where:** `packages/server/src/http.ts:335-340` - `codeGuard.blocked()` before
  `await accounts.checkTotp()`, the failure counted after it; `guarded` (`:266-282`) has the same order
  for the address guard; `paced` only delays.
- **Impact:** with the password, a burst of N codes is evaluated whole; a right one in it signs in.
  Bursts of 10,000 once per block period find a code within about a day: 2FA no longer adds much.
- **Reproduction:** `packages/server/scripts/audit2/totp-burst.mts` - 99 wrong codes sent together,
  all 99 checked, none blocked, the right one among them signed in. **Reproduced.**
- **Fix:** count an attempt before checking it (reserve the slot), one code check in flight per
  account; the same for addresses.

### M4 - `replaces: "__proto__"` pollutes the server process

- **Where:** `packages/server/src/accounts.ts:421-422` - `account.deletedVaults?.[replaces]` with a
  client's string; `http.ts:548` passes it unchecked. Fastify's guard looks at keys, not values.
- **Impact:** any account that deleted a vault of its own sets `Object.prototype.replacedBy`. Until the
  server restarts, `restoreRefusal` refuses every deleted vault of every account ("a vault was made
  anew in its place") - the owner's and the admin's restore - and every bundle says it is not
  restorable, so devices offer to make the vault anew; the sweep then clears them after the grace
  period.
- **Reproduction:** `packages/server/scripts/audit2/replaces-proto.mts`. **Reproduced.**
- **Fix:** `isHexId(replaces) && Object.hasOwn(account.deletedVaults, replaces)`; prefer `Map`s or
  null-prototype objects for records keyed by ids.

### M5 - R7 (the backup server's own network) does not hold

- **Where:** only `Restic.run` calls `networkProblem` (`restic.ts:118`); `dumpTo` (`:240`) - used by
  `backupList`/`backupRead`/`backupAt` - spawns restic directly. `hostsOf` (`network.ts:34`) sees no
  host in `s3://10.0.0.5/bucket`, keeps the port in `s3:10.0.0.5:9000/bucket` and then fails open when
  the lookup fails (`:110-114`); `isInternalAddress` misses `::ffff:a9fe:a9fe`, the form `new URL`
  makes of `[::ffff:169.254.169.254]`.
- **Reproduction:** `packages/backup/scripts/audit2/location-checks.mts` (the checks pass all four);
  restic 0.19.1 dials 127.0.0.1 for each form (seen here against a closed local port). **Reproduced.**
- **Fix:** the network check before every start of restic; parse locations as restic does; fail
  closed when a name does not resolve; normalise IPv6 before the check. An egress firewall stays the
  real answer (redirects, Swift's storage URL, DNS rebinding).

### M6 - a malicious sync server still wears the backups away

- **Where:** `packages/backup/src/fetch.ts:144-148` - a `?from=` answer without `from` replaces the
  cached room whole (`fromLog`), without checking that its snapshot reaches the cached last frame (the
  rule devices follow, invariant 19), and without merging; an empty log empties the note. Frames that
  no longer open (a server-named tie or owner, `keys.ts:111-119`) only mark the note incomplete
  (`layout.ts:160-163`); withheld blobs are not counted against the index (`layout.ts:193`).
  `retentionHold` (`run.ts:300-313`) looks at counts and `diverged` only.
- **Impact:** notes emptied or files missing in every new snapshot while retention forgets the good
  ones - what 0.9.13 meant to stop.
- **Status:** reasoned. A check in `backup-selftest`: one good run, then an empty log under a new tag
  with `keep {last: 1}`; `report.retention` must hold.
- **Fix:** a missing `from` is a divergence unless the snapshot covers the last cached frame; merge
  instead of replacing; count emptied, newly unreadable or missing content toward the hold; keys by
  the index's owner and folder, not the server's.

### M7 - the quota does not cover snapshots, starting points, rewrites or unfinished uploads

- **Where:** `packages/server/src/rooms.ts:1829-1842` (`snapshot`), `:1446-1470` (`startSnapshot`:
  "Counted, never refused", a file per `uptoSeq`), join snapshots in `share`/`joinNote`, `rewrite`;
  `blobs.ts:208,361-372` (only finished blobs count; `.upload/` is never cleaned).
- **Impact:** any account fills the server's disk past `MYCEL_QUOTA_MB` (R2 incomplete).
- **Status:** reasoned. **Fix:** check `fits` for every write that stores bytes; count and expire
  unfinished uploads.

### M8 - room metadata without bound

- **Where:** `packages/server/src/rooms.ts:183` (`MAX_EPOCH_JUMP = 1 << 20`), a rotation of a note
  without members needs no keys; a share with history carries a key for every epoch (`:872-878`), up
  to 4 KiB each; every meta stays in memory and `loadAllMeta` reads all of them at every start.
- **Impact:** two accounts of one person (open registration) put tens of MB into one room's meta; a few
  dozen rooms exhaust the heap, and the server then fails at every start until files are removed by
  hand. S7 limited the size of a key, not their number.
- **Status:** reasoned. **Fix:** a small epoch jump (or count epochs), cap keys per member, count meta
  bytes against the quota.

### M9 - the server's folder tie decides how a note is read

- **Where:** `packages/plugin/src/account/KeyRing.ts:526-568` - `noteCrypto.key` and `check` use the
  tie `learn` took from `caughtUp`/`rekey`; `tieAgrees` (P8) guards only writing. `frameVerdict`
  (`shared/src/crypto.ts:646-648`) accepts a folder writer's certificate whenever the tie names that
  folder.
- **Attack (server + a writer of any folder the victim owns):** tie the next epoch of a private note to
  that folder; the writer encrypts under the folder-derived key and signs with their genuine folder
  certificate; every device of the victim applies it to the private note and its file.
- **Status:** reasoned. **Fix:** read under a tie only when the index agrees (`tieAgrees` for `key` and
  `check` too).

### M10 - a removed writer keeps writing under the epoch they had

- **Where:** `packages/plugin/src/sync/VaultSocket.ts:791-832` (`applyFrame`) has no epoch check;
  the certificate check accepts a writer's certificate for the frame's own epoch.
- **Attack (server + a member revoked or demoted to read):** the server appends their frames at the
  old epoch after the room moved on; every remaining device applies them - text into notes, renames
  and deletes "for everyone" in a folder's room.
- **Status:** reasoned. **Fix:** drop a frame whose epoch is below the highest frame epoch already
  applied in the room (snapshots aside; the server never stores such a frame honestly).

### M11 - `Sharing.renewFor` seals to whoever the server lists

- **Where:** `packages/plugin/src/share/Sharing.ts:451-468` - epochs from
  `api.sealedEpochs(room).members[account]`, `recipient()` checks "contact, not replaced", not the
  recorded role (`Folders.renewFor` uses `memberKeys`). Reached when a contact is confirmed again after
  `contact-replaced` - an unsigned server notice (`main.ts:2810-2812`, `Contacts.ts:153-159`).
- **Status:** reasoned. **Fix:** skip rooms without a recorded role for that account; sign
  `contact-replaced` as `contact-removed` is (R9).

### M12 - during *Replace all keys* the server's tie decides a note's new key

- **Where:** `packages/plugin/src/account/KeyReplacement.ts:100-105` - both rings get
  `setFolderOwnership(() => true)` and no `setNoteFolders`, so `tieAgrees` is always true; `seal()`
  encrypts under `crypto.after.key(epoch)`, whose tie comes from the server's `keys` answer.
- **Attack (server + a member of a folder the victim owns):** tie a private note's epochs to that
  folder in the answers to the new ring only; the note is rewritten under a folder-derived key the
  member receives when the folder's keys are sealed anew.
- **Status:** reasoned (medium confidence). **Fix:** give the rings the index's folders (the index is
  rewritten before the notes) and refuse ties it does not confirm.

## Low

- **L1 - a device clock behind by more than the retention purges at once.** `deletedAt` is the
  deleting device's clock (`VaultIndex.markDeleted`); `Trash.purge`/`DocStore.expiredDeleted` on any
  other device purge the room at the next pass, and `Trash.list` never shows it. The text survives in
  the devices' `backups/`. `packages/plugin/scripts/audit2/skewed-clock-purge.mts` (45 days behind,
  retention 30) - **reproduced**. Fix: a tombstone's time no later than the server took it (as
  `changeTime` does for frames), or count retention from when this device first saw the tombstone.
- **L2 - a `null` entry in a folder's document stops its mirror.** `FolderIndex.all()`/`live()`
  (`FolderIndex.ts:144-158`) pass `null`, `Folders.reconcile` (`Folders.ts:554-558`) reads
  `entry.path` and throws - on every pass and device, the owner's too. Likewise a `null` claim in
  `LinkClaims.settle`. Any writer. Reasoned. Fix: skip entries that are not objects.
- **L3 - a reader claims note ids of a folder before they exist.** New notes take ids from
  `deriveDocId(folderKey, relPath, gen)`, which readers can compute; the server lets any account
  create any `doc:` room, and the folder's owner then gets `denied "no access"` for a new
  `Untitled.md` (`rooms.ts:630-651`, `VaultSocket.ts:713`). Reasoned. Fix: a room named by a folder id
  scheme may be created only in that folder, by its writers.
- **L4 - an incoming share overwrites one's own tombstone.** `DocStore.acceptShare`
  (`DocStore.ts:1527-1531`) looks up `pathFor`, which is undefined for a tombstone, and `adopt`
  replaces the entry with the server-named owner (invariant 5: ids never reused). Reasoned. Fix:
  refuse any id the index knows (`entry(docId)`).
- **L5 - *Overwrite the server* (0.9.33), two more edges.** (a) `ownNote` (`Joining.ts:348-352`)
  takes notes this account shared with others: overwriting removes what collaborators wrote, for
  them too (restorable from the history); the window says only that notes *others shared* are merged.
  (b) `serverAsBase` records the base with `state.set`/`setAttachment` (debounced, one second) while
  the join is marked done at once (`setJoin`): a crash in between leaves files without a base, kept
  twice as conflicts. Reasoned.
- **L6 - the joining copy checks no free space.** `BackupStore.copyVault` (`BackupStore.ts:67-96`)
  copies every file of the vault - also for "the same state" - and a failed copy leaves its partial
  folder; trying again makes another. On a full phone Obsidian then cannot save. Reasoned.
- **L7 - "Take the server's version" trashes files too large for the server.** They are in
  `filesHere` and never in the index (`Joining.ts:414-442`), so "only here", and trashed
  (`takeServers`). In the copy of the vault and the trash. Reasoned.
- **L8 - the backup server, smaller.** Room names from the sync server become cache paths unchecked
  (`fetch.ts:69`, `cache.ts:43-45`: `doc_../../x.json`); one invitation pairs two vaults when two
  sessions `connect` at once (`sessions.ts:142,154`); a vault's pairing is replaced on the sync
  server's word about the account (`service.ts:272-295`, and `decryptedFolder` reused); a pax header of
  any size (`tarcheck.ts:95`); idle sessions are never ended and fill the relay's 64; `checkTask`
  starts restic unqueued; `GOOGLE_APPLICATION_CREDENTIALS` still names a file (`config.ts:89`,
  suspected: what restic's Google library does with an external-account file); and `forget
  --group-by host,tags` (`restic.ts:215`) groups every vault of a shared cloud repository together.
  Reasoned.
- **L9 - the server, smaller.** The sweep takes `vaultPurges()` and then works for long while a
  restore succeeds meanwhile (`rooms.ts:2123`, `accounts.ts:476-488`): a vault "restored" whose data is
  gone; `user remove` drops `deletedVaults`, so their ids can be taken again (invariant 35). `subscribe`
  adds the client after an await without checking access again (`rooms.ts:652-678`): a revocation in
  between leaves the member subscribed (ciphertext, presence, sizes). Owner REST routes and
  `RoomHub.access` do not ask `deletedVaults` (invariant 35 says every check asks `vaults`). No limit on
  vaults or connections per account. Reasoned.
- **L10 - paths and floors.** `vaultPathProblem` lets `F/note.md.`, `F/note.md ` (trailing dot or
  space on the last segment), `F/x.png:stream` and `F/CON.png` through as file paths (checked here);
  inside a shared folder (`FolderFiles.reconcileOne`), Windows writes `note.md.` into `note.md`. A
  folder writer can write that note anyway, so the gain is small - suspected, needs a device. Case-only
  and NFC/NFD collisions (`Plan.md` against `plan.md`) are taken as free by every "taken" check; what
  Obsidian's `create` does then on Windows and macOS is not known from here - suspected. And
  `KeyRing.epochFloor` takes sealed-key epochs unchecked (`KeyRing.ts:169-179,765-770`): a server
  naming epoch 2^53 blocks writing in that room for good, even after it is honest again. Reasoned.

## Notes on what was found

- **Where the first audit's fixes stop.** Four findings are P5, P6 and P11 coming back through paths
  added after 0.9.9: *Replace all keys* (H1, M12), `renewFor` (M11), "Share again" (H2), and the
  account's own public keys (C2, which P5's fingerprint rests on). A rule like "only members this
  account recorded" lives in `Sharing.memberKeys`; every place that seals or claims needs to go through
  it, and a test per place.
- **The new code of 0.9.33** (*Overwrite the server*): sound in what it merges and backs up; the trap
  is what the comparison takes for "only on the server" (M1), and who else wrote in an own shared note
  (L5).
- **Not reproduced and left open from `docs/PROGRESS.md`:** `DocStore.evict` letting go of a note an
  editor just bound (its re-check at `DocStore.ts:638` still misses `pinned` and `editorOwned`) - not
  attempted.

## Attacked and found sound

- **The server's interfaces** (review of every route and message): JWT HS-only with issuer, scope and
  session generation checked; `2fa` and `backup` tokens accepted only where meant; owner, member and
  folder-owner checks on every REST route and WebSocket message; `idx`/`set` rooms only on their own
  vault's socket; no path traversal through any id (room subjects, vault, account, blob and fork ids are
  checked as hex); invariants 16, 17, 19, 21 and 33 on the server side; S9 holds for deleted vault ids;
  `accounts.lock` and the takeover lock against the CLI; contacts' constant-time redemption and caps.
  `test:security` of the server passes.
- **Ciphertext binding:** frames, snapshots and presence bound to room and epoch; distinct HKDF labels
  for every key; sealed keys bound to room, epoch, recipient and the box; blob chunks bound to blob,
  index and count, downloads checked against their hash. The server cannot move ciphertext between
  rooms, epochs or kinds. Replaying an old signed frame is idempotent.
- **Signatures:** readers' frames dropped; snapshots only from the owner; index and settings only the
  account's; certificates bound to room or folder, epoch, account and key; presence signed, its client
  ids held by their first signer, names and colours sanitised; titles signed (R5); `contact-removed`
  signed (R9). A garbage frame does not stall a room (checked in H4's script).
- **The gate** (`guard.ts`): every vault, adapter and file-manager method checked; no bypass found.
  CSS built from paths is quoted.
- **The backup relay's sessions:** ECDH with a pre-shared key the relay never sees, transcript-bound
  proofs, a key per direction, counters in the associated data; replay, reordering, reflection and a
  relay in the middle all fail. A pairing reaches its own vault only; reads only from the vault's own
  destinations. The decrypted copy's `inside`, `safePath`, manifest and guard hold; R6's signature
  checks hold.
- **Data paths:** the Reconciler's rules (no base: union; conflicts: both kept), backups before every
  overwrite in `applyOutcome`, the Time Machine's journal and copies (a file written by someone else
  over a past file is kept aside before it is put back), the Time Machine blocking `startSync` and
  *Disconnect*, invariant 36's claims (last writer wins, the other window stops on the `storage`
  event), the attachment store's conflicts and `stillHolds`, *Overwrite the server* resuming after a
  stop (it compares again and is idempotent).
- **Refuted:** a backup location with an unknown scheme (`xx:/../../x`) - restic 0.19.1 answers
  "invalid backend" and writes nothing.
