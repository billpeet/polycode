import * as http from 'http'
import { app, BrowserWindow } from 'electron'
import { handleControlRpc, CONTROL_RPC_CHANNELS } from '../control/control-rpc'
import { onAppEvent } from '../app-events'
import { RemoteServerConfig } from '../../shared/types'

let server: http.Server | null = null

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  })
  res.end(json)
}

function readBody(req: http.IncomingMessage, maxBytes = 5 * 1024 * 1024): Promise<string> {
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

function isAuthorized(req: http.IncomingMessage, token: string): boolean {
  const authHeader = req.headers.authorization ?? ''
  return authHeader === `Bearer ${token}`
}

function shouldStreamEvent(channel: string): boolean {
  return channel.startsWith('thread:')
    || channel === 'plan:associated'
    || channel === 'webhook:thread-created'
}

function createRequestHandler(config: RemoteServerConfig, window: BrowserWindow): http.RequestListener {
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://${config.host}:${config.port}`)

    if (!isAuthorized(req, config.token)) {
      return sendJson(res, 401, { error: 'Unauthorized' })
    }

    if (req.method === 'GET' && url.pathname === '/api/remote/health') {
      return sendJson(res, 200, {
        ok: true,
        app: 'PolyCode',
        version: app.getVersion(),
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

      const off = onAppEvent((event) => {
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

        const value = await handleControlRpc(window, body.channel, body.args)
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

export function startRemoteControlServer(config: RemoteServerConfig, window: BrowserWindow): void {
  stopRemoteControlServer()
  if (!config.enabled) return

  server = http.createServer(createRequestHandler(config, window))
  server.listen(config.port, config.host, () => {
    console.log(`[remote-control] Server listening on http://${config.host}:${config.port}`)
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

export function restartRemoteControlServer(config: RemoteServerConfig, window: BrowserWindow): void {
  stopRemoteControlServer()
  if (config.enabled) startRemoteControlServer(config, window)
}
