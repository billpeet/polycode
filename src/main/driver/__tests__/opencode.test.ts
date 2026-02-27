import { describe, it, expect, beforeEach } from 'bun:test'
import { OpenCodeDriver, buildOpenCodeArgs } from '../opencode'
import type { OutputEvent } from '../../../shared/types'
import type { DriverOptions } from '../types'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDriver(opts: Partial<DriverOptions> = {}): OpenCodeDriver {
  return new OpenCodeDriver({
    workingDir: '/tmp/test',
    threadId: 'test-thread',
    ...opts,
  })
}

/** Call the (now inherited) parseEvent method via any-cast. */
function parse(driver: OpenCodeDriver, data: Record<string, unknown>): OutputEvent[] {
  return (driver as any).parseEvent(data)
}

/** Feed a full JSONL string through processBuffer and collect events. */
function feed(driver: OpenCodeDriver, jsonl: string): OutputEvent[] {
  const events: OutputEvent[] = []
  ;(driver as any).buffer = jsonl + '\n'
  ;(driver as any).processBuffer((e: OutputEvent) => events.push(e))
  return events
}

// Real session/part IDs from the observed logs
const SESSION_ID = 'ses_37c19c7d1ffe6iyf3lsD4ooAiU'
const PART_ID    = 'prt_c83e6e3ca001ZcdseS035irmy3'
const CALL_ID    = 'call_abc123'

// ── buildOpenCodeArgs ─────────────────────────────────────────────────────────

describe('buildOpenCodeArgs', () => {
  it('new conversation: format flag only', () => {
    expect(buildOpenCodeArgs(null, undefined)).toEqual([
      'run', '--format', 'json',
    ])
  })

  it('new conversation: model flag present', () => {
    expect(buildOpenCodeArgs(null, 'opencode/big-pickle')).toEqual([
      'run', '--format', 'json', '--model', 'opencode/big-pickle',
    ])
  })

  it('resume: --session before --model', () => {
    expect(buildOpenCodeArgs('ses_abc', 'opencode/big-pickle')).toEqual([
      'run', '--format', 'json', '--session', 'ses_abc', '--model', 'opencode/big-pickle',
    ])
  })

  it('resume without model', () => {
    expect(buildOpenCodeArgs('ses_abc', undefined)).toEqual([
      'run', '--format', 'json', '--session', 'ses_abc',
    ])
  })

  it('--format json always present', () => {
    const args = buildOpenCodeArgs(null, undefined)
    expect(args).toContain('--format')
    expect(args[args.indexOf('--format') + 1]).toBe('json')
  })
})

// ── Session ID capture ────────────────────────────────────────────────────────

describe('sessionID capture', () => {
  it('captures sessionID from first event and calls onSessionId', () => {
    let captured: string | undefined
    const driver = makeDriver({ onSessionId: (id) => { captured = id } })
    parse(driver, {
      type: 'step_start',
      sessionID: SESSION_ID,
      timestamp: 1771739439637,
      part: { id: PART_ID },
    })
    expect(captured).toBe(SESSION_ID)
    expect((driver as any).sessionId).toBe(SESSION_ID)
  })

  it('does not call onSessionId a second time once captured', () => {
    let callCount = 0
    const driver = makeDriver({ onSessionId: () => { callCount++ } })
    const event = { type: 'step_start', sessionID: SESSION_ID, timestamp: 1 }
    parse(driver, event)
    parse(driver, event)
    expect(callCount).toBe(1)
  })

  it('does not call onSessionId when no sessionID on event', () => {
    let captured: string | undefined
    const driver = makeDriver({ onSessionId: (id) => { captured = id } })
    parse(driver, { type: 'text', part: { text: 'hi' } })
    expect(captured).toBeUndefined()
  })

  it('uses initialSessionId for resumption without re-calling onSessionId', () => {
    let captured: string | undefined
    const driver = makeDriver({
      initialSessionId: SESSION_ID,
      onSessionId: (id) => { captured = id },
    })
    parse(driver, { type: 'step_start', sessionID: SESSION_ID, timestamp: 1 })
    expect(captured).toBeUndefined() // already set via initialSessionId, should not fire again
    expect((driver as any).sessionId).toBe(SESSION_ID)
  })
})

