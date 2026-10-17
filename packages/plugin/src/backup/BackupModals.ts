import { App, DropdownComponent, Modal, Notice, Setting, TextAreaComponent, TextComponent } from 'obsidian'
import {
  BACKUP_GUARD_DEFAULT,
  BACKUP_GUARD_MAX,
  BACKUP_GUARD_MIN,
  backupGuard,
  type BackupTargetSetting,
  type KeepPolicy
} from '@obsidian-connect/shared'
import { generatePassword } from '../account/password'
import { PasswordReveal } from '../account/reveal'
import { busy, type BusyButton } from '../busy'
import { DEFAULT_KEEP, type Backups } from './Backups'

/**
 * Connects a backup server with an invitation from its operator, and the
 * password for the key it gets. `again`: one paired before whose key ended -
 * a new key over the pairing, the password alone.
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
    private readonly again: { routeId: string; label: string } | null = null
  ) {
    super(app)
    if (again) this.label = again.label
  }

  onOpen(): void {
    this.titleEl.setText(this.again ? `A new key for ${this.again.label}` : 'Connect a backup server')
    if (this.again) {
      this.contentEl.createEl('p', {
        text: 'Its key ended: a password change or a recovery ends every backup key of the account. Your password makes it a new one; its destinations and backups stay as they are.'
      })
      this.passwordRow()
      this.connectButton()
      return
    }
    this.contentEl.createEl('p', {
      text: "A backup server keeps this vault in restic repositories wherever you choose - a disk, a NAS, a cloud. Its operator gives you an invitation for it (obsidian-connect-backup invite); it works once, for one vault, within a week."
    })
    this.contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'It gets a key that reads this vault and nothing else: it can never change your notes. Whoever runs it can read this vault - connect only one you trust. The invitation never leaves this device; the sync server only passes on what is encrypted between the two.'
    })
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
    if ((!this.again && !this.code) || !this.password) {
      new Notice(this.again ? 'Enter your password.' : 'Enter the invitation and your password.')
      return
    }
    this.working = true
    try {
      await busy(button, async () => {
        if (this.again) {
          await this.backups.rekey(this.again.routeId, this.password)
          new Notice(`Obsidian Connect: ${this.again.label} has a new key and backs up as before.`, 8_000)
          return
        }
        const connected = await this.backups.connect(this.code, this.password, this.label)
        new Notice(`Obsidian Connect: ${connected.label} is connected. Add a destination next - until then it backs up nothing.`, 8_000)
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

/**
 * One place a backup server puts the vault: a restic repository, or the
 * trusted copy. Adds one, or changes one: how long backups are kept, the
 * credentials, the guard - its location and password stay, since another
 * location or password is another repository.
 */
export class BackupTargetModal extends Modal {
  private kind: BackupTargetSetting['kind'] = 'restic'
  private location = ''
  private password = ''
  private env = ''
  private keep = 'default'
  private custom: KeepPolicy = { ...DEFAULT_KEEP }
  private guard = BACKUP_GUARD_DEFAULT
  private working = false
  private readonly reveal = new PasswordReveal(true)

  constructor(
    app: App,
    private readonly backups: Backups,
    private readonly routeId: string,
    /** The backup server's backup folder, for the description. */
    private readonly root: string | null,
    private readonly hasTrusted: boolean,
    private readonly done: () => void,
    private readonly existing: BackupTargetSetting | null = null
  ) {
    super(app)
    if (existing) {
      this.kind = existing.kind
      this.location = existing.location
      this.env = Object.entries(existing.env ?? {})
        .map(([name, value]) => `${name}=${value}`)
        .join('\n')
      this.keep = presetOf(existing.keep)
      if (existing.keep) this.custom = { ...existing.keep }
      this.guard = backupGuard(existing.guard)
    }
  }

  onOpen(): void {
    this.titleEl.setText(this.existing ? 'Change a destination' : 'Add a destination')
    this.render()
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()
    const folder = this.root ? `a folder below ${this.root} on the backup server` : "a folder below the backup server's backup folder"
    if (this.existing) {
      new Setting(contentEl)
        .setName(this.kind === 'restic' ? 'Repository' : 'Trusted copy')
        .setDesc(`${this.location}. Another location or password is another repository: add that as a destination of its own.`)
    } else {
      new Setting(contentEl).setName('Kind').addDropdown((dropdown: DropdownComponent) => {
        dropdown.addOption('restic', 'A restic repository - encrypted, every backup kept')
        if (!this.hasTrusted) dropdown.addOption('trusted', 'The trusted copy - decrypted, the newest version only')
        dropdown.setValue(this.kind).onChange((value) => {
          this.kind = value === 'trusted' ? 'trusted' : 'restic'
          this.render()
        })
      })
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
    }
    if (this.kind === 'trusted') this.trustedRows()
    else this.resticRows()
    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText(this.existing ? 'Save' : 'Check and add')
        .setCta()
        .onClick(() => void this.submit(button))
    )
  }

  private trustedRows(): void {
    const { contentEl } = this
    contentEl.createEl('p', {
      cls: 'setting-item-description mod-warning',
      text: 'Every note and file of the vault lies there unencrypted, as it is now, and is brought up to date by every backup. Use it only on a disk you trust. It is what is left when the repository password is lost.'
    })
    new Setting(contentEl)
      .setName('Wait when much vanishes')
      .setDesc(
        'When this share of the notes, or of the files, is gone since the copy last followed, it waits for you to confirm - the sync server may have lost data, and the copy must not follow that. The restic backups go on either way.'
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

  private resticRows(): void {
    const { contentEl } = this
    if (!this.existing) {
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
    }
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

  private credentials(): Record<string, string> | undefined {
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
    if (!this.existing && !this.location) {
      new Notice('Enter where to put the backups.')
      return
    }
    if (!this.existing && this.kind === 'restic' && !this.password) {
      new Notice('The repository needs a password - "Make one" makes a strong one.')
      return
    }
    this.working = true
    try {
      await busy(button, async () => {
        if (this.existing) {
          await this.backups.updateTarget(
            this.routeId,
            this.existing.id,
            this.kind === 'restic' ? { keep: this.keepPolicy(), env: this.credentials() } : { guard: this.guard }
          )
          new Notice('Obsidian Connect: saved.')
          return
        }
        const target: Pick<BackupTargetSetting, 'kind' | 'location' | 'password' | 'env' | 'keep' | 'guard'> = { kind: this.kind, location: this.location }
        if (this.kind === 'restic') {
          target.password = this.password
          const env = this.credentials()
          if (env) target.env = env
          const keep = this.keepPolicy()
          if (keep) target.keep = keep
        } else if (this.guard !== BACKUP_GUARD_DEFAULT) {
          target.guard = this.guard
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
