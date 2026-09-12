import { describe, expect, it } from 'vitest'
import { normalizeClaudeSubscriptionUsage, normalizeCodexSubscriptionUsage, normalizeGlmSubscriptionUsage } from '../subscription-usage'
import { subscriptionUsageProviderFor } from '../../shared/types'

describe('subscription usage provider resolution', () => {
  it.each([
    ['codex', 'gpt-5.6-codex', 'codex'],
    ['claude-code', 'claude-opus-4-6', 'claude-code'],
    ['pi', 'openai-codex/gpt-5.6-codex', 'codex'],
    ['pi', 'anthropic/claude-opus-4-6', 'claude-code'],
    ['pi', 'zai/glm-5.3', 'glm'],
    ['opencode', 'openai/gpt-5.6-codex', 'codex'],
    ['opencode', 'anthropic/claude-opus-4-6', 'claude-code'],
    ['opencode', 'zai-coding-plan/glm-5.3', 'glm'],
  ] as const)('maps %s model %s to %s', (provider, model, expected) => {
    expect(subscriptionUsageProviderFor(provider, model)).toBe(expected)
  })

  it('does not mistake routed or unrelated models for direct subscriptions', () => {
    expect(subscriptionUsageProviderFor('opencode', 'openrouter/z-ai/glm-5.3')).toBeNull()
    expect(subscriptionUsageProviderFor('pi', 'google/gemini-3-pro')).toBeNull()
  })
})

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

  it('normalizes Z.ai token windows and millisecond reset timestamps', () => {
    const snapshot = normalizeGlmSubscriptionUsage({
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 14, nextResetTime: 1_800_000_000_000 },
          { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 31, nextResetTime: 1_800_100_000_000 },
          { type: 'TIME_LIMIT', unit: 6, number: 1, percentage: 80, nextResetTime: 1_800_100_000_000 },
        ],
      },
    })

    expect(snapshot.provider).toBe('glm')
    expect(snapshot.source).toBe('glm-monitor')
    expect(snapshot.windows).toMatchObject([
      { id: 'five_hour', label: '5 hour', usedPercent: 14, durationMinutes: 300, resetsAt: 1_800_000_000 },
      { id: 'seven_day', label: 'Weekly', usedPercent: 31, durationMinutes: 10_080, resetsAt: 1_800_100_000 },
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