// ── text events ───────────────────────────────────────────────────────────────

describe('parseOpenCodeEvent — text', () => {
  it('emits text event from part.text', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'text',
      sessionID: SESSION_ID,
      timestamp: 1771739439776,
      part: {
        id: 'prt_c83e6629a001euDpcsJpGvut0C',
        sessionID: SESSION_ID,
        messageID: 'msg_c83e6300a001',
        type: 'text',
        text: 'Yes, I am working!',
      },
    })
    expect(events).toEqual([{ type: 'text', content: 'Yes, I am working!' }])
  })

  it('emits nothing when part.text is absent', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'text',
      sessionID: SESSION_ID,
      part: { id: PART_ID, type: 'text' },
    })
    expect(events).toHaveLength(0)
  })

  it('emits nothing when part is absent', () => {
    const driver = makeDriver()
    expect(parse(driver, { type: 'text', sessionID: SESSION_ID })).toHaveLength(0)
  })

  it('emits nothing when text is empty string', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'text',
      sessionID: SESSION_ID,
      part: { type: 'text', text: '' },
    })
    expect(events).toHaveLength(0)
  })
})

// ── tool_use events ───────────────────────────────────────────────────────────

describe('parseOpenCodeEvent — tool_use (completed)', () => {
  it('emits tool_call + tool_result for a completed read tool', () => {
    const driver = makeDriver()
    // Shape observed in real logs: tool_use event with completed ToolPart
    const events = parse(driver, {
      type: 'tool_use',
      sessionID: SESSION_ID,
      timestamp: 1771739472894,
      part: {
        id: PART_ID,
        sessionID: SESSION_ID,
        messageID: 'msg_c83e6e00a001',
        type: 'tool',
        callID: CALL_ID,
        tool: 'read',
        state: {
          status: 'completed',
          input: { filePath: 'peanut-poem.txt' },
          output: 'Peanuts are great\nThey taste so fine\n',
          title: 'Read peanut-poem.txt',
          metadata: {},
          time: { start: 1771739472000, end: 1771739473000 },
        },
      },
    })

    expect(events).toHaveLength(2)

    const call = events[0]
    expect(call.type).toBe('tool_call')
    expect(call.content).toBe('read')
    expect(call.metadata?.type).toBe('tool_call')
    expect(call.metadata?.name).toBe('read')
    expect(call.metadata?.input).toEqual({ filePath: 'peanut-poem.txt' })
    expect(call.metadata?.id).toBe(CALL_ID)

    const result = events[1]
    expect(result.type).toBe('tool_result')
    expect(result.content).toBe('Peanuts are great\nThey taste so fine\n')
    expect(result.metadata?.type).toBe('tool_result')
    expect(result.metadata?.tool_use_id).toBe(CALL_ID)
    expect(result.metadata?.is_error).toBeUndefined()
  })

  it('emits tool_call + tool_result for a completed bash tool', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'tool_use',
      sessionID: SESSION_ID,
      timestamp: 1771739475634,
      part: {
        id: 'prt_c83e6eea1001',
        sessionID: SESSION_ID,
        messageID: 'msg_c83e6e00a001',
        type: 'tool',
        callID: 'call_bash1',
        tool: 'bash',
        state: {
          status: 'completed',
          input: { command: 'ls -la' },
          output: 'file1.txt\nfile2.txt\n',
          title: 'ls -la',
          metadata: {},
          time: { start: 1771739475000, end: 1771739476000 },
        },
      },
    })

    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('tool_call')
    expect(events[0].content).toBe('bash')
    expect(events[0].metadata?.name).toBe('bash')
    expect((events[0].metadata?.input as Record<string, unknown>)?.command).toBe('ls -la')
    expect(events[1].type).toBe('tool_result')
    expect(events[1].content).toBe('file1.txt\nfile2.txt\n')
    expect(events[1].metadata?.tool_use_id).toBe('call_bash1')
  })

  it('emits tool_result with empty string when output is absent', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'tool_use',
      sessionID: SESSION_ID,
      part: {
        callID: CALL_ID,
        tool: 'write',
        state: { status: 'completed', input: { filePath: 'out.txt' }, title: 'Write', metadata: {} },
      },
    })
    const result = events.find(e => e.type === 'tool_result')
    expect(result).toBeDefined()
    expect(result?.content).toBe('')
    expect(result?.metadata?.tool_use_id).toBe(CALL_ID)
  })
})

