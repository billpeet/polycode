import { describe, expect, it } from 'vitest'
import {
  buildRemoteResolvePreamble,
  parseOpenCodeText,
  runSystemTextChain,
  type SystemTextAttempt,
} from '../system-text'

describe('system text provider chain', () => {
  it('returns the first successful attempt', async () => {
    const attempts: SystemTextAttempt[] = [
      { provider: 'codex', query: () => Promise.reject(new Error('codex not found')) },
      { provider: 'claude', query: () => Promise.resolve('claude says hi') },
      { provider: 'opencode', query: () => Promise.resolve('opencode says hi') },
    ]

    expect(await runSystemTextChain(attempts)).toBe('claude says hi')
  })

  it('skips attempts that resolve to empty output', async () => {
    const attempts: SystemTextAttempt[] = [
      { provider: 'codex', query: () => Promise.resolve('   ') },
      { provider: 'claude', query: () => Promise.resolve('pong') },
    ]

    expect(await runSystemTextChain(attempts)).toBe('pong')
  })

  it('aggregates every failure when all providers fail', async () => {
    const attempts: SystemTextAttempt[] = [
      { provider: 'codex', query: () => Promise.reject(new Error('not installed')) },
      { provider: 'claude', query: () => Promise.reject(new Error('not authenticated')) },
    ]

    await expect(runSystemTextChain(attempts)).rejects.toThrow(
      'No text-generation provider available — codex: not installed | claude: not authenticated',
    )
  })

  it('extracts assistant text from opencode NDJSON events', () => {
    const raw = [
      '{"type":"step_start","sessionID":"s1","part":{}}',
      '{"type":"text","sessionID":"s1","part":{"type":"text","text":"fix: add"}}',
      '{"type":"text","sessionID":"s1","part":{"type":"text","text":" fallback"}}',
    ].join('\n')

    expect(parseOpenCodeText(raw)).toBe('fix: add fallback')
  })

  it('falls back to raw stdout when opencode emits plain text', () => {
    expect(parseOpenCodeText('plain response\n')).toBe('plain response')
  })

  it('builds a remote preamble that exports the resolved CLI directory', () => {
    const preamble = buildRemoteResolvePreamble('claude', 'CLAUDE_BIN')

    expect(preamble).toContain('CLAUDE_BIN="$(command -v claude')
    expect(preamble).toContain('/mnt/c/*')
    expect(preamble).toContain('export PATH="$(dirname "$CLAUDE_BIN"):$PATH"')
    expect(preamble).toContain('exit 127')
  })
})
