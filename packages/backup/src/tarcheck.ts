import { createHash, type Hash } from 'node:crypto'

// Reads a tar stream back - one this backup server wrote - and hashes every
// file in it: the weekly check that a files snapshot holds what it should,
// byte for byte, without a file of it ever lying whole in memory.

const BLOCK = 512

function field(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8')
}

function octal(block: Buffer, start: number, length: number): number {
  const text = field(block, start, length).trim()
  return text === '' ? 0 : Number.parseInt(text, 8)
}

function paxPath(records: Buffer): string | null {
  let offset = 0
  while (offset < records.length) {
    const space = records.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(records.subarray(offset, space).toString('ascii'), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = records.subarray(space + 1, offset + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (record.slice(0, equals) === 'path') return record.slice(equals + 1)
    offset += length
  }
  return null
}

export class TarHasher {
  /** Path -> SHA-256 of its content, hex. */
  readonly hashes = new Map<string, string>()
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private state: 'header' | 'pax' | 'data' | 'pad' | 'done' = 'header'
  private remaining = 0
  private padding = 0
  private path = ''
  private nextPath: string | null = null
  private pax: Buffer[] = []
  private hash: Hash | null = null

  write(chunk: Buffer): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    for (;;) {
      if (this.state === 'done') return
      if (this.state === 'header') {
        if (this.pending.length < BLOCK) return
        const block = this.pending.subarray(0, BLOCK)
        this.pending = this.pending.subarray(BLOCK)
        if (block.every((byte) => byte === 0)) {
          this.state = 'done'
          return
        }
        const size = octal(block, 124, 12)
        const type = field(block, 156, 1)
        const prefix = field(block, 345, 155)
        const name = field(block, 0, 100)
        this.remaining = size
        this.padding = size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK)
        if (type === 'x') {
          this.pax = []
          this.state = 'pax'
        } else {
          this.path = this.nextPath ?? (prefix ? `${prefix}/${name}` : name)
          this.nextPath = null
          this.hash = createHash('sha256')
          this.state = 'data'
        }
        continue
      }
      if (this.state === 'pax' || this.state === 'data') {
        if (this.remaining > 0) {
          if (this.pending.length === 0) return
          const take = this.pending.subarray(0, Math.min(this.remaining, this.pending.length))
          this.pending = this.pending.subarray(take.length)
          this.remaining -= take.length
          if (this.state === 'pax') this.pax.push(Buffer.from(take))
          else this.hash?.update(take)
          if (this.remaining > 0) return
        }
        if (this.state === 'pax') this.nextPath = paxPath(Buffer.concat(this.pax))
        else this.hashes.set(this.path, this.hash?.digest('hex') ?? '')
        this.state = 'pad'
        continue
      }
      if (this.state === 'pad') {
        if (this.pending.length < this.padding) return
        this.pending = this.pending.subarray(this.padding)
        this.state = 'header'
      }
    }
  }

  /** Whether the stream ended where a tar ends, not in the middle of a file. */
  get complete(): boolean {
    return this.state === 'done' || (this.state === 'header' && this.pending.length === 0)
  }
}
