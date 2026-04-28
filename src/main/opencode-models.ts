import { homedir } from 'os'
import { ModelOption, ReasoningLevel, SshConfig, WslConfig } from '../shared/types'
import { createRunner } from './driver/runner'

export type OpenCodeAvailableModelOption = ModelOption

type CacheEntry = {
  expiresAt: number
  value: OpenCodeAvailableModelOption[]
}

type OpenCodeModel = {
  name?: unknown
  capabilities?: { reasoning?: unknown }
  limit?: { context?: unknown }
  variants?: unknown
  status?: unknown
}

const SUCCESS_TTL_MS = 24 * 60 * 60_000
const EMPTY_TTL_MS = 60 * 60_000
const ERROR_TTL_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 20_000

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<OpenCodeAvailableModelOption[]>>()

function cacheKey(ssh?: SshConfig | null, wsl?: WslConfig | null): string {
  if (ssh) return `ssh:${ssh.user}@${ssh.host}:${ssh.port ?? 22}:${ssh.keyPath ?? ''}`
  if (wsl) return `wsl:${wsl.distro}`
  return 'local'
}

const REASONING_LEVELS: ReasoningLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function normalizeReasoningLevel(value: unknown): ReasoningLevel | null {
  if (value === 'none') return 'off'
  return typeof value === 'string' && REASONING_LEVELS.includes(value as ReasoningLevel)
    ? value as ReasoningLevel
    : null
}

function fallbackReasoningLevelsForModel(id: string): ReasoningLevel[] {
  const lower = id.toLowerCase()
  if (lower.includes('gpt-5') || lower.includes('codex')) return ['off', 'minimal', 'low', 'medium', 'high']
  if (lower.includes('opus-4-7') || lower.includes('opus-4.7')) return ['off', 'low', 'medium', 'high', 'xhigh', 'max']
  if (lower.includes('opus-4-6') || lower.includes('opus-4.6') || lower.includes('sonnet-4-6') || lower.includes('sonnet-4.6')) return ['off', 'low', 'medium', 'high', 'max']
  return ['off', 'low', 'medium', 'high']
}

function normalizeReasoningLevels(model: OpenCodeModel, id: string): ReasoningLevel[] {
  if (model.variants && typeof model.variants === 'object' && !Array.isArray(model.variants)) {
    const levels = Object.keys(model.variants)
      .map(normalizeReasoningLevel)
      .filter((level): level is ReasoningLevel => level !== null)
    if (levels.length > 0) return Array.from(new Set(['off' as ReasoningLevel, ...levels]))
  }

  if (model.capabilities?.reasoning === true) return fallbackReasoningLevelsForModel(id)
  return ['off']
}

function parseVerboseModels(output: string): OpenCodeAvailableModelOption[] {
  const lines = output.split(/\r?\n/)
  const models: OpenCodeAvailableModelOption[] = []

  for (let i = 0; i < lines.length; i++) {
    const id = lines[i].trim()
    if (!id || id.startsWith('{') || !id.includes('/')) continue

    const jsonLines: string[] = []
    let depth = 0
    let started = false

    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      const trimmed = line.trim()
      if (!started && !trimmed.startsWith('{')) continue

      started = true
      jsonLines.push(line)
      for (const char of line) {
        if (char === '{') depth += 1
        else if (char === '}') depth -= 1
      }

      if (started && depth <= 0) {
        i = j
        break
      }
    }

    let model: OpenCodeModel = {}
    if (jsonLines.length > 0) {
      try {
        model = JSON.parse(jsonLines.join('\n')) as OpenCodeModel
      } catch {
        model = {}
      }
    }

    const provider = id.split('/')[0]
    const name = typeof model.name === 'string' && model.name.trim() ? model.name.trim() : id.split('/').slice(1).join('/')
    const contextWindow = typeof model.limit?.context === 'number' ? model.limit.context : undefined
    const reasoningLevels = normalizeReasoningLevels(model, id)

    models.push({
      id,
      label: `${provider}/${name}`,
      reasoning: model.capabilities?.reasoning === true,
      reasoningLevels,
      ...(contextWindow ? { contextWindow } : {}),
    })
  }

  return models.sort((a, b) => {
    const aOpenCode = a.id.startsWith('opencode/')
    const bOpenCode = b.id.startsWith('opencode/')
    if (aOpenCode && !bOpenCode) return -1
    if (!aOpenCode && bOpenCode) return 1
    return a.label.localeCompare(b.label)
  })
}

function readCached(key: string): OpenCodeAvailableModelOption[] | undefined {
  const cached = cache.get(key)
  if (!cached || cached.expiresAt <= Date.now()) return undefined
  return cached.value
}

function writeCache(key: string, value: OpenCodeAvailableModelOption[], ttlMs: number): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs })
}

async function queryOpenCodeAvailableModels(
  cwd: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<OpenCodeAvailableModelOption[]> {
  return new Promise((resolve, reject) => {
    const runner = createRunner({ ssh: ssh ?? undefined, wsl: wsl ?? undefined })
    const proc = runner.spawn({
      binary: 'opencode',
      args: ['models', '--verbose'],
      workDir: cwd,
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (error: Error | null, models?: OpenCodeAvailableModelOption[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
      if (error) reject(error)
      else resolve(models ?? [])
    }

    const timer = setTimeout(() => {
      finish(new Error(`Timed out while asking opencode for available models${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
    }, REQUEST_TIMEOUT_MS)

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    proc.on('error', (error) => finish(error))
    proc.on('close', (code) => {
      if (settled) return
      if (code !== 0 && code !== null) {
        finish(new Error(`opencode exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
        return
      }
      finish(null, parseVerboseModels(stdout))
    })
  })
}

export async function listOpenCodeAvailableModels(options: {
  cwd?: string | null
  ssh?: SshConfig | null
  wsl?: WslConfig | null
} = {}): Promise<OpenCodeAvailableModelOption[]> {
  const key = cacheKey(options.ssh, options.wsl)
  const cached = readCached(key)
  if (cached) return cached

  const existing = inFlight.get(key)
  if (existing) return existing

  const cwd = options.cwd || (options.ssh || options.wsl ? '~' : homedir())

  const promise = queryOpenCodeAvailableModels(cwd, options.ssh, options.wsl)
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
