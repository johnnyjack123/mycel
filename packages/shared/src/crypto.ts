// End-to-end encryption, WebCrypto only, so the same code runs in Obsidian on
// desktop and mobile and in Node for the tests. WebCrypto has no Argon2id;
// whoever stretches a password passes an implementation in.
//
// Kept out of the package index on purpose: the server never encrypts or
// decrypts anything, and does not compile against the DOM's crypto types.

import { BLOB_CHUNK_BYTES, blobChunkAad, blobChunkCount } from './protocol.js'
import type { KdfParams } from './types.js'

/** What WebCrypto's types accept: bytes backed by a plain ArrayBuffer. */
export type Bytes = Uint8Array<ArrayBuffer>

export type Argon2id = (
  password: string,
  salt: Bytes,
  params: { memoryKiB: number; iterations: number; parallelism: number; hashLength: number }
) => Promise<Uint8Array>

/**
 * The Argon2id parameter sets this code knows, by version. Pinned here rather
 * than taken from the server: a server handing out weak parameters would
 * weaken every password stretched with them. An account records the version
 * it was created with, so a later, stronger set does not lock anyone out.
 * Version 1 is above RFC 9106's second recommendation (64 MiB, t = 3).
 */
export const KDF_VERSIONS: Readonly<Record<number, KdfParams>> = {
  1: { algorithm: 'argon2id', memoryKiB: 65_536, iterations: 4, parallelism: 1 }
}
export const CURRENT_KDF_VERSION = 1

const IV_BYTES = 12
const P256_PUBLIC_BYTES = 65

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// --- bytes -----------------------------------------------------------------------

/** A copy in a plain ArrayBuffer. Yjs and lib0 hand out views WebCrypto's types refuse. */
export function bytes(input: Uint8Array): Bytes {
  return new Uint8Array(input)
}

export function utf8(text: string): Bytes {
  return bytes(encoder.encode(text))
}

export function fromUtf8(data: Uint8Array): string {
  return decoder.decode(data)
}

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function randomBytes(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(length))
}

export function toBase64(data: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < data.length; i += 0x8000) {
    binary += String.fromCharCode(...data.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function fromBase64(text: string): Bytes {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

export function toHex(data: Uint8Array): string {
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// --- derivation --------------------------------------------------------------------

export async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

/** What an attachment's content is known by: in the index, and to name its blob. */
export async function contentHash(data: Bytes): Promise<string> {
  return toHex(await sha256(data))
}

export async function hkdf(secret: Bytes, info: string, length = 32): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) },
    key,
    length * 8
  )
  return new Uint8Array(bits)
}

async function hmac(secret: Bytes, message: string): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(message)))
}

/** How a name is compared: the same account whatever the case or spacing it is typed in. */
export function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase()
}

/**
 * Derived, never stored, never secret: from the server's random id and the
 * name, so a device can compute it before signing in without asking the
 * server about a name. It only has to differ per server and per name, which
 * keeps one precomputed table from attacking everyone at once.
 */
export async function accountSalt(serverId: string, username: string): Promise<Bytes> {
  return (await sha256(utf8(`obsidian-connect salt::${serverId}::${normalizeName(username)}`))).slice(0, 16)
}

export interface PasswordKeys {
  /**
   * Sent to the server, which finds the account by a hash of it and never
   * learns the name. Name and password together are the only way to it.
   */
  loginKey: Bytes
  /** Never leaves the device. Wraps the private key and the account secret. */
  masterKey: Bytes
}

/**
 * Two unrelated keys from one password. The server checks the first and never
 * sees the second, so knowing what logs you in does not decrypt anything.
 */
export async function derivePasswordKeys(
  password: string,
  salt: Bytes,
  version: number,
  argon2id: Argon2id
): Promise<PasswordKeys> {
  const params = KDF_VERSIONS[version]
  if (!params) throw new Error(`unknown key derivation version ${version}`)
  const stretched = bytes(
    await argon2id(password.normalize('NFKC'), salt, {
      memoryKiB: params.memoryKiB,
      iterations: params.iterations,
      parallelism: params.parallelism,
      hashLength: 64
    })
  )
  return {
    loginKey: await hkdf(stretched, 'obsidian-connect login'),
    masterKey: await hkdf(stretched, 'obsidian-connect master')
  }
}

