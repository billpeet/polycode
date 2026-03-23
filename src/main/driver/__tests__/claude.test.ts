import { afterEach, beforeEach, describe, it, expect, mock } from 'bun:test'
import { ClaudeDriver } from '../claude'
import type { DriverOptions } from '../types'
import type { OutputEvent } from '../../../shared/types'

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
  it('uses the system claude binary and adds the working directory to additionalDirectories', async () => {
    let capturedInput: any
    const fakeQuery = {
      setPermissionMode: async () => {},
      setModel: async () => {},
      interrupt: async () => {},
      close: () => {},
      [Symbol.asyncIterator]: async function* () {},
    }

    mock.module('@anthropic-ai/claude-agent-sdk', () => ({
      query: (input: any) => {
        capturedInput = input
        return fakeQuery
      },
    }))

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

    mock.module('@anthropic-ai/claude-agent-sdk', () => ({
      query: (input: any) => {
        capturedInput = input
        return fakeQuery
      },
    }))

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
