import { homedir } from 'os'
import { SshConfig, WslConfig } from '../shared/types'
import { createRunner } from './driver/runner'

export interface PiAvailableModelOption {
  id: string
  label: string
  contextWindow?: number
}

type CacheEntry = {
  expiresAt: number
  value: PiAvailableModelOption[]
}

type RpcResponse = {
  id?: string
  type?: string
  command?: string
  success?: boolean
  error?: string
  data?: unknown
}

type PiModel = {
  id?: unknown
  name?: unknown
  provider?: unknown
  contextWindow?: unknown
}

const SUCCESS_TTL_MS = 60 * 60_000
const EMPTY_TTL_MS = 5 * 60_000
const ERROR_TTL_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<PiAvailableModelOption[]>>()

function cacheKey(ssh?: SshConfig | null, wsl?: WslConfig | null): string {
  if (ssh) return `ssh:${ssh.user}@${ssh.host}:${ssh.port ?? 22}:${ssh.keyPath ?? ''}`
  if (wsl) return `wsl:${wsl.distro}`
  return 'local'
}

function normalizeLabel(provider: string, id: string, name?: string): string {
  if (name && name !== id) return name
  return `${provider}/${id}`
}

function normalizeModels(data: unknown): PiAvailableModelOption[] {
  const models = (data as { models?: unknown } | undefined)?.models
  if (!Array.isArray(models)) return []

  return models
    .map((raw): PiAvailableModelOption | null => {
      const model = raw as PiModel
      if (typeof model.id !== 'string' || typeof model.provider !== 'string') return null
      const contextWindow = typeof model.contextWindow === 'number' ? model.contextWindow : undefined
      return {
        id: `${model.provider}/${model.id}`,
        label: normalizeLabel(model.provider, model.id, typeof model.name === 'string' ? model.name : undefined),
        ...(contextWindow ? { contextWindow } : {}),
      }
    })
    .filter((model): model is PiAvailableModelOption => model !== null)
    .sort((a, b) => a.label.localeCompare(b.label))
}

function readCached(key: string): PiAvailableModelOption[] | undefined {
  const cached = cache.get(key)
  if (!cached || cached.expiresAt <= Date.now()) return undefined
  return cached.value
}

function writeCache(key: string, value: PiAvailableModelOption[], ttlMs: number): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs })
}

async function queryPiAvailableModels(
  cwd: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<PiAvailableModelOption[]> {
  return new Promise((resolve, reject) => {
    const runner = createRunner({ ssh: ssh ?? undefined, wsl: wsl ?? undefined })
    const requestId = `models-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const proc = runner.spawn({
      binary: 'pi',
      args: ['--mode', 'rpc'],
      workDir: cwd,
      keepStdinOpen: true,
    })

    let stdoutBuffer = ''
    let stderrBuffer = ''
    let settled = false

    const finish = (error: Error | null, models?: PiAvailableModelOption[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
      if (error) reject(error)
      else resolve(models ?? [])
    }

    const timer = setTimeout(() => {
      finish(new Error(`Timed out while asking pi for available models${stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : ''}`))
    }, REQUEST_TIMEOUT_MS)

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        let parsed: RpcResponse
        try {
          parsed = JSON.parse(line) as RpcResponse
        } catch {
          continue
        }

        if (parsed.type !== 'response' || parsed.id !== requestId || parsed.command !== 'get_available_models') {
          continue
        }

        if (!parsed.success) {
          finish(new Error(parsed.error || 'pi get_available_models failed'))
          return
        }

        finish(null, normalizeModels(parsed.data))
        return
      }
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf8')
    })

    proc.on('error', (error) => finish(error))
    proc.on('close', (code) => {
      if (!settled && code !== 0 && code !== null) {
        finish(new Error(`pi exited with code ${code}${stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : ''}`))
      }
    })

    proc.stdin?.write(JSON.stringify({ id: requestId, type: 'get_available_models' }) + '\n')
  })
}

export async function listPiAvailableModels(options: {
  cwd?: string | null
  ssh?: SshConfig | null
  wsl?: WslConfig | null
} = {}): Promise<PiAvailableModelOption[]> {
  const key = cacheKey(options.ssh, options.wsl)
  const cached = readCached(key)
  if (cached) return cached

  const existing = inFlight.get(key)
  if (existing) return existing

  const cwd = options.cwd || (options.ssh || options.wsl ? '~' : homedir())

  const promise = queryPiAvailableModels(cwd, options.ssh, options.wsl)
    .then((models) => {
      writeCache(key, models, models.length > 0 ? SUCCESS_TTL_MS : EMPTY_TTL_MS)
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