/**
 * From the account secret: random, made once, kept under the master key.
 * A password change re-wraps only the secret; vaults stay as they are.
 */
export const accountKeys = {
  vaultWrap: (secret: Bytes): Promise<Bytes> => hkdf(secret, 'obsidian-connect vault-wrap'),
  vaultName: (secret: Bytes): Promise<Bytes> => hkdf(secret, 'obsidian-connect vault-name'),
  /** The same on every device of the account, and meaningless to everyone else. */
  vaultId: async (secret: Bytes, vaultName: string): Promise<string> =>
    toHex((await hmac(await hkdf(secret, 'obsidian-connect vault-id'), `vault::${vaultName.trim()}`)).subarray(0, 16))
}

/**
 * A note's id: deterministic on every device holding the vault key, and
 * unguessable for anyone else - nobody can claim a note's room before its
 * owner does, and the server cannot recover paths from ids.
 */
export async function deriveDocId(vaultKey: Bytes, path: string, generation: number): Promise<string> {
  return toHex((await hmac(vaultKey, `doc::${path}::${generation}`)).subarray(0, 16))
}

/**
 * An attachment's id, derived like a note's under a label of its own, so the
 * same file gets the same id on every device of the account.
 */
export async function deriveFileId(vaultKey: Bytes, path: string, generation: number): Promise<string> {
  return toHex((await hmac(vaultKey, `file::${path}::${generation}`)).subarray(0, 16))
}

/**
 * A blob's name: keyed, so the server cannot tell whether a vault holds a file
 * it knows, yet the same content on every device of the vault - uploading it
 * twice changes nothing.
 */
export async function blobIdFor(blobIdKey: Bytes, hash: string): Promise<string> {
  return toHex((await hmac(blobIdKey, `blob::${hash}`)).subarray(0, 16))
}

/** Everything the owner encrypts with comes from the vault key. */
export const vaultKeys = {
  blobId: (vaultKey: Bytes): Promise<Bytes> => hkdf(vaultKey, 'obsidian-connect blob-id'),
  /** Derived, so a blob's key is never stored; it leaves the vault only inside a shared note. */
  blob: (vaultKey: Bytes, blobId: string): Promise<Bytes> => hkdf(vaultKey, `obsidian-connect blob:${blobId}`),
  index: (vaultKey: Bytes): Promise<Bytes> => hkdf(vaultKey, 'obsidian-connect idx'),
  settings: (vaultKey: Bytes): Promise<Bytes> => hkdf(vaultKey, 'obsidian-connect set'),
  /**
   * One key per note and epoch. The owner can always derive every epoch, which
   * is what keeps the whole history readable to them; moving to a new epoch
   * is just counting up.
   */
  doc: (vaultKey: Bytes, docId: string, epoch: number): Promise<Bytes> =>
    hkdf(vaultKey, `obsidian-connect doc:${docId}:${epoch}`)
}

// --- symmetric ---------------------------------------------------------------------

export function aesKey(raw: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** `iv ++ ciphertext`, authenticated together with `aad`. */
export async function encrypt(key: CryptoKey, plaintext: Bytes, aad: string): Promise<Bytes> {
  const iv = randomBytes(IV_BYTES)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad) }, key, plaintext)
  return concat(iv, new Uint8Array(ciphertext))
}

/** Throws when the key, the associated data or a single byte is wrong. */
export async function decrypt(key: CryptoKey, data: Uint8Array, aad: string): Promise<Bytes> {
  const input = bytes(data)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: input.slice(0, IV_BYTES), additionalData: utf8(aad) },
    key,
    input.slice(IV_BYTES)
  )
  return new Uint8Array(plaintext)
}

/** A secret kept under the master key, e.g. the private key or a vault key. */
export async function wrapSecret(masterKey: Bytes, secret: Bytes, context: string): Promise<string> {
  return toBase64(await encrypt(await aesKey(masterKey), secret, `wrap:${context}`))
}

