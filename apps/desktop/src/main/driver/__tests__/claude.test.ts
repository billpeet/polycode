import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { ClaudeDriver } from '../claude'
import type { DriverOptions } from '../types'
import type { OutputEvent } from '../../../shared/types'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}))

function makeDriver(opts: Partial<DriverOptions> = {}): ClaudeDriver {
  return new ClaudeDriver({
    workingDir: '/tmp/test',
    threadId: 'test-thread',
    ...opts,
  })
}

const BASE_ENV = process.env

beforeEach(() => {
  process.env = BASE_ENV
  queryMock.mockReset()
})

afterEach(() => {
  process.env = BASE_ENV
})

describe('ClaudeDriver permission mode', () => {
  it('uses default mode by default', () => {
    const driver = makeDriver()
    expect((driver as any).resolvePermissionMode({})).toBe('default')
  })

  it('uses bypassPermissions in yolo mode', () => {
    const driver = makeDriver()
    expect((driver as any).resolvePermissionMode({ yoloMode: true })).toBe('bypassPermissions')
  })

  it('uses plan mode when requested', () => {
    const driver = makeDriver()
    expect((driver as any).resolvePermissionMode({ planMode: true, yoloMode: true })).toBe('plan')
  })
})

describe('ClaudeDriver permission control flow', () => {
  it('emits permission_request and resolves when approved', async () => {
    const driver = makeDriver()
    const events: OutputEvent[] = []
    ;(driver as any).currentTurn = {
      onEvent: (event: OutputEvent) => events.push(event),
      onDone: () => {},
    }

    const promise = (driver as any).handleCanUseTool(
      'Write',
      { file_path: 'src/app.ts' },
      { signal: new AbortController().signal, toolUseID: 'tool-123' },
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: 'permission_request',
      content: 'Write',
      metadata: {
        type: 'permission_request',
        requestId: 'permission:tool-123',
        toolName: 'Write',
        toolInput: { file_path: 'src/app.ts' },
        toolUseId: 'tool-123',
      },
    })

    driver.sendControlResponse('permission:tool-123', 'allow')
    await expect(promise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { file_path: 'src/app.ts' },
    })
  })

  it('auto-approves tool use when both plan mode and yolo mode are enabled', async () => {
    const driver = makeDriver()
    ;(driver as any).currentMessageOptions = { planMode: true, yoloMode: true }

    await expect(
      (driver as any).handleCanUseTool(
        'Write',
        { file_path: 'src/app.ts' },
        { signal: new AbortController().signal, toolUseID: 'tool-789' },
      )
    ).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { file_path: 'src/app.ts' },
    })
  })

  it('emits question events and resolves with structured answers', async () => {
    const driver = makeDriver()
    const events: OutputEvent[] = []
    ;(driver as any).currentTurn = {
      onEvent: (event: OutputEvent) => events.push(event),
      onDone: () => {},
    }

    const promise = (driver as any).handleCanUseTool(
      'AskUserQuestion',
      {
        questions: [
          {
            header: 'Sandbox',
            question: 'Which mode should be used?',
            options: [{ label: 'Workspace', description: 'Scoped writes' }],
          },
        ],
      },
      { signal: new AbortController().signal, toolUseID: 'tool-456' },
    )

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('question')
    expect(events[0]?.metadata?.requestId).toBe('question:tool-456')

    driver.answerQuestion?.('question:tool-456', { Sandbox: 'Workspace' })
    await expect(promise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: [
          {
            header: 'Sandbox',
            question: 'Which mode should be used?',
            options: [{ label: 'Workspace', description: 'Scoped writes' }],
          },
        ],
        answers: { Sandbox: 'Workspace' },
      },
    })
  })
})

