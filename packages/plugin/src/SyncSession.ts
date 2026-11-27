import { TFile, TFolder, type App, type DataAdapter, type TAbstractFile } from 'obsidian'
import {
  roomKind,
  roomSubject,
  settingsRoom,
  type FolderNotice,
  type Notice as ServerNotice,
  type NotifyKind,
  type ShareNotice,
  type VaultLockNotice
} from '@mycel/shared'
import type { ConnectApi } from './account/api.js'
import { KeyRing } from './account/KeyRing.js'
import type { OpenVault, SecretStore, Unlocked } from './account/Session.js'
import type { EditorSync } from './editor/EditorSync.js'
import { Contacts } from './share/Contacts.js'
import { Folders, type FolderNews, type FolderPrompts } from './share/Folders.js'
import { LinkClaims, notePeople, type LinkQuestion } from './share/LinkClaims.js'
import type { ForeignLink } from './share/LinkedNotes.js'
import { SharedFiles } from './share/SharedFiles.js'
import { Sharing, type MemberPlace } from './share/Sharing.js'
import { AccountSettings, type MarkEvent } from './sync/AccountSettings.js'
import { AttachmentIndex } from './sync/AttachmentIndex.js'
import { AttachmentStore, type AttachmentOptions } from './sync/AttachmentStore.js'
import { BackupStore } from './sync/BackupStore.js'
import { Blobs } from './sync/Blobs.js'
import { Compactor } from './sync/Compactor.js'
import { LocalCursor, type LocalStore, type OpenLocalStore } from './sync/DocHandle.js'
import { DocStore, type DocStoreOptions } from './sync/DocStore.js'
import type { HistoryStore } from './sync/History.js'
import { Joining, type JoinHost } from './sync/Joining.js'
import { Recovery, type RecoveryChoice } from './sync/Recovery.js'
import { ReviewStore, type Review } from './sync/Reviews.js'
import { StateStore } from './sync/StateStore.js'
import { Trash } from './sync/Trash.js'
import { VaultIndex } from './sync/VaultIndex.js'
import { VaultSocket, type SocketStatus } from './sync/VaultSocket.js'
import { log } from './log.js'

const DAY_MS = 24 * 60 * 60 * 1000
/** How long a file the join moved to the trash has its delete event taken for that. */
const LEAVING_MS = 60_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** How starting the notes went: `waiting` - a device new to the vault was asked, and nothing was touched. */
export type StartOutcome = 'started' | 'unreachable' | 'waiting' | 'stopped'

/** What the server tells about the account rather than a share or a folder: the host's to carry out. */
export type AccountNoticeKind = Exclude<NotifyKind, 'share-added' | 'share-changed' | 'share-removed' | 'folder-added' | 'folder-changed' | 'folder-removed'>

/** How long the sync waits for what; the plugin's are for people, a test's for a test. */
export interface SyncTiming {
  syncTimeoutMs: number
  /** The events of one move or delete in a shared folder are gathered this long before it is weighed. */
  folderSettleMs: number
  /** A delete another device of the account made in a shared folder is left to it this long. */
  folderDecideMs: number
  /** A link typed into a shared note is claimed this long after the last keystroke there, */
  linkSettleMs: number
  /** and asked about only once the typing stopped this long. */
  linkAskMs: number
  /** A link no list names yet waits this long for this account's claim before it is left alone. */
  sharedFilesClaimMs: number
  /** Changes of the vault index are applied together, this long after the last one. */
  indexApplyMs: number
}

/**
 * What a sync session gets from whoever runs it - the plugin, or a test's
 * device: where things are kept, the settings of the moment, and everything
 * the person is told or asked. Everything between the parts of the sync is
 * the session's own, so a test runs the wiring the plugin runs.
 */
