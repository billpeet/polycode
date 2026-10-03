import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/chime', () => ({ playChime: vi.fn() }))

import { playChime } from '../../lib/chime'
import { loadUnifiedCollapsed, useUnifiedStore, sourceKey } from '../unified'
import { useThreadStore } from '../threads'
import type { UnifiedSource } from '@polycode/shared'
import type { Project, QueueThread, Thread } from '../../types/ipc'

function project(id: string, gitUrl: string | null): Project {
  return {
    id,
    name: id,
    git_url: gitUrl,
    favicon_path: null,
    allow_main_branch_commits: true,
    archived_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

function source(sourceId: string, label: string, projects: Project[], threads: Thread[] = []): UnifiedSource {
  return {
    sourceId,
    label,
    status: 'ok',
    error: null,
    archivedProjects: [],
    projects: projects.map((p) => ({ project: p, locations: [], pools: [], threads, archivedCount: 0, snoozedCount: 0 })),
  }
}

describe('unified store', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { api: { invoke, on: () => () => undefined } })
    invoke.mockReset()
    vi.mocked(playChime).mockReset()
    useUnifiedStore.setState({
      enabled: true,
      snapshot: null,
      projects: [],
      activeSourceId: 'local',
      liveStatus: {},
      liveUnread: {},
      liveTitle: {},
      sections: {},
    })
    useThreadStore.setState({ byProject: {}, selectedThreadId: null })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('merges a partial refresh into the existing snapshot', async () => {
    invoke.mockResolvedValueOnce({
      sources: [source('local', 'Local', [project('a', 'github.com/x/r')]), source('h1', 'Box', [project('b', 'github.com/x/r')])],
      fetchedAt: 't0',
    })
    await useUnifiedStore.getState().refresh()
    expect(useUnifiedStore.getState().projects[0].members).toHaveLength(2)

    invoke.mockResolvedValueOnce({ sources: [source('h1', 'Box', [])], fetchedAt: 't1' })
    await useUnifiedStore.getState().refresh(['h1'])
    expect(invoke).toHaveBeenLastCalledWith('remote:getUnifiedSnapshot', ['h1'])
    const { snapshot, projects } = useUnifiedStore.getState()
    expect(snapshot?.sources.map((s) => s.sourceId)).toEqual(['local', 'h1'])
    expect(projects[0].members.map((m) => m.sourceId)).toEqual(['local'])
  })

  it('applies live status and titles per source without touching other sources', () => {
    const { handleEvent } = useUnifiedStore.getState()
    handleEvent({ sourceId: 'h1', kind: 'event', channel: 'thread:status:t1', args: ['running'] })
    handleEvent({ sourceId: 'h1', kind: 'event', channel: 'thread:title:t1', args: ['Renamed'] })
    const state = useUnifiedStore.getState()
    expect(state.liveStatus[sourceKey('h1', 't1')]).toBe('running')
    expect(state.liveTitle[sourceKey('h1', 't1')]).toBe('Renamed')
    expect(state.liveStatus[sourceKey('local', 't1')]).toBeUndefined()
  })

  it('marks a completed Thread on another source unread and chimes', () => {
    useUnifiedStore.getState().handleEvent({ sourceId: 'h1', kind: 'event', channel: 'thread:complete:t1', args: ['idle'] })
    expect(useUnifiedStore.getState().liveUnread[sourceKey('h1', 't1')]).toBe(true)
    expect(playChime).toHaveBeenCalledOnce()
  })

  it('stays quiet for the Thread on screen', () => {
    useThreadStore.setState({ selectedThreadId: 't1' })
    useUnifiedStore.getState().handleEvent({ sourceId: 'local', kind: 'event', channel: 'thread:complete:t1', args: ['idle'] })
    expect(useUnifiedStore.getState().liveUnread[sourceKey('local', 't1')]).toBeUndefined()
    expect(playChime).not.toHaveBeenCalled()
  })

  it('leaves the chime to the tree for active-source Threads it has loaded', () => {
    useThreadStore.setState({ byProject: { p: [{ id: 't1' } as Thread] } })
    useUnifiedStore.getState().handleEvent({ sourceId: 'local', kind: 'event', channel: 'thread:complete:t1', args: ['idle'] })
    expect(playChime).not.toHaveBeenCalled()
  })

  it('refetches a source whose event stream came back', async () => {
    invoke.mockResolvedValue({ sources: [], fetchedAt: 't' })
    useUnifiedStore.getState().handleEvent({ sourceId: 'h1', kind: 'connection', connected: false })
    expect(useUnifiedStore.getState().disconnected.h1).toBe(true)
    useUnifiedStore.getState().handleEvent({ sourceId: 'h1', kind: 'connection', connected: true })
    await vi.runAllTimersAsync()
    expect(invoke).toHaveBeenCalledWith('remote:getUnifiedSnapshot', ['h1'])
  })

  it('routes source actions through remote:invokeOnSource', async () => {
    invoke.mockResolvedValue(undefined)
    await useUnifiedStore.getState().invokeOn('h1', 'threads:archive', 't1')
    expect(invoke).toHaveBeenCalledWith('remote:invokeOnSource', 'h1', 'threads:archive', ['t1'])
  })

  it('tags each source Queue row with their source', async () => {
    useUnifiedStore.setState({ snapshot: { sources: [source('local', 'Local', []), source('h1', 'Box', [])], fetchedAt: 't' } })
    invoke.mockImplementation(async (_channel: string, sourceId: string) => [{ id: `q-${sourceId}` } as QueueThread])
    await useUnifiedStore.getState().refreshQueue()
    const { queueBySource } = useUnifiedStore.getState()
    expect(queueBySource.local[0]).toMatchObject({ id: 'q-local', source_id: 'local', source_label: 'Local' })
    expect(queueBySource.h1[0]).toMatchObject({ id: 'q-h1', source_id: 'h1', source_label: 'Box' })
  })

  it('pages Snoozed/Archived per source and merges them newest first', async () => {
    useUnifiedStore.setState({ snapshot: { sources: [source('local', 'Local', []), source('h1', 'Box', [])], fetchedAt: 't' } })
    const row = (id: string, at: string) => ({ id, updated_at: at, last_turn_completed_at: at }) as QueueThread
    const pages: Record<string, QueueThread[][]> = {
      local: [[row('l1', '2026-01-03T00:00:00Z'), row('l2', '2026-01-01T00:00:00Z')], [row('l3', '2025-12-01T00:00:00Z')]],
      h1: [[row('h1a', '2026-01-02T00:00:00Z')]],
    }
    invoke.mockImplementation(async (_c: string, sourceId: string, _ch: string, args: unknown[]) => {
      const offset = args[2] as number
      return pages[sourceId][offset === 0 ? 0 : 1] ?? []
    })
    const first = await loadUnifiedCollapsed('archived', null, 0, 2)
    expect(first.rows.map((r) => r.id)).toEqual(['l1', 'h1a', 'l2'])
    expect(first.hasMore).toBe(true) // local filled its page; h1 did not
    const second = await loadUnifiedCollapsed('archived', null, 3, 2)
    expect(second.rows.map((r) => r.id)).toEqual(['l3'])
    expect(second.hasMore).toBe(false)
    // h1 was exhausted after its first short page and is not asked again.
    expect(invoke.mock.calls.filter((c) => c[1] === 'h1')).toHaveLength(1)
  })

  it('carries the typed draft across when the destination moves to another source', async () => {
    vi.useRealTimers()
    vi.stubGlobal('window', {
      api: {
        invoke,
        // Stand in for main announcing the host switch.
        on: (_channel: string, callback: () => void) => { queueMicrotask(callback); return () => undefined },
      },
      dispatchEvent: () => true,
    })
    invoke.mockImplementation(async (channel: string) => (channel === 'remote:getActiveHost' ? null : []))
    useThreadStore.setState({ byProject: {}, draftNewThreadId: null, draftByThread: {} })
    useThreadStore.getState().openDraftThread('p1', 'l1')
    const firstDraft = useThreadStore.getState().draftNewThreadId!
    useThreadStore.getState().setDraft(firstDraft, 'half-written prompt')
    // What App does on remote:active-changed: the per-host stores are wiped.
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'remote:setActiveHost') {
        useThreadStore.setState({ byProject: {}, draftNewThreadId: null, draftByThread: {}, selectedThreadId: null })
        return { id: 'h1' }
      }
      return channel === 'remote:getActiveHost' ? null : []
    })

    await useUnifiedStore.getState().setDraftDestination('h1', 'p2', 'l2', { newWorktree: true })

    const threads = useThreadStore.getState()
    const draft = threads.byProject.p2?.find((t) => t.id === threads.draftNewThreadId)
    expect(draft).toMatchObject({ project_id: 'p2', location_id: 'l2', is_pending: true })
    expect(threads.draftNewWorktree).toBe(true)
    expect(threads.draftByThread[threads.draftNewThreadId!]).toBe('half-written prompt')
    expect(useUnifiedStore.getState().activeSourceId).toBe('h1')
    expect(invoke).toHaveBeenCalledWith('remote:setActiveHost', 'h1')
  })

  it('re-points the draft in place when the destination stays on the active source', async () => {
    useThreadStore.setState({ byProject: {}, draftNewThreadId: null, draftByThread: {} })
    useThreadStore.getState().openDraftThread('p1', 'l1')
    await useUnifiedStore.getState().setDraftDestination('local', 'p1', 'l9')
    const threads = useThreadStore.getState()
    expect(threads.byProject.p1?.[0]).toMatchObject({ location_id: 'l9' })
    expect(invoke).not.toHaveBeenCalledWith('remote:setActiveHost', expect.anything())
  })
})
