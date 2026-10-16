import { App, DropdownComponent, Modal, Notice, Setting, TextAreaComponent, TextComponent } from 'obsidian'
import type { BackupTargetSetting, KeepPolicy } from '@obsidian-connect/shared'
import { generatePassword } from '../account/password'
import { PasswordReveal } from '../account/reveal'
import { busy, type BusyButton } from '../busy'
import { DEFAULT_KEEP, type Backups } from './Backups'

/**
 * Connects a backup server: its code, and the password for the key it gets.
 * `again`: one connected before, whose key ended or which lost the vault.
 */
export class BackupConnectModal extends Modal {
  private code = ''
  private label = ''
  private password = ''
  private working = false

  constructor(
    app: App,
    private readonly backups: Backups,
    private readonly done: () => void,
    private readonly again: { code: string; label: string } | null = null
  ) {
    super(app)
    if (again) {
      this.code = again.code
      this.label = again.label
    }
  }

  onOpen(): void {
    this.titleEl.setText(this.again ? `Connect ${this.again.label} again` : 'Connect a backup server')
    if (this.again) {
      this.contentEl.createEl('p', {
        text: 'Its key ended - a password change or a recovery ends every backup key - or it lost what it knew of this vault. Your password gives it a new key; its destinations and backups stay as they are.'
      })
      this.passwordRow()
      this.connectButton()
      return
    }
    this.contentEl.createEl('p', {
      text: 'A backup server of your own keeps this vault in restic repositories wherever you choose - a disk, a NAS, a cloud. It shows its code when it starts for the first time (or: obsidian-connect-backup code).'
    })
    this.contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'It gets a key that reads this vault and nothing else: it can never change your notes. Whoever runs it can read this vault - connect only one you trust. The code never leaves this device; this server only passes on what is encrypted between the two.'
    })
    new Setting(this.contentEl).setName("The backup server's code").addText((text) => {
      text.setPlaceholder('XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX').onChange((value) => {
        this.code = value.trim()
      })
      text.inputEl.addClass('connect-code')
      window.setTimeout(() => text.inputEl.focus(), 0)
    })
    new Setting(this.contentEl)
      .setName('Name')
      .setDesc('How it is shown here. Empty takes the name it gives itself.')
      .addText((text) =>
        text.setPlaceholder('NAS').onChange((value) => {
          this.label = value
        })
      )
    this.passwordRow()
    this.connectButton()
  }

  private passwordRow(): void {
    const reveal = new PasswordReveal()
    const setting = new Setting(this.contentEl).setName('Current password').setDesc('Its key is made with your password, like a recovery code.')
    const password = new TextComponent(setting.controlEl)
    password.onChange((value) => {
      this.password = value
    })
    reveal.attach(setting, password.inputEl)
    if (this.again) window.setTimeout(() => password.inputEl.focus(), 0)
  }

  private connectButton(): void {
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText('Connect')
        .setCta()
        .onClick(() => void this.submit(button))
    )
  }

  private async submit(button: BusyButton): Promise<void> {
    if (this.working) return
    if (!this.code || !this.password) {
      new Notice('Enter the code and your password.')
      return
    }
    this.working = true
    try {
      await busy(button, async () => {
        const connected = await this.backups.connect(this.code, this.password, this.label)
        new Notice(
          this.again
            ? `Obsidian Connect: ${connected.label} has a new key and backs up as before.`
            : `Obsidian Connect: ${connected.label} is connected. Add a destination next - until then it backs up nothing.`,
          8_000
        )
      })
      this.close()
      this.done()
    } catch (error) {
      new Notice(`Connecting failed: ${error instanceof Error ? error.message : String(error)}`, 10_000)
    } finally {
      this.working = false
    }
  }

  onClose(): void {
    this.password = ''
    this.contentEl.empty()
  }
}

const KEEPS: ReadonlyArray<{ id: string; label: string; keep: KeepPolicy | undefined }> = [
  { id: 'default', label: 'The last 3, then one a day for a week, a week for 5 weeks, a month for a year, a year for 3 years', keep: DEFAULT_KEEP },
  { id: 'month', label: 'One a day for a month', keep: { last: 3, daily: 31 } },
  { id: 'all', label: 'Every backup, forever', keep: undefined }
]

/** One place a backup server puts the vault: a restic repository, or the trusted copy. */
export class BackupTargetModal extends Modal {
  private kind: BackupTargetSetting['kind'] = 'restic'
  private location = ''
  private password = ''
  private env = ''
  private keep = 'default'
  private working = false
  private readonly reveal = new PasswordReveal(true)

