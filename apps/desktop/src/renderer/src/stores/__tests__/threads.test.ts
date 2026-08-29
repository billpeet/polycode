import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '../../types/ipc'
import { useMessageStore } from '../messages'
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
    total_tokens: 0,
    total_cost_usd: null,
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
    last_turn_started_at: null,
    last_turn_completed_at: null,
    snoozed_until: null,
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

describe('create-on-send draft survival', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { api: { invoke } })
    useThreadStore.setState({
      byProject: {},
      selectedThreadId: null,
      statusMap: {},
      unreadByThread: {},
      draftNewThreadId: null,
      draftNewWorktree: false,
    })
    useMessageStore.setState({ messagesByThread: {}, messagesBySession: {} })
  })

  it('keeps the draft at the head when the project thread list refreshes from the DB', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'threads:list') return [makeThread({ id: 'db-thread' })]
      if (channel === 'threads:archivedCount') return 0
      return null
    })

    useThreadStore.getState().openDraftThread('project-1', 'location-main')
    const draftId = useThreadStore.getState().draftNewThreadId
    expect(draftId).not.toBeNull()

    await useThreadStore.getState().fetch('project-1')

    const ids = (useThreadStore.getState().byProject['project-1'] ?? []).map((t) => t.id)
    expect(ids[0]).toBe(draftId)
    expect(ids).toContain('db-thread')
  })

  it('does not resurrect the draft into other projects on refresh', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'threads:list') return []
      if (channel === 'threads:archivedCount') return 0
      return null
    })

    useThreadStore.getState().openDraftThread('project-1', 'location-main')

    await useThreadStore.getState().fetch('project-2')

    expect(useThreadStore.getState().byProject['project-2']).toEqual([])
  })

  it('recovers when the draft pointer outlives its optimistic thread', () => {
    useThreadStore.setState({
      byProject: { 'project-1': [makeThread({})] },
      selectedThreadId: null,
      draftNewThreadId: 'missing-draft',
      draftNewWorktree: false,
    })

    useThreadStore.getState().openDraftThread('project-1', 'location-main')

    const state = useThreadStore.getState()
    const draftId = state.draftNewThreadId
    expect(draftId).not.toBe('missing-draft')
    expect(state.selectedThreadId).toBe(draftId)
    expect(state.byProject['project-1'].some((thread) => thread.id === draftId)).toBe(true)
  })

  it('carries the optimistic user message onto the materialized thread', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'threads:create') return makeThread({ id: 'real-thread', name: 'New thread' })
      return undefined
    })
    useThreadStore.getState().openDraftThread('project-1', 'location-main')
    const draftId = useThreadStore.getState().draftNewThreadId
    if (!draftId) throw new Error('expected a draft thread')
    useMessageStore.getState().appendUserMessage(draftId, 'Start this work', 'message-1')

    const realThreadId = await useThreadStore.getState().materializeDraftThread(draftId)

    expect(realThreadId).toBe('real-thread')
    expect(useMessageStore.getState().messagesByThread[draftId]).toBeUndefined()
    expect(useMessageStore.getState().messagesByThread[realThreadId]).toMatchObject([
      { id: 'message-1', thread_id: realThreadId, role: 'user', content: 'Start this work' },
    ])
  })
})