export interface SyncHost {
  readonly app: App
  readonly api: ConnectApi
  readonly secrets: SecretStore
  readonly serverUrl: string
  token(): string
  /** Where the plugin keeps its own files - the state, merge backups, reviews - and below which folder. */
  readonly adapter: DataAdapter
  readonly root: string
  readonly openLocal: OpenLocalStore
  history(vaultId: string): HistoryStore
  /** Outlives the session: Obsidian keeps its editors while the sync stops and starts again. */
  readonly editors: EditorSync
  readonly carried: CarriedTexts
  readonly timing: SyncTiming
  /** The vault lock this device writes under, if any: named to the socket before anything is sent. */
  heldLock(): string | null
  storeOptions(): DocStoreOptions
  attachmentOptions(): AttachmentOptions
  /** Where shares that come in land. */
  shareFolder(): string
  /** Whether shares that come in are taken without asking - with a single vault there is nowhere else for them. */
  autoAccept(): boolean
  retentionDays(): number
  /** This device, as the account's other devices know it: what it records carries its name and id. */
  device(): { id: string; name: string }

  // What the server says that the person hears about: about the account - contacts, a lock of this vault -, never a share or a folder.
  notify(kind: AccountNoticeKind, payload: ServerNotice): void
  signedOut(socket: VaultSocket): void
  /** The vault was deleted on the server (0.9.24): the session is no use any more. */
  vaultDeleted(): void
  locked(): void
  full(room: string): void

  // What the person is asked.
  /** A device meeting this vault on the server for the first time: the comparison, the choice, the outcome. */
  readonly joining: JoinHost
  askRecovery(notes: string[]): Promise<RecoveryChoice | null>
  unknownMembers(accounts: string[], place: MemberPlace): void
  readonly folderPrompts: FolderPrompts
  folderNews(news: FolderNews): void
  askLinkedNote(question: LinkQuestion): void
  /** A contact confirmed anew after they replaced their keys. */
  contactConfirmed(account: string): void

  // What the host draws again.
  status(session: SyncSession, status: SocketStatus): void
  linksChanged(docId: string): void
  foldersChanged(): void
  transfer(): void
  settingsChanged(remote: boolean): void
  indexApplied(): void
  /** A note kept in two versions, waiting for someone to choose - besides the list of them the session keeps. */
  reviewed?(review: Omit<Review, 'id'>): void
}

/**
 * What a stopped store knew of the texts its editors held, for the next store
 * of the same vault (invariant 25): an editor that outlived the restart still
 * shows them.
 */
export class CarriedTexts {
  private carried: { vaultId: string; held: Map<string, Set<string>> } | null = null

  keep(vaultId: string, held: Map<string, Set<string>>): void {
    this.carried = { vaultId, held }
  }

  take(vaultId: string): Map<string, Set<string>> | null {
    const carried = this.carried
    this.carried = null
    return carried?.vaultId === vaultId ? carried.held : null
  }
}

/**
 * One run of the sync for one vault: every part, built in the order they need
 * each other and taken down in the reverse. A part is null until it is built
 * and again once it is stopped - a stop may come while `open` still waits
 * for the disk or the server, and takes down what was built so far.
 */
export class SyncSession {
  readonly keys: KeyRing
  state: StateStore | null = null
  backups: BackupStore | null = null
  reviews: ReviewStore | null = null
  index: VaultIndex | null = null
  socket: VaultSocket | null = null
  history: HistoryStore | null = null
  accountSettings: AccountSettings | null = null
  store: DocStore | null = null
  attachmentIndex: AttachmentIndex | null = null
  attachments: AttachmentStore | null = null
  recovery: Recovery | null = null
  contacts: Contacts | null = null
  sharing: Sharing | null = null
  folders: Folders | null = null
  linkClaims: LinkClaims | null = null
  sharedFiles: SharedFiles | null = null
  compactor: Compactor | null = null
  trash: Trash | null = null
  joining: Joining | null = null
  /** Whether the store started - the index arrived and the vault was scanned. */
  started = false
  starting = false

