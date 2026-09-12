import type { SubscriptionUsageSnapshot, SubscriptionUsageWindow } from '../shared/types'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import path from 'path'

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function codexWindow(value: unknown, id: string): SubscriptionUsageWindow | null {
  const raw = record(value)
  if (!raw) return null
  const durationMinutes = finite(raw.windowDurationMins)
  const label = durationMinutes === 300
    ? '5 hour'
    : durationMinutes === 10_080
      ? 'Weekly'
      : durationMinutes == null
        ? id
        : `${durationMinutes} min`
  return {
    id,
    label,
    usedPercent: finite(raw.usedPercent),
    durationMinutes,
    resetsAt: finite(raw.resetsAt),
  }
}

export function normalizeCodexSubscriptionUsage(value: unknown): SubscriptionUsageSnapshot {
  const root = record(value)
  const rawLimits = record(root?.rateLimits)
  const windows = [
    codexWindow(rawLimits?.primary, 'primary'),
    codexWindow(rawLimits?.secondary, 'secondary'),
  ].filter((window): window is SubscriptionUsageWindow => window !== null)

  return {
    provider: 'codex',
    plan: typeof rawLimits?.planType === 'string' ? rawLimits.planType : null,
    windows,
    observedAt: Date.now(),
    source: 'codex-app-server',
    ...(rawLimits && windows.length > 0 ? {} : { error: 'unavailable' as const }),
  }
}

function claudeWindow(value: unknown, id: string, label: string, durationMinutes: number | null): SubscriptionUsageWindow | null {
  const raw = record(value)
  if (!raw) return null
  const reset = raw.resets_at
  const parsedReset = typeof reset === 'string' ? Date.parse(reset) / 1000 : finite(reset)
  return {
    id,
    label,
    usedPercent: finite(raw.utilization),
    durationMinutes,
    resetsAt: parsedReset !== null && Number.isFinite(parsedReset) ? parsedReset : null,
  }
}

export function normalizeClaudeSubscriptionUsage(value: unknown): SubscriptionUsageSnapshot {
  const root = record(value)
  const rawLimits = record(root?.rate_limits)
  const windows = [
    claudeWindow(rawLimits?.five_hour, 'five_hour', '5 hour', 300),
    claudeWindow(rawLimits?.seven_day, 'seven_day', 'Weekly', 10_080),
    claudeWindow(rawLimits?.seven_day_opus, 'seven_day_opus', 'Opus weekly', 10_080),
    claudeWindow(rawLimits?.seven_day_sonnet, 'seven_day_sonnet', 'Sonnet weekly', 10_080),
  ].filter((window): window is SubscriptionUsageWindow => window !== null)

  return {
    provider: 'claude-code',
    plan: typeof root?.subscription_type === 'string' ? root.subscription_type : null,
    windows,
    observedAt: Date.now(),
    source: 'claude-sdk',
    ...(root?.rate_limits_available === false || windows.length === 0 ? { error: 'unavailable' as const } : {}),
  }
}

export function normalizeGlmSubscriptionUsage(value: unknown): SubscriptionUsageSnapshot {
  const root = record(value)
  const data = record(root?.data)
  const limits = Array.isArray(data?.limits) ? data.limits : []
  const windows = limits.flatMap((value): SubscriptionUsageWindow[] => {
    const limit = record(value)
    if (!limit || limit.type !== 'TOKENS_LIMIT') return []
    const unit = finite(limit.unit)
    const number = finite(limit.number)
    const durationMinutes = unit === 3 && number === 5
      ? 300
      : unit === 6 && number === 1
        ? 10_080
        : null
    const resetMilliseconds = finite(limit.nextResetTime)
    return [{
      id: durationMinutes === 300 ? 'five_hour' : durationMinutes === 10_080 ? 'seven_day' : `tokens_${unit ?? 'unknown'}_${number ?? 'unknown'}`,
      label: durationMinutes === 300 ? '5 hour' : durationMinutes === 10_080 ? 'Weekly' : 'Token quota',
      usedPercent: finite(limit.percentage),
      durationMinutes,
      resetsAt: resetMilliseconds == null ? null : resetMilliseconds / 1000,
    }]
  })

  return {
    provider: 'glm',
    plan: null,
    windows,
    observedAt: Date.now(),
    source: 'glm-monitor',
    ...(windows.length > 0 ? {} : { error: 'unavailable' as const }),
  }
}

function readOpenCodeZaiApiKey(): string | null {
  const environmentKey = process.env.ZAI_API_KEY?.trim()
  if (environmentKey) return environmentKey
  const dataHome = process.env.XDG_DATA_HOME?.trim()
  const candidates = [
    ...(dataHome ? [path.join(dataHome, 'opencode', 'auth.json')] : []),
    path.join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
  ]
  for (const candidate of candidates) {
    try {
      const auth = record(JSON.parse(readFileSync(candidate, 'utf8')))
      const credential = record(auth?.['zai-coding-plan'])
      const key = typeof credential?.key === 'string' ? credential.key.trim() : ''
      if (key) return key
    } catch {
      // Try the next conventional OpenCode credential location.
    }
  }
  return null
}

export async function getGlmSubscriptionUsage(fetchImpl: typeof fetch = fetch): Promise<SubscriptionUsageSnapshot> {
  const apiKey = readOpenCodeZaiApiKey()
  if (!apiKey) throw new Error('Z.ai authentication required. Sign in to the Z.AI Coding Plan through OpenCode or set ZAI_API_KEY.')
  const response = await fetchImpl('https://api.z.ai/api/monitor/usage/quota/limit', {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  })
  if (response.status === 401 || response.status === 403) {
    throw new Error('Z.ai authentication failed. Sign in to the Z.AI Coding Plan through OpenCode again.')
  }
  if (!response.ok) throw new Error(`Z.ai usage request failed (HTTP ${response.status}).`)
  return normalizeGlmSubscriptionUsage(await response.json())
}

export function unavailableSubscriptionUsage(provider: 'claude-code' | 'codex'): SubscriptionUsageSnapshot {
  return {
    provider,
    plan: null,
    windows: [],
    observedAt: Date.now(),
    source: provider === 'codex' ? 'codex-app-server' : 'claude-sdk',
    error: 'unavailable',
  }
}