describe('ClaudeDriver query configuration', () => {
  it('launches plan-mode yolo sessions with dangerous skip permissions allowed for later approval', async () => {
    let capturedInput: any
    const fakeQuery = {
      setPermissionMode: async () => {},
      setModel: async () => {},
      interrupt: async () => {},
      close: () => {},
      [Symbol.asyncIterator]: async function* () {},
    }

    queryMock.mockImplementation((input: any) => {
      capturedInput = input
      return fakeQuery
    })

    process.env = {
      ...BASE_ENV,
      CLAUDE_CODE_PATH: '/tmp/custom-claude',
    }

    const driver = makeDriver()
    ;(driver as any).currentMessageOptions = { planMode: true, yoloMode: true }

    await (driver as any).ensureQuery()

    expect(capturedInput).toBeDefined()
    expect(capturedInput.options.permissionMode).toBe('plan')
    expect(capturedInput.options.allowDangerouslySkipPermissions).toBe(true)
  })

  it('uses the system claude binary and adds the working directory to additionalDirectories', async () => {
    let capturedInput: any
    const fakeQuery = {
      setPermissionMode: async () => {},
      setModel: async () => {},
      interrupt: async () => {},
      close: () => {},
      [Symbol.asyncIterator]: async function* () {},
    }

    queryMock.mockImplementation((input: any) => {
      capturedInput = input
      return fakeQuery
    })

    process.env = {
      ...BASE_ENV,
      CLAUDE_CODE_PATH: '/tmp/custom-claude',
    }

    const driver = makeDriver({ model: 'claude-sonnet-4-6' })

    await (driver as any).ensureQuery()

    expect(capturedInput).toBeDefined()
    expect(capturedInput.options.model).toBe('claude-sonnet-4-6')
    expect(capturedInput.options.cwd).toBe('/tmp/test')
    expect(capturedInput.options.pathToClaudeCodeExecutable).toBe('/tmp/custom-claude')
    expect(capturedInput.options.additionalDirectories).toEqual(['/tmp/test'])
    expect(capturedInput.options.settingSources).toEqual(['user', 'project', 'local'])
  })

  it('expands ~ in the working directory before passing it to the SDK', async () => {
    let capturedInput: any
    const fakeQuery = {
      setPermissionMode: async () => {},
      setModel: async () => {},
      interrupt: async () => {},
      close: () => {},
      [Symbol.asyncIterator]: async function* () {},
    }

    queryMock.mockImplementation((input: any) => {
      capturedInput = input
      return fakeQuery
    })

    process.env = {
      ...BASE_ENV,
      HOME: '/tmp/home',
      CLAUDE_CODE_PATH: '/tmp/custom-claude',
    }

    const driver = makeDriver({ workingDir: '~/repo' })

    await (driver as any).ensureQuery()

    expect(capturedInput.options.cwd).toBe('/tmp/home/repo')
    expect(capturedInput.options.additionalDirectories).toEqual(['/tmp/home/repo'])
    expect(capturedInput.options.settingSources).toEqual(['user', 'project', 'local'])
  })
})

