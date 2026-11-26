import { Modal, type App } from 'obsidian'
import type { VaultLockInfo } from '@mycel/shared'
import { busy } from '../busy.js'
import { deviceWords } from '../device.js'
import type { LockPurpose } from '../sync/VaultLock.js'

// Windows over everything for the Time Machine's states that guard the vault:
// the user wants those where they cannot be missed, and every action to say
// when it is done.

function when(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Before the past is shown: what happens meanwhile, then each step as it goes. */
export class StartModal extends Modal {
  private resolve: ((go: boolean) => void) | null = null
  private answer: ((go: boolean) => void) | null = null
  private closed = false
  private stepsEl: HTMLElement | null = null
  private buttonsEl: HTMLElement | null = null

  constructor(
    app: App,
    private readonly what: string,
    private readonly note: boolean
  ) {
    super(app)
  }

  /** Resolves once the person chose; the window stays open for the steps. */
  ask(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve
      this.open()
    })
  }

  onOpen(): void {
    const { contentEl } = this
    this.titleEl.setText(`Time Machine: ${this.what}`)
    contentEl.createEl('p', {
      text: `${this.note ? 'The note' : 'Your files'} will show ${this.what} as it was at the moment you choose - in the normal editor${this.note ? '' : ' and the explorer'}, read-only.`
    })
    const list = contentEl.createEl('ul')
    list.createEl('li', { text: 'A backup comes first - at once when nothing changed since the last one.' })
    list.createEl('li', { text: 'The sync stops on this device until you restore a version or abort. Nothing you see is sent anywhere.' })
    list.createEl('li', {
      text: `${this.note ? 'The note' : this.what.replace(/^the /, 'The ')} is read-only on all your devices meanwhile. What is written elsewhere in the vault waits, and goes out once it is over.`
    })
    list.createEl('li', { text: 'Every file is copied into the plugin folder before it is replaced, and comes back from there - also if Obsidian closes meanwhile.' })
    this.stepsEl = contentEl.createDiv({ cls: 'mycel-tm-steps' })
    this.buttonsEl = contentEl.createDiv({ cls: 'modal-button-container' })
    this.buttonsEl.createEl('button', { text: 'Cancel' }).onclick = () => this.choose(false)
    const go = this.buttonsEl.createEl('button', { cls: 'mod-cta', text: 'Open the Time Machine' })
    go.onclick = () => this.choose(true)
  }

  private choose(go: boolean): void {
    const resolve = this.resolve
    this.resolve = null
    resolve?.(go)
    if (!go) this.close()
    else this.buttonsEl?.empty()
  }

  /** One step of opening it, shown as it happens. */
  step(text: string): void {
    this.stepsEl?.empty()
    this.stepsEl?.createDiv({ cls: 'mycel-tm-step', text })
  }

  /** A question on the way: go on or stop. Closing the window stops. */
  async goOn(question: string, goLabel: string): Promise<boolean> {
    return new Promise((resolve) => {
      const buttons = this.buttonsEl
      if (!buttons || this.closed) return resolve(false)
      const answer = (go: boolean): void => {
        this.answer = null
        buttons.empty()
        resolve(go)
      }
      this.answer = answer
      this.stepsEl?.empty()
      this.stepsEl?.createEl('p', { cls: 'mod-warning', text: question })
      buttons.empty()
      buttons.createEl('button', { text: 'Stop' }).onclick = () => answer(false)
      buttons.createEl('button', { cls: 'mod-warning', text: goLabel }).onclick = () => answer(true)
    })
  }

  onClose(): void {
    this.closed = true
    this.resolve?.(false)
    this.resolve = null
    this.answer?.(false)
    this.contentEl.empty()
  }
}

