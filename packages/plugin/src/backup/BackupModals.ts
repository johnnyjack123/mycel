import { App, DropdownComponent, Modal, Setting, TextAreaComponent, TextComponent } from 'obsidian'
import { Notice } from '../notices.js'
import {
  BACKUP_GUARD_DEFAULT,
  BACKUP_GUARD_MAX,
  BACKUP_GUARD_MIN,
  backupGuard,
  type BackupServerSetting,
  type BackupTaskSetting,
  type KeepPolicy
} from '@obsidian-connect/shared'
import { generatePassword } from '../account/password'
import { PasswordReveal } from '../account/reveal'
import { busy, type BusyButton } from '../busy'
import { DEFAULT_KEEP, type Backups } from './Backups'

/**
 * Connects a backup server with an invitation from its operator, and the
 * password for the key it gets. `again`: one paired before whose key ended -
 * a new key over the pairing, the password alone. A vault has one backup
 * server, so connecting another replaces the one it has.
 */
export class BackupConnectModal extends Modal {
  private code = ''
  private label = ''
  private password = ''
  private working = false

  constructor(
    app: App,
    private readonly backups: Backups,
    private readonly done: (connected: BackupServerSetting | null) => void,
    private readonly again: { routeId: string; label: string } | null = null
  ) {
    super(app)
    if (again) this.label = again.label
  }

