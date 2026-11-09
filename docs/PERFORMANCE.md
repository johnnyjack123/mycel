# Performance (0.9.10)

Measured on 2026-11-09 with `npm run bench` (`packages/plugin/scripts/bench.mts`) on a
synthetic vault of **5,000 notes and 2,000 files** (133 MB), and of 1,000 notes and 400
files (23 MB) to see what grows. The benchmark measures and reports; nothing in
`packages/*/src` was changed for it. Every figure below is **measured** unless it says
*inferred* or *estimated*.

**Machine:** Snapdragon X Elite X1E80100 (12 Oryon cores, arm64), 15.6 GB, Windows 11
(10.0.26300), UFS SSD; Node 24.16.0 (V8 13.6), tsx 4.23, Yjs 13.6.32, y-indexeddb 9.0.12.

## The short version

0. **First, a bug the benchmark ran into: a change can leave the outbox without ever being
   sent.** *(Fixed in 0.9.11: one push per room is made at a time, and an acknowledgement
   clears only the payload it acknowledges - `docs/CHANGELOG.md`. The rest of this page is
   0.9.10 as measured.)* Two `sendNext` calls of one room can overlap. The stale one sends a payload the
   server already acknowledged, and its acknowledgement then clears the newer payload, unsent.
   In a 5,000-note upload run with the self-tests' slower IndexedDB stand-in, this happened
   110 times (128 KB of vault-index changes). In two earlier attempts of the same setup, the
   other device's index stopped at 2,954 and at 3,351 of 5,000 notes, with no error anywhere.
   It needs a busy
   main thread or crypto pool, which is a phone during a first sync. Details under "Things that
   looked wrong".
1. **Unsent edits cost more with every edit.** Offline, each keystroke merges the whole
   outbox again (`Y.mergeUpdates`) and writes it whole as base64 JSON. The synchronous cost of a
   keystroke grows by about 0.75 ms per 1,000 keystrokes not yet sent: 0.37 ms at the start,
   7.4 ms after 10,000, 15.4 ms after 20,000. 20,000 keystrokes took 176 s of CPU.
   The hypothesis holds.
2. **A restart opens every note.** The start's scan reconciles every file, which loads every
   document, subscribes every room, has the server send each note's last frame again
   (28.8 MB at 5,000 notes) and rewrites every base text (28.8 MB). Then it lets 4,500 of
   them go again. That is about 3 s here; in Obsidian it also means 5,000 IndexedDB databases
   opened.
3. **Bookkeeping that is O(notes) per operation, so O(notes²) per sync.** `DocStore.evict`
   filters and sorts every loaded note each time one opens (40 % of a restart's main-thread
   time). `VaultIndex` rebuilds its path map from scratch on every index change.
   `AttachmentIndex` sorts every id on every change. `baseFor` scans every tombstone for every
   note that has no base. Together they are 5.6 s of the first upload's 19.8 s on the main
   thread.
4. **Files written to the plugin folder.** A note pulled on the first sync gets its base text
   written three times (84.6 MB for 29 MB of notes). Every restart rewrites all of them.
   While typing, every Obsidian save rewrites `state.json` and `attachments.json` whole:
   about 0.85 MB every 2 s at this size, to store a modification time nothing reads.
5. **Per frame, the signature is the floor.** One ECDSA verification (0.37 ms here) per
   frame received and one signature (0.42 ms) per frame sent. A week of another device's
   20,000 frames was caught up in 5.4-6.6 s here and never blocked the event loop for more than
   52 ms. It is also the first thing a phone will feel.

## Results

### Per scenario

