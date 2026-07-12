import { beforeEach, describe, expect, it } from 'bun:test'
import path from 'path'
import {
  buildCodexEnvironment,
  buildCodexAppServerThreadParams,
  buildCodexSdkOptions,
  CodexDriver,
  buildCodexArgs,
  createCodexStreamState,
  parseBashCommand,
  parseCodexAppServerNotification,
  parseCodexSdkEvent,
  winQuote,
} from '../codex'
import type { DriverOptions } from '../types'
import type { OutputEvent } from '../../../shared/types'

function makeDriver(opts: Partial<DriverOptions> = {}): CodexDriver {
  return new CodexDriver({
    workingDir: '/tmp/test',
    threadId: 'thread-1',
    ...opts,
  })
}

describe('buildCodexArgs', () => {
  it('builds a new conversation command', () => {
    expect(buildCodexArgs(null, undefined, 'hello world')).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'on-request',
      'hello world',
    ])
  })

  it('builds a resume command with yolo mode', () => {
    expect(buildCodexArgs('session-123', 'gpt-5.5', 'continue', true)).toEqual([
      'exec',
      '--json',
      'resume',
      '--dangerously-bypass-approvals-and-sandbox',
      '-c',
      'model=gpt-5.5',
      'session-123',
      'continue',
    ])
  })

  it('adds the priority service tier when fast mode is enabled', () => {
    expect(buildCodexArgs(null, 'gpt-5.5', 'go fast', false, 'medium', true)).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'on-request',
      '-c',
      'model=gpt-5.5',
      '-c',
      'model_reasoning_effort=medium',
      '-c',
      'service_tier=fast',
      'go fast',
    ])
  })

  it('omits the service tier when fast mode is disabled', () => {
    expect(buildCodexArgs(null, undefined, 'normal', false, undefined, false)).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'on-request',
      'normal',
    ])
  })

  it('builds workspace-write permission mode args', () => {
    expect(buildCodexArgs(null, undefined, 'edit', 'workspace')).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      'edit',
    ])
  })
})

describe('winQuote', () => {
  it('leaves simple args unquoted', () => {
    expect(winQuote('exec')).toBe('exec')
    expect(winQuote('--json')).toBe('--json')
  })

  it('quotes args with spaces', () => {
    expect(winQuote('hello world')).toBe('"hello world"')
  })
})

describe('parseBashCommand', () => {
  it('unwraps bash -lc', () => {
    expect(parseBashCommand('/bin/bash -lc "ls -la"')).toEqual({
      name: 'Bash',
      innerCmd: 'ls -la',
    })
  })

  it('falls back to Shell for non-bash commands', () => {
    expect(parseBashCommand('pwsh.exe -Command ls')).toEqual({
      name: 'Shell',
      innerCmd: 'pwsh.exe -Command ls',
    })
  })
})

