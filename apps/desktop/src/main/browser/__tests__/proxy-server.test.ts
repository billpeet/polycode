import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as http from 'http'
import * as net from 'net'
import { startBrowserProxy, parseProxyTarget, type RelayForwarder } from '../proxy-server'
import type { ForwardHandle } from '../../port-forward'

// ── Test doubles ──────────────────────────────────────────────────────────────

/**
 * Stands in for the SSH tunnel pool: "tunneling" to localhost:N just connects
 * to a local server pretending to be the remote dev server.
 */
function fakeForwarder(): RelayForwarder & {
  calls: Array<{ host: string; port: number }>
  route: (host: string, port: number) => number | null
} {
  const calls: Array<{ host: string; port: number }> = []
  const handles = new Map<string, ForwardHandle>()
  const api = {
    calls,
    route: (host: string, port: number): number | null =>
      (host === 'localhost' || host === '127.0.0.1') && port === 5173 ? remoteDevServerPort : null,
    async acquire(host: string, port: number) {
      calls.push({ host, port })
      const key = `${host}:${port}`
      const existing = handles.get(key)
      if (existing) return existing
      const localPort = api.route(host, port)
      if (localPort === null) throw new Error(`no route for ${key}`)
      const handle: ForwardHandle = {
        localPort,
        retain: () => {},
        release: () => {},
      }
      handles.set(key, handle)
      return handle
    },
  }
  return api
}

function requestViaProxy(
  proxyPort: number,
  targetUrl: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${proxyPort}`,
      {
        // Proxy-form: absolute URL in the request line, like Chromium sends.
        path: targetUrl,
        headers: { ...headers },
      },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk.toString() })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      },
    )
    req.once('error', reject)
    req.end()
  })
}

function connectViaProxy(proxyPort: number, authority: string): Promise<{
  status: number
  socket: net.Socket
  echoed: string
}> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: authority })
    // Node only emits 'connect' for 2xx answers; a proxy rejection (502)
    // arrives as a plain 'response' instead.
    const onFail = (res: http.IncomingMessage): void => {
      res.resume()
      resolve({ status: res.statusCode ?? 0, socket: req.socket, echoed: '' })
    }
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        resolve({ status: res.statusCode, socket, echoed: '' })
        return
      }
      socket.write('ping\n')
      socket.once('data', (chunk: Buffer) => {
        resolve({ status: res.statusCode ?? 0, socket, echoed: chunk.toString() })
        socket.destroy()
      })
    })
    req.once('response', onFail)
    req.once('error', reject)
    req.end()
  })
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const servers: Array<http.Server | net.Server> = []

function listenHttp(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port)
    })
  })
}

function listenRaw(onConnection: (socket: net.Socket) => void): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer(onConnection)
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port)
    })
  })
}

beforeAll(async () => {
  // The "remote" dev server: reports what it saw so assertions can check the
  // Host header survived the proxy hop and the request line lost its
  // absolute-form prefix.
  remoteDevServerPort = await listenHttp((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Dev-Server': 'yes' })
      res.end(JSON.stringify({ seenUrl: req.url, seenHost: req.headers.host, body }))
    })
  })
})

let remoteDevServerPort = 0
let proxyPort = 0
let proxyClose: (() => Promise<void>) | null = null
let forwarder: ReturnType<typeof fakeForwarder>

afterAll(async () => {
  await proxyClose?.()
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

beforeAll(async () => {
  forwarder = fakeForwarder()
  const proxy = await startBrowserProxy(forwarder)
  proxyPort = proxy.port
  proxyClose = proxy.close
})

// ── parseProxyTarget ──────────────────────────────────────────────────────

describe('parseProxyTarget', () => {
  it('parses CONNECT authorities', () => {
    expect(parseProxyTarget('localhost:5173')).toEqual({ host: 'localhost', port: 5173 })
  })

  it('parses absolute URLs', () => {
    expect(parseProxyTarget('http://localhost:5173/a?b')).toEqual({ host: 'localhost', port: 5173 })
  })

  it('defaults the port to 80', () => {
    expect(parseProxyTarget('example.com')).toEqual({ host: 'example.com', port: 80 })
  })

  it('rejects origin-form paths, spaces and non-http schemes', () => {
    expect(parseProxyTarget('/local/path')).toBeNull()
    expect(parseProxyTarget('localhost:5173 extra')).toBeNull()
    expect(parseProxyTarget('https://example.com')).toBeNull()
    expect(parseProxyTarget('localhost:99999')).toBeNull()
  })
})

// ── Plain HTTP relay ──────────────────────────────────────────────────────

describe('plain HTTP requests through the proxy', () => {
  it('relays to the tunnel and preserves the Host header and path', async () => {
    const res = await requestViaProxy(proxyPort, 'http://localhost:5173/api/status', {
      host: 'localhost:5173',
      'x-probe': '1',
    })
    expect(res.status).toBe(200)
    expect(res.headers['x-dev-server']).toBe('yes')
    const seen = JSON.parse(res.body) as { seenUrl: string; seenHost: string }
    // Origin-form reaches the server; the absolute-form prefix is stripped.
    expect(seen.seenUrl).toBe('/api/status')
    // The dev server still sees the host the browser asked for.
    expect(seen.seenHost).toBe('localhost:5173')
  }, 10_000)

  it('relays request bodies', async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${proxyPort}`, {
        path: 'http://localhost:5173/submit',
        method: 'POST',
        headers: { host: 'localhost:5173' },
      }, (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk.toString() })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.once('error', reject)
      req.end('payload-123')
    })
    expect(JSON.parse(res.body).body).toBe('payload-123')
  }, 10_000)

  it('routes only loopback targets through the forwarder', async () => {
    // A non-loopback host takes the direct path (which fails to connect here),
    // and the forwarder must never have been asked.
    const callsBefore = forwarder.calls.length
    const res = await requestViaProxy(proxyPort, 'http://127.1.1.1:9/unreachable')
    expect(res.status).toBe(502)
    expect(forwarder.calls.slice(callsBefore)).toEqual([])
  }, 10_000)

  it('answers 502 when the tunnel cannot be established', async () => {
    const res = await requestViaProxy(proxyPort, 'http://localhost:9999/nowhere', {
      host: 'localhost:9999',
    })
    expect(res.status).toBe(502)
    expect(res.body).toContain('localhost:9999')
  }, 10_000)

  it('rejects origin-form requests outright', async () => {
    const res = await requestViaProxy(proxyPort, '/just/a/path')
    expect(res.status).toBe(400)
  })
})

