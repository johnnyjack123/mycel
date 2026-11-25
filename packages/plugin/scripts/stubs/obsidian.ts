// Stands in for the `obsidian` module when the sync layer runs outside the
// app (see scripts/tsconfig.json). Only what `src/sync` and `src/editor`
// import at runtime; behaviour lives in `fake-vault.ts`.

export class TAbstractFile {
  path = ''
  name = ''
}

export class TFile extends TAbstractFile {
  basename = ''
  extension = ''
  stat = { ctime: 0, mtime: 0, size: 0 }
}

export class TFolder extends TAbstractFile {
  /** What lies directly in it; the fake vault keeps it current. */
  children: TAbstractFile[] = []
}

export class Notice {
  /** Every notice shown so far, for tests to assert on. */
  static readonly shown: string[] = []

  constructor(message: string | DocumentFragment, _duration?: number) {
    if (typeof message === 'string') {
      Notice.shown.push(message)
      return
    }
    // As Obsidian does: the fragment's nodes move into the notice, and the fragment is left empty.
    const el = document.createElement('div')
    el.appendChild(message)
    Notice.shown.push(el.textContent ?? '')
  }

  hide(): void {}
}

// --- windows, for a test that opens one in jsdom (`installDomHelpers` first) -----------------

interface ElementOptions {
  cls?: string
  text?: string
  attr?: Record<string, string>
}

/** What Obsidian adds to every element, as far as the plugin's windows use it. */
export function installDomHelpers(): void {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>
  if (proto.createEl) return
  proto.createEl = function (this: HTMLElement, tag: string, options: ElementOptions = {}): HTMLElement {
    const el = document.createElement(tag)
    if (options.cls) el.className = options.cls
    if (options.text !== undefined) el.textContent = options.text
    for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value)
    this.appendChild(el)
    return el
  }
  proto.createDiv = function (this: HTMLElement & { createEl: (tag: string, o?: ElementOptions) => HTMLElement }, options?: ElementOptions) {
    return this.createEl('div', options)
  }
  proto.createSpan = function (this: HTMLElement & { createEl: (tag: string, o?: ElementOptions) => HTMLElement }, options?: ElementOptions) {
    return this.createEl('span', options)
  }
  proto.setText = function (this: HTMLElement, text: string) {
    this.textContent = text
  }
  proto.appendText = function (this: HTMLElement, text: string) {
    this.appendChild(document.createTextNode(text))
  }
  proto.empty = function (this: HTMLElement) {
    this.replaceChildren()
  }
  proto.addClass = function (this: HTMLElement, ...classes: string[]) {
    this.classList.add(...classes)
  }
  proto.removeClass = function (this: HTMLElement, ...classes: string[]) {
    this.classList.remove(...classes)
  }
  proto.toggleClass = function (this: HTMLElement, cls: string, on: boolean) {
    this.classList.toggle(cls, on)
  }
  proto.setAttr = function (this: HTMLElement, key: string, value: string) {
    this.setAttribute(key, value)
  }
  proto.setCssStyles = function (this: HTMLElement, styles: Record<string, string>) {
    Object.assign(this.style, styles)
  }
}

export function setIcon(el: HTMLElement, icon: string): void {
  el.setAttribute('data-icon', icon)
}

/** Only for the import: the Time Machine's bar builds one on a click no test makes. */
export class Menu {
  addItem(_build: (item: unknown) => unknown): this {
    return this
  }

  addSeparator(): this {
    return this
  }

  showAtMouseEvent(_event: MouseEvent): void {}
}

export class Modal {
  readonly modalEl: HTMLElement
  readonly titleEl: HTMLElement
  readonly contentEl: HTMLElement
  /** Every window open now, the newest last: a test answers the one in front. */
  static readonly open: Modal[] = []

  constructor(readonly app: unknown) {
    this.modalEl = document.createElement('div')
    this.titleEl = document.createElement('div')
    this.contentEl = document.createElement('div')
    this.modalEl.append(this.titleEl, this.contentEl)
  }

  open(): void {
    document.body.appendChild(this.modalEl)
    Modal.open.push(this)
    this.onOpen()
  }

  close(): void {
    const at = Modal.open.indexOf(this)
    if (at < 0) return
    Modal.open.splice(at, 1)
    this.modalEl.remove()
    this.onClose()
  }

  onOpen(): void {}
  onClose(): void {}
}

class ButtonComponent {
  readonly buttonEl: HTMLButtonElement

  constructor(parent: HTMLElement) {
    this.buttonEl = document.createElement('button')
    parent.appendChild(this.buttonEl)
  }

  setButtonText(text: string): this {
    this.buttonEl.textContent = text
    return this
  }

  setCta(): this {
    this.buttonEl.classList.add('mod-cta')
    return this
  }

  setWarning(): this {
    this.buttonEl.classList.add('mod-warning')
    return this
  }

  setTooltip(text: string): this {
    this.buttonEl.setAttribute('aria-label', text)
    return this
  }

  setDisabled(disabled: boolean): this {
    this.buttonEl.disabled = disabled
    return this
  }

  onClick(run: () => unknown): this {
    this.buttonEl.addEventListener('click', () => void run())
    return this
  }
}

export class Setting {
  readonly settingEl: HTMLElement

  constructor(parent: HTMLElement) {
    this.settingEl = document.createElement('div')
    this.settingEl.className = 'setting-item'
    parent.appendChild(this.settingEl)
  }

  setName(name: string): this {
    this.settingEl.setAttribute('data-name', name)
    return this
  }

  setDesc(desc: string): this {
    this.settingEl.setAttribute('data-desc', desc)
    return this
  }

  addButton(build: (button: ButtonComponent) => unknown): this {
    build(new ButtonComponent(this.settingEl))
    return this
  }
}

export function normalizePath(path: string): string {
  return path
}

/** A link's target without its heading or block reference. */
export function getLinkpath(linktext: string): string {
  const cut = linktext.search(/[#^]/)
  return cut < 0 ? linktext : linktext.slice(0, cut)
}
