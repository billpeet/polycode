import type { SubscriptionUsageSnapshot, SubscriptionUsageWindow } from '../shared/types'

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
