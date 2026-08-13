import { homedir } from 'os'
import { ModelOption, SshConfig, WslConfig } from '../shared/types'
import { createRunner } from './driver/runner'
import {
  GROK_ACP_ARGS,
  GROK_BINARY,
  GROK_CLIENT_CAPABILITIES,
  GROK_CLIENT_INFO,
  GROK_DEFAULT_MODEL_ID,
  GROK_REMOTE_PREAMBLE,
  GROK_SPAWN_EXTRA_ENV,
  grokAuthMethodOrder,
  parseGrokSessionModels,
} from './driver/grok-acp'

export type GrokAvailableModelOption = ModelOption

type CacheEntry = {
  expiresAt: number
  value: GrokAvailableModelOption[]
}

type JsonRpcMessage = {
  id?: number | string
  method?: string
  result?: unknown
  error?: { message?: string; code?: number }
}

const SUCCESS_TTL_MS = 60 * 60_000
const EMPTY_TTL_MS = 5 * 60_000
const ERROR_TTL_MS = 60_000
const REQUEST_TIMEOUT_MS = 20_000

const FALLBACK_MODELS: GrokAvailableModelOption[] = [
  { id: GROK_DEFAULT_MODEL_ID, label: 'Grok Build' },
]

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<GrokAvailableModelOption[]>>()

function cacheKey(ssh?: SshConfig | null, wsl?: WslConfig | null): string {
  if (ssh) return `ssh:${ssh.user}@${ssh.host}:${ssh.port ?? 22}:${ssh.keyPath ?? ''}`
  if (wsl) return `wsl:${wsl.distro}`
  return 'local'
}

function mergeWithFallback(models: GrokAvailableModelOption[]): GrokAvailableModelOption[] {
  const seen = new Set<string>()
  return [...FALLBACK_MODELS, ...models].filter((model) => {
    if (!model.id || seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}

function readCached(key: string): GrokAvailableModelOption[] | undefined {
  const cached = cache.get(key)
  if (!cached || cached.expiresAt <= Date.now()) return undefined
  return cached.value
}

function writeCache(key: string, value: GrokAvailableModelOption[], ttlMs: number): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs })
}

/**
 * Start a throwaway `grok agent stdio` ACP session and read the model catalog
 * off the session setup result (`models.availableModels`) — the same discovery
 * t3code's discoverGrokModelsViaAcp performs. Grok has no dedicated
 * list-models request, so a short-lived session/new is the probe.
 */
async function queryGrokAvailableModels(
  cwd: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<GrokAvailableModelOption[]> {
  return new Promise((resolve, reject) => {
    const runner = createRunner({ ssh: ssh ?? undefined, wsl: wsl ?? undefined })
    const proc = runner.spawn({
      binary: GROK_BINARY,
      args: GROK_ACP_ARGS,
      workDir: cwd,
      preamble: GROK_REMOTE_PREAMBLE,
      keepStdinOpen: true,
      extraEnv: GROK_SPAWN_EXTRA_ENV,
    })

    let buffer = ''
    let stderr = ''
    let settled = false
    let nextId = 1
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

    const finish = (error: Error | null, models?: GrokAvailableModelOption[]) => {
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
      finish(new Error(`Timed out while asking Grok for available models${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
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
        if (message.error) request.reject(new Error(message.error.message ?? `Grok ACP request failed (${message.error.code ?? 'unknown'})`))
        else request.resolve(message.result)
      }
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    proc.on('error', (error) => finish(error))
    proc.on('close', (code) => {
      if (!settled && code !== 0 && code !== null) {
        finish(new Error(`Grok ACP exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
      }
    })

    ;(async () => {
      await sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: GROK_CLIENT_CAPABILITIES,
        clientInfo: GROK_CLIENT_INFO,
      })
      const methods = grokAuthMethodOrder(process.env, !!(ssh || wsl))
      let authenticated = false
      let lastAuthError: Error | null = null
      for (const methodId of methods) {
        try {
          await sendRequest('authenticate', { methodId })
          authenticated = true
          break
        } catch (error) {
          lastAuthError = error instanceof Error ? error : new Error(String(error))
        }
      }
      if (!authenticated) throw lastAuthError ?? new Error('Grok ACP authentication failed')
      const setup = await sendRequest('session/new', { cwd, mcpServers: [] })
      finish(null, mergeWithFallback(parseGrokSessionModels(setup).models))
    })().catch((error) => finish(error instanceof Error ? error : new Error(String(error))))
  })
}

export async function listGrokAvailableModels(options: {
  cwd?: string | null
  ssh?: SshConfig | null
  wsl?: WslConfig | null
} = {}): Promise<GrokAvailableModelOption[]> {
  const key = cacheKey(options.ssh, options.wsl)
  const cached = readCached(key)
  if (cached) return cached

  const existing = inFlight.get(key)
  if (existing) return existing

  const cwd = options.cwd || (options.ssh || options.wsl ? '~' : homedir())

  const promise = queryGrokAvailableModels(cwd, options.ssh, options.wsl)
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