export async function unwrapSecret(masterKey: Bytes, wrapped: string, context: string): Promise<Bytes> {
  return decrypt(await aesKey(masterKey), fromBase64(wrapped), `wrap:${context}`)
}

// --- identity ----------------------------------------------------------------------

export interface IdentityKeys {
  /** Uncompressed P-256 point, 65 bytes. Handed to anyone who wants to share with you. */
  publicKey: Bytes
  /** PKCS#8. Only ever stored wrapped. */
  privateKey: Bytes
}

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const

export async function generateIdentity(): Promise<IdentityKeys> {
  const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])
  return {
    publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  }
}

export function importPrivateKey(pkcs8: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pkcs8, ECDH, false, ['deriveBits'])
}

function importPublicKey(raw: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, ECDH, false, [])
}

async function sealingKey(shared: ArrayBuffer, ephemeral: Bytes, recipient: Bytes): Promise<CryptoKey> {
  // Both public keys go into the derivation, so a sealed box only opens for
  // the pair it was made for.
  return aesKey(await hkdf(concat(new Uint8Array(shared), ephemeral, recipient), 'obsidian-connect seal'))
}

/**
 * Encrypts a secret so only the holder of `recipientPublicKey` can read it:
 * ephemeral ECDH, HKDF, AES-GCM. `context` names what it is for and must
 * match on the way out.
 */
export async function seal(recipientPublicKey: Bytes, secret: Bytes, context: string): Promise<string> {
  const ephemeral = await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: await importPublicKey(recipientPublicKey) },
    ephemeral.privateKey,
    256
  )
  const ephemeralRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))
  const key = await sealingKey(shared, ephemeralRaw, recipientPublicKey)
  return toBase64(concat(ephemeralRaw, await encrypt(key, secret, `seal:${context}`)))
}

export async function unseal(
  privateKey: CryptoKey,
  ownPublicKey: Bytes,
  sealed: string,
  context: string
): Promise<Bytes> {
  const data = fromBase64(sealed)
  const ephemeralRaw = data.slice(0, P256_PUBLIC_BYTES)
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: await importPublicKey(ephemeralRaw) },
    privateKey,
    256
  )
  const key = await sealingKey(shared, ephemeralRaw, ownPublicKey)
  return decrypt(key, data.slice(P256_PUBLIC_BYTES), `seal:${context}`)
}

// --- frames ------------------------------------------------------------------------

/** The plaintext of a log frame: the author's clock, then the Yjs update. */
export function packFrame(authorTs: number, update: Uint8Array): Bytes {
  const out = new Uint8Array(8 + update.length)
  new DataView(out.buffer).setFloat64(0, authorTs)
  out.set(update, 8)
  return out
}

export function unpackFrame(data: Uint8Array): { authorTs: number; update: Bytes } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return { authorTs: view.getFloat64(0), update: bytes(data.subarray(8)) }
}

// --- blobs -------------------------------------------------------------------------

/** Chunk `index` of a file's plaintext. */
export function blobChunk(plaintext: Uint8Array, index: number): Bytes {
  return bytes(plaintext.subarray(index * BLOB_CHUNK_BYTES, (index + 1) * BLOB_CHUNK_BYTES))
}

export function encryptBlobChunk(key: CryptoKey, chunk: Bytes, blobId: string, index: number, count: number): Promise<Bytes> {
  return encrypt(key, chunk, blobChunkAad(blobId, index, count))
}

export function decryptBlobChunk(key: CryptoKey, data: Uint8Array, blobId: string, index: number, count: number): Promise<Bytes> {
  return decrypt(key, data, blobChunkAad(blobId, index, count))
}

/** Every chunk of a file, encrypted. For tests and small files; transfers go chunk by chunk. */
export async function encryptBlob(key: CryptoKey, plaintext: Uint8Array, blobId: string): Promise<Bytes[]> {
  const count = blobChunkCount(plaintext.length)
  const chunks: Bytes[] = []
  for (let index = 0; index < count; index += 1) {
    chunks.push(await encryptBlobChunk(key, blobChunk(plaintext, index), blobId, index, count))
  }
  return chunks
}

