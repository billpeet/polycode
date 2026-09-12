import { describe, expect, it } from 'vitest'
import { normalizeClaudeSubscriptionUsage, normalizeCodexSubscriptionUsage } from '../subscription-usage'

describe('subscription usage normalization', () => {
  it('normalizes Codex session and weekly windows by duration', () => {
    const snapshot = normalizeCodexSubscriptionUsage({
      rateLimits: {
        planType: 'plus',
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 8, windowDurationMins: 10_080, resetsAt: 1_800_100_000 },
      },
    })

    expect(snapshot.plan).toBe('plus')
    expect(snapshot.windows).toMatchObject([
      { label: '5 hour', usedPercent: 25, durationMinutes: 300 },
      { label: 'Weekly', usedPercent: 8, durationMinutes: 10_080 },
    ])
  })

  it('normalizes nullable Claude plan windows and ISO reset timestamps', () => {
    const snapshot = normalizeClaudeSubscriptionUsage({
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 37, resets_at: '2026-09-12T06:00:00Z' },
        seven_day: { utilization: 26, resets_at: null },
        seven_day_opus: null,
      },
    })

    expect(snapshot.plan).toBe('max')
    expect(snapshot.windows).toHaveLength(2)
    expect(snapshot.windows[0].resetsAt).toBe(Date.parse('2026-09-12T06:00:00Z') / 1000)
    expect(snapshot.windows[1].resetsAt).toBeNull()
  })

  it('does not turn a missing response into zero usage', () => {
    expect(normalizeCodexSubscriptionUsage({}).windows).toEqual([])
    expect(normalizeCodexSubscriptionUsage({}).error).toBe('unavailable')
    expect(normalizeClaudeSubscriptionUsage({ rate_limits_available: false }).windows).toEqual([])
  })
})