describe('parseOpenCodeEvent — tool_use (error)', () => {
  it('emits tool_call + tool_result with is_error for an errored tool', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'tool_use',
      sessionID: SESSION_ID,
      part: {
        callID: CALL_ID,
        tool: 'bash',
        state: {
          status: 'error',
          input: { command: 'cat nonexistent.txt' },
          error: 'cat: nonexistent.txt: No such file or directory',
          time: { start: 1771739475000, end: 1771739476000 },
        },
      },
    })

    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('tool_call')
    expect(events[1].type).toBe('tool_result')
    expect(events[1].content).toBe('cat: nonexistent.txt: No such file or directory')
    expect(events[1].metadata?.is_error).toBe(true)
    expect(events[1].metadata?.tool_use_id).toBe(CALL_ID)
  })

  it('emits empty error content when error field is absent', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'tool_use',
      sessionID: SESSION_ID,
      part: {
        callID: CALL_ID,
        tool: 'bash',
        state: { status: 'error', input: {}, time: { start: 0, end: 1 } },
      },
    })
    const result = events.find(e => e.type === 'tool_result')
    expect(result?.content).toBe('')
    expect(result?.metadata?.is_error).toBe(true)
  })
})

describe('parseOpenCodeEvent — tool_use (no/unknown state)', () => {
  it('emits only tool_call when state is absent', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'tool_use',
      sessionID: SESSION_ID,
      part: { callID: CALL_ID, tool: 'glob', state: undefined },
    })
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('tool_call')
  })

  it('emits only tool_call when state has unknown status', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'tool_use',
      sessionID: SESSION_ID,
      part: { callID: CALL_ID, tool: 'glob', state: { status: 'running', input: {} } },
    })
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('tool_call')
  })

  it('emits nothing when part is absent', () => {
    const driver = makeDriver()
    expect(parse(driver, { type: 'tool_use', sessionID: SESSION_ID })).toHaveLength(0)
  })

  it('falls back to "tool" as name when part.tool is absent', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'tool_use',
      sessionID: SESSION_ID,
      part: { callID: CALL_ID, state: { status: 'completed', input: {}, output: '' } },
    })
    expect(events[0].content).toBe('tool')
    expect(events[0].metadata?.name).toBe('tool')
  })

  it('falls back to part.id for tool_use_id when callID is absent', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'tool_use',
      sessionID: SESSION_ID,
      part: {
        id: PART_ID,
        tool: 'read',
        state: { status: 'completed', input: {}, output: 'content' },
      },
    })
    const call = events.find(e => e.type === 'tool_call')
    const result = events.find(e => e.type === 'tool_result')
    expect(call?.metadata?.id).toBe(PART_ID)
    expect(result?.metadata?.tool_use_id).toBe(PART_ID)
  })
})

// ── tool_call metadata does not contain state output ─────────────────────────

describe('tool_call metadata isolation', () => {
  it('does not include state (or output) inside tool_call metadata', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'tool_use',
      sessionID: SESSION_ID,
      part: {
        callID: CALL_ID,
        tool: 'read',
        state: {
          status: 'completed',
          input: { filePath: 'big-file.txt' },
          output: 'A'.repeat(10_000),
          title: 'Read',
          metadata: {},
        },
      },
    })
    const callMeta = events[0].metadata as Record<string, unknown>
    // state should NOT be present in tool_call metadata — only name, input, type, id
    expect(callMeta.state).toBeUndefined()
    expect(callMeta.name).toBe('read')
    expect(callMeta.input).toEqual({ filePath: 'big-file.txt' })
  })
})