describe('parseCodexSdkEvent', () => {
  let state: ReturnType<typeof createCodexStreamState>

  beforeEach(() => {
    state = createCodexStreamState()
  })

  it('captures a thread id on thread.started', () => {
    let captured: string | undefined
    const events = parseCodexSdkEvent(
      { type: 'thread.started', thread_id: 'thr_123' },
      state,
      (id) => { captured = id }
    )
    expect(events).toHaveLength(0)
    expect(captured).toBe('thr_123')
  })

  it('streams agent text via item.updated and suppresses duplicate completion text', () => {
    const streaming = parseCodexSdkEvent(
      { type: 'item.updated', item: { id: 'item_1', type: 'agent_message', text: 'Hello ' } },
      state
    )
    const completion = parseCodexSdkEvent(
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Hello world' } },
      state
    )

    expect(streaming).toEqual([{ type: 'text', content: 'Hello ' } satisfies OutputEvent])
    expect(completion).toEqual([{ type: 'text', content: 'world' } satisfies OutputEvent])
  })

  it('emits a single tool_call when item.started is followed by item.completed', () => {
    const started = parseCodexSdkEvent(
      {
        type: 'item.started',
        item: {
          id: 'item_cmd',
          type: 'command_execution',
          command: '/bin/bash -lc "ls -la"',
          aggregated_output: '',
          status: 'in_progress',
        },
      },
      state
    )
    const completed = parseCodexSdkEvent(
      {
        type: 'item.completed',
        item: {
          id: 'item_cmd',
          type: 'command_execution',
          command: '/bin/bash -lc "ls -la"',
          aggregated_output: 'file1\nfile2',
          exit_code: 0,
          status: 'completed',
        },
      },
      state
    )

    expect(started).toHaveLength(1)
    expect(started[0].type).toBe('tool_call')
    expect(started[0].content).toBe('ls -la')

    expect(completed).toHaveLength(1)
    expect(completed[0].type).toBe('tool_result')
    expect(completed[0].content).toBe('file1\nfile2')
    expect(completed[0].metadata?.tool_use_id).toBe('item_cmd')
  })

  it('maps todo_list items into tool events with items metadata', () => {
    const started = parseCodexSdkEvent(
      {
        type: 'item.started',
        item: {
          id: 'todo_1',
          type: 'todo_list',
          items: [{ text: 'Ship it', completed: false }],
        },
      },
      state
    )
    const completed = parseCodexSdkEvent(
      {
        type: 'item.completed',
        item: {
          id: 'todo_1',
          type: 'todo_list',
          items: [{ text: 'Ship it', completed: true }],
        },
      },
      state
    )

    expect(started[0].type).toBe('tool_call')
    expect(started[0].content).toBe('todo_list')
    expect(completed[0].type).toBe('tool_result')
    expect(completed[0].metadata?.items).toEqual([{ text: 'Ship it', completed: true }])
  })

  it('emits usage on turn.completed', () => {
    expect(parseCodexSdkEvent(
      {
        type: 'turn.completed',
        usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 },
      },
      state
    )).toEqual([
      {
        type: 'usage',
        content: '',
        metadata: { input_tokens: 10, output_tokens: 3, context_window: 17 },
      } satisfies OutputEvent,
    ])
  })

  it('emits error events for failures', () => {
    expect(parseCodexSdkEvent(
      { type: 'turn.failed', error: { message: 'context limit exceeded' } },
      state
    )).toEqual([{ type: 'error', content: 'context limit exceeded' } satisfies OutputEvent])
  })
})

