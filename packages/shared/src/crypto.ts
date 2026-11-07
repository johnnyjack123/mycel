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

export function fromHex(text: string): Bytes {
  const out = new Uint8Array(text.length >> 1)
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
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
  return (await sha256(utf8(`mycel salt::${serverId}::${normalizeName(username)}`))).slice(0, 16)
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
    loginKey: await hkdf(stretched, 'mycel login'),
    masterKey: await hkdf(stretched, 'mycel master')
  }
}

/**
 * From the account secret: random, made once, kept under the master key.
 * A password change re-wraps only the secret; vaults stay as they are.
 */
export const accountKeys = {
  vaultWrap: (secret: Bytes): Promise<Bytes> => hkdf(secret, 'mycel vault-wrap'),
  /** Wraps the account's signing key: a password change or a recovery re-wraps the secret only. */
  signingWrap: (secret: Bytes): Promise<Bytes> => hkdf(secret, 'mycel signing-wrap'),
  /**
   * Wraps the account secret a replacement of every key replaced, under the
   * new one, until the vaults are written anew: a password change or a
   * recovery meanwhile leaves it readable.
   */
  previousWrap: (secret: Bytes): Promise<Bytes> => hkdf(secret, 'mycel previous-wrap'),
  vaultName: (secret: Bytes): Promise<Bytes> => hkdf(secret, 'mycel vault-name'),
  /** The same on every device of the account, and meaningless to everyone else. */
  vaultId: async (secret: Bytes, vaultName: string): Promise<string> =>
    toHex((await hmac(await hkdf(secret, 'mycel vault-id'), `vault::${vaultName.trim()}`)).subarray(0, 16))
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
 * A shared folder's id, derived like a note's under a label of its own: never
 * random, and the next generation once a folder's share ended (invariant 5).
 */
export async function deriveFolderId(vaultKey: Bytes, path: string, generation: number): Promise<string> {
  return toHex((await hmac(vaultKey, `folder::${path}::${generation}`)).subarray(0, 16))
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
  blobId: (vaultKey: Bytes): Promise<Bytes> => hkdf(vaultKey, 'mycel blob-id'),
  /** Derived, so a blob's key is never stored; it leaves the vault only inside a shared note. */
  blob: (vaultKey: Bytes, blobId: string): Promise<Bytes> => hkdf(vaultKey, `mycel blob:${blobId}`),
  index: (vaultKey: Bytes): Promise<Bytes> => hkdf(vaultKey, 'mycel idx'),
  settings: (vaultKey: Bytes): Promise<Bytes> => hkdf(vaultKey, 'mycel set'),
  /**
   * One key per note and epoch. The owner can always derive every epoch, which
   * is what keeps the whole history readable to them; moving to a new epoch
   * is just counting up.
   */
  doc: (vaultKey: Bytes, docId: string, epoch: number): Promise<Bytes> =>
    hkdf(vaultKey, `mycel doc:${docId}:${epoch}`),
  /** One key per shared folder and folder epoch; members get it sealed. */
  folder: (vaultKey: Bytes, folderId: string, epoch: number): Promise<Bytes> =>
    hkdf(vaultKey, `mycel fld:${folderId}:${epoch}`)
}

/**
 * What one epoch's key of a shared folder opens. Whoever holds it reads every
 * note in the folder - one added tomorrow included - without anyone sealing a
 * key per note.
 */
export const folderKeys = {
  /** The folder room's own key in that epoch. */
  room: (folderKey: Bytes): Promise<Bytes> => hkdf(folderKey, 'mycel folder-room'),
  /** A note's key for an epoch it spent in the folder while the folder was in this one. */
  doc: (folderKey: Bytes, docId: string, epoch: number): Promise<Bytes> =>
    hkdf(folderKey, `mycel doc:${docId}:${epoch}`),
  /**
   * The key ids of notes and files created in the folder are derived under
   * (`deriveDocId`, `deriveFileId`, on the path relative to the folder): the same
   * for everyone in it, and new with every epoch, so someone revoked cannot
   * compute the ids still to come and claim their rooms first.
   */
  ids: (folderKey: Bytes): Promise<Bytes> => hkdf(folderKey, 'mycel folder-ids')
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
  return aesKey(await hkdf(concat(new Uint8Array(shared), ephemeral, recipient), 'mycel seal'))
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

// --- signing --------------------------------------------------------------------------
//
// Every account has a signing key pair besides its sealing one: ECDSA P-256,
// which every WebCrypto has. The owner of a note or folder signs each key it
// seals, so a server that hands someone a key of its own - and frames under it -
// is caught: the signature is missing or not the owner's.

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const
const ECDSA_SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const

export interface SigningKeys {
  /** Uncompressed P-256 point, 65 bytes. */
  publicKey: Bytes
  /** PKCS#8. Only ever stored wrapped. */
  privateKey: Bytes
}

export async function generateSigningKeys(): Promise<SigningKeys> {
  const pair = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify'])
  return {
    publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  }
}

export function importSigningKey(pkcs8: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pkcs8, ECDSA, false, ['sign'])
}

const verifyKeys = new Map<string, Promise<CryptoKey>>()

function importVerifyKey(raw: Bytes): Promise<CryptoKey> {
  const id = toBase64(raw)
  let key = verifyKeys.get(id)
  if (!key) {
    key = crypto.subtle.importKey('raw', raw, ECDSA, false, ['verify'])
    verifyKeys.set(id, key)
    key.catch(() => verifyKeys.delete(id))
  }
  return key
}

/** A signature over `message`, base64 - 64 bytes, r and s. */
export async function sign(privateKey: CryptoKey, message: string | Bytes): Promise<string> {
  const data = typeof message === 'string' ? utf8(message) : message
  return toBase64(new Uint8Array(await crypto.subtle.sign(ECDSA_SIGN, privateKey, data)))
}

/** False for a wrong signature, and for a key or signature that is no such thing. */
export async function verifySignature(publicKey: Bytes, message: string | Bytes, signature: string): Promise<boolean> {
  try {
    const data = typeof message === 'string' ? utf8(message) : message
    return await crypto.subtle.verify(ECDSA_SIGN, await importVerifyKey(publicKey), fromBase64(signature), data)
  } catch {
    return false
  }
}

/** What the owner signs for a key it seals: which room and epoch, for whom, and the sealed box itself. */
async function sealedKeyMessage(room: string, epoch: number, recipient: string, sealed: string): Promise<string> {
  return `sealed-key|${room}|${epoch}|${recipient}|${toHex(await sha256(utf8(sealed)))}`
}

/**
 * A sealed key with its sealer's signature: `sealed.signer.signature`, and for
 * someone who may write `.cert` - the owner's word that they may, over the room
 * and epoch and their signing key (`writerCertMessage`).
 */
export async function signSealed(
  signingKey: CryptoKey,
  signer: string,
  room: string,
  epoch: number,
  recipient: string,
  sealed: string,
  cert?: string
): Promise<string> {
  const signed = `${sealed}.${signer}.${await sign(signingKey, await sealedKeyMessage(room, epoch, recipient, sealed))}`
  return cert ? `${signed}.${cert}` : signed
}

export interface SignedSealed {
  sealed: string
  signer: string
  signature: string
  /** The owner's signature letting the recipient write, base64; absent for a reader. */
  cert?: string
}

/** The parts of a signed sealed key; null for anything else. */
export function splitSealed(value: string): SignedSealed | null {
  const parts = value.split('.')
  if (parts.length !== 3 && parts.length !== 4) return null
  const [sealed, signer, signature, cert] = parts as [string, string, string, string | undefined]
  if (!sealed || !/^[0-9a-f]{32}$/.test(signer) || !signature) return null
  return cert ? { sealed, signer, signature, cert } : { sealed, signer, signature }
}

export async function verifySealed(signerPublicKey: Bytes, room: string, epoch: number, recipient: string, value: SignedSealed): Promise<boolean> {
  return verifySignature(signerPublicKey, await sealedKeyMessage(room, epoch, recipient, value.sealed), value.signature)
}

// --- frames ------------------------------------------------------------------------
//
// A frame's plaintext - the same for a snapshot - names its author, the author's
// clock and the Yjs update, and carries the author's signature over room, epoch,
// clock and update, inside the encryption: the server sees no author, and cannot
// take the signature off. Someone writing in a room they do not own adds the
// owner's word that they may write there - a writer's certificate: the owner's
// signature over the room (or folder), the epoch, the writer and the writer's
// signing key - so everyone in the room can check them, contacts of theirs or not.

const FRAME_FORMAT = 1
const ACCOUNT_BYTES = 16
const SIGNATURE_BYTES = 64

/** The owner's word that `account`, with this signing key, may write in a room or folder in one epoch. */
export interface WriterCert {
  signingKey: Bytes
  /** The owner's signature (`writerCertMessage`). */
  signature: Bytes
}

export interface OpenedFrame {
  authorTs: number
  update: Bytes
  /** The author's account id. */
  author: string
  /** Absent for the room's owner, who needs none. */
  cert: WriterCert | null
  signature: Bytes
}

function frameMessage(room: string, epoch: number, authorTs: number, author: string, update: Uint8Array): Bytes {
  return concat(utf8(`frame|${room}|${epoch}|${authorTs}|${author}|`), update)
}

/** What an owner signs to let someone write: the room or folder, its epoch, who, and with which key. */
export function writerCertMessage(scopeRoom: string, scopeEpoch: number, account: string, signingKey: Uint8Array): string {
  return `writer|${scopeRoom}|${scopeEpoch}|${account}|${toBase64(signingKey)}`
}

export async function signWriterCert(ownerKey: CryptoKey, scopeRoom: string, scopeEpoch: number, account: string, signingKey: Bytes): Promise<string> {
  return sign(ownerKey, writerCertMessage(scopeRoom, scopeEpoch, account, signingKey))
}

export function verifyWriterCert(ownerPublicKey: Bytes, scopeRoom: string, scopeEpoch: number, account: string, cert: WriterCert): Promise<boolean> {
  return verifySignature(ownerPublicKey, writerCertMessage(scopeRoom, scopeEpoch, account, cert.signingKey), toBase64(cert.signature))
}

/** A frame's plaintext, signed by its author; `cert` for anyone but the room's owner. */
export async function packSignedFrame(
  signingKey: CryptoKey,
  room: string,
  epoch: number,
  author: string,
  cert: WriterCert | null,
  authorTs: number,
  update: Uint8Array
): Promise<Bytes> {
  const signature = fromBase64(await sign(signingKey, frameMessage(room, epoch, authorTs, author, update)))
  return assembleFrame(author, cert, authorTs, signature, update)
}

/**
 * A frame someone else signed, with another certificate: the owner replaced
 * its keys and certifies the writer anew. Their signature covers room, epoch,
 * author, time and change - none of which moves - and still holds.
 */
export function recertifyFrame(frame: OpenedFrame, cert: WriterCert): Bytes {
  return assembleFrame(frame.author, cert, frame.authorTs, frame.signature, frame.update)
}

function assembleFrame(author: string, cert: WriterCert | null, authorTs: number, signature: Uint8Array, update: Uint8Array): Bytes {
  const head = new Uint8Array(1 + 8 + ACCOUNT_BYTES + 1)
  head[0] = FRAME_FORMAT
  new DataView(head.buffer).setFloat64(1, authorTs)
  head.set(fromHex(author), 9)
  head[9 + ACCOUNT_BYTES] = cert ? 1 : 0
  return concat(head, ...(cert ? [cert.signingKey, cert.signature] : []), signature, update)
}

/**
 * A frame's plaintext; null for anything that is not one. It opened under the
 * room's key, so whoever made it holds that key - and is dropped like a forged
 * frame, never let to stop the room.
 */
export function unpackFrame(data: Uint8Array): OpenedFrame | null {
  const head = 9 + ACCOUNT_BYTES + 1
  if (data[0] !== FRAME_FORMAT || data.length < head + SIGNATURE_BYTES) return null
  const flag = data[head - 1]
  if (flag !== 0 && flag !== 1) return null
  let offset = head
  let cert: WriterCert | null = null
  if (flag === 1) {
    if (data.length < head + P256_PUBLIC_BYTES + 2 * SIGNATURE_BYTES) return null
    cert = {
      signingKey: bytes(data.subarray(offset, offset + P256_PUBLIC_BYTES)),
      signature: bytes(data.subarray(offset + P256_PUBLIC_BYTES, offset + P256_PUBLIC_BYTES + SIGNATURE_BYTES))
    }
    offset += P256_PUBLIC_BYTES + SIGNATURE_BYTES
  }
  const authorTs = new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat64(1)
  if (!Number.isFinite(authorTs)) return null
  return {
    authorTs,
    update: bytes(data.subarray(offset + SIGNATURE_BYTES)),
    author: toHex(data.subarray(9, 9 + ACCOUNT_BYTES)),
    cert,
    signature: bytes(data.subarray(offset, offset + SIGNATURE_BYTES))
  }
}

/** Whether a frame's signature holds under `publicKey` - the owner's, or the one its certificate names. */
export function verifyFrame(publicKey: Bytes, room: string, epoch: number, frame: OpenedFrame): Promise<boolean> {
  return verifySignature(publicKey, frameMessage(room, epoch, frame.authorTs, frame.author, frame.update), toBase64(frame.signature))
}

// Presence - carets, selections, the name beside them - travels in the frame's
// format, under a signature of its own kind: one made for a caret is never one
// for a change. Unsigned, anyone holding a note's key, a reader too, drew a caret
// in any account's name and hid their own behind it (0.9.9).

function presenceMessage(room: string, epoch: number, authorTs: number, author: string, update: Uint8Array): Bytes {
  return concat(utf8(`presence|${room}|${epoch}|${authorTs}|${author}|`), update)
}

/** A presence update's plaintext, signed by whoever sends it; a writer adds the owner's certificate, as on a frame. */
export async function packSignedPresence(
  signingKey: CryptoKey,
  room: string,
  epoch: number,
  author: string,
  cert: WriterCert | null,
  authorTs: number,
  update: Uint8Array
): Promise<Bytes> {
  const signature = fromBase64(await sign(signingKey, presenceMessage(room, epoch, authorTs, author, update)))
  return assembleFrame(author, cert, authorTs, signature, update)
}

/** Whether a presence update's signature holds under `publicKey`. Read with `unpackFrame`. */
export function verifyPresence(publicKey: Bytes, room: string, epoch: number, presence: OpenedFrame): Promise<boolean> {
  return verifySignature(publicKey, presenceMessage(room, epoch, presence.authorTs, presence.author, presence.update), toBase64(presence.signature))
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
// creator's identity - sealing and signing key together -, and travels outside
// the server. From the secret come the code's id, a key the server checks a
// redemption with (it stores only a hash), and a MAC key that never leaves a
// device: both sides sign what they send each other with it, so a server that
// saw the redemption still cannot forge a contact or swap a key.

const CONTACT_SECRET_BYTES = 16
const FINGERPRINT_BYTES = 12
// Crockford's base32: no I, L, O or U to misread.
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function newContactSecret(): Bytes {
  return randomBytes(CONTACT_SECRET_BYTES)
}

/**
 * The first 96 bits of the hash of an identity - the account's id, its sealing
 * and its signing key: enough that nobody can make another that matches. The
 * id is in it since 0.9.8: with the keys alone, a server could name any other
 * contact as a code's creator and have that contact's keys replaced by the
 * code creator's on the device redeeming it.
 */
export async function identityFingerprint(accountId: string, publicKey: Bytes, signingPublicKey: Bytes): Promise<Bytes> {
  if (!/^[0-9a-f]{32}$/.test(accountId)) throw new Error('not an account id')
  return (await sha256(concat(utf8(`mycel identity::${accountId}::`), publicKey, signingPublicKey))).slice(0, FINGERPRINT_BYTES)
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
    codeId: toHex(await hkdf(secret, 'mycel contact-id', 16)),
    redeemKey: await hkdf(secret, 'mycel contact-redeem'),
    macKey: await hkdf(secret, 'mycel contact-mac')
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

type CodeKind = 'recovery' | 'backup-invite'

/**
 * The check carries what the code is for, so a code of one kind never passes
 * for another: a recovery code typed where a backup invitation goes is a
 * typo, not a request the server counts against the address.
 */
async function codeCheck(secret: Bytes, kind: CodeKind): Promise<Bytes> {
  const label = kind === 'recovery' ? 'mycel recovery-check' : 'mycel backup-invite-check'
  const check = (await sha256(concat(utf8(label), secret))).slice(0, RECOVERY_CHECK_BYTES)
  check[RECOVERY_CHECK_BYTES - 1] &= 0xfc
  return check
}

async function encodeCode(secret: Bytes, kind: CodeKind): Promise<string> {
  const text = toBase32(concat(secret, await codeCheck(secret, kind))).slice(0, RECOVERY_CODE_CHARS)
  return (text.match(/.{1,5}/g) ?? []).join('-')
}

async function decodeCode(code: string, kind: CodeKind): Promise<Bytes | null> {
  const compact = code.replace(/[\s-]/g, '')
  if (compact.length !== RECOVERY_CODE_CHARS) return null
  const data = fromBase32(`${compact}0`)
  if (!data || data.length !== RECOVERY_SECRET_BYTES + RECOVERY_CHECK_BYTES) return null
  const secret = data.slice(0, RECOVERY_SECRET_BYTES)
  const check = await codeCheck(secret, kind)
  return check.every((byte, index) => byte === data[RECOVERY_SECRET_BYTES + index]) ? secret : null
}

/** Six groups of five characters, for writing down. */
export function encodeRecoveryCode(secret: Bytes): Promise<string> {
  return encodeCode(secret, 'recovery')
}

/** The secret behind a code, or null for anything that is not one - a typo included. */
export function decodeRecoveryCode(code: string): Promise<Bytes | null> {
  return decodeCode(code, 'recovery')
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
    recoveryKey: await hkdf(secret, 'mycel recovery-login'),
    wrapKey: await hkdf(secret, 'mycel recovery-wrap')
  }
}

// --- backup servers ------------------------------------------------------------------
//
// A device reaches a backup server through the sync server with a secret the
// two share: a one-time invitation from the backup server's operator, then a
// pairing secret of the vault's own. From each secret come a route - the
// sync server knows the backup server by it, as a hash of something derived
// from the secret - and the key of the handshake. The secret itself never
// travels, not even encrypted: encrypting it to the backup server's key would
// need that key from the sync server, which could hand out its own. Instead
// both ends prove they know it, and the session key depends on it - a
// pre-shared key, as WireGuard uses one.

/** 128 random bits: an invitation's, or a pairing's. */
export function newBackupSecret(): Bytes {
  return randomBytes(RECOVERY_SECRET_BYTES)
}

/** An invitation, written like a recovery code, for passing on. */
export function encodeBackupInvite(secret: Bytes): Promise<string> {
  return encodeCode(secret, 'backup-invite')
}

/** The secret behind an invitation, or null for anything else - a recovery code included. */
export function decodeBackupInvite(code: string): Promise<Bytes | null> {
  return decodeCode(code, 'backup-invite')
}

export interface BackupRouteKeys {
  /** Sent to the sync server when the backup server registers the route there. */
  routeToken: Bytes
  /** What the sync server and the plugin address the route by: the route token's hash, hex. */
  routeId: string
  /** Never sent. */
  psk: Bytes
}

export async function backupRouteKeys(secret: Bytes): Promise<BackupRouteKeys> {
  const routeToken = await hkdf(secret, 'mycel backup-route')
  return {
    routeToken,
    routeId: toHex(await sha256(routeToken)),
    psk: await hkdf(secret, 'mycel backup-pair')
  }
}

/** The plugin's opening: an ephemeral key and a nonce, in the clear. */
export interface SessionHello {
  e: string
  n: string
}

/** The backup server's answer, with its proof that it knows the code. */
export interface SessionAnswer {
  e: string
  n: string
  mac: string
}

/** A session's keys, one per direction, and the transcript they were made from. */
export interface SessionKeys {
  send: CryptoKey
  receive: CryptoKey
  transcript: string
}

export type SessionRole = 'plugin' | 'backup'

const NONCE_BYTES = 16

function other(role: SessionRole): SessionRole {
  return role === 'plugin' ? 'backup' : 'plugin'
}

async function sessionKeys(role: SessionRole, privateKey: CryptoKey, peer: Bytes, psk: Bytes, transcript: string): Promise<SessionKeys> {
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: await importPublicKey(peer) }, privateKey, 256))
  const material = concat(shared, psk)
  const key = async (from: SessionRole): Promise<CryptoKey> => aesKey(await hkdf(material, `mycel backup-session ${from} ${transcript}`))
  return { send: await key(role), receive: await key(other(role)), transcript }
}

