import * as http from 'http'
import { join } from 'path'
import { app, BrowserWindow } from 'electron'
import { handleControlRpc, CONTROL_RPC_CHANNELS } from '../control/control-rpc'
import type { RunLifecycle } from '../runs/lifecycle'
import { onAppEvent } from '../app-events'
import { RemoteServerConfig } from '../../shared/types'
import { isValidBearerToken, isValidToken } from '../http-auth'
import { getAllowedCorsOrigin, isAllowedHostHeader } from '../http-request-security'
import { attachRemoteBrowserTunnel } from './browser-tunnel'
import {
  LoginRateLimiter,
  SessionStore,
  expiredSessionCookie,
  readSessionCookie,
  resolveClientAddress,
  sessionCookie,
} from './sessions'
import { isStaticPath, serveStaticFile } from './static'
import { tailscaleIdentityLogin } from './identity'

let server: http.Server | null = null

/**
 * Browser sessions outlive a settings-driven restart — saving an unrelated field must
 * not log every browser out. Only a token change revokes them, which is also what
 * revokes every paired native client.
 */
const sessions = new SessionStore()
const loginLimiter = new LoginRateLimiter()
let sessionsToken: string | null = null

/** Everything the request handler reaches for that is not the request itself. */
export interface RequestHandlerDeps {
  handleRpc: (channel: string, args: unknown[]) => Promise<unknown>
  subscribe: typeof onAppEvent
  version: () => string
  /** Directory holding the renderer bundle (`index.html` + `assets/`). */
  staticRoot: string
  sessions: SessionStore
  loginLimiter: LoginRateLimiter
}

const LOGIN_BODY_LIMIT = 4 * 1024

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    ...headers,
  })
  res.end(json)
}

function readBody(req: http.IncomingMessage, maxBytes = 15 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      data += chunk.toString('utf8')
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  return raw?.split(',')[0]?.trim() || undefined
}

/** `https` only when a proxy in front of us says the client leg was TLS. */
function forwardedProto(req: http.IncomingMessage): string | undefined {
  return firstHeaderValue(req.headers['x-forwarded-proto'])?.toLowerCase()
}

function clientAddress(req: http.IncomingMessage): string {
  return resolveClientAddress(req.socket.remoteAddress, firstHeaderValue(req.headers['x-forwarded-for']))
}

type Credential = 'bearer' | 'session'

function authenticate(req: http.IncomingMessage, config: RemoteServerConfig, sessions: SessionStore): Credential | null {
  if (isValidBearerToken(req.headers.authorization, config.token)) return 'bearer'
  if (config.webEnabled && sessions.has(readSessionCookie(req.headers.cookie))) return 'session'
  return null
}

function shouldStreamEvent(channel: string): boolean {
  return channel.startsWith('thread:')
    || channel.startsWith('command:')
    || channel.startsWith('terminal:')
    || channel === 'plan:associated'
    || channel.startsWith('plan-file:')
    || channel === 'webhook:thread-created'
    || channel === 'files:changed'
    || channel === 'git:repoChanged'
    || channel === 'routines:changed'
}

async function handleLogin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: RemoteServerConfig,
  deps: RequestHandlerDeps,
): Promise<void> {
  const address = clientAddress(req)
  if (!deps.loginLimiter.allow(address)) {
    return sendJson(res, 429, { error: 'Too many attempts' }, {
      'Retry-After': String(deps.loginLimiter.retryAfterSeconds(address)),
    })
  }

  let presented: unknown
  try {
    presented = (JSON.parse(await readBody(req, LOGIN_BODY_LIMIT)) as { token?: unknown }).token
  } catch {
    return sendJson(res, 400, { error: 'Expected a JSON body with a "token" string' })
  }

  if (typeof presented !== 'string' || !isValidToken(presented, config.token)) {
    deps.loginLimiter.recordFailure(address)
    return sendJson(res, 401, { error: 'Unauthorized' })
  }

  deps.loginLimiter.reset(address)
  const id = deps.sessions.mint()
  sendJson(res, 200, { ok: true }, {
    'Set-Cookie': sessionCookie(id, { secure: forwardedProto(req) === 'https' }),
  })
}

