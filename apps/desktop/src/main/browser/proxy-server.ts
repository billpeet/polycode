import * as http from 'http'
import * as net from 'net'
import { isLoopbackHost } from '../../shared/browser'
import type { ForwardHandle } from './port-forward'

/**
 * The proxy needs one thing from its transport: a local endpoint that reaches
 * `host:port` on the far side. Production wires an SshTunnelPool; tests wire a
 * plain local server, which is how the relay logic is exercised without SSH.
 */
export interface RelayForwarder {
  acquire(host: string, port: number): Promise<ForwardHandle>
}

export interface BrowserProxy {
  port: number
  close(): Promise<void>
}

/** Headers meaningful to the proxy hop only; the origin server must not see them. */
const HOP_HEADERS = new Set(['proxy-authorization', 'proxy-connection', 'proxy-authenticate'])

function relayHeaders(req: http.IncomingMessage): [string, string][] {
  const out: [string, string][] = []
  const raw = req.rawHeaders
  for (let i = 0; i < raw.length; i += 2) {
    if (HOP_HEADERS.has(raw[i].toLowerCase())) continue
    out.push([raw[i], raw[i + 1]])
  }
  return out
}

/** Parse a CONNECT authority ("host:port") or an absolute http(s) URL. */
export function parseProxyTarget(raw: string): { host: string; port: number } | null {
  if (raw.startsWith('/') || /\s/.test(raw)) return null
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
    const url = new URL(withScheme)
    if (url.protocol !== 'http:') return null
    const port = url.port === '' ? 80 : Number(url.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
    return { host: url.hostname, port }
  } catch {
    return null
  }
}

/**
 * An HTTP proxy that relays loopback traffic through a forwarder (in practice
 * an SSH tunnel pool) and everything else straight out to the internet.
 *
 * Chromium drives it through a per-location PAC script, so only loopback
 * requests ever arrive in production — the direct path exists as a fallback
 * and for tests. The page's URL, Host header and origin are untouched: a dev
 * server behind the tunnel is indistinguishable from one running locally,
 * which is the whole point — Vite host checks, cookies, redirects and HMR
 * WebSockets all behave as if the browser were on the session host.
 */
export function startBrowserProxy(forwarder: RelayForwarder): Promise<BrowserProxy> {
  const server = http.createServer((req, res) => {
    void handlePlainRequest(req, res, forwarder)
  })

  // ws:// over a proxy arrives as CONNECT in modern Chromium, but a plain
  // HTTP/1.1 Upgrade request must not fall into the default handler — Node
  // destroys the socket when no upgrade listener exists.
  server.on('upgrade', (req, socket, head) => {
    void handleUpgrade(req, socket as net.Socket, head, forwarder)
  })

  server.on('connect', (req, socket, head) => {
    void handleConnect(req, socket as net.Socket, head, forwarder)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // Loopback only: the proxy grants loopback reachability through the
    // session's SSH connection and must never listen on a LAN interface.
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Browser proxy failed to bind'))
        return
      }
      server.on('error', () => { /* late errors surface as failed requests */ })
      resolve({
        port: address.port,
        close: () => new Promise((done) => {
          server.closeIdleConnections()
          server.closeAllConnections()
          server.close(() => done())
        }),
      })
    })
  })
}

/** Decide where a target goes and return the relay endpoint. */
async function resolveEndpoint(
  target: { host: string; port: number },
  forwarder: RelayForwarder,
): Promise<{ host: string; port: number; handle: ForwardHandle | null }> {
  if (!isLoopbackHost(target.host)) {
    return { host: target.host, port: target.port, handle: null }
  }
  const handle = await forwarder.acquire(target.host, target.port)
  return { host: '127.0.0.1', port: handle.localPort, handle }
}

