// What the end-to-end self-tests share: a DOM for real CodeMirror editors,
// the check helpers, and `Device` - one device of one person, with the real
// accounts, keys, DocStore, socket and editor binding, against a fake vault
// that saves and reloads the way Obsidian does.
import { JSDOM } from 'jsdom'
import type { KeepProblem } from '../src/account/Session.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
const globals = globalThis as Record<string, unknown>
globals.window = dom.window
globals.document = dom.window.document
for (const key of [
  'navigator', 'Node', 'Element', 'HTMLElement', 'DocumentFragment', 'Range', 'Text',
  'DOMParser', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'CustomEvent', 'Event', 'KeyboardEvent', 'InputEvent',
  'ClipboardEvent', 'DragEvent', 'MouseEvent', 'CompositionEvent', 'ResizeObserver',
  'IntersectionObserver'
]) {
  const value = (dom.window as unknown as Record<string, unknown>)[key]
  if (globals[key] === undefined && value !== undefined) globals[key] = value
}
// jsdom has no layout. CodeMirror measures text in an animation frame and
// throws there without this - harmless, but it buries the test output.
const rangeProto = dom.window.Range.prototype as unknown as { getClientRects?: () => unknown }
rangeProto.getClientRects ??= () => []

// Imported after the DOM globals exist; CodeMirror reads them at module scope.
const { userColor } = await import('@mycel/shared')
const { toBase64 } = await import('@mycel/shared/crypto')
const { ConnectApi, fetchHttp } = await import('../src/account/api.js')
const { Session, VaultDeletedError } = await import('../src/account/Session.js')
const { probeServer } = await import('../src/account/probe.js')
const { KeyReplacement } = await import('../src/account/KeyReplacement.js')
const { hashWasmArgon2id } = await import('../src/account/argon2.js')
const { EditorSync } = await import('../src/editor/EditorSync.js')
const { SyncSession, CarriedTexts } = await import('../src/SyncSession.js')
const { openInviteSession, openPairingSession } = await import('../src/backup/BackupLink.js')
const { Backups } = await import('../src/backup/Backups.js')
const { Rollback } = await import('../src/sync/Rollback.js')
const { LockSeal, OwnLocks, lockNonce } = await import('../src/sync/VaultLock.js')
const { FakeVault, FakeFileManager, FakeMarkdownView, FakeMetadataCache, MemoryLocalStores, noteOf } = await import(
  './stubs/fake-vault.js'
)
const { gateApp } = await import('../src/guard.js')

type SyncHost = import('../src/SyncSession.js').SyncHost
type SessionT = InstanceType<typeof SyncSession>
type DocStoreT = NonNullable<SessionT['store']>
type Unlocked = Awaited<ReturnType<InstanceType<typeof Session>['login']>>
type ViewT = InstanceType<typeof FakeMarkdownView>

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const failures: string[] = []