Two full runs without a profiler, **run 1 / run 2**. Run 2 ran on a quiet machine and
came out 10-20 % faster throughout, with the same shape. *loop max* is the longest the event
loop was blocked, after the sign-in (Argon2id blocks the main thread for ~200 ms by design and
is reported apart). The devices' own processes start at 119 MB RSS and 60 MB heap before a
device exists (Node, jsdom, CodeMirror, the plugin's modules).

**5,000 notes, 2,000 files**

| scenario | wall | device CPU | server CPU | loop max | RSS peak / after | heap after | traffic |
|---|---|---|---|---|---|---|---|
| upload (A, first device) | 37.2 / 33.8 s | 29.6 / 27.5 s | 35.8 / 31.7 s | 62 / 38 ms | 939 / 741 MB | 147 MB | 5,602 pushes 29.7 MB; 4,012 HTTP, 110 MB of blobs up |
| join (B, new device) | 10.0 / 8.2 s | 15.6 / 13.1 s | 4.6 / 4.1 s | 33 / 30 ms | 608 / 537 MB | 123 MB | 5,602 frames 29.7 MB in; 4,011 HTTP, 110 MB down |
| restart (B), 3 + 3 | 3.2-3.3 / 2.9-3.0 s | 2.6-2.7 / 2.3-2.4 s | 0.6-1.1 s | 21-26 ms | 598-636 / 589-611 MB | 121-123 MB | 5,001 frames **28.8 MB** in; 5,002 subscribes |
| catch-up after a week | 6.6 / 5.4 s | 12.4 / 11.8 s | 1.3 / 1.2 s | 43 / 44 ms | 574 / 571 MB | 168 MB | 25,001 frames 33.9 MB in |
| idle, 60 s | - | 0.6 / 0.6 s | 0.0 s | 24 / 25 ms | 561 / 559 MB | 168 MB | nothing |

**1,000 notes, 400 files**

| scenario | wall | device CPU | server CPU | loop max | RSS peak / after | heap after |
|---|---|---|---|---|---|---|
| upload | 8.1 / 7.7 s | 6.9 / 6.0 s | 6.5 / 6.6 s | 23 / 26 ms | 353 / 335 MB | 80 MB |
| join | 3.3 / 3.0 s | 3.3 / 3.1 s | 0.9 / 0.8 s | 22 / 20 ms | 304 / 295 MB | 75 MB |
| restart, 3 + 3 | 0.9-1.0 s | 0.4-0.6 s | 0.1-0.3 s | 20-25 ms | 324-342 MB | 78-80 MB |
| catch-up after a week | 3.4 / 3.3 s | 10.0 / 10.4 s | 0.5 / 0.3 s | 17 / 18 ms | 360 / 347 MB | 107 MB |
| idle, 60 s | - | 0.7 / 0.3 s | 0.2 / 0.1 s | 24 ms | 350 / 225 MB | 107 MB |

From 1,000 to 5,000 notes (×5): upload ×4.4-4.6, join ×2.7-3.0, restart ×3.2. The catch-up
has the same 20,000 frames at both sizes and still grows (×1.6-1.9), because it starts with
a restart. The quadratic parts (item 3) are still a minority at 5,000 notes; at 20,000 they
would dominate (*inferred*: they grow ×16 where the rest grows ×4).

Two more runs of upload, join and restart at 5,000 notes, one counting cursor writes and one
with a profiler, gave 37.9 / 9.5 / 3.2 s and 38.9 / 9.3 / 3.3 s. Every join and catch-up that
completed matched A byte for byte.

### 1. First sync of a new device

B signs in (1.2 s: Argon2id ~0.2 s, the server's fixed one-second pace for every sign-in),
has the vault index at 1.8-2.0 s, and has every note and file at 7.7-9.5 s. The content is
checked against A by a hash over every path and byte: identical in every run. It opened
all 5,000 notes and kept the last 500. Per note it read the file twice and wrote the base
text three times.

**Where the CPU went** (profiled run, 14.7 s device CPU):

- **Main thread, 6.3 s**: plugin logic 1.7 s (of which `evict` 0.8 s), WebCrypto's JS glue
  in Node 0.9 s, Yjs 0.4 s, GC 0.4 s, WebSocket/HTTP 0.4 s, log output 0.2 s, Node and
  native rest 2.3 s.
- **Other threads, 8.4 s**: WebCrypto runs on libuv's pool. *Estimated* from the operation
  counts × the micro-benchmarks: 5,602 ECDSA verifications ≈ 2.1 s, 7,607 AES-GCM
  decryptions (frames and 110 MB of blob chunks) ≈ 1.1 s, 15,205 SHA-256 ≈ 0.7 s,
  18,014 key imports and 7,007 HKDF derivations ≈ 0.6-1 s, together ≈ 5 s. The rest is
  V8's GC and compiler threads and I/O.
- **Server, 5.1 s**: 1.8 s on its main thread (file reads, the socket), the rest its own
  file I/O threads.
- **Storage** (the IndexedDB stand-in): 0.08 s, but see "What these figures cannot say":
  the real one is not modelled.

### 2. Warm restart

2.9-3.3 s at 5,000 notes, 0.9-1.0 s at 1,000; 2.3-2.7 s of device CPU, 2.2 s of it on the
main thread (profiled). Every restart:

- opened **all 5,000** notes (`locals.opened` counted 5,000) and subscribed every room;
- got **5,001 frames, 28.8 MB**: the frame each cursor ends at, sent again so the log can
  be recognised (invariant 19, `VaultSocket.subscribe`, VaultSocket.ts:446). For a note
  never edited since it was seeded, that frame is the whole note;
- read every note's file (5,000 reads, 29 MB) and **wrote every base text again** (5,003
  plugin-folder writes, 28.8 MB);
- sent 4,500 unsubscribes and the watch messages for what it let go again.

On the main thread, **`DocStore.evict` took 0.92 s of 2.2 s**: `isSettled` and `isHeld` for
every loaded note, then a sort, on every `handleFor` once 500 are loaded. RSS stays at
about 600 MB, of which the stand-ins hold 220 MB (vault files 133 MB, local store 30 MB,
history 28 MB, plugin folder 29 MB) that Obsidian keeps on disk.

### 3. Memory per note held open

Measured by letting go of all but one note, then opening 100 and 500 of them, with three GCs
before each reading. The divisor is the number of notes opened.

| | per note | the note |
|---|---|---|
| short history (seeded once, 1 Yjs struct), 500 notes | **19.5 KB heap** (both runs) | 7,480 chars, state 7.5 KB |
| first 100 of those | 20.5 KB heap | |
| long history (1,000 scattered edits, 1,545 structs), 100 notes | **490 KB heap** (489.5 / 490.5) | 2,765 chars, state 24 KB |

RSS per note is noise at this scale (-16 to +32 KB between runs; the allocator keeps what
it has), so the heap is the figure to go by.

A Yjs struct costs about 300 bytes of heap: the `Item`, its `ID`s and its content. The
limit `maxLoadedDocuments` (500) counts notes, not bytes. 500 short notes are ~10 MB, but
500 heavily edited ones would be ~245 MB (*inferred* from the per-note figure). Every
`DocHandle` is a new `Y.Doc` with a new random client id (DocHandle.ts:139), so every
session that types into a note adds a client to its state vector, and its typing never
merges with the previous session's structs.

### 4. Typing

Online: one keystroke every 62.5 ms (60 ms asked; Windows timers tick every ~15.6 ms),
in the middle of the note, until the server acknowledged everything.

| | keystrokes | sync time per keystroke, mean / p99 / max (run 1; run 2) | CPU per keystroke | frames |
|---|---|---|---|---|
| direct, 5 KB note | 2,000 | **0.20 / 0.39 / 0.69 ms; 0.15 / 0.30 / 0.45 ms** | 2.05; 1.59 ms | 2,000 (1 per keystroke) |
| editor, 5 KB note | 2,000 | 0.64 / 1.13 / 6.35 ms; 0.50 / 0.85 / 4.25 ms | 4.64; 3.87 ms | 2,000 |
| editor, 100 KB note | 1,000 | 0.79 / 1.15 / 2.91 ms; 0.65 / 0.99 / 2.27 ms | 4.17; 4.97 ms | 1,000 |

- *direct* is the sync layer's share (Y.Text, the outbox, the cursor, the local store, the
  store's observer). *editor* adds CodeMirror and jsdom's DOM; jsdom is half of that profile
  and says nothing about Chromium.
- **Every keystroke became its own frame.** `SEND_DELAY_MS` (VaultSocket.ts:23) is 40 ms,
  shorter than the time between keystrokes. So every keystroke is signed, encrypted, sent,
  written with an fsync on the server and acknowledged.
- CPU per keystroke, direct: 1.6-2.05 ms in all. The process uses ~10 ms/s with nothing
  happening, partly the benchmark's own sampling. Subtracting that leaves **~1.0-1.4 ms per
  keystroke**: ~0.3 ms on the main thread (profiled), ~0.5 ms WebCrypto per frame (sign
  0.42, encrypt, two SHA-256; *estimated* from the micro-benchmarks), and the rest V8's
  background threads (not attributable from here). The server spent ~1.2 ms per frame.
- **Every Obsidian save rewrites the plugin's state files.** Typing in the editor made 244
  plugin-folder writes of 52.6 MB in 125 s. Each save (every 2 s) reconciles the note,
  `recordAgreement` sets its mtime and size in `StateStore`, and `StateStore.flush` rewrites
  `state.json`, `attachments.json` and `cleared.json` whole (~0.85 MB at 5,000 notes and 2,000
  files). For notes, those mtimes and sizes are never read (`state.get` is used for `path`
  only: DocStore.ts:811, 1160, 1269, 1283, 1330, 1357, 1514).

**Offline**: the socket closed, keystrokes back to back. Synchronous cost per keystroke
by how many were typed before it (direct path; the editor path is the same plus ~0.15 ms):

| keystrokes unsent | 1,000 | 2,000 | 5,000 | 10,000 | 15,000 | 20,000 |
|---|---|---|---|---|---|---|
| sync time per keystroke, run 1 | 0.37 ms | 1.1 ms | 3.5 ms | 7.5 ms | 11.4 ms | 15.4 ms |
| sync time per keystroke, run 2 | 0.33 ms | 1.0 ms | 3.2 ms | 6.8 ms | 10.6 ms | 14.4 ms |
| CPU per keystroke, run 1 | 0.48 ms | 1.2 ms | 3.7 ms | 8.8 ms | 13.4 ms | 19.5 ms |
| outbox | 17 KB | 34 KB | 85 KB | 170 KB | 255 KB | 343 KB |

- 2,000 keystrokes took 1.4-1.5 s, 10,000 took 36-42 s, 20,000 took **161-176 s**. The
  cursor JSON written on *every* keystroke was 458 KB at the end. Going online sent it all as
  one frame in 0.13 s.
- **The hypothesis is confirmed.** `VaultSocket`'s `onDocUpdate` (VaultSocket.ts:1137-1144)
  runs `Y.mergeUpdates([outbox, update])` and `cursor.persist(true)` on every update.
  `LocalCursor.flush` (DocHandle.ts:106) then base64-encodes `sending` and `outbox` into JSON.
  In the profile, `toBase64` is 49.5 % of the main thread and Yjs's merge (lazy struct
  reader and writer, varints, UTF-8) is 24 %.
