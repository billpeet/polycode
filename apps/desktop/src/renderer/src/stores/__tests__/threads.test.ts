import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '../../types/ipc'
import { useThreadStore } from '../threads'

function makeThread(overrides: Partial<Thread>): Thread {
  return {
    id: 'thread-main',
    project_id: 'project-1',
    location_id: 'location-main',
    name: 'Existing thread',
    provider: 'claude-code',
    model: 'claude-opus-4-8',
    reasoning_level: 'off',
    codex_personality: 'none',
    codex_reasoning_summary: 'auto',
    cursor_thinking: null,
    cursor_context: null,
    status: 'idle',
    archived: false,
    input_tokens: 0,
    output_tokens: 0,
    context_window: 0,
    unread: false,
    has_messages: false,
    permission_mode: 'ask',
    yolo_mode: false,
    use_wsl: false,
    wsl_distro: null,
    git_branch: null,
    routine_id: null,
    run_state: null,
    run_detail: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('thread store creation defaults', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { api: { invoke } })
    useThreadStore.setState({
      byProject: {},
      selectedThreadId: null,
      statusMap: {},
      unreadByThread: {},
      pendingThreadIdByLocation: {},
    })
  })

  it('inherits the selected thread permission mode when starting in a new worktree', async () => {
    const selectedThread = makeThread({ permission_mode: 'workspace' })
    const createdThread = makeThread({
      id: 'thread-worktree',
      location_id: 'location-worktree',
      name: 'New thread',
      permission_mode: 'ask',
    })
    useThreadStore.setState({
      byProject: { 'project-1': [selectedThread] },
      selectedThreadId: selectedThread.id,
    })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'threads:create') return createdThread
      return undefined
    })

    await useThreadStore.getState().create('project-1', 'New thread', 'location-worktree')

    expect(invoke).toHaveBeenCalledWith('threads:setPermissionMode', createdThread.id, 'workspace')
    expect(useThreadStore.getState().byProject['project-1'][0].permission_mode).toBe('workspace')
  })
})

describe('thread action rollback', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { api: { invoke } })
    useThreadStore.setState({
      byProject: { 'project-1': [makeThread({})] },
      statusMap: { 'thread-main': 'idle' },
      runStartedAtByThread: {},
    })
  })

  it('restores idle status when sending fails before the main process accepts it', async () => {
    invoke.mockRejectedValueOnce(new Error('IPC unavailable'))

    await expect(useThreadStore.getState().send('thread-main', 'hello')).rejects.toThrow('IPC unavailable')

    expect(useThreadStore.getState().statusMap['thread-main']).toBe('idle')
    expect(useThreadStore.getState().runStartedAtByThread['thread-main']).toBeUndefined()
    expect(useThreadStore.getState().byProject['project-1'][0].has_messages).toBe(false)
  })

  it('restores the permission prompt when approval fails', async () => {
    useThreadStore.setState({ statusMap: { 'thread-main': 'permission_pending' } })
    invoke.mockRejectedValueOnce(new Error('IPC unavailable'))

    await expect(useThreadStore.getState().approvePermissions('thread-main', 'request-1')).rejects.toThrow('IPC unavailable')

    expect(useThreadStore.getState().statusMap['thread-main']).toBe('permission_pending')
    expect(useThreadStore.getState().runStartedAtByThread['thread-main']).toBeUndefined()
  })
})
