// Measures what the sync layer costs on a synthetic vault: the first upload, a
// new device's first sync, a restart, a note held open, a keystroke online and
// offline, a week of another device's changes, and an idle minute. It measures
// and reports; it changes nothing in the plugin. The two devices and the server
// each run in a process of their own, so one's memory and CPU are not counted
// for the other; the server listens on a port the OS picks and keeps its data in
// a new folder under the OS temp dir - never 1234, never packages/server/data.
//
//   npm run bench                                   # 1,000/400 and 5,000/2,000 notes/files
//   npm run bench -- --sizes 5000:2000 --scenarios typing,offline
//   npm run bench -- --profile                      # a .cpuprofile per scenario, top functions by self time
//   npm run bench -- --heap-profile                 # instead: bytes allocated per function, the collected ones included
//   npm run bench -- --store harness                # the self-tests' IndexedDB stand-in instead of the y-indexeddb model
//
// Options: --sizes N:M,...  --scenarios all|memory,typing,offline,catchup,idle,micro (upload, join and
// restart always run)  --restarts 3  --keystrokes 2000  --interval 60 (ms between keystrokes online)
// --offline 2000,10000,20000  --catchup-frames 20000  --catchup-notes 500  --idle 60 (s)  --tick 1000
// (ms, the per-minute passes shortened)  --every-size (memory, typing, offline at every size, not only
// the largest)  --out <dir>  --keep (the server's data folder stays)  --profile  --heap-profile
// --store ylike|harness.
//
// Results: a summary on stdout and everything in <out>/results.json, the
// devices' and the server's logs next to it. docs/PERFORMANCE.md says how to
// read them and what they cannot say.
import { fork, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { Session } from 'node:inspector/promises'
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import type { Doc as YDoc } from 'yjs'

const HERE = fileURLToPath(import.meta.url)
const REPO = resolve(HERE, '../../../..')
const MB = 1024 * 1024

// --- options ------------------------------------------------------------------------

function option(name: string): string | undefined {
  for (let i = 2; i < process.argv.length; i += 1) {
    const value = process.argv[i] as string
    if (value === `--${name}`) {
      const next = process.argv[i + 1]
      return next !== undefined && !next.startsWith('--') ? next : ''
    }
    if (value.startsWith(`--${name}=`)) return value.slice(name.length + 3)
  }
  return undefined
}

const flag = (name: string): boolean => option(name) !== undefined
const numberOption = (name: string, fallback: number): number => {
  const value = option(name)
  return value ? Number(value) : fallback
}

// --- small helpers ---------------------------------------------------------------------

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
const round = (value: number, digits = 1): number => Math.round(value * 10 ** digits) / 10 ** digits

interface Stats {
  n: number
  mean: number
  p50: number
  p90: number
  p99: number
  max: number
}

function stats(values: number[]): Stats {
  if (values.length === 0) return { n: 0, mean: 0, p50: 0, p90: 0, p99: 0, max: 0 }
  const sorted = values.slice().sort((a, b) => a - b)
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number
  return {
    n: values.length,
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length, 4),
    p50: round(at(0.5), 4),
    p90: round(at(0.9), 4),
    p99: round(at(0.99), 4),
    max: round(sorted[sorted.length - 1] as number, 4)
  }
}

/** The same sequence everywhere: the plan of the vault is computed again by every process. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// --- the synthetic vault -----------------------------------------------------------------

interface VaultPlan {
  notes: Array<{ path: string; bytes: number }>
  files: Array<{ path: string; bytes: number; kind: string }>
}

/**
 * Notes mostly 1-10 KB with a tail to 30 KB and 1 % around 100 KB; files mostly
 * small images, some larger ones, PDFs and a few multi-megabyte ones, and canvases.
 */
function planVault(noteCount: number, fileCount: number): VaultPlan {
  const random = rng(7)
  const notes = Array.from({ length: noteCount }, (_, i) => {
    const r = random()
    const bytes = r < 0.6 ? 1024 + random() * 2048 : r < 0.9 ? 3072 + random() * 7168 : r < 0.99 ? 10240 + random() * 20480 : 81920 + random() * 40960
    return { path: `Area ${i % 20}/Topic ${i % 100}/Note ${i}.md`, bytes: Math.round(bytes) }
  })
  const files = Array.from({ length: fileCount }, (_, i) => {
    const k = random()
    const kind = k < 0.5 ? 'png' : k < 0.8 ? 'jpg' : k < 0.95 ? 'pdf' : 'canvas'
    const r = random()
    const bytes = r < 0.7 ? 4096 + random() * 12288 : r < 0.95 ? 32768 + random() * 98304 : r < 0.996 ? 262144 + random() * 786432 : 2 * MB + random() * 2 * MB
    return { path: `Attachments/${kind}/file-${i}.${kind}`, bytes: Math.round(kind === 'canvas' ? Math.min(bytes, 65536) : bytes), kind }
  })
  return { notes, files }
}

const WORDS = (
  'the a of and to in sync note vault garden river stone light memory paper window letter morning evening field forest city ' +
  'market bridge harbor engine signal pattern theory method reason question answer draft idea plan task meeting project review ' +
  'summary detail example problem solution change version history server device editor caret merge conflict backup folder file'
).split(' ')

function words(random: () => number, count: number): string {
  return Array.from({ length: count }, () => WORDS[Math.floor(random() * WORDS.length)]).join(' ')
}

function noteText(index: number, bytes: number, random: () => number, plan: VaultPlan): string {
  const parts = [`# Note ${index}\n\n`]
  let length = (parts[0] as string).length
  while (length < bytes) {
    const kind = random()
    let block: string
    if (kind < 0.12) block = `## ${words(random, 3)}\n\n`
    else if (kind < 0.27) {
      block = `${Array.from({ length: 2 + Math.floor(random() * 4) }, () => `- ${words(random, 4 + Math.floor(random() * 8))}`).join('\n')}\n\n`
    } else if (kind < 0.31 && plan.files.length > 0) {
      const file = plan.files[Math.floor(random() * plan.files.length)] as { path: string }
      block = `![[${file.path.split('/').pop()}]]\n\n`
    } else {
      const link = random() < 0.4 ? ` [[Note ${Math.floor(random() * plan.notes.length)}]]` : ''
      block = `${words(random, 30 + Math.floor(random() * 90))}${link}.\n\n`
    }
    parts.push(block)
    length += block.length
  }
  return parts.join('').slice(0, bytes)
}

function canvasText(bytes: number, random: () => number): string {
  const nodes: string[] = []
  let length = 40
  for (let i = 0; length < bytes; i += 1) {
    const node = JSON.stringify({ id: `n${i}`, type: 'text', text: words(random, 12), x: i * 40, y: i * 20, width: 250, height: 60 })
    nodes.push(node)
    length += node.length + 1
  }
  return `{"nodes":[${nodes.join(',')}],"edges":[]}`
}

function buildVault(plan: VaultPlan): Record<string, string | Uint8Array> {
  const random = rng(42)
  const files: Record<string, string | Uint8Array> = {}
  plan.notes.forEach((note, index) => {
    files[note.path] = noteText(index, note.bytes, random, plan)
  })
  for (const file of plan.files) {
    // Images and PDFs are as good as random to everything that reads them.
    files[file.path] = file.kind === 'canvas' ? new TextEncoder().encode(canvasText(file.bytes, random)) : new Uint8Array(randomBytes(file.bytes))
  }
  return files
}

/** Which notes each scenario uses: disjoint where one scenario edits what another measures. */
function pickNotes(plan: VaultPlan, catchupNotes: number) {
  const n = plan.notes.length
  const longCount = Math.min(100, Math.floor(n / 10))
  const typingRange = plan.notes.slice(longCount, longCount + 100)
  const mid = typingRange.filter((note) => note.bytes >= 4000 && note.bytes <= 7000).map((note) => note.path)
  const large =
    plan.notes.slice(longCount).find((note) => note.bytes >= 80000)?.path ??
    plan.notes.slice(longCount).reduce((best, note) => (note.bytes > best.bytes ? note : best)).path
  const shortStart = longCount + 100
  return {
    long: plan.notes.slice(0, longCount).map((note) => note.path),
    typing: mid,
    large,
    short: plan.notes.slice(shortStart, shortStart + Math.min(500, Math.max(0, n - shortStart))).map((note) => note.path),
    catchup: plan.notes.slice(n - Math.min(catchupNotes, Math.floor(n / 2))).map((note) => note.path)
  }
}

// --- profiles ----------------------------------------------------------------------------

interface ProfileNode {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
}

interface CpuProfile {
  nodes: ProfileNode[]
  samples?: number[]
  timeDeltas?: number[]
}

interface ProfileSummary {
  file: string
  busyMs: number
  idleMs: number
  top: Array<{ fn: string; ms: number; pct: number; category: string }>
  categories: Array<{ category: string; ms: number; pct: number }>
}

function shortUrl(url: string): string {
  const path = url.startsWith('file:///') ? decodeURIComponent(url.slice(8)) : url
  const normalized = path.replace(/\\/g, '/')
  const root = REPO.replace(/\\/g, '/')
  return normalized.toLowerCase().startsWith(root.toLowerCase()) ? normalized.slice(root.length + 1) : normalized
}

