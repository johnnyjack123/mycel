// A WebSocket that fails says little - often only "closed (1006)". Asking the
// sync server's /health over plain HTTP and over TLS says more: an address
// with wss:// on a port that has no TLS (the sync server itself speaks plain
// ws:// on its port; wss:// is for a proxy with TLS in front of it), the
// other way round, or a server that answers but whose proxy does not pass
// the WebSocket on /relay.

const PROBE_MS = 5_000

type Outcome = { ok: true; status: number } | { ok: false; reason: string }

async function ask(url: string): Promise<Outcome> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_MS) })
    return { ok: true, status: response.status }
  } catch (error) {
    const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause
    const text = [cause?.code, cause?.message].filter((part) => typeof part === 'string' && part !== '').join(': ')
    return { ok: false, reason: text || (error instanceof Error ? error.message : String(error)) }
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