/** Proves knowledge of the code for this session only: the transcript holds both fresh keys. */
export async function sessionProof(psk: Bytes, from: SessionRole, transcript: string): Promise<string> {
  return toHex(await hmac(psk, `mycel backup-proof ${from} ${transcript}`))
}

/** The plugin opens a session. Its private half stays here until `finishSession`. */
export async function openSession(): Promise<{ hello: SessionHello; pending: { privateKey: CryptoKey; publicRaw: Bytes; nonce: Bytes } }> {
  const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const nonce = randomBytes(NONCE_BYTES)
  return { hello: { e: toBase64(publicRaw), n: toBase64(nonce) }, pending: { privateKey: pair.privateKey, publicRaw, nonce } }
}

function transcriptOf(pluginKey: Bytes, pluginNonce: Bytes, backupKey: Bytes, backupNonce: Bytes): string {
  return toHex(concat(pluginKey, pluginNonce, backupKey, backupNonce))
}

/** The backup server answers a hello: its own fresh key, and a proof only the code's holder can make. */
export async function answerSession(psk: Bytes, hello: SessionHello): Promise<{ answer: SessionAnswer; keys: SessionKeys }> {
  const peer = fromBase64(hello.e)
  const peerNonce = fromBase64(hello.n)
  if (peer.length !== P256_PUBLIC_BYTES || peerNonce.length !== NONCE_BYTES) throw new Error('not a session opening')
  const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const nonce = randomBytes(NONCE_BYTES)
  const transcript = transcriptOf(peer, peerNonce, publicRaw, nonce)
  const keys = await sessionKeys('backup', pair.privateKey, peer, psk, transcript)
  return { answer: { e: toBase64(publicRaw), n: toBase64(nonce), mac: await sessionProof(psk, 'backup', transcript) }, keys }
}

