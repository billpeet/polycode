import { beforeEach, describe, expect, it } from 'bun:test'
import path from 'path'
import {
  buildCodexEnvironment,
  buildCodexSdkOptions,
  CodexDriver,
  buildCodexArgs,
  createCodexStreamState,
  parseBashCommand,
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
      '--full-auto',
      'hello world',
    ])
  })

  it('builds a resume command with yolo mode', () => {
    expect(buildCodexArgs('session-123', 'gpt-5.3-codex', 'continue', true)).toEqual([
      'exec',
      '--json',
      'resume',
      '--dangerously-bypass-approvals-and-sandbox',
      '-c',
      'model=gpt-5.3-codex',
      'session-123',
      'continue',
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
        metadata: { input_tokens: 10, output_tokens: 3 },
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
