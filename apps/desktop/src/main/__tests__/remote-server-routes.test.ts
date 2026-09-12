import * as http from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import type { RemoteServerConfig } from '../../shared/types'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
}))
vi.mock('../control/control-rpc', () => ({
  handleControlRpc: vi.fn(),
  CONTROL_RPC_CHANNELS: new Set(['threads:list']),
}))
vi.mock('../app-events', () => ({
  onAppEvent: vi.fn(() => () => {}),
}))

import { createRequestHandler, type RequestHandlerDeps } from '../remote/server'
import { LoginRateLimiter, SessionStore } from '../remote/sessions'

interface Response {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

interface RequestOptions {
  method?: string
  path: string
  headers?: Record<string, string>
  body?: string
}

let staticRoot: string

beforeAll(() => {
  staticRoot = mkdtempSync(join(tmpdir(), 'polycode-web-'))
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><div id="root"></div>')
  mkdirSync(join(staticRoot, 'assets'))
  writeFileSync(join(staticRoot, 'assets', 'app.js'), 'console.log(1)')
})

afterAll(() => rmSync(staticRoot, { recursive: true, force: true }))

const servers: http.Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

interface Harness {
  config: RemoteServerConfig
  deps: RequestHandlerDeps
  port: number
  origin: string
  request: (options: RequestOptions) => Promise<Response>
}

async function start(overrides: Partial<RemoteServerConfig> = {}): Promise<Harness> {
  const config: RemoteServerConfig = {
    enabled: true,
    host: '127.0.0.1',
    port: 0,
    token: 'host-token',
    webEnabled: true,
    allowedHostnames: ['pc.tailnet.ts.net'],
    tailscaleLogins: [],
    ...overrides,
  }
  const deps: RequestHandlerDeps = {
    handleRpc: vi.fn(async (channel, args) => ({ channel, args })),
    subscribe: vi.fn(() => () => {}),
    version: () => '0.0.0-test',
    staticRoot,
    sessions: new SessionStore(),
    loginLimiter: new LoginRateLimiter(),
  }
  const server = http.createServer(createRequestHandler(config, deps))
  servers.push(server)
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
  // The handler reads config.port at request time; the ephemeral port is only known now.
  config.port = port

  const request = (options: RequestOptions): Promise<Response> => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: options.path,
      headers: options.headers,
    }, (res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.once('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })

  return { config, deps, port, origin: `http://127.0.0.1:${port}`, request }
}

const BEARER = { Authorization: 'Bearer host-token' }

async function login(h: Harness, headers: Record<string, string> = {}): Promise<string> {
  const res = await h.request({
    method: 'POST',
    path: '/api/remote/session',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ token: 'host-token' }),
  })
  expect(res.status).toBe(200)
  const setCookie = res.headers['set-cookie']?.[0]
  expect(setCookie).toBeDefined()
  return setCookie!.split(';')[0]
}

describe('Host gate', () => {
  it('accepts an allowed hostname without a port, as a fronting proxy presents it', async () => {
    const h = await start()
    const res = await h.request({ path: '/api/remote/health', headers: { ...BEARER, Host: 'pc.tailnet.ts.net' } })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true, app: 'PolyCode', version: '0.0.0-test' })
  })

  it('still answers 421 for any other DNS name', async () => {
    const h = await start()
    const res = await h.request({ path: '/api/remote/health', headers: { ...BEARER, Host: `other.tailnet.ts.net:${h.port}` } })
    expect(res.status).toBe(421)
  })
})

describe('static web UI', () => {
  it('serves index.html with the security headers and no caching', async () => {
    const h = await start()
    const res = await h.request({ path: '/' })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['content-security-policy']).toContain("default-src 'self'")
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.body).toContain('id="root"')
  })

  it('serves hashed assets as immutable', async () => {
    const h = await start()
    const res = await h.request({ path: '/assets/app.js' })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(res.headers['content-security-policy']).toBeUndefined()
  })

  it('answers 404 for a missing asset without needing credentials', async () => {
    const h = await start()
    expect((await h.request({ path: '/assets/missing.js' })).status).toBe(404)
  })

  it('is not reachable at all while web access is off', async () => {
    const h = await start({ webEnabled: false })
    expect((await h.request({ path: '/' })).status).toBe(401)
    expect((await h.request({ path: '/assets/app.js' })).status).toBe(401)
    const login = await h.request({ method: 'POST', path: '/api/remote/session', body: JSON.stringify({ token: 'host-token' }) })
    expect(login.status).toBe(401)
  })
})

describe('login exchange', () => {
  it('issues an HttpOnly, SameSite=Strict cookie for the host token', async () => {
    const h = await start()
    const res = await h.request({ method: 'POST', path: '/api/remote/session', body: JSON.stringify({ token: 'host-token' }) })
    expect(res.status).toBe(200)
    const cookie = res.headers['set-cookie']?.[0] ?? ''
    expect(cookie).toMatch(/^polycode_session=[0-9a-f]{64}; /)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).not.toContain('Secure')
  })

  it('marks the cookie Secure when a proxy reports TLS', async () => {
    const h = await start()
    const res = await h.request({
      method: 'POST',
      path: '/api/remote/session',
      headers: { 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ token: 'host-token' }),
    })
    expect(res.headers['set-cookie']?.[0]).toContain('Secure')
  })

  it('rejects a wrong token and rate-limits repeated failures', async () => {
    const h = await start()
    for (let i = 0; i < 5; i++) {
      const res = await h.request({ method: 'POST', path: '/api/remote/session', body: JSON.stringify({ token: 'nope' }) })
      expect(res.status).toBe(401)
      expect(res.headers['set-cookie']).toBeUndefined()
    }
    const limited = await h.request({ method: 'POST', path: '/api/remote/session', body: JSON.stringify({ token: 'host-token' }) })
    expect(limited.status).toBe(429)
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    expect(h.deps.sessions.size).toBe(0)
  })

  it('rejects a body that is not a token object', async () => {
    const h = await start()
    expect((await h.request({ method: 'POST', path: '/api/remote/session', body: 'not json' })).status).toBe(400)
    expect((await h.request({ method: 'POST', path: '/api/remote/session', body: JSON.stringify({ token: 42 }) })).status).toBe(401)
  })
})

