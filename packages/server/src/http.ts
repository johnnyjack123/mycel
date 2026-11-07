import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import {
  API,
  BLOB_CHUNK_BYTES,
  BLOB_CHUNK_OVERHEAD,
  PROTOCOL_VERSION,
  isHexId,
  type AcceptRequest,
  type AttachBlobsRequest,
  type BackupKeyCreated,
  type BackupKeyDeleteRequest,
  type BackupKeyRequest,
  type BackupLoginRequest,
  type BackupRoomsResponse,
  type BackupSessionResponse,
  type BlobHaveResponse,
  type BlobIdsRequest,
  type BlobInfo,
  type BlobListResponse,
  type BlobPurgeResponse,
  type BlobTouchResponse,
  type BlobUsageResponse,
  type AuthConfigResponse,
  type ResealRequest,
  type RotateRequest,
  type SealedEpochsResponse,
  type ChangedResponse,
  type TimesResponse,
  type CompactableResponse,
  type ContactCodeInfo,
  type ContactCodeRequest,
  type ContactReplyRequest,
  type ContactsResponse,
  type CreateVaultRequest,
  type InboxResponse,
  type RedeemRequest,
  type DocRequest,
  type FolderAcceptRequest,
  type FolderEndRequest,
  type FolderJoinRequest,
  type FolderLeaveRequest,
  type FolderRevokeRequest,
  type FolderRoleRequest,
  type FolderRotation,
  type FolderShareRequest,
  type FolderStateResponse,
  type ForkDoneRequest,
  type ForksResponse,
  type ImportRequest,
  type IncomingFoldersResponse,
  type IncomingSharesResponse,
  type AccountBundle,
  type LoginRequest,
  type OwnedRoomsResponse,
  type PasswordChangeRequest,
  type ReplaceKeysRequest,
  type RewriteRequest,
  type WholeLogResponse,
  type RecoverCommitRequest,
  type RecoverRequest,
  type RecoverResponse,
  type RecoveryDeleteRequest,
  type RecoverySetRequest,
  type RefreshResponse,
  type RegisterRequest,
  type SecondFactorRequired,
  type TotpDisableRequest,
  type TotpEnableRequest,
  type TotpLoginRequest,
  type RevokeRequest,
  type RoleRequest,
  type SessionResponse,
  type ShareRequest,
  type SnapshotRequest,
  type StartSnapshotRequest,
  type VaultLockIdRequest,
  type VaultLockRequest,
  type VaultLockResponse,
  type VaultLockTaken
} from '@mycel/shared'
import { AccountError, isAccountId, sessionOf, type AccountStore, type StoredAccount } from './accounts.js'
import type { TokenService, TokenSession } from './auth.js'
import { BlobError, type BlobStore } from './blobs.js'
import type { ServerConfig } from './config.js'
import type { ContactStore } from './contacts.js'
import { HubError, type RoomHub } from './rooms.js'
import { AddressGuard, paced } from './throttle.js'

interface RoomParams {
  room: string
}

interface DocParams {
  docId: string
}

interface FolderParams {
  folderId: string
}

/** Whose store, which vault: every blob route names both, so reading someone else's store later needs no new routes. */
interface StoreParams {
  account: string
  vaultId: string
}

interface BlobParams extends StoreParams {
  blobId: string
}

interface ChunkParams extends BlobParams {
  chunk: string
}

// Snapshots and imported histories travel as base64 JSON - read only for a
// request whose token this server signed.
const BODY_LIMIT = 64 * 1024 * 1024
/** Signing in, registering, a recovery: a few keys. Anyone may send these, so they stay small. */
const PUBLIC_BODY_LIMIT = 64 * 1024

export interface HttpOptions {
  /** The reverse proxies whose X-Forwarded-For counts (`MYCEL_TRUST_PROXY`). */
  trustProxy?: string[]
  logger?: boolean
  /** How long every sign-in and registration takes; shorter in self-tests. */
  paceMs?: number
  /** The clock codes from an authenticator app are checked against; a self-test's own. */
  now?: () => number
  /** Failures an address may have within 15 minutes; more in self-tests, which fail on purpose. */
  maxFailures?: number
}

