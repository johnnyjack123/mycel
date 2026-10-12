# Phase 5 — recovery codes and two-factor sign-in (0.6)

Agreed with the user on 2026-10-12; the specification the implementation follows.
Order of work, each step with its tests and a commit:

1. Signing out the other devices: a session generation per account (0.6.0).
2. The recovery code (0.6.1).
3. Two-factor sign-in with TOTP (0.6.2).

The rules are the ones that hold already: the password, the recovery code and
everything derived from them that unlocks keys never leave the device (invariant 14),
and the server knows accounts only by id. What the server learns that it did not
before: whether an account has a recovery code and since when, whether it signs in
with a second factor, that factor's TOTP secret, and when a code was last used.

## Decided with the user

- **One recovery code per account**, characters in groups of five like the friend
  codes. Using it spends it: the recovery makes a new one at once.
- **The code alone opens the account.** The server finds the account by the code;
  name and password are chosen anew, so a forgotten name is recoverable too - the
  server knows no names, so forgetting one is a real case.
- **Every new account gets a code**, shown once. The settings renew or delete it;
  existing accounts see a hint there to make one. **Setting up 2FA asks whether the
  code is still at hand** and offers a new one if not.
- **A recovery and a password change sign out every other device** on the server.
- **2FA is TOTP, optional, and guards the sign-in only.** Asked whether 2FA could
  also be needed to decrypt: not with TOTP. A six-digit code that changes every 30
  seconds and is checked by the server cannot be part of a key; "decrypting needs 2FA"
  could only mean a key share the server releases after the code, which is no
  stronger than the server - the case end-to-end encryption is built against. A real
  second secret (1Password's Secret Key: random, on the devices only, entered once per
  new device) was offered and not chosen.
- **Turning 2FA on signs out every other device**; they sign in again with a code.
- **A lost second factor:** the recovery code signs in without it, sets a new
  password, turns 2FA off and offers to set it up again. The admin can turn it off
  too (`obsidian-connect user 2fa-off <accountId>`); the password stays needed, so
  that only lowers the sign-in to what it was without 2FA.
- **Signing in is two steps:** name and password, then the code.

## Signing out the other devices *(step 1, built 0.6.0)*

Today a token stays valid until it expires (30 days, refreshed on every start), so a
password change leaves every other device's token working; honest devices only notice
that their master key no longer opens the bundle. That is not enough after a password
was stolen: whoever signed in with it holds the account secret, which a password change
does not replace (that would mean re-encrypting everything). What can be taken from them
is the server - new frames, new notes, new files.

- Every account has a **session generation** (`sessions`, 0 for every existing
  account). Every token carries it (`gen`; a token without one is generation 0). A
  token is valid only while its generation is the account's: every REST call, the
  refresh, and the socket upgrade check it.
- It moves on with a password change, a recovery, and turning 2FA on. The request that
  moves it answers with a token of the new generation, so that device stays signed in.
- **Open sockets:** when the generation moves, the server closes every socket of the
  account with close code `4401`. A socket upgrade with a token of an old generation
  is accepted and closed at once with `4401` too: a browser WebSocket cannot see the
  HTTP status of a refused upgrade, so a `401` there looks like "unreachable" and is
  retried forever - which is what happens today.
- **The plugin on `4401`** asks the server whether its token still holds (`refresh`).
  If it does, this was the device that moved the generation: reconnect. If it is
  refused, the device was signed out: sync stops, master key and bundle are
  forgotten, and a notice says to sign in again. Nothing local is lost - the files
  stay, and unsent edits stay in IndexedDB and go out once the device is signed in to
  the same account again (the vault id follows from the account secret, the same
  after a password change).
- The password dialog already says that the other devices will ask to sign in again;
  from now on that holds for every client, not only honest ones.

