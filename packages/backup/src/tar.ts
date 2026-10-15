import { once } from 'node:events'
import type { Writable } from 'node:stream'

// A tar stream (POSIX pax), written as it goes: attachments travel into
// restic this way, one at a time, so a vault full of pictures never lies in
// memory whole. Any tar reads it back - GNU tar, bsdtar, 7-Zip.

const BLOCK = 512
const encoder = new TextEncoder()

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

function header(name: string, size: number, mtimeSeconds: number, type: '0' | 'x', prefix = ''): Buffer {
  const block = Buffer.alloc(BLOCK)
  block.write(name, 0, 100, 'utf8')
  block.write(octal(0o644, 8), 100, 8, 'ascii')
  block.write(octal(0, 8), 108, 8, 'ascii')
  block.write(octal(0, 8), 116, 8, 'ascii')
  block.write(octal(size, 12), 124, 12, 'ascii')
  block.write(octal(mtimeSeconds, 12), 136, 12, 'ascii')
  // The checksum is taken with its own field as spaces.
  block.write('        ', 148, 8, 'ascii')
  block.write(type, 156, 1, 'ascii')
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  block.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return block
}

/** A pax record: its own length counts itself, digits included. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  let length = encoder.encode(body).length
  let digits = String(length).length
  while (String(length + digits).length !== digits) digits += 1
  length += digits
  return `${length}${body}`
}

function padding(size: number): Buffer {
  const rest = size % BLOCK
  return Buffer.alloc(rest === 0 ? 0 : BLOCK - rest)
}

/** Whether the name fits a plain ustar header: ASCII, and short enough. */
function plain(name: string): boolean {
  return name.length <= 100 && /^[\x20-\x7e]*$/.test(name)
}

export class TarWriter {
  private written = 0

  constructor(private readonly out: Writable) {}

  /** Bytes put into the stream so far. */
  get bytes(): number {
    return this.written
  }

  private async put(data: Uint8Array): Promise<void> {
    if (data.length === 0) return
    if (this.out.destroyed || this.out.writableEnded) throw new Error('the stream was closed')
    this.written += data.length
    // A reader that went away never drains; waiting for it would hang the run.
    if (!this.out.write(data)) {
      const listening = new AbortController()
      try {
        await Promise.race([
          once(this.out, 'drain', { signal: listening.signal }),
          once(this.out, 'close', { signal: listening.signal }).then(() => {
            throw new Error('the stream was closed')
          })
        ])
      } finally {
        listening.abort()
      }
    }
  }

  /**
   * One file. `chunks` must yield exactly `size` bytes: the header has
   * promised them, and a stream with any other count is broken from there on.
   */
  async file(path: string, size: number, mtimeMs: number, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    const mtime = Math.max(0, Math.floor(mtimeMs / 1000))
    if (!plain(path)) {
      const records = encoder.encode(paxRecord('path', path))
      await this.put(header('PaxHeader', records.length, mtime, 'x'))
      await this.put(records)
      await this.put(padding(records.length))
    }
    // With a pax header in front the plain name is only a fallback for very old readers.
    const fallback = plain(path) ? path : path.replace(/[^\x20-\x7e]/g, '_').slice(-100)
    await this.put(header(fallback, size, mtime, '0'))
    let count = 0
    for await (const chunk of chunks) {
      count += chunk.length
      if (count > size) throw new Error(`${path} is longer than its header says`)
      await this.put(chunk)
    }
    if (count !== size) throw new Error(`${path} is shorter than its header says`)
    await this.put(padding(size))
  }

  /** Two empty blocks close an archive. */
  async end(): Promise<void> {
    await this.put(Buffer.alloc(BLOCK * 2))
  }
}
