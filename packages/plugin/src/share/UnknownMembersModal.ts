import { App, Modal, Setting } from 'obsidian'
import { Notice } from '../notices.js'
import { busy } from '../busy'

export interface UnknownMembersQuestion {
  /** The note's path or the folder's, as the user knows it. */
  where: string
  kind: 'note' | 'folder'
  /** Account ids the server lists that are not contacts. */
  accounts: string[]
  /** Takes one of them out of it - offered only when there is exactly one. */
  remove: ((account: string) => Promise<void>) | null
  closed: () => void
}

/**
 * The server listed someone in a note or folder of this account's who is no
 * contact. Over everything: a key was about to be sealed to them, and the
 * rotation that needed it did not happen - whatever it was for, a revocation
 * included, waits until this is resolved.
 */
export class UnknownMembersModal extends Modal {
  constructor(
    app: App,
    private readonly question: UnknownMembersQuestion
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText(`Someone you do not know is in this ${this.question.kind}`)
    this.render()
  }

  private render(failure?: string): void {
    const { contentEl } = this
    const { where, kind, accounts, remove } = this.question
    contentEl.empty()
    const who = accounts.map((account) => account.slice(0, 8)).join(', ')
    contentEl.createEl('p', {
      text: `The server lists ${accounts.length === 1 ? `an account (${who})` : `${accounts.length} accounts (${who})`} as member of "${where}" - and ${accounts.length === 1 ? 'it is' : 'they are'} not one of your contacts.`
    })
    contentEl.createEl('p', {
      text: `Nothing was sealed for ${accounts.length === 1 ? 'it' : 'them'}, so what was just done - sharing, revoking, the ${kind} moving to a new key - did not happen. The ${kind} keeps the key it had.`
    })
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Notes are only ever shared with contacts, and removing a contact ends every share with them. So this is either a contact removed on another device whose shares did not all end, or a server that should not be trusted with this share.'
    })
    if (accounts.length > 1) {
      contentEl.createEl('p', {
        text: 'More than one unknown member is not something a removed contact explains. Treat this server as untrusted for this share.'
      })
    }
    if (failure) contentEl.createEl('p', { cls: 'mod-warning', text: `Removing it did not work: ${failure}` })

    const buttons = new Setting(contentEl).addButton((button) => button.setButtonText('Close').onClick(() => this.close()))
    const account = accounts[0]
    if (remove && accounts.length === 1 && account) {
      buttons.addButton((button) => {
        button
          .setButtonText(`Remove it from the ${kind}`)
          .setWarning()
          .onClick(() =>
            void busy(button, async () => {
              try {
                await remove(account)
              } catch (error) {
                this.render(error instanceof Error ? error.message : String(error))
                return
              }
              new Notice(`Obsidian Connect: ${account.slice(0, 8)} is no longer in "${where}". Try again what you were doing.`, 10_000)
              this.close()
            })
          )
      })
    }
  }

  onClose(): void {
    this.contentEl.empty()
    this.question.closed()
  }
}