- `Y.mergeUpdates` does not merge adjacent structs, so the outbox grows by ~17 bytes per
  keystroke. Encoding the same document's state stays at 50-70 µs (micro-benchmark:
  `mergeUpdatesOutbox_20000` 6.1 ms and `cursorJson_20000` 10.8 ms, against
  `encodeStateOfThatDoc_20000` 0.07 ms).

### 5. Catch-up after a week away

B stopped; A made 20,000 frames: 40 rounds of one insertion in each of 500 notes, each
acknowledged before the next round. That took 18 s. Then B started.

- 5,000 notes: **5.4-6.6 s** (5.7 s profiled), 11.8-12.4 s CPU. 1,000 notes: 3.3-3.4 s,
  10.0-10.4 s CPU. A restart without changes takes ~3 s and 1.0 s, so the 20,000 frames
  themselves cost ~2.4-3.3 s here.
- **The event loop was never blocked for long**: 43 ms at most at 5,000 notes, 17 ms at
  1,000. Frames are applied per room in a promise chain with awaited crypto, so the work
  is cut into small pieces.
- CPU: 7.9 s of 12.2 s ran off the main thread. 20,000 ECDSA verifications ≈ 7.4 s at
  0.37 ms each (*estimated*), so **signature checks are about 60 % of the catch-up's
  CPU**. The main thread's 4.2 s: `evict` 0.94 s, Yjs 0.48 s, WebCrypto glue 0.73 s.
