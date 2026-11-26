import { Modal, type App } from 'obsidian'

/** What the window shows before *Disconnect this vault* (0.9.30). */
export interface DisconnectFacts {
  /** The vault's name, as this device syncs it. */
  vault: string
  signedIn: boolean
  /** What may not have reached the server, or null: everything did. */
  unsent: string | null
  /** What the safety copies hold; none, no choice about them. */
  copies: { files: number; bytes: number }
}

function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`
}

/** Says what goes and what stays; resolves with the choice, or null when the person stopped. */
export class DisconnectModal extends Modal {
  private resolve: ((choice: { keepCopies: boolean } | null) => void) | null = null

  constructor(
    app: App,
    private readonly facts: DisconnectFacts
  ) {
    super(app)
  }

  ask(): Promise<{ keepCopies: boolean } | null> {
    return new Promise((resolve) => {
      this.resolve = resolve
      this.open()
    })
  }

  onOpen(): void {
    const { contentEl, facts } = this
    this.titleEl.setText('Disconnect this vault')
    contentEl.createEl('p', {
      text: `This device lets go of syncing "${facts.vault}" entirely, as if Mycel had never synced it here.`
    })
    contentEl.createEl('p', { text: 'Removed from this device:' })
    const gone = contentEl.createEl('ul')
    gone.createEl('li', { text: "Mycel's copies of the notes and their history, and what this device last agreed on with the server." })
    if (facts.signedIn) gone.createEl('li', { text: 'Your sign-in and the keys on this device: you are signed out.' })
    gone.createEl('li', { text: "Mycel's log and notifications, and this device's Mycel settings - only the server's address is kept." })
    contentEl.createEl('p', { text: 'Kept: every note and file of this vault, everything on the server, and your other devices as they are.' })
    contentEl.createEl('p', {
      text: 'To sync again, sign in: this device then meets the vault as a new one - it compares this vault with the server and asks how to join.'
    })

    if (facts.unsent) {
      const warning = contentEl.createDiv({ cls: 'mycel-disconnect-warning' })
      warning.createEl('strong', { text: facts.unsent })
      warning.createSpan({ text: ' Disconnected now, it stays in the files of this vault but never reaches your other devices.' })
    }

    let keep: HTMLInputElement | null = null
    if (facts.copies.files > 0) {
      const row = contentEl.createEl('label', { cls: 'mycel-disconnect-keep' })
      keep = row.createEl('input', { type: 'checkbox' })
      row.createSpan({
        text: ` Keep the safety copies in the plugin folder (${facts.copies.files} file(s), ${megabytes(facts.copies.bytes)}): the copies of this vault made before it joined, before merges and before rollbacks.`
      })
    }

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' })
    buttons.createEl('button', { text: 'Cancel' }).onclick = () => this.answer(null)
    buttons.createEl('button', { cls: 'mod-warning', text: facts.unsent ? 'Disconnect anyway' : 'Disconnect' }).onclick = () =>
      this.answer({ keepCopies: keep?.checked ?? false })
  }

  private answer(choice: { keepCopies: boolean } | null): void {
    const resolve = this.resolve
    this.resolve = null
    resolve?.(choice)
    this.close()
  }

  onClose(): void {
    this.resolve?.(null)
    this.resolve = null
    this.contentEl.empty()
  }
}
