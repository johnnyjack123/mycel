import { App, Modal, Setting } from 'obsidian'
import { busy } from '../busy.js'
import type { DeletedVaultInfo } from './Session.js'

// Deleting a vault on the server, and what a device sees once it was (0.9.24, the
// user's decisions of 2026-11-21): locked at once on every device, its data kept for
// a week and restorable until then, then gone - its own shares ending as copies for
// everyone in them, the shares accepted into it left. Files on the devices are never
// touched. A window over everything says so, and asks what comes next.

function date(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export interface DeleteVaultActions {
  /** The vault's name, typed to confirm. */
  name: string
  vaultId: string
  /** The backup servers that back it up: offered to run first. */
  backups: string[]
  graceDays: number
  checkPassword(password: string): Promise<boolean>
  /** Deletes it, after a fresh backup when asked for; throws to say why not. */
  run(password: string, backUpFirst: boolean): Promise<void>
}

/** "Delete this vault on the server?": what goes, what stays, the name typed and the password. */
export class DeleteVaultModal extends Modal {
  private name = ''
  private password = ''
  private backUpFirst = true
  private problem: HTMLElement | null = null
  private button: HTMLButtonElement | null = null

  constructor(
    app: App,
    private readonly actions: DeleteVaultActions
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    const { name, graceDays, backups } = this.actions
    this.titleEl.setText(`Delete "${name}" on the server?`)
    const list = contentEl.createEl('ul')
    list.createEl('li', { text: `Every device of your account stops syncing it at once. The files on every device - this one too - stay as they are.` })
    list.createEl('li', {
      text: `Its data stays on the server for ${graceDays} days: until then you can take it back, from any device of your account.`
    })
    list.createEl('li', {
      text: 'After that it is gone from the server - its version history, its trash, its past in the Time Machine. The notes and folders you shared from it end, and everyone in them keeps a copy; the ones others shared with you into it are left.'
    })
    if (backups.length > 0) list.createEl('li', { text: `Your backups on ${backups.join(', ')} stay where they are.` })
    contentEl.createEl('p', { cls: 'setting-item-description', text: `Vault id on the server: ${this.actions.vaultId}` })

    if (backups.length > 0) {
      new Setting(contentEl)
        .setName('Back up first')
        .setDesc('A fresh backup before anything is deleted. If it fails, nothing is deleted.')
        .addToggle((toggle) =>
          toggle.setValue(this.backUpFirst).onChange((value) => {
            this.backUpFirst = value
          })
        )
    }
    new Setting(contentEl)
      .setName('Type the vault\'s name')
      .setDesc(name)
      .addText((text) =>
        text.setPlaceholder(name).onChange((value) => {
          this.name = value
          this.update()
        })
      )
    new Setting(contentEl).setName('Your password').addText((text) => {
      text.inputEl.type = 'password'
      text.onChange((value) => {
        this.password = value
        this.update()
      })
    })
    this.problem = contentEl.createEl('p', { cls: 'mod-warning' })
    new Setting(contentEl)
      .addButton((cancel) => cancel.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => {
        this.button = button.buttonEl
        button
          .setButtonText('Delete on the server')
          .setWarning()
          .onClick(() => void busy(button, () => this.submit()))
      })
    this.update()
  }

  private update(): void {
    if (this.button) this.button.disabled = this.name.trim() !== this.actions.name || this.password.length === 0
  }

  private async submit(): Promise<void> {
    this.problem?.setText('')
    try {
      if (!(await this.actions.checkPassword(this.password))) {
        this.problem?.setText('That is not your password.')
        return
      }
      await this.actions.run(this.password, this.backUpFirst)
      this.close()
    } catch (error) {
      this.problem?.setText(`Nothing was deleted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

export interface VaultDeletedActions {
  restore(): Promise<void>
  uploadAnew(): Promise<void>
  otherVault(): void
}

/**
 * The vault this device syncs was deleted on the server: by whom and when, what is left,
 * and the way on - take it back while it can be, upload it anew, connect to another
 * vault, or not now. Over everything: nothing syncs meanwhile (the user: states that
 * guard data are shown where they cannot be missed).
 */
export class VaultDeletedModal extends Modal {
  constructor(
    app: App,
    private readonly info: DeletedVaultInfo,
    /** Deleted from this device a moment ago. */
    private readonly own: boolean,
    private readonly actions: VaultDeletedActions
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl, info } = this
    const name = info.name || 'This vault'
    this.titleEl.setText(`"${name}" was deleted on the server`)
    const who = this.own
      ? `You deleted it from this device on ${date(info.deletedAt)}.`
      : info.by === 'admin'
        ? `The server's admin deleted it on ${date(info.deletedAt)}.`
        : `It was deleted on ${date(info.deletedAt)}${info.device ? `, from ${info.device} of yours` : ''}.`
    contentEl.createEl('p', { text: `${who} Nothing syncs on this device any more; your files here stay as they are.` })
    if (info.purgedAt !== null) {
      contentEl.createEl('p', { text: `Its data is gone from the server since ${date(info.purgedAt)}.` })
    } else if (info.restorable) {
      contentEl.createEl('p', { text: `Its data stays on the server until ${date(info.purgeAt)}; until then it can be taken back.` })
    } else {
      contentEl.createEl('p', {
        text: info.replacedBy
          ? 'A vault of the same name was made anew in its place, so it can no longer be taken back.'
          : info.by === 'admin'
            ? `Its data stays on the server until ${date(info.purgeAt)}; only the server's admin can take it back.`
            : 'It can no longer be taken back.'
      })
    }

    if (info.restorable && info.purgedAt === null) {
      new Setting(contentEl)
        .setName('Take it back')
        .setDesc('Everything comes back as it was, on every device of your account.')
        .addButton((button) =>
          button
            .setButtonText('Take it back')
            .setCta()
            .onClick(() => void busy(button, () => this.act(() => this.actions.restore())))
        )
    }
    new Setting(contentEl)
      .setName('Upload this vault anew')
      .setDesc(
        `A new vault named "${name}" on the server, from the files on this device - compared first, as on any first connection. Your other devices find it by its name.${
          info.restorable && info.purgedAt === null ? ' The deleted one can then no longer be taken back.' : ''
        }`
      )
      .addButton((button) => button.setButtonText('Upload anew').onClick(() => void busy(button, () => this.act(() => this.actions.uploadAnew()))))
    new Setting(contentEl)
      .setName('Connect to another vault')
      .setDesc('Settings → Mycel → Account, "Vault on the server".')
      .addButton((button) =>
        button.setButtonText('Open the settings').onClick(() => {
          this.close()
          this.actions.otherVault()
        })
      )
    new Setting(contentEl)
      .setName('Not now')
      .setDesc('Nothing syncs until you choose. The command "Mycel: The vault was deleted on the server…" brings this back.')
      .addButton((button) => button.setButtonText('Not now').onClick(() => this.close()))
  }

  private async act(task: () => Promise<void>): Promise<void> {
    try {
      await task()
      this.close()
    } catch (error) {
      this.contentEl.createEl('p', { cls: 'mod-warning', text: `That did not go through: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
