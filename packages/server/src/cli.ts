// Account administration, meant for `docker exec <container> obsidian-connect …`.
// Works on the data directory directly; the running server notices the change.
//
//   obsidian-connect user add <name>      creates an account and prints its invite code
//   obsidian-connect user invite <name>   a new code for an account not yet claimed
//   obsidian-connect user list
//   obsidian-connect user remove <name>
import { AccountError, AccountStore } from './accounts.js'
import { loadConfig, loadEnvFile } from './config.js'

const USAGE = `usage:
  obsidian-connect user add <name>      create an account; prints the invite code
  obsidian-connect user invite <name>   new invite code for an account not yet claimed
  obsidian-connect user list            every account and whether it was claimed
  obsidian-connect user remove <name>   delete an account`

async function main(argv: string[]): Promise<number> {
  const [scope, command, name] = argv
  if (scope !== 'user' || !command) {
    console.log(USAGE)
    return scope === undefined || scope === 'help' || scope === '--help' ? 0 : 1
  }
  // The same settings as the server, or it would write to another data directory.
  loadEnvFile()
  const config = loadConfig()
  const accounts = new AccountStore(config.dataDir, config.jwtSecret)

  switch (command) {
    case 'add':
    case 'invite': {
      if (!name) {
        console.error(`usage: obsidian-connect user ${command} <name>`)
        return 1
      }
      const existing = await accounts.get(name.toLowerCase())
      if (command === 'add' && existing) {
        console.error(`${existing.username} already exists${existing.status === 'pending' ? '; use "user invite" for a new code' : ''}`)
        return 1
      }
      if (command === 'invite' && !existing) {
        console.error(`${name} does not exist; use "user add"`)
        return 1
      }
      const code = await accounts.invite(name)
      console.log(`Invite code for ${name.toLowerCase()}: ${code}`)
      console.log('In Obsidian: Settings -> Obsidian Connect -> Create account, with this name and code.')
      return 0
    }
    case 'list': {
      const all = await accounts.list()
      if (all.length === 0) console.log('no accounts')
      for (const account of all) {
        const vaults = Object.values(account.vaults).map((vault) => vault.name)
        console.log(
          `${account.username.padEnd(24)} ${account.status === 'active' ? 'active ' : 'invited'}  ${vaults.length > 0 ? vaults.join(', ') : '-'}`
        )
      }
      return 0
    }
    case 'remove': {
      if (!name) {
        console.error('usage: obsidian-connect user remove <name>')
        return 1
      }
      const removed = await accounts.remove(name)
      console.log(removed ? `${name.toLowerCase()} removed. Their notes stay on the server, encrypted and unreadable.` : `no account ${name}`)
      return removed ? 0 : 1
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