export function check(ok: boolean, label: string, detail?: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`)
  if (!ok) {
    failures.push(label)
    if (detail !== undefined) console.log('      got:', JSON.stringify(detail))
  }
}

export async function eventually(predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await delay(40)
  }
  return predicate()
}

/**
 * Makes one method of a device's socket or api wait first - so many
 * milliseconds, or until a promise settles - for the calls `only` picks: an
 * order a slower machine, CI's, came to now and then, made certain. Returns
 * what makes it quick again.
 */
export function slowed(
  target: object | null,
  method: string,
  wait: number | Promise<unknown>,
  only: (...args: never[]) => boolean = () => true
): () => void {
  const holder = target as Record<string, unknown>
  const original = holder[method] as (...args: unknown[]) => Promise<unknown>
  holder[method] = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    if ((only as (...args: unknown[]) => boolean)(...args)) await (typeof wait === 'number' ? delay(wait) : wait.catch(() => undefined))
    return original.apply(this, args)
  }
  return () => {
    delete holder[method]
  }
}

export function finish(): never {
  console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
  process.exit(failures.length === 0 ? 0 : 1)
}

let serverUrl = 'ws://localhost:1234'

/** Read whenever a device connects, so a test can move to a restarted server. */
export function useServer(url: string): void {
  serverUrl = url
}

export const PASSWORD = 'correct horse battery staple'
export const VAULT = 'Test vault'
/**
 * Where the plugin keeps its own files, as Obsidian has it: inside the hidden configuration
 * folder, which the gate refuses. A folder outside it let every copy that walked its folders
 * from the top of the vault pass here and fail on a device (0.9.20).
 */
export const PLUGIN_DIR = '.obsidian/plugins/mycel'

export class Device {
  readonly vault: InstanceType<typeof FakeVault>
  /** What the user renames with in Obsidian; it rewrites the links to the file. */
  readonly fileManager: InstanceType<typeof FakeFileManager>
  readonly metadataCache: InstanceType<typeof FakeMetadataCache>
  readonly locals = new MemoryLocalStores()
  private readonly secretMap = new Map<string, string>()
  private readonly secrets = {
    load: (key: string): string | null => this.secretMap.get(key) ?? null,
    save: (key: string, value: string | null): void => {
      if (value === null) this.secretMap.delete(key)
      else this.secretMap.set(key, value)
    }
  }
  private token: string | null = null
  readonly api = new ConnectApi(() => serverUrl, fetchHttp, () => this.token)
  private readonly session = new Session(
    this.api,
    this.secrets,
    hashWasmArgon2id,
    async (token) => {
      this.token = token
    },
    () => serverUrl
  )
  /** The server knows this account by this id alone; sharing addresses it. */
  accountId = ''
  /** What this device signs in with; a password change elsewhere does not tell it. */
  password = PASSWORD
  private unlocked: Unlocked | null = null
  /** The recovery code this device was last shown. */
  recoveryCode: string | null = null
  /** Whether the last recovery on this device turned two-factor sign-in off (false when it kept it). */
  totpWasOn = false
  /** The person's authenticator app, as far as signing in on this device goes; null: no code to give. */
  authenticator: { code(): Promise<string> } | null = null
  /** Every time signing in asked for a code: whether it was asked again after a wrong one. */
  readonly askedForCode: boolean[] = []
  /**
   * What the person answers when a recovery asks whether to keep two-factor
   * sign-in: the app's code if they have one, otherwise turn it off.
   */
  keepTotp: (problem: KeepProblem) => Promise<{ code: string } | 'off' | null> = async () =>
    this.authenticator ? { code: await this.authenticator.code() } : 'off'
  /** Every time a recovery asked that: why it asked (null: the first time). */
  readonly askedToKeep: KeepProblem[] = []
  /** How often the server signed this device out while it ran. */
  signedOut = 0
  // Outlives restarts, like the plugin's own: Obsidian keeps the extension in
  // its editors while sync is stopped and started again.
  readonly editors = new EditorSync(() => this.store, noteOf)
  /**
   * The sync as the plugin runs it (`SyncSession`), the last one after a
   * shutdown: its keys stay readable, every other part is gone.
   */
  sync: SessionT | null = null
  private readonly carried = new CarriedTexts()
  get store(): SessionT['store'] {
    return this.sync?.store ?? null
  }
  get attachments(): SessionT['attachments'] {
    return this.sync?.attachments ?? null
  }
  get sharedFiles(): SessionT['sharedFiles'] {
    return this.sync?.sharedFiles ?? null
  }
  get linkClaims(): SessionT['linkClaims'] {
    return this.sync?.linkClaims ?? null
  }
  get attachmentIndex(): SessionT['attachmentIndex'] {
    return this.sync?.attachmentIndex ?? null
  }
  get index(): SessionT['index'] {
    return this.sync?.index ?? null
  }
  get keys(): SessionT['keys'] | null {
    return this.sync?.keys ?? null
  }
  get sharing(): SessionT['sharing'] {
    return this.sync?.sharing ?? null
  }
  get folders(): SessionT['folders'] {
    return this.sync?.folders ?? null
  }
  get compactor(): SessionT['compactor'] {
    return this.sync?.compactor ?? null
  }
  get trash(): SessionT['trash'] {
    return this.sync?.trash ?? null
  }
  get settings(): SessionT['accountSettings'] {
    return this.sync?.accountSettings ?? null
  }
  get contacts(): SessionT['contacts'] {
    return this.sync?.contacts ?? null
  }
  get recovery(): SessionT['recovery'] {
    return this.sync?.recovery ?? null
  }
  get socket(): SessionT['socket'] {
    return this.sync?.socket ?? null
  }
  /** Every time a link typed here named a note of this vault the people in the note lack: what was asked. */
  readonly linkQuestions: Array<import('../src/share/LinkClaims.js').LinkQuestion> = []
  /** Whether the person says yes to that question at once. */
  linkAnswer = false
  /** This device's download limit for attachments, in bytes; null fetches everything. */
  downloadLimit: number | null = null
  /** Files shown in a view that is not a Markdown editor, such as a canvas. */
  readonly openFiles = new Set<string>()
  private maxFileBytes = 0
  /** What the person answers when a note is moved into a shared folder; null leaves the window open. */
  moveInAnswer: 'share' | 'back' | null = 'share'
  /** Whether that answer shares the notes it links to as well. */
  moveInWithLinked = false
  /** Every time a window asked about moving a note into a shared folder, and where it was. */
  readonly askedMoveIn: string[] = []
  /** The same windows with what they said: who would see it, the files and notes going along, when it opened. */
  readonly moveInQuestions: Array<{ path: string; files: string[]; linked: string[]; strangers: number; people: string[]; at: number }> = []
  /** What the person answers when a note of theirs lies outside its shared folder after a crash. */
  outsideAnswer: 'end' | 'back' | null = null
  /** What this device said about shared folders, oldest first. */
  readonly folderNews: Array<{ kind: string; batch?: unknown; [key: string]: unknown }> = []
  /** Members the server listed who are not contacts, as the window over everything would name them. */
  readonly unknownMembers: Array<{ accounts: string[]; place: { kind: string } }> = []
  retentionDays = 30
  /** How many notes the device holds open at most (`maxLoadedDocuments`). */
  maxLoaded = 500
  /** How far a rollback trusts the server's clock; an hour unless a test says otherwise. */
  rollbackClockMarginMs: number | undefined = undefined
  /** What the user answers when the server turns out to have other data. */
  recoveryAnswer: 'device' | 'server' | null = null
  /** How many times this device had to ask. */
  asked = 0
  /** Which notes each question named. */
  readonly askedAbout: string[][] = []
  /** Notes kept in two versions, waiting for someone to choose. */
  readonly reviews: Array<{ docId: string; path: string; kind: string; mine: string; theirs: string; merged: string }> = []
  private refs: Array<{ name: string; listener: (...args: unknown[]) => void }> = []
  readonly views: ViewT[] = []
  /** Shares being sealed anew to a contact confirmed again; the tests wait for it. */
  renewing: Promise<void> = Promise.resolve()
  /** What the person chooses when this device meets the vault on the server for the first time; merging is what every device did before 0.9.19. */
  joinAnswer: import('../src/sync/Joining.js').JoinChoice = 'merge'
  /** Every comparison this device was shown, oldest first. */
  readonly joinPlans: Array<import('../src/sync/Joining.js').JoinPlan> = []
  /** And what came of each choice. */
  readonly joinResults: Array<import('../src/sync/Joining.js').JoinResult> = []
  /** How the last start of the notes went (`SyncSession.start`). */
  lastStart: import('../src/SyncSession.js').StartOutcome | null = null
  /** How often the server said this device's vault was deleted (0.9.24). */
  vaultDeletions = 0

  constructor(
    /** A recovery may choose another. */
    public username: string,
    private readonly signUp: boolean,
    files: Record<string, string | Uint8Array> = {}
  ) {
    this.vault = new FakeVault(files)
    this.fileManager = new FakeFileManager(this.vault)
    this.metadataCache = new FakeMetadataCache(this.vault)
  }

  /** The vault's adapter behind the plugin's gate, as main.ts hands it to everything it starts. */
  get pluginAdapter(): InstanceType<typeof FakeVault>['adapter'] {
    return (gateApp({ vault: this.vault } as never, PLUGIN_DIR) as unknown as { vault: InstanceType<typeof FakeVault> }).vault.adapter
  }

  async boot(): Promise<boolean> {
    // A restart unlocks with what the device kept; the first start signs in.
    const register = async (): Promise<Unlocked> => {
      const registered = await this.session.register(this.username, this.password)
      this.recoveryCode = registered.recoveryCode
      return registered.unlocked
    }
    const askCode = async (again: boolean): Promise<string | null> => {
      this.askedForCode.push(again)
      return this.authenticator ? this.authenticator.code() : null
    }
    let unlocked =
      (await this.session.unlock()) ??
      (this.signUp && !this.accountId ? await register() : await this.session.login(this.username, this.password, askCode))
    // What main.ts's `carryOnReplacement` does before anything syncs.
    if (unlocked.previous) unlocked = await this.carryOnReplacement(unlocked)
    this.unlocked = unlocked
    this.accountId = unlocked.accountId
    const openVault = await this.session.openVault(unlocked, VAULT)
    const vault = this.vault
    // Leaves showing files that are not notes - a canvas, a PDF - as far as
    // attachments care: which file each one shows.
    const workspace = {
      iterateAllLeaves: (visit: (leaf: { view: { file: unknown } }) => void): void => {
        for (const path of this.openFiles) visit({ view: { file: vault.getAbstractFileByPath(path) } })
      }
    }
    // Behind the plugin's gate, as main.ts has it: every test runs with it, and fails where it would refuse.
    const plain = { vault, fileManager: this.fileManager, metadataCache: this.metadataCache, workspace }
    const app = gateApp(plain as never, PLUGIN_DIR) as unknown as typeof plain
    // As main.ts: the account id, which a signed caret must name.
    const user = { id: unlocked.accountId, name: this.username, ...userColor(this.username) }
    // What main.ts's `startAttachments` asks the server, before the store that needs it.
    this.maxFileBytes = (await this.api.config()).maxFileBytes ?? 0
    // What main.ts's `renewShares` does, without its notice.
    const renew = async (account: string): Promise<void> => {
      try {
        await this.sync?.renewShares(account)
      } catch (error) {
        console.warn(`sealing the shares with ${account.slice(0, 8)} anew failed`, error)
      }
    }
    this.renewing = Promise.resolve()
    // What main.ts's `syncHost` hands over: the same session, the person answering as each test says.
    const host: SyncHost = {
      app: app as never,
      api: this.api,
      secrets: this.secrets,
      serverUrl,
      token: () => this.token ?? '',
      adapter: app.vault.adapter as never,
      root: PLUGIN_DIR,
      openLocal: this.locals.open,
      history: () => this.locals.history,
      editors: this.editors,
      carried: this.carried,
      timing: {
        syncTimeoutMs: 4_000,
        folderSettleMs: 300,
        folderDecideMs: 2_000,
        linkSettleMs: 150,
        linkAskMs: 500,
        sharedFilesClaimMs: 300,
        indexApplyMs: 100
      },
      heldLock: () => this.heldLockId,
      storeOptions: () => ({
        vaultId: openVault.vaultId,
        user,
        excludeGlobs: [],
        maxLoadedDocuments: this.maxLoaded,
        syncTimeoutMs: 4_000,
        writeDebounceMs: 150
      }),
      attachmentOptions: () => this.attachmentOptions(),
      shareFolder: () => 'Shared',
      autoAccept: () => true,
      retentionDays: () => this.retentionDays,
      notify: (kind, payload) => {
        // Caught, as main.ts's `processContacts` does: the next notice reads the inbox again.
        if (kind === 'contact') void this.contacts?.processInbox().catch(() => undefined)
        else if (kind === 'contact-removed') void this.contacts?.forget(payload as { account: string })
        else if (kind === 'contact-replaced') this.contacts?.markReplaced((payload as { account: string }).account)
        // What main.ts's `refreshAccount` does.
        else if (kind === 'account-changed') void this.refreshAccount()
        // What main.ts's `showVaultLock` does, without its window.
        else if (kind === 'vault-lock') this.followLock((payload as { lock: { sealed: string } | null }).lock)
      },
      locked: () =>
        void this.api.vaultLock(openVault.vaultId).then(
          ({ lock }) => this.followLock(lock),
          () => undefined
        ),
      full: () => undefined,
      // main.ts stops the sync and asks the person; the tests look.
      vaultDeleted: () => {
        this.vaultDeletions += 1
      },
      // What main.ts's `checkSignedIn` does.
      signedOut: (socket) =>
        void this.session.stillSignedIn().then(async (still) => {
          if (this.socket !== socket) return
          if (still !== false) {
            socket.reconnect(still === true)
            return
          }
          this.signedOut += 1
          await this.shutdown()
        }),
      askRecovery: async (notes) => {
        this.asked += 1
        this.askedAbout.push(notes)
        return this.recoveryAnswer
      },
      // What main.ts's window says.
      unknownMembers: (accounts, place) => {
        this.unknownMembers.push({ accounts, place })
      },
      folderPrompts: {
        moveIn: async (question) => {
          this.askedMoveIn.push(question.path)
          this.moveInQuestions.push({
            path: question.path,
            files: question.files,
            linked: question.linked.map((note) => note.path),
            strangers: question.strangers,
            people: question.people,
            at: Date.now()
          })
          if (this.moveInAnswer === null) {
            await question.moot
            return null
          }
          return { choice: this.moveInAnswer, withLinked: this.moveInWithLinked }
        },
        outside: async (question) => {
          if (this.outsideAnswer === null) {
            await question.moot
            return null
          }
          return this.outsideAnswer
        }
      },
      folderNews: (news) => this.folderNews.push(news as never),
      joining: {
        progress: () => undefined,
        ask: async (plan) => {
          this.joinPlans.push(plan)
          return this.joinAnswer
        },
        finished: (result) => {
          this.joinResults.push(result)
        }
      },
      askLinkedNote: (question) => {
        this.linkQuestions.push(question)
        if (this.linkAnswer) void this.linkClaims?.shareLinked(question)
      },
      contactConfirmed: (account) => {
        this.renewing = this.renewing.then(() => renew(account))
      },
      status: (sync, status) => {
        if (status !== 'connected' || this.sync !== sync || !sync.started) return
        void sync.store?.resume().then(() => this.editors.refresh())
        void sync.attachments?.resume()
        void this.refreshAccount()
        // What main.ts's `checkVaultLock` does on a reconnect: a lock lifted while away was told to nobody here.
        void this.api.vaultLock(openVault.vaultId).then(
          ({ lock }) => this.followLock(lock),
          () => undefined
        )
      },
      linksChanged: () => undefined,
      foldersChanged: () => undefined,
      transfer: () => undefined,
      settingsChanged: () => undefined,
      indexApplied: () => this.editors.refresh(),
      reviewed: (review) => this.reviews.push(review)
    }
    // What main.ts registers once; here per start, and taken off again by `shutdown`.
    this.refs = [
      vault.on('modify', (file) => {
        this.sync?.modified(file as never)
        // Obsidian's metadata cache reports a note's changed links.
        this.sync?.linksRead(file as never)
      }),
      vault.on('create', (file) => {
        this.sync?.created(file as never)
        if ((file as { extension?: string }).extension !== undefined) this.sync?.linksRead(file as never)
      }),
      vault.on('delete', (file) => this.sync?.deleted(file as never)),
      vault.on('rename', (file, oldPath) => this.sync?.renamed(file as never, oldPath as string))
    ]
    const sync = new SyncSession(host, unlocked, openVault)
    this.sync = sync
    await sync.open(() => false)
    return this.startNotes()
  }

  /** "Compare this vault with the server…" after "Not now": compared and asked once more. */
  async joinAgain(): Promise<boolean> {
    this.sync?.joinAgain()
    return this.startNotes()
  }

  /** What main.ts's `runStart` does, every step awaited. */
  private async startNotes(): Promise<boolean> {
    const sync = this.sync
    const { store, attachments, sharedFiles, folders, contacts, sharing } = sync ?? {}
    if (!sync || !store || !attachments || !sharedFiles || !folders || !contacts || !sharing) throw new Error('the sync stopped while it opened')
    const renew = async (account: string): Promise<void> => {
      try {
        await sync.renewShares(account)
      } catch (error) {
        console.warn(`sealing the shares with ${account.slice(0, 8)} anew failed`, error)
      }
    }
    this.lastStart = await sync.start()
    const started = this.lastStart === 'started'
    sync.started = started
    if (started) {
      folders.start()
      await attachments.start()
      sharedFiles.start()
      await contacts.processInbox()
      for (const account of contacts.awaitingRenewal()) await renew(account)
      await sharing.checkEnded()
      await sharing.checkIncoming()
      await folders.checkIncoming()
    }
    this.editors.refresh()
    return started
  }

  /**
   * What *Replace all keys* does, the device shut down first: every key
   * replaced on the server, then the vaults written anew - unless
   * `writeAnew` is false, as a device that broke off right after.
   */
  async replaceKeys(next: string, writeAnew = true): Promise<void> {
    if (!this.unlocked) throw new Error('not signed in')
    const { unlocked, recoveryCode } = await this.session.replaceKeys(this.unlocked, this.password, next)
    this.unlocked = unlocked
    this.recoveryCode = recoveryCode
    this.password = next
    if (writeAnew) this.unlocked = await this.carryOnReplacement(unlocked)
  }

  private async carryOnReplacement(unlocked: Unlocked): Promise<Unlocked> {
    await new KeyReplacement(this.api, unlocked, await this.session.allVaults(unlocked), { device: this.username }).run()
    return this.session.finishReplacement(unlocked)
  }

  /** Whether a replacement of the keys is under way, as this device last heard. */
  get replacing(): boolean {
    return Boolean(this.unlocked?.previous)
  }

  /** What the password dialog does. The other devices of the account are not told the new one. */
  async changePassword(next: string): Promise<void> {
    if (!this.unlocked) throw new Error('not signed in')
    this.unlocked = await this.session.changePassword(this.unlocked, this.password, next)
    this.password = next
  }

  /** What the settings do: needs the password, replaces the code. */
  async makeRecoveryCode(password = this.password): Promise<void> {
    if (!this.unlocked) throw new Error('not signed in')
    const made = await this.session.makeRecoveryCode(this.unlocked, password)
    this.unlocked = made.unlocked
    this.recoveryCode = made.code
  }

  async deleteRecoveryCode(password = this.password): Promise<void> {
    if (!this.unlocked) throw new Error('not signed in')
    this.unlocked = await this.session.deleteRecoveryCode(this.unlocked, password)
  }

  // --- a vault deleted on the server (0.9.24) --------------------------------------------

  /** What "Delete on the server…" does, with the password: the vault this device syncs. Its id. */
  async deleteVault(password = this.password): Promise<string> {
    if (!this.unlocked) throw new Error('not signed in')
    const vault = await this.session.openVault(this.unlocked, VAULT)
    this.unlocked = await this.session.deleteVault(this.unlocked, vault.vaultId, password, this.username)
    return vault.vaultId
  }

  /** The vault of this device's name as the server has it now: open, or deleted and how - what a start finds. */
  async vaultState(): Promise<{ vaultId: string } | { deleted: import('../src/account/Session.js').DeletedVaultInfo }> {
    if (!this.unlocked) throw new Error('not signed in')
    this.unlocked = await this.session.refreshBundle(this.unlocked)
    try {
      return { vaultId: (await this.session.openVault(this.unlocked, VAULT)).vaultId }
    } catch (error) {
      if (error instanceof VaultDeletedError) return { deleted: error.info }
      throw error
    }
  }

  /** "Take it back", from the window. */
  async restoreVault(vaultId: string): Promise<void> {
    if (!this.unlocked) throw new Error('not signed in')
    this.unlocked = await this.session.restoreVault(this.unlocked, vaultId)
  }

  /** "Upload this vault anew", from the window: the new vault's id. */
  async createVaultAnew(replaces: string): Promise<string> {
    if (!this.unlocked) throw new Error('not signed in')
    this.unlocked = await this.session.refreshBundle(this.unlocked)
    return (await this.session.createVaultAnew(this.unlocked, VAULT, replaces)).vaultId
  }

  /** What connecting a backup server does on the device: a backup key for this vault, and the grant it hands over. */
  async makeBackupGrant(label = 'backup server', password = this.password): Promise<import('@mycel/shared').BackupGrant> {
    if (!this.unlocked) throw new Error('not signed in')
    const vault = await this.session.openVault(this.unlocked, VAULT)
    const made = await this.session.makeBackupGrant(this.unlocked, password, vault, label)
    this.unlocked = made.unlocked
    return made.grant
  }

  async deleteBackupKey(keyId: string): Promise<void> {
    if (!this.unlocked) throw new Error('not signed in')
    this.unlocked = await this.session.deleteBackupKey(this.unlocked, keyId)
  }

  private backupsController: InstanceType<typeof Backups> | null = null
  /** When this device last saw a good backup, per backup server - main.ts keeps it in data.json. */
  backupLastGood: Record<string, number> = {}

  /** The backup servers of the vault, wired the way main.ts wires them. */
  get backups(): InstanceType<typeof Backups> {
    this.backupsController ??= new Backups({
      serverUrl: () => serverUrl,
      token: () => this.token,
      settings: () => this.settings,
      makeGrant: (password, label) => this.makeBackupGrant(label, password),
      deleteKey: (keyId) => this.deleteBackupKey(keyId),
      signingPublicKey: () => (this.keys ? toBase64(this.keys.signingPublicKey) : null),
      lastGood: () => this.backupLastGood,
      saveLastGood: async (value) => {
        this.backupLastGood = value
      }
    })
    return this.backupsController
  }

  /** What the settings ask the server before anyone signs in, with the id this device pinned. */
  probe(): ReturnType<typeof probeServer> {
    return probeServer(this.api, this.session.pinnedServerId())
  }

  /** "Use this server", signed out: the server at the address was set up anew. */
  useNewServer(): void {
    this.session.forgetServer()
  }

  /** Locks of the vault this device took itself, by what they say - main.ts's, which the Time Machine takes its lock through too. */
  readonly ownLocks = new OwnLocks()
  /** The lock this device writes under, named to every new connection - main.ts's `heldLockId`. */
  heldLockId: string | null = null

  /** Another device's lock holds what this one writes; its end lets it go. */
  private followLock(lock: { sealed: string } | null): void {
    if (lock && this.ownLocks.has(lock.sealed)) return
    this.socket?.setLocked(lock !== null)
  }

  /** The vault locked for a rollback, this connection writing under it - as main.ts's `lockForRollback`. */
  async lockForRollback(folder = ''): Promise<{ release(): Promise<void> }> {
    const keys = this.keys
    if (!keys) throw new Error('not running')
    const scope = folder ? { kind: 'folder' as const, path: folder } : { kind: 'vault' as const }
    const sealed = await new LockSeal(keys.settingsCrypto(), keys.vaultId).seal({ what: 'a rollback', device: this.username, nonce: lockNonce(), scope })
    const lock = await this.ownLocks.take(this.api, keys.vaultId, 'rollback', sealed, () => undefined)
    this.heldLockId = lock.id
    this.socket?.holdLock(lock.id)
    return {
      release: async () => {
        await this.store?.whenAllSent(30_000)
        this.heldLockId = null
        this.socket?.holdLock(null)
        await lock.release()
        this.ownLocks.delete(sealed)
      }
    }
  }

  /** Rolling the vault back, wired the way main.ts wires it. */
  get rollback(): InstanceType<typeof Rollback> {
    const keys = this.keys
    if (!keys || !this.store || !this.settings) throw new Error('not running')
    return new Rollback({
      api: this.api,
      vaultId: keys.vaultId,
      indexCrypto: keys.indexCrypto(),
      docCrypto: (docId) => keys.noteCrypto(docId, { owned: true, folder: true, owner: null }),
      store: this.store,
      attachments: this.attachments,
      settings: this.settings,
      // The backup servers once the test has reached for them, as main.ts hands them over.
      backups: this.backupsController,
      adapter: this.pluginAdapter as never,
      root: PLUGIN_DIR,
      isExcluded: () => false,
      clockMarginMs: this.rollbackClockMarginMs,
      lock: (folder) => this.lockForRollback(folder)
    })
  }

  /** A session on an invitation's route, through the sync server's relay, as connecting opens one. */
  openInviteSession(code: string, timeoutMs?: number): ReturnType<typeof openInviteSession> {
    return openInviteSession(serverUrl, this.token ?? '', code, timeoutMs)
  }

  /** A session on a vault's pairing route, as the settings open one. */
  openPairingSession(pairing: string, timeoutMs?: number): ReturnType<typeof openPairingSession> {
    return openPairingSession(serverUrl, this.token ?? '', pairing, timeoutMs)
  }

  /** Whether the server keeps a recovery code for the account, as this device last heard. */
  get hasRecoveryCode(): boolean | undefined {
    return this.unlocked?.bundle.recovery === undefined ? undefined : this.unlocked.bundle.recovery !== null
  }

  /** When the account's recovery code was made, as this device last heard; null for none. */
  get recoveryMadeAt(): number | null | undefined {
    const recovery = this.unlocked?.bundle.recovery
    return recovery === undefined ? undefined : (recovery?.createdAt ?? null)
  }

  private async refreshAccount(): Promise<void> {
    const unlocked = this.unlocked
    if (!unlocked) return
    const refreshed = await this.session.refreshBundle(unlocked).catch(() => null)
    if (refreshed && this.unlocked === unlocked) this.unlocked = refreshed
  }

  /** The sign-in screen's "Forgot your password?": signs this device in under the name and password chosen. */
  async recover(code: string, username: string, password: string): Promise<void> {
    const recovered = await this.session.recover(code, username, password, (problem) => {
      this.askedToKeep.push(problem)
      return this.keepTotp(problem)
    })
    this.recoveryCode = recovered.recoveryCode
    this.totpWasOn = recovered.totpWasOn
    this.username = username
    this.password = password
  }

  /** What the setup dialog does once the app shows a code for the secret. */
  async enableTotp(secret: Uint8Array, code: string, password = this.password): Promise<void> {
    if (!this.unlocked) throw new Error('not signed in')
    this.unlocked = await this.session.enableTotp(this.unlocked, password, new Uint8Array(secret), code)
  }

  async disableTotp(password = this.password): Promise<void> {
    if (!this.unlocked) throw new Error('not signed in')
    this.unlocked = await this.session.disableTotp(this.unlocked, password)
  }

  /** Whether signing in asks for a code, as this device last heard. */
  get hasTotp(): boolean | undefined {
    return this.unlocked?.bundle.totp
  }

  /** Whether the device holds a token and keys - what the settings show as "signed in". */
  get signedIn(): boolean {
    return this.token !== null
  }

  /** For tests that speak to the sync server as this account, without the plugin's code. */
  get accessToken(): string {
    return this.token ?? ''
  }

  /**
   * `keepViews`: sync stops while Obsidian goes on showing its editors - a
   * restart of sync, as signing out and in or a changed setting does - and
   * whatever is typed meanwhile stays in them.
   */
  async shutdown(options: { keepViews?: boolean } = {}): Promise<void> {
    this.backupsController?.closeSessions()
    if (!options.keepViews) for (const view of this.views.splice(0)) view.close()
    this.editors.unbindAll()
    for (const ref of this.refs) this.vault.offref(ref)
    this.refs = []
    await this.sync?.stop()
  }

  private attachmentOptions(): ReturnType<SyncHost['attachmentOptions']> {
    return {
      excludeGlobs: [],
      downloadLimitBytes: this.downloadLimit,
      maxFileBytes: this.maxFileBytes,
      settleMs: 100,
      rescanMs: 1_000,
      // Versions here live for seconds; all of them count.
      minVersionAgeMs: 0
    }
  }

  /** What the settings tab does when the limit is changed. */
  setDownloadLimit(bytes: number | null): void {
    this.downloadLimit = bytes
    this.attachments?.setOptions(this.attachmentOptions())
  }

  /** `saveEveryMs`: how often the view saves while it changes; Obsidian takes about two seconds. */
  open(path: string, saveEveryMs?: number): ViewT {
    const view = new FakeMarkdownView(this.vault, this.vault.file(path), this.editors.extension, document.body, saveEveryMs)
    this.views.push(view)
    return view
  }

  close(view: ViewT): void {
    view.close()
    this.views.splice(this.views.indexOf(view), 1)
  }

  docText(path: string): string | undefined {
    const docId = this.index?.docIdForPath(path)
    return docId ? this.handleText(docId) : undefined
  }

  private handleText(docId: string): string | undefined {
    const handles = (this.store as unknown as { handles: Map<string, { text(): string }> }).handles
    return handles.get(docId)?.text()
  }
}