describe('ClaudeDriver live input', () => {
  it('keeps the turn open until queued injected prompts are finished', async () => {
    const driver = makeDriver()
    const done = vi.fn(() => {})

    ;(driver as any).currentTurn = {
      onEvent: () => {},
      onDone: done,
    }
    ;(driver as any).queuedTurnCount = 1
    ;(driver as any).query = {
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'result', subtype: 'success' }
        yield { type: 'result', subtype: 'success' }
      },
    }

    await (driver as any).consumeStream()

    expect(done).toHaveBeenCalledTimes(1)
    expect((driver as any).queuedTurnCount).toBe(0)
    expect((driver as any).currentTurn).toBeNull()
  })

  it('emits Claude task progress as thinking updates', async () => {
    const driver = makeDriver()
    const events: OutputEvent[] = []
    const done = vi.fn(() => {})

    ;(driver as any).currentTurn = {
      onEvent: (event: OutputEvent) => events.push(event),
      onDone: done,
    }
    ;(driver as any).query = {
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: 'system',
          subtype: 'task_started',
          task_id: 'task-1',
          tool_use_id: 'tool-task-1',
          description: 'Review the database layer',
          subagent_type: 'code-reviewer',
          session_id: 'sdk-session',
          uuid: 'task-started-1',
        }
        yield {
          type: 'system',
          subtype: 'task_progress',
          task_id: 'task-1',
          tool_use_id: 'tool-task-1',
          description: 'Review the database layer',
          summary: 'Checked migration edge cases.',
          subagent_type: 'code-reviewer',
          usage: { total_tokens: 123, tool_uses: 4, duration_ms: 987 },
          last_tool_name: 'Grep',
          session_id: 'sdk-session',
          uuid: 'task-progress-1',
        }
        yield { type: 'result', subtype: 'success' }
      },
    }

    await (driver as any).consumeStream()

    expect(events.filter((event) => event.type === 'thinking')).toHaveLength(2)
    expect(events[0]?.content).toContain('Subagent started')
    expect(events[1]?.content).toContain('Checked migration edge cases.')
    expect(events[1]?.metadata?.source).toBe('claude_task')
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('keeps the turn open after a result while Claude background tasks are active', async () => {
    const driver = makeDriver()
    const events: OutputEvent[] = []
    const done = vi.fn(() => {})

    ;(driver as any).currentTurn = {
      onEvent: (event: OutputEvent) => events.push(event),
      onDone: done,
    }
    ;(driver as any).query = {
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: 'system',
          subtype: 'task_started',
          task_id: 'task-1',
          tool_use_id: 'tool-task-1',
          description: 'Security audit',
          subagent_type: 'general-purpose',
          session_id: 'sdk-session',
          uuid: 'task-started-1',
        }
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          modelUsage: {},
          session_id: 'sdk-session',
          uuid: 'result-1',
        }
        expect(done).not.toHaveBeenCalled()

        yield {
          type: 'system',
          subtype: 'task_progress',
          task_id: 'task-1',
          tool_use_id: 'tool-task-1',
          description: 'Security audit',
          summary: 'Still checking IPC.',
          usage: { total_tokens: 123, tool_uses: 4, duration_ms: 987 },
          last_tool_name: 'Read',
          session_id: 'sdk-session',
          uuid: 'task-progress-1',
        }
        expect(done).not.toHaveBeenCalled()

        yield {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'task-1',
          tool_use_id: 'tool-task-1',
          status: 'completed',
          output_file: 'task-1.md',
          summary: 'Security audit complete.',
          session_id: 'sdk-session',
          uuid: 'task-notification-1',
        }
        expect(done).not.toHaveBeenCalled()

        yield {
          type: 'system',
          subtype: 'session_state_changed',
          state: 'idle',
          session_id: 'sdk-session',
          uuid: 'idle-1',
        }
      },
    }

    await (driver as any).consumeStream()

    expect(done).toHaveBeenCalledTimes(1)
    expect(done.mock.calls[0]?.[0]).toBeUndefined()
    expect(events.some((event) => event.content.includes('Still checking IPC.'))).toBe(true)
    expect(events.some((event) => event.content.includes('Security audit complete.'))).toBe(true)
  })

  it('completes a turn on Claude idle state when no result frame arrives', async () => {
    const driver = makeDriver()
    const done = vi.fn(() => {})

    ;(driver as any).currentTurn = {
      onEvent: () => {},
      onDone: done,
    }
    ;(driver as any).query = {
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: 'system',
          subtype: 'session_state_changed',
          state: 'idle',
          session_id: 'sdk-session',
          uuid: 'idle-1',
        }
      },
    }

    await (driver as any).consumeStream()

    expect(done).toHaveBeenCalledTimes(1)
    expect(done.mock.calls[0]?.[0]).toBeUndefined()
    expect((driver as any).currentTurn).toBeNull()
    expect((driver as any).query).toBeNull()
  })

  it('fails a running turn when the Claude stream ends without result or idle state', async () => {
    const driver = makeDriver()
    const done = vi.fn(() => {})

    ;(driver as any).currentTurn = {
      onEvent: () => {},
      onDone: done,
    }
    ;(driver as any).query = {
      [Symbol.asyncIterator]: async function* () {},
    }

    await (driver as any).consumeStream()

    expect(done).toHaveBeenCalledTimes(1)
    expect(done.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    expect(String(done.mock.calls[0]?.[0]?.message)).toContain('ended before a result')
    expect((driver as any).currentTurn).toBeNull()
    expect((driver as any).query).toBeNull()
  })
})