export function createRequestHandler(config: RemoteServerConfig, deps: RequestHandlerDeps): http.RequestListener {
  return async (req, res) => {
    if (!isAllowedHostHeader(req.headers.host, config.host, config.port, { allowedHostnames: config.allowedHostnames })) {
      return sendJson(res, 421, { error: 'Misdirected request' })
    }

    const allowedOrigin = getAllowedCorsOrigin(req.headers.origin, req.headers.host, forwardedProto(req))
    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
    }
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('X-Content-Type-Options', 'nosniff')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://${config.host}:${config.port}`)

    // The web UI's bundle and its login exchange are the only things reachable without
    // a credential: a browser has nothing to present until it has loaded the page.
    if (config.webEnabled) {
      if (req.method === 'GET' && isStaticPath(url.pathname)) {
        return serveStaticFile(deps.staticRoot, url.pathname, res)
      }
      if (req.method === 'POST' && url.pathname === '/api/remote/session') {
        return handleLogin(req, res, config, deps)
      }
    }

    let credential = authenticate(req, config, deps.sessions)

    // A browser arriving through `tailscale serve` on this machine may be signed in by
    // its tailnet identity instead of the token — but only here, on the read-only probe
    // the web client opens with, and only to mint the same cookie the token would. Every
    // request after that is an ordinary session; nothing else ever reads the header.
    if (!credential && req.method === 'GET' && url.pathname === '/api/remote/health') {
      const login = tailscaleIdentityLogin(req.socket.remoteAddress, req.headers, config)
      if (login) {
        res.setHeader('Set-Cookie', sessionCookie(deps.sessions.mint(), { secure: forwardedProto(req) === 'https' }))
        credential = 'session'
      }
    }

    if (!credential) {
      return sendJson(res, 401, { error: 'Unauthorized' })
    }

    // A cookie rides along on any request the browser makes, including one a hostile
    // page provoked. `SameSite=Strict` is the first fence; requiring a same-origin
    // `Origin` on anything that mutates is the second. Bearer clients are unaffected.
    if (credential === 'session' && req.method !== 'GET' && !allowedOrigin) {
      return sendJson(res, 403, { error: 'Cross-origin request rejected' })
    }

    if (req.method === 'DELETE' && url.pathname === '/api/remote/session') {
      const id = readSessionCookie(req.headers.cookie)
      if (id) deps.sessions.revoke(id)
      res.writeHead(204, { 'Set-Cookie': expiredSessionCookie({ secure: forwardedProto(req) === 'https' }) })
      res.end()
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/remote/health') {
      return sendJson(res, 200, {
        ok: true,
        app: 'PolyCode',
        version: deps.version(),
      })
    }

    if (req.method === 'GET' && url.pathname === '/api/remote/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write(': connected\n\n')

      const keepAlive = setInterval(() => {
        res.write(`: ${Date.now()}\n\n`)
      }, 25_000)

      const off = deps.subscribe((event) => {
        if (!shouldStreamEvent(event.channel)) return
        res.write(`event: app\ndata: ${JSON.stringify(event)}\n\n`)
      })

      req.on('close', () => {
        clearInterval(keepAlive)
        off()
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/remote/rpc') {
      try {
        const raw = await readBody(req)
        const body = JSON.parse(raw) as { channel?: unknown; args?: unknown }
        if (typeof body.channel !== 'string' || !CONTROL_RPC_CHANNELS.has(body.channel)) {
          return sendJson(res, 400, { ok: false, error: 'Unsupported channel' })
        }
        if (!Array.isArray(body.args)) {
          return sendJson(res, 400, { ok: false, error: '"args" must be an array' })
        }

        const value = await deps.handleRpc(body.channel, body.args)
        return sendJson(res, 200, { ok: true, value })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[remote-control] RPC failed:', message)
        return sendJson(res, 500, { ok: false, error: message })
      }
    }

    sendJson(res, 404, { error: 'Not found' })
  }
}

export function startRemoteControlServer(config: RemoteServerConfig, window: BrowserWindow, runLifecycle: RunLifecycle): void {
  stopRemoteControlServer()
  if (!config.enabled) return

  if (sessionsToken !== config.token) {
    sessions.clear()
    sessionsToken = config.token
  }

  const deps: RequestHandlerDeps = {
    handleRpc: (channel, args) => handleControlRpc({ window, runLifecycle }, channel, args),
    subscribe: onAppEvent,
    version: () => app.getVersion(),
    // Same bundle the desktop window loads (`main/index.ts` → `../renderer/index.html`).
    staticRoot: join(__dirname, '../renderer'),
    sessions,
    loginLimiter,
  }

  server = http.createServer(createRequestHandler(config, deps))
  attachRemoteBrowserTunnel(server, config)
  server.listen(config.port, config.host, () => {
    console.log(`[remote-control] Server listening on http://${config.host}:${config.port}${config.webEnabled ? ' (web UI enabled)' : ''}`)
  })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[remote-control] Port ${config.port} is already in use`)
    } else {
      console.error('[remote-control] Server error:', err)
    }
  })
}

export function stopRemoteControlServer(): void {
  if (!server) return
  server.close()
  server = null
}

export function restartRemoteControlServer(config: RemoteServerConfig, window: BrowserWindow, runLifecycle: RunLifecycle): void {
  stopRemoteControlServer()
  if (config.enabled) startRemoteControlServer(config, window, runLifecycle)
}