describe('parseCodexAppServerNotification', () => {
  let state: ReturnType<typeof createCodexStreamState>

  beforeEach(() => {
    state = createCodexStreamState()
  })

  it('emits usage but not a duplicate error for failed turn/completed notifications', () => {
    expect(parseCodexAppServerNotification(
      'turn/completed',
      {
        turn: {
          status: 'failed',
          error: { message: 'tool router failed' },
          usage: { inputTokens: 12, outputTokens: 4 },
        },
      },
      state,
    )).toEqual([
      {
        type: 'usage',
        content: '',
        metadata: { input_tokens: 12, output_tokens: 4, context_window: 16 },
      } satisfies OutputEvent,
    ])
  })

  it('does not surface protocol error notifications as chat error events', () => {
    expect(parseCodexAppServerNotification(
      'error',
      { error: { message: 'internal app-server error' } },
      state,
    )).toEqual([])
  })

  it('renders unknown item types as generic tool items', () => {
    const events = parseCodexAppServerNotification(
      'item/completed',
      { item: { id: 'future_1', type: 'futureItem', value: 42 } },
      state,
    )

    expect(events).toEqual([
      {
        type: 'tool_call',
        content: 'futureItem',
        metadata: expect.objectContaining({ id: 'future_1', name: 'futureItem', codex_item_type: 'futureItem' }),
      },
      {
        type: 'tool_result',
        content: '',
        metadata: expect.objectContaining({ tool_use_id: 'future_1', codex_item_type: 'futureItem' }),
      },
    ])
  })

  it('renders canonical dynamicToolCall and hookPrompt items', () => {
    expect(parseCodexAppServerNotification(
      'item/completed',
      {
        item: {
          id: 'dynamic_1',
          type: 'dynamicToolCall',
          namespace: 'apps',
          tool: 'lookup',
          arguments: { id: '123' },
          status: 'completed',
          contentItems: [{ type: 'inputText', text: 'found' }],
          success: true,
        },
      },
      state,
    )).toEqual([
      expect.objectContaining({ type: 'tool_call', content: 'lookup', metadata: expect.objectContaining({ name: 'apps.lookup' }) }),
      expect.objectContaining({ type: 'tool_result', content: 'found', metadata: expect.objectContaining({ tool_use_id: 'dynamic_1' }) }),
    ])

    expect(parseCodexAppServerNotification(
      'item/completed',
      { item: { id: 'hook_1', type: 'hookPrompt', fragments: [{ text: 'Injected context' }] } },
      state,
    )).toEqual([
      expect.objectContaining({ type: 'thinking', content: 'Injected context', metadata: expect.objectContaining({ source: 'codex_hook_prompt' }) }),
    ])
  })

  it('renders context compaction notifications as informational tool events', () => {
    const started = parseCodexAppServerNotification(
      'item/started',
      {
        item: {
          id: 'compact_1',
          type: 'contextCompaction',
        },
      },
      state,
    )
    const completed = parseCodexAppServerNotification(
      'item/completed',
      {
        item: {
          id: 'compact_1',
          type: 'contextCompaction',
        },
      },
      state,
    )

    expect(started).toEqual([
      {
        type: 'tool_call',
        content: 'conversation history',
        metadata: {
          id: 'compact_1',
          type: 'tool_call',
          name: 'ContextCompaction',
          input: { action: 'compact_history' },
        },
      } satisfies OutputEvent,
    ])
    expect(completed).toEqual([
      {
        type: 'tool_result',
        content: 'Conversation history compacted.',
        metadata: {
          id: 'compact_1',
          type: 'tool_result',
          tool_use_id: 'compact_1',
        },
      } satisfies OutputEvent,
    ])
  })

  it('renders imageView notifications as image view tool events', () => {
    const started = parseCodexAppServerNotification(
      'item/started',
      {
        item: {
          id: 'image_1',
          type: 'imageView',
          path: 'C:\\tmp\\screenshot.png',
          caption: 'Screenshot',
        },
      },
      state,
    )
    const completed = parseCodexAppServerNotification(
      'item/completed',
      {
        item: {
          id: 'image_1',
          type: 'imageView',
          path: 'C:\\tmp\\screenshot.png',
          caption: 'Screenshot',
        },
      },
      state,
    )

    expect(started).toEqual([
      {
        type: 'tool_call',
        content: 'C:\\tmp\\screenshot.png',
        metadata: {
          id: 'image_1',
          type: 'tool_call',
          name: 'ImageView',
          path: 'C:\\tmp\\screenshot.png',
          caption: 'Screenshot',
          input: {
            path: 'C:\\tmp\\screenshot.png',
            url: undefined,
            caption: 'Screenshot',
          },
        },
      } satisfies OutputEvent,
    ])
    expect(completed).toEqual([
      {
        type: 'tool_result',
        content: '',
        metadata: {
          id: 'image_1',
          type: 'tool_result',
          tool_use_id: 'image_1',
          path: 'C:\\tmp\\screenshot.png',
          caption: 'Screenshot',
        },
      } satisfies OutputEvent,
    ])
  })

  it('renders Codex collab agent tool calls as tool events', () => {
    const started = parseCodexAppServerNotification(
      'item/started',
      {
        item: {
          id: 'agent_call_1',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'inProgress',
          senderThreadId: 'parent-thread',
          receiverThreadIds: [],
          prompt: 'Review the parser changes',
          model: 'gpt-5.3-codex',
          reasoningEffort: 'medium',
          agentsStates: {},
        },
      },
      state,
    )
    const completed = parseCodexAppServerNotification(
      'item/completed',
      {
        item: {
          id: 'agent_call_1',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'completed',
          senderThreadId: 'parent-thread',
          receiverThreadIds: ['child-thread'],
          prompt: 'Review the parser changes',
          model: 'gpt-5.3-codex',
          reasoningEffort: 'medium',
          agentsStates: {
            'child-thread': { status: 'running', message: null },
          },
        },
      },
      state,
    )

    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({
      type: 'tool_call',
      content: 'Spawn agent: Review the parser changes',
      metadata: {
        name: 'Agent',
        tool: 'spawnAgent',
        sender_thread_id: 'parent-thread',
      },
    })
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({
      type: 'tool_result',
      content: 'child-thread running',
      metadata: {
        tool_use_id: 'agent_call_1',
        receiver_thread_ids: ['child-thread'],
      },
    })
  })

  it('renders Codex sub-agent activity as thinking events', () => {
    const events = parseCodexAppServerNotification(
      'item/completed',
      {
        item: {
          id: 'subagent_evt_1',
          type: 'subAgentActivity',
          kind: 'started',
          agentThreadId: 'child-thread',
          agentPath: 'worker',
        },
      },
      state,
    )

    expect(events).toEqual([
      {
        type: 'thinking',
        content: '**Subagent started:** worker',
        metadata: {
          type: 'thinking',
          source: 'codex_subagent',
          task_event: 'started',
          task_id: 'child-thread',
          agent_scope: 'subagent',
          agent_task_id: 'child-thread',
          agent_description: 'worker',
          agent_status: 'running',
          codex_item_id: 'subagent_evt_1',
          codex_agent_path: 'worker',
        },
      } satisfies OutputEvent,
    ])
  })

  it('streams Codex plan and reasoning deltas as thinking', () => {
    expect(parseCodexAppServerNotification(
      'item/plan/delta',
      { itemId: 'plan_1', turnId: 'turn_1', delta: 'Plan line\n' },
      state,
    )).toEqual([
      {
        type: 'thinking',
        content: 'Plan line\n',
        metadata: { type: 'thinking', source: 'codex_plan', item_id: 'plan_1', turn_id: 'turn_1' },
      } satisfies OutputEvent,
    ])

    expect(parseCodexAppServerNotification(
      'item/reasoning/summaryTextDelta',
      { itemId: 'reason_1', turnId: 'turn_1', summaryIndex: 0, delta: 'Checking files.' },
      state,
    )).toEqual([
      {
        type: 'thinking',
        content: 'Checking files.',
        metadata: {
          type: 'thinking',
          source: 'codex_reasoning_summary',
          item_id: 'reason_1',
          turn_id: 'turn_1',
          content_index: undefined,
          summary_index: 0,
        },
      } satisfies OutputEvent,
    ])
  })

  it('emits completed Codex plan items as plan_ready', () => {
    parseCodexAppServerNotification(
      'item/plan/delta',
      { itemId: 'plan_1', turnId: 'turn_1', delta: 'Fallback plan\n' },
      state,
    )

    expect(parseCodexAppServerNotification(
      'item/completed',
      {
        item: {
          id: 'plan_1',
          type: 'plan',
          text: '# Plan\n\n1. Inspect the code.\n2. Patch the driver.',
        },
      },
      state,
    )).toEqual([
      {
        type: 'plan_ready',
        content: '# Plan\n\n1. Inspect the code.\n2. Patch the driver.',
        metadata: {
          id: 'plan_1',
          type: 'plan_ready',
          text: '# Plan\n\n1. Inspect the code.\n2. Patch the driver.',
          provider: 'codex',
        },
      } satisfies OutputEvent,
    ])
  })

  it('falls back to streamed proposed plan text when completed plan text is empty', () => {
    parseCodexAppServerNotification(
      'item/plan/delta',
      { itemId: 'plan_2', turnId: 'turn_1', delta: '# Streamed Plan\n' },
      state,
    )

    expect(parseCodexAppServerNotification(
      'item/completed',
      { item: { id: 'plan_2', type: 'plan', text: '' } },
      state,
    )).toEqual([
      {
        type: 'plan_ready',
        content: '# Streamed Plan\n',
        metadata: {
          id: 'plan_2',
          type: 'plan_ready',
          text: '# Streamed Plan\n',
          provider: 'codex',
        },
      } satisfies OutputEvent,
    ])
  })

  it('emits live Codex token usage updates', () => {
    expect(parseCodexAppServerNotification(
      'thread/tokenUsage/updated',
      {
        threadId: 'thread_1',
        turnId: 'turn_1',
        tokenUsage: {
          last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, totalTokens: 15 },
          total: { inputTokens: 20, cachedInputTokens: 4, outputTokens: 6, totalTokens: 30 },
          modelContextWindow: 200,
        },
      },
      state,
    )).toEqual([
      {
        type: 'usage',
        content: '',
        metadata: { input_tokens: 10, output_tokens: 3, context_window: 15 },
      } satisfies OutputEvent,
    ])
  })

  it('surfaces Codex model and warning notifications', () => {
    expect(parseCodexAppServerNotification(
      'model/rerouted',
      {
        threadId: 'thread_1',
        turnId: 'turn_1',
        fromModel: 'gpt-5.3-codex',
        toModel: 'gpt-5.3-codex-spark',
        reason: 'load',
      },
      state,
    )[0]).toMatchObject({
      type: 'thinking',
      content: 'Model rerouted from gpt-5.3-codex to gpt-5.3-codex-spark.',
      metadata: { source: 'codex_model_rerouted' },
    })

    expect(parseCodexAppServerNotification(
      'configWarning',
      { summary: 'Invalid config', details: 'Unknown key', path: 'config.toml' },
      state,
    )[0]).toMatchObject({
      type: 'thinking',
      content: 'Invalid config\nUnknown key',
      metadata: { source: 'codex_config_warning', path: 'config.toml' },
    })
  })

  it('surfaces Codex MCP progress and patch updates', () => {
    expect(parseCodexAppServerNotification(
      'item/mcpToolCall/progress',
      { threadId: 'thread_1', turnId: 'turn_1', itemId: 'mcp_1', message: 'Fetching issue data' },
      state,
    )).toEqual([
      {
        type: 'thinking',
        content: 'Fetching issue data',
        metadata: {
          type: 'thinking',
          source: 'codex_mcp_progress',
          item_id: 'mcp_1',
          turn_id: 'turn_1',
        },
      } satisfies OutputEvent,
    ])

    expect(parseCodexAppServerNotification(
      'item/fileChange/patchUpdated',
      {
        threadId: 'thread_1',
        turnId: 'turn_1',
        itemId: 'patch_1',
        changes: [{ path: 'src/app.ts', kind: 'update' }],
      },
      state,
    )).toEqual([
      {
        type: 'tool_result',
        content: '',
        metadata: {
          threadId: 'thread_1',
          turnId: 'turn_1',
          itemId: 'patch_1',
          changes: [{ path: 'src/app.ts', kind: 'update' }],
          type: 'tool_result',
          tool_use_id: 'patch_1',
        },
      } satisfies OutputEvent,
    ])
  })
})