async function handlePlainRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  forwarder: RelayForwarder,
): Promise<void> {
  // Proxy-form request: absolute URL in the request line. Anything else is a
  // misdirected origin-form request, which this server never serves.
  if (!req.url || !/^[a-z][a-z0-9+.-]*:\/\//i.test(req.url)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    res.end('PolyCode browser proxy expects proxy-form requests')
    return
  }

  let target: { host: string; port: number }
  let path: string
  try {
    const url = new URL(req.url)
    target = { host: url.hostname, port: url.port === '' ? 80 : Number(url.port) }
    path = `${url.pathname}${url.search}`
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    res.end('Unparseable request URL')
    return
  }

  let endpoint: Awaited<ReturnType<typeof resolveEndpoint>>
  try {
    endpoint = await resolveEndpoint(target, forwarder)
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end(`PolyCode could not reach ${target.host}:${target.port} on the session host: ${
      err instanceof Error ? err.message : String(err)
    }`)
    return
  }

  // Hold the tunnel for the whole exchange; `release` below (once-only) is
  // what the refcounting pool watches to decide when a tunnel is idle.
  endpoint.handle?.retain()

  // Rebuild the request as origin-form against the relay endpoint. The Host
  // header passes through untouched — the origin sees exactly the host the
  // browser asked for (localhost:5173), not the relay's 127.0.0.1:forwarded.
  // `agent: false` gives every proxied request its own upstream connection
  // that dies with it, which keeps the forward-handle refcount exact.
  const upstreamReq = http.request({
    host: endpoint.host,
    port: endpoint.port,
    method: req.method,
    path,
    headers: headersObject(relayHeaders(req)),
    agent: false,
  })

  const releasedRef = { released: false }
  const release = (): void => {
    // The error path and res 'close' can both fire; the handle must be
    // released exactly once or the tunnel refcount drifts.
    if (releasedRef.released) return
    releasedRef.released = true
    endpoint.handle?.release()
    upstreamReq.destroy()
  }

  req.once('error', release)
  res.once('close', release)

  upstreamReq.once('response', (upstreamRes) => {
    if (!upstreamRes.statusCode) {
      release()
      return
    }
    res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, upstreamRes.headers)
    // Pass the body through untouched; SSE and chunked streaming must not be
    // re-buffered by a second HTTP stack.
    upstreamRes.pipe(res)
    upstreamRes.once('error', release)
  })

  upstreamReq.once('error', (err) => {
    if (res.headersSent) {
      release()
      res.destroy()
      return
    }
    release()
    res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end(`PolyCode could not reach ${target.host}:${target.port}: ${
      err instanceof Error ? err.message : String(err)
    }`)
  })

  req.pipe(upstreamReq)
}

/** Multi-value safe header object for http.request (Set-Cookie etc. survive). */
function headersObject(pairs: [string, string][]): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [name, value] of pairs) {
    const key = name.toLowerCase()
    const existing = out[key]
    if (existing === undefined) {
      out[key] = value
    } else if (Array.isArray(existing)) {
      existing.push(value)
    } else {
      out[key] = [existing as string, value]
    }
  }
  return out
}

async function handleUpgrade(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
  forwarder: RelayForwarder,
): Promise<void> {
  const target = parseProxyTarget(req.url ?? '')
  if (!target) {
    socket.destroy()
    return
  }
  await relayRaw(target, forwarder, socket, head, rewriteRequestLine(req))
}

async function handleConnect(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
  forwarder: RelayForwarder,
): Promise<void> {
  const target = parseProxyTarget(req.url ?? '')
  if (!target) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }
  await relayRaw(target, forwarder, socket, head, null)
}

/** Tunnel a raw connection (CONNECT payload or an Upgrade hop) to the target. */
async function relayRaw(
  target: { host: string; port: number },
  forwarder: RelayForwarder,
  client: net.Socket,
  head: Buffer,
  /** Rewritten first request line for Upgrade hops; null answers 200 first. */
  upgradeRequestHead: string | null,
): Promise<void> {
  let endpoint: Awaited<ReturnType<typeof resolveEndpoint>>
  try {
    endpoint = await resolveEndpoint(target, forwarder)
  } catch {
    // end() rather than destroy(): the client must be able to read the status
    // line before the socket goes away.
    client.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    client.end()
    return
  }

  const upstream = net.connect({ host: endpoint.host, port: endpoint.port })
  endpoint.handle?.retain()

  const release = (): void => {
    endpoint.handle?.release()
    upstream.destroy()
    client.destroy()
  }

  upstream.once('error', release)
  client.once('error', release)
  upstream.once('close', release)
  client.once('close', release)

  upstream.once('connect', () => {
    if (upgradeRequestHead !== null) {
      // Upgrade: the client's request line is rewritten to origin-form and
      // relayed verbatim; the 101 comes back from the origin through the pipe.
      upstream.write(upgradeRequestHead)
      if (head.length > 0) upstream.write(head)
      client.pipe(upstream)
      upstream.pipe(client)
      return
    }
    // CONNECT: tell the client the tunnel is up, then go transparent. TLS,
    // WebSockets and everything else after this point is end-to-end bytes.
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) upstream.write(head)
    client.pipe(upstream)
    upstream.pipe(client)
  })
}

function rewriteRequestLine(req: http.IncomingMessage): string | null {
  try {
    const url = new URL(req.url ?? '')
    const path = `${url.pathname}${url.search}`
    const head = [
      `${req.method} ${path} HTTP/${req.httpVersion}`,
      ...relayHeaders(req).map(([name, value]) => `${name}: ${value}`),
      '',
      '',
    ]
    return head.join('\r\n')
  } catch {
    return null
  }
}
