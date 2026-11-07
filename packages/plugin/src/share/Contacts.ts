import type { InboxItem } from '@mycel/shared'
import {
  contactContext,
  contactKeys,
  contactMac,
  decodeContactCode,
  encodeContactCode,
  fromBase64,
  fromUtf8,
  identityFingerprint,
  newContactSecret,
  sameMac,
  seal,
  sha256,
  toBase64,
  toHex,
  unseal,
  utf8,
  type Bytes
} from '@mycel/shared/crypto'
import type { ConnectApi } from '../account/api.js'
import type { AccountSettings, Contact } from '../sync/AccountSettings.js'
import { log } from '../log.js'

// Contacts, made with a one-time code. The server knows no names, so this is
// where names come from: each side tells the other its own, sealed to the
// other's key and signed with a key from the code that never reached the
// server. The creator's keys - sealing and signing - are checked against the
// fingerprint in the code, the redeemer's against the signature; after that
// both are pinned, and a compromised server cannot slip in a key of its own.
//
// Contacts, codes and pending redemptions live in the account's encrypted
// settings, so every device of the account knows them.

export type ContactApi = Pick<
  ConnectApi,
  | 'addContactCode'
  | 'revokeContactCode'
  | 'contactCode'
  | 'redeemContact'
  | 'replyContact'
  | 'contactInbox'
  | 'contactInboxDone'
  | 'removeContact'
>

/** A code handed out and not redeemed yet. */
export interface OpenCode {
  codeId: string
  /** What the other person enters. */
  code: string
  createdAt: number
  expiresAt: number
}

export interface Me {
  accountId: string
  username: string
  publicKey: Bytes
  privateKey: CryptoKey
  signingPublicKey: Bytes
}

interface Introduction {
  account: string
  publicKey: string
  signingKey: string
  name: string
  mac: string
}

const CODE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