function category(url: string, fn: string): string {
  if (fn === '(garbage collector)') return 'GC'
  if (fn === '(idle)') return 'idle'
  // The profiler stopping and serializing itself.
  if (url.startsWith('node:inspector')) return 'profiler'
  // A device's stdout is its log file, written synchronously: the plugin's log lines.
  if (fn === 'writeBuffer' || fn === 'writeUtf8String' || fn === 'writeString') return 'log output'
  if (fn === '(program)') return 'native / VM'
  if (fn === '(root)') return 'other'
  if (/node_modules\/(yjs|lib0|y-protocols)\//.test(url)) return 'Yjs / lib0'
  if (url.includes('shared/src/crypto')) return 'crypto, JS side'
  if (url.includes('node:internal/crypto') || url.includes('node:crypto')) return 'crypto, Node glue'
  if (/node_modules\/(@codemirror|@lezer|style-mod|w3c-keyname|crelt)\//.test(url)) return 'CodeMirror'
  if (/node_modules\/(jsdom|nwsapi|cssstyle|parse5|whatwg-url|tough-cookie|@asamuzakjp|rrweb-cssom|cssom)/.test(url)) return 'jsdom'
  if (url.includes('scripts/stubs/fake-vault')) return 'harness stand-ins'
  if (url.includes('scripts/bench') && fn.startsWith('ylike')) return 'IndexedDB stand-in'
  if (url.includes('scripts/')) return 'bench / harness'
  if (url.includes('packages/server/')) return 'server'
  if (url.includes('packages/plugin/src/')) return 'plugin'
  if (url.includes('packages/shared/src/')) return 'shared (diff, merge, protocol)'
  if (url.includes('undici') || url.includes('websocket')) return 'WebSocket / HTTP'
  if (url.includes('node_modules/')) return 'other libraries'
  if (url.startsWith('node:')) return 'Node internals'
  return url === '' ? 'native functions' : 'other'
}

function summarize(profile: CpuProfile, file: string): ProfileSummary {
  const self = new Map<number, number>()
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  for (let i = 0; i < samples.length; i += 1) self.set(samples[i] as number, (self.get(samples[i] as number) ?? 0) + (deltas[i] ?? 0))
  const byFunction = new Map<string, { us: number; category: string }>()
  const byCategory = new Map<string, number>()
  let idle = 0
  let busy = 0
  for (const node of profile.nodes) {
    const us = self.get(node.id) ?? 0
    if (us === 0) continue
    const { functionName, url, lineNumber } = node.callFrame
    const cat = category(shortUrl(url), functionName)
    if (cat === 'idle') {
      idle += us
      continue
    }
    if (cat === 'profiler') continue
    busy += us
    const key = `${functionName || '(anonymous)'} ${url ? `${shortUrl(url)}:${lineNumber + 1}` : ''}`.trim()
    const entry = byFunction.get(key) ?? { us: 0, category: cat }
    entry.us += us
    byFunction.set(key, entry)
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + us)
  }
  const pct = (us: number): number => (busy === 0 ? 0 : round((100 * us) / busy, 1))
  return {
    file,
    busyMs: round(busy / 1000, 0),
    idleMs: round(idle / 1000, 0),
    top: Array.from(byFunction, ([fn, entry]) => ({ fn, ms: round(entry.us / 1000, 0), pct: pct(entry.us), category: entry.category }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 15),
    categories: Array.from(byCategory, ([cat, us]) => ({ category: cat, ms: round(us / 1000, 0), pct: pct(us) })).sort((a, b) => b.ms - a.ms)
  }
}

interface HeapNode {
  callFrame: { functionName: string; url: string; lineNumber: number }
  selfSize: number
  children: HeapNode[]
}

interface AllocationSummary {
  file: string
  totalMB: number
  top: Array<{ fn: string; mb: number; pct: number; category: string }>
}

/** Bytes allocated per function, the collected ones included: what churns the heap, not what stays. */
function summarizeAllocations(head: HeapNode, file: string): AllocationSummary {
  const byFunction = new Map<string, { bytes: number; category: string }>()
  let total = 0
  const walk = (node: HeapNode): void => {
    if (node.selfSize > 0) {
      const { functionName, url, lineNumber } = node.callFrame
      const key = `${functionName || '(anonymous)'} ${url ? `${shortUrl(url)}:${lineNumber + 1}` : ''}`.trim()
      const entry = byFunction.get(key) ?? { bytes: 0, category: category(shortUrl(url), functionName) }
      entry.bytes += node.selfSize
      byFunction.set(key, entry)
      total += node.selfSize
    }
    for (const child of node.children) walk(child)
  }
  walk(head)
  return {
    file,
    totalMB: round(total / MB, 0),
    top: Array.from(byFunction, ([fn, entry]) => ({ fn, mb: round(entry.bytes / MB, 1), pct: round((100 * entry.bytes) / Math.max(1, total), 1), category: entry.category }))
      .sort((a, b) => b.mb - a.mb)
      .slice(0, 15)
  }
}

/** The inspector in this very process: no port, no second process attached. */
class Profiler {
  private session: Session | null = null
  private heap = false

  async start(heap = false): Promise<void> {
    const session = new Session()
    session.connect()
    this.heap = heap
    if (heap) {
      await session.post('HeapProfiler.enable')
      await session.post('HeapProfiler.startSampling', {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true
      } as never)
    } else {
      await session.post('Profiler.enable')
      await session.post('Profiler.setSamplingInterval', { interval: 250 })
      await session.post('Profiler.start')
    }
    this.session = session
  }

  async stop(file: string): Promise<ProfileSummary | AllocationSummary | undefined> {
    const session = this.session
    if (!session) return undefined
    this.session = null
    if (this.heap) {
      const { profile } = (await session.post('HeapProfiler.stopSampling')) as unknown as { profile: { head: HeapNode } }
      session.disconnect()
      const heapFile = file.replace(/\.cpuprofile$/, '.heapprofile')
      writeFileSync(heapFile, JSON.stringify(profile))
      return summarizeAllocations(profile.head, heapFile)
    }
    const { profile } = (await session.post('Profiler.stop')) as { profile: CpuProfile }
    session.disconnect()
    writeFileSync(file, JSON.stringify(profile))
    return summarize(profile, file)
  }
}

// --- talking between the processes ---------------------------------------------------------

type Handler = (args: never) => unknown
interface Reply {
  id?: number
  ok?: boolean
  result?: unknown
  error?: string
  progress?: string
  ready?: boolean
}

function serve(handlers: Record<string, Handler>): void {
  process.on('message', (message: { id: number; cmd: string; args?: unknown }) => {
    void (async () => {
      try {
        const handler = handlers[message.cmd]
        if (!handler) throw new Error(`no command ${message.cmd}`)
        const result = await handler(message.args as never)
        process.send?.({ id: message.id, ok: true, result })
      } catch (error) {
        process.send?.({ id: message.id, ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) })
      }
    })()
  })
  process.send?.({ ready: true })
}

function progress(text: string): void {
  process.send?.({ progress: text })
}

interface Rpc {
  name: string
  child: ChildProcess
  call<T = unknown>(cmd: string, args?: unknown): Promise<T>
}

function spawnRole(role: string, name: string, args: string[], logFile: string): Promise<Rpc> {
  const log = openSync(logFile, 'a')
  // The same loader, tsconfig and --expose-gc this process was started with.
  const child = fork(HERE, ['--role', role, ...args], { execArgv: process.execArgv, stdio: ['ignore', log, log, 'ipc'] })
  let next = 1
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  return new Promise((resolveReady, rejectReady) => {
    child.on('message', (message: Reply) => {
      if (message.ready) {
        resolveReady({
          name,
          child,
          call: <T,>(cmd: string, callArgs?: unknown) =>
            new Promise<T>((resolveCall, rejectCall) => {
              const id = next
              next += 1
              pending.set(id, { resolve: resolveCall as (value: unknown) => void, reject: rejectCall })
              child.send({ id, cmd, args: callArgs })
            })
        })
        return
      }
      if (message.progress) {
        console.log(`    [${name}] ${message.progress}`)
        return
      }
      const waiter = message.id === undefined ? undefined : pending.get(message.id)
      if (!waiter || message.id === undefined) return
      pending.delete(message.id)
      if (message.ok) waiter.resolve(message.result)
      else waiter.reject(new Error(`${name}: ${message.error}`))
    })
    child.on('exit', (code) => {
      rejectReady(new Error(`${name} exited with ${code} before it was ready (see ${logFile})`))
      for (const waiter of pending.values()) waiter.reject(new Error(`${name} exited with ${code} (see ${logFile})`))
      pending.clear()
    })
  })
}

// --- measuring, in a device's or the server's process -----------------------------------------

interface MemorySnapshot {
  rssMB: number
  heapUsedMB: number
  heapTotalMB: number
  externalMB: number
  arrayBuffersMB: number
  [extra: string]: number
}

function memoryNow(): MemorySnapshot {
  const usage = process.memoryUsage()
  return {
    rssMB: round(usage.rss / MB),
    heapUsedMB: round(usage.heapUsed / MB),
    heapTotalMB: round(usage.heapTotal / MB),
    externalMB: round(usage.external / MB),
    arrayBuffersMB: round(usage.arrayBuffers / MB)
  }
}

async function collectGarbage(): Promise<void> {
  const gc = (globalThis as { gc?: () => void }).gc
  if (!gc) return
  for (let i = 0; i < 3; i += 1) {
    gc()
    await new Promise((done) => setImmediate(done))
  }
}

type Counters = { [key: string]: number | Counters }

function cloneCounters(counters: Counters): Counters {
  return JSON.parse(JSON.stringify(counters)) as Counters
}

function diffCounters(after: Counters, before: Counters): Counters {
  const out: Counters = {}
  for (const [key, value] of Object.entries(after)) {
    const earlier = before[key]
    if (typeof value === 'number') {
      const delta = value - (typeof earlier === 'number' ? earlier : 0)
      if (delta !== 0) out[key] = round(delta, 0)
    } else {
      const inner = diffCounters(value, typeof earlier === 'object' ? earlier : {})
      if (Object.keys(inner).length > 0) out[key] = inner
    }
  }
  return out
}

interface Measured {
  name: string
  wallMs: number
  cpuMs: { user: number; system: number }
  /**
   * Delay of the event loop from the moment the sign-in finished, if one did
   * (Argon2id runs on the main thread and blocks it by design); `signInMaxMs`
   * the longest block up to then. On Windows timers tick every ~15.6 ms, so
   * anything up to about that is the clock, not the code.
   */
  eventLoop: { maxMs: number; p99Ms: number; meanMs: number; signInMaxMs?: number }
  peak: { rssMB: number; heapUsedMB: number; [extra: string]: number }
  before: MemorySnapshot
  after: MemorySnapshot
  counters: Counters
  marks: Record<string, number>
  /** CPU by self time, or with `--heap-profile` bytes allocated by function. */
  profile?: ProfileSummary | AllocationSummary
}

interface MeasureContext {
  counters: Counters
  profiler: Profiler
  profiling: boolean
  /** Allocations instead of CPU (`--heap-profile`). */
  heapProfiling: boolean
  profileFile: (name: string) => string
  /** Memory the stand-ins hold - the vault's files, the IndexedDB stand-in - added to every snapshot. */
  extraMemory: () => Record<string, number>
}

async function measure(
  context: MeasureContext,
  name: string,
  run: (mark: (label: string, at?: number) => void) => Promise<void>,
  sample?: () => Record<string, number>
): Promise<Measured> {
  await collectGarbage()
  const before = { ...memoryNow(), ...context.extraMemory() }
  const counters = cloneCounters(context.counters)
  const peak: Measured['peak'] = { rssMB: before.rssMB, heapUsedMB: before.heapUsedMB }
  const sampler = setInterval(() => {
    const usage = process.memoryUsage()
    peak.rssMB = Math.max(peak.rssMB, round(usage.rss / MB))
    peak.heapUsedMB = Math.max(peak.heapUsedMB, round(usage.heapUsed / MB))
    for (const [key, value] of Object.entries(sample?.() ?? {})) peak[key] = Math.max(peak[key] ?? 0, value)
  }, 50)
  const loop = monitorEventLoopDelay({ resolution: 10 })
  const profiling = context.profiling || context.heapProfiling
  if (profiling) await context.profiler.start(context.heapProfiling)
  const marks: Record<string, number> = {}
  const cpu = process.cpuUsage()
  const started = performance.now()
  let signInMaxMs: number | undefined
  loop.enable()
  try {
    await run((label, at) => {
      marks[label] = round((at ?? performance.now()) - started, 0)
      if (label === 'login') {
        signInMaxMs = round(loop.max / 1e6, 1)
        loop.reset()
      }
    })
  } finally {
    loop.disable()
    clearInterval(sampler)
  }
  const wallMs = round(performance.now() - started, 0)
  const used = process.cpuUsage(cpu)
  const profile = profiling ? await context.profiler.stop(context.profileFile(name)) : undefined
  await collectGarbage()
  return {
    name,
    wallMs,
    cpuMs: { user: round(used.user / 1000, 0), system: round(used.system / 1000, 0) },
    eventLoop: { maxMs: round(loop.max / 1e6, 1), p99Ms: round(loop.percentile(99) / 1e6, 1), meanMs: round(loop.mean / 1e6, 2), signInMaxMs },
    peak,
    before,
    after: { ...memoryNow(), ...context.extraMemory() },
    counters: diffCounters(context.counters, counters),
    marks,
    profile
  }
}

// --- the server's process ------------------------------------------------------------------------

function diskUsage(dir: string): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const inner = join(path, entry.name)
      if (entry.isDirectory()) walk(inner)
      else {
        bytes += statSync(inner).size
        files += 1
      }
    }
  }
  walk(dir)
  return { bytes, files }
}

