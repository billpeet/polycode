import { describe, expect, it } from 'vitest'
import { knownContextLimit, resolveContextLimit } from '../types'

describe('knownContextLimit', () => {
  it('gives Claude Code models and aliases their 1M default window', () => {
    for (const model of ['opus', 'opus[1m]', 'default', 'sonnet', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7']) {
      expect(knownContextLimit('claude-code', model, null), model).toBe(1_000_000)
    }
  })

  it('keeps Haiku and pre-4.7 Opus/Sonnet at 200k unless the 1M slug is chosen', () => {
    for (const model of ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'claude-opus-4-20250514']) {
      expect(knownContextLimit('claude-code', model, null), model).toBe(200_000)
    }
    expect(knownContextLimit('claude-code', 'claude-opus-4-6', '1m')).toBe(1_000_000)
  })

  it('reads Cursor context selections and catalogue windows', () => {
    expect(knownContextLimit('cursor', 'claude-opus-5-5', '1m')).toBe(1_000_000)
    expect(knownContextLimit('cursor', 'grok-4.7', '256k')).toBe(256_000)
    expect(knownContextLimit('pi', 'openai-codex/gpt-6-sol', null)).toBe(272_000)
    expect(knownContextLimit('opencode', 'opencode/space-bunny-free', null)).toBe(1_048_576)
  })
})

describe('resolveContextLimit', () => {
  it('keeps a Claude 1M window when the SDK reports the 200k base window', () => {
    expect(resolveContextLimit('claude-code', 'claude-opus-4-6', '1m', 200_000)).toBe(1_000_000)
    expect(resolveContextLimit('claude-code', 'opus', null, 200_000)).toBe(1_000_000)
  })

  it('lets Claude report a larger window than PolyCode knows about', () => {
    expect(resolveContextLimit('claude-code', 'claude-sonnet-4-6', null, 1_000_000)).toBe(1_000_000)
  })

  it('prefers the runtime limit for other providers', () => {
    expect(resolveContextLimit('codex', 'gpt-6-sol', null, 258_400)).toBe(258_400)
    expect(resolveContextLimit('pi', 'openai-codex/gpt-6-sol', null, 258_400)).toBe(258_400)
    expect(resolveContextLimit('codex', 'gpt-6-sol', null, null)).toBe(200_000)
  })
})