  private settingsStore: LocalStore | null = null
  private settingsCursor: LocalCursor | null = null
  private readonly unwatchers: Array<() => void> = []
  private indexTimer: ReturnType<typeof setTimeout> | null = null
  /** Files the join moved to the trash: their delete events are no deletes made here. */
  private readonly leaving = new Map<string, ReturnType<typeof setTimeout>>()
  /** Once stopped, never built on again: a session is one run. */
  private closed = false

  constructor(
    private readonly host: SyncHost,
    readonly unlocked: Unlocked,
    readonly vault: OpenVault
  ) {
    const keys = new KeyRing(vault, unlocked, host.api, host.secrets)
    this.keys = keys
    // A key sealed by a contact opens only with their signature, checked against their pinned signing key.
    keys.setSigners((account) => this.contacts?.signingKey(account) ?? null)
    // A contact's caret carries the name this account calls them, not the one their device sends.
    keys.setNames((account) => (this.contacts?.isContact(account) ? this.contacts.name(account) : null))
  }

  /** Whether every link to `ref` in a note is someone else's: notes shared along with it follow only this account's. */
  readonly foreignLink: ForeignLink = (path, ref) => {
    const docId = this.store?.docIdForPath(path)
    return docId ? (this.linkClaims?.othersOnly(docId, ref) ?? false) : false
  }

