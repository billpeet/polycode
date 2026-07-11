import { randomBytes, randomUUID } from 'crypto'
import { BrowserWindow, ipcMain } from 'electron'
import { getSetting, setSetting } from '../db/queries'
import { CONTROL_RPC_CHANNELS } from '../control/control-rpc'
import { readRemoteServerConfig, saveRemoteServerConfig } from './config'
import { getPairingInfo } from './lan'
import { restartRemoteControlServer } from './server'
import { emitAppEvent } from '../app-events'
import {
  RemoteConnectionStatus,
  RemoteHost,
  RemoteHostInput,
  RemoteServerConfig,
} from '../../shared/types'

const REMOTE_HOSTS_KEY = 'remote:hosts'
const REMOTE_ACTIVE_HOST_KEY = 'remote:activeHostId'

interface RpcResponse {
  ok?: boolean
  value?: unknown
  error?: string
}

interface ProxyResult {
  handled: boolean
  value?: unknown
}

let activeClient: RemoteControlClient | null = null

function readHosts(): RemoteHost[] {
  const raw = getSetting(REMOTE_HOSTS_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRemoteHost)
  } catch {
    return []
  }
}

function writeHosts(hosts: RemoteHost[]): void {
  setSetting(REMOTE_HOSTS_KEY, JSON.stringify(hosts))
}

function isRemoteHost(value: unknown): value is RemoteHost {
  const host = value as RemoteHost
  return Boolean(
    host
      && typeof host.id === 'string'
      && typeof host.label === 'string'
      && typeof host.baseUrl === 'string'
      && typeof host.token === 'string'
      && typeof host.createdAt === 'string'
      && typeof host.updatedAt === 'string',
  )
}

function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Remote URL is required')
  const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  const url = new URL(withProtocol)
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/+$/, '')
}

