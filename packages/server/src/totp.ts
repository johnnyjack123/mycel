import { createHmac, timingSafeEqual } from 'node:crypto'

// Two-factor sign-in: TOTP (RFC 6238), HMAC-SHA1, six digits, 30-second
// steps - what every authenticator app speaks. It guards the sign-in only:
// whoever reads accounts.json has the secret, but has the ciphertext anyway.

export const TOTP_STEP_MS = 30_000
export const TOTP_SECRET_BYTES = 20

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / TOTP_STEP_MS)
}

export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', secret).update(counter).digest()
  const offset = (mac[mac.length - 1] as number) & 0x0f
  const binary = mac.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 1_000_000).padStart(6, '0')
}

/**
 * The step a code was made for - now, or one either side for clocks that
 * drift - or null. A step at or before `lastStep` was used already: a code
 * seen over a shoulder is spent.
 */
export function totpMatch(secret: Buffer, code: unknown, nowMs: number, lastStep: number): number | null {
  if (typeof code !== 'string') return null
  const typed = Buffer.from(code.replace(/\s/g, ''))
  if (typed.length !== 6) return null
  const now = totpStep(nowMs)
  for (const step of [now - 1, now, now + 1]) {
    if (step <= lastStep) continue
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), typed)) return step
  }
  return null
}