  /**
   * Builds every part and connects. `stopped` is asked after every wait
   * (invariant 26): false comes back once it says so, and the stop that
   * said it takes down what was built.
   */
  async open(stoppedOutside: () => boolean): Promise<boolean> {
    if (this.closed) return false
    const stopped = (): boolean => this.closed || stoppedOutside()
    const { host, keys, vault, unlocked } = this
    const { app, api } = host
    const state = new StateStore(host.adapter, host.root)
    this.state = state
    const backups = new BackupStore(host.adapter, host.root)
    this.backups = backups
    const index = new VaultIndex(vault.vaultId, (path, generation) => keys.docId(path, generation))
    this.index = index
    const socket = new VaultSocket(host.serverUrl, vault.vaultId, () => host.token(), {
      notify: (kind, payload) => this.notified(kind, payload),
      revoked: (room) =>
        void (roomKind(room) === 'fld' ? this.folders?.onRevoked(room) : this.sharing?.onRevoked(room))?.then(() => host.editors.refresh()),
      denied: (room, reason) => log.error(`${room} was refused: ${reason}`),
      diverged: (room) => this.recovery?.diverged(room),
      signedOut: () => host.signedOut(socket),
      vaultDeleted: () => host.vaultDeleted(),
      locked: () => host.locked(),
      full: (room) => host.full(room)
    })
    // A restore from the Time Machine starts the sync under the lock it holds: named before anything is sent.
    const held = host.heldLock()
    if (held) socket.holdLock(held)
    this.socket = socket
    const history = host.history(vault.vaultId)
    this.history = history

    // The account's settings first: the scan depends on what is excluded.
    const accountSettings = new AccountSettings()
    this.accountSettings = accountSettings
    const settingsStore = host.openLocal(`mycel/${vault.vaultId}/set`, accountSettings.doc)
    this.settingsStore = settingsStore
    await settingsStore.whenSynced
    if (stopped()) return false
    // What this device records there - the Time Machine's marks - carries its name.
    accountSettings.recordAs(host.device().name)
    // In the account's settings, so every device of the account shows them and can put them together (0.9.29).
    const reviews = new ReviewStore(host.adapter, host.root, accountSettings, host.device())
    this.reviews = reviews
    void reviews.list()
    // Epochs only go forward, on every device of the vault: a server moving a room back is caught here.
    keys.setEpochRecord({ floor: (room) => accountSettings.epochFloor(room), raise: (room, epoch) => accountSettings.raiseEpochFloor(room, epoch) })
    keys.onEpochBehind((room) => this.epochBehind(room))
    const settingsCursor = await LocalCursor.load(settingsStore)
    if (stopped()) return false
    this.settingsCursor = settingsCursor
    socket.register(settingsRoom(vault.vaultId), accountSettings.doc, { crypto: keys.settingsCrypto(), cursor: settingsCursor })
    const settingsReady = (): Promise<boolean> =>
      Promise.race([socket.whenSynced(settingsRoom(vault.vaultId)).then(() => true), delay(host.timing.syncTimeoutMs).then(() => false)])

    const store = new DocStore(
      app,
      socket,
      index,
      state,
      backups,
      host.storeOptions(),
      {
        indexCrypto: keys.indexCrypto(),
        docCrypto: (docId, entry) =>
          keys.noteCrypto(docId, { owned: !entry?.owner, folder: Boolean(entry?.folder), owner: () => index.entry(docId)?.owner ?? null }),
        roomFolder: (docId, entry) => this.folders?.roomFolder(docId, entry) ?? null
      },
      host.openLocal,
      history
    )
    this.store = store
    store.watchEditors((path) => host.editors.shows(path))
    const carried = host.carried.take(vault.vaultId)
    if (carried) store.inheritHeld(carried)
    const attachmentIndex = new AttachmentIndex(index.doc, (path, generation) => keys.fileId(path, generation))
    this.attachmentIndex = attachmentIndex
    const attachments = new AttachmentStore(app, attachmentIndex, state, new Blobs(api, keys), host.attachmentOptions())
    this.attachments = attachments
    this.recovery = new Recovery({
      socket,
      store,
      settings: accountSettings,
      settingsReady: async () => {
        await settingsReady()
      },
      ask: (notes) => host.askRecovery(notes),
      onResolved: () => host.editors.refresh()
    })
    const contacts = new Contacts(
      api,
      {
        accountId: unlocked.accountId,
        username: unlocked.username,
        publicKey: unlocked.publicKey,
        privateKey: unlocked.privateKey,
        signingPublicKey: unlocked.signing.publicKey,
        signingKey: unlocked.signing.privateKey
      },
      accountSettings
    )
    this.contacts = contacts
    contacts.onConfirmed((account) => host.contactConfirmed(account))
    // A contact another device of the account made, arrived: what they shared meanwhile comes in now.
    contacts.onKnown(() => {
      socket.retryStalled()
      void this.sharing?.checkIncoming().catch((error: unknown) => log.warn('checking for shared notes failed', error))
      void this.folders?.checkIncoming().catch((error: unknown) => log.warn('checking for shared folders failed', error))
    })
    const sharing = new Sharing(
      api,
      keys,
      store,
      {
        folder: () => host.shareFolder(),
        syncTimeoutMs: host.timing.syncTimeoutMs,
        autoAccept: () => host.autoAccept(),
        folderEpoch: (folderId) => folders.currentEpoch(folderId),
        folderOver: (folderId) => folders.over(folderId),
        contactsReady: settingsReady,
        unknownMembers: (accounts, place) => host.unknownMembers(accounts, place),
        roles: {
          get: (room, account) => accountSettings.shareRole(room, account),
          set: (room, account, role) => accountSettings.setShareRole(room, account, role),
          written: (room) => accountSettings.othersMayHaveWritten(room)
        },
        approveFiles: (docId) => this.sharedFiles?.approve(docId),
        claimLinks: async (docId) => this.linkClaims?.claimAll(docId),
        marked: (event) => accountSettings.addEvent(event)
      },
      contacts
    )
    this.sharing = sharing
    // Before the vault is scanned: a note new in a shared folder takes its id from the folder.
    const folders: Folders = new Folders(
      app,
      api,
      keys,
      store,
      index,
      socket,
      host.openLocal,
      sharing,
      {
        shareFolder: () => host.shareFolder(),
        syncTimeoutMs: host.timing.syncTimeoutMs,
        autoAccept: () => host.autoAccept(),
        settleMs: host.timing.folderSettleMs,
        decideMs: host.timing.folderDecideMs,
        foreignLink: this.foreignLink,
        marked: (event) => accountSettings.addEvent(event)
      },
      host.folderPrompts,
      (news) => host.folderNews(news),
      attachments
    )
    this.folders = folders
    this.unwatchers.push(index.onFoldersChange(() => host.foldersChanged()))
    // Before the first note opens: whose a link is, it sees from the first keystroke.
    const linkClaims = new LinkClaims(app, store, keys, {
      settleMs: host.timing.linkSettleMs,
      askMs: host.timing.linkAskMs,
      deliveredPath: (docId, ref) => attachments.delivered(docId, ref)?.entry.path ?? null,
      people: notePeople(api, store, unlocked.accountId),
      name: (account) => sharing.knownName(account),
      asked: (note, target) => accountSettings.linkAsked(note, target),
      markAsked: (note, target) => accountSettings.markLinkAsked(note, target),
      ask: (question) => host.askLinkedNote(question),
      share: (target, person, landing) => sharing.share(target, person.account, person.role, false, undefined, landing)
    })
    this.linkClaims = linkClaims
    linkClaims.onChange((docId) => {
      // A link of this account's: its file may go along now.
      const entry = store.entry(docId)
      if (entry?.shared || entry?.owner) this.sharedFiles?.schedule(docId)
      host.linksChanged(docId)
    })
    this.sharedFiles = new SharedFiles(app, store, attachments, api, keys, {
      folder: () => host.shareFolder(),
      syncTimeoutMs: host.timing.syncTimeoutMs,
      claimDelayMs: host.timing.sharedFilesClaimMs,
      claimed: (docId, ref) => linkClaims.ownsRef(docId, ref),
      folders
    })
    this.compactor = new Compactor(api, keys, () => host.retentionDays())
    this.trash = new Trash(api, store, () => host.retentionDays(), attachments, folders)
    this.joining = new Joining({
      app,
      vaultId: vault.vaultId,
      index,
      attachmentIndex,
      store,
      attachments,
      state,
      backups,
      host: host.joining,
      leaving: (path) => this.leave(path),
      marked: (event) => accountSettings.addEvent(event)
    })

    // Editors bind as soon as the index is there, not after the whole vault
    // has been scanned: an open note is settled on its own, first.
    store.onReady(() => host.editors.refresh())
    // A shared note caught up after another device changed it: its list of files may have moved.
    store.onRefreshed((docId) => {
      const entry = store.entry(docId)
      if (entry?.shared || entry?.owner) this.sharedFiles?.schedule(docId)
    })
    store.onLeave((docId) => void this.sharing?.leave(docId))
    store.onReview((review) => {
      void reviews.add(review).catch((error: unknown) => log.error(`keeping the review of ${review.path} failed`, error))
      accountSettings.addEvent({ kind: 'merged', at: review.at, docId: review.docId, path: review.path })
      host.reviewed?.(review)
    })
    this.unwatchers.push(
      accountSettings.onChange((_settings, remote) => {
        this.store?.setOptions(host.storeOptions())
        this.attachments?.setOptions(host.attachmentOptions())
        host.settingsChanged(remote)
      }),
      socket.onStatus((status) => host.status(this, status)),
      index.onChange(() => this.scheduleIndexApply()),
      attachmentIndex.onChange(() => this.scheduleIndexApply()),
      attachments.onTransfer(() => host.transfer())
    )

    socket.connect()
    await settingsReady()
    return !stopped()
  }