  constructor(
    app: App,
    private readonly backups: Backups,
    private readonly routeId: string,
    /** The backup server's backup folder, for the description. */
    private readonly root: string | null,
    private readonly hasTrusted: boolean,
    private readonly done: () => void
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText('Add a destination')
    this.render()
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()
    new Setting(contentEl).setName('Kind').addDropdown((dropdown: DropdownComponent) => {
      dropdown.addOption('restic', 'A restic repository - encrypted, every backup kept')
      if (!this.hasTrusted) dropdown.addOption('trusted', 'The trusted copy - decrypted, the newest version only')
      dropdown.setValue(this.kind).onChange((value) => {
        this.kind = value === 'trusted' ? 'trusted' : 'restic'
        this.render()
      })
    })
    const folder = this.root ? `a folder below ${this.root} on the backup server` : "a folder below the backup server's backup folder"
    new Setting(contentEl)
      .setName(this.kind === 'restic' ? 'Location' : 'Folder')
      .setDesc(
        this.kind === 'restic'
          ? `Relative to the backup folder (nas/obsidian), ${folder}, or a location restic knows: s3:…, b2:…, sftp:…, rest:…, rclone:…. A cloud folder mounted on the backup server's host is a folder like any other.`
          : `${folder[0]?.toUpperCase()}${folder.slice(1)}. It must be empty, or one the backup server wrote before.`
      )
      .addText((text) =>
        text
          .setPlaceholder(this.kind === 'restic' ? 'nas/obsidian' : 'trusted/obsidian')
          .setValue(this.location)
          .onChange((value) => {
            this.location = value.trim()
          })
      )
    if (this.kind === 'trusted') {
      contentEl.createEl('p', {
        cls: 'setting-item-description mod-warning',
        text: 'Every note and file of the vault lies there unencrypted, as it is now, and is brought up to date by every backup. Use it only on a disk you trust. It is what is left when the repository password is lost.'
      })
    } else {
      const passwordSetting = new Setting(contentEl)
        .setName('Repository password')
        .setDesc(
          'restic encrypts the repository with it. It is kept in your account, encrypted, so every device can show it - write it down as well: without it nobody can read the repository, not even you.'
        )
      const password = new TextComponent(passwordSetting.controlEl)
      password.setValue(this.password).onChange((value) => {
        this.password = value
      })
      this.reveal.attach(passwordSetting, password.inputEl)
      passwordSetting.addButton((button) =>
        button.setButtonText('Make one').onClick(() => {
          this.password = generatePassword()
          password.setValue(this.password)
          this.reveal.set(true)
        })
      )
      new Setting(contentEl)
        .setName('Credentials')
        .setDesc('For a cloud location: one per line, NAME=value - e.g. AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for S3, B2_ACCOUNT_ID and B2_ACCOUNT_KEY for B2.')
        .addTextArea((area: TextAreaComponent) =>
          area
            .setPlaceholder('AWS_ACCESS_KEY_ID=…\nAWS_SECRET_ACCESS_KEY=…')
            .setValue(this.env)
            .onChange((value) => {
              this.env = value
            })
        )
      new Setting(contentEl).setName('Keep').addDropdown((dropdown: DropdownComponent) => {
        for (const option of KEEPS) dropdown.addOption(option.id, option.label)
        dropdown.setValue(this.keep).onChange((value) => {
          this.keep = value
        })
      })
    }
    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText('Check and add')
        .setCta()
        .onClick(() => void this.submit(button))
    )
  }

  private credentials(): Record<string, string> | undefined {
    const env: Record<string, string> = {}
    for (const line of this.env.split('\n')) {
      const equals = line.indexOf('=')
      if (equals <= 0) continue
      env[line.slice(0, equals).trim()] = line.slice(equals + 1).trim()
    }
    return Object.keys(env).length > 0 ? env : undefined
  }

  private async submit(button: BusyButton): Promise<void> {
    if (this.working) return
    if (!this.location) {
      new Notice('Enter where to put the backups.')
      return
    }
    if (this.kind === 'restic' && !this.password) {
      new Notice('The repository needs a password - "Make one" makes a strong one.')
      return
    }
    this.working = true
    try {
      await busy(button, async () => {
        const target: Pick<BackupTargetSetting, 'kind' | 'location' | 'password' | 'env' | 'keep'> = { kind: this.kind, location: this.location }
        if (this.kind === 'restic') {
          target.password = this.password
          const env = this.credentials()
          if (env) target.env = env
          const keep = KEEPS.find((option) => option.id === this.keep)?.keep
          if (keep) target.keep = keep
        }
        const added = await this.backups.addTarget(this.routeId, target)
        new Notice(added.created ? 'Obsidian Connect: the repository was made and added.' : 'Obsidian Connect: added.')
      })
      this.close()
      this.done()
    } catch (error) {
      new Notice(`The backup server cannot use this: ${error instanceof Error ? error.message : String(error)}`, 10_000)
    } finally {
      this.working = false
    }
  }

  onClose(): void {
    this.password = ''
    this.contentEl.empty()
  }
}