- Per frame received: AES-GCM decrypt, two SHA-256 (the bytes and what the frame says,
  VaultSocket.ts:752 and 768), one ECDSA verify, `Y.applyUpdate`, a history entry and a
  debounced cursor write. Sequentially that is 384 µs of crypto per frame; with eight at once,
  105 µs per verification.
- Every note changed elsewhere went through `adopt-remote` and got a backup of the text
  it replaced, even though that text equalled its base. That is 500 backups (DocStore.ts:1002).

### 6. Idle

60 s with the attachment rescan, the shared files' pass and the cloud's `noteState` every
second, the per-minute passes 60× more often than in Obsidian: **0.6 s of CPU per minute**.
That includes the benchmark's own timers (the event-loop histogram ticks every 10 ms, memory
is sampled every 50 ms). The plugin's part:

- one attachment scan costs 1.5-2.2 ms at 2,000 files (0.5-0.7 ms at 400). At Obsidian's
  interval of 60 s that is ~2 ms per minute;
- no WebSocket message and no HTTP request in either direction. The server pings every
  30 s at the protocol level, which these counters do not see.

### 7. The first upload, which dominated

The first device sending a 5,000-note vault: 33.8-37.2 s, 27.5-29.6 s device CPU,
**31.7-35.8 s server CPU** (only 5.9 s of it on the server's main thread; the rest is its
file I/O threads).

- **The server writes three files with an fsync per new note**: `meta.json` when the room
  is created, the first frame, and `meta.json` again to record `oldestFrameTs`
  (log.ts:370). The blobs come on top. Here that is 7 ms of server CPU per note; on an SD
  card it is fsync latency (*inferred*).
- Device main thread, 19.8 s (profiled run): `VaultIndex` rebuilding its path map on every change 2.8 s,
  `evict` 1.3 s, `AttachmentIndex.rebuild` 1.0 s, `toBase64` in `LocalCursor.flush`
  0.96 s, `VaultIndex.deleted` from `baseFor` 0.55 s, GC 1.2 s.
- **6.8 GB allocated on the heap for a 133 MB vault** (`--heap-profile`, collected objects
  included). About 3 GB of it is `toBase64` in `LocalCursor.flush`, encoding 39 MB of
  unsent changes in 21,500 cursor writes: spreading 32 K bytes into `String.fromCharCode`
  allocates ~75 bytes per byte. About 1 GB is `VaultIndex`'s path map refilled on every
  change. The heap peaked at 538 MB used (147 MB after GC), and RSS at 939 MB.

### Micro-benchmarks (µs per operation, sequential unless said)

| operation | µs | | operation | µs |
|---|---|---|---|---|
| AES-GCM encrypt 200 B | 37 | | Yjs apply a 5 KB seed | 62 |
| AES-GCM decrypt 200 B | 32 (18 with 8 at once) | | Yjs encode state, 5 KB | 26 |
| AES-GCM decrypt 100 KB | 810 | | Yjs encode state, 100 KB | 407 |
| SHA-256 1 KB / 100 KB | 23 / 270 | | Yjs encode state, 5 KB after 2,000 edits | 471 |
| ECDSA P-256 sign a frame | 421 | | merge outbox of 1k / 10k / 20k keystrokes + 1 | 438 / 2,952 / 6,117 |
| ECDSA P-256 verify a frame | 369 (106 with 8 at once) | | cursor JSON of that outbox | 420 / 4,603 / 10,785 |
| receive path: 2 SHA-256 + decrypt + verify | 384 | | Argon2id, the sign-in | 195 ms |
| HMAC, a note's id | 43 | | | |

### The IndexedDB stand-in, compared

The same scenarios with the self-tests' `MemoryLocalStores` (`--store harness`), 5,000 notes,
three attempts:

| | y-indexeddb model (default) | self-tests' stand-in |
|---|---|---|
| upload, wall | 33.8-39.2 s | 53.2 / 56.9 / 53.8 s |
| upload, device CPU | 27.5-33.9 s | 63.6 / 70.0 / 64.8 s |
| join | 8.2-10.0 s, identical to A every time | **never completed**: twice B's index stopped short (changes lost by the race under "Things that looked wrong"); the third time the race was counted during the upload, and B's index then took longer than the 4 s `syncTimeoutMs` |
| per keystroke, added by the stand-in | - | `encodeStateAsUpdate` of the whole note: 26 µs at 5 KB, 407 µs at 100 KB, 471 µs for a 5 KB note after 2,000 edits (micro-benchmarks) |

