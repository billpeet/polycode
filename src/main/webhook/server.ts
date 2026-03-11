import * as http from 'http'
import { BrowserWindow } from 'electron'
import {
  createThread,
  getProjectByName,
  getLocationByLabel,
  getLocationById,
  getPoolByName,
  getNextAvailablePoolLocation,
  checkoutLocation,
  getLastUsedProviderAndModel,
} from '../db/queries'
import { sessionManager } from '../session/manager'
import { getModelsForProvider, getDefaultModelForProvider, Provider } from '../../shared/types'

let server: http.Server | null = null

export interface WebhookConfig {
  enabled: boolean
  port: number
  token: string
}

function windowsPathToWsl(winPath: string): string {
  return winPath
    .replace(/^([A-Za-z]):[/\\]/, (_, drive) => `/mnt/${drive.toLowerCase()}/`)
    .replace(/\\/g, '/')
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  })
  res.end(json)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

async function handleCreateThread(
  body: Record<string, unknown>,
  window: BrowserWindow,
  res: http.ServerResponse
): Promise<void> {
  const { project: projectName, location: locationName, provider, model, name, message } = body

  if (!projectName || typeof projectName !== 'string') {
    return sendJson(res, 400, { error: '"project" is required' })
  }

  const project = getProjectByName(projectName)
  if (!project) {
    return sendJson(res, 404, { error: `Project "${projectName}" not found` })
  }

  // Resolve location: by label first, then by pool name
  let locationId: string | null = null
  if (locationName && typeof locationName === 'string') {
    const byLabel = getLocationByLabel(project.id, locationName)
    if (byLabel) {
      locationId = byLabel.id
    } else {
      const pool = getPoolByName(project.id, locationName)
      if (pool) {
        const available = getNextAvailablePoolLocation(pool.id)
        if (!available) {
          return sendJson(res, 409, { error: `Pool "${locationName}" has no available locations` })
        }
        checkoutLocation(available.id)
        locationId = available.id
      } else {
        return sendJson(res, 404, { error: `Location or pool "${locationName}" not found` })
      }
    }
  }

  // Resolve provider/model
  const { provider: defaultProvider, model: defaultModel } = getLastUsedProviderAndModel(project.id)
  const resolvedProvider = (typeof provider === 'string' ? provider : defaultProvider) as Provider
  const validModels = getModelsForProvider(resolvedProvider).map((m) => m.id)
  const resolvedModel =
    typeof model === 'string' && validModels.includes(model)
      ? model
      : typeof model === 'string'
        ? getDefaultModelForProvider(resolvedProvider)
        : defaultModel

  // Create thread
  const threadName = typeof name === 'string' && name.trim() ? name.trim() : 'Webhook thread'
  const thread = createThread(project.id, threadName, locationId, resolvedProvider, resolvedModel)

  // Send initial message if provided
  if (typeof message === 'string' && message.trim()) {
    const location = locationId ? getLocationById(locationId) : null
    let effectiveDir = location?.path ?? ''
    if (location?.connection_type === 'wsl' && /^[A-Za-z]:[/\\]/.test(effectiveDir)) {
      effectiveDir = windowsPathToWsl(effectiveDir)
    }
    const sshConfig = location?.ssh ?? null
    const wslConfig = location?.wsl ?? null
    const session = sessionManager.getOrCreate(thread.id, effectiveDir, window, sshConfig, wslConfig)
    session.sendMessage(message.trim())
  }

  // Notify renderer to refresh thread list
  window.webContents.send('webhook:thread-created', { projectId: project.id, threadId: thread.id })

  sendJson(res, 201, { threadId: thread.id, projectId: project.id, locationId })
}

function createRequestHandler(config: WebhookConfig, window: BrowserWindow): http.RequestListener {
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (config.token) {
      const authHeader = req.headers['authorization'] ?? ''
      if (authHeader !== `Bearer ${config.token}`) {
        return sendJson(res, 401, { error: 'Unauthorized' })
      }
    }

    if (req.method === 'POST' && req.url === '/api/threads') {
      try {
        const raw = await readBody(req)
        const body = JSON.parse(raw) as Record<string, unknown>
        await handleCreateThread(body, window, res)
      } catch (err) {
        console.error('[webhook] Error handling POST /api/threads:', err)
        sendJson(res, 500, { error: 'Internal server error' })
      }
      return
    }

    sendJson(res, 404, { error: 'Not found' })
  }
}

export function startWebhookServer(config: WebhookConfig, window: BrowserWindow): void {
  stopWebhookServer()
  if (!config.enabled) return

  server = http.createServer(createRequestHandler(config, window))
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`[webhook] Server listening on http://127.0.0.1:${config.port}`)
  })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[webhook] Port ${config.port} is already in use`)
    } else {
      console.error('[webhook] Server error:', err)
    }
  })
}

export function stopWebhookServer(): void {
  if (server) {
    server.close()
    server = null
  }
}

export function restartWebhookServer(config: WebhookConfig, window: BrowserWindow): void {
  stopWebhookServer()
  if (config.enabled) {
    startWebhookServer(config, window)
  }
}