  onOpen(): void {
    this.titleEl.setText(this.again ? `A new key for ${this.again.label}` : 'Connect a backup server')
    if (this.again) {
      this.contentEl.createEl('p', {
        text: 'Its key ended: a password change or a recovery ends every backup key of the account. Your password makes it a new one; its backup task and backups stay as they are.'
      })
      this.passwordRow()
      this.connectButton()
      return
    }
    this.contentEl.createEl('p', {
      text: 'A backup server keeps this vault in a restic repository - on the backup server or in a cloud. Its operator gives you an invitation for it (obsidian-connect-backup invite); it works once, for one vault, within a week.'
    })
    this.contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'It gets a key that reads this vault and nothing else: it can never change your notes. Whoever runs it can read this vault - connect only one you trust. The invitation never leaves this device; the sync server only passes on what is encrypted between the two.'
    })
    const current = this.backups.servers()
    if (current.length > 0) {
      this.contentEl.createEl('p', {
        cls: 'setting-item-description mod-warning',
        text: `This vault is backed up by ${current.map((server) => server.label).join(', ')}. A vault has one backup server: connecting another replaces it, and it stops backing up this vault. Its backups stay where they are.`
      })
    }
    new Setting(this.contentEl).setName('Invitation').addText((text) => {
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
    this.connectButton(current.length > 0 ? 'Replace and connect' : 'Connect')
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

  private connectButton(text = 'Connect'): void {
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText(text)
        .setCta()
        .onClick(() => void this.submit(button))
    )
  }

  private async submit(button: BusyButton): Promise<void> {
    if (this.working) return
    if ((!this.again && !this.code) || !this.password) {
      new Notice(this.again ? 'Enter your password.' : 'Enter the invitation and your password.')
      return
    }
    this.working = true
    let connected: BackupServerSetting | null = null
    try {
      await busy(button, async () => {
        if (this.again) {
          await this.backups.rekey(this.again.routeId, this.password)
          new Notice(`Obsidian Connect: ${this.again.label} has a new key and backs up as before.`, 8_000)
          return
        }
        connected = await this.backups.connect(this.code, this.password, this.label)
      })
      this.close()
      this.done(connected)
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

const CUSTOM = 'custom'

const KEEP_RULES: ReadonlyArray<{ rule: keyof KeepPolicy; name: string; desc: string }> = [
  { rule: 'last', name: 'The last', desc: 'backups, whenever they were made' },
  { rule: 'hourly', name: 'Hours', desc: 'the newest backup of each of that many hours' },
  { rule: 'daily', name: 'Days', desc: 'the newest backup of each of that many days' },
  { rule: 'weekly', name: 'Weeks', desc: 'the newest backup of each of that many weeks' },
  { rule: 'monthly', name: 'Months', desc: 'the newest backup of each of that many months' },
  { rule: 'yearly', name: 'Years', desc: 'the newest backup of each of that many years' }
]

function sameKeep(a: KeepPolicy | undefined, b: KeepPolicy | undefined): boolean {
  if (!a || !b) return a === b
  return KEEP_RULES.every(({ rule }) => (a[rule] ?? 0) === (b[rule] ?? 0))
}

/** The preset a retention is, or "custom". */
function presetOf(keep: KeepPolicy | undefined): string {
  return KEEPS.find((option) => sameKeep(option.keep, keep))?.id ?? CUSTOM
}

/** How long restic keeps backups, in a few words. */
export function describeKeep(keep: KeepPolicy | undefined): string {
  if (!keep) return 'Keeps every backup.'
  const words: Record<keyof KeepPolicy, string> = { last: 'the last', hourly: 'hours', daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' }
  const parts = KEEP_RULES.filter(({ rule }) => (keep[rule] ?? 0) > 0).map(({ rule }) =>
    rule === 'last' ? `the last ${keep[rule]}` : `${keep[rule]} ${words[rule]}`
  )
  return parts.length > 0 ? `Keeps ${parts.join(', ')}.` : 'Keeps every backup.'
}

/** What the guard does, in a few words. */
export function describeGuard(guard: number | undefined): string {
  const share = backupGuard(guard)
  return share === 0
    ? 'Follows the vault whatever vanishes from it.'
    : `Waits when more than ${share} % of the notes, or of the files, vanish at once.`
}

/** Where the repository lies, as the settings name it. */
export function describeRepository(task: BackupTaskSetting, folder: string | null): string {
  if (task.where === 'cloud') return task.location ?? ''
  return folder ? `on the backup server, ${folder}` : 'on the backup server'
}

/**
 * The vault's backup task: where the restic repository lies - on the backup
 * server, in a folder it names after the vault's id, or in a cloud -, its
 * password, how long backups are kept, and whether a decrypted copy is kept
 * on the backup server too. Sets one up, or changes one: everything but the
 * repository's place and password, since another place or password is
 * another repository.
 */
export class BackupTaskModal extends Modal {
  private where: BackupTaskSetting['where'] = 'local'
  private location = ''
  private password = ''
  private env = ''
  private keep = 'default'
  private custom: KeepPolicy = { ...DEFAULT_KEEP }
  private decrypted = false
  private guard = BACKUP_GUARD_DEFAULT
  private working = false
  private readonly reveal = new PasswordReveal(true)

  constructor(
    app: App,
    private readonly backups: Backups,
    private readonly routeId: string,
    private readonly done: () => void,
    private readonly existing: BackupTaskSetting | null = null
  ) {
    super(app)
    if (existing) {
      this.where = existing.where
      this.location = existing.location ?? ''
      this.env = Object.entries(existing.env ?? {})
        .map(([name, value]) => `${name}=${value}`)
        .join('\n')
      this.keep = presetOf(existing.keep)
      if (existing.keep) this.custom = { ...existing.keep }
      this.decrypted = existing.decrypted
      this.guard = backupGuard(existing.guard)
    }
  }

  /** The backup server's folders for this vault, once it was asked. */
  private get folders(): { encrypted: string; decrypted: string } | null {
    return this.backups.view(this.routeId)?.status?.folders ?? null
  }

  onOpen(): void {
    this.titleEl.setText(this.existing ? 'Change the backup' : 'Back up this vault')
    this.render()
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()
    const folders = this.folders
    if (this.existing) {
      new Setting(contentEl)
        .setName('Repository')
        .setDesc(
          `${describeRepository(this.existing, folders?.encrypted ?? null)}. Its place and password stay; for another repository, remove this backup and set up a new one.`
        )
    } else {
      new Setting(contentEl)
        .setName('Repository')
        .setDesc('restic keeps every backup there, encrypted with its own password.')
        .addDropdown((dropdown: DropdownComponent) => {
          dropdown.addOption('local', folders ? `On the backup server - ${folders.encrypted}` : 'On the backup server')
          dropdown.addOption('cloud', 'In a cloud')
          dropdown.setValue(this.where).onChange((value) => {
            this.where = value === 'cloud' ? 'cloud' : 'local'
            this.render()
          })
        })
      if (this.where === 'cloud') {
        new Setting(contentEl)
          .setName('Location')
          .setDesc(
            'A location restic reaches: s3:…, b2:…, rest:…, azure:…, gs:…, swift:…; rclone:<remote>:<path> for any cloud rclone knows - Google Drive, OneDrive, Dropbox, Nextcloud - once its operator set the remote up there (rclone config); or sftp:…, which needs an SSH key on the backup server.'
          )
          .addText((text) =>
            text
              .setPlaceholder('s3:s3.amazonaws.com/bucket/obsidian')
              .setValue(this.location)
              .onChange((value) => {
                this.location = value.trim()
              })
          )
      }
      this.passwordRow()
    }
    if (this.where === 'cloud') {
      new Setting(contentEl)
        .setName('Credentials')
        .setDesc('One per line, NAME=value - e.g. AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for S3, B2_ACCOUNT_ID and B2_ACCOUNT_KEY for B2.')
        .addTextArea((area: TextAreaComponent) =>
          area
            .setPlaceholder('AWS_ACCESS_KEY_ID=…\nAWS_SECRET_ACCESS_KEY=…')
            .setValue(this.env)
            .onChange((value) => {
              this.env = value
            })
        )
    }
    this.keepRows()
    this.decryptedRows()
    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText(this.existing ? 'Save' : 'Check and save')
        .setCta()
        .onClick(() => void this.submit(button))
    )
  }

  private passwordRow(): void {
    const passwordSetting = new Setting(this.contentEl)
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
  }

  private keepRows(): void {
    const { contentEl } = this
    new Setting(contentEl).setName('Keep').addDropdown((dropdown: DropdownComponent) => {
      for (const option of KEEPS) dropdown.addOption(option.id, option.label)
      dropdown.addOption(CUSTOM, 'Numbers of my own')
      dropdown.setValue(this.keep).onChange((value) => {
        this.keep = value
        this.render()
      })
    })
    if (this.keep !== CUSTOM) return
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'restic keeps a backup when any of these asks for it; one backup can count for several. Empty or 0: none of that kind. All empty keeps every backup.'
    })
    for (const { rule, name, desc } of KEEP_RULES) {
      new Setting(contentEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) => {
          text.inputEl.type = 'number'
          text.inputEl.min = '0'
          text
            .setPlaceholder('0')
            .setValue(this.custom[rule] ? String(this.custom[rule]) : '')
            .onChange((value) => {
              const count = Number.parseInt(value, 10)
              if (Number.isInteger(count) && count > 0) this.custom[rule] = count
              else delete this.custom[rule]
            })
        })
    }
  }

  private decryptedRows(): void {
    const { contentEl } = this
    const folder = this.folders?.decrypted
    new Setting(contentEl)
      .setName('Decrypted copy (trusted)')
      .setDesc(
        `Also the newest version of every note and file, decrypted, ${folder ? `in ${folder}` : 'in its folder for decrypted vaults'} on the backup server - for the day the repository password is lost. Brought up to date by every backup, once the repository took it.`
      )
      .addToggle((toggle) =>
        toggle.setValue(this.decrypted).onChange((value) => {
          this.decrypted = value
          this.render()
        })
      )
    if (!this.decrypted) return
    contentEl.createEl('p', {
      cls: 'setting-item-description mod-warning',
      text: "Every note and file lies there unencrypted. Turn it on only for a backup server whose disk you trust. Should its folder for decrypted vaults lie in a cloud, then only in a cloud that is your own: any other provider could read every note."
    })
    new Setting(contentEl)
      .setName('Wait when much vanishes')
      .setDesc(
        'When this share of the notes, or of the files, is gone since the copy last followed, it waits for you to confirm - the sync server may have lost data, and the copy must not follow that. The repository takes every backup either way.'
      )
      .addDropdown((dropdown: DropdownComponent) => {
        for (let share = BACKUP_GUARD_MIN; share <= BACKUP_GUARD_MAX; share += 10) {
          dropdown.addOption(String(share), share === BACKUP_GUARD_DEFAULT ? `More than ${share} % (the default)` : `More than ${share} %`)
        }
        dropdown.addOption('0', 'Never - always follow')
        dropdown.setValue(String(this.guard)).onChange((value) => {
          this.guard = Number(value)
        })
      })
  }

  private credentials(): Record<string, string> | undefined {
    if (this.where !== 'cloud') return undefined
    const env: Record<string, string> = {}
    for (const line of this.env.split('\n')) {
      const equals = line.indexOf('=')
      if (equals <= 0) continue
      env[line.slice(0, equals).trim()] = line.slice(equals + 1).trim()
    }
    return Object.keys(env).length > 0 ? env : undefined
  }

  /** What "Keep" says: a preset, or the numbers given - none at all keeping everything. */
  private keepPolicy(): KeepPolicy | undefined {
    if (this.keep !== CUSTOM) return KEEPS.find((option) => option.id === this.keep)?.keep
    const keep: KeepPolicy = {}
    for (const { rule } of KEEP_RULES) if ((this.custom[rule] ?? 0) > 0) keep[rule] = this.custom[rule]
    return Object.keys(keep).length > 0 ? keep : undefined
  }

  private async submit(button: BusyButton): Promise<void> {
    if (this.working) return
    if (!this.existing && this.where === 'cloud' && !this.location) {
      new Notice('Enter the cloud location.')
      return
    }
    if (!this.existing && !this.password) {
      new Notice('The repository needs a password - "Make one" makes a strong one.')
      return
    }
    this.working = true
    try {
      await busy(button, async () => {
        const guard = this.decrypted && this.guard !== BACKUP_GUARD_DEFAULT ? this.guard : undefined
        if (this.existing) {
          await this.backups.updateTask(this.routeId, { keep: this.keepPolicy(), env: this.credentials(), decrypted: this.decrypted, guard })
          new Notice('Obsidian Connect: saved.')
          return
        }
        const task: Omit<BackupTaskSetting, 'server' | 'createdAt' | 'everyHours'> = { where: this.where, password: this.password, decrypted: this.decrypted }
        if (this.where === 'cloud') task.location = this.location
        const env = this.credentials()
        if (env) task.env = env
        const keep = this.keepPolicy()
        if (keep) task.keep = keep
        if (guard !== undefined) task.guard = guard
        const made = await this.backups.setTask(this.routeId, task)
        // The first backup at once: it shows whether everything works, and the vault need not wait for the night.
        await this.backups.runNow(this.routeId).catch(() => undefined)
        new Notice(
          `Obsidian Connect: ${made.created ? 'the repository was made, and ' : ''}the first backup runs now; from then on every night at three - the settings change when.`,
          10_000
        )
      })
      this.close()
      this.done()
    } catch (error) {
      new Notice(`The backup server cannot carry this out: ${error instanceof Error ? error.message : String(error)}`, 10_000)
    } finally {
      this.working = false
    }
  }

  onClose(): void {
    this.password = ''
    this.contentEl.empty()
  }
}