export function createHttpApp(
  config: ServerConfig,
  tokens: TokenService,
  accounts: AccountStore,
  hub: RoomHub,
  contacts: ContactStore,
  blobs: BlobStore,
  options: HttpOptions = {}
): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: BODY_LIMIT, trustProxy: options.trustProxy ?? false })
  const guard = new AddressGuard(options.maxFailures)
  const small = { bodyLimit: PUBLIC_BODY_LIMIT }

  // Every route but these takes a token, and checks it before anything else -
  // before its body is read: 64 MiB of JSON from anyone, as often as they
  // liked, was parsed before the route turned it away.
  const open: ReadonlySet<string> = new Set([
    API.health,
    API.config,
    API.register,
    API.login,
    API.loginTotp,
    API.recover,
    `${API.recover}/commit`,
    API.backupLogin
  ])
  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions.url
    if (route !== undefined && open.has(route)) return
    if (!(await tokens.signed(bearer(request)))) await reply.code(401).send({ error: 'sign in again' })
  })
  // Wrong codes, per account: five within 15 minutes block codes for 15.
  const codeGuard = new AddressGuard(5)
  const now = options.now ?? Date.now

  // Blob chunks travel raw: base64 in JSON would add a third to every file.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: BLOB_CHUNK_BYTES + BLOB_CHUNK_OVERHEAD },
    (_request, body, done) => done(null, body)
  )

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AccountError || error instanceof HubError || error instanceof BlobError) {
      return reply.code(error.status).send({ error: error.message })
    }
    app.log.error(error)
    const { statusCode, message } = error as { statusCode?: number; message?: string }
    const status = statusCode ?? 500
    return reply.code(status).send({ error: status === 500 ? 'internal error' : (message ?? 'error') })
  })

  function bearer(request: FastifyRequest): string {
    const header = request.headers.authorization ?? ''
    return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  }

  /** The account behind a device's token, or null. */
  async function userOf(token: string): Promise<string | null> {
    try {
      const { accountId, gen } = await tokens.verify(token)
      const account = await accounts.get(accountId)
      // A token from before the password changed was signed out with it.
      if (account && sessionOf(account) === gen) return accountId
    } catch {
      // not a device's token
    }
    return null
  }

  /** The account behind the bearer token, or a 401 already sent. Backup tokens never pass here. */
  async function user(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const accountId = await userOf(bearer(request))
    if (accountId) return accountId
    await reply.code(401).send({ error: 'sign in again' })
    return null
  }

  /**
   * Whoever may read: a device of the account (`vaultId` null), or a backup
   * server whose key still stands, limited to its one vault. The key is looked
   * up on every request, so deleting it ends its tokens at once.
   */
  async function reader(request: FastifyRequest, reply: FastifyReply): Promise<{ accountId: string; vaultId: string | null } | null> {
    const token = bearer(request)
    const accountId = await userOf(token)
    if (accountId) return { accountId, vaultId: null }
    try {
      const backup = await tokens.verifyBackup(token)
      const account = await accounts.get(backup.accountId)
      const key = account?.backupKeys?.[backup.keyId]
      if (account && sessionOf(account) === backup.gen && key?.vaultId === backup.vaultId && account.vaults[backup.vaultId]) {
        return { accountId: backup.accountId, vaultId: backup.vaultId }
      }
    } catch {
      // falls through to 401
    }
    await reply.code(401).send({ error: 'sign in again' })
    return null
  }

  /** A reader of this room: any room the account may read, or for a backup server one of its vault. */
  async function roomReader(request: FastifyRequest, reply: FastifyReply, room: string): Promise<string | null> {
    const who = await reader(request, reply)
    if (!who) return null
    if (who.vaultId !== null && !(await hub.inVault(who.accountId, who.vaultId, room))) {
      await reply.code(403).send({ error: 'not part of this vault' })
      return null
    }
    return who.accountId
  }

  async function session(accountId: string): Promise<SessionResponse> {
    const account = await accounts.get(accountId)
    if (!account) throw new AccountError(401, 'unknown account')
    const issued = await tokens.issue(accountId, sessionOf(account))
    return { token: issued.token, expiresIn: issued.expiresIn, account: accounts.bundle(account) }
  }

  /**
   * Sign-in, registration and password change: always the same time, and an
   * address that keeps failing is turned away before anything is looked at.
   */
  async function guarded<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    task: () => Promise<T | null>,
    refusal = 'wrong name or password'
  ): Promise<T | undefined> {
    const address = request.ip
    return paced(async () => {
      if (guard.blocked(address)) {
        await reply.code(429).send({ error: 'too many attempts; try again later' })
        return undefined
      }
      try {
        const result = await task()
        if (result === null) {
          guard.failed(address)
          await reply.code(401).send({ error: refusal })
          return undefined
        }
        return result
      } catch (error) {
        if (error instanceof AccountError && error.status >= 400 && error.status < 500) guard.failed(address)
        throw error
      }
    }, options.paceMs)
  }

  app.get(API.health, async () => ({ ok: true, service: 'mycel-server', protocol: PROTOCOL_VERSION }))

  // --- accounts ------------------------------------------------------------------

  app.get(API.config, async (): Promise<AuthConfigResponse> => ({
    registration: config.registration,
    protocol: PROTOCOL_VERSION,
    serverId: await accounts.serverId(),
    maxFileBytes: blobs.limits.maxFileBytes
  }))

  app.post(API.register, small, async (request, reply) =>
    guarded(request, reply, async (): Promise<SessionResponse> => {
      const account = await accounts.register(request.body as RegisterRequest, config.registration)
      return session(account.accountId)
    })
  )

  app.post(API.login, small, async (request, reply) =>
    guarded(request, reply, async (): Promise<SessionResponse | SecondFactorRequired | null> => {
      const account = await accounts.login(((request.body ?? {}) as Partial<LoginRequest>).loginKey)
      if (!account) return null
      if (!account.totp) return session(account.accountId)
      // The right password, but no session and no keys yet.
      void reply.code(403)
      return {
        error: 'This account signs in with a code from an authenticator app.',
        secondFactor: 'totp',
        challenge: await tokens.challenge(account.accountId, sessionOf(account))
      }
    })
  )

  app.post(API.loginTotp, small, async (request, reply) =>
    guarded(
      request,
      reply,
      async (): Promise<SessionResponse | null> => {
        const body = (request.body ?? {}) as Partial<TotpLoginRequest>
        let challenge: TokenSession
        try {
          challenge = await tokens.verifyChallenge(typeof body.challenge === 'string' ? body.challenge : '')
        } catch {
          throw new AccountError(401, 'that took too long; sign in again')
        }
        const account = await accounts.get(challenge.accountId)
        if (!account || sessionOf(account) !== challenge.gen) throw new AccountError(401, 'sign in again')
        // Only someone who knew the password gets here, so wrong codes can be
        // counted per account - six digits are not much to guess.
        if (codeGuard.blocked(account.accountId)) throw new AccountError(429, 'too many wrong codes; try again later')
        const right = await accounts.checkTotp(account.accountId, body.code, now())
        if (right === null) return session(account.accountId)
        if (!right) {
          codeGuard.failed(account.accountId)
          return null
        }
        return session(account.accountId)
      },
      'wrong code'
    )
  )

  app.post(API.refresh, async (request, reply): Promise<RefreshResponse | undefined> => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const { token, expiresIn } = await session(accountId)
    return { token, expiresIn }
  })

  app.post(API.password, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return guarded(request, reply, async () => {
      await accounts.changePassword(accountId, request.body as PasswordChangeRequest)
      hub.disconnect(accountId)
      return session(accountId)
    })
  })

  // Every key replaced: the account's devices are signed out, its open codes
  // and what waits in its inbox go, and its contacts are told to trust nothing
  // in its name until they confirmed it again.
  app.post(API.replaceKeys, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return guarded(request, reply, async () => {
      await accounts.replaceKeys(accountId, request.body as ReplaceKeysRequest)
      hub.disconnect(accountId)
      for (const contact of await contacts.replaced(accountId)) hub.notify(contact, 'contact-replaced', { account: accountId })
      return session(accountId)
    })
  })

  app.post(`${API.replaceKeys}/done`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return guarded(request, reply, async () => {
      const { id } = (request.body ?? {}) as { id?: unknown }
      const account = await accounts.finishReplacement(accountId, id)
      return accounts.bundle(account)
    })
  })

  /**
   * Tells the account's devices that its bundle changed: they show 2FA and the
   * recovery code from it, and otherwise learned of a change only on a restart.
   */
  const changed = (accountId: string, bundle: AccountBundle): AccountBundle => {
    hub.notify(accountId, 'account-changed', { account: accountId })
    return bundle
  }

  // --- recovery ------------------------------------------------------------------
  // The code is the credential: whoever has it gets the second wrapping, and
  // with it sets a new name and password. Unknown codes count against the
  // address like wrong passwords.

  const unknownCode = 'this recovery code is not known here'

  app.post(API.recover, small, async (request, reply) =>
    guarded(
      request,
      reply,
      async (): Promise<RecoverResponse | null> => {
        const account = await accounts.findByRecovery(((request.body ?? {}) as Partial<RecoverRequest>).recoveryKey)
        if (!account?.recovery) return null
        return {
          accountId: account.accountId,
          publicKey: account.publicKey,
          wrappedPrivateKey: account.recovery.wrappedPrivateKey,
          wrappedAccountSecret: account.recovery.wrappedAccountSecret,
          totp: Boolean(account.totp)
        }
      },
      unknownCode
    )
  )

  app.post(`${API.recover}/commit`, small, async (request, reply) =>
    guarded(
      request,
      reply,
      async (): Promise<SessionResponse | null> => {
        const body = (request.body ?? {}) as RecoverCommitRequest
        const found = await accounts.findByRecovery(body.recoveryKey)
        const keeping = Boolean(found?.totp) && body.totpCode !== undefined
        // Codes to keep the second factor are counted like those signing in:
        // a block leaves turning it off, which the recovery code allows anyway.
        if (found && keeping && codeGuard.blocked(found.accountId)) throw new AccountError(429, 'too many wrong codes; try again later')
        let account: StoredAccount | null
        try {
          account = await accounts.recover(body, now())
        } catch (error) {
          if (found && keeping && error instanceof AccountError && error.status === 401) codeGuard.failed(found.accountId)
          throw error
        }
        if (!account) return null
        hub.disconnect(account.accountId)
        return { ...(await session(account.accountId)), totpWasOn: Boolean(found?.totp) && !account.totp }
      },
      unknownCode
    )
  )

  // --- two-factor sign-in ----------------------------------------------------------

  app.post(API.totp, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return guarded(request, reply, async (): Promise<SessionResponse> => {
      const body = (request.body ?? {}) as Partial<TotpEnableRequest>
      await accounts.enableTotp(accountId, body.loginKey, body.secret, body.code, now())
      // Every other device signs in again, with a code; this one carries on.
      hub.disconnect(accountId)
      return session(accountId)
    })
  })

  app.post(`${API.totp}/off`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return guarded(request, reply, async (): Promise<AccountBundle> => {
      const body = (request.body ?? {}) as Partial<TotpDisableRequest>
      return changed(accountId, accounts.bundle(await accounts.disableTotp(accountId, body.loginKey)))
    })
  })

  app.post(API.recovery, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return guarded(request, reply, async (): Promise<AccountBundle> => {
      const body = (request.body ?? {}) as Partial<RecoverySetRequest>
      return changed(accountId, accounts.bundle(await accounts.setRecovery(accountId, body.loginKey, body.recovery ?? {})))
    })
  })

  app.post(`${API.recovery}/delete`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return guarded(request, reply, async (): Promise<AccountBundle> => {
      const body = (request.body ?? {}) as Partial<RecoveryDeleteRequest>
      return changed(accountId, accounts.bundle(await accounts.setRecovery(accountId, body.loginKey, null)))
    })
  })

  // --- backup keys -----------------------------------------------------------------

  app.post(API.backupKeys, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return guarded(request, reply, async (): Promise<BackupKeyCreated> => {
      const body = (request.body ?? {}) as Partial<BackupKeyRequest>
      const id = await accounts.addBackupKey(accountId, body.loginKey, body.vaultId, body.backupKey, body.label, now())
      const account = await accounts.get(accountId)
      if (!account) throw new AccountError(401, 'unknown account')
      return { id, account: changed(accountId, accounts.bundle(account)) }
    })
  })

  app.post(`${API.backupKeys}/delete`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const body = (request.body ?? {}) as Partial<BackupKeyDeleteRequest>
    return changed(accountId, accounts.bundle(await accounts.deleteBackupKey(accountId, body.id)))
  })

  // Guarded like a sign-in: an unknown key counts against the address.
  app.post(API.backupLogin, small, async (request, reply) =>
    guarded(
      request,
      reply,
      async (): Promise<BackupSessionResponse | null> => {
        const found = await accounts.findBackupKey(((request.body ?? {}) as Partial<BackupLoginRequest>).backupKey)
        if (!found || !found.account.vaults[found.key.vaultId]) return null
        const { account, id, key } = found
        await accounts.touchBackupKey(account.accountId, id, now())
        const issued = await tokens.issueBackup(account.accountId, sessionOf(account), key.vaultId, id)
        return { token: issued.token, expiresIn: issued.expiresIn, accountId: account.accountId, vaultId: key.vaultId, keyId: id }
      },
      'this backup key is not known here'
    )
  )

  app.get(API.backupRooms, async (request, reply): Promise<BackupRoomsResponse | undefined> => {
    const who = await reader(request, reply)
    if (!who) return undefined
    if (who.vaultId === null) return reply.code(403).send({ error: 'for backup servers' })
    return { vaultId: who.vaultId, rooms: await hub.backupRooms(who.accountId, who.vaultId) }
  })

  app.get(API.account, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const account = await accounts.get(accountId)
    if (!account) return reply.code(401).send({ error: 'sign in again' })
    return accounts.bundle(account)
  })

  app.post(API.vaults, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const body = (request.body ?? {}) as Partial<CreateVaultRequest>
    return accounts.addVault(accountId, body.vaultId, body.sealedName, body.wrappedKey)
  })

  // --- contacts ------------------------------------------------------------------

  app.post(`${API.contacts}/codes`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const body = (request.body ?? {}) as Partial<ContactCodeRequest>
    await contacts.addCode(accountId, body.codeId, body.redeemHash, body.expiresAt)
    return { ok: true }
  })

  app.get<{ Params: { codeId: string } }>(`${API.contacts}/codes/:codeId`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const owner = await contacts.codeOwner(request.params.codeId)
    const account = owner ? await accounts.get(owner) : undefined
    if (!account) return reply.code(404).send({ error: 'this code is not valid (any more)' })
    const info: ContactCodeInfo = { owner: account.accountId, publicKey: account.publicKey, signingPublicKey: account.signingPublicKey }
    return info
  })

  app.post<{ Params: { codeId: string } }>(`${API.contacts}/codes/:codeId/revoke`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await contacts.revokeCode(accountId, request.params.codeId)
    return { ok: true }
  })

  app.post(`${API.contacts}/redeem`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const body = (request.body ?? {}) as Partial<RedeemRequest>
    const owner = await contacts.redeem(accountId, body.codeId, body.redeemKey, body.sealed)
    hub.notify(owner, 'contact', { account: accountId })
    return { owner }
  })

  app.post(`${API.contacts}/reply`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const body = (request.body ?? {}) as Partial<ContactReplyRequest>
    await contacts.reply(accountId, body.to, body.codeId, body.sealed)
    hub.notify(body.to as string, 'contact', { account: accountId })
    return { ok: true }
  })

  app.get(`${API.contacts}/inbox`, async (request, reply): Promise<InboxResponse | undefined> => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return { items: await contacts.inbox(accountId) }
  })

  app.post(`${API.contacts}/inbox/done`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await contacts.done(accountId, ((request.body ?? {}) as { ids?: unknown }).ids)
    return { ok: true }
  })

  app.get(API.contacts, async (request, reply): Promise<ContactsResponse | undefined> => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return { contacts: await contacts.contactsOf(accountId) }
  })

  app.post(`${API.contacts}/remove`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const other = ((request.body ?? {}) as { account?: unknown }).account
    if (!isAccountId(other)) return reply.code(400).send({ error: 'not an account id' })
    if (await contacts.unpair(accountId, other)) hub.notify(other, 'contact-removed', { account: accountId })
    return { ok: true }
  })

  // --- sharing -------------------------------------------------------------------

  app.post(API.shares, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await hub.share(accountId, request.body as ShareRequest)
    return { ok: true }
  })

  app.get(`${API.shares}/incoming`, async (request, reply): Promise<IncomingSharesResponse | undefined> => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return { shares: await hub.incoming(accountId) }
  })

  app.get<{ Params: DocParams }>(`${API.shares}/:docId`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return hub.members(accountId, request.params.docId)
  })

  app.post(`${API.shares}/revoke`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await hub.revoke(accountId, request.body as RevokeRequest)
    return { ok: true }
  })

  app.post(`${API.shares}/rotate`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await hub.rotateNote(accountId, request.body as RotateRequest)
    return { ok: true }
  })

  app.post(`${API.shares}/leave`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await hub.leave(accountId, ((request.body ?? {}) as Partial<DocRequest>).docId)
    return { ok: true }
  })

  app.post(`${API.shares}/detach`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await hub.detachShare(accountId, ((request.body ?? {}) as Partial<DocRequest>).docId)
    return { ok: true }
  })

  // --- shared folders ----------------------------------------------------------------

  app.post(API.folders, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await hub.shareFolder(accountId, request.body as FolderShareRequest)
    return { ok: true }
  })

  app.get(`${API.folders}/incoming`, async (request, reply): Promise<IncomingFoldersResponse | undefined> => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return { folders: await hub.incomingFolders(accountId) }
  })

  app.get<{ Params: FolderParams }>(`${API.folders}/:folderId`, async (request, reply): Promise<FolderStateResponse | undefined> => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return hub.folderState(accountId, request.params.folderId)
  })

  /** One route per thing done to a folder, each taking its own request. */
  const folderAction = <T>(path: string, act: (accountId: string, folderId: string, body: T) => Promise<void>): void => {
    app.post<{ Params: FolderParams }>(`${API.folders}/:folderId/${path}`, async (request, reply) => {
      const accountId = await user(request, reply)
      if (!accountId) return undefined
      await act(accountId, request.params.folderId, (request.body ?? {}) as T)
      return { ok: true }
    })
  }
  folderAction<FolderRotation>('rotate', (account, folderId, body) => hub.rotateFolder(account, folderId, body))
  folderAction<FolderJoinRequest>('notes/join', (account, folderId, body) => hub.joinNote(account, folderId, body))
  folderAction<FolderLeaveRequest>('notes/leave', (account, folderId, body) => hub.leaveNote(account, folderId, body))
  folderAction<FolderRevokeRequest>('revoke', (account, folderId, body) => hub.revokeFolder(account, folderId, body))
  folderAction<FolderRoleRequest>('role', (account, folderId, body) => hub.setFolderRole(account, folderId, body))
  folderAction<Partial<FolderAcceptRequest>>('accept', (account, folderId, body) => hub.acceptFolder(account, folderId, body.vaultId))
  folderAction<unknown>('detach', (account, folderId) => hub.detachFolder(account, folderId))
  folderAction<unknown>('leave', (account, folderId) => hub.leaveFolder(account, folderId))
  folderAction<FolderEndRequest>('end', (account, folderId, body) => hub.endFolder(account, folderId, body))

  // --- shares that ended -----------------------------------------------------------

  app.get(API.forks, async (request, reply): Promise<ForksResponse | undefined> => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return { forks: await hub.forksOf(accountId) }
  })

  app.get<{ Params: DocParams }>(`${API.forks}/:docId`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return hub.fork(accountId, request.params.docId)
  })

  app.post<{ Params: DocParams }>(`${API.forks}/:docId/done`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const body = (request.body ?? {}) as Partial<ForkDoneRequest>
    return { forkedTo: await hub.forkDone(accountId, request.params.docId, body.forkedTo) }
  })

  app.post(`${API.shares}/role`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await hub.setRole(accountId, request.body as RoleRequest)
    return { ok: true }
  })

  app.post(`${API.shares}/accept`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const body = (request.body ?? {}) as Partial<AcceptRequest>
    await hub.accept(accountId, body.docId, body.vaultId)
    return { ok: true }
  })

  // --- keys and log --------------------------------------------------------------

  app.get<{ Params: RoomParams }>(`${API.keys}/:room`, async (request, reply) => {
    const accountId = await roomReader(request, reply, request.params.room)
    if (!accountId) return undefined
    return hub.keys(accountId, request.params.room)
  })

  app.get<{ Params: RoomParams; Querystring: { from?: string } }>(`${API.log}/:room`, async (request, reply) => {
    const accountId = await roomReader(request, reply, request.params.room)
    if (!accountId) return undefined
    const from = request.query.from === undefined ? undefined : Number(request.query.from)
    return hub.log(accountId, request.params.room, from)
  })

  app.post<{ Params: RoomParams }>(`${API.log}/:room/snapshot`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await hub.snapshot(accountId, request.params.room, request.body as SnapshotRequest)
    return { ok: true }
  })

  app.post<{ Params: RoomParams }>(`${API.log}/:room/start`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await hub.startSnapshot(accountId, request.params.room, request.body as StartSnapshotRequest)
    return { ok: true }
  })

  // The owner's, while its keys are replaced: everything the room holds, and the room written anew.
  app.get<{ Params: RoomParams }>(`${API.log}/:room/whole`, async (request, reply): Promise<WholeLogResponse | undefined> => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return hub.wholeLog(accountId, request.params.room)
  })

  app.post<{ Params: RoomParams }>(`${API.log}/:room/rewrite`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await hub.rewrite(accountId, request.params.room, request.body as RewriteRequest)
    return { ok: true }
  })

  // The owner's: which epochs each member holds a key of, and those keys sealed anew and signed (0.9.3).
  app.get<{ Params: RoomParams }>(`${API.keys}/:room/sealed`, async (request, reply): Promise<SealedEpochsResponse | undefined> => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    return hub.sealedEpochs(accountId, request.params.room)
  })

  app.post<{ Params: RoomParams }>(`${API.keys}/:room/reseal`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await hub.reseal(accountId, request.params.room, ((request.body ?? {}) as Partial<ResealRequest>).keys)
    return { ok: true }
  })

  app.post<{ Params: RoomParams }>(`${API.log}/:room/purge`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await hub.purge(accountId, request.params.room)
    return { ok: true }
  })

  app.post<{ Params: RoomParams; Querystring: { vaultId?: string } }>(
    `${API.log}/:room/import`,
    async (request, reply) => {
      const accountId = await user(request, reply)
      if (!accountId) return undefined
      const vaultId = request.query.vaultId ?? ''
      if (!isHexId(vaultId)) return reply.code(400).send({ error: 'not a vault id' })
      const body = (request.body ?? {}) as Partial<ImportRequest>
      const headSeq = await hub.importFrames(accountId, request.params.room, vaultId, body.frames ?? [])
      return { headSeq }
    }
  )

  // --- blobs -----------------------------------------------------------------------

  /** The caller, if the store named is one of their own vaults; otherwise the refusal is sent. */
  async function ownStore(request: FastifyRequest<{ Params: StoreParams }>, reply: FastifyReply): Promise<string | null> {
    const accountId = await user(request, reply)
    if (!accountId) return null
    const { account, vaultId } = request.params
    if (account !== accountId || !isHexId(vaultId) || !(await accounts.get(accountId))?.vaults[vaultId]) {
      await reply.code(403).send({ error: 'not your vault' })
      return null
    }
    return accountId
  }

  /**
   * Reading: the store's own account, or - with `?room=` - anyone who may
   * read that note, if its attachment list names this blob.
   */
  async function readableBlob(
    request: FastifyRequest<{ Params: BlobParams; Querystring: { room?: string } }>,
    reply: FastifyReply
  ): Promise<boolean> {
    const who = await reader(request, reply)
    if (!who) return false
    const { accountId } = who
    const { account, vaultId, blobId } = request.params
    const ownVault = who.vaultId === null || who.vaultId === vaultId
    if (ownVault && account === accountId && isHexId(vaultId) && (await accounts.get(accountId))?.vaults[vaultId]) return true
    const room = request.query.room
    const roomAllowed = room !== undefined && (who.vaultId === null || (await hub.inVault(accountId, who.vaultId, room)))
    if (room && roomAllowed && (await hub.canReadBlob(accountId, room, { account, vault: vaultId, blob: blobId }))) return true
    await reply.code(403).send({ error: 'not yours, and no note you can read names it' })
    return false
  }

  app.get<{ Params: BlobParams; Querystring: { room?: string } }>(
    `${API.blobs}/:account/:vaultId/:blobId`,
    async (request, reply): Promise<BlobInfo | undefined> => {
      if (!(await readableBlob(request, reply))) return undefined
      const info = await blobs.info(request.params.account, request.params.vaultId, request.params.blobId)
      if (!info) return reply.code(404).send({ error: 'no such blob' })
      return info
    }
  )

  app.get<{ Params: ChunkParams; Querystring: { room?: string } }>(`${API.blobs}/:account/:vaultId/:blobId/:chunk`, async (request, reply) => {
    if (!(await readableBlob(request, reply))) return undefined
    const { account, vaultId, blobId, chunk } = request.params
    const data = await blobs.readChunk(account, vaultId, blobId, Number(chunk))
    return reply.type('application/octet-stream').send(data)
  })

  app.post<{ Params: RoomParams }>(`${API.log}/:room/attachments`, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    await hub.attachBlobs(accountId, request.params.room, (request.body ?? {}) as AttachBlobsRequest)
    return { ok: true }
  })

  app.put<{ Params: ChunkParams; Querystring: { count?: string } }>(
    `${API.blobs}/:account/:vaultId/:blobId/:chunk`,
    async (request, reply): Promise<BlobInfo | undefined> => {
      if (!(await ownStore(request, reply))) return undefined
      if (!Buffer.isBuffer(request.body)) return reply.code(415).send({ error: 'a chunk is sent as application/octet-stream' })
      const { account, vaultId, blobId, chunk } = request.params
      return blobs.putChunk(account, vaultId, blobId, Number(chunk), Number(request.query.count), request.body)
    }
  )

  app.post<{ Params: StoreParams }>(`${API.blobs}/:account/:vaultId/have`, async (request, reply): Promise<BlobHaveResponse | undefined> => {
    if (!(await ownStore(request, reply))) return undefined
    const body = (request.body ?? {}) as Partial<BlobIdsRequest>
    return { have: await blobs.have(request.params.account, request.params.vaultId, body.ids) }
  })

  app.post<{ Params: StoreParams }>(`${API.blobs}/:account/:vaultId/purge`, async (request, reply): Promise<BlobPurgeResponse | undefined> => {
    if (!(await ownStore(request, reply))) return undefined
    const body = (request.body ?? {}) as Partial<BlobIdsRequest> & { replacing?: unknown }
    // Only the replacement under way may skip the grace a blob just uploaded has.
    const replacing = body.replacing !== undefined && (await accounts.get(request.params.account))?.replacing?.id === body.replacing
    return blobs.purge(request.params.account, request.params.vaultId, body.ids, Date.now(), replacing)
  })

  app.post<{ Params: StoreParams }>(`${API.blobs}/:account/:vaultId/touch`, async (request, reply): Promise<BlobTouchResponse | undefined> => {
    if (!(await ownStore(request, reply))) return undefined
    const body = (request.body ?? {}) as Partial<BlobIdsRequest>
    return { touched: await blobs.touch(request.params.account, request.params.vaultId, body.ids) }
  })

  // The store's owner only: which content it holds is its own business.
  app.get<{ Params: StoreParams }>(`${API.blobs}/:account/:vaultId/list`, async (request, reply): Promise<BlobListResponse | undefined> => {
    if (!(await ownStore(request, reply))) return undefined
    return blobs.list(request.params.account, request.params.vaultId)
  })

  app.get<{ Params: { account: string } }>(`${API.blobs}/:account/usage`, async (request, reply): Promise<BlobUsageResponse | undefined> => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    if (request.params.account !== accountId) return reply.code(403).send({ error: 'not your account' })
    return { bytes: await blobs.usageOf(accountId), quotaBytes: blobs.limits.quotaBytes }
  })

  app.get<{ Querystring: { vaultId?: string; before?: string } }>(API.compactable, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const before = Number(request.query.before)
    if (!Number.isFinite(before)) return reply.code(400).send({ error: 'before is required' })
    const response: CompactableResponse = {
      rooms: await hub.compactable(accountId, request.query.vaultId ?? '', before)
    }
    return response
  })

  app.get<{ Querystring: { vaultId?: string; since?: string } }>(API.changed, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const since = Number(request.query.since)
    if (!Number.isFinite(since)) return reply.code(400).send({ error: 'since is required' })
    const response: ChangedResponse = { rooms: await hub.changedSince(accountId, request.query.vaultId ?? '', since) }
    return response
  })

  app.get<{ Querystring: { vaultId?: string; since?: string } }>(API.times, async (request, reply) => {
    const accountId = await user(request, reply)
    if (!accountId) return undefined
    const since = Number(request.query.since ?? 0)
    if (!Number.isFinite(since)) return reply.code(400).send({ error: 'since must be a number' })
    const response: TimesResponse = { rooms: await hub.frameTimes(accountId, request.query.vaultId ?? '', since) }
    return response
  })

  // --- the vault lock (docs/TIMEMACHINE.md) -------------------------------------------

  /** The account behind the token, if the vault named is one of its own. */
  async function vaultOwner(request: FastifyRequest<{ Params: { vaultId: string } }>, reply: FastifyReply): Promise<string | null> {
    const accountId = await user(request, reply)
    if (!accountId) return null
    const { vaultId } = request.params
    if (!isHexId(vaultId) || !(await accounts.get(accountId))?.vaults[vaultId]) {
      await reply.code(404).send({ error: 'no such vault' })
      return null
    }
    return accountId
  }

  app.get<{ Params: { vaultId: string } }>(`${API.vaults}/:vaultId/lock`, async (request, reply) => {
    const accountId = await vaultOwner(request, reply)
    if (!accountId) return undefined
    const response: VaultLockResponse = { lock: hub.currentLock(accountId, request.params.vaultId) }
    return response
  })

  // The rooms the account owns in the vault, for writing them anew under replaced keys.
  app.get<{ Params: { vaultId: string } }>(`${API.vaults}/:vaultId/rooms`, async (request, reply) => {
    const accountId = await vaultOwner(request, reply)
    if (!accountId) return undefined
    const response: OwnedRoomsResponse = { rooms: await hub.ownedRooms(accountId, request.params.vaultId) }
    return response
  })

  app.post<{ Params: { vaultId: string } }>(`${API.vaults}/:vaultId/lock`, async (request, reply) => {
    const accountId = await vaultOwner(request, reply)
    if (!accountId) return undefined
    const taken: VaultLockTaken = hub.takeLock(accountId, request.params.vaultId, (request.body ?? {}) as Partial<VaultLockRequest>)
    return taken
  })

  app.post<{ Params: { vaultId: string } }>(`${API.vaults}/:vaultId/lock/renew`, async (request, reply) => {
    const accountId = await vaultOwner(request, reply)
    if (!accountId) return undefined
    const body = (request.body ?? {}) as Partial<VaultLockIdRequest>
    const response: VaultLockResponse = { lock: hub.renewLock(accountId, request.params.vaultId, body.id) }
    return response
  })

  app.post<{ Params: { vaultId: string } }>(`${API.vaults}/:vaultId/lock/release`, async (request, reply) => {
    const accountId = await vaultOwner(request, reply)
    if (!accountId) return undefined
    hub.releaseLock(accountId, request.params.vaultId, ((request.body ?? {}) as Partial<VaultLockIdRequest>).id)
    return { ok: true }
  })

  app.post<{ Params: { vaultId: string } }>(`${API.vaults}/:vaultId/lock/break`, async (request, reply) => {
    const accountId = await vaultOwner(request, reply)
    if (!accountId) return undefined
    return { ended: hub.breakLock(accountId, request.params.vaultId) }
  })

  return app
}