describe('CodexDriver transport selection', () => {
  it('uses the app-server driver locally', () => {
    const driver = makeDriver()
    expect((driver as any).localDriver).toBeDefined()
    expect((driver as any).fallbackDriver).toBeNull()
  })

  it('keeps the CLI fallback for WSL', () => {
    const driver = makeDriver({ wsl: { distro: 'Ubuntu' } })
    expect((driver as any).localDriver).toBeNull()
    expect((driver as any).fallbackDriver).toBeDefined()
  })
})

describe('Codex app-server protocol parameters', () => {
  it('uses thread-level sandbox modes and excludes reconstructed turns on resume', () => {
    expect(buildCodexAppServerThreadParams({
      workingDir: '/repo',
      permissionMode: 'workspace',
      threadId: 'thread_1',
    })).toEqual({
      cwd: '/repo',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      threadId: 'thread_1',
      excludeTurns: true,
    })
  })
})

describe('CodexDriver app-server approvals', () => {
  function setupLocalDriver(opts: Partial<DriverOptions> = {}) {
    const driver = makeDriver(opts)
    const local = (driver as any).localDriver
    const events: OutputEvent[] = []
    const writes: unknown[] = []
    ;(local as any).currentTurn = {
      onEvent: (event: OutputEvent) => events.push(event),
      onDone: () => {},
    }
    ;(local as any).child = {
      stdin: {
        writable: true,
        write: (line: string) => {
          writes.push(JSON.parse(line))
          return true
        },
      },
      killed: false,
      kill: () => {},
    }
    return { driver, local, events, writes }
  }

  it('emits command approval requests and sends accept/decline decisions', () => {
    const { driver, local, events, writes } = setupLocalDriver()
    ;(local as any).handleServerRequest(42, 'item/commandExecution/requestApproval', {
      threadId: 'thread_1',
      turnId: 'turn_1',
      itemId: 'cmd_1',
      command: 'npm test',
      cwd: '/repo',
      reason: 'Run tests',
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'permission_request',
      content: 'Bash',
      metadata: {
        requestId: 'codex:item/commandExecution/requestApproval:42',
        toolName: 'Bash',
        toolUseId: 'cmd_1',
      },
    })

    driver.sendControlResponse('codex:item/commandExecution/requestApproval:42', 'allow')
    expect(writes).toEqual([{ id: 42, result: { decision: 'accept' } }])
  })

  it('emits Codex user-input questions and sends structured answers', () => {
    const { driver, local, events, writes } = setupLocalDriver()
    ;(local as any).handleServerRequest(43, 'item/tool/requestUserInput', {
      threadId: 'thread_1',
      turnId: 'turn_1',
      itemId: 'question_1',
      questions: [
        {
          id: 'choice',
          header: 'Mode',
          question: 'Which mode?',
          options: [{ label: 'Fast', description: 'Use fast mode' }],
        },
      ],
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'question',
      metadata: {
        requestId: 'codex:item/tool/requestUserInput:43',
        toolUseId: 'question_1',
      },
    })

    driver.answerQuestion?.('codex:item/tool/requestUserInput:43', { choice: 'Fast' })
    expect(writes).toEqual([
      {
        id: 43,
        result: { answers: { choice: { answers: ['Fast'] } } },
      },
    ])
  })

  it('responds to permission-profile requests with granted or empty permissions', () => {
    const { driver, local, writes } = setupLocalDriver()
    ;(local as any).handleServerRequest(44, 'item/permissions/requestApproval', {
      threadId: 'thread_1',
      turnId: 'turn_1',
      itemId: 'perm_1',
      permissions: { fileSystem: { write: ['/repo'] } },
    })

    driver.sendControlResponse('codex:item/permissions/requestApproval:44', 'deny')
    expect(writes).toEqual([
      {
        id: 44,
        result: { permissions: {}, scope: 'session' },
      },
    ])
  })

  it('starts non-yolo turns with read-only sandbox and on-request approvals', async () => {
    const { local } = setupLocalDriver()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(local as any).codexThreadId = 'thread_1'
    ;(local as any).ensureReady = async () => {}
    ;(local as any).sendRequest = async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params })
      return { turn: { id: 'turn_1' } }
    }

    await (local as any).startTurn('write a file', { yoloMode: false })

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      method: 'turn/start',
      params: {
        approvalPolicy: 'on-request',
        sandboxPolicy: { type: 'readOnly' },
      },
    })
  })

  it('starts yolo turns with full access and no approvals', async () => {
    const { local } = setupLocalDriver()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(local as any).codexThreadId = 'thread_1'
    ;(local as any).ensureReady = async () => {}
    ;(local as any).sendRequest = async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params })
      return { turn: { id: 'turn_1' } }
    }

    await (local as any).startTurn('write a file', { yoloMode: true })

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      method: 'turn/start',
      params: {
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      },
    })
  })

  it('starts workspace turns with workspace-write sandbox and on-request approvals', async () => {
    const { local } = setupLocalDriver()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(local as any).codexThreadId = 'thread_1'
    ;(local as any).ensureReady = async () => {}
    ;(local as any).sendRequest = async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params })
      return { turn: { id: 'turn_1' } }
    }

    await (local as any).startTurn('write a file', { permissionMode: 'workspace' })

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      method: 'turn/start',
      params: {
        approvalPolicy: 'on-request',
        sandboxPolicy: { type: 'workspaceWrite' },
      },
    })
  })

  it('starts plan-mode turns with Codex collaboration mode enabled', async () => {
    const { local } = setupLocalDriver({ model: 'gpt-5.5' })
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(local as any).codexThreadId = 'thread_1'
    ;(local as any).ensureReady = async () => {}
    ;(local as any).sendRequest = async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params })
      return { turn: { id: 'turn_1' } }
    }

    await (local as any).startTurn('make a plan', { planMode: true })

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      method: 'turn/start',
      params: {
        collaborationMode: {
          mode: 'plan',
          settings: {
            model: 'gpt-5.5',
            reasoning_effort: null,
            developer_instructions: null,
          },
        },
      },
    })
  })

  it('steers the active turn for live message injection', async () => {
    const { driver, local } = setupLocalDriver()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(local as any).codexThreadId = 'thread_1'
    ;(local as any).activeTurnId = 'turn_1'
    ;(local as any).sendRequest = async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params })
      return {}
    }

    driver.injectMessage?.('change direction')
    await Promise.resolve()

    expect(requests).toEqual([{
      method: 'turn/steer',
      params: {
        threadId: 'thread_1',
        expectedTurnId: 'turn_1',
        input: [{ type: 'text', text: 'change direction', text_elements: [] }],
      },
    }])
  })

  it('keeps a turn alive for recoverable errors', () => {
    const { local } = setupLocalDriver()
    let done = false
    ;(local as any).currentTurn.onDone = () => { done = true }
    ;(local as any).outstandingTurnCount = 1

    ;(local as any).handleLine(JSON.stringify({
      method: 'error',
      params: { error: { message: 'transient disconnect' }, willRetry: true, threadId: 'thread_1', turnId: 'turn_1' },
    }))

    expect(done).toBe(false)
    expect((local as any).currentTurn).not.toBeNull()
  })

  it('ignores restored usage replay before an active turn starts', () => {
    const { local, events } = setupLocalDriver()
    ;(local as any).activeTurnId = null

    ;(local as any).handleLine(JSON.stringify({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread_1',
        turnId: 'historical_turn',
        tokenUsage: {
          last: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 25, totalTokens: 125 },
          total: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 250, totalTokens: 1250 },
          modelContextWindow: 200000,
        },
      },
    }))

    expect(events).toEqual([])
  })

  it('clears server requests resolved by Codex and emits a resolution event', () => {
    const { local, events } = setupLocalDriver()
    ;(local as any).handleServerRequest(45, 'item/tool/requestUserInput', {
      threadId: 'thread_1', turnId: 'turn_1', itemId: 'question_1', questions: [],
    })

    ;(local as any).handleLine(JSON.stringify({
      method: 'serverRequest/resolved',
      params: { threadId: 'thread_1', requestId: 45 },
    }))

    expect((local as any).pendingQuestionRequests.size).toBe(0)
    expect(events.at(-1)).toMatchObject({
      type: 'status',
      metadata: { type: 'server_request_resolved', requestId: 'codex:item/tool/requestUserInput:45' },
    })
  })

  it('returns a structured failure for unregistered dynamic tool calls', () => {
    const { local, writes } = setupLocalDriver()
    ;(local as any).handleServerRequest(46, 'item/tool/call', {
      threadId: 'thread_1', turnId: 'turn_1', callId: 'dynamic_1', tool: 'lookup', arguments: {},
    })

    expect(writes).toEqual([{
      id: 46,
      result: {
        contentItems: [{ type: 'inputText', text: 'Dynamic tool lookup is not registered in PolyCode.' }],
        success: false,
      },
    }])
  })

  it('forceStop immediately kills and detaches the app-server', () => {
    const { driver, local } = setupLocalDriver()
    let kills = 0
    ;(local as any).child.kill = () => { kills += 1 }

    driver.forceStop?.()

    expect(kills).toBe(1)
    expect((local as any).child).toBeNull()
    expect(driver.isRunning()).toBe(false)
  })
})

describe('buildCodexEnvironment', () => {
  it('derives CODEX_HOME from USERPROFILE on Windows-style envs', () => {
    const env = buildCodexEnvironment({
      USERPROFILE: 'C:\\Users\\marti',
      PATH: 'C:\\Windows\\System32',
    })

    expect(env.HOME).toBe('C:\\Users\\marti')
    expect(env.CODEX_HOME).toBe('C:\\Users\\marti\\.codex')
  })

  it('preserves an explicit CODEX_HOME', () => {
    const env = buildCodexEnvironment({
      HOME: '/tmp/home',
      CODEX_HOME: '/tmp/custom-codex-home',
    })

    expect(env.HOME).toBe('/tmp/home')
    expect(env.CODEX_HOME).toBe('/tmp/custom-codex-home')
  })
})

describe('buildCodexSdkOptions', () => {
  it('passes the normalized env through to the SDK', () => {
    const options = buildCodexSdkOptions({
      HOME: '/tmp/home',
    })

    expect(options.env).toMatchObject({
      HOME: '/tmp/home',
      CODEX_HOME: path.join('/tmp/home', '.codex'),
    })
  })
})
