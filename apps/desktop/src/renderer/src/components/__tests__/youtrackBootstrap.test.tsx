// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from '../../App'
import { useProjectStore } from '../../stores/projects'
import { useThreadStore } from '../../stores/threads'
import { useLocationStore } from '../../stores/locations'
import { useYouTrackStore } from '../../stores/youtrack'
import type { Project, Thread } from '../../types/ipc'

vi.mock('../Sidebar', () => ({ default: () => null }))
vi.mock('../ThreadView', () => ({ default: () => null }))
vi.mock('../RightPanel', () => ({ default: () => null }))
vi.mock('../SecondPanel', () => ({ default: () => null }))
vi.mock('../Toast', () => ({ default: () => null }))
vi.mock('../TitleBar', () => ({ default: () => null }))
vi.mock('../UpdateBanner', () => ({ UpdateBanner: () => null }))
vi.mock('../RemoteConnectionBanner', () => ({ RemoteConnectionBanner: () => null }))
vi.mock('../../hooks/useDatabaseSync', () => ({ useDatabaseSync: () => {} }))
vi.mock('../../hooks/useAvailableAuxTabs', () => ({ useAvailableAuxTabs: () => ({ tabs: ['chat'] }) }))
vi.mock('../../stores/plans', () => ({}))

const invoke = vi.fn()
beforeEach(() => {
  invoke.mockReset()
  Object.assign(window, { api: { invoke, on: vi.fn(() => () => {}) } })
  invoke.mockImplementation(async (channel: string, key: string) => {
    if (channel === 'settings:get') {
      if (key === 'selectedProjectId') return 'project-1'
      if (key === 'selectedThreadId') return 'thread-1'
      return null
    }
    if (channel === 'youtrack:servers:list') throw new TypeError('fetch failed')
    return undefined
  })
  useProjectStore.setState({ projects: [{ id: 'project-1' } as Project], selectedProjectId: null, fetch: vi.fn().mockResolvedValue(undefined) })
  useThreadStore.setState({ byProject: { 'project-1': [{ id: 'thread-1' } as Thread] }, selectedThreadId: null, fetch: vi.fn().mockResolvedValue(undefined) })
  useLocationStore.setState({ fetch: vi.fn().mockResolvedValue(undefined), fetchPools: vi.fn().mockResolvedValue(undefined) })
  useYouTrackStore.setState(useYouTrackStore.getInitialState())
})
afterEach(cleanup)

it.each([
  new TypeError('fetch failed'),
  new Error("Error invoking remote method 'youtrack:servers:list': RemoteUnavailableError: offline"),
  new Error('SQLITE_CORRUPT: database disk image is malformed'),
])('restores the saved project and thread when YouTrack loading fails: %s', async (error) => {
  const original = invoke.getMockImplementation()!
  invoke.mockImplementation((channel, ...args) => channel === 'youtrack:servers:list' ? Promise.reject(error) : original(channel, ...args))
  render(<App />)
  await waitFor(() => expect(useThreadStore.getState().selectedThreadId).toBe('thread-1'))
  expect(useProjectStore.getState().selectedProjectId).toBe('project-1')
  expect(invoke).toHaveBeenCalledWith('youtrack:servers:list')
})

it('restores selections without waiting for YouTrack', async () => {
  let finish!: (servers: []) => void
  const pending = new Promise<[]>((resolve) => { finish = resolve })
  const original = invoke.getMockImplementation()!
  invoke.mockImplementation((channel, ...args) => channel === 'youtrack:servers:list' ? pending : original(channel, ...args))
  render(<App />)
  try {
    await waitFor(() => expect(useThreadStore.getState().selectedThreadId).toBe('thread-1'))
  } finally {
    await act(async () => { finish([]); await pending })
  }
})