That stand-in encodes the whole document on every update. For the vault index (thousands of
entries, changed once per note) and for every keystroke in a large note, that is a cost
y-indexeddb does not have. **Do not read the self-tests' timings as the plugin's.**

## Hotspots, ranked

Ranked by what a user would feel, with the phone in mind. *Expected gain* is inferred from
the measurements, not measured.

| # | where | measured | on a phone | idea | expected gain |
|---|---|---|---|---|---|
| 1 | `VaultSocket` `onDocUpdate` (VaultSocket.ts:1141-1142) + `LocalCursor.flush` (DocHandle.ts:106) + `toBase64` (shared crypto.ts:67) | +0.75 ms per keystroke per 1,000 unsent; 15.4 ms at 20,000; 458 KB written per keystroke | Phones are offline most and 3-10× slower: past a few thousand unsent keystrokes typing lags visibly (*inferred*: ~10 ms per keystroke at ~3,000 unsent if 4× slower) | Do not keep the outbox as merged bytes. Derive it at send time: `Y.encodeStateAsUpdate(doc, stateVectorTheServerHas)`, where that vector is what was acknowledged plus what arrived. Persist only that vector; y-indexeddb already stores every update at once, so invariant 15 holds by construction. Failing that, keep updates in a list and store bytes, not base64 JSON | Flat ~0.35 ms per keystroke whatever is unsent (the measured first-1,000 level): 20× at 10,000, 40× at 20,000; cursor writes ~100 B instead of up to 458 KB |
| 2 | `DocStore.start` → `scanVault` → `syncFile` → `reconcileFile` → `handleFor` for every note (DocStore.ts:1847, 888) | every restart opens 5,000 notes, 5,000 subscribes, 28.8 MB down, 5,000 reads, 28.8 MB written; 3.3 s | Obsidian on a phone restarts whenever the OS killed it. Each start pays this, plus 5,000 IndexedDB opens (not measured, likely the largest part) | Open at start only notes whose file changed since its recorded stat (`StateStore` already keeps mtime/size per note and never reads them) or whose log moved. Watch the rest with their known seq, as eviction does. Keep each note's `lastSeq` in the state so no database needs opening to know it | Restart work O(changed) instead of O(notes): ~0 opens, ~190 KB of watch messages instead of 28.8 MB down, 0 MB written. Invariant 19's check then happens when a note is next opened, as it already does for evicted notes |
| 3 | `subscribe` asks for the cursor's last frame again (VaultSocket.ts:446) | 28.8 MB per restart at 5,000 notes (the whole text of every note not edited since its seed) | Mobile data, mobile radio time | Send the frame's hash; let the server answer "same" or the frame. Bytes are needed only where they differ (keys replaced) | −28.8 MB per restart and per reconnect of the notes held open |
| 4 | O(n) per operation: `DocStore.evict` (DocStore.ts:595-628), `VaultIndex` observer → `rebuild` (VaultIndex.ts:79, 99), `AttachmentIndex.rebuild` with a sort (AttachmentIndex.ts:67, 79), `baseFor` scanning `deleted()` (DocStore.ts:807) | evict 0.9 s of a restart's 2.2 s main thread and of a catch-up's 4.2 s; on the upload 1.3 + 2.8 + 1.0 + 0.55 s = 5.6 s of 19.8 s, ~1 GB of allocation | Quadratic: a 20,000-note vault pays 16× (*inferred*), on a slower CPU | evict: LRU order in a `Map` (re-insert on touch), take the oldest eligible, stop at the limit. Index maps: update from the event's `keysChanged`. `baseFor`: a `forkedTo → docId` map kept with the index | −40 % of restart main-thread time; −5.6 s on the 5,000-note upload, growing with the square of the vault |
| 5 | `recordAgreement` (DocStore.ts:789) writes the base text every time, and `StateStore.flush` (StateStore.ts:163) rewrites three JSON files whole | join: 15,003 writes / 84.6 MB for 29 MB of notes; restart 5,003 / 28.8 MB; typing ~0.85 MB every 2 s | Real file writes through Capacitor's bridge, flash wear, battery | Skip the base write when the base already holds that text (a fingerprint per note). Do not store mtime/size for notes, or do not mark the state dirty when only they changed. Write only the files that changed | join −56 MB, restart −28.8 MB, typing from ~0.4 MB/s to the ~6 KB base text per save |
| 6 | A frame per keystroke, each signed (`SEND_DELAY_MS` 40, VaultSocket.ts:23) | 2,000 frames for 2,000 keystrokes; ~1.4 ms CPU per keystroke on the device, ~1.2 ms on the server, an fsync each | ECDSA in a WebView is slower; a Pi syncs every frame to its SD card | A longer delay while keystrokes keep coming (e.g. 200-300 ms; presence travels apart and stays live) | ~3-5× fewer frames, signatures and server fsyncs at typing speed; collaborators see text 0.2 s later |
| 7 | Receive path per frame (VaultSocket.ts:752-796) | 384 µs of crypto per frame; signature checks ≈ 60 % of the catch-up's CPU | The catch-up's bulk on a phone (*inferred*: 20,000 frames ≈ 20-40 s of CPU) | Only the frame the cursor ends at needs its two fingerprints. Compute them for the last frame of a catch-up only. The signature stays | −2 of 5 crypto operations per frame (~15 % of crypto time) |
| 8 | Notes held open counted, not weighed (`maxLoadedDocuments`, DocStore.ts:596) | 19.5 KB per short note, 490 KB per long-history note | WebView memory is tight; 500 long notes ≈ 245 MB (*inferred*) | Weigh by struct count or state size; a lower limit on mobile | Memory bounded by size, not by luck |
| 9 | Server: three fsync'd writes per new note (log.ts:370) | 35.8 s server CPU for the 5,000-note upload, mostly file I/O threads | On the Pi's SD card, fsync latency × 3 × 5,000 (*inferred*) | Write `oldestFrameTs` with the first `meta.json` | −1 of 3 fsyncs per new note on the first upload |