function normalizeHostInput(input: RemoteHostInput): RemoteHostInput {
  const label = input.label.trim()
  if (!label) throw new Error('Host label is required')
  const token = input.token.trim()
  if (!token) throw new Error('Host token is required')
  return {
    label,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    token,
  }
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readJsonResponse(response: Response): Promise<RpcResponse> {
  try {
    return await response.json() as RpcResponse
  } catch {
    return {}
  }
}

export class RemoteControlClient {
  private eventAbort: AbortController | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private streamGeneration = 0

  constructor(private readonly window: BrowserWindow) {
    this.restartEventStream()
  }

  stop(): void {
    this.streamGeneration += 1
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.eventAbort?.abort()
    this.eventAbort = null
  }

  getHosts(): RemoteHost[] {
    return readHosts()
  }

  getActiveHost(): RemoteHost | null {
    const activeId = getSetting(REMOTE_ACTIVE_HOST_KEY)
    if (!activeId) return null
    return this.getHosts().find((host) => host.id === activeId) ?? null
  }

  addHost(input: RemoteHostInput): RemoteHost {
    const normalized = normalizeHostInput(input)
    const now = new Date().toISOString()
    const host: RemoteHost = {
      id: randomUUID(),
      ...normalized,
      createdAt: now,
      updatedAt: now,
    }
    writeHosts([...this.getHosts(), host])
    emitAppEvent(this.window, 'remote:hosts-changed', this.getHosts())
    return host
  }

  updateHost(id: string, input: RemoteHostInput): RemoteHost {
    const normalized = normalizeHostInput(input)
    let updated: RemoteHost | null = null
    const hosts = this.getHosts().map((host) => {
      if (host.id !== id) return host
      updated = { ...host, ...normalized, updatedAt: new Date().toISOString() }
      return updated
    })
    if (!updated) throw new Error('Remote host not found')
    writeHosts(hosts)
    emitAppEvent(this.window, 'remote:hosts-changed', hosts)
    if (getSetting(REMOTE_ACTIVE_HOST_KEY) === id) this.restartEventStream()
    return updated
  }

  removeHost(id: string): void {
    const hosts = this.getHosts().filter((host) => host.id !== id)
    writeHosts(hosts)
    emitAppEvent(this.window, 'remote:hosts-changed', hosts)
    if (getSetting(REMOTE_ACTIVE_HOST_KEY) === id) {
      setSetting(REMOTE_ACTIVE_HOST_KEY, '')
      this.restartEventStream()
      emitAppEvent(this.window, 'remote:active-changed', null)
    }
  }

  setActiveHost(id: string | null): RemoteHost | null {
    if (!id) {
      setSetting(REMOTE_ACTIVE_HOST_KEY, '')
      this.restartEventStream()
      emitAppEvent(this.window, 'remote:active-changed', null)
      return null
    }

    const host = this.getHosts().find((candidate) => candidate.id === id)
    if (!host) throw new Error('Remote host not found')
    setSetting(REMOTE_ACTIVE_HOST_KEY, host.id)
    this.restartEventStream()
    emitAppEvent(this.window, 'remote:active-changed', host)
    return host
  }

  shouldProxy(channel: string): boolean {
    return CONTROL_RPC_CHANNELS.has(channel)
  }

  async invokeIfActive(channel: string, args: unknown[]): Promise<ProxyResult> {
    const host = this.getActiveHost()
    if (!host || !this.shouldProxy(channel)) return { handled: false }
    return { handled: true, value: await this.invoke(host, channel, args) }
  }

  async testHost(input: RemoteHostInput): Promise<RemoteConnectionStatus> {
    try {
      const normalized = normalizeHostInput(input)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      try {
        const response = await fetch(endpoint(normalized.baseUrl, '/api/remote/health'), {
          method: 'GET',
          headers: { Authorization: `Bearer ${normalized.token}` },
          signal: controller.signal,
        })
        const body = await readJsonResponse(response)
        if (response.ok && body.ok) return { ok: true }
        return { ok: false, error: body.error ?? `HTTP ${response.status}` }
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }

  private async invoke(host: RemoteHost, channel: string, args: unknown[]): Promise<unknown> {
    const response = await fetch(endpoint(host.baseUrl, '/api/remote/rpc'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${host.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel, args }),
    })
    const body = await readJsonResponse(response)
    if (!response.ok || !body.ok) {
      throw new Error(body.error ?? `Remote request failed with HTTP ${response.status}`)
    }
    return body.value
  }

  private restartEventStream(): void {
    this.streamGeneration += 1
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.eventAbort?.abort()
    this.eventAbort = null

    const host = this.getActiveHost()
    if (!host) return

    const generation = this.streamGeneration
    this.connectEventStream(host, generation, 0)
  }

  private connectEventStream(host: RemoteHost, generation: number, delayMs: number): void {
    if (delayMs > 0) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        void this.runEventStream(host, generation)
      }, delayMs)
      return
    }
    void this.runEventStream(host, generation)
  }

  private async runEventStream(host: RemoteHost, generation: number): Promise<void> {
    if (generation !== this.streamGeneration) return
    const controller = new AbortController()
    this.eventAbort = controller

    try {
      const response = await fetch(endpoint(host.baseUrl, '/api/remote/events'), {
        method: 'GET',
        headers: { Authorization: `Bearer ${host.token}` },
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        throw new Error(`Remote event stream failed with HTTP ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (generation === this.streamGeneration) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let separator = buffer.indexOf('\n\n')
        while (separator !== -1) {
          const frame = buffer.slice(0, separator)
          buffer = buffer.slice(separator + 2)
          this.handleSseFrame(frame)
          separator = buffer.indexOf('\n\n')
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn('[remote-control] Event stream disconnected:', errorMessage(error))
      }
    } finally {
      if (this.eventAbort === controller) this.eventAbort = null
      if (generation === this.streamGeneration && !controller.signal.aborted) {
        this.connectEventStream(host, generation, 2000)
      }
    }
  }

  private handleSseFrame(frame: string): void {
    const lines = frame.split(/\r?\n/)
    let eventName = 'message'
    const dataLines: string[] = []

    for (const line of lines) {
      if (!line || line.startsWith(':')) continue
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }
    }

    if (eventName !== 'app' || dataLines.length === 0) return

    try {
      const event = JSON.parse(dataLines.join('\n')) as { channel?: unknown; args?: unknown }
      if (typeof event.channel !== 'string' || !Array.isArray(event.args)) return
      if (this.window.webContents.isDestroyed()) return
      this.window.webContents.send(event.channel, ...event.args)
    } catch {
      // Ignore malformed frames from a stale or incompatible host.
    }
  }
}

export function registerRemoteControlIpcHandlers(window: BrowserWindow): RemoteControlClient {
  const client = new RemoteControlClient(window)
  activeClient = client

  ipcMain.handle('remote:getServerConfig', () => {
    return readRemoteServerConfig()
  })

  ipcMain.handle('remote:setServerConfig', (_event, config: RemoteServerConfig) => {
    const saved = saveRemoteServerConfig(config)
    restartRemoteControlServer(saved, window)
    return saved
  })

  ipcMain.handle('remote:regenerateServerToken', () => {
    const current = readRemoteServerConfig()
    const saved = saveRemoteServerConfig({
      ...current,
      token: randomBytes(24).toString('hex'),
    })
    restartRemoteControlServer(saved, window)
    return saved
  })

  ipcMain.handle('remote:getPairingInfo', () => {
    return getPairingInfo()
  })

  ipcMain.handle('remote:getHosts', () => {
    return client.getHosts()
  })

  ipcMain.handle('remote:addHost', (_event, input: RemoteHostInput) => {
    return client.addHost(input)
  })

  ipcMain.handle('remote:updateHost', (_event, id: string, input: RemoteHostInput) => {
    return client.updateHost(id, input)
  })

  ipcMain.handle('remote:removeHost', (_event, id: string) => {
    client.removeHost(id)
  })

  ipcMain.handle('remote:setActiveHost', (_event, id: string | null) => {
    return client.setActiveHost(id)
  })

  ipcMain.handle('remote:getActiveHost', () => {
    return client.getActiveHost()
  })

  ipcMain.handle('remote:testHost', (_event, input: RemoteHostInput) => {
    return client.testHost(input)
  })

  return client
}

export function stopRemoteControlClient(): void {
  activeClient?.stop()
  activeClient = null
}