*As built:* the device that moved the generation has its own socket closed too, and
the close arrives before the answer carrying its new token. `Session` therefore runs
every request that moves the generation through `move`, and `stillSignedIn` waits for
it before asking - without that the device signed itself out (reproduced). A removed
account's sockets are closed with `4401` as well, at the start of the sweep.

## The recovery code *(step 2, built 0.6.1)*

```
code: 16 random bytes ‖ 22-bit check   (30 characters, Crockford base32, six groups of five)
16 random bytes ── HKDF "recovery-login" ──► recoveryKey    sent; the server stores its hash and finds the account by it
16 random bytes ── HKDF "recovery-wrap"  ──► recoveryWrap   never sent; wraps the private key and the account secret a second time
```

- **No Argon2id, no salt, no name:** the code is 128 random bits; there is nothing to
  stretch, and nothing to guess.
- The check is the first 22 bits of a hash of the secret. It lets the plugin catch a
  typo before asking the server, where every wrong code counts against the address -
  and is why the code has 30 characters rather than 26.
- The second wrapping holds the same private key and account secret as the password's,
  under contexts of their own (`recovery-private-key`, `recovery-account-secret`), so
  neither wrapping can stand in for the other. A password change does not touch it:
  the code stays valid.

### Making one

- **At registration** the device makes the code, and its wrapping travels with the
  registration request. Once the account exists the plugin shows the code once: the
  code, "Copy", and "I have written it down". Closing without ticking is allowed - the
  code can be renewed at any time.
- **In the settings**, signed in: "Recovery code: made on <date>" or "none", with
  "Make a new code…" (replaces the old one, which stops working at once) and "Delete".
  Both ask for the current password. A token alone - it travels in the socket URL -
  must not be able to plant a code its holder knows: through the recovery that would
  replace the account's keys.
- **Existing accounts**: the settings say there is no recovery code and what that
  means, with "Make one…".

### Using it

On the sign-in screen, "Forgot your password?" opens the recovery: the code, a name
(the old one or a new one), the new password twice.

1. `POST /auth/recover` with the `recoveryKey` answers with the account id, the public
   key and the second wrapping. Paced and guarded like sign-in; an unknown code counts
   as a failure of the address.
2. The device unwraps private key and account secret, derives the keys for name and
   new password, wraps both under the new master key, makes a **new** code with its
   wrapping, and checks that every new wrapping opens again with the keys it derived -
   a wrapping of nothing would destroy the account. Then `POST /auth/recover/commit`:
   the old `recoveryKey`, `newLoginKey`, `kdfVersion`, the password wrappings, and the
   new code's key and wrappings.
3. The server checks the old code again, replaces login and recovery, turns 2FA off,
   moves the session generation, and answers with a session - and whether 2FA was on.
4. The plugin shows the new code once, and if 2FA was on, offers to set it up again.

- A name and password another account has already are refused (409), as at
  registration.
- Every other device signs in again, with the new name and password.

*As built:* the sign-in screen has "Use a recovery code…", which opens the
recovery screen; its back arrow returns to signing in. The dialog showing a code
enables "Done" only once "I have written it down" is on; Escape still closes it.
Making a code checks its wrappings open again too, not only a recovery. A server
from before 0.6 shows up as a bundle without `recovery`: the settings then say the
server needs an update, and registration simply shows no code.

## Two-factor sign-in *(step 3)*

- **TOTP** (RFC 6238): HMAC-SHA1, six digits, 30 seconds, one step either side
  accepted for clocks that drift. A step once used is not accepted again (`lastStep`),
  so a code seen over a shoulder is spent.
- The secret is 20 random bytes, made on the device and shown three ways: a QR code
  (for a phone next to the computer), an `otpauth://` link (a phone running Obsidian
  cannot scan its own screen; the link opens the authenticator app) and the base32
  text to type. The label is "Obsidian Connect" and the name - made on the device; the
  server never sees the URI.
- The server keeps the secret in `accounts.json`. Whoever can read that file has the
  ciphertext already; 2FA guards reaching it through the API.

