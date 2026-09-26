import type { InboxItem } from '@obsidian-connect/shared'
import {
  contactContext,
  contactKeys,
  contactMac,
  decodeContactCode,
  encodeContactCode,
  fromBase64,
  fromUtf8,
  keyFingerprint,
  newContactSecret,
  sameMac,
  seal,
  sha256,
  toBase64,
  toHex,
  unseal,
  utf8,
  type Bytes
} from '@obsidian-connect/shared/crypto'
import type { ConnectApi } from '../account/api.js'
import type { AccountSettings, Contact } from '../sync/AccountSettings.js'

// Contacts, made with a one-time code. The server knows no names, so this is
// where names come from: each side tells the other its own, sealed to the
// other's key and signed with a key from the code that never reached the
// server. The creator's key is checked against the fingerprint in the code,
// the redeemer's against the signature; after that both are pinned, and a
// compromised server cannot slip in a key of its own.
//
// Contacts, codes and pending redemptions live in the account's encrypted
// settings, so every device of the account knows them.

export type ContactApi = Pick<
  ConnectApi,
  'addContactCode' | 'contactCode' | 'redeemContact' | 'replyContact' | 'contactInbox' | 'contactInboxDone' | 'removeContact'
>

export interface Me {
  accountId: string
  username: string
  publicKey: Bytes
  privateKey: CryptoKey
}

interface Introduction {
  account: string
  publicKey: string
  name: string
  mac: string
}

const CODE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

function introductionText(kind: 'request' | 'reply', codeId: string, intro: Omit<Introduction, 'mac'>): string {
  return `${kind}|${codeId}|${intro.account}|${intro.publicKey}|${intro.name}`
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

export class Contacts {
  constructor(
    private readonly api: ContactApi,
    private readonly me: Me,
    private readonly settings: AccountSettings
  ) {}

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
    return encodeContactCode(secret, await keyFingerprint(this.me.publicKey))
  }

  /**
   * Redeems someone's code. Their key is checked against the fingerprint in
   * the code before anything is sent; their name follows once their device
   * has answered. Returns their account id.
   */
  async redeem(code: string, now = Date.now()): Promise<string> {
    const decoded = decodeContactCode(code)
    if (!decoded) throw new Error('That is not a contact code.')
    const keys = await contactKeys(decoded.secret)
    const info = await this.api.contactCode(keys.codeId)
    if (info.owner === this.me.accountId) throw new Error('That is your own code.')
    const ownerKey = fromBase64(info.publicKey)
    if (!sameBytes(await keyFingerprint(ownerKey), decoded.fingerprint)) {
      throw new Error("The server handed out a key that does not belong to this code. Nothing was sent.")
    }
    const intro = { account: this.me.accountId, publicKey: toBase64(this.me.publicKey), name: this.me.username }
    const signed: Introduction = { ...intro, mac: await contactMac(keys.macKey, introductionText('request', keys.codeId, intro)) }
    const sealed = await seal(ownerKey, utf8(JSON.stringify(signed)), contactContext(keys.codeId, 'request'))
    this.settings.setPending(keys.codeId, { secret: toBase64(decoded.secret), owner: info.owner, publicKey: info.publicKey, requestedAt: now })
    await this.api.redeemContact({ codeId: keys.codeId, redeemKey: toBase64(keys.redeemKey), sealed })
    if (!this.settings.contact(info.owner)) {
      this.settings.setContact(info.owner, { accountId: info.owner, name: '', publicKey: info.publicKey, addedAt: now })
    }
    return info.owner
  }

  /** Handles what waits in the inbox. Returns how many contacts were added or completed. */
  async processInbox(now = Date.now()): Promise<number> {
    const { items } = await this.api.contactInbox()
    const done: string[] = []
    let changed = 0
    for (const item of items) {
      try {
        const outcome = item.kind === 'request' ? await this.handleRequest(item) : await this.handleReply(item)
        if (outcome === 'wait' && now - item.at < CODE_LIFETIME_MS) continue
        if (outcome === 'added') changed += 1
      } catch (error) {
        // Unreadable or forged: dropped, never acted on.
        console.warn('[obsidian-connect] a contact message could not be verified', error)
      }
      done.push(item.id)
    }
    if (done.length > 0) await this.api.contactInboxDone(done)
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
    if (code.usedBy && code.usedBy !== item.from) return 'dropped'
    const keys = await contactKeys(fromBase64(code.secret))
    const intro = await this.open(item)
    if (intro.account !== item.from) return 'dropped'
    const expected = await contactMac(keys.macKey, introductionText('request', item.codeId, intro))
    if (!sameMac(expected, intro.mac)) return 'dropped'

    this.settings.setCode(item.codeId, { ...code, usedBy: item.from })
    const existing = this.settings.contact(item.from)
    this.settings.setContact(item.from, {
      accountId: item.from,
      name: intro.name,
      localName: existing?.localName,
      publicKey: intro.publicKey,
      addedAt: existing?.addedAt ?? Date.now()
    })
    const answer = { account: this.me.accountId, publicKey: toBase64(this.me.publicKey), name: this.me.username }
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
    // Only the key checked against the code's fingerprint counts.
    if (intro.account !== item.from || intro.publicKey !== pending.publicKey) return 'dropped'
    const expected = await contactMac(keys.macKey, introductionText('reply', item.codeId, intro))
    if (!sameMac(expected, intro.mac)) return 'dropped'
    const existing = this.settings.contact(item.from)
    this.settings.setContact(item.from, {
      accountId: item.from,
      name: intro.name,
      localName: existing?.localName,
      publicKey: pending.publicKey,
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
