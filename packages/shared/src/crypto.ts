// End-to-end encryption, WebCrypto only, so the same code runs in Obsidian on
// desktop and mobile and in Node for the tests. WebCrypto has no Argon2id;
// whoever stretches a password passes an implementation in.
//
// Kept out of the package index on purpose: the server never encrypts or
// decrypts anything, and does not compile against the DOM's crypto types.

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

/** Everything the owner encrypts with comes from the vault key. */
export const vaultKeys = {
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

/** What a sealed epoch key is for; binds it to the room and the epoch. */
export function epochKeyContext(room: string, epoch: number): string {
  return `epoch:${room}#${epoch}`
}

/** What a sealed share title is for. */
export function titleContext(docId: string): string {
  return `title:${docId}`
}