function introductionText(kind: 'request' | 'reply', codeId: string, intro: Omit<Introduction, 'mac'>): string {
  return `${kind}|${codeId}|${intro.account}|${intro.publicKey}|${intro.signingKey}|${intro.name}`
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

export class Contacts {
  private readonly confirmedListeners = new Set<(accountId: string) => void>()

  constructor(
    private readonly api: ContactApi,
    private readonly me: Me,
    private readonly settings: AccountSettings
  ) {}

  /** A contact's keys were confirmed anew with a friend code - they replaced theirs: what is shared with them is sealed anew. */
  onConfirmed(listener: (accountId: string) => void): void {
    this.confirmedListeners.add(listener)
  }

  /**
   * Pins a contact's keys as the code's exchange vouched for them. Other keys
   * than pinned before - or a contact who replaced theirs - is told on.
   */
  private pin(contact: Contact): void {
    const before = this.settings.contact(contact.accountId)
    const changed = before !== null && (before.publicKey !== contact.publicKey || before.signingKey !== contact.signingKey || before.replacedAt !== undefined)
    // Kept until the shares with them are sealed anew - by whichever device of the account gets there.
    const renew = changed ? Date.now() : before?.renewNeeded
    this.settings.setContact(contact.accountId, renew === undefined ? contact : { ...contact, renewNeeded: renew })
    if (!changed) return
    log.info(`${contact.accountId.slice(0, 8)}: keys confirmed anew`)
    for (const listener of this.confirmedListeners) listener(contact.accountId)
  }

  /** Contacts confirmed anew whose shares are not sealed anew yet. */
  awaitingRenewal(): string[] {
    return this.settings
      .contacts()
      .filter((contact) => contact.renewNeeded !== undefined)
      .map((contact) => contact.accountId)
  }

  /** Everything shared with them is sealed anew to the keys confirmed. */
  renewed(accountId: string): void {
    const contact = this.settings.contact(accountId)
    if (!contact || contact.renewNeeded === undefined) return
    const { renewNeeded: _done, ...rest } = contact
    this.settings.setContact(accountId, rest)
  }

  /**
   * The server says this contact replaced every key. Only ever a reason to
   * trust less: their keys stay pinned, but nothing is sealed to them nor
   * taken in their name until a new friend code confirmed them.
   */
  markReplaced(accountId: string, now = Date.now()): boolean {
    const contact = this.settings.contact(accountId)
    if (!contact || contact.replacedAt !== undefined) return false
    this.settings.setContact(accountId, { ...contact, replacedAt: now })
    log.warn(`${accountId.slice(0, 8)} replaced their keys; waits for a new friend code`)
    return true
  }

  /** Whether they replaced their keys and were not confirmed again since. */
  isReplaced(accountId: string): boolean {
    return this.settings.contact(accountId)?.replacedAt !== undefined
  }

  /** Everyone, named ones first. */
  list(): Contact[] {
    return this.settings.contacts().sort((a, b) => this.nameOf(a).localeCompare(this.nameOf(b)))
  }

  private nameOf(contact: Contact): string {
    return contact.localName || contact.name || `someone (${contact.accountId.slice(0, 8)})`
  }

  /** How this account calls someone, by id; the id itself for strangers. */
  name(accountId: string): string {
    const contact = this.settings.contact(accountId)
    return contact ? this.nameOf(contact) : accountId.slice(0, 8)
  }

  /** The key pinned when the contact was made, never the server's word. */
  publicKey(accountId: string): Bytes | null {
    const contact = this.settings.contact(accountId)
    return contact ? fromBase64(contact.publicKey) : null
  }

  /**
   * A contact's signing key, pinned with their sealing key when the contact
   * was made; none while they replaced their keys and were not confirmed
   * again - whoever took the keys before signs with that one.
   */
  signingKey(accountId: string): Bytes | null {
    const contact = this.settings.contact(accountId)
    return contact && contact.replacedAt === undefined ? fromBase64(contact.signingKey) : null
  }

  isContact(accountId: string): boolean {
    return this.settings.contact(accountId) !== null
  }

  rename(accountId: string, localName: string): void {
    const contact = this.settings.contact(accountId)
    if (!contact) return
    this.settings.setContact(accountId, { ...contact, localName: localName.trim() || undefined })
  }

  /** A code for one person, valid for seven days. Send it any way but through this server. */
  async createCode(now = Date.now()): Promise<string> {
    const secret = newContactSecret()
    const keys = await contactKeys(secret)
    const expiresAt = now + CODE_LIFETIME_MS
    await this.api.addContactCode({ codeId: keys.codeId, redeemHash: toHex(await sha256(keys.redeemKey)), expiresAt })
    this.settings.setCode(keys.codeId, { secret: toBase64(secret), createdAt: now, expiresAt })
    log.info(`contact code ${keys.codeId.slice(0, 8)} created`)
    return encodeContactCode(secret, await identityFingerprint(this.me.accountId, this.me.publicKey, this.me.signingPublicKey))
  }

  /** Codes this account handed out that nobody has redeemed yet, oldest first - on every device. */
  async openCodes(now = Date.now()): Promise<OpenCode[]> {
    const fingerprint = await identityFingerprint(this.me.accountId, this.me.publicKey, this.me.signingPublicKey)
    return this.settings
      .codes()
      .filter(({ code }) => !code.usedBy && !code.revokedAt && code.expiresAt > now)
      .sort((a, b) => a.code.createdAt - b.code.createdAt)
      .map(({ codeId, code }) => ({
        codeId,
        code: encodeContactCode(fromBase64(code.secret), fingerprint),
        createdAt: code.createdAt,
        expiresAt: code.expiresAt
      }))
  }

  /** Takes a code back before anyone redeemed it. */
  async revokeCode(codeId: string, now = Date.now()): Promise<void> {
    const code = this.settings.code(codeId)
    if (!code || code.usedBy) return
    await this.api.revokeContactCode(codeId)
    this.settings.setCode(codeId, { ...code, revokedAt: now })
    log.info(`contact code ${codeId.slice(0, 8)} deleted`)
  }

  /** Codes long past their end: neither the server nor anyone holding them can use them any more. */
  private pruneCodes(now: number): void {
    for (const { codeId, code } of this.settings.codes()) {
      if (code.expiresAt + CODE_LIFETIME_MS < now) this.settings.setCode(codeId, null)
    }
  }

  /**
   * Redeems someone's code. Their identity - sealing and signing key - is
   * checked against the fingerprint in the code before anything is sent, and
   * pinned; their name follows once their device has answered. Returns their
   * account id. Redeemed from a contact, the code replaces the keys pinned for
   * them: that is how a contact who replaced their keys is confirmed again.
   */
  async redeem(code: string, now = Date.now()): Promise<string> {
    const decoded = decodeContactCode(code)
    if (!decoded) throw new Error('That is not a contact code.')
    const keys = await contactKeys(decoded.secret)
    const info = await this.api.contactCode(keys.codeId)
    if (info.owner === this.me.accountId) throw new Error('That is your own code.')
    const ownerKey = fromBase64(info.publicKey)
    // The account the code's creator is, too - not only its keys.
    const matches = await identityFingerprint(info.owner, ownerKey, fromBase64(info.signingPublicKey)).then(
      (fingerprint) => sameBytes(fingerprint, decoded.fingerprint),
      () => false
    )
    if (!matches) throw new Error('The server handed out an account or keys that do not belong to this code. Nothing was sent.')
    const intro = this.introduction()
    const signed: Introduction = { ...intro, mac: await contactMac(keys.macKey, introductionText('request', keys.codeId, intro)) }
    const sealed = await seal(ownerKey, utf8(JSON.stringify(signed)), contactContext(keys.codeId, 'request'))
    this.settings.setPending(keys.codeId, {
      secret: toBase64(decoded.secret),
      owner: info.owner,
      publicKey: info.publicKey,
      signingKey: info.signingPublicKey,
      requestedAt: now
    })
    await this.api.redeemContact({ codeId: keys.codeId, redeemKey: toBase64(keys.redeemKey), sealed })
    const existing = this.settings.contact(info.owner)
    this.pin({
      accountId: info.owner,
      name: existing?.name ?? '',
      localName: existing?.localName,
      publicKey: info.publicKey,
      signingKey: info.signingPublicKey,
      addedAt: existing?.addedAt ?? now
    })
    return info.owner
  }

  private introduction(): Omit<Introduction, 'mac'> {
    return {
      account: this.me.accountId,
      publicKey: toBase64(this.me.publicKey),
      signingKey: toBase64(this.me.signingPublicKey),
      name: this.me.username
    }
  }

  /** Handles what waits in the inbox. Returns how many contacts were added or completed. */
  async processInbox(now = Date.now()): Promise<number> {
    const { items } = await this.api.contactInbox()
    const done: string[] = []
    let changed = 0
    for (const item of items) {
      try {
        const outcome = item.kind === 'request' ? await this.handleRequest(item) : await this.handleReply(item)
        log.info(`contact ${item.kind} from ${item.from} for code ${item.codeId.slice(0, 8)}: ${outcome}`)
        if (outcome === 'wait' && now - item.at < CODE_LIFETIME_MS) continue
        if (outcome === 'added') changed += 1
      } catch (error) {
        // Unreadable or forged: dropped, never acted on.
        log.warn('a contact message could not be verified', error)
      }
      done.push(item.id)
    }
    if (done.length > 0) await this.api.contactInboxDone(done)
    this.pruneCodes(now)
    return changed
  }

  private async open(item: InboxItem): Promise<Introduction> {
    const plaintext = await unseal(this.me.privateKey, this.me.publicKey, item.sealed, contactContext(item.codeId, item.kind))
    return JSON.parse(fromUtf8(plaintext)) as Introduction
  }

  /** Someone redeemed a code this account made. */
  private async handleRequest(item: InboxItem): Promise<'added' | 'dropped' | 'wait'> {
    const code = this.settings.code(item.codeId)
    // The code may not have reached this device's settings yet.
    if (!code) return 'wait'
    if (code.revokedAt || (code.usedBy && code.usedBy !== item.from)) return 'dropped'
    const keys = await contactKeys(fromBase64(code.secret))
    const intro = await this.open(item)
    if (intro.account !== item.from || typeof intro.publicKey !== 'string' || typeof intro.signingKey !== 'string' || typeof intro.name !== 'string') return 'dropped'
    const expected = await contactMac(keys.macKey, introductionText('request', item.codeId, intro))
    if (!sameMac(expected, intro.mac)) return 'dropped'

    const existing = this.settings.contact(item.from)
    // Whoever redeems a code names their account themselves - nothing binds it,
    // as the code binds its creator's. Other keys for a contact pinned already
    // are taken only once that contact replaced theirs: otherwise anyone handed
    // a code, with a server going along, could take an existing contact's place.
    if (existing && existing.replacedAt === undefined && (existing.publicKey !== intro.publicKey || existing.signingKey !== intro.signingKey)) {
      log.error(`a redemption of code ${item.codeId.slice(0, 8)} names ${item.from.slice(0, 8)}, a contact already, with other keys; dropped`)
      return 'dropped'
    }
    this.settings.setCode(item.codeId, { ...code, usedBy: item.from })
    this.pin({
      accountId: item.from,
      name: intro.name,
      localName: existing?.localName,
      publicKey: intro.publicKey,
      signingKey: intro.signingKey,
      addedAt: existing?.addedAt ?? Date.now()
    })
    const answer = this.introduction()
    const signed: Introduction = { ...answer, mac: await contactMac(keys.macKey, introductionText('reply', item.codeId, answer)) }
    const sealed = await seal(fromBase64(intro.publicKey), utf8(JSON.stringify(signed)), contactContext(item.codeId, 'reply'))
    await this.api.replyContact({ to: item.from, codeId: item.codeId, sealed })
    return 'added'
  }

  /** The answer to a code this account redeemed: the other side's name. */
  private async handleReply(item: InboxItem): Promise<'added' | 'dropped' | 'wait'> {
    const pending = this.settings.pending(item.codeId)
    if (!pending) return this.settings.contact(item.from)?.name ? 'dropped' : 'wait'
    if (pending.owner !== item.from) return 'dropped'
    const keys = await contactKeys(fromBase64(pending.secret))
    const intro = await this.open(item)
    // Only the keys checked against the code's fingerprint count.
    if (intro.account !== item.from || intro.publicKey !== pending.publicKey || intro.signingKey !== pending.signingKey) return 'dropped'
    const expected = await contactMac(keys.macKey, introductionText('reply', item.codeId, intro))
    if (!sameMac(expected, intro.mac)) return 'dropped'
    const existing = this.settings.contact(item.from)
    this.pin({
      accountId: item.from,
      name: intro.name,
      localName: existing?.localName,
      publicKey: pending.publicKey,
      signingKey: pending.signingKey,
      addedAt: existing?.addedAt ?? Date.now()
    })
    this.settings.setPending(item.codeId, null)
    return 'added'
  }

  /** Ends the contact. Whatever the two share must have ended before; see `Sharing.endWith`. */
  async remove(accountId: string): Promise<void> {
    await this.api.removeContact(accountId)
    this.settings.setContact(accountId, null)
  }

  /** The other side ended it. */
  forget(accountId: string): void {
    this.settings.setContact(accountId, null)
  }
}