### Turning it on

In the settings, signed in:

1. The current password.
2. "Do you still have your recovery code?" - *yes*, or *no, make a new one* (shown,
   noted). Without one there is none to answer for; the plugin makes one first.
3. QR code, link and key; the person enters a code from the app. The plugin checks it
   against the secret itself first, so a phone with the wrong clock is caught before
   the server is asked.
4. `POST /account/totp` with `loginKey`, `secret` and `code`: the server checks
   password and code, stores the secret, moves the session generation - every other
   device signs in again, with a code - and answers with a session for this device.

### Signing in

1. `POST /auth/login` as before. For an account with 2FA the right login key answers
   `403 { error, secondFactor: 'totp', challenge }` instead of a session: no bundle, no
   token. The challenge is a token of its own scope (`2fa`), valid five minutes, which
   nothing else accepts. A 0.5 plugin shows the error text, which says to update.
2. The plugin asks for the code; `POST /auth/login/totp` with `challenge` and `code`
   answers with the session.

- Wrong codes count against the address, as wrong passwords do, and per account: five
  within 15 minutes block codes for that account for 15 minutes. Per account is
  possible here - only someone who knew the password gets this far. The recovery code
  still works during such a block.
- Every answer still takes one second.
- Two steps tell someone who has the password that it is right. Accepted: the address
  throttle limits guessing, and a one-form sign-in would show a code field to everyone.

### Turning it off

- In the settings: the password and a current code. Moves no generation.
- By a recovery (above).
- By the admin: `obsidian-connect user 2fa-off <accountId>`.

## Server

- `StoredAccount`: `sessions?`, `recovery?: { hash, wrappedPrivateKey,
  wrappedAccountSecret, createdAt }`, `totp?: { secret, createdAt, lastStep }`.
  `AccountFile.recoveries`: recovery hash -> account id. Removing an account removes
  its entry there too.
- `AccountBundle` adds `recovery: { createdAt } | null` and `totp: boolean`, for the
  settings.
- New endpoints, all paced and guarded: `POST /auth/recover`, `/auth/recover/commit`,
  `/auth/login/totp`; with a token and the current login key: `POST /account/recovery`
  (make or replace), `/account/recovery/delete`, `/account/totp`, `/account/totp/off`.
- `/auth/config` names what the server can (`features`); a plugin that finds recovery
  or 2FA missing says the server needs an update. No new protocol version: everything
  is added, and a 0.5 plugin keeps working against the new server, except for signing
  in to an account with 2FA.
- CLI: `user list` shows `recovery` and `2fa` per account; `user 2fa-off <accountId>`.
- Logs: never a code, a secret or a key - the account id and the outcome.

## Tests

- `test:merge` (no server): the code's round trip, every single-character typo caught
  by the check, recovery keys unrelated to the password's, wrappings not usable in
  each other's place, TOTP against the test vectors of RFC 6238.
- `test:rooms` (`AccountStore`, the HTTP routes in-process): tokens of an old
  generation refused, sockets closed with `4401`; the recovery finds the account,
  commit replaces login and recovery, the old code is spent, a colliding name and
  password refused; TOTP needs password and code to turn on, a used step is refused,
  the account block, turning it off.
- `test:account`, new: the plugin's `Session` against an in-process server, like
  `test:recovery` - register, recover with a new name and password, the old password
  refused, the same vault key afterwards; a second device signed out on its socket;
  2FA on, the two-step sign-in, a recovery turning it off.

## To verify on a device

The dialogs (the code shown at registration, the recovery screen, the 2FA setup), the
QR code scanned by an authenticator app, the `otpauth://` link on a phone, a device
being signed out while it runs.

## Known limit

Signing out takes the server away from a device, not the keys it already unwrapped:
the account secret and the vault keys are never replaced. Replacing them means
re-encrypting every note and file under new keys; not planned before 0.9.
