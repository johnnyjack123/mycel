import { App, Modal, Setting, type ButtonComponent } from 'obsidian'
import { Notice } from '../notices.js'
import type { BackupRunStatus } from '@mycel/shared'
import { busy } from '../busy'
import type { Backups } from './Backups'

/**
 * A decrypted copy the guard held: shown over everything, wherever the
 * settings are, since with backups at night nobody watches the run that
 * held it. It says what vanished and leaves the choice: let the copy follow,
 * or not now. Letting it follow is waited for to the end, so the window
 * closes only once it is done - or says why it is not.
 */
export class CopyWaitsModal extends Modal {
  private working = false
  private decided = false

  constructor(
    app: App,
    private readonly backups: Backups,
    private readonly routeId: string,
    private readonly label: string,
    private readonly run: BackupRunStatus,
    private readonly key: string,
    private readonly openTrash: () => void,
    private readonly closed: () => void
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText('The decrypted copy waits')
    this.render()
  }

  private render(failure?: string): void {
    const { contentEl } = this
    contentEl.empty()
    const at = new Date(this.run.finishedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    contentEl.createEl('p', {
      text: `${this.label} backed this vault up on ${at}, but left the decrypted copy as it was: more vanished from the vault than its limit lets through.`
    })
    const shrunk = this.run.trusted?.shrunk ?? []
    if (shrunk.length > 0) {
      const list = contentEl.createEl('ul', { cls: 'mycel-shrunk' })
      for (const kind of shrunk) {
        const gone = kind.before > 0 ? Math.round((1 - kind.now / kind.before) * 100) : 100
        const item = list.createEl('li')
        item.createEl('strong', { text: kind.what === 'notes' ? 'Notes' : 'Files' })
        item.appendText(`: ${kind.now} now - ${kind.before} at most in the week before, ${gone} % gone`)
      }
    } else if (this.run.trusted?.held) {
      contentEl.createEl('p', { text: this.run.trusted.held })
    }
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'The repository took this backup as always and keeps the earlier ones. The copy stays as it was until you decide: the sync server may have lost data, and the copy must not follow that.'
    })
    contentEl.createEl('p', {
      text: 'Deleted on purpose? Let the copy follow. Not sure? Look first - what is gone is among the deleted notes, in the earlier backups, and still in the copy.'
    })
    if (failure) contentEl.createEl('p', { cls: 'mod-warning', text: `Letting it follow did not work: ${failure}` })
    const status = contentEl.createEl('p', { cls: 'setting-item-description mycel-follow-status' })

    let follow: ButtonComponent | null = null
    const others: ButtonComponent[] = []
    new Setting(contentEl)
      .addButton((button) => {
        others.push(button)
        button.setButtonText('Deleted notes…').onClick(() => this.openTrash())
      })
      .addButton((button) => {
        others.push(button)
        button.setButtonText('Not now').onClick(() => this.close())
      })
      .addButton((button) => {
        follow = button
        button
          .setButtonText('Let the copy follow')
          .setWarning()
          .onClick(() => {
            if (!follow) return
            for (const other of others) other.setDisabled(true)
            status.setText('Backing up, and bringing the copy level with the vault - as long as a backup takes. You may close this window; it goes on.')
            void busy(follow, () => this.follow())
          })
      })
  }

  private async follow(): Promise<void> {
    if (this.working) return
    this.working = true
    const outcome = await this.backups.followCopy(this.routeId)
    this.working = false
    if (outcome.ok) {
      this.decided = true
      const done = outcome.run?.trusted
      const counts = done && (done.written !== undefined || done.deleted !== undefined) ? ` - ${done.written ?? 0} written, ${done.deleted ?? 0} removed` : ''
      new Notice(`Mycel: the decrypted copy follows the vault again${counts}.`, 10_000)
      this.close()
      return
    }
    const why = outcome.error ?? 'the backup failed'
    // Closed meanwhile: said where it is seen.
    if (!this.contentEl.isConnected) new Notice(`Mycel: letting the decrypted copy follow did not work - ${why}`, 0)
    else this.render(why)
  }

  onClose(): void {
    // Closed without deciding - "Not now", Escape, the cross: not asked again for the same reason.
    if (!this.decided && !this.working) this.backups.dismissHold(this.key)
    this.contentEl.empty()
    this.closed()
  }
}
