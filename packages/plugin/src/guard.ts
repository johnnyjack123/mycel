import type { App } from 'obsidian'
import { vaultPathProblem } from '@mycel/shared'
import { log } from './log.js'

// One gate in front of every file this plugin touches (`docs/AUDIT.md`). Paths
// reach this plugin from other people - a shared folder's document, a shared
// note's list of files, a sealed title - and, should it lie, from the server.
// Each place that takes such a path checks it; this gate stands behind all of
// them, so that a place that forgot, or one added later, still cannot write
// outside the vault, into its configuration folder or another plugin's: the
// plugin reads and writes the vault's own notes and files, and its own folder,
// and nothing else.
//
// It guards against this plugin being misled, not against this plugin's own
// code: a plugin runs with every right Obsidian has, and an update of it could
// leave the gate out. That is for the update to prove (docs/AUDIT.md, "Updates").

export class PathRefused extends Error {
  constructor(
    readonly path: string,
    readonly why: string
  ) {
    super(`Mycel does not touch ${JSON.stringify(path)}: ${why}`)
  }
}

/** A path below the plugin's own folder: plain segments, nothing that climbs. */
function pluginPathProblem(path: string, pluginDir: string): string | null {
  if (path !== pluginDir && !path.startsWith(`${pluginDir}/`)) return 'outside the vault and the plugin folder'
  const rest = path.slice(pluginDir.length + 1)
  if (rest === '') return null
  if (rest.includes('\\')) return 'a backslash'
  for (let index = 0; index < rest.length; index += 1) {
    const code = rest.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return 'a control character'
  }
  for (const segment of rest.split('/')) {
    const core = segment.replace(/[. ]+$/, '')
    if (segment === '' || core.trim() === '') return 'a climb out of the plugin folder'
  }
  return null
}

/** What the gate lets through: a path of the vault (not hidden), or one in the plugin's folder. */
export class PathGate {
  constructor(private readonly pluginDir: string) {}

  /** Notes, files and folders of the vault: never hidden ones, never the configuration. */
  vault(path: unknown, what: string): void {
    const problem = vaultPathProblem(path)
    if (problem) this.refuse(path, `${what}: ${problem}`)
  }

  /** What the adapter is asked for: the vault's files, or the plugin's own folder. */
  any(path: unknown, what: string): void {
    if (typeof path !== 'string') return this.refuse(path, `${what}: no path`)
    if (vaultPathProblem(path) === null) return
    const problem = pluginPathProblem(path, this.pluginDir)
    if (problem) this.refuse(path, `${what}: ${problem}`)
  }

  private refuse(path: unknown, why: string): never {
    const shown = typeof path === 'string' ? path : String(path)
    log.error(`refused to touch ${JSON.stringify(shown)} - ${why}`)
    throw new PathRefused(shown, why)
  }
}

type Check = (args: unknown[]) => void

function pathOf(file: unknown): unknown {
  return file && typeof file === 'object' && 'path' in file ? (file as { path: unknown }).path : undefined
}

/**
 * `target` with the methods named in `checks` checked before they run, every
 * other method bound to it as it is, and `replaced` standing in for some of
 * its properties.
 */
function gated<T extends object>(target: T, checks: Record<string, Check>, replaced: Record<string, unknown> = {}): T {
  // A test's stand-in for Obsidian may lack a part; there is nothing to guard then.
  if (!target || typeof target !== 'object') return target
  const bound = new Map<PropertyKey, { original: unknown; wrapper: unknown }>()
  return new Proxy(target, {
    get(object, property) {
      if (typeof property === 'string' && property in replaced) return replaced[property]
      const value: unknown = Reflect.get(object, property, object)
      if (typeof value !== 'function') return value
      const known = bound.get(property)
      if (known && known.original === value) return known.wrapper
      const method = value as (...args: unknown[]) => unknown
      const check = typeof property === 'string' ? checks[property] : undefined
      const wrapper = check
        ? (...args: unknown[]) => {
            check(args)
            return method.apply(object, args)
          }
        : method.bind(object)
      bound.set(property, { original: value, wrapper })
      return wrapper
    }
  })
}

/**
 * The app as this plugin sees it: its vault, the vault's adapter and the file
 * manager behind the gate, everything else as Obsidian has it.
 */
export function gateApp(app: App, pluginDir: string): App {
  const gate = new PathGate(pluginDir)
  const file = (index: number, what: string): Check => (args) => gate.vault(pathOf(args[index]), what)
  const path = (index: number, what: string): Check => (args) => gate.vault(args[index], what)
  const both = (...checks: Check[]): Check => (args) => {
    for (const check of checks) check(args)
  }
  const any = (index: number, what: string): Check => (args) => gate.any(args[index], what)

  const vault = app.vault
  const adapter = gated(vault.adapter, {
    read: any(0, 'reading'),
    readBinary: any(0, 'reading'),
    exists: any(0, 'looking for'),
    stat: any(0, 'looking at'),
    list: any(0, 'listing'),
    write: any(0, 'writing'),
    writeBinary: any(0, 'writing'),
    append: any(0, 'writing'),
    appendBinary: any(0, 'writing'),
    process: any(0, 'writing'),
    mkdir: any(0, 'making a folder'),
    remove: any(0, 'deleting'),
    rmdir: any(0, 'deleting'),
    trashSystem: any(0, 'deleting'),
    trashLocal: any(0, 'deleting'),
    rename: both(any(0, 'moving'), any(1, 'moving')),
    copy: both(any(0, 'copying'), any(1, 'copying'))
  })
  const gatedVault = gated(
    vault,
    {
      create: path(0, 'creating'),
      createBinary: path(0, 'creating'),
      createFolder: path(0, 'making a folder'),
      modify: file(0, 'writing'),
      modifyBinary: file(0, 'writing'),
      append: file(0, 'writing'),
      process: file(0, 'writing'),
      rename: both(file(0, 'moving'), path(1, 'moving')),
      copy: both(file(0, 'copying'), path(1, 'copying')),
      delete: file(0, 'deleting'),
      trash: file(0, 'deleting'),
      read: file(0, 'reading'),
      cachedRead: file(0, 'reading'),
      readBinary: file(0, 'reading')
    },
    { adapter }
  )
  const fileManager = gated(app.fileManager, {
    renameFile: both(file(0, 'moving'), path(1, 'moving')),
    trashFile: file(0, 'deleting'),
    processFrontMatter: file(0, 'writing')
  })
  return gated(app, {}, { vault: gatedVault, fileManager })
}
