// Loads the built bundle with `obsidian` and `@codemirror/*` stubbed, the way
// Obsidian supplies them at runtime. Catches anything that breaks at import
// time - a missing export, a bad top-level call - which in Obsidian shows up
// only as a plugin that silently refuses to start.
//
//   npm run build:plugin && npm run test:load -w @crdt-sync/plugin
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
const bundle = join(mkdtempSync(join(tmpdir(), 'crdt-load-')), 'main.cjs')
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

const obsidian = {
  Plugin: class extends Stub {
    constructor() {
      super()
      this.app = {}
      this.manifest = { id: 'crdt-sync', dir: '.obsidian/plugins/crdt-sync' }
    }
    addStatusBarItem() {
      return { setText: fn }
    }
    registerView = fn
    addSettingTab = fn
    addRibbonIcon = fn
    addCommand = fn
    registerEvent = fn
    register = fn
    loadData = async () => null
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
  TAbstractFile: Stub,
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
  } catch (error) {
    check(false, 'the plugin can be constructed', error?.stack ?? String(error))
  }
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
