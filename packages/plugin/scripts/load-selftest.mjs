// Loads the built bundle with `obsidian` and `@codemirror/*` stubbed, the way
// Obsidian supplies them at runtime. Catches anything that breaks at import
// time - a missing export, a bad top-level call - which in Obsidian shows up
// only as a plugin that silently refuses to start.
//
//   npm run build:plugin && npm run test:load -w @mycel/plugin
import Module from 'node:module'
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
// The bundle is CommonJS, but the package is `"type": "module"`, so Node would
// parse main.js as ESM. Obsidian evaluates it as CommonJS itself; the .cjs copy
// reproduces that.
const source = join(here, '..', 'main.js')
const bundle = join(mkdtempSync(join(tmpdir(), 'mycel-load-')), 'main.cjs')
copyFileSync(source, bundle)

class Stub {
  constructor() {}
}
const fn = () => undefined
const chainable = () => {
  const api = new Proxy(fn, {
    get: () => chainable(),
    apply: () => api
  })
  return api
}

// What onload registered, so the test can check it without Obsidian.
const registered = { commands: [], editorExtensions: [], layoutReady: [], views: [], documentListeners: [] }
const localStorageStub = new Map()

const adapterFiles = new Map()
const adapter = {
  exists: async (path) => adapterFiles.has(path),
  mkdir: async (path) => void adapterFiles.set(path, ''),
  read: async (path) => adapterFiles.get(path) ?? '',
  write: async (path, data) => void adapterFiles.set(path, data),
  append: async (path, data) => void adapterFiles.set(path, (adapterFiles.get(path) ?? '') + data),
  remove: async (path) => void adapterFiles.delete(path),
  list: async () => ({ files: [], folders: [] }),
  rmdir: async () => undefined
}

const obsidian = {
  Plugin: class extends Stub {
    constructor() {
      super()
      this.app = {
        vault: { on: () => ({}), configDir: '.obsidian', adapter, getMarkdownFiles: () => [], getName: () => 'Test vault' },
        workspace: {
          on: () => ({}),
          onLayoutReady: (callback) => registered.layoutReady.push(callback),
          getActiveFile: () => null,
          // The explorer's guard listens on the document and greys with a style of its own.
          containerEl: {
            doc: {
              head: { createEl: () => ({ remove: fn, textContent: '' }) },
              addEventListener: (type) => registered.documentListeners.push(type),
              removeEventListener: fn
            }
          }
        },
        metadataCache: { on: () => ({}) },
        loadLocalStorage: (key) => localStorageStub.get(key) ?? null,
        saveLocalStorage: (key, value) => {
          if (value === null) localStorageStub.delete(key)
          else localStorageStub.set(key, value)
        }
      }
      this.manifest = { id: 'mycel', dir: '.obsidian/plugins/mycel' }
    }
    addStatusBarItem() {
      return { setText: fn, addClass: fn, removeClass: fn, addEventListener: fn, empty: fn, hide: fn, show: fn, setAttribute: fn, removeAttribute: fn }
    }
    registerView = (type) => registered.views.push(type)
    addSettingTab = fn
    // Obsidian hands back the icon's element; the notification center puts its count on it.
    addRibbonIcon = () => ({ addClass: fn, createSpan: () => ({ setText: fn, toggleClass: fn }) })
    addCommand = (command) => registered.commands.push(command.id)
    registerEvent = fn
    registerDomEvent = fn
    register = fn
    registerEditorExtension = (extension) => registered.editorExtensions.push(extension)
    registerMarkdownPostProcessor = fn
    registerInterval = (id) => id
    // Signed out, the way a fresh install starts: the start must stop short
    // without touching the network.
    loadData = async () => ({ serverUrl: 'ws://127.0.0.1:9', syncTimeoutMs: 200 })
    saveData = async () => undefined
  },
  PluginSettingTab: Stub,
  Modal: class extends Stub {
    constructor() {
      super()
      this.titleEl = { setText: fn }
      this.contentEl = { empty: fn, createEl: () => ({ setText: fn }), createDiv: () => ({}) }
    }
  },
  ItemView: class extends Stub {
    constructor() {
      super()
      this.contentEl = {}
    }
  },
  Notice: Stub,
  Setting: class extends Stub {
    setName = () => this
    setDesc = () => this
    setHeading = () => this
    addText = () => this
    addTextArea = () => this
    addToggle = () => this
    addDropdown = () => this
    addButton = () => this
  },
  TFile: Stub,
  TFolder: Stub,
  TAbstractFile: Stub,
  Platform: { isMobile: false },
  setIcon: fn,
  Menu: Stub,
  editorInfoField: {},
  MarkdownView: Stub,
  MarkdownRenderer: { render: async () => undefined },
  Component: class extends Stub {
    load = fn
    unload = fn
  },
  getLinkpath: (value) => value,
  normalizePath: (value) => value,
  requestUrl: async () => ({ status: 503, json: {} })
}