describe('tailnet identity sign-in', () => {
  const IDENTITY = { 'Tailscale-User-Login': 'Owner@Example.com', 'Tailscale-User-Name': 'Owner' }

  it('mints a session on the health probe for an admitted login arriving via the local proxy', async () => {
    const h = await start({ tailscaleLogins: ['owner@example.com'] })
    const res = await h.request({ path: '/api/remote/health', headers: IDENTITY })
    expect(res.status).toBe(200)
    const cookie = res.headers['set-cookie']?.[0] ?? ''
    expect(cookie).toMatch(/^polycode_session=[0-9a-f]{64}; /)
    expect(cookie).toContain('HttpOnly')

    // From here on it is an ordinary session: the header is not needed again.
    const rpc = await h.request({
      method: 'POST',
      path: '/api/remote/rpc',
      headers: { Cookie: cookie.split(';')[0], Origin: h.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'threads:list', args: [] }),
    })
    expect(rpc.status).toBe(200)
  })

  it.each([
    ['a login that is not admitted', { tailscaleLogins: ['owner@example.com'] }, { 'Tailscale-User-Login': 'guest@example.com' }],
    ['no identity header', { tailscaleLogins: ['owner@example.com'] }, {}],
    ['a Funnel request', { tailscaleLogins: ['owner@example.com'] }, { ...IDENTITY, 'Tailscale-Funnel-Request': '?1' }],
    ['no admitted logins configured', { tailscaleLogins: [] }, IDENTITY],
    ['web access off', { tailscaleLogins: ['owner@example.com'], webEnabled: false }, IDENTITY],
  ])('answers 401 and sets no cookie for %s', async (_case, overrides, headers) => {
    const h = await start(overrides)
    const res = await h.request({ path: '/api/remote/health', headers })
    expect(res.status).toBe(401)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('never signs in by identity on any endpoint but the health probe', async () => {
    const h = await start({ tailscaleLogins: ['owner@example.com'] })
    const rpc = await h.request({
      method: 'POST',
      path: '/api/remote/rpc',
      headers: { ...IDENTITY, Origin: h.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'threads:list', args: [] }),
    })
    expect(rpc.status).toBe(401)
    const events = await h.request({ path: '/api/remote/events', headers: IDENTITY })
    expect(events.status).toBe(401)
  })
})

describe('cookie-authenticated API access', () => {
  it('reads with the cookie alone', async () => {
    const h = await start()
    const cookie = await login(h)
    const res = await h.request({ path: '/api/remote/health', headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
  })

  it('mutates only with a same-origin Origin header alongside the cookie', async () => {
    const h = await start()
    const cookie = await login(h)
    const body = JSON.stringify({ channel: 'threads:list', args: ['p1'] })

    const withOrigin = await h.request({
      method: 'POST',
      path: '/api/remote/rpc',
      headers: { Cookie: cookie, Origin: h.origin, 'Content-Type': 'application/json' },
      body,
    })
    expect(withOrigin.status).toBe(200)
    expect(JSON.parse(withOrigin.body)).toEqual({ ok: true, value: { channel: 'threads:list', args: ['p1'] } })

    const withoutOrigin = await h.request({
      method: 'POST',
      path: '/api/remote/rpc',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body,
    })
    expect(withoutOrigin.status).toBe(403)

    const foreignOrigin = await h.request({
      method: 'POST',
      path: '/api/remote/rpc',
      headers: { Cookie: cookie, Origin: 'http://attacker.example', 'Content-Type': 'application/json' },
      body,
    })
    expect(foreignOrigin.status).toBe(403)
    expect(h.deps.handleRpc).toHaveBeenCalledTimes(1)
  })

  it('leaves bearer clients exactly as they were: no Origin required', async () => {
    const h = await start()
    const res = await h.request({
      method: 'POST',
      path: '/api/remote/rpc',
      headers: { ...BEARER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'threads:list', args: [] }),
    })
    expect(res.status).toBe(200)
  })

  it('logs out on DELETE and forgets the session', async () => {
    const h = await start()
    const cookie = await login(h)

    const out = await h.request({ method: 'DELETE', path: '/api/remote/session', headers: { Cookie: cookie, Origin: h.origin } })
    expect(out.status).toBe(204)
    expect(out.headers['set-cookie']?.[0]).toContain('Max-Age=0')

    const after = await h.request({ path: '/api/remote/health', headers: { Cookie: cookie } })
    expect(after.status).toBe(401)
  })

  it('ignores a session cookie once web access is turned off', async () => {
    const h = await start({ webEnabled: false })
    const id = h.deps.sessions.mint()
    const res = await h.request({ path: '/api/remote/health', headers: { Cookie: `polycode_session=${id}` } })
    expect(res.status).toBe(401)
  })
})