// ── CONNECT relay ─────────────────────────────────────────────────────────

describe('CONNECT through the proxy', () => {
  it('opens a transparent tunnel with the payload relayed both ways', async () => {
    const echo = await listenRaw((socket) => {
      socket.on('data', (chunk: Buffer) => socket.write(chunk))
    })

    forwarder.route = (_host, port) => (port === echo ? echo : null)
    const result = await connectViaProxy(proxyPort, `localhost:${echo}`)
    expect(result.status).toBe(200)
    expect(result.echoed).toBe('ping\n')
    result.socket.destroy()
    forwarder.route = (_host, port) => (port === 5173 ? remoteDevServerPort : null)
  }, 10_000)

  it('answers 502 when the tunnel cannot be established', async () => {
    const result = await connectViaProxy(proxyPort, 'localhost:65530')
    expect(result.status).toBe(502)
  }, 10_000)
})

// ── Forward-handle accounting ─────────────────────────────────────────────

describe('the forward handle is held for the whole exchange', () => {
  it('retains before connecting and releases after the response', async () => {
    const events: string[] = []
    const trackingForwarder: RelayForwarder = {
      async acquire(_host, _port) {
        let retained = false
        return {
          localPort: remoteDevServerPort,
          retain: () => {
            retained = true
            events.push('retain')
          },
          release: () => {
            events.push(retained ? 'release' : 'release-without-retain')
          },
        }
      },
    }
    const proxy = await startBrowserProxy(trackingForwarder)
    try {
      await requestViaProxy(proxy.port, 'http://localhost:5173/accounting', { host: 'localhost:5173' })
      await vi.waitFor(() => {
        expect(events).toEqual(['retain', 'release'])
      })
    } finally {
      await proxy.close()
    }
  }, 10_000)
})