/**
 * Unknown members answer with a callable that keeps answering. CodeMirror's
 * real surface is large and libraries poke at it during import; the test cares
 * that our own module bodies run, not that the stub is faithful.
 */
function permissive(base) {
  return new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key]
      if (typeof key === 'symbol') return undefined
      return chainable()
    }
  })
}

const cmState = permissive({
  Annotation: { define: () => ({ of: fn }) },
  Facet: { define: () => ({ of: fn }) },
  StateEffect: { define: () => ({ of: fn, is: () => false }), appendConfig: { of: fn } },
  StateField: { define: () => ({}) },
  Compartment: class {
    of = (value) => value
    reconfigure = fn
  },
  EditorState: { create: () => ({}), readOnly: { of: fn, from: fn }, transactionFilter: { of: fn } },
  Prec: { highest: (extension) => extension },
  EditorSelection: {}
})

const EditorViewStub = permissive(
  Object.assign(
    class {
      constructor() {}
      dispatch() {}
      destroy() {}
    },
    { decorations: { from: () => ({}) } }
  )
)

const cmView = permissive({
  EditorView: EditorViewStub,
  ViewPlugin: { fromClass: (cls) => ({ cls }), define: (cls) => ({ cls }) },
  Decoration: {
    none: {},
    set: () => ({}),
    mark: () => ({ range: fn }),
    widget: () => ({ range: fn }),
    line: () => ({ range: fn })
  },
  WidgetType: Stub,
  keymap: { of: fn },
  lineNumbers: fn,
  highlightActiveLine: fn
})

const stubs = new Map([
  ['obsidian', obsidian],
  ['@codemirror/state', cmState],
  ['@codemirror/view', cmView],
  ['@codemirror/commands', { defaultKeymap: [], history: fn, historyKeymap: [] }],
  ['@codemirror/language', chainable()],
  ['@codemirror/search', chainable()],
  ['@codemirror/autocomplete', chainable()],
  ['@codemirror/lint', chainable()],
  ['@codemirror/collab', chainable()],
  ['@lezer/common', chainable()],
  ['@lezer/highlight', chainable()],
  ['@lezer/lr', chainable()],
  ['electron', {}]
])

const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (stubs.has(request)) return request
  return originalResolve.call(this, request, ...rest)
}
const originalLoad = Module._load
Module._load = function (request, ...rest) {
  if (stubs.has(request)) return stubs.get(request)
  return originalLoad.call(this, request, ...rest)
}

// The bundle expects a browser-ish global surface.
globalThis.window ??= { setTimeout, clearTimeout, setInterval, clearInterval }
globalThis.WebSocket ??= class {
  static OPEN = 1
  constructor() {
    this.readyState = 0
  }
  close() {}
  send() {}
}
globalThis.indexedDB ??= { open: () => ({}) }

