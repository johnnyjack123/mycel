// Loads the built bundle with `obsidian` and `@codemirror/*` stubbed, the way
// Obsidian supplies them at runtime. Catches anything that breaks at import
// time - a missing export, a bad top-level call - which in Obsidian shows up
// only as a plugin that silently refuses to start.
//
//   npm run build:plugin && npm run test:load -w @obsidian-connect/plugin
import Module from 'node:module'
import { createRequire } from 'node:module'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
// The bundle is CommonJS, but the package is `"type": "module"`, so Node would
// parse main.js as ESM. Obsidian evaluates it as CommonJS itself; the .cjs copy
// reproduces that.
const source = join(here, '..', 'main.js')
const bundle = join(mkdtempSync(join(tmpdir(), 'connect-load-')), 'main.cjs')
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
const registered = { commands: [], editorExtensions: [], protocolHandlers: [], layoutReady: [] }

const adapterFiles = new Map()
const adapter = {
  exists: async (path) => adapterFiles.has(path),
  mkdir: async (path) => void adapterFiles.set(path, ''),
  read: async (path) => adapterFiles.get(path) ?? '',
  write: async (path, data) => void adapterFiles.set(path, data),
  remove: async (path) => void adapterFiles.delete(path),
  list: async () => ({ files: [], folders: [] }),
  rmdir: async () => undefined
}

const obsidian = {
  Plugin: class extends Stub {
    constructor() {
      super()
      this.app = {
        vault: { on: () => ({}), configDir: '.obsidian', adapter, getMarkdownFiles: () => [] },
        workspace: {
          on: () => ({}),
          onLayoutReady: (callback) => registered.layoutReady.push(callback),
          getActiveFile: () => null
        }
      }
      this.manifest = { id: 'obsidian-connect', dir: '.obsidian/plugins/obsidian-connect' }
    }
    addStatusBarItem() {
      return { setText: fn }
    }
    registerView = fn
    addSettingTab = fn
    addRibbonIcon = fn
    addCommand = (command) => registered.commands.push(command.id)
    registerEvent = fn
    register = fn
    registerEditorExtension = (extension) => registered.editorExtensions.push(extension)
    registerObsidianProtocolHandler = (action) => registered.protocolHandlers.push(action)
    // A short timeout: the stub socket never connects, and the test waits for
    // the start to give up.
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
  editorInfoField: {},
  MarkdownView: Stub,
  normalizePath: (value) => value,
  requestUrl: async () => ({ json: {} })
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
  EditorState: { create: () => ({}) },
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
globalThis.window ??= { setTimeout, clearTimeout }
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
    check(registered.editorExtensions.length === 1, 'it registers exactly one editor extension', registered.editorExtensions.length)

    try {
      for (const callback of registered.layoutReady) await callback()
      // startSync gives up on the unreachable server after syncTimeoutMs.
      await new Promise((resolve) => setTimeout(resolve, 600))
      check(true, 'starting sync against an unreachable server does not throw')
    } catch (error) {
      check(false, 'starting sync against an unreachable server does not throw', error?.stack ?? String(error))
    }
    try {
      await instance.onunload()
      check(true, 'onunload runs')
    } catch (error) {
      check(false, 'onunload runs', error?.stack ?? String(error))
    }
  } catch (error) {
    check(false, 'the plugin can be constructed', error?.stack ?? String(error))
  }
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
