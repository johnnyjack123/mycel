import { PROTOCOL_VERSION, type RegistrationMode } from '@mycel/shared'
import { ApiError, type ConnectApi } from './api.js'

// Asked before anyone signs in, so the settings can say why signing in cannot
// work instead of failing on the first click with whatever the request threw.

export type ServerProbe =
  /** `changed`: the server at this address has another id than the one this device pinned - set up anew, or another one. */
  | { state: 'ok'; registration: RegistrationMode; changed: boolean }
  | { state: 'unreachable'; reason: string }
  | { state: 'incompatible'; reason: string }

const SERVICE = 'mycel-server'

/** `pinned`: the server id this device knows for the address; null for none. */
export async function probeServer(api: ConnectApi, pinned: string | null = null): Promise<ServerProbe> {
  let health: unknown
  try {
    health = await api.health()
  } catch (error) {
    if (error instanceof ApiError && error.status !== 0) {
      return { state: 'incompatible', reason: `Something answers there, but not an Mycel server (HTTP ${error.status}).` }
    }
    return { state: 'unreachable', reason: error instanceof Error ? error.message : String(error) }
  }
  const { service, protocol } = (health ?? {}) as { service?: unknown; protocol?: unknown }
  if (service !== SERVICE) {
    return { state: 'incompatible', reason: 'Something answers there, but not an Mycel server.' }
  }
  if (protocol !== PROTOCOL_VERSION) {
    const older = typeof protocol === 'number' && protocol < PROTOCOL_VERSION
    return {
      state: 'incompatible',
      reason: `The server speaks protocol ${String(protocol)}, this plugin ${PROTOCOL_VERSION}. Update the ${older ? 'server' : 'plugin'}.`
    }
  }
  try {
    const config = await api.config()
    return { state: 'ok', registration: config.registration === 'open' ? 'open' : 'invite', changed: pinned !== null && pinned !== config.serverId }
  } catch (error) {
    if (error instanceof ApiError && error.status !== 0) {
      return { state: 'incompatible', reason: `The server answers, but not as expected (HTTP ${error.status}).` }
    }
    return { state: 'unreachable', reason: error instanceof Error ? error.message : String(error) }
  }
}
