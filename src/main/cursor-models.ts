import { homedir } from 'os'
import { ModelOption, ReasoningLevel, SshConfig, WslConfig } from '../shared/types'
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
  name?: string
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

// Canonical order for the effort levels the UI renders.
const REASONING_ORDER: ReasoningLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

function normalizeCursorReasoning(value: string | null | undefined): ReasoningLevel | undefined {
  const normalized = value?.trim().toLowerCase()
  switch (normalized) {
    case 'low':
    case 'medium':
    case 'high':
    case 'max':
      return normalized
    case 'xhigh':
    case 'extra-high':
    case 'extra high':
      return 'xhigh'
    default:
      return undefined
  }
}

function isEffortConfigOption(option: ConfigOption): boolean {
  const id = (option.id ?? '').trim().toLowerCase()
  const name = (option.name ?? '').trim().toLowerCase()
  return option.type === 'select' && (
    id === 'effort' || id === 'reasoning' ||
    name === 'effort' || name === 'reasoning' ||
    name.includes('effort') || name.includes('reasoning')
  )
}

// Mirror t3code's findCursorEffortConfigOption selection priority.
function findEffortConfigOption(configOptions: ConfigOption[]): ConfigOption | undefined {
  const candidates = configOptions.filter(isEffortConfigOption)
  return (
    candidates.find((option) => (option.category ?? '').toLowerCase() === 'model_option') ??
    candidates.find((option) => (option.id ?? '').trim().toLowerCase() === 'effort') ??
    candidates.find((option) => (option.category ?? '').toLowerCase() === 'thought_level') ??
    candidates[0]
  )
}

// Extract the effort levels a model supports from its ACP config options.
// Returns the levels prefixed with 'off' (Cursor's default effort) so the
// selector stays enabled and lets the user fall back to the provider default.
function extractReasoningLevels(configOptions: ConfigOption[] | undefined): ReasoningLevel[] | undefined {
  if (!Array.isArray(configOptions)) return undefined
  const option = findEffortConfigOption(configOptions)
  if (!option) return undefined
  const found = new Set<ReasoningLevel>()
  for (const entry of flattenModelOptions(option)) {
    const level = normalizeCursorReasoning(entry.id) ?? normalizeCursorReasoning(entry.label)
    if (level) found.add(level)
  }
  const ordered = REASONING_ORDER.filter((level) => found.has(level))
  return ordered.length > 0 ? ['off', ...ordered] : undefined
}

function configOptionName(option: ConfigOption): string {
  return (option.name ?? '').trim().toLowerCase()
}

function isFastConfigOption(option: ConfigOption): boolean {
  const id = (option.id ?? '').trim().toLowerCase()
  const name = configOptionName(option)
  return id === 'fast' || name === 'fast' || name.includes('fast mode')
}

function isThinkingConfigOption(option: ConfigOption): boolean {
  const id = (option.id ?? '').trim().toLowerCase()
  return id === 'thinking' || configOptionName(option).includes('thinking')
}

function isContextConfigOption(option: ConfigOption): boolean {
  const id = (option.id ?? '').trim().toLowerCase()
  return id === 'context' || id === 'context_size' || configOptionName(option).includes('context')
}

function findModelConfigOption(configOptions: ConfigOption[], predicate: (option: ConfigOption) => boolean): ConfigOption | undefined {
  return configOptions.find((option) => (option.category ?? '').toLowerCase() === 'model_config' && predicate(option))
    ?? configOptions.find(predicate)
}

function hasBooleanConfigOption(configOptions: ConfigOption[] | undefined, predicate: (option: ConfigOption) => boolean): boolean {
  if (!Array.isArray(configOptions)) return false
  const option = findModelConfigOption(configOptions, predicate)
  if (!option) return false
  if (option.type === 'boolean') return true
  const values = new Set(flattenModelOptions(option).map((entry) => entry.id.trim().toLowerCase()))
  return values.has('true') && values.has('false')
}

function extractContextWindows(configOptions: ConfigOption[] | undefined): { value: string; label: string }[] | undefined {
  if (!Array.isArray(configOptions)) return undefined
  const option = findModelConfigOption(configOptions, isContextConfigOption)
  if (!option || option.type !== 'select') return undefined
  const seen = new Set<string>()
  const windows = flattenModelOptions(option).flatMap((entry) => {
    const value = entry.id.trim()
    if (!value || seen.has(value)) return []
    seen.add(value)
    return [{ value, label: entry.label.trim() || value }]
  })
  return windows.length > 0 ? windows : undefined
}

// Build the model list from `cursor/list_available_models`, which returns each
// model with its own configOptions (parameterized model picker), letting us
// surface per-model effort levels, fast/thinking toggles and context windows
// the way t3code does.
function buildModelsFromListAvailable(result: unknown): CursorAvailableModelOption[] {
  const rec = asRecord(result)
  const models = Array.isArray(rec?.models) ? rec.models : []
  const out: CursorAvailableModelOption[] = []
  const seen = new Set<string>()
  for (const raw of models) {
    const model = asRecord(raw)
    const id = typeof model?.value === 'string' ? model.value.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const label = typeof model?.name === 'string' && model.name.trim() ? model.name.trim() : id
    const configOptions = Array.isArray(model?.configOptions) ? model!.configOptions as ConfigOption[] : undefined
    const reasoningLevels = extractReasoningLevels(configOptions)
    const contextWindows = extractContextWindows(configOptions)
    out.push({
      id,
      label,
      ...(reasoningLevels ? { reasoning: true, reasoningLevels } : {}),
      ...(hasBooleanConfigOption(configOptions, isFastConfigOption) ? { fast: true } : {}),
      ...(hasBooleanConfigOption(configOptions, isThinkingConfigOption) ? { thinking: true } : {}),
      ...(contextWindows ? { contextWindows } : {}),
    })
  }
  return out
}

function mergeWithFallback(models: CursorAvailableModelOption[]): CursorAvailableModelOption[] {
  const seen = new Set<string>()
  return [...FALLBACK_MODELS, ...models].filter((model) => {
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
      binary: 'cursor-agent',
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
      // Prefer the parameterized model picker: it returns each model with its
      // own configOptions, so we can surface per-model effort levels. Fall back
      // to session/new enumeration when the CLI is too old to support it.
      const richModels = await sendRequest('cursor/list_available_models', {})
        .then((result) => buildModelsFromListAvailable(result))
        .catch(() => [] as CursorAvailableModelOption[])
      if (richModels.length > 0) {
        finish(null, mergeWithFallback(richModels))
        return
      }
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
