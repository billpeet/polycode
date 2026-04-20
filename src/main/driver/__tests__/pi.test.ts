import { describe, it, expect } from 'bun:test'
import { PiDriver, buildPiArgs } from '../pi'
import type { OutputEvent } from '../../../shared/types'
import type { DriverOptions } from '../types'

function makeDriver(opts: Partial<DriverOptions> = {}): PiDriver {
  return new PiDriver({
    workingDir: '/tmp/test',
    threadId: 'test-thread',
    ...opts,
  })
}

function parse(driver: PiDriver, data: Record<string, unknown>): OutputEvent[] {
  return (driver as any).parseEvent(data)
}

function feed(driver: PiDriver, jsonl: string): OutputEvent[] {
  const events: OutputEvent[] = []
  ;(driver as any).buffer = jsonl + '\n'
  ;(driver as any).processBuffer((event: OutputEvent) => events.push(event))
  return events
}

describe('buildPiArgs', () => {
  it('builds a new session command', () => {
    expect(buildPiArgs(null, undefined)).toEqual([
      '--mode', 'json',
    ])
  })

  it('builds a resume command with model selection', () => {
    expect(buildPiArgs('abc123', 'openai-codex/gpt-5.4')).toEqual([
      '--mode', 'json', '--session', 'abc123', '--model', 'openai-codex/gpt-5.4',
    ])
  })
})

describe('PiDriver command transport', () => {
  it('sends the prompt via stdin instead of argv', () => {
    const driver = makeDriver({ model: 'openai-codex/gpt-5.4' })
    const command = (driver as any).buildCommand('line 1\nline 2', 'local', {})

    expect(command).toEqual({
      binary: 'pi',
      args: ['--mode', 'json', '--model', 'openai-codex/gpt-5.4'],
      workDir: '/tmp/test',
      stdinContent: 'line 1\nline 2',
    })
  })
})

describe('PiDriver session capture', () => {
  it('captures the session id from the session header', () => {
    let captured: string | undefined
    const driver = makeDriver({ onSessionId: (id) => { captured = id } })

    expect(parse(driver, { type: 'session', id: 'pi-session-1' })).toEqual([])
    expect(captured).toBe('pi-session-1')
    expect((driver as any).sessionId).toBe('pi-session-1')
  })

  it('does not re-emit onSessionId when initialSessionId is already present', () => {
    let count = 0
    const driver = makeDriver({
      initialSessionId: 'pi-session-1',
      onSessionId: () => { count++ },
    })

    parse(driver, { type: 'session', id: 'pi-session-1' })
    expect(count).toBe(0)
  })
})

describe('PiDriver event parsing', () => {
  it('emits assistant text deltas', () => {
    const driver = makeDriver()
    expect(parse(driver, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello world' },
    })).toEqual([{ type: 'text', content: 'hello world' } satisfies OutputEvent])
  })

  it('emits thinking deltas', () => {
    const driver = makeDriver()
    expect(parse(driver, {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking...' },
    })).toEqual([{ type: 'thinking', content: 'thinking...', metadata: { type: 'thinking' } } satisfies OutputEvent])
  })

  it('maps tool execution lifecycle to tool_call/tool_result', () => {
    const driver = makeDriver()

    const started = parse(driver, {
      type: 'tool_execution_start',
      toolCallId: 'tool_1',
      toolName: 'bash',
      args: { command: 'ls -la' },
    })
    const ended = parse(driver, {
      type: 'tool_execution_end',
      toolCallId: 'tool_1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'file1\nfile2' }] },
      isError: false,
    })

    expect(started).toEqual([
      {
        type: 'tool_call',
        content: 'bash',
        metadata: { type: 'tool_call', id: 'tool_1', name: 'bash', input: { command: 'ls -la' } },
      } satisfies OutputEvent,
    ])
    expect(ended).toEqual([
      {
        type: 'tool_result',
        content: 'file1\nfile2',
        metadata: { type: 'tool_result', tool_use_id: 'tool_1', is_error: false },
      } satisfies OutputEvent,
    ])
  })

  it('emits usage from turn_end message usage', () => {
    const driver = makeDriver()
    expect(parse(driver, {
      type: 'turn_end',
      message: {
        usage: { input: 12, output: 4 },
      },
    })).toEqual([
      {
        type: 'usage',
        content: '',
        metadata: { input_tokens: 12, output_tokens: 4, context_window: 16 },
      } satisfies OutputEvent,
    ])
  })

  it('emits turn_end errors for failed assistant messages', () => {
    const driver = makeDriver()
    expect(parse(driver, {
      type: 'turn_end',
      message: {
        stopReason: 'error',
        errorMessage: 'provider failed',
      },
    })).toEqual([
      { type: 'error', content: 'provider failed' } satisfies OutputEvent,
    ])
  })

  it('ignores unsupported event types', () => {
    const driver = makeDriver()
    expect(parse(driver, { type: 'queue_update' })).toEqual([])
  })
})

describe('PiDriver JSONL buffering', () => {
  it('handles split stdout chunks and skips invalid lines', () => {
    const driver = makeDriver()
    const validLine = JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'split message' },
    })
    const half = Math.floor(validLine.length / 2)
    const events: OutputEvent[] = []

    ;(driver as any).buffer = `not json\n${validLine.slice(0, half)}`
    ;(driver as any).processBuffer((event: OutputEvent) => events.push(event))
    expect(events).toHaveLength(0)

    ;(driver as any).buffer += `${validLine.slice(half)}\n`
    ;(driver as any).processBuffer((event: OutputEvent) => events.push(event))
    expect(events).toEqual([{ type: 'text', content: 'split message' } satisfies OutputEvent])
  })

  it('processes a mixed JSONL turn sequence', () => {
    const driver = makeDriver()
    const lines = [
      JSON.stringify({ type: 'session', id: 'pi-session-1' }),
      JSON.stringify({ type: 'tool_execution_start', toolCallId: 'tool_1', toolName: 'read', args: { filePath: 'README.md' } }),
      JSON.stringify({ type: 'tool_execution_end', toolCallId: 'tool_1', toolName: 'read', result: { content: [{ type: 'text', text: 'hello' }] }, isError: false }),
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } }),
      JSON.stringify({ type: 'turn_end', message: { usage: { input: 8, output: 2 } } }),
    ].join('\n')

    expect(feed(driver, lines)).toEqual([
      {
        type: 'tool_call',
        content: 'read',
        metadata: { type: 'tool_call', id: 'tool_1', name: 'read', input: { filePath: 'README.md' } },
      } satisfies OutputEvent,
      {
        type: 'tool_result',
        content: 'hello',
        metadata: { type: 'tool_result', tool_use_id: 'tool_1', is_error: false },
      } satisfies OutputEvent,
      { type: 'text', content: 'done' } satisfies OutputEvent,
      {
        type: 'usage',
        content: '',
        metadata: { input_tokens: 8, output_tokens: 2, context_window: 10 },
      } satisfies OutputEvent,
    ])
  })
})