export async function decryptBlob(key: CryptoKey, chunks: Uint8Array[], blobId: string): Promise<Bytes> {
  const plain: Bytes[] = []
  for (let index = 0; index < chunks.length; index += 1) {
    plain.push(await decryptBlobChunk(key, chunks[index] as Uint8Array, blobId, index, chunks.length))
  }
  return concat(...plain)
}

/** What a sealed epoch key is for; binds it to the room and the epoch. */
export function epochKeyContext(room: string, epoch: number): string {
  return `epoch:${room}#${epoch}`
}

/** What a sealed share title is for. */
export function titleContext(docId: string): string {
  return `title:${docId}`
}

// --- contacts ------------------------------------------------------------------------
//
// A one-time friend code carries a random secret and the fingerprint of its
// creator's public key, and travels outside the server. From the secret come
// the code's id, a key the server checks a redemption with (it stores only a
// hash), and a MAC key that never leaves a device: both sides sign what they
// send each other with it, so a server that saw the redemption still cannot
// forge a contact or swap a key.

const CONTACT_SECRET_BYTES = 16
const FINGERPRINT_BYTES = 12
// Crockford's base32: no I, L, O or U to misread.
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function newContactSecret(): Bytes {
  return randomBytes(CONTACT_SECRET_BYTES)
}

/** The first 96 bits of the key's hash: enough that nobody can make another key that matches. */
export async function keyFingerprint(publicKey: Bytes): Promise<Bytes> {
  return (await sha256(publicKey)).slice(0, FINGERPRINT_BYTES)
}

export interface ContactKeys {
  codeId: string
  /** Sent to the server when redeeming; the server keeps only its hash. */
  redeemKey: Bytes
  /** Never leaves a device. */
  macKey: Bytes
}

export async function contactKeys(secret: Bytes): Promise<ContactKeys> {
  return {
    codeId: toHex(await hkdf(secret, 'obsidian-connect contact-id', 16)),
    redeemKey: await hkdf(secret, 'obsidian-connect contact-redeem'),
    macKey: await hkdf(secret, 'obsidian-connect contact-mac')
  }
}

export async function contactMac(macKey: Bytes, message: string): Promise<string> {
  return toHex(await hmac(macKey, message))
}

/** Compares two MACs without leaking through timing where they first differ. */
export function sameMac(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return difference === 0
}

function toBase32(data: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of data) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