/** On every other device of the account while the vault is locked. */
export class LockedModal extends Modal {
  constructor(
    app: App,
    private readonly lock: VaultLockInfo,
    private readonly purpose: LockPurpose | null,
    private readonly unlock: () => Promise<boolean>
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    this.titleEl.setText('The vault is locked')
    const what = this.purpose ? `${this.purpose.what}, on ${deviceWords(this.purpose.device)}` : 'another device of yours'
    contentEl.createEl('p', {
      text:
        this.lock.kind === 'rollback'
          ? `A rollback of ${what} runs since ${when(this.lock.takenAt)}.`
          : `The Time Machine shows the past of ${what} since ${when(this.lock.takenAt)}.`
    })
    const scope = this.purpose?.scope
    const locked = !scope || scope.kind === 'vault' ? 'Every note of the vault' : scope.kind === 'folder' ? `Every note in ${scope.path}` : `The note ${scope.path}`
    contentEl.createEl('p', {
      text: `${locked} is read-only here until it is over. Whatever else is written on this device waits and goes out once the lock ends; what comes from your other devices and the people you share with still arrives.`
    })
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Lift it only if that device hangs or is gone: the lock also ends by itself two minutes after its device stops answering. What is written into it after you lift it is kept - a restore there merges it in. Later, the bar at the top of a locked note, the lock in its header, the cloud in the status bar and This device in the settings lift it too.'
    })
    const buttons = contentEl.createDiv({ cls: 'modal-button-container' })
    const lift = buttons.createEl('button', { cls: 'mod-warning', text: 'Unlock…' })
    lift.onclick = () => this.confirm(buttons)
    buttons.createEl('button', { cls: 'mod-cta', text: 'OK' }).onclick = () => this.close()
  }

  private confirm(buttons: HTMLElement): void {
    buttons.empty()
    buttons.createEl('p', { text: 'Unlock the vault on all your devices? The device that locked it is told so.' })
    buttons.createEl('button', { text: 'Keep it locked' }).onclick = () => this.close()
    const go = buttons.createEl('button', { cls: 'mod-warning', text: 'Unlock' })
    const spinning = { buttonEl: go, setDisabled: (disabled: boolean) => (go.disabled = disabled) }
    go.onclick = () =>
      void busy(spinning, async () => {
        await this.unlock()
        this.close()
      })
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

/** A question with two answers, over everything; closing the window answers no. */
export class ConfirmModal extends Modal {
  private resolve: ((go: boolean) => void) | null = null

  constructor(
    app: App,
    private readonly title: string,
    private readonly question: string,
    private readonly goLabel: string
  ) {
    super(app)
  }

  ask(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve
      this.open()
    })
  }

  onOpen(): void {
    this.titleEl.setText(this.title)
    this.contentEl.createEl('p', { text: this.question })
    const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' })
    buttons.createEl('button', { text: 'Stop' }).onclick = () => this.answer(false)
    buttons.createEl('button', { cls: 'mod-warning', text: this.goLabel }).onclick = () => this.answer(true)
  }

  private answer(go: boolean): void {
    const resolve = this.resolve
    this.resolve = null
    resolve?.(go)
    this.close()
  }

  onClose(): void {
    this.resolve?.(false)
    this.resolve = null
    this.contentEl.empty()
  }
}

/** Putting the files back left some out: the sync stays off until they are back. */
export class RestoreFailedModal extends Modal {
  constructor(
    app: App,
    private readonly failed: string[],
    private readonly retry: () => Promise<boolean>
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    this.titleEl.setText('Not everything is back yet')
    contentEl.createEl('p', {
      text: `${this.failed.length} file(s) could not be put back as they were. The sync stays off on this device until they are: it would take the past in them for changes and send it everywhere.`
    })
    const list = contentEl.createEl('ul')
    for (const path of this.failed.slice(0, 12)) list.createEl('li', { text: path })
    if (this.failed.length > 12) list.createEl('li', { text: `… and ${this.failed.length - 12} more` })
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Their copies lie in the plugin folder, under timemachine/. Close what has these files open, then try again; the next start of Obsidian tries too.'
    })
    const buttons = contentEl.createDiv({ cls: 'modal-button-container' })
    const again = buttons.createEl('button', { cls: 'mod-cta', text: 'Try again' })
    const spinning = { buttonEl: again, setDisabled: (disabled: boolean) => (again.disabled = disabled) }
    again.onclick = () =>
      void busy(spinning, async () => {
        if (await this.retry()) this.close()
      })
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

/** A backup was made that lies on this device alone (`docs/TIMEMACHINE.md`, V4). */
export class LocalOnlyModal extends Modal {
  constructor(
    app: App,
    private readonly what: string,
    private readonly where: string,
    private readonly days: number,
    private readonly why: string
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    this.titleEl.setText('This backup is only on this device')
    contentEl.createEl('p', { text: `${this.what} lies in ${this.where}, in the plugin folder - and nowhere else: ${this.why}.` })
    contentEl.createEl('p', {
      text:
        this.days > 0
          ? `It is kept for ${this.days} days (Keep backups for, under All devices), then deleted. Copy it elsewhere if you want it longer.`
          : 'It is kept until you delete it (Keep backups for is 0).'
    })
    const buttons = contentEl.createDiv({ cls: 'modal-button-container' })
    buttons.createEl('button', { cls: 'mod-cta', text: 'OK' }).onclick = () => this.close()
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
