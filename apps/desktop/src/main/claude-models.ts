import { homedir } from 'os'
import { ModelOption, ReasoningLevel, SshConfig, WslConfig } from '../shared/types'
import { augmentWindowsPath, expandHomePath, resolveClaudeCodeExecutable } from './driver/runner'

export type ClaudeAvailableModelOption = ModelOption

type CacheEntry = {
  expiresAt: number
  value: ClaudeAvailableModelOption[]
}

type ClaudeModelInfo = {
  value?: unknown
  displayName?: unknown
  description?: unknown
  supportsEffort?: unknown
  supportedEffortLevels?: unknown
  supportsAdaptiveThinking?: unknown
}

const SUCCESS_TTL_MS = 24 * 60 * 60_000
const EMPTY_TTL_MS = 60 * 60_000
const ERROR_TTL_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 20_000

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<ClaudeAvailableModelOption[]>>()

function cacheKey(ssh?: SshConfig | null, wsl?: WslConfig | null): string {
  // Claude Code SDK model discovery is local. Include transport in the key anyway so this
  // remains safe if a future SDK supports remote discovery through the same options shape.
  if (ssh) return `ssh:${ssh.user}@${ssh.host}:${ssh.port ?? 22}:${ssh.keyPath ?? ''}`
  if (wsl) return `wsl:${wsl.distro}`
  return 'local'
}

const CLAUDE_EFFORT_LEVELS: ReasoningLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

function isClaudeEffortLevel(value: unknown): value is ReasoningLevel {
  return typeof value === 'string' && CLAUDE_EFFORT_LEVELS.includes(value as ReasoningLevel)
}

function fallbackEffortLevelsForModel(id: string): ReasoningLevel[] {
  if (id.includes('opus-4-8') || id.includes('opus-4.8') || id.includes('opus-4-7') || id.includes('opus-4.7') || id.includes('opus-4-6') || id.includes('opus-4.6')) {
    return ['off', 'low', 'medium', 'high', 'xhigh', 'max']
  }
  if (id.includes('haiku')) return ['off', 'low', 'medium', 'high']
  return ['off', 'low', 'medium', 'high', 'xhigh']
}

function normalizeEffortLevels(model: ClaudeModelInfo, id: string): ReasoningLevel[] {
  const rawLevels = Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels : null
  const levels = rawLevels?.filter(isClaudeEffortLevel)
  if (levels && levels.length > 0) return Array.from(new Set(['off' as ReasoningLevel, ...levels]))
  if (model.supportsEffort === true) return fallbackEffortLevelsForModel(id)
  return ['off']
}

function normalizeModels(models: unknown): ClaudeAvailableModelOption[] {
  if (!Array.isArray(models)) return []

  return models
    .map((raw): ClaudeAvailableModelOption | null => {
      const model = raw as ClaudeModelInfo
      if (typeof model.value !== 'string') return null
      const label = typeof model.displayName === 'string' && model.displayName.trim()
        ? model.displayName.trim()
        : model.value
      const reasoningLevels = normalizeEffortLevels(model, model.value)
      return {
        id: model.value,
        label,
        reasoning: model.supportsEffort === true,
        reasoningLevels,
      }
    })
    .filter((model): model is ClaudeAvailableModelOption => model !== null)
}

function readCached(key: string): ClaudeAvailableModelOption[] | undefined {
  const cached = cache.get(key)
  if (!cached || cached.expiresAt <= Date.now()) return undefined
  return cached.value
}

function writeCache(key: string, value: ClaudeAvailableModelOption[], ttlMs: number): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs })
}

async function queryClaudeAvailableModels(cwd: string): Promise<ClaudeAvailableModelOption[]> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  const env = process.platform === 'win32' ? augmentWindowsPath(process.env) : process.env
  const workingDir = expandHomePath(cwd)

  async function* emptyPrompt() {
    // The SDK exposes model metadata after initialization; no user message is needed.
  }

  const query = sdk.query({
    prompt: emptyPrompt(),
    options: {
      cwd: workingDir,
      pathToClaudeCodeExecutable: resolveClaudeCodeExecutable(env),
      env,
      settingSources: ['user', 'project', 'local'],
    } as Parameters<typeof sdk.query>[0]['options'] & { settingSources: string[] },
  })

  let timer: NodeJS.Timeout | undefined
  try {
    const models = await Promise.race([
      query.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out while asking Claude Code for available models')), REQUEST_TIMEOUT_MS)
      }),
    ])
    return normalizeModels(models)
  } finally {
    if (timer) clearTimeout(timer)
    const closeResult = query.close()
    if (closeResult && typeof (closeResult as Promise<void>).catch === 'function') {
      await closeResult.catch(() => undefined)
    }
  }
}

export async function listClaudeAvailableModels(options: {
  cwd?: string | null
  ssh?: SshConfig | null
  wsl?: WslConfig | null
} = {}): Promise<ClaudeAvailableModelOption[]> {
  const key = cacheKey(options.ssh, options.wsl)
  const cached = readCached(key)
  if (cached) return cached

  const existing = inFlight.get(key)
  if (existing) return existing

  const cwd = options.cwd || homedir()

  const promise = queryClaudeAvailableModels(cwd)
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