async function serverRole(): Promise<void> {
  const dataDir = option('data') as string
  const { loadConfig } = await import('../../server/src/config.js')
  const { startServer } = await import('../../server/src/server.js')
  const server = await startServer(
    loadConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      MYCEL_DATA_DIR: dataDir,
      MYCEL_REGISTRATION: 'open',
      MYCEL_JWT_SECRET: 'mycel-bench-secret-of-well-over-32-characters',
      MYCEL_MAX_FILE_MB: '100'
    }),
    { logger: false }
  )
  const profiler = new Profiler()
  serve({
    port: () => ({ port: server.port }),
    stats: () => ({ cpu: process.cpuUsage(), memory: memoryNow() }),
    disk: () => diskUsage(dataDir),
    profileStart: (args: { heap?: boolean } | undefined) => profiler.start(args?.heap ?? false),
    profileStop: (args: { file: string }) => profiler.stop(args.file),
    stop: async () => {
      await server.close()
      setTimeout(() => process.exit(0), 50)
    }
  })
}

// --- a device's process ------------------------------------------------------------------------

async function deviceRole(): Promise<void> {
  const counters: Counters = {
    crypto: {},
    wsOut: {},
    wsIn: {},
    http: { requests: 0, bytesOut: 0, bytesIn: 0 },
    vault: { reads: 0, writes: 0, creates: 0, readBytes: 0 },
    adapter: { writes: 0, writeBytes: 0, reads: 0, exists: 0 },
    history: { adds: 0 },
    cursor: { indexFlushes: 0, indexBytes: 0, otherFlushes: 0, otherBytes: 0 },
    race: { overlappingSendNext: 0, ackClearsAnotherPayload: 0, bytesNeverSent: 0 }
  }
  const bump = (group: string, key: string, by = 1): void => {
    const inner = counters[group] as Counters
    inner[key] = ((inner[key] as number | undefined) ?? 0) + by
  }

  // WebCrypto, counted by what it does: the work itself runs on libuv's threads.
  const subtle = Object.getPrototypeOf(globalThis.crypto.subtle) as Record<string, (...args: unknown[]) => unknown>
  for (const method of ['encrypt', 'decrypt', 'sign', 'verify', 'digest', 'importKey', 'deriveBits', 'exportKey', 'generateKey']) {
    const original = subtle[method] as (...args: unknown[]) => unknown
    subtle[method] = function (this: unknown, ...args: unknown[]) {
      const algorithm = args[0] as string | { name?: string }
      bump('crypto', `${method}:${typeof algorithm === 'string' ? algorithm : (algorithm?.name ?? '?')}`)
      return original.apply(this, args)
    }
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    bump('http', 'requests')
    const body = init?.body
    if (body instanceof Uint8Array) bump('http', 'bytesOut', body.byteLength)
    else if (typeof body === 'string') bump('http', 'bytesOut', body.length)
    const response = await realFetch(input, init)
    bump('http', 'bytesIn', Number(response.headers.get('content-length') ?? 0))
    return response
  }) as typeof fetch

  const Y = await import('yjs')
  const shared = await import('@mycel/shared')
  const { toBase64 } = await import('@mycel/shared/crypto')
  const muxName = new Map<number, string>(Object.entries(shared.MUX).map(([key, value]) => [value as number, key]))
  const socketProto = globalThis.WebSocket.prototype as unknown as { send(data: unknown): void }
  const realSend = socketProto.send
  socketProto.send = function (this: unknown, data: unknown) {
    if (data instanceof Uint8Array) {
      const type = muxName.get(data[0] as number) ?? `type${data[0]}`
      bump('wsOut', `${type}`)
      bump('wsOut', `${type}Bytes`, data.byteLength)
    }
    return realSend.call(this, data)
  }

  const harness = await import('./harness.mjs')
  const { VaultSocket } = await import('../src/sync/VaultSocket.js')
  const { entryKey } = await import('../src/sync/History.js')
  const { EDITOR_ORIGIN } = await import('../src/sync/origin.js')
  type HistoryStore = import('../src/sync/History.js').HistoryStore
  type HistoryEntry = import('../src/sync/History.js').HistoryEntry
  type LocalStore = import('../src/sync/DocHandle.js').LocalStore
  type Device = InstanceType<typeof harness.Device>

  // What every write of a room's cursor serializes: its unacknowledged changes, base64 in JSON.
  const { LocalCursor } = await import('../src/sync/DocHandle.js')
  const cursorProto = LocalCursor.prototype as unknown as { flush(): Promise<void> }
  const realFlush = cursorProto.flush
  cursorProto.flush = function (this: { sending: Uint8Array | null; outbox: Uint8Array | null }) {
    const index = (device?.store as unknown as { indexCursor?: unknown } | null)?.indexCursor === this
    bump('cursor', index ? 'indexFlushes' : 'otherFlushes')
    bump('cursor', index ? 'indexBytes' : 'otherBytes', (this.sending?.length ?? 0) + (this.outbox?.length ?? 0))
    return realFlush.call(this)
  }

  // Every change of the vault index the server acknowledged: whether they rebuild this device's index is checked after the upload.
  const indexAcked: Uint8Array[] = []

  /** Clients whose changes a document waits for: some clock range of theirs never arrived. */
  function waitingFor(doc: YDoc): Record<string, number> {
    const pending = (doc.store as unknown as { pendingStructs: { missing: Map<number, number> } | null }).pendingStructs
    return pending ? Object.fromEntries(Array.from(pending.missing, ([client, clock]) => [String(client), clock])) : {}
  }

  const decoding = await import('lib0/decoding')
  type Sending = { inflight: number | null; inflightFrame: { payload: Uint8Array } | null; options: { cursor: { sending: Uint8Array | null } } }
  const vaultSocketProto = VaultSocket.prototype as unknown as {
    receive(message: Uint8Array): void
    sendNext(registration: unknown): Promise<void>
  }
  const realReceive = vaultSocketProto.receive
  vaultSocketProto.receive = function (this: { registrations: Map<string, Sending> }, message: Uint8Array) {
    const type = muxName.get(message[0] as number) ?? `type${message[0]}`
    bump('wsIn', type)
    bump('wsIn', `${type}Bytes`, message.length)
    if (message[0] === shared.MUX.ack) {
      // The acknowledgement clears `cursor.sending`: it must be for what `cursor.sending` holds, or that is never sent.
      const decoder = decoding.createDecoder(message)
      decoding.readVarUint(decoder)
      const room = decoding.readVarString(decoder)
      const registration = this.registrations.get(room)
      const ref = decoding.readVarUint(decoder)
      const sending = registration?.options.cursor.sending ?? null
      if (registration && registration.inflight === ref && registration.inflightFrame) {
        if (room.startsWith('idx:')) indexAcked.push(registration.inflightFrame.payload.slice())
        if (sending !== registration.inflightFrame.payload) {
          bump('race', 'ackClearsAnotherPayload')
          bump('race', 'bytesNeverSent', sending?.length ?? 0)
        }
      }
    }
    return realReceive.call(this, message)
  }
  // Two `sendNext` of one room at once: the second can send what the first already sent.
  const sendingNow = new WeakMap<object, number>()
  const realSendNext = vaultSocketProto.sendNext
  vaultSocketProto.sendNext = async function (this: unknown, registration: object) {
    const running = (sendingNow.get(registration) ?? 0) + 1
    sendingNow.set(registration, running)
    if (running > 1) bump('race', 'overlappingSendNext')
    try {
      return await realSendNext.call(this, registration)
    } finally {
      sendingNow.set(registration, (sendingNow.get(registration) ?? 1) - 1)
    }
  }

  /** The device's own history, as the harness keeps it, with what it holds counted. */
  class CountingHistory implements HistoryStore {
    readonly rooms = new Map<string, Map<string, HistoryEntry>>()
    bytes = 0
    add(room: string, entry: HistoryEntry): void {
      bump('history', 'adds')
      let entries = this.rooms.get(room)
      if (!entries) {
        entries = new Map()
        this.rooms.set(room, entries)
      }
      const key = entryKey(entry)
      const previous = entries.get(key)
      if (previous) this.bytes -= previous.update.length
      entries.set(key, { authorTs: entry.authorTs, update: entry.update.slice() })
      this.bytes += entry.update.length
    }
    async entries(room: string): Promise<HistoryEntry[]> {
      return Array.from(this.rooms.get(room)?.values() ?? []).sort((a, b) => a.authorTs - b.authorTs)
    }
    async prune(before: number): Promise<void> {
      for (const entries of this.rooms.values()) {
        for (const [key, entry] of entries) {
          if (entry.authorTs >= before) continue
          entries.delete(key)
          this.bytes -= entry.update.length
        }
      }
    }
    async clear(room: string): Promise<void> {
      for (const entry of this.rooms.get(room)?.values() ?? []) this.bytes -= entry.update.length
      this.rooms.delete(room)
    }
  }

  /**
   * What y-indexeddb 9 does with a document, minus IndexedDB itself: every
   * update appended as a record (a copy, as structured cloning makes one), the
   * whole state written anew once 500 records piled up, a second after the
   * last; opening applies every record in one transaction after appending the
   * state the document had. The self-tests' stand-in encodes the whole
   * document on every update instead - see docs/PERFORMANCE.md.
   */
  class YLikeLocalStores {
    readonly records = new Map<string, Uint8Array[]>()
    readonly meta = new Map<string, Map<string, string>>()
    history: HistoryStore = new CountingHistory()
    readonly opened = new Map<string, number>()

    has(name: string): boolean {
      return this.records.has(name)
    }

    readonly open = (name: string, doc: YDoc): LocalStore => {
      this.opened.set(name, (this.opened.get(name) ?? 0) + 1)
      let records = this.records.get(name)
      if (!records) {
        records = []
        this.records.set(name, records)
      }
      const list = records
      const marker = {}
      const ylikeStoreOpen = (): void => {
        const stored = list.slice()
        list.push(Y.encodeStateAsUpdate(doc))
        Y.transact(doc, () => {
          for (const update of stored) Y.applyUpdate(doc, update)
        }, marker, false)
      }
      ylikeStoreOpen()
      let trimTimer: ReturnType<typeof setTimeout> | null = null
      const ylikeStoreTrim = (): void => {
        trimTimer = null
        list.splice(0, list.length, Y.encodeStateAsUpdate(doc))
      }
      const ylikeStoreUpdate = (update: Uint8Array, origin: unknown): void => {
        if (origin === marker) return
        list.push(update.slice())
        if (list.length >= 500) {
          if (trimTimer) clearTimeout(trimTimer)
          trimTimer = setTimeout(ylikeStoreTrim, 1_000)
        }
      }
      doc.on('update', ylikeStoreUpdate)
      let values = this.meta.get(name)
      if (!values) {
        values = new Map()
        this.meta.set(name, values)
      }
      const kept = values
      return {
        whenSynced: Promise.resolve(),
        destroy: () => {
          if (trimTimer) clearTimeout(trimTimer)
          doc.off('update', ylikeStoreUpdate)
        },
        clear: async () => {
          if (trimTimer) clearTimeout(trimTimer)
          doc.off('update', ylikeStoreUpdate)
          this.records.delete(name)
          this.meta.delete(name)
        },
        get: async (key) => kept.get(key) ?? null,
        set: async (key, value) => {
          kept.set(key, value)
        }
      }
    }
  }

  let device: Device | null = null
  let plan: VaultPlan = { notes: [], files: [] }
  let label = ''
  let out = ''
  const context: MeasureContext = {
    counters,
    profiler: new Profiler(),
    profiling: false,
    heapProfiling: false,
    profileFile: (name) => join(out, `${label}-${name}.cpuprofile`),
    extraMemory: () => standInMemory()
  }

  const need = (): Device => {
    if (!device) throw new Error('no device; init first')
    return device
  }

  /** What the stand-ins hold in this process: in Obsidian, files on disk and IndexedDB. */
  function standInMemory(): Record<string, number> {
    if (!device) return {}
    let vault = 0
    for (const file of device.vault.getFiles()) vault += device.vault.text(file.path)?.length ?? device.vault.bytes(file.path)?.length ?? 0
    let local = 0
    const locals = device.locals as unknown as { records?: Map<string, Uint8Array[]>; saved?: Map<string, Uint8Array>; meta: Map<string, Map<string, string>>; history: CountingHistory }
    for (const list of locals.records?.values() ?? []) for (const record of list) local += record.length
    for (const saved of locals.saved?.values() ?? []) local += saved.length
    for (const values of locals.meta.values()) for (const value of values.values()) local += value.length
    let adapter = 0
    const fakeAdapter = device.vault.adapter as unknown as { files: Map<string, string>; binaries: Map<string, Uint8Array> }
    for (const text of fakeAdapter.files.values()) adapter += text.length
    for (const data of fakeAdapter.binaries.values()) adapter += data.length
    return {
      vaultFilesMB: round(vault / MB),
      localStoreMB: round(local / MB),
      historyMB: round((locals.history.bytes ?? 0) / MB),
      pluginFolderMB: round(adapter / MB)
    }
  }

  function instrumentVault(target: Device): void {
    const vault = target.vault as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    const wrap = (holder: Record<string, (...args: unknown[]) => Promise<unknown>>, method: string, count: (args: unknown[], result: unknown) => void): void => {
      const original = holder[method] as (...args: unknown[]) => Promise<unknown>
      holder[method] = async function (this: unknown, ...args: unknown[]) {
        const result = await original.apply(holder, args)
        count(args, result)
        return result
      }
    }
    wrap(vault, 'read', (_args, result) => {
      bump('vault', 'reads')
      bump('vault', 'readBytes', (result as string).length)
    })
    wrap(vault, 'modify', () => bump('vault', 'writes'))
    wrap(vault, 'create', () => bump('vault', 'creates'))
    wrap(vault, 'createBinary', () => bump('vault', 'creates'))
    wrap(vault, 'modifyBinary', () => bump('vault', 'writes'))
    const adapter = target.vault.adapter as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    wrap(adapter, 'write', (args) => {
      bump('adapter', 'writes')
      bump('adapter', 'writeBytes', String(args[1]).length)
    })
    wrap(adapter, 'read', () => bump('adapter', 'reads'))
    wrap(adapter, 'exists', () => bump('adapter', 'exists'))
  }

  /** Nothing running that would change what is measured next. */
  function settled(target: Device): boolean {
    const store = target.store as unknown as Record<string, { size: number }> | null
    const attachments = target.attachments as unknown as {
      transfers: { uploads: number; downloads: number }
      locks: { size: number }
      settling: { size: number }
      scanning: unknown
    } | null
    if (!store || !attachments || !target.socket) return false
    return (
      target.socket.allSettled() &&
      (store.stale as { size: number }).size === 0 &&
      (store.catchingUp as { size: number }).size === 0 &&
      (store.writeTimers as { size: number }).size === 0 &&
      (store.locks as { size: number }).size === 0 &&
      (store.inFlight as { size: number }).size === 0 &&
      (target as unknown as { indexTimer: unknown }).indexTimer === null &&
      attachments.transfers.uploads === 0 &&
      attachments.transfers.downloads === 0 &&
      attachments.locks.size === 0 &&
      attachments.settling.size === 0 &&
      attachments.scanning === null
    )
  }

  function describe(target: Device): string {
    const notes = target.vault.getMarkdownFiles().length
    const files = target.vault.getFiles().length - notes
    return `${notes} notes, ${files} files in the vault, ${target.store?.loadedCount() ?? 0} loaded, ${target.socket?.allSettled() ? 'all sent' : 'sending'}`
  }

  async function until(predicate: () => boolean, what: string, everyMs = 50, timeoutMs = 60 * 60_000): Promise<void> {
    const started = Date.now()
    let reported = started
    while (!predicate()) {
      if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what} (${device ? describe(device) : ''})`)
      if (Date.now() - reported > 15_000) {
        progress(`${what}: waiting, ${Math.round((Date.now() - started) / 1000)} s (${device ? describe(device) : ''})`)
        reported = Date.now()
      }
      await delay(everyMs)
    }
  }

  const messagesIn = (): number => {
    let total = 0
    for (const [key, value] of Object.entries(counters.wsIn as Counters)) if (!key.endsWith('Bytes')) total += value as number
    return total
  }

  /** When the predicate first held, confirmed by half a second without a message from the server. */
  async function settle(predicate: () => boolean, what: string): Promise<number> {
    for (;;) {
      await until(predicate, what)
      const at = performance.now()
      const heard = messagesIn()
      await delay(500)
      if (predicate() && messagesIn() === heard) return at
    }
  }

  const opened = (): number => {
    let total = 0
    for (const [name, count] of (need().locals as unknown as { opened: Map<string, number> }).opened) {
      if (!name.endsWith('/idx') && !name.endsWith('/set')) total += count
    }
    return total
  }

  function vaultDigest(target: Device): string {
    const hash = createHash('sha256')
    for (const path of target.vault.getFiles().map((file) => file.path).sort()) {
      hash.update(path)
      hash.update('\0')
      const text = target.vault.text(path)
      hash.update(text ?? target.vault.bytes(path) ?? new Uint8Array())
      hash.update('\0')
    }
    return hash.digest('hex')
  }

  /** Marks when the sign-in finished and when the vault index arrived, from outside `boot`. */
  function watchStart(target: Device, mark: (label: string) => void): ReturnType<typeof setInterval> {
    const seen = new Set<string>()
    return setInterval(() => {
      if (target.accountId && !seen.has('login')) {
        seen.add('login')
        mark('login')
      }
      if (target.store?.ready && !seen.has('index')) {
        seen.add('index')
        mark('index')
      }
    }, 10)
  }

  async function bootOrFail(target: Device): Promise<void> {
    if (!(await target.boot())) throw new Error('boot returned false: the vault index did not arrive in time')
  }

  const docIdOf = (path: string): string => {
    const docId = need().store?.docIdForPath(path)
    if (!docId) throw new Error(`no note at ${path}`)
    return docId
  }

  const cursorOf = (docId: string): { outbox: Uint8Array | null; sending: Uint8Array | null } =>
    (need().socket as unknown as { registrations: Map<string, { options: { cursor: { outbox: Uint8Array | null; sending: Uint8Array | null } } }> }).registrations.get(
      shared.docRoom(docId)
    )?.options.cursor ?? { outbox: null, sending: null }

  async function goOffline(target: Device): Promise<void> {
    const socket = target.socket as unknown as { closed: boolean; ws: { close(): void } | null }
    socket.closed = true
    socket.ws?.close()
    await until(() => socket.ws === null, 'going offline', 10)
  }

  async function goOnline(target: Device): Promise<void> {
    const socket = target.socket as unknown as { closed: boolean; retries: number; connect(): void }
    socket.closed = false
    socket.retries = 0
    socket.connect()
    await until(() => target.socket?.connected === true, 'connecting', 5)
  }

  interface Typist {
    docId: string
    type(index: number): void
    close(): Promise<void>
  }

  const SENTENCE = 'the quick brown fox jumps over the lazy dog and keeps on writing '

  /**
   * `editor`: a Markdown view with real CodeMirror and the binding, as a
   * keystroke reaches the plugin in Obsidian. `direct`: the same note claimed
   * for an editor (pinned, owned) and typed into Y.Text directly - the sync
   * layer's share of a keystroke without CodeMirror and jsdom.
   */
  async function typist(target: Device, path: string, mode: 'editor' | 'direct'): Promise<Typist> {
    const store = target.store
    if (!store) throw new Error('not running')
    const docId = docIdOf(path)
    const start = Math.floor((target.vault.text(path) ?? '').length / 2)
    if (mode === 'editor') {
      const bound = target.editors.boundCount()
      // Obsidian saves an edited view about every two seconds.
      const view = target.open(path, 2_000)
      await until(() => target.editors.boundCount() > bound, 'binding the editor')
      return {
        docId,
        type: (index) => view.type(SENTENCE[index % SENTENCE.length] as string, start + index),
        close: async () => target.close(view)
      }
    }
    store.pin(docId)
    store.setEditorOwned(docId, true)
    const handle = await store.handle(docId)
    return {
      docId,
      type: (index) => handle.doc.transact(() => handle.ytext.insert(start + index, SENTENCE[index % SENTENCE.length] as string), EDITOR_ORIGIN),
      close: async () => {
        store.setEditorOwned(docId, false)
        store.unpin(docId)
      }
    }
  }

  function docStats(doc: YDoc): Record<string, number> {
    let structs = 0
    for (const list of (doc.store as unknown as { clients: Map<number, unknown[]> }).clients.values()) structs += list.length
    return { chars: doc.getText(shared.CONTENT_FIELD).length, structs, stateBytes: Y.encodeStateAsUpdate(doc).length }
  }

  async function pool<T>(items: T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length) {
          const item = items[next] as T
          next += 1
          await task(item)
        }
      })
    )
  }

  const pushes = (measured: Measured): number => ((measured.counters.wsOut as Counters | undefined)?.push as number | undefined) ?? 0

  serve({
    init: async (args: { role: 'A' | 'B'; username: string; url: string; notes: number; files: number; store: string; out: string; label: string; profile: boolean; heapProfile: boolean }) => {
      harness.useServer(args.url)
      plan = planVault(args.notes, args.files)
      label = args.label
      out = args.out
      context.profiling = args.profile && !args.heapProfile
      context.heapProfiling = args.heapProfile
      // Node, jsdom, CodeMirror and the plugin's modules loaded, no device yet: what every figure starts from.
      await collectGarbage()
      const baseline = memoryNow()
      const files = args.role === 'A' ? buildVault(plan) : {}
      device = new harness.Device(args.username, args.role === 'A', files)
      const holder = device as unknown as { locals: { history: HistoryStore } }
      if (args.store === 'ylike') holder.locals = new YLikeLocalStores()
      else holder.locals.history = new CountingHistory()
      instrumentVault(device)
      let bytes = 0
      for (const content of Object.values(files)) bytes += content.length
      return { files: Object.keys(files).length, contentMB: round(bytes / MB), baseline }
    },

    stop: async () => {
      await device?.shutdown()
      return { ok: true }
    },

    /** The first device uploads a vault the server has never seen. */
    upload: async () => {
      const target = need()
      const measured = await measure(context, 'upload', async (mark) => {
        const watcher = watchStart(target, mark)
        try {
          await bootOrFail(target)
          mark('boot')
          const at = await settle(
            () => settled(target) && (target.store?.trackedCount() ?? 0) >= plan.notes.length && (target.attachmentIndex?.live().length ?? 0) >= plan.files.length,
            'uploading'
          )
          mark('settled', at)
        } finally {
          clearInterval(watcher)
        }
      }, () => ({ loaded: target.store?.loadedCount() ?? 0 }))
      // What the server acknowledged of the index has to rebuild it: a clock range never sent leaves every later change waiting elsewhere.
      const rebuilt = new Y.Doc()
      for (const update of indexAcked) Y.applyUpdate(rebuilt, update)
      const own = target.index?.doc
      const indexCheck = {
        updatesAcknowledged: indexAcked.length,
        waitingFor: waitingFor(rebuilt),
        complete: own !== undefined && Buffer.from(Y.encodeStateVector(rebuilt)).equals(Buffer.from(Y.encodeStateVector(own)))
      }
      if (!indexCheck.complete) progress(`what the server acknowledged of the index does not rebuild A's index: ${JSON.stringify(indexCheck)}`)
      return { measured, digest: vaultDigest(target), opened: opened(), indexCheck }
    },

    /** A new device of the same account syncs a vault another one filled. */
    join: async (args: { digest: string }) => {
      const target = need()
      const notes = plan.notes.length
      const files = plan.files.length
      const openedBefore = opened()
      const measured = await measure(context, 'join', async (mark) => {
        const watcher = watchStart(target, mark)
        try {
          await bootOrFail(target)
          mark('boot')
          // Nothing new for two minutes is no slow sync: say what the index waits for instead of waiting an hour.
          let seen = -1
          let since = Date.now()
          await until(() => {
            const count = target.vault.getMarkdownFiles().length
            if (count !== seen) {
              seen = count
              since = Date.now()
            }
            if (Date.now() - since > 120_000) {
              const doc = target.index?.doc
              throw new Error(
                `no note arrived for two minutes at ${count} of ${notes}; the index has ${target.store?.trackedCount()} notes and waits for ${JSON.stringify(doc ? waitingFor(doc) : null)}`
              )
            }
            return count >= notes
          }, 'notes arriving')
          mark('notes')
          await until(() => target.vault.getFiles().length - target.vault.getMarkdownFiles().length >= files, 'files arriving')
          mark('files')
          mark('settled', await settle(() => settled(target), 'settling'))
        } finally {
          clearInterval(watcher)
        }
      }, () => ({ loaded: target.store?.loadedCount() ?? 0 }))
      const digest = vaultDigest(target)
      return { measured, same: digest === args.digest, opened: opened() - openedBefore, loadedAfter: target.store?.loadedCount() ?? 0 }
    },

    /** Stops and starts again with everything local - a restart of Obsidian, without the process restarting. */
    restart: async () => {
      const target = need()
      await target.shutdown()
      const openedBefore = opened()
      const measured = await measure(context, 'restart', async (mark) => {
        await bootOrFail(target)
        mark('boot')
        mark('settled', await settle(() => settled(target), 'settling after the restart'))
      }, () => ({ loaded: target.store?.loadedCount() ?? 0 }))
      return { measured, opened: opened() - openedBefore, loadedAfter: target.store?.loadedCount() ?? 0 }
    },

    /** What a note held open costs, with a short and with a long history. */
    memory: async (args: { short: string[]; long: string[]; editsPerLong: number }) => {
      const target = need()
      const store = target.store
      const socket = target.socket
      if (!store || !socket) throw new Error('not running')
      const holder = store as unknown as { options: Parameters<typeof store.setOptions>[0]; evict(): Promise<void> }
      const original = holder.options.maxLoadedDocuments
      const limit = async (max: number): Promise<void> => {
        store.setOptions({ ...holder.options, maxLoadedDocuments: max })
        for (let i = 0; i < 100 && store.loadedCount() > Math.max(max, 1); i += 1) {
          await holder.evict()
          await delay(50)
        }
      }
      const openAll = (paths: string[]): Promise<void> =>
        pool(paths, 8, async (path) => {
          const docId = docIdOf(path)
          await store.handle(docId)
          await socket.whenSynced(shared.docRoom(docId))
        })

      // A long history: insertions and deletions all over the note, as months of editing leave it.
      const setupStarted = performance.now()
      const random = rng(11)
      await pool(args.long, 4, async (path) => {
        const handle = await store.handle(docIdOf(path))
        for (let batch = 0; batch < args.editsPerLong / 20; batch += 1) {
          handle.doc.transact(() => {
            for (let i = 0; i < 20; i += 1) {
              const length = handle.ytext.length
              if (random() < 0.7 || length < 10) handle.ytext.insert(Math.floor(random() * (length + 1)), words(random, 1).slice(0, 1 + Math.floor(random() * 6)))
              else handle.ytext.delete(Math.floor(random() * (length - 4)), 1 + Math.floor(random() * 3))
            }
          }, 'mycel-bench')
        }
      })
      await settle(() => settled(target), 'sending the long histories')
      const setupMs = round(performance.now() - setupStarted, 0)
      const shortDoc = docStats((await store.handle(docIdOf(args.short[0] as string))).doc)
      const longDoc = docStats((await store.handle(docIdOf(args.long[0] as string))).doc)

      const point = async (): Promise<Record<string, number>> => {
        await collectGarbage()
        return { loaded: store.loadedCount(), ...memoryNow(), ...standInMemory() }
      }
      await limit(1)
      const base = await point()
      await limit(1_000_000)
      await openAll(args.short.slice(0, 100))
      const short100 = await point()
      await openAll(args.short.slice(100, 500))
      const short500 = await point()
      await limit(1)
      const base2 = await point()
      await limit(1_000_000)
      await openAll(args.long)
      const longAll = await point()
      await limit(original)
      const perNote = (from: Record<string, number>, to: Record<string, number>): Record<string, number> => {
        const notes = (to.loaded as number) - (from.loaded as number)
        const each = (key: string): number => round((((to[key] as number) - (from[key] as number)) * 1024) / notes, 1)
        return { notes, heapUsedKB: each('heapUsedMB'), arrayBuffersKB: each('arrayBuffersMB'), externalKB: each('externalMB'), rssKB: each('rssMB') }
      }
      return {
        setupMs,
        shortDoc,
        longDoc,
        points: { base, short100, short500, base2, longAll },
        perShortNote: perNote(base, short500),
        perShortNoteFirst100: perNote(base, short100),
        perLongNote: perNote(base2, longAll)
      }
    },

    /** Keystrokes online, `intervalMs` apart, until the server acknowledged all of them. */
    typing: async (args: { path: string; keystrokes: number; intervalMs: number; mode: 'editor' | 'direct'; name: string }) => {
      const target = need()
      const typing = await typist(target, args.path, args.mode)
      await settle(() => settled(target), 'settling before typing')
      const times: number[] = []
      const measured = await measure(context, args.name, async (mark) => {
        for (let i = 0; i < args.keystrokes; i += 1) {
          const started = performance.now()
          typing.type(i)
          times.push(performance.now() - started)
          await delay(args.intervalMs)
        }
        mark('typed')
        await until(() => target.socket?.allSettled() === true, 'acknowledgements', 5)
        mark('sent')
      })
      await typing.close()
      await settle(() => settled(target), 'settling after typing')
      const cpu = measured.cpuMs.user + measured.cpuMs.system
      const frames = pushes(measured)
      return {
        measured,
        keystroke: stats(times),
        frames,
        keystrokesPerFrame: frames === 0 ? 0 : round(args.keystrokes / frames, 2),
        cpuPerKeystrokeMs: round(cpu / args.keystrokes, 3),
        // Timers are coarse (~15.6 ms on Windows): the interval keystrokes really came at.
        actualIntervalMs: round(measured.marks.typed / args.keystrokes, 1)
      }
    },

    /** Keystrokes offline, back to back, then the connection comes back and they go out. */
    offline: async (args: { path: string; keystrokes: number; mode: 'editor' | 'direct'; name: string }) => {
      const target = need()
      const typing = await typist(target, args.path, args.mode)
      await settle(() => settled(target), 'settling before typing offline')
      await goOffline(target)
      const buckets: Array<Record<string, number>> = []
      const all: number[] = []
      const measured = await measure(context, args.name, async (mark) => {
        let times: number[] = []
        let cpu = process.cpuUsage()
        let wall = performance.now()
        for (let i = 0; i < args.keystrokes; i += 1) {
          const started = performance.now()
          typing.type(i)
          const took = performance.now() - started
          times.push(took)
          all.push(took)
          // What a keystroke leaves for later - the cursor's write, the view's save - runs in between.
          await new Promise((done) => setImmediate(done))
          if ((i + 1) % 1000 === 0 || i + 1 === args.keystrokes) {
            const used = process.cpuUsage(cpu)
            const summary = stats(times)
            buckets.push({
              upTo: i + 1,
              syncMeanMs: summary.mean,
              syncP99Ms: summary.p99,
              syncMaxMs: summary.max,
              cpuPerKeystrokeMs: round((used.user + used.system) / 1000 / times.length, 3),
              wallPerKeystrokeMs: round((performance.now() - wall) / times.length, 3),
              outboxBytes: cursorOf(typing.docId).outbox?.length ?? 0
            })
            times = []
            cpu = process.cpuUsage()
            wall = performance.now()
          }
        }
        mark('typed')
      })
      const cursor = cursorOf(typing.docId)
      const outbox = cursor.outbox?.length ?? 0
      const locals = target.locals as unknown as { meta: Map<string, Map<string, string>> }
      const cursorJson = locals.meta.get(`mycel/${target.keys?.vaultId}/${typing.docId}`)?.get('cursor')?.length ?? 0
      const send = await measure(context, `${args.name}-send`, async (mark) => {
        await goOnline(target)
        mark('connected')
        await until(() => target.socket?.allSettled() === true, 'sending what was typed offline', 5)
        mark('sent')
      })
      await typing.close()
      await settle(() => settled(target), 'settling after typing offline')
      return { measured, send, buckets, keystroke: stats(all), outboxBytes: outbox, cursorJsonBytes: cursorJson, framesToSend: pushes(send) }
    },

    /** Another device's week: `framesPerNote` rounds of one edit in each note, each its own frame. */
    generate: async (args: { paths: string[]; framesPerNote: number }) => {
      const target = need()
      await bootOrFail(target)
      await settle(() => settled(target), 'settling before the week of edits')
      const store = target.store
      if (!store) throw new Error('not running')
      const handles = []
      for (const path of args.paths) {
        const docId = docIdOf(path)
        store.pin(docId)
        handles.push(await store.handle(docId))
      }
      const random = rng(5)
      const started = performance.now()
      const before = cloneCounters(counters)
      for (let round = 0; round < args.framesPerNote; round += 1) {
        for (const handle of handles) {
          const at = Math.floor(random() * (handle.ytext.length + 1))
          handle.doc.transact(() => handle.ytext.insert(at, `w${round} `), 'mycel-bench')
        }
        await until(() => target.socket?.allSettled() === true, 'a round of edits', 5)
        if ((round + 1) % 10 === 0) progress(`a week of edits: ${round + 1} of ${args.framesPerNote} rounds`)
      }
      const ms = round(performance.now() - started, 0)
      const delta = diffCounters(counters, before)
      const frames = ((delta.wsOut as Counters | undefined)?.push as number | undefined) ?? 0
      const race = delta.race ?? {}
      const expected = handles.map((handle, index) => {
        const text = handle.text()
        return { path: args.paths[index] as string, length: text.length, hash: createHash('sha256').update(text).digest('hex') }
      })
      for (const path of args.paths) store.unpin(docIdOf(path))
      await settle(() => settled(target), 'writing the week of edits')
      await target.shutdown()
      return { ms, frames, race, expected }
    },

    /** Back after the week: the other device's frames caught up. */
    catchup: async (args: { expected: Array<{ path: string; length: number; hash: string }> }) => {
      const target = need()
      const openedBefore = opened()
      const measured = await measure(context, 'catchup', async (mark) => {
        await bootOrFail(target)
        mark('boot')
        await until(() => args.expected.every((note) => target.vault.text(note.path)?.length === note.length), 'catching up', 100)
        mark('files')
        mark('settled', await settle(() => settled(target), 'settling after catching up'))
      }, () => ({ loaded: target.store?.loadedCount() ?? 0 }))
      const wrong = args.expected.filter((note) => createHash('sha256').update(target.vault.text(note.path) ?? '').digest('hex') !== note.hash)
      return { measured, same: wrong.length === 0, wrong: wrong.length, opened: opened() - openedBefore, loadedAfter: target.store?.loadedCount() ?? 0 }
    },

    /** Nothing happening, with the per-minute passes every `tickMs`. */
    idle: async (args: { seconds: number; tickMs: number }) => {
      const target = need()
      await settle(() => settled(target), 'settling before idling')
      const attachments = target.attachments as unknown as { scan(): Promise<void> }
      const scan = attachments.scan
      let scans = 0
      let scanMs = 0
      attachments.scan = function (this: unknown) {
        scans += 1
        const started = performance.now()
        return scan.call(attachments).finally(() => {
          scanMs += performance.now() - started
        })
      }
      // What main.ts runs besides: the shared files' pass every minute, the cloud's state every 400 ms.
      const sharedPass = setInterval(() => target.sharedFiles?.scheduleAll(), args.tickMs)
      const anyNote = target.vault.getMarkdownFiles()[0]
      const cloud = setInterval(() => {
        if (anyNote) target.store?.noteState(anyNote)
      }, 400)
      try {
        const measured = await measure(context, 'idle', async () => {
          await delay(args.seconds * 1000)
        })
        return { measured, scans, scanMsEach: scans === 0 ? 0 : round(scanMs / scans, 2), tickMs: args.tickMs }
      } finally {
        clearInterval(sharedPass)
        clearInterval(cloud)
        delete (attachments as unknown as Record<string, unknown>).scan
      }
    },

    /** One operation at a time, and eight at once: what the hot paths are made of. */
    micro: async () => {
      const crypto = await import('@mycel/shared/crypto')
      const { hashWasmArgon2id } = await import('../src/account/argon2.js')
      const results: Record<string, number> = {}
      const time = async (name: string, iterations: number, task: () => unknown): Promise<void> => {
        for (let i = 0; i < Math.min(20, iterations); i += 1) await task()
        const started = performance.now()
        for (let i = 0; i < iterations; i += 1) await task()
        results[name] = round(((performance.now() - started) * 1000) / iterations, 1)
      }
      const parallel = async (name: string, iterations: number, task: () => Promise<unknown>): Promise<void> => {
        const started = performance.now()
        for (let i = 0; i < iterations; i += 8) await Promise.all(Array.from({ length: 8 }, task))
        results[name] = round(((performance.now() - started) * 1000) / iterations, 1)
      }
      const key = await crypto.aesKey(crypto.randomBytes(32))
      const small = crypto.randomBytes(200)
      // WebCrypto hands out at most 64 KiB at a time.
      const big = new Uint8Array(randomBytes(100 * 1024))
      const sealedSmall = await crypto.encrypt(key, small, 'aad')
      const sealedBig = await crypto.encrypt(key, big, 'aad')
      await time('aesGcmEncrypt200B', 2000, () => crypto.encrypt(key, small, 'aad'))
      await time('aesGcmDecrypt200B', 2000, () => crypto.decrypt(key, sealedSmall, 'aad'))
      await time('aesGcmDecrypt100KB', 300, () => crypto.decrypt(key, sealedBig, 'aad'))
      await time('sha256_1KB', 2000, () => crypto.sha256(crypto.randomBytes(1024)))
      await time('sha256_100KB', 300, () => crypto.sha256(big))
      const signing = await crypto.generateSigningKeys()
      const signingKey = await crypto.importSigningKey(signing.privateKey)
      const room = 'doc:0123456789abcdef0123456789abcdef'
      const frame = await crypto.packSignedFrame(signingKey, room, 0, '0123456789abcdef0123456789abcdef', null, Date.now(), small)
      const opened = crypto.unpackFrame(frame)
      if (!opened) throw new Error('frame did not unpack')
      await time('ecdsaSignFrame', 1000, () => crypto.packSignedFrame(signingKey, room, 0, '0123456789abcdef0123456789abcdef', null, Date.now(), small))
      await time('ecdsaVerifyFrame', 1000, () => crypto.verifyFrame(signing.publicKey, room, 0, opened))
      await parallel('ecdsaVerifyFrame_8parallel', 1000, () => crypto.verifyFrame(signing.publicKey, room, 0, opened))
      await parallel('aesGcmDecrypt200B_8parallel', 2000, () => crypto.decrypt(key, sealedSmall, 'aad'))
      await time('hmacDeriveDocId', 1000, () => crypto.deriveDocId(crypto.randomBytes(32), 'Area 1/Topic 1/Note 1.md', 0))
      // A frame as a device takes it in: open, fingerprint twice, unpack, verify.
      const sealedFrame = await crypto.encrypt(key, frame, 'aad')
      await time('frameReceiveCryptoPath', 1000, async () => {
        await crypto.sha256(crypto.bytes(sealedFrame))
        const plain = await crypto.decrypt(key, sealedFrame, 'aad')
        const unpacked = crypto.unpackFrame(plain)
        await crypto.sha256(crypto.concat(crypto.utf8(`${unpacked?.author}|${unpacked?.authorTs}|`), unpacked?.update ?? small))
        await crypto.verifyFrame(signing.publicKey, room, 0, unpacked as NonNullable<typeof unpacked>)
      })
      // Yjs.
      const random = rng(3)
      const seedDoc = new Y.Doc()
      seedDoc.getText('content').insert(0, words(random, 900))
      const seed = Y.encodeStateAsUpdate(seedDoc)
      await time('yjsApplySeed5KB', 1000, () => Y.applyUpdate(new Y.Doc(), seed))
      await time('yjsEncodeState5KB', 1000, () => Y.encodeStateAsUpdate(seedDoc))
      const bigDoc = new Y.Doc()
      bigDoc.getText('content').insert(0, words(random, 18000))
      await time('yjsEncodeState100KB', 300, () => Y.encodeStateAsUpdate(bigDoc))
      const editedDoc = new Y.Doc()
      const edited = editedDoc.getText('content')
      edited.insert(0, words(random, 900))
      for (let i = 0; i < 2000; i += 1) {
        if (random() < 0.7) edited.insert(Math.floor(random() * edited.length), 'ab')
        else edited.delete(Math.floor(random() * (edited.length - 3)), 2)
      }
      await time('yjsEncodeState5KB_2000edits', 300, () => Y.encodeStateAsUpdate(editedDoc))
      // The outbox, merged with one more keystroke, and written as the cursor's JSON.
      for (const unsent of [1000, 10000, 20000]) {
        const doc = new Y.Doc()
        const text = doc.getText('content')
        text.insert(0, words(random, 900))
        const updates: Uint8Array[] = []
        doc.on('update', (update: Uint8Array) => updates.push(update))
        for (let i = 0; i < unsent; i += 1) text.insert(2000 + i, 'a')
        const outbox = Y.mergeUpdates(updates.slice(0, -1))
        const last = updates[updates.length - 1] as Uint8Array
        results[`outboxBytes_${unsent}`] = outbox.length
        await time(`mergeUpdatesOutbox_${unsent}`, 50, () => Y.mergeUpdates([outbox, last]))
        await time(`cursorJson_${unsent}`, 50, () => JSON.stringify({ outbox: toBase64(outbox) }))
        await time(`encodeStateOfThatDoc_${unsent}`, 50, () => Y.encodeStateAsUpdate(doc))
      }
      const started = performance.now()
      await hashWasmArgon2id('correct horse battery staple', crypto.randomBytes(16), { memoryKiB: 65_536, iterations: 4, parallelism: 1, hashLength: 64 })
      results.argon2idLoginMs = round(performance.now() - started, 0)
      return results
    }
  })
}