function fromBase32(text: string): Bytes | null {
  const normalized = text
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of normalized) {
    const index = BASE32.indexOf(char)
    if (index < 0) return null
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

/** Secret and fingerprint, in groups of five for reading out or typing. */
export function encodeContactCode(secret: Bytes, fingerprint: Bytes): string {
  return (toBase32(concat(secret, fingerprint)).match(/.{1,5}/g) ?? []).join('-')
}

export function decodeContactCode(code: string): { secret: Bytes; fingerprint: Bytes } | null {
  const data = fromBase32(code)
  if (!data || data.length !== CONTACT_SECRET_BYTES + FINGERPRINT_BYTES) return null
  return { secret: data.slice(0, CONTACT_SECRET_BYTES), fingerprint: data.slice(CONTACT_SECRET_BYTES) }
}

/** What a sealed contact message is for; binds it to its code and direction. */
export function contactContext(codeId: string, kind: 'request' | 'reply'): string {
  return `contact-${kind}:${codeId}`
}

// --- recovery ------------------------------------------------------------------------
//
// A recovery code opens the account on its own, so a forgotten password - or
// name - is not the end of it. It is 128 random bits: nothing to stretch, no
// salt, no name. From it come a key the server finds the account by (it keeps
// only the hash) and a key that wraps the private key and the account secret a
// second time, which never leaves a device. A 22-bit check rides along, so a
// typo is caught here rather than counted against the address at the server.

const RECOVERY_SECRET_BYTES = 16
const RECOVERY_CHECK_BYTES = 3
// 128 + 22 bits are 30 characters exactly; the last two bits of the check
// bytes stay zero and their character is dropped.
const RECOVERY_CODE_CHARS = 30

export function newRecoverySecret(): Bytes {
  return randomBytes(RECOVERY_SECRET_BYTES)
}

async function recoveryCheck(secret: Bytes): Promise<Bytes> {
  const check = (await sha256(concat(utf8('obsidian-connect recovery-check'), secret))).slice(0, RECOVERY_CHECK_BYTES)
  check[RECOVERY_CHECK_BYTES - 1] &= 0xfc
  return check
}

/** Six groups of five characters, for writing down. */
export async function encodeRecoveryCode(secret: Bytes): Promise<string> {
  const text = toBase32(concat(secret, await recoveryCheck(secret))).slice(0, RECOVERY_CODE_CHARS)
  return (text.match(/.{1,5}/g) ?? []).join('-')
}

/** The secret behind a code, or null for anything that is not one - a typo included. */
export async function decodeRecoveryCode(code: string): Promise<Bytes | null> {
  const compact = code.replace(/[\s-]/g, '')
  if (compact.length !== RECOVERY_CODE_CHARS) return null
  const data = fromBase32(`${compact}0`)
  if (!data || data.length !== RECOVERY_SECRET_BYTES + RECOVERY_CHECK_BYTES) return null
  const secret = data.slice(0, RECOVERY_SECRET_BYTES)
  const check = await recoveryCheck(secret)
  return check.every((byte, index) => byte === data[RECOVERY_SECRET_BYTES + index]) ? secret : null
}

export interface RecoveryKeys {
  /** Sent to the server, which finds the account by its hash. */
  recoveryKey: Bytes
  /** Never leaves the device. Wraps the private key and the account secret. */
  wrapKey: Bytes
}

// --- two-factor sign-in --------------------------------------------------------------
//
// TOTP (RFC 6238) as every authenticator app speaks it: HMAC-SHA1, six digits,
// 30-second steps. It guards the sign-in only; nothing is encrypted with it.
// The server checks codes itself; this side makes the secret, shows it to the
// app, and checks the first code before bothering the server with it.

export const TOTP_STEP_SECONDS = 30
const TOTP_SECRET_BYTES = 20
// Authenticator apps read RFC 4648 base32, not Crockford's.
const RFC4648 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function newTotpSecret(): Bytes {
  return randomBytes(TOTP_SECRET_BYTES)
}

/** The secret as an authenticator app takes it typed in: RFC 4648 base32, no padding. */
export function totpKeyText(secret: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of secret) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += RFC4648[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += RFC4648[(value << (5 - bits)) & 31]
  return out
}

/** What a QR code or a link hands an authenticator app. */
export function totpUri(secret: Uint8Array, label: string, issuer: string): string {
  const name = `${encodeURIComponent(issuer)}:${encodeURIComponent(label)}`
  return `otpauth://totp/${name}?secret=${totpKeyText(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP_SECONDS}`
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS)
}

/** The six digits for one time step. */
export async function totpCode(secret: Bytes, step: number): Promise<string> {
  const counter = new Uint8Array(8)
  let rest = step
  for (let index = 7; index >= 0; index -= 1) {
    counter[index] = rest % 256
    rest = Math.floor(rest / 256)
  }
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter))
  const offset = (mac[mac.length - 1] as number) & 0x0f
  const binary =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number)
  return String(binary % 1_000_000).padStart(6, '0')
}

/** Whether a code fits now, a step either side allowed for clocks that drift. */
export async function totpMatches(secret: Bytes, code: string, nowMs: number): Promise<boolean> {
  const typed = code.replace(/\s/g, '')
  const step = totpStep(nowMs)
  for (const candidate of [step - 1, step, step + 1]) {
    if ((await totpCode(secret, candidate)) === typed) return true
  }
  return false
}

export async function recoveryKeys(secret: Bytes): Promise<RecoveryKeys> {
  return {
    recoveryKey: await hkdf(secret, 'obsidian-connect recovery-login'),
    wrapKey: await hkdf(secret, 'obsidian-connect recovery-wrap')
  }
}