// ── error events ──────────────────────────────────────────────────────────────

describe('parseOpenCodeEvent — error', () => {
  it('emits error event from error.message object', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'error',
      sessionID: SESSION_ID,
      error: { message: 'rate limit exceeded', code: 429 },
    })
    expect(events).toEqual([{ type: 'error', content: 'rate limit exceeded' }])
  })

  it('emits error event from a plain string error field', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'error',
      sessionID: SESSION_ID,
      error: 'context window exceeded',
    })
    expect(events).toEqual([{ type: 'error', content: 'context window exceeded' }])
  })

  it('emits generic message when error field is absent', () => {
    const driver = makeDriver()
    const events = parse(driver, { type: 'error', sessionID: SESSION_ID })
    expect(events[0].type).toBe('error')
    expect(events[0].content).toBe('Unknown OpenCode error')
  })
})

// ── no-op events ──────────────────────────────────────────────────────────────

describe('parseOpenCodeEvent — no-ops', () => {
  it('emits nothing for step_start', () => {
    const driver = makeDriver()
    expect(parse(driver, {
      type: 'step_start',
      sessionID: SESSION_ID,
      timestamp: 1771739471944,
      part: { id: PART_ID },
    })).toHaveLength(0)
  })

  it('emits nothing for step_finish', () => {
    const driver = makeDriver()
    expect(parse(driver, {
      type: 'step_finish',
      sessionID: SESSION_ID,
      timestamp: 1771739473033,
      part: { id: PART_ID },
    })).toHaveLength(0)
  })

  it('emits nothing for reasoning', () => {
    const driver = makeDriver()
    expect(parse(driver, {
      type: 'reasoning',
      sessionID: SESSION_ID,
      part: { type: 'reasoning', text: 'I should read the file first.' },
    })).toHaveLength(0)
  })

  it('emits nothing for unknown event types', () => {
    const driver = makeDriver()
    expect(parse(driver, { type: 'future.unknown.event', sessionID: SESSION_ID })).toHaveLength(0)
  })
})

// ── Full turn sequences (feed) ────────────────────────────────────────────────