Smaller things seen in the profiles: every `new Y.Doc()` draws its client id from
`crypto.getRandomValues` (0.2 s per 5,000 opens in Node). The plugin's log lines are
written synchronously here (0.1-0.6 s per scenario); Obsidian buffers them.

## Things that looked wrong

- **A change can be dropped from the outbox unsent** (`VaultSocket.sendNext`,
  VaultSocket.ts:955-1006, with the `ack` handler at 573-594). **Measured, then explained by
  reading.**
  - *Why two run at once:* `scheduleSend` (line 945) guards only on `inflight` and
    `sendTimer`. While a `sendNext` awaits the key, the signature, the encryption and two
    fingerprints, both are null, so the next local change starts a second `sendNext` 40 ms
    later. Both take `payload = cursor.sending` (line 970).
  - *How the newer payload is lost:* the first sends P1, which is acknowledged, and the
    acknowledgement sets `cursor.sending = null` (line 583). A third `sendNext` moves the
    outbox P2 into `cursor.sending` and starts awaiting. If the second, stale one finishes
    its awaits first, the check at line 993 (`inflight !== null`) lets it through: it pushes
    P1 again and takes the in-flight slot, and the third returns at the same check. The
    duplicate's acknowledgement then clears `cursor.sending`, which holds P2. P2 is never sent.
  - *What the benchmark saw:* with the self-tests' IndexedDB stand-in, which keeps the main
    thread busy, there were three attempts at 5,000 notes.
    - The first two had no detector yet. Device B's index stopped at 3,351 and at 2,954 notes
      of 5,000, with no file at all. In the second its Yjs document waited for A's client from
      clock 2,985 on (`pendingStructs.missing`). The server's log of the first held every
      frame A pushed (752, seq 1-752, no gap), so the server lost nothing: the missing changes
      were never pushed. No error was logged on either device.
    - The third counted, during A's upload, 128 overlapping `sendNext` and **110
      acknowledgements that cleared a payload never pushed: 128 KB of vault-index changes**.
    - With the y-indexeddb model on a quiet machine (run 2), the overlap happened once, in
      the 5,000-note upload. The acknowledgement cleared another payload, but `cursor.sending`
      was empty at that moment, so it was a needless duplicate push with nothing lost, and the
      acknowledged index rebuilt A's. Every other scenario of run 2 counted none. So the
      overlap happens on a fast desktop too; it loses data when a newer payload is waiting.
  - *Consequences:* the device keeps the change, but the server never gets it. Every other
    device holds that client's later changes to that room as pending, for good: nothing sends
    the range again, short of `keepLocal` after a server that lost data. Changes of later
    sessions that build on a pending item wait too (*inferred* from how Yjs integrates). For
    the vault index that means notes and files missing on every other device; for a note,
    text. It breaks the guarantee of invariant 15 from the other end.
  - *When:* whenever `sendNext`'s awaits take longer than `SEND_DELAY_MS` plus the
    acknowledgement's round trip: a slow or busy main thread, or a saturated crypto pool. That
    is a phone during a first sync or a catch-up (*inferred*).
  - *Fix:* one `sendNext` per room at a time (a flag `scheduleSend` and `sendNext` both
    respect), or after the awaits `if (cursor.sending !== payload) return`. And in the `ack`
    handler, clear `cursor.sending` only when it is the payload acknowledged.

  The benchmark checks for it from now on: every scenario counts overlapping `sendNext`
  and acknowledgements that clear another payload, and after the upload the index changes the
  server acknowledged must rebuild A's index.
- **`DocStore.evict` can let go of a note an editor just took** (DocStore.ts:614-620). The
  candidate filter (lines 600-610) leaves out notes that are pinned, editor-owned, in flight
  or closing. The re-check in the loop (line 618) tests only `isSettled`, `isHeld`,
  `writeTimers` and `locks`, and every `await this.dropHandle(...)` yields in between.
  `evict` also runs concurrently, once per `handleFor` completion, with no guard. So:
  - a note `EditorSync.acquire` pins and claims (`pin`, `setEditorOwned`) after the
    candidates were taken is destroyed under the editor. `isStale()` sees it only at the
    next `refresh()`; until then keystrokes go into a destroyed `Y.Doc` and are not sent,
    and `dropHandle` drops the note's held texts (invariant 25).
  - a note dropped by a concurrent `evict` and opened again by `handleFor` meanwhile gets its
    new handle destroyed in the middle of `open()`. A caller outside a lock (`handle()`, or
    the loser in `mergeDuplicates`) then waits `syncTimeoutMs` on a room never registered.

  The fix is to repeat the full filter in the loop. Not reproduced in the benchmark, which
  binds no editor while evicting; found by reading.