  /**
   * Starts the notes: the index from the server, then - on a device new to this vault - the
   * comparison and the person's choice (`Joining`, invariant 34), then the vault. `waiting`:
   * nothing of the vault was touched, until asked again (`joinAgain`).
   */
  async start(): Promise<StartOutcome> {
    const { store, joining } = this
    if (this.closed || !store || !joining) return 'stopped'
    if (!(await store.openIndex())) return this.closed ? 'stopped' : 'unreachable'
    if (this.closed) return 'stopped'
    if (!(await joining.decide())) return this.closed ? 'stopped' : 'waiting'
    if (this.closed) return 'stopped'
    return (await store.start()) ? 'started' : this.closed ? 'stopped' : 'unreachable'
  }

  /** Whether the person was asked how this device joins the vault, and chose to wait. */
  get joinWaiting(): boolean {
    return this.joining?.waiting ?? false
  }

  /** Asked again: the next `start` compares and asks once more. */
  joinAgain(): void {
    this.joining?.again()
  }

  private leave(path: string): void {
    const previous = this.leaving.get(path)
    if (previous !== undefined) clearTimeout(previous)
    this.leaving.set(
      path,
      setTimeout(() => this.leaving.delete(path), LEAVING_MS)
    )
  }

  /** Whether this is the delete event of a file the join moved to the trash - once. */
  private left(path: string): boolean {
    const timer = this.leaving.get(path)
    if (timer === undefined) return false
    clearTimeout(timer)
    this.leaving.delete(path)
    return true
  }

