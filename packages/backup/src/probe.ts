// A WebSocket that fails says little - often only "closed (1006)". Asking the
// sync server's /health over plain HTTP and over TLS says more: an address
// with wss:// on a port that has no TLS (the sync server itself speaks plain
// ws:// on its port; wss:// is for a proxy with TLS in front of it), the
// other way round, or a server that answers but whose proxy does not pass
// the WebSocket on /relay.

const PROBE_MS = 5_000

type Outcome = { ok: true; status: number } | { ok: false; reason: string }

/** What a failed request means, for someone setting up a container - not only what Node calls it. */
function plainly(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause
  const code = typeof cause?.code === 'string' ? cause.code : ''
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return `no answer within ${PROBE_MS / 1000} s - a firewall between this container and that host drops it (on the same host as the sync server: often the case for its LAN address)`
  }
  if (code === 'ECONNREFUSED') return 'refused (ECONNREFUSED) - nothing listens at that address and port, seen from this container'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `that host cannot be reached from this container (${code})`
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `the name does not resolve in this container (${code})`
  const text = [code, typeof cause?.message === 'string' ? cause.message : ''].filter((part) => part !== '').join(': ')
  return text || (error instanceof Error ? error.message : String(error))
}

async function ask(url: string): Promise<Outcome> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_MS) })
    return { ok: true, status: response.status }
  } catch (error) {
    return { ok: false, reason: plainly(error) }
  }
}

/** Why the relay at `server` could not be reached, as far as asking it over HTTP tells; null when it tells nothing. */
export async function explainUnreachable(server: string): Promise<string | null> {
  const base = server.trim().replace(/\/+$/, '')
  const secure = /^(wss|https):/i.test(base)
  const host = base.replace(/^[a-z]+:\/\//i, '')
  const asGiven = await ask(`${secure ? 'https' : 'http'}://${host}/health`)
  if (asGiven.ok && asGiven.status === 200) {
    return 'the sync server answers there, but the WebSocket on /relay was refused - a reverse proxy in front of it must pass /relay on as a WebSocket, like /vault/'
  }
  const other = await ask(`${secure ? 'http' : 'https'}://${host}/health`)
  if (other.ok && other.status === 200) {
    return secure
      ? `no TLS on this port - the sync server answers plain http there: use ws://${host} instead of wss://`
      : `this address speaks TLS: use wss://${host} instead of ws://`
  }
  if (asGiven.ok) return `the address answers HTTP ${asGiven.status} on /health - is it the sync server?`
  return asGiven.reason || null
}

/**
 * The whole way to the relay, step by step, for `check`: the sync server's
 * /health, then a WebSocket to /relay as a backup server opens it. Every line
 * says what happened.
 */
export async function checkRelay(server: string): Promise<{ ok: boolean; lines: string[] }> {
  const base = server.trim().replace(/\/+$/, '')
  const host = base.replace(/^[a-z]+:\/\//i, '')
  const secure = /^(wss|https):/i.test(base)
  const lines: string[] = []
  const health = await ask(`${secure ? 'https' : 'http'}://${host}/health`)
  lines.push(health.ok ? `HTTP ${secure ? 'https' : 'http'}://${host}/health: ${health.status}` : `HTTP ${secure ? 'https' : 'http'}://${host}/health: ${health.reason}`)
  const relay = `${secure ? 'wss' : 'ws'}://${host}/relay?role=backup`
  const opened = await new Promise<string | null>((resolve) => {
    let socket: WebSocket
    try {
      socket = new WebSocket(relay)
    } catch (error) {
      resolve(error instanceof Error ? error.message : String(error))
      return
    }
    const timer = setTimeout(() => {
      socket.close()
      resolve(`no answer within ${PROBE_MS / 1000} s`)
    }, PROBE_MS)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      socket.close()
      resolve(null)
    })
    socket.addEventListener('close', (event) => {
      clearTimeout(timer)
      resolve(event.reason ? `${event.reason} (${event.code})` : `closed (${event.code})`)
    })
    socket.addEventListener('error', () => undefined)
  })
  lines.push(opened === null ? `WebSocket ${relay}: opened - the relay takes this backup server` : `WebSocket ${relay}: ${opened}`)
  if (opened !== null) {
    const why = await explainUnreachable(server)
    if (why) lines.push(`why: ${why}`)
  }
  return { ok: opened === null, lines }
}