// --- the orchestrator --------------------------------------------------------------------------

interface ServerStats {
  cpu: { user: number; system: number }
  memory: MemorySnapshot
}

/** What crossed the socket and how much crypto it took, in a few words. */
function traffic(m: Measured): string {
  const get = (group: string, key: string): number => ((m.counters[group] as Counters | undefined)?.[key] as number | undefined) ?? 0
  const kb = (bytes: number): string => (bytes >= MB ? `${round(bytes / MB, 1)} MB` : `${round(bytes / 1024, 0)} KB`)
  const parts = [
    `in: ${get('wsIn', 'frame')} frames ${kb(get('wsIn', 'frameBytes'))}, ${get('wsIn', 'snapshot')} snapshots, ${get('wsIn', 'changed')} changed`,
    `out: ${get('wsOut', 'subscribe')} subscribes, ${get('wsOut', 'push')} pushes ${kb(get('wsOut', 'pushBytes'))}, ${get('wsOut', 'watch')} watch msgs`,
    `http ${get('http', 'requests')} req`,
    `verify ${get('crypto', 'verify:ECDSA')}, sign ${get('crypto', 'sign:ECDSA')}, decrypt ${get('crypto', 'decrypt:AES-GCM')}, sha ${get('crypto', 'digest:SHA-256')}`,
    `files read ${get('vault', 'reads')}, plugin-folder writes ${get('adapter', 'writes')} ${kb(get('adapter', 'writeBytes'))}`,
    `cursor writes: index ${get('cursor', 'indexFlushes')} of ${kb(get('cursor', 'indexBytes'))}, notes ${get('cursor', 'otherFlushes')} of ${kb(get('cursor', 'otherBytes'))} unsent`,
    `sendNext overlapping ${get('race', 'overlappingSendNext')}, acks clearing a payload never sent ${get('race', 'ackClearsAnotherPayload')} (${kb(get('race', 'bytesNeverSent'))})`
  ]
  return parts.join('; ')
}