- **`StateStore` keeps mtime and size per note that nothing reads.** Not a correctness bug,
  but it is what makes every editor save rewrite the state files (hotspot 5).
- **`AttachmentIndex.rebuild` sorts every id, deleted ones too, on every change of the map,
  remote ones included.** Correct, but O(n log n) per change (hotspot 4).
- **A slow vault index reads as a dead server.** With the slower stand-in, B's 752 index
  frames took longer than `syncTimeoutMs`, and `DocStore.start` returned false.
  `main.ts:1411-1423` then starts once the index arrives, which is right, but first shows
  "no answer from <server>. Nothing is synced until it responds." Here the index took
  ~0.7 s; a phone several times slower with a larger vault can pass the 5 s (*inferred*).
  The notice should say the index is still arriving.

## How it is measured

`npm run bench` (`packages/plugin/scripts/bench.mts`). The orchestrator starts three
processes per size, with the same `tsx` loader and `--expose-gc`:

- **the server**: `startServer` from `packages/server/src/server.ts` with `HOST=127.0.0.1`
  and `PORT=0` (the OS picks a free port), registration open, and a new data folder under
  the OS temp dir, removed afterwards (`--keep` keeps it). Never 1234, never
  `packages/server/data`.
- **device A** and **device B**: one `Device` of `scripts/harness.mts` each. That is the
  real accounts, keys, `DocStore`, `VaultSocket`, `AttachmentStore` and editor binding,
  wired as `main.ts` wires them, over `scripts/stubs/fake-vault.ts`. Both use one account:
  A registers, B signs in. Each runs in its own process, so what B costs is not mixed with
  what A costs.

**The synthetic vault** (deterministic, `planVault`):

- Notes: 60 % 1-3 KB, 30 % 3-10 KB, 9 % 10-30 KB, 1 % 80-120 KB. Markdown with headings,
  lists, `[[links]]` and `![[embeds]]`, in 20 × 100 folders.
- Files: 50 % png, 30 % jpg, 15 % pdf, 5 % canvas. 70 % 4-16 KB, 25 % 32-128 KB,
  4.6 % 0.25-1 MB, 0.4 % 2-4 MB. Random bytes, except a canvas, which is JSON.

**What each number is**

- *wall*: from the start of the scenario until its condition held **and** half a second
  passed without a message from the server (`settle`); that half second is not counted.
  - The condition always includes "settled": every room's outbox acknowledged, and no
    catch-up, write, lock or transfer running in `DocStore` or `AttachmentStore`, and no
    index pass pending. Then each scenario's own: every note and file in B's vault, every
    expected text.
  - A join is checked against A afterwards by a SHA-256 over every path and content, and a
    catch-up by the hash of every note A edited. Both matched in every run that completed.
- *cpu*: `process.cpuUsage()` of the device's process, which counts every thread: the main
  thread, libuv's pool where WebCrypto runs, and V8's GC and compiler threads. *Server CPU*
  is the same for the server's process over the same scenario.
- *loop max*: `perf_hooks.monitorEventLoopDelay` (10 ms resolution), the longest the event
  loop was blocked. It is reset when the sign-in finished, because Argon2id (hash-wasm,
  64 MiB, 4 passes) blocks the main thread by design; that is reported apart. **On Windows
  timers tick every ~15.6 ms**, so anything up to ~20 ms is the clock, not the code.
