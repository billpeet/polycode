import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMessageStore } from '../../stores/messages'
import { useProjectStore } from '../../stores/projects'
import { useSessionStore } from '../../stores/sessions'
import { useThreadStore } from '../../stores/threads'
import { useDatabaseSync } from '../useDatabaseSync'

describe('useDatabaseSync', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(window, { api: { invoke, on: vi.fn(() => () => {}) } })
    useProjectStore.setState({ selectedProjectId: 'project-1' })
    useThreadStore.setState({
      byProject: { 'project-1': [] },
      selectedThreadId: 'thread-1',
      expandedArchivedProjectId: null,
    })
    useSessionStore.setState({ activeSessionByThread: { 'thread-1': 'session-1' } })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'threads:list') return []
      if (channel === 'threads:archivedCount') return 0
      if (channel === 'messages:listBySession') return []
      if (channel === 'sessions:list') return []
      return undefined
    })
  })

  it('reloads the loaded thread list and visible transcript when the window regains focus', async () => {
    renderHook(() => useDatabaseSync())
    invoke.mockClear()

    act(() => window.dispatchEvent(new Event('focus')))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('threads:list', 'project-1')
      expect(invoke).toHaveBeenCalledWith('threads:archivedCount', 'project-1')
      expect(invoke).toHaveBeenCalledWith('messages:listBySession', 'session-1')
    })
  })
})
// @vitest-environment happy-dom
