import { ZxcvbnFactory, type OptionsDictionary } from '@zxcvbn-ts/core'
import * as common from '@zxcvbn-ts/language-common'
import deCommonWords from '@zxcvbn-ts/language-de/dist/commonWords.json.mjs'
import deFirstnames from '@zxcvbn-ts/language-de/dist/firstnames.json.mjs'
import deLastnames from '@zxcvbn-ts/language-de/dist/lastnames.json.mjs'
import deSequences from '@zxcvbn-ts/language-de/dist/wordSequences.json.mjs'
import enCommonWords from '@zxcvbn-ts/language-en/dist/commonWords.json.mjs'
import enFirstnames from '@zxcvbn-ts/language-en/dist/firstnames.json.mjs'
import enSequences from '@zxcvbn-ts/language-en/dist/wordSequences.json.mjs'
import translations from '@zxcvbn-ts/language-en/dist/translations.mjs'

// The password is the only secret. Name and password together are what finds
// an account, the master key comes from it, and nobody can reset it - so a
// password someone could guess is refused, however long it is. Checked here
// only: the server never sees a password, and a client that skips the check
// harms nobody but its own account.

export const MIN_LENGTH = 12
/**
 * Estimated guesses, as a power of ten. With Argon2id at 64 MiB every guess
 * costs about a second of work, so 10^12 guesses is far beyond any attacker
 * guessing online or offline.
 */
export const MIN_GUESSES_LOG10 = 12

let factory: ZxcvbnFactory | null = null

// Leaked passwords, and the words and names people build passwords from, in
// English and German. Left out: the Wikipedia lists and the English surnames
// - about 1.4 MB of the bundle for little that the rest does not catch.
const dictionary = {
  ...common.dictionary,
  'commonWords-en': enCommonWords,
  'firstnames-en': enFirstnames,
  ...(enSequences as Record<string, string[]>),
  'commonWords-de': deCommonWords,
  'firstnames-de': deFirstnames,
  'lastnames-de': deLastnames,
  ...(deSequences as Record<string, string[]>)
} as OptionsDictionary

/** Built on first use: the dictionaries are large, and most sessions never need them. */
function estimator(): ZxcvbnFactory {
  factory ??= new ZxcvbnFactory({
    dictionary,
    graphs: common.adjacencyGraphs,
    translations,
    useLevenshteinDistance: true
  })
  return factory
}

export interface PasswordVerdict {
  ok: boolean
  /** Why not, in words a person can act on. */
  reason?: string
}

/** `context`: words the password must not lean on, such as the name. */
export function judgePassword(password: string, context: string[] = []): PasswordVerdict {
  if (password.length < MIN_LENGTH) return { ok: false, reason: `Use at least ${MIN_LENGTH} characters.` }
  const result = estimator().check(password, context.filter((word) => word.length > 0))
  if (result.guessesLog10 < MIN_GUESSES_LOG10) {
    const hint = result.feedback.warning ?? result.feedback.suggestions[0] ?? ''
    return {
      ok: false,
      reason: `This password is too easy to guess${hint ? ` (${hint.replace(/\.$/, '')})` : ''}. Try the generator.`
    }
  }
  return { ok: true }
}

// Letters and digits people do not confuse when typing one off a screen:
// no 0 and O, no 1, l and I. 57 characters, about 5.8 bits each.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
const GROUPS = 4
const GROUP_LENGTH = 5

/** A byte uniformly from 0 to `ALPHABET.length - 1`: rejection keeps every character equally likely. */
function randomIndex(): number {
  const limit = 256 - (256 % ALPHABET.length)
  const byte = new Uint8Array(1)
  for (;;) {
    crypto.getRandomValues(byte)
    const value = byte[0] as number
    if (value < limit) return value % ALPHABET.length
  }
}

/** 20 random characters in groups of five, joined by dashes that are part of it: about 117 bits. */
export function generatePassword(): string {
  const groups: string[] = []
  for (let group = 0; group < GROUPS; group += 1) {
    let part = ''
    for (let i = 0; i < GROUP_LENGTH; i += 1) part += ALPHABET[randomIndex()]
    groups.push(part)
  }
  return groups.join('-')
}