  private notified(kind: NotifyKind, payload: ServerNotice): void {
    switch (kind) {
      case 'folder-added':
      case 'folder-changed':
      case 'folder-removed':
        void this.folders?.onNotify(kind, payload as FolderNotice).then(() => {
          this.host.editors.refresh()
          this.host.foldersChanged()
        })
        return
      case 'share-added':
      case 'share-changed':
      case 'share-removed':
        void this.sharing?.onNotify(kind, payload as ShareNotice).then(() => this.host.editors.refresh())
        return
      case 'vault-lock':
        // The account's other vaults are locked and unlocked on the same socket's account.
        if ((payload as VaultLockNotice).vaultId === this.vault.vaultId) this.host.notify(kind, payload)
        return
      default:
        this.host.notify(kind, payload)
    }
  }

  // Both stores hear every event of the vault; each takes the files that are its own.

  modified(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return
    void this.store?.onModify(file)
    this.attachments?.onModify(file)
  }

  created(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return
    void this.store?.onCreate(file)
    this.attachments?.onCreate(file)
  }

  deleted(file: TAbstractFile): void {
    if (file instanceof TFile) {
      // Only this vault had it, and the person chose the server's state: no delete for anyone.
      if (this.left(file.path)) return
      void this.store?.onDelete(file.path)
      void this.attachments?.onDelete(file.path)
    } else if (file instanceof TFolder) {
      void this.store?.onDeleteFolder(file.path)
      void this.attachments?.onDeleteFolder(file.path)
      this.folders?.onFolderDeleted(file.path)
    }
  }

  renamed(file: TAbstractFile, oldPath: string): void {
    if (file instanceof TFolder) {
      // A shared folder's place follows; its notes' own events come apart.
      this.folders?.onFolderRenamed(oldPath, file.path)
      return
    }
    if (!(file instanceof TFile)) return
    void this.store?.onRename(file, oldPath)
    void this.attachments?.onRename(file, oldPath)
  }

  /** Obsidian read a note's links anew: a shared note's files may go along or stay. */
  linksRead(file: TFile): void {
    this.sharedFiles?.noteChanged(file)
  }

  /**
   * A contact confirmed anew after they replaced their keys: what is shared with
   * them is sealed to the new ones. False while the sync is not running; throws
   * when sealing failed - the next start tries again.
   */
  async renewShares(account: string): Promise<boolean> {
    const { sharing, folders, contacts } = this
    if (!sharing || !folders || !contacts) return false
    // Their own notes and folders, sealed to this account under their new keys, open now.
    this.socket?.retryStalled()
    await sharing.renewFor(account)
    await folders.renewFor(account)
    contacts.renewed(account)
    return true
  }

  /** Something worth a mark in the Time Machine, made on this device - "Compare versions" applied (0.9.29). */
  mark(event: Omit<MarkEvent, 'id' | 'device'>): void {
    this.accountSettings?.addEvent(event)
  }

  /**
   * What this device wrote that has not reached the server, waited for a while, or null: all of
   * it did. Disconnecting before, it stays in the vault's files and never reaches the other devices.
   */
  async notYetSent(timeoutMs: number): Promise<string | null> {
    const { store, attachments } = this
    if (!this.started || !store) return 'This device is not connected, so it cannot tell whether everything written here reached the server.'
    if (!(await store.whenAllSent(timeoutMs))) return 'Something written on this device has not reached the server yet.'
    if ((attachments?.activeTransfers().uploads ?? 0) > 0) return 'Files are still being uploaded.'
    return null
  }

