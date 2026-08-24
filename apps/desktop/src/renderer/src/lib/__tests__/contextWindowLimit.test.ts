import { describe, expect, it } from 'vitest'
import { resolveDisplayedContextLimit } from '../contextWindowLimit'

describe('resolveDisplayedContextLimit', () => {
  it('keeps an explicit Claude 1M selection when the SDK reports its 200k base window', () => {
    expect(resolveDisplayedContextLimit(
      'claude-code',
      'claude-opus-4-6',
      '1m',
      200_000,
    )).toBe(1_000_000)
  })

  it('uses runtime limits for providers whose catalog value is only a fallback', () => {
    expect(resolveDisplayedContextLimit('codex', 'gpt-5.5', null, 258_400)).toBe(258_400)
    expect(resolveDisplayedContextLimit('pi', 'openai-codex/gpt-5.5', null, 258_400)).toBe(258_400)
  })
})
