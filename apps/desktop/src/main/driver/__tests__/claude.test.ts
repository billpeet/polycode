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

  it('uses Claude auto mode when requested', () => {
    const driver = makeDriver()
    expect((driver as any).resolvePermissionMode({ permissionMode: 'auto' })).toBe('auto')
  })

  it('falls back to the driver-level permission mode for auto', () => {
    const driver = makeDriver({ permissionMode: 'auto' })
    expect((driver as any).resolvePermissionMode({})).toBe('auto')
  })

  it('yolo and plan take precedence over auto', () => {
    const driver = makeDriver()
    expect((driver as any).resolvePermissionMode({ permissionMode: 'auto', yoloMode: true })).toBe('bypassPermissions')
    expect((driver as any).resolvePermissionMode({ permissionMode: 'auto', planMode: true })).toBe('plan')
  })

  it('uses plan mode when requested', () => {
    const driver = makeDriver()
    expect((driver as any).resolvePermissionMode({ planMode: true, yoloMode: true })).toBe('plan')
  })
})

describe('ClaudeDriver context usage', () => {
  it('emits the provider-reported context limit with result usage', () => {
    const driver = makeDriver()
    const events = (driver as any).parseMessage({
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 70,
      },
      total_cost_usd: 0.0123,
      modelUsage: { 'claude-test': { contextWindow: 1_000_000 } },
    })

    expect(events).toEqual([{
      type: 'usage',
      content: '',
      metadata: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 200,
        cost_usd: 0.0123,
        context_window: 200,
        max_context_window: 1_000_000,
      },
    }])
  })

  it('clears the live context snapshot when compaction starts', () => {
    const driver = makeDriver()
    expect((driver as any).parseMessage({
      type: 'system',
      subtype: 'status',
      status: 'compacting',
    })).toEqual([
      { type: 'usage', content: '', metadata: { input_tokens: 0, output_tokens: 0, context_window: 0 } },
      {
        type: 'thinking',
        content: 'Compacting conversation context...',
        metadata: { type: 'thinking', source: 'claude_status', status: 'compacting' },
      },
    ])
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

  it('launches auto-mode sessions without dangerous skip permissions', async () => {
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

    const driver = makeDriver()
    ;(driver as any).currentMessageOptions = { permissionMode: 'auto' }

    await (driver as any).ensureQuery()

    expect(capturedInput).toBeDefined()
    expect(capturedInput.options.permissionMode).toBe('auto')
    expect(capturedInput.options.allowDangerouslySkipPermissions).toBe(false)
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

  it('keeps the turn running when Claude returns success while subagents are still running', async () => {
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
          subtype: 'task_notification',
          task_id: 'task-1',
          tool_use_id: 'tool-task-1',
          status: 'completed',
          summary: 'Security audit complete',
          session_id: 'sdk-session',
          uuid: 'task-completed-1',
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
    expect((driver as any).activeBackgroundTaskIds.size).toBe(0)
  })

  it('reports a detached shell command as a background command, not a sub-agent', async () => {
    // Claude detaches any Bash call that outruns its foreground timeout and
    // reports it through the same task_* frames as a real sub-agent. Stamping
    // those with subagent scope made the renderer group them as conversational
    // participants — the thread view grew a tab labelled with the raw grep.
    const driver = makeDriver()
    const events: OutputEvent[] = []

    ;(driver as any).currentTurn = { onEvent: (e: OutputEvent) => events.push(e), onDone: () => {} }
    ;(driver as any).query = {
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: 'system',
          subtype: 'task_started',
          task_id: 'a32995dc9ab170fe7',
          tool_use_id: 'toolu_agent',
          task_type: 'local_agent',
          subagent_type: 'general-purpose',
          description: 'Review port-forward.ts',
          session_id: 'sdk-session',
          uuid: 'task-started-agent',
        }
        yield {
          type: 'system',
          subtype: 'task_started',
          task_id: 'bbycjq409',
          tool_use_id: 'toolu_bash',
          task_type: 'local_bash',
          description: 'grep -rn "port-forward" --include=*.ts .',
          session_id: 'sdk-session',
          uuid: 'task-started-bash',
        }
        yield { type: 'result', subtype: 'success', usage: {}, modelUsage: {}, session_id: 'sdk-session', uuid: 'r' }
        yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: 'sdk-session', uuid: 'i' }
      },
    }

    await (driver as any).consumeStream()

    const [agentEvent, commandEvent] = events
    // The real sub-agent keeps subagent scope, so it still gets its own group.
    expect(agentEvent.metadata?.agent_scope).toBe('subagent')
    expect(agentEvent.metadata?.agent_subagent_type).toBe('general-purpose')
    expect(agentEvent.content).toContain('Subagent started')

    // The detached command must not be scoped as a participant: messageParentKey
    // returns null for anything not scoped 'subagent', which is what keeps it
    // out of the tab strip.
    expect(commandEvent.metadata?.agent_scope).toBe('main')
    expect(commandEvent.metadata?.agent_parent_tool_use_id).toBeUndefined()
    expect(commandEvent.metadata?.task_kind).toBe('command')
    expect(commandEvent.content).toContain('Background command started')
    expect(commandEvent.content).not.toContain('Subagent')
  })

  it('completes the turn on idle even when a background task never reports back', async () => {
    // Regression: a Bash command detached after its 120s timeout, an endless
    // watch loop, or a subagent killed with its parent shell never emits a
    // terminal task_notification. Gating the idle frame on that set pinned the
    // turn open indefinitely and PolyCode reported the Thread as still running.
    const driver = makeDriver()
    const done = vi.fn(() => {})

    ;(driver as any).currentTurn = { onEvent: () => {}, onDone: done }
    ;(driver as any).query = {
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: 'system',
          subtype: 'task_started',
          task_id: 'orphan-1',
          tool_use_id: 'tool-orphan-1',
          description: 'Open the design schedule Gantt via dev login',
          task_type: 'local_bash',
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
        // No task_notification for orphan-1 — it never reports back.
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
    // The task stays tracked: it is detached, not finished, and Run cleanup
    // must still see it.
    expect((driver as any).hasLiveBackgroundWork()).toBe(true)
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
