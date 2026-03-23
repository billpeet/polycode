import { describe, it, expect } from 'bun:test'
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