- *memory*: `process.memoryUsage()` after `gc()` three times with a `setImmediate` in
  between (`--expose-gc`). *Peak* is sampled every 50 ms during the scenario. Every
  snapshot also counts what the stand-ins hold in the same heap, which in Obsidian is on
  disk: `vaultFilesMB` (the fake vault's files), `localStoreMB` (the IndexedDB stand-in),
  `historyMB` (the device's history) and `pluginFolderMB` (state, base texts, backups).
- *counters*: measuring hooks of the benchmark only; nothing in `packages/*/src` was changed.
  - WebCrypto calls by method and algorithm, by wrapping `SubtleCrypto`.
  - Every socket message by type and size, by wrapping `WebSocket.send` and
    `VaultSocket.receive`; HTTP requests, by wrapping `fetch`.
  - Vault reads and writes and plugin-folder writes, by wrapping the fake vault and its
    adapter.
  - Bytes serialized per cursor write, by wrapping `LocalCursor.prototype.flush`.
  - Overlapping `sendNext` and acknowledgements that clear another payload (see "Things
    that looked wrong").
- *profiles*: the V8 sampling profiler through `node:inspector`, in the process itself (no
  port).
  - `--profile`: CPU at a 250 µs interval, summarized by **self time**, by category (file or
    package), and by callers with a small script over the `.cpuprofile`. The inspector's own
    `post` frame is left out.
  - `--heap-profile`: allocations at 32 KB sampling, collected objects included.
  - Main thread only: WebCrypto's work on libuv's threads never shows, only its JS glue,
    which is why the micro-benchmarks exist. Profiled runs are ~5 % slower; the timings in
    the tables come from runs without a profiler.

**Typing** goes through two paths:

- *editor*: a `FakeMarkdownView`, typing in the middle of the note. That is real
  CodeMirror 6 in jsdom, with the binding installed as Obsidian installs it, saving every
  2 s as Obsidian does.
- *direct*: the same note claimed for an editor (`pin`, `setEditorOwned`) and typed into
  `Y.Text` with the binding's origin. This is the sync layer's share of a keystroke without
  CodeMirror and jsdom, and the honest figure for what Mycel costs per keystroke. *editor*
  adds jsdom's DOM work, which says nothing about a browser.
- *Online*: one keystroke every 60 ms (~62.5 ms on Windows), until every one is
  acknowledged.
- *Offline*: the socket closed, with its `closed` flag set so it does not reconnect.
  Keystrokes come back to back with a `setImmediate` between them; then the socket opens
  again and the time until the outbox is acknowledged is measured.

**The week away**: B stops. A starts again, opens 500 notes, and makes 40 rounds of one
insertion in each, waiting for every acknowledgement after each round: 20,000 frames. A
stops, and B starts and catches up.

**Idle**: the per-minute passes run every second (`--tick 1000`). The harness's attachment
rescan already does (`rescanMs: 1_000`); the shared files' pass is added as `main.ts` runs
it, and the cloud's `noteState` every 400 ms. Per pass is what was measured divided by the
number of passes.

**Runs** (all on 2026-11-09):

- run 1: both sizes, every scenario.
- the same with `--profile` at 5,000 notes, typing and offline shortened.
- `--heap-profile` and a counting run, both at 5,000 notes, upload/join/restart only.
- three attempts with `--store harness`.
- run 2: both sizes, every scenario again.

Other sessions on this machine ran self-tests from about 20:17 on, after run 1 and the
profiles; run 2 was started once none was running.

## What these figures cannot say

- **Node is not Obsidian.** Desktop Obsidian is Electron: Chromium's V8, BoringSSL behind
  WebCrypto, Chromium's IndexedDB. Mobile is Capacitor in Android's WebView or iOS's
  WKWebView (JavaScriptCore, another engine altogether, with another WebCrypto). Per-op
  crypto and Yjs costs move with the engine. Node's WebCrypto runs on libuv's pool of four
  threads; a browser's runs where the browser puts it.
- **This machine is fast.** A Snapdragon X Elite core is several times a mid-range phone's,
  so what took 3 s here can take 10-30 s there. Ratios and growth (per note, per keystroke,
  per unsent edit) carry over better than absolute times.
- **The fake vault is memory.** Reading or writing a file costs nothing here. In Obsidian it
  is disk I/O, on mobile through a bridge, and every create or modify also makes Obsidian
  parse the note for its metadata cache and indexes. None of that is modelled. Plugin-folder
  writes (base texts, state, backups) are counted and sized for that reason: each is a real
  file write in Obsidian.
- **IndexedDB is not IndexedDB.**
  - The self-tests use `MemoryLocalStores` (`fake-vault.ts`). On **every** update it encodes
    the whole document (`Y.encodeStateAsUpdate`) and keeps it in the JS heap.
  - y-indexeddb 9 instead appends each update as a record, and rewrites the whole state only
    after 500 records, a second after the last.
  - So the harness's stand-in charges O(document) per keystroke and per index change, which
    the plugin does not pay. It charges nothing for what the plugin does pay: an IndexedDB
    transaction per update and per cursor write, structured cloning, and **opening one
    database per note**. y-indexeddb names a database per document, so a restart that opens
    5,000 notes opens 5,000 databases.
  - The benchmark therefore models y-indexeddb's policy by default (`YLikeLocalStores` in
    `bench.mts`: a copied record per update, the whole state again after 500). It can run
    the harness's stand-in instead (`--store harness`) to show the difference. Neither has
    IndexedDB's own costs, so the storage figures here are a floor.
- **The server is next door.** Loopback, no latency, the development machine's SSD. A real
  server is a round trip away. That matters wherever the device waits for an answer: eight
  notes at once on a join, one frame in flight per room while typing. The user's Pi also
  syncs every frame to an SD card.
- **jsdom is not a browser.** The *editor* typing figures include jsdom's DOM and CSS work
  for CodeMirror; Chromium does that natively and much faster. Use *direct* for the sync
  layer.
- **One machine, a few runs.** The spread is given where there is one.

## Running it again

```bash
npm run bench                                    # both sizes, every scenario (~35 min here)
npm run bench -- --sizes 5000:2000 --profile     # with a .cpuprofile per scenario and process
npm run bench -- --sizes 5000:2000 --heap-profile --scenarios none --restarts 1
npm run bench -- --store harness --scenarios typing
```

Options are listed at the top of `bench.mts`. Results go to `<out>/results.json` (`--out`,
default a new folder in the OS temp dir) with every counter, mark and profile summary,
next to the processes' logs and the profiles. A `.cpuprofile` opens in Chrome's DevTools
(Performance tab) or VS Code. Line numbers in them are of tsx's transform, not the source;
the function names and callers are what to go by.
