import { afterEach, expect, it, vi } from 'vitest'
import type { QueueThread } from '../../types/ipc'
import { useLocationStore } from '../locations'
import { useThreadStore } from '../threads'

afterEach(() => vi.unstubAllGlobals())

it.each([false, true])('removes worktree threads immediately with project list loaded: %s', async (projectLoaded) => {
  let finish!: () => void
  const invoke = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
  vi.stubGlobal('window', { api: { invoke } })
  const thread = { id: 't', project_id: 'p', location_id: 'worktree' } as QueueThread
  const other = { id: 'other', project_id: 'p', location_id: 'main' } as QueueThread
  useThreadStore.setState({
    byProject: { p: projectLoaded ? [thread, other] : [] }, queueThreads: [thread, other],
    archivedCountByProject: { p: 0 }, selectedThreadId: thread.id,
  })
  useLocationStore.setState({ byProject: {}, deletingWorktreesByProject: {} })

  const deletion = useLocationStore.getState().removeWorktree('worktree', 'p')
  try {
    expect(invoke).toHaveBeenCalledWith('locations:removeWorktree', 'worktree')
    expect(useThreadStore.getState().queueThreads).toEqual([other])
    expect(useThreadStore.getState().byProject.p).toEqual(projectLoaded ? [other] : [])
    expect(useThreadStore.getState().selectedThreadId).toBeNull()
    expect(useThreadStore.getState().archivedCountByProject.p).toBe(1)
  } finally {
    finish()
    await deletion
  }
})