function line(name: string, result: { measured: Measured; server?: { cpuMs: number; rssMB: number } }, extra = ''): string {
  const m = result.measured
  const cpu = (m.cpuMs.user + m.cpuMs.system) / 1000
  const marks = Object.entries(m.marks)
    .map(([key, value]) => `${key} ${round(value / 1000, 1)}`)
    .join(', ')
  const signIn = m.eventLoop.signInMaxMs === undefined ? '' : ` (sign-in ${m.eventLoop.signInMaxMs} ms)`
  return (
    `  ${name.padEnd(22)} wall ${String(round(m.wallMs / 1000, 1)).padStart(6)} s | cpu ${String(round(cpu, 1)).padStart(6)} s` +
    ` | server cpu ${String(round((result.server?.cpuMs ?? 0) / 1000, 1)).padStart(5)} s | loop max ${String(m.eventLoop.maxMs).padStart(6)} ms${signIn}` +
    ` | rss peak ${String(m.peak.rssMB).padStart(5)} MB, after ${m.after.rssMB} MB, heap ${m.after.heapUsedMB} MB` +
    `${marks ? ` | at s: ${marks}` : ''}${extra ? ` | ${extra}` : ''}\n${' '.repeat(26)}${traffic(m)}`
  )
}

function printProfile(name: string, summary: ProfileSummary | AllocationSummary | undefined): void {
  if (summary && 'totalMB' in summary) {
    console.log(`    allocations ${name}: ${summary.totalMB} MB allocated (${summary.file})`)
    for (const entry of summary.top.slice(0, 10)) console.log(`      ${String(entry.mb).padStart(7)} MB ${String(entry.pct).padStart(5)}%  ${entry.fn}`)
    return
  }
  const profile = summary
  if (!profile) return
  console.log(`    profile ${name}: ${profile.busyMs} ms busy on the main thread (${profile.file})`)
  console.log(`      by category: ${profile.categories.slice(0, 8).map((entry) => `${entry.category} ${entry.pct}%`).join(', ')}`)
  for (const entry of profile.top.slice(0, 10)) console.log(`      ${String(entry.ms).padStart(6)} ms ${String(entry.pct).padStart(5)}%  ${entry.fn}`)
}