  /** History older than the retention folded, here and on the server, and notes deleted before it let go of. */
  async compact(): Promise<void> {
    if (!this.started || !this.compactor) return
    try {
      const compacted = await this.compactor.run()
      if (compacted > 0) log.info(`folded old history of ${compacted} note(s)`)
    } catch (error) {
      log.warn('compacting history failed', error)
    }
    // The device's own copy of the history follows the same retention.
    const days = this.host.retentionDays()
    if (days > 0) {
      await this.history?.prune(Date.now() - days * DAY_MS).catch((error: unknown) => {
        log.warn('pruning the local history failed', error)
      })
    }
    // And so do deleted notes: restorable within it, gone after.
    try {
      const purged = (await this.trash?.purge()) ?? 0
      if (purged > 0) log.info(`let go of ${purged} note(s) deleted more than ${days} days ago`)
    } catch (error) {
      log.warn('emptying the trash failed', error)
    }
  }

  /**
   * The server named an epoch below one this account knew a room in. A room of
   * this account's moves on past it; in anyone else's, nothing is written until
   * its owner's device did that.
   */
  private epochBehind(room: string): void {
    const subject = roomSubject(room)
    const kind = roomKind(room)
    if (kind === 'doc') {
      const entry = this.store?.entry(subject)
      if (entry && !entry.owner) void this.sharing?.catchUpEpoch(subject)
    } else if (kind === 'fld') {
      void this.folders?.catchUpEpoch(subject)
    }
  }

  private scheduleIndexApply(): void {
    if (this.indexTimer !== null) clearTimeout(this.indexTimer)
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null
      const store = this.store
      if (!store) return
      // New notes may have arrived, and a share may have started or ended.
      void store.applyRemoteIndexChanges().then(() => this.host.indexApplied())
      void this.attachments?.applyRemoteChanges()
      // A share may have started, and the files of shared notes may have moved.
      this.sharedFiles?.scheduleAll()
      // A file of a shared folder may have a new version here.
      this.folders?.scheduleAll()
    }, this.host.timing.indexApplyMs)
  }

  /** Takes down what `open` built, the editors already let go: releasing them hands their files back to the store. */
  async stop(): Promise<void> {
    this.closed = true
    this.joining?.stop()
    this.joining = null
    for (const timer of this.leaving.values()) clearTimeout(timer)
    this.leaving.clear()
    if (this.indexTimer !== null) {
      clearTimeout(this.indexTimer)
      this.indexTimer = null
    }
    for (const unwatch of this.unwatchers.splice(0)) unwatch()
    this.recovery?.stop()
    this.recovery = null
    await this.folders?.stop()
    this.folders = null
    this.sharedFiles?.stop()
    this.sharedFiles = null
    this.linkClaims?.stop()
    this.linkClaims = null
    // Before the notes: stopping those closes the state both write to.
    const attachments = this.attachments
    this.attachments = null
    await attachments?.stop()
    this.attachmentIndex?.destroy()
    this.attachmentIndex = null
    const store = this.store
    this.store = null
    if (store) this.host.carried.keep(this.vault.vaultId, store.heldTexts())
    await store?.stop()
    try {
      await this.settingsCursor?.flush()
      await this.settingsStore?.destroy()
    } catch (error) {
      log.error('closing the account settings failed', error)
    }
    this.socket?.destroy()
    this.index?.destroy()
    this.accountSettings?.destroy()
    this.started = false
    this.starting = false
    this.socket = null
    this.index = null
    this.state = null
    this.backups = null
    this.accountSettings = null
    this.settingsStore = null
    this.settingsCursor = null
    this.sharing = null
    this.contacts = null
    this.compactor = null
    this.trash = null
    this.reviews?.stop()
    this.reviews = null
    this.history?.close?.()
    this.history = null
  }
}
