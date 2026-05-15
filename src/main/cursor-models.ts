import { homedir } from 'os'
import { ModelOption, SshConfig, WslConfig } from '../shared/types'
import { createRunner, LOAD_NODE_MANAGERS } from './driver/runner'

export type CursorAvailableModelOption = ModelOption

type CacheEntry = {
  expiresAt: number
  value: CursorAvailableModelOption[]
}

type JsonRpcMessage = {
  id?: number | string
  method?: string
  result?: unknown
  error?: { message?: string; code?: number }
}

type ConfigOption = {
  id?: string
  category?: string
  type?: string
  options?: unknown[]
}

const SUCCESS_TTL_MS = 60 * 60_000
const EMPTY_TTL_MS = 5 * 60_000
const ERROR_TTL_MS = 60_000
const REQUEST_TIMEOUT_MS = 20_000

const CURSOR_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  _meta: { parameterizedModelPicker: true },
}

const FALLBACK_MODELS: CursorAvailableModelOption[] = [
  { id: 'default', label: 'Default' },
  { id: 'auto', label: 'Auto' },
]

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<CursorAvailableModelOption[]>>()

function cacheKey(ssh?: SshConfig | null, wsl?: WslConfig | null): string {
  if (ssh) return `ssh:${ssh.user}@${ssh.host}:${ssh.port ?? 22}:${ssh.keyPath ?? ''}`
  if (wsl) return `wsl:${wsl.distro}`
  return 'local'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function flattenModelOptions(option: ConfigOption | undefined): CursorAvailableModelOption[] {
  if (!option || option.type !== 'select' || !Array.isArray(option.options)) return []

  const out: CursorAvailableModelOption[] = []
  const visit = (entry: unknown) => {
    const rec = asRecord(entry)
    if (!rec) return
    if (typeof rec.value === 'string') {
      out.push({ id: rec.value, label: typeof rec.name === 'string' ? rec.name : rec.value })
      return
    }
    if (Array.isArray(rec.options)) rec.options.forEach(visit)
  }

  option.options.forEach(visit)
  return out
}

function normalizeModels(setup: unknown): CursorAvailableModelOption[] {
  const setupRecord = asRecord(setup) ?? {}
  const configOptions = Array.isArray(setupRecord.configOptions) ? setupRecord.configOptions as ConfigOption[] : []
  const modelOption = configOptions.find((option) => option.category === 'model' || option.id === 'model')
  const liveModels = flattenModelOptions(modelOption)
  const seen = new Set<string>()

  return [...FALLBACK_MODELS, ...liveModels].filter((model) => {
    if (!model.id || seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}

function readCached(key: string): CursorAvailableModelOption[] | undefined {
  const cached = cache.get(key)
  if (!cached || cached.expiresAt <= Date.now()) return undefined
  return cached.value
}

function writeCache(key: string, value: CursorAvailableModelOption[], ttlMs: number): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs })
}

async function queryCursorAvailableModels(
  cwd: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<CursorAvailableModelOption[]> {
  return new Promise((resolve, reject) => {
    const runner = createRunner({ ssh: ssh ?? undefined, wsl: wsl ?? undefined })
    const proc = runner.spawn({
      binary: 'agent',
      args: ['acp'],
      workDir: cwd,
      preamble: LOAD_NODE_MANAGERS,
      keepStdinOpen: true,
    })

    let buffer = ''
    let stderr = ''
    let settled = false
    let nextId = 1
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

    const finish = (error: Error | null, models?: CursorAvailableModelOption[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
      if (error) reject(error)
      else resolve(models ?? [])
    }

    const sendRequest = (method: string, params: unknown): Promise<unknown> => {
      const id = nextId++
      return new Promise((requestResolve, requestReject) => {
        pending.set(id, { resolve: requestResolve, reject: requestReject })
        proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    }

    const timer = setTimeout(() => {
      finish(new Error(`Timed out while asking Cursor for available models${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
    }, REQUEST_TIMEOUT_MS)

    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        let message: JsonRpcMessage
        try {
          message = JSON.parse(line) as JsonRpcMessage
        } catch {
          continue
        }
        if (typeof message.id !== 'number' || message.method) continue
        const request = pending.get(message.id)
        if (!request) continue
        pending.delete(message.id)
        if (message.error) request.reject(new Error(message.error.message ?? `Cursor ACP request failed (${message.error.code ?? 'unknown'})`))
        else request.resolve(message.result)
      }
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    proc.on('error', (error) => finish(error))
    proc.on('close', (code) => {
      if (!settled && code !== 0 && code !== null) {
        finish(new Error(`Cursor ACP exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
      }
    })

    ;(async () => {
      await sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: CURSOR_CLIENT_CAPABILITIES,
        clientInfo: { name: 'polycode', version: '0.13.0' },
      })
      await sendRequest('authenticate', { methodId: 'cursor_login' })
      const setup = await sendRequest('session/new', { cwd, mcpServers: [] })
      finish(null, normalizeModels(setup))
    })().catch((error) => finish(error instanceof Error ? error : new Error(String(error))))
  })
}

export async function listCursorAvailableModels(options: {
  cwd?: string | null
  ssh?: SshConfig | null
  wsl?: WslConfig | null
} = {}): Promise<CursorAvailableModelOption[]> {
  const key = cacheKey(options.ssh, options.wsl)
  const cached = readCached(key)
  if (cached) return cached

  const existing = inFlight.get(key)
  if (existing) return existing

  const cwd = options.cwd || (options.ssh || options.wsl ? '~' : homedir())

  const promise = queryCursorAvailableModels(cwd, options.ssh, options.wsl)
    .then((models) => {
      writeCache(key, models, models.length > FALLBACK_MODELS.length ? SUCCESS_TTL_MS : EMPTY_TTL_MS)
      return models
    })
    .catch((error) => {
      writeCache(key, [], ERROR_TTL_MS)
      throw error
    })
    .finally(() => {
      inFlight.delete(key)
    })

  inFlight.set(key, promise)
  return promise
}