describe('full turn sequences', () => {
  it('processes the observed first turn ("you working?") correctly', () => {
    // Reconstructed from real log: step_start → text → step_finish
    const driver = makeDriver()
    const lines = [
      JSON.stringify({ type: 'step_start', sessionID: SESSION_ID, timestamp: 1771739439637, part: { id: 'prt_step1' } }),
      JSON.stringify({ type: 'text', sessionID: SESSION_ID, timestamp: 1771739439776, part: { id: 'prt_text1', type: 'text', text: 'Yes, I am working!' } }),
      JSON.stringify({ type: 'step_finish', sessionID: SESSION_ID, timestamp: 1771739440049, part: { id: 'prt_step1' } }),
    ].join('\n')

    const events = feed(driver, lines)

    expect(events.filter(e => e.type === 'text')).toEqual([{ type: 'text', content: 'Yes, I am working!' }])
    expect(events.filter(e => e.type === 'tool_call')).toHaveLength(0)
    expect((driver as any).sessionId).toBe(SESSION_ID)
  })

  it('processes the observed second turn (two reads + text) correctly', () => {
    // Reconstructed from real logs:
    // step_start → tool_use(read) → step_finish → step_start → tool_use(read) → step_finish → step_start → text → step_finish
    const driver = makeDriver({ initialSessionId: SESSION_ID })
    const lines = [
      JSON.stringify({ type: 'step_start', sessionID: SESSION_ID, timestamp: 1771739471944, part: { id: 'prt_s1' } }),
      JSON.stringify({
        type: 'tool_use', sessionID: SESSION_ID, timestamp: 1771739472894,
        part: { id: 'prt_t1', sessionID: SESSION_ID, messageID: 'msg_1', type: 'tool', callID: 'call_read1', tool: 'read', state: { status: 'completed', input: { filePath: 'peanut-poem.txt' }, output: 'Peanuts are great\n', title: 'Read peanut-poem.txt', metadata: {}, time: { start: 1771739472000, end: 1771739473000 } } },
      }),
      JSON.stringify({ type: 'step_finish', sessionID: SESSION_ID, timestamp: 1771739473033, part: { id: 'prt_s1' } }),
      JSON.stringify({ type: 'step_start', sessionID: SESSION_ID, timestamp: 1771739475149, part: { id: 'prt_s2' } }),
      JSON.stringify({
        type: 'tool_use', sessionID: SESSION_ID, timestamp: 1771739475634,
        part: { id: 'prt_t2', sessionID: SESSION_ID, messageID: 'msg_2', type: 'tool', callID: 'call_read2', tool: 'read', state: { status: 'completed', input: { filePath: 'peanut-poem.txt' }, output: 'Peanuts are great\n', title: 'Read peanut-poem.txt', metadata: {}, time: { start: 1771739475000, end: 1771739476000 } } },
      }),
      JSON.stringify({ type: 'step_finish', sessionID: SESSION_ID, timestamp: 1771739475744, part: { id: 'prt_s2' } }),
      JSON.stringify({ type: 'step_start', sessionID: SESSION_ID, timestamp: 1771739477608, part: { id: 'prt_s3' } }),
      JSON.stringify({ type: 'text', sessionID: SESSION_ID, timestamp: 1771739480735, part: { id: 'prt_text', type: 'text', text: "I love peanuts!" } }),
      JSON.stringify({ type: 'step_finish', sessionID: SESSION_ID, timestamp: 1771739480862, part: { id: 'prt_s3' } }),
    ].join('\n')

    const events = feed(driver, lines)
    const toolCalls = events.filter(e => e.type === 'tool_call')
    const toolResults = events.filter(e => e.type === 'tool_result')
    const texts = events.filter(e => e.type === 'text')

    expect(toolCalls).toHaveLength(2)
    expect(toolResults).toHaveLength(2)
    expect(texts).toHaveLength(1)
    expect(texts[0].content).toBe('I love peanuts!')

    // tool_result IDs pair correctly with their tool_calls
    expect(toolResults[0].metadata?.tool_use_id).toBe('call_read1')
    expect(toolResults[1].metadata?.tool_use_id).toBe('call_read2')
  })

  it('handles chunks split across newlines correctly', () => {
    // Simulate stdout arriving in two chunks mid-line
    const driver = makeDriver()
    const fullLine = JSON.stringify({ type: 'text', sessionID: SESSION_ID, part: { type: 'text', text: 'split message' } })
    const half1 = fullLine.slice(0, Math.floor(fullLine.length / 2))
    const half2 = fullLine.slice(Math.floor(fullLine.length / 2))

    const events: OutputEvent[] = []
    const onEvent = (e: OutputEvent) => events.push(e)

    // First chunk: no newline → nothing emitted yet
    ;(driver as any).buffer = half1
    ;(driver as any).processBuffer(onEvent)
    expect(events).toHaveLength(0)

    // Second chunk: completes the line → event emitted
    ;(driver as any).buffer += half2 + '\n'
    ;(driver as any).processBuffer(onEvent)
    expect(events).toHaveLength(1)
    expect(events[0].content).toBe('split message')
  })

  it('silently skips non-JSON lines', () => {
    const driver = makeDriver()
    const lines = [
      'not json at all',
      JSON.stringify({ type: 'text', sessionID: SESSION_ID, part: { type: 'text', text: 'valid' } }),
      '{broken json',
    ].join('\n')
    const events = feed(driver, lines)
    expect(events.filter(e => e.type === 'text')).toHaveLength(1)
    expect(events[0].content).toBe('valid')
  })
})