const failures = []
function check(ok, label, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`)
  if (!ok) {
    failures.push(label)
    if (detail) console.log('      ', detail)
  }
}

let exported
try {
  exported = createRequire(import.meta.url)(bundle)
  check(true, 'the bundle loads with Obsidian stubbed')
} catch (error) {
  check(false, 'the bundle loads with Obsidian stubbed', error?.stack ?? String(error))
}

if (exported) {
  const PluginClass = exported.default ?? exported
  check(typeof PluginClass === 'function', 'it exports a plugin class')
  try {
    const instance = new PluginClass()
    check(typeof instance.onload === 'function', 'the plugin exposes onload')
    check(typeof instance.onunload === 'function', 'the plugin exposes onunload')

    // In Obsidian a throw from here shows as "failed to load plugin" and
    // nothing else, so run the whole of it.
    try {
      await instance.onload()
      check(true, 'onload runs')
    } catch (error) {
      check(false, 'onload runs', error?.stack ?? String(error))
    }
    check(
      registered.editorExtensions.length === 3,
      "it registers its three editor extensions: the binding, the one that marks someone else's links, and the one that shows a note its past read-only",
      registered.editorExtensions.length
    )
    check(
      ['share-note', 'note-access', 'shared-with-me', 'detach-note'].every((id) => registered.commands.includes(id)),
      'it registers the sharing commands',
      registered.commands
    )
    check(
      registered.views.includes('mycel-time-machine') && ['time-machine', 'time-machine-note', 'time-machine-close'].every((id) => registered.commands.includes(id)),
      "it registers the Time Machine's overview and its commands",
      { views: registered.views, commands: registered.commands }
    )
    check(
      registered.views.includes('mycel-notifications') && registered.commands.includes('notifications'),
      'and the notification center, with its command',
      { views: registered.views, commands: registered.commands }
    )
    check(registered.commands.includes('setup'), "and the setup wizard's command", registered.commands)
    // By itself only on a device never connected, and once: a device set up, or
    // signed out later with its address kept, is never interrupted by it.
    {
      const kept = instance.settings
      const base = { ...kept, serverUrl: 'ws://localhost:1234', username: '', token: '', setupShown: false }
      const offers = (patch) => {
        instance.settings = { ...base, ...patch }
        return instance.offersSetup()
      }
      const fresh = offers({})
      const seen = offers({ setupShown: true })
      const signedIn = offers({ username: 'someone', token: 'token' })
      const addressed = offers({ serverUrl: 'wss://notes.example.com' })
      instance.settings = kept
      check(
        fresh && !seen && !signedIn && !addressed,
        'the setup wizard opens by itself on a device never connected, once - never on one signed in or given an address',
        { fresh, seen, signedIn, addressed }
      )
    }

    try {
      for (const callback of registered.layoutReady) await callback()
      await new Promise((resolve) => setTimeout(resolve, 300))
      check(true, 'starting while signed out does not throw')
    } catch (error) {
      check(false, 'starting while signed out does not throw', error?.stack ?? String(error))
    }
    check(
      ['click', 'contextmenu', 'dragstart'].every((type) => registered.documentListeners.includes(type)),
      'once the layout is ready, the explorer is guarded: clicks, its menu and dragging are caught first',
      registered.documentListeners
    )
    try {
      await instance.onunload()
      check(true, 'onunload runs')
    } catch (error) {
      check(false, 'onunload runs', error?.stack ?? String(error))
    }
  } catch (error) {
    check(false, 'the plugin can be constructed', error?.stack ?? String(error))
  }

  // Unloaded while its start still waits for the server - the plugin turned off
  // and on again. A start that went on afterwards left a second copy running
  // unseen, with a connection of its own, which merged the note open in the
  // new copy with conflict markers.
  try {
    registered.layoutReady.length = 0
    const instance = new PluginClass()
    await instance.onload()
    let answer
    const session = instance.session
    session.unlock = () => new Promise((resolve) => (answer = resolve))
    session.openVault = async () => ({ vaultId: 'vault', name: 'Test vault', key: new Uint8Array(32) })
    const starting = Promise.all(registered.layoutReady.map((callback) => callback()))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await instance.onunload()
    answer({ accountId: 'account', username: 'someone', accountSecret: new Uint8Array(32), bundle: { vaults: [] } })
    await starting
    await new Promise((resolve) => setTimeout(resolve, 50))
    check(
      instance.socket === null && instance.store === null && instance.unlocked === null,
      'a start the plugin was unloaded during builds nothing afterwards',
      { socket: Boolean(instance.socket), store: Boolean(instance.store), unlocked: Boolean(instance.unlocked) }
    )
    for (const callback of registered.layoutReady) await callback()
    check(instance.socket === null && instance.opening === false, 'and an unloaded plugin does not start again when called back')
  } catch (error) {
    check(false, 'a start the plugin was unloaded during builds nothing afterwards', error?.stack ?? String(error))
  }
}

// A bundle built from other sources than the ones here - once from a stash that
// held an older state - passes every other check and ships the old plugin.
{
  const bundleTime = statSync(source).mtimeMs
  const newer = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (statSync(path).mtimeMs > bundleTime) newer.push(path.slice(join(here, '..').length + 1))
    }
  }
  walk(join(here, '..', 'src'))
  for (const file of ['styles.css', 'manifest.json']) {
    if (statSync(join(here, '..', file)).mtimeMs > bundleTime) newer.push(file)
  }
  check(newer.length === 0, 'main.js is built from the sources as they are now', `rebuild; newer: ${newer.join(', ')}`)
}

// The version Obsidian shows is the manifest's; everything else must say the same.
{
  const read = (path) => JSON.parse(readFileSync(join(here, '..', path), 'utf8'))
  const manifest = read('manifest.json')
  const versions = read('versions.json')
  const root = JSON.parse(readFileSync(join(here, '..', '..', '..', 'package.json'), 'utf8'))
  const packages = join(here, '..', '..')
  const others = readdirSync(packages)
    .filter((name) => existsSync(join(packages, name, 'package.json')))
    .map((name) => `${name} ${JSON.parse(readFileSync(join(packages, name, 'package.json'), 'utf8')).version}`)
  check(
    manifest.version === root.version && others.every((entry) => entry.endsWith(` ${manifest.version}`)),
    'manifest and every package carry the same version',
    `${manifest.version} / root ${root.version} / ${others.join(', ')}`
  )
  check(versions[manifest.version] === manifest.minAppVersion, 'and versions.json knows it', manifest.version)
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