/**
 * The plugin checks the answer and derives the session's keys. Throws when
 * whoever answered does not know the code - the sync server itself, say.
 */
export async function finishSession(
  psk: Bytes,
  pending: { privateKey: CryptoKey; publicRaw: Bytes; nonce: Bytes },
  answer: SessionAnswer
): Promise<SessionKeys> {
  const peer = fromBase64(answer.e)
  const peerNonce = fromBase64(answer.n)
  if (peer.length !== P256_PUBLIC_BYTES || peerNonce.length !== NONCE_BYTES) throw new Error('not a session answer')
  const transcript = transcriptOf(pending.publicRaw, pending.nonce, peer, peerNonce)
  if (!sameMac(answer.mac, await sessionProof(psk, 'backup', transcript))) {
    throw new Error('the backup server could not prove it knows the code')
  }
  return sessionKeys('plugin', pending.privateKey, peer, psk, transcript)
}

/**
 * Messages of a session, in order. Each one's associated data names its
 * direction and number, so a message replayed, dropped, reordered or sent
 * back to its sender does not open.
 */
export class SessionCipher {
  private sent = 0
  private received = 0

  constructor(
    private readonly keys: SessionKeys,
    private readonly role: SessionRole
  ) {}

  async seal(message: string): Promise<string> {
    const aad = `backup-session ${this.role} #${this.sent}`
    this.sent += 1
    return toBase64(await encrypt(this.keys.send, utf8(message), aad))
  }

  /** Messages are opened in the order they arrive; one that fails ends the session. */
  async open(data: string): Promise<string> {
    const aad = `backup-session ${other(this.role)} #${this.received}`
    this.received += 1
    return fromUtf8(await decrypt(this.keys.receive, fromBase64(data), aad))
  }
}
