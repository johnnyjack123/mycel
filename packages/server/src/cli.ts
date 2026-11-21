// Account administration, meant for `docker exec <container> mycel …`.
// Works on the data directory directly; the running server notices the change.
//
// The server knows no names, so neither does this: an invite code names
// nobody, and accounts and vaults are listed by id. Everyone sees their own
// account id and their vault's id in the plugin's settings.
//
//   mycel invite                    a code for one new account
//   mycel user list
//   mycel user remove <accountId>
//   mycel user 2fa-off <accountId>
//   mycel vault remove <accountId> <vaultId>
//   mycel vault restore <accountId> <vaultId>
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { VAULT_DELETE_GRACE_MS, isHexId } from '@mycel/shared'
import { AccountError, AccountStore, isAccountId } from './accounts.js'
import { loadConfig, loadEnvFile } from './config.js'

const USAGE = `usage:
  mycel invite                               print a code that lets one person create an account
  mycel user list                            every account: id, created, recovery code, 2fa, backup keys, and its vaults
  mycel user remove <accountId>              delete an account (its id is shown in the plugin's settings)
  mycel user 2fa-off <accountId>             turn off two-factor sign-in, for a lost phone without a recovery code
  mycel vault remove <accountId> <vaultId>   delete one vault: locked at once, restorable for 7 days, then cleared
  mycel vault restore <accountId> <vaultId>  take a deleted vault back within those 7 days`

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** What a vault's folder holds: its size, and when anything in it last changed. */
async function folderStats(dir: string): Promise<{ bytes: number; changed: number } | null> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  let bytes = 0
  let changed = 0
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      const inner = await folderStats(path)
      if (inner) {
        bytes += inner.bytes
        changed = Math.max(changed, inner.changed)
      }
    } else if (entry.isFile()) {
      const info = await stat(path)
      bytes += info.size
      changed = Math.max(changed, info.mtimeMs)
    }
  }
  return { bytes, changed }
}

async function main(argv: string[]): Promise<number> {
  const [scope, command, id, second] = argv
  // As the server writes accounts.json: its user's alone.
  process.umask(0o077)
  // The same settings as the server, or it would write to another data directory.
  loadEnvFile()
  const config = loadConfig()
  const accounts = new AccountStore(config.dataDir)

  if (scope === 'invite') {
    const code = await accounts.invite()
    console.log(`Invite code: ${code}`)
    console.log('In Obsidian: Settings -> Mycel -> Create a new account, with this code.')
    return 0
  }
  if (scope === 'vault') return vault(accounts, command, id, second)
  if (scope !== 'user' || !command) {
    console.log(USAGE)
    return scope === undefined || scope === 'help' || scope === '--help' ? 0 : 1
  }

  switch (command) {
    case 'list': {
      const all = await accounts.list()
      if (all.length === 0) console.log('no accounts')
      for (const account of all) {
        const recovery = account.recovery ? '  recovery code' : ''
        const totp = account.totp ? '  2fa' : ''
        const backupKeys = Object.keys(account.backupKeys ?? {}).length
        const backups = backupKeys > 0 ? `  backup keys ${backupKeys}` : ''
        console.log(`${account.accountId}  created ${day(account.createdAt)}  vaults ${Object.keys(account.vaults).length}${recovery}${totp}${backups}`)
        for (const vaultId of Object.keys(account.vaults).sort()) {
          const stats = await folderStats(join(config.dataDir, 'users', account.accountId, vaultId))
          console.log(`  vault ${vaultId}  ${stats ? `${size(stats.bytes)}  last change ${stats.changed > 0 ? day(stats.changed) : '-'}` : 'nothing stored yet'}`)
        }
        for (const [vaultId, deleted] of Object.entries(account.deletedVaults ?? {}).sort(([, a], [, b]) => a.deletedAt - b.deletedAt)) {
          const state = deleted.purgedAt !== undefined ? `cleared ${day(deleted.purgedAt)}` : `cleared after ${day(deleted.purgeAt)}, restorable until then`
          console.log(`  vault ${vaultId}  deleted ${day(deleted.deletedAt)} by the ${deleted.by === 'admin' ? 'admin' : 'owner'}, ${state}`)
        }
      }
      const open = await accounts.invites()
      if (open > 0) console.log(`${open} invite code(s) not used yet`)
      return 0
    }
    case 'remove': {
      if (!isAccountId(id)) {
        console.error('usage: mycel user remove <accountId>')
        return 1
      }
      const removed = await accounts.remove(id)
      console.log(
        removed
          ? `${id} can no longer sign in. Within a few minutes the running server ends its shares - everyone keeps a copy of what was shared with them - and deletes its data.`
          : `no account ${id}`
      )
      return removed ? 0 : 1
    }
    case '2fa-off': {
      if (!isAccountId(id)) {
        console.error('usage: mycel user 2fa-off <accountId>')
        return 1
      }
      const turnedOff = await accounts.turnOffTotp(id)
      console.log(
        turnedOff
          ? `${id} signs in without a code again. Its password is still needed - to sign in, and to decrypt anything.`
          : `${id} has no two-factor sign-in (or no such account)`
      )
      return turnedOff ? 0 : 1
    }
    default:
      console.log(USAGE)
      return 1
  }
}

/** One vault of an account, by its id: deleted on the server, or taken back (0.9.24). */
async function vault(accounts: AccountStore, command: string | undefined, accountId: string | undefined, id: string | undefined): Promise<number> {
  if ((command !== 'remove' && command !== 'restore') || !isAccountId(accountId) || id === undefined || !isHexId(id)) {
    console.error(`usage: mycel vault ${command === 'restore' ? 'restore' : 'remove'} <accountId> <vaultId>   (both from "mycel user list")`)
    return 1
  }
  const vaultId: string = id
  try {
    if (command === 'remove') {
      const deleted = await accounts.deleteVault(accountId, vaultId, 'admin', undefined, VAULT_DELETE_GRACE_MS)
      console.log(
        `The vault ${vaultId} is deleted: within five minutes the running server closes its connections, and no device of the account syncs it any more - their files stay with them. Its data stays until ${day(deleted.purgeAt)}; "mycel vault restore ${accountId} ${vaultId}" takes it back until then. After that the server ends its shares - everyone keeps a copy of what was shared with them - and deletes it.`
      )
    } else {
      await accounts.restoreVault(accountId, vaultId, 'admin')
      console.log(`The vault ${vaultId} is back. Its devices offer to connect again; the backup keys it had work again.`)
    }
    return 0
  } catch (error) {
    if (!(error instanceof AccountError)) throw error
    console.error(error.message)
    return 1
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof AccountError ? error.message : error)
    process.exit(1)
  }
)
