// Account administration, meant for `docker exec <container> obsidian-connect …`.
// Works on the data directory directly; the running server notices the change.
//
// The server knows no names, so neither does this: an invite code names
// nobody, and accounts are listed by id. Everyone sees their own account id
// in the plugin's settings.
//
//   obsidian-connect invite                    a code for one new account
//   obsidian-connect user list
//   obsidian-connect user remove <accountId>
//   obsidian-connect user 2fa-off <accountId>
import { AccountError, AccountStore, isAccountId } from './accounts.js'
import { loadConfig, loadEnvFile } from './config.js'

const USAGE = `usage:
  obsidian-connect invite                    print a code that lets one person create an account
  obsidian-connect user list                 every account: id, created, number of vaults, recovery code, 2fa, backup keys
  obsidian-connect user remove <accountId>   delete an account (its id is shown in the plugin's settings)
  obsidian-connect user 2fa-off <accountId>  turn off two-factor sign-in, for a lost phone without a recovery code`

async function main(argv: string[]): Promise<number> {
  const [scope, command, id] = argv
  // The same settings as the server, or it would write to another data directory.
  loadEnvFile()
  const config = loadConfig()
  const accounts = new AccountStore(config.dataDir)

  if (scope === 'invite') {
    const code = await accounts.invite()
    console.log(`Invite code: ${code}`)
    console.log('In Obsidian: Settings -> Obsidian Connect -> Create a new account, with this code.')
    return 0
  }
  if (scope !== 'user' || !command) {
    console.log(USAGE)
    return scope === undefined || scope === 'help' || scope === '--help' ? 0 : 1
  }

  switch (command) {
    case 'list': {
      const all = await accounts.list()
      if (all.length === 0) console.log('no accounts')
      for (const account of all) {
        const created = new Date(account.createdAt).toISOString().slice(0, 10)
        const recovery = account.recovery ? '  recovery code' : ''
        const totp = account.totp ? '  2fa' : ''
        const backupKeys = Object.keys(account.backupKeys ?? {}).length
        const backups = backupKeys > 0 ? `  backup keys ${backupKeys}` : ''
        console.log(`${account.accountId}  created ${created}  vaults ${Object.keys(account.vaults).length}${recovery}${totp}${backups}`)
      }
      const open = await accounts.invites()
      if (open > 0) console.log(`${open} invite code(s) not used yet`)
      return 0
    }
    case 'remove': {
      if (!isAccountId(id)) {
        console.error('usage: obsidian-connect user remove <accountId>')
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
        console.error('usage: obsidian-connect user 2fa-off <accountId>')
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

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof AccountError ? error.message : error)
    process.exit(1)
  }
)
