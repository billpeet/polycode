import { describe, it, expect, mock } from 'bun:test'
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

function makeActiveTurn(driver: PiDriver, onEvent = () => {}, onDone = () => {}): void {
  ;(driver as any).currentTurn = { onEvent, onDone }
}

describe('buildPiArgs', () => {
  it('builds a new session command', () => {
    expect(buildPiArgs(null, undefined)).toEqual([
      '--mode', 'rpc',
    ])
  })

  it('builds a resume command with model selection', () => {
    expect(buildPiArgs('abc123', 'openai-codex/gpt-5.4')).toEqual([
      '--mode', 'rpc', '--session', 'abc123', '--model', 'openai-codex/gpt-5.4',
    ])
  })
})

describe('PiDriver command transport', () => {
  it('keeps stdin open for RPC mode', () => {
    const driver = makeDriver({ model: 'openai-codex/gpt-5.4' })
    const command = (driver as any).buildCommand()

    expect(command).toEqual({
      binary: 'pi',
      args: ['--mode', 'rpc', '--model', 'openai-codex/gpt-5.4'],
      workDir: '/tmp/test',
      keepStdinOpen: true,
    })
  })
})

describe('PiDriver RPC control', () => {
  it('injects follow-up user input via steer', async () => {
    const driver = makeDriver()
    const sendRequest = mock(async () => ({ type: 'response', command: 'steer', success: true }))
    ;(driver as any).sendRequest = sendRequest
    makeActiveTurn(driver)

    driver.injectMessage('change direction')
    await Promise.resolve()

    expect(sendRequest).toHaveBeenCalledWith('steer', { type: 'steer', message: 'change direction' })
  })

  it('stops by sending abort before killing the process', async () => {
    const driver = makeDriver()
    const sendRequest = mock(async () => ({ type: 'response', command: 'abort', success: true }))
    ;(driver as any).sendRequest = sendRequest
    ;(driver as any).process = { stdin: { writable: true } }

    driver.stop()
    await Promise.resolve()

    expect(sendRequest).toHaveBeenCalledWith('abort', { type: 'abort' }, 10_000)
  })
})

describe('PiDriver session capture', () => {
  it('captures the session id from RPC get_state', async () => {
    let captured: string | undefined
    const driver = makeDriver({ onSessionId: (id) => { captured = id } })

    const sendRequest = mock(async () => ({
      type: 'response',
      command: 'get_state',
      success: true,
      data: { sessionId: 'pi-session-1' },
    }))
    ;(driver as any).sendRequest = sendRequest
    ;(driver as any).process = { stdout: { on() {} }, stderr: { on() {} }, on() {}, stdin: { writable: true, write() {} } }
    ;(driver as any).readyPromise = Promise.resolve()

    await (driver as any).ensureReady()

    expect(captured).toBeUndefined()

    ;(driver as any).readyPromise = null
    ;(driver as any).process = null
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
    makeActiveTurn(driver, (event) => events.push(event))

    ;(driver as any).buffer = `not json\n${validLine.slice(0, half)}`
    ;(driver as any).processBuffer()
    expect(events).toHaveLength(0)

    ;(driver as any).buffer += `${validLine.slice(half)}\n`
    ;(driver as any).processBuffer()
    expect(events).toEqual([{ type: 'text', content: 'split message' } satisfies OutputEvent])
  })

  it('routes responses to pending requests and events to the active turn', async () => {
    const driver = makeDriver()
    const events: OutputEvent[] = []
    makeActiveTurn(driver, (event) => events.push(event))

    let resolved: Record<string, unknown> | null = null
    ;(driver as any).pending.set('pi-1', {
      resolve: (value: Record<string, unknown>) => { resolved = value },
      reject: () => {},
      timeout: setTimeout(() => {}, 1000),
    })

    ;(driver as any).buffer = [
      JSON.stringify({ id: 'pi-1', type: 'response', command: 'prompt', success: true }),
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } }),
    ].join('\n') + '\n'

    ;(driver as any).processBuffer()

    expect(resolved).toEqual({ id: 'pi-1', type: 'response', command: 'prompt', success: true })
    expect(events).toEqual([{ type: 'text', content: 'done' } satisfies OutputEvent])
  })

  it('finishes the active turn on agent_end', () => {
    const driver = makeDriver()
    const done = mock(() => {})
    makeActiveTurn(driver, () => {}, done)

    ;(driver as any).buffer = `${JSON.stringify({ type: 'agent_end', messages: [] })}\n`
    ;(driver as any).processBuffer()

    expect(done).toHaveBeenCalledTimes(1)
    expect((driver as any).currentTurn).toBeNull()
  })
})