async function orchestrate(): Promise<void> {
  const sizes = (option('sizes') || '1000:400,5000:2000').split(',').map((size) => {
    const [notes, files] = size.split(':').map(Number) as [number, number | undefined]
    return { notes, files: files ?? Math.round(notes * 0.4) }
  })
  const scenarios = new Set((option('scenarios') || 'all').split(','))
  const want = (name: string): boolean => scenarios.has('all') || scenarios.has(name)
  const out = option('out') || mkdtempSync(join(tmpdir(), 'mycel-bench-'))
  mkdirSync(out, { recursive: true })
  const config = {
    store: option('store') || 'ylike',
    profile: flag('profile'),
    heapProfile: flag('heap-profile'),
    restarts: numberOption('restarts', 3),
    keystrokes: numberOption('keystrokes', 2000),
    intervalMs: numberOption('interval', 60),
    offline: (option('offline') || '2000,10000,20000').split(',').map(Number),
    catchupFrames: numberOption('catchup-frames', 20000),
    catchupNotes: numberOption('catchup-notes', 500),
    idleSeconds: numberOption('idle', 60),
    tickMs: numberOption('tick', 1000),
    everySize: flag('every-size'),
    keep: flag('keep')
  }
  const machine = {
    cpu: cpus()[0]?.model ?? '?',
    cores: cpus().length,
    memoryGB: round(totalmem() / 1024 ** 3, 1),
    node: process.version,
    v8: process.versions.v8,
    arch: arch(),
    os: `${platform()} ${release()}`
  }
  console.log(`Mycel benchmark - ${machine.cpu}, ${machine.cores} cores, ${machine.memoryGB} GB, Node ${machine.node} ${machine.arch}, ${machine.os}`)
  console.log(`store: ${config.store}${config.profile ? ', profiling' : ''}${config.heapProfile ? ', sampling allocations' : ''}; results in ${out}`)
  const results: Record<string, unknown> = { machine, config, startedAt: new Date().toISOString(), sizes: [] as unknown[] }
  const save = (): void => writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2))

  for (const [index, size] of sizes.entries()) {
    const heavy = config.everySize || index === sizes.length - 1
    const tag = `${size.notes}n`
    console.log(`\n== ${size.notes} notes, ${size.files} files ==`)
    const dataDir = mkdtempSync(join(tmpdir(), 'mycel-bench-data-'))
    const server = await spawnRole('server', 'server', ['--data', dataDir], join(out, `${tag}-server.log`))
    const { port } = await server.call<{ port: number }>('port')
    const url = `ws://127.0.0.1:${port}`
    const username = `bench${Date.now().toString(36)}`
    const plan = planVault(size.notes, size.files)
    const notes = pickNotes(plan, config.catchupNotes)
    const A = await spawnRole('device', 'A', [], join(out, `${tag}-A.log`))
    const B = await spawnRole('device', 'B', [], join(out, `${tag}-B.log`))
    const sizeResult: Record<string, unknown> = { size, port, picks: { typing: notes.typing.slice(0, 5), large: notes.large } }
    ;(results.sizes as unknown[]).push(sizeResult)
    const scenarioResults: Record<string, unknown> = {}
    sizeResult.scenarios = scenarioResults

    const profiling = config.profile || config.heapProfile
    const withServer = async <T extends { measured: Measured }>(
      name: string,
      run: () => Promise<T>
    ): Promise<T & { server: { cpuMs: number; rssMB: number; profile?: ProfileSummary | AllocationSummary } }> => {
      const before = await server.call<ServerStats>('stats')
      if (profiling) await server.call('profileStart', { heap: config.heapProfile })
      const result = await run()
      const profile = profiling ? await server.call<ProfileSummary | AllocationSummary>('profileStop', { file: join(out, `${tag}-server-${name}.cpuprofile`) }) : undefined
      const after = await server.call<ServerStats>('stats')
      const cpuMs = round((after.cpu.user - before.cpu.user + after.cpu.system - before.cpu.system) / 1000, 0)
      const full = { ...result, server: { cpuMs, rssMB: after.memory.rssMB, profile } }
      scenarioResults[name] = full
      save()
      return full
    }

    try {
      const init = { username, url, notes: size.notes, files: size.files, store: config.store, out, profile: config.profile, heapProfile: config.heapProfile }
      const built = await A.call<{ files: number; contentMB: number; baseline: MemorySnapshot }>('init', { ...init, role: 'A', label: `${tag}-A` })
      sizeResult.vault = { files: built.files, contentMB: built.contentMB }
      sizeResult.processBaseline = built.baseline
      console.log(`  vault: ${built.files} files, ${built.contentMB} MB; a device process before its device: ${JSON.stringify(built.baseline)}`)
      const upload = await withServer('upload', () =>
        A.call<{ measured: Measured; digest: string; opened: number; indexCheck: { complete: boolean; waitingFor: Record<string, number> } }>('upload')
      )
      sizeResult.serverDisk = await server.call('disk')
      console.log(line('upload (A, first device)', upload, `opened ${upload.opened}, the server holds the whole index: ${upload.indexCheck.complete}`))
      printProfile('upload', upload.measured.profile)
      printProfile('upload (server)', upload.server.profile)
      await A.call('stop')

      const joined = await B.call<{ baseline: MemorySnapshot }>('init', { ...init, role: 'B', label: `${tag}-B` })
      sizeResult.processBaselineB = joined.baseline
      const join = await withServer('join', () => B.call<{ measured: Measured; same: boolean; opened: number; loadedAfter: number }>('join', { digest: upload.digest }))
      console.log(line('join (B, new device)', join, `same as A: ${join.same}, opened ${join.opened}, loaded after ${join.loadedAfter}`))
      printProfile('join', join.measured.profile)
      printProfile('join (server)', join.server.profile)

      for (let r = 1; r <= config.restarts; r += 1) {
        const restart = await withServer(`restart${r}`, () => B.call<{ measured: Measured; opened: number; loadedAfter: number }>('restart'))
        console.log(line(`restart ${r} (B)`, restart, `opened ${restart.opened}, loaded peak ${restart.measured.peak.loaded}, after ${restart.loadedAfter}`))
        if (r === 1) {
          printProfile('restart', restart.measured.profile)
          printProfile('restart (server)', restart.server.profile)
        }
      }

      if (heavy && want('memory')) {
        const memory = await B.call<Record<string, unknown>>('memory', { short: notes.short, long: notes.long, editsPerLong: 1000 })
        scenarioResults.memory = memory
        save()
        console.log(`  memory per note held open: short ${JSON.stringify(memory.perShortNote)}; long ${JSON.stringify(memory.perLongNote)}`)
        console.log(`    a short note: ${JSON.stringify(memory.shortDoc)}; a long one: ${JSON.stringify(memory.longDoc)}`)
      }

      if (heavy && want('typing')) {
        const runs: Array<{ name: string; path: string; mode: 'editor' | 'direct'; keystrokes: number }> = [
          { name: 'typing-editor-5KB', path: notes.typing[0] as string, mode: 'editor', keystrokes: config.keystrokes },
          { name: 'typing-direct-5KB', path: notes.typing[1] as string, mode: 'direct', keystrokes: config.keystrokes },
          { name: 'typing-editor-100KB', path: notes.large, mode: 'editor', keystrokes: Math.round(config.keystrokes / 2) }
        ]
        for (const run of runs) {
          const typed = await withServer(run.name, () =>
            B.call<{ measured: Measured; keystroke: Stats; frames: number; keystrokesPerFrame: number; cpuPerKeystrokeMs: number }>('typing', {
              ...run,
              intervalMs: config.intervalMs
            })
          )
          console.log(
            line(run.name, typed, `keystroke sync mean ${typed.keystroke.mean} ms p99 ${typed.keystroke.p99} max ${typed.keystroke.max}; cpu/keystroke ${typed.cpuPerKeystrokeMs} ms; ${typed.frames} frames (${typed.keystrokesPerFrame} keys/frame)`)
          )
          printProfile(run.name, typed.measured.profile)
        }
      }

      if (heavy && want('offline')) {
        const runs: Array<{ name: string; path: string; mode: 'editor' | 'direct'; keystrokes: number }> = config.offline.map((keystrokes, i) => ({
          name: `offline-direct-${keystrokes}`,
          path: notes.typing[2 + i] as string,
          mode: 'direct',
          keystrokes
        }))
        runs.push({ name: `offline-editor-${config.offline[1] ?? 10000}`, path: notes.typing[2 + config.offline.length] as string, mode: 'editor' as const, keystrokes: config.offline[1] ?? 10000 })
        for (const run of runs) {
          const typed = await withServer(run.name, () =>
            B.call<{ measured: Measured; send: Measured; buckets: Array<Record<string, number>>; keystroke: Stats; outboxBytes: number; cursorJsonBytes: number; framesToSend: number }>('offline', run)
          )
          const first = typed.buckets[0]
          const last = typed.buckets[typed.buckets.length - 1]
          console.log(
            line(run.name, typed, `outbox ${typed.outboxBytes} B, cursor JSON ${typed.cursorJsonBytes} B; sync/keystroke first 1000 ${first?.syncMeanMs} ms, last 1000 ${last?.syncMeanMs} ms; sent in ${round(typed.send.wallMs / 1000, 2)} s, ${typed.framesToSend} frame(s)`)
          )
          printProfile(run.name, typed.measured.profile)
        }
      }

      if (want('catchup')) {
        await B.call('stop')
        const framesPerNote = Math.max(1, Math.round(config.catchupFrames / notes.catchup.length))
        console.log(`  A makes ${framesPerNote} frames in each of ${notes.catchup.length} notes while B is away ...`)
        const generated = await A.call<{ ms: number; frames: number; race: Counters; expected: Array<{ path: string; length: number; hash: string }> }>('generate', {
          paths: notes.catchup,
          framesPerNote
        })
        sizeResult.generate = { ms: generated.ms, frames: generated.frames, race: generated.race }
        console.log(`  ... ${generated.frames} frames in ${round(generated.ms / 1000, 1)} s; sendNext races ${JSON.stringify(generated.race)}`)
        const catchup = await withServer('catchup', () => B.call<{ measured: Measured; same: boolean; wrong: number; opened: number; loadedAfter: number }>('catchup', { expected: generated.expected }))
        console.log(line('catch-up (B, a week away)', catchup, `same as A: ${catchup.same}, opened ${catchup.opened}, loaded after ${catchup.loadedAfter}`))
        printProfile('catchup', catchup.measured.profile)
        printProfile('catchup (server)', catchup.server.profile)
      }

      if (want('idle')) {
        const idle = await withServer('idle', () => B.call<{ measured: Measured; scans: number; scanMsEach: number }>('idle', { seconds: config.idleSeconds, tickMs: config.tickMs }))
        console.log(line('idle (B)', idle, `${idle.scans} attachment scans of ${idle.scanMsEach} ms; ws out ${JSON.stringify(idle.measured.counters.wsOut ?? {})} in ${JSON.stringify(idle.measured.counters.wsIn ?? {})}`))
        printProfile('idle', idle.measured.profile)
      }

      await B.call('stop')
      if (index === sizes.length - 1 && want('micro')) {
        const micro = await B.call<Record<string, number>>('micro')
        results.micro = micro
        save()
        console.log(`  micro (µs per operation unless named): ${JSON.stringify(micro)}`)
      }
    } finally {
      A.child.kill()
      B.child.kill()
      await server.call('stop').catch(() => undefined)
      if (!config.keep) rmSync(dataDir, { recursive: true, force: true })
    }
  }
  results.finishedAt = new Date().toISOString()
  save()
  console.log(`\nresults: ${join(out, 'results.json')}`)
  process.exit(0)
}

const role = option('role')
if (role === 'server') await serverRole()
else if (role === 'device') await deviceRole()
else await orchestrate()
