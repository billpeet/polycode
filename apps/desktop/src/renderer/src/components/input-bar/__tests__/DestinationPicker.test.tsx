// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, PullRequest, RepoLocation, Thread } from '../../../types/ipc'
import DestinationPicker from '../DestinationPicker'
import { useProjectStore } from '../../../stores/projects'
import { useLocationStore } from '../../../stores/locations'
import { useThreadStore } from '../../../stores/threads'
import { useUnifiedStore } from '../../../stores/unified'
import { mergeUnifiedSources, type UnifiedSource } from '@polycode/shared'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('../../../lib/client', () => ({ client: { invoke } }))
vi.mock('../../ProjectFavicon', () => ({
  default: ({ projectId }: { projectId: string }) => <img alt="" data-testid={`favicon-${projectId}`} />,
}))

function makeProject(overrides: Partial<Project>): Project {
  return {
    id: 'p',
    name: 'Project',
    git_url: null,
    favicon_path: null,
    allow_main_branch_commits: false,
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeLocation(overrides: Partial<RepoLocation>): RepoLocation {
  return {
    id: 'loc',
    project_id: 'zeta',
    label: 'Local',
    path: 'C:/zeta',
    connection_type: 'local',
    is_worktree: false,
    parent_location_id: null,
    pool_id: null,
    checked_out: false,
    ...overrides,
  } as RepoLocation
}

const pullRequests: PullRequest[] = [
  { id: 41, title: 'Add favicons', status: 'active', sourceBranch: 'feat/favicons', targetBranch: 'main', authorName: 'a', url: '', creationDate: '' },
]

beforeEach(() => {
  vi.clearAllMocks()
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'forge:pr:list') return pullRequests
    return undefined
  })
  useProjectStore.setState({
    projects: [
      makeProject({ id: 'zeta', name: 'Zeta' }),
      makeProject({ id: 'alpha', name: 'alpha' }),
      makeProject({ id: 'mid', name: 'Mid' }),
      makeProject({ id: 'old', name: 'Archived', archived_at: '2026-01-01T00:00:00.000Z' }),
    ],
  })
  useLocationStore.setState({ byProject: { zeta: [makeLocation({})] } })
  useThreadStore.setState({ byProject: {}, draftNewThreadId: null, draftNewWorktree: false, draftPullRequest: null })
  useThreadStore.getState().openDraftThread('zeta', 'loc')
})

afterEach(() => {
  cleanup()
})

function draft(): Thread {
  const id = useThreadStore.getState().draftNewThreadId
  const thread = Object.values(useThreadStore.getState().byProject).flat().find((t) => t.id === id)
  if (!thread) throw new Error('expected a draft thread')
  return thread
}

describe('DestinationPicker project menu', () => {
  it('lists unarchived projects alphabetically with their favicons', () => {
    render(<DestinationPicker draftThread={draft()} />)
    fireEvent.click(screen.getByTitle('Project'))

    const listbox = screen.getByRole('listbox', { name: 'Project' })
    const options = within(listbox).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['alpha', 'Mid', 'Zeta'])
    expect(within(options[0]).getByTestId('favicon-alpha')).toBeTruthy()
    expect(options[2].getAttribute('aria-selected')).toBe('true')
  })

  it('shows the current project favicon on the trigger', () => {
    render(<DestinationPicker draftThread={draft()} />)
    expect(within(screen.getByTitle('Project')).getByTestId('favicon-zeta')).toBeTruthy()
  })
})

describe('DestinationPicker pull requests', () => {
  it('offers open pull requests and marks the draft to check one out in a new worktree', async () => {
    render(<DestinationPicker draftThread={draft()} />)
    const select = screen.getByTitle('Location, worktree or pull request') as HTMLSelectElement

    await waitFor(() => expect(within(select).getByText('#41 Add favicons')).toBeTruthy())
    expect(invoke).toHaveBeenCalledWith('forge:pr:list', 'C:/zeta')

    fireEvent.change(select, { target: { value: 'pr:loc:41' } })

    const state = useThreadStore.getState()
    expect(state.draftNewWorktree).toBe(true)
    expect(state.draftPullRequest).toEqual({ id: 41, title: 'Add favicons' })
    expect(draft().location_id).toBe('loc')
  })

  it('does not offer pull requests for locations that cannot fork a worktree', async () => {
    useLocationStore.setState({ byProject: { zeta: [makeLocation({ connection_type: 'ssh' })] } })
    render(<DestinationPicker draftThread={draft()} />)

    await Promise.resolve()
    expect(invoke).not.toHaveBeenCalledWith('forge:pr:list', expect.anything())
  })
})

describe('DestinationPicker worktree names', () => {
  it('lists a worktree by its current branch rather than its stored label', async () => {
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'forge:pr:list') return []
      if (channel === 'git:branch') return args[0] === 'C:/zeta-worktrees/kf12oi' ? 'feat/renamed-by-agent' : 'master'
      return undefined
    })
    useLocationStore.setState({
      byProject: {
        zeta: [
          makeLocation({}),
          makeLocation({ id: 'wt', label: 'kf12oi', path: 'C:/zeta-worktrees/kf12oi', is_worktree: true, parent_location_id: 'loc' }),
        ],
      },
    })
    render(<DestinationPicker draftThread={draft()} />)

    const select = screen.getByTitle('Location, worktree or pull request') as HTMLSelectElement
    await waitFor(() => {
      expect(within(select).getByRole('option', { name: '↳ feat/renamed-by-agent' })).toBeTruthy()
    })
    expect(within(select).getByRole('option', { name: 'Local' })).toBeTruthy()
  })
})

describe('DestinationPicker in the unified view', () => {
  const sources: UnifiedSource[] = [
    {
      sourceId: 'local', label: 'Local', status: 'ok', error: null, archivedProjects: [],
      projects: [{
        project: makeProject({ id: 'zeta', name: 'Zeta', git_url: 'https://github.com/x/zeta.git' }),
        locations: [makeLocation({})], pools: [], threads: [], archivedCount: 0, snoozedCount: 0,
      }],
    },
    {
      sourceId: 'h1', label: 'Build box', status: 'ok', error: null, archivedProjects: [],
      projects: [{
        project: makeProject({ id: 'zeta-remote', name: 'zeta', git_url: 'git@github.com:x/zeta' }),
        locations: [makeLocation({ id: 'rloc', project_id: 'zeta-remote', label: 'Checkout', path: '/srv/zeta' })],
        pools: [], threads: [], archivedCount: 0, snoozedCount: 0,
      }],
    },
  ]

  beforeEach(() => {
    useUnifiedStore.setState({
      enabled: true,
      activeSourceId: 'local',
      snapshot: { sources, fetchedAt: 't' },
      projects: mergeUnifiedSources(sources),
    })
  })
  afterEach(() => useUnifiedStore.setState({ enabled: false, snapshot: null, projects: [] }))

  it('groups the merged project’s locations by source', () => {
    render(<DestinationPicker draftThread={draft()} />)
    const select = screen.getByTitle('Location on any source, worktree or pull request') as HTMLSelectElement
    const groups = [...select.querySelectorAll('optgroup')].map((g) => g.label)
    expect(groups.slice(0, 2)).toEqual(['Local', 'Build box'])
    expect(within(select).getByRole('option', { name: 'Checkout' })).toBeTruthy()
    // The draft's current destination is selected, and its source is named beside it.
    expect(select.selectedOptions[0].textContent).toBe('Local')
    expect(screen.getByTitle('This thread runs on this machine')).toBeTruthy()
  })

  it('moves the draft to the chosen source when a location on another source is picked', () => {
    const setDraftDestination = vi.fn(async () => undefined)
    useUnifiedStore.setState({ setDraftDestination })
    render(<DestinationPicker draftThread={draft()} />)
    const select = screen.getByTitle('Location on any source, worktree or pull request') as HTMLSelectElement
    const option = within(select).getByRole('option', { name: 'Checkout' }) as HTMLOptionElement
    fireEvent.change(select, { target: { value: option.value } })
    expect(setDraftDestination).toHaveBeenCalledWith('h1', 'zeta-remote', 'rloc', { newWorktree: undefined, pullRequest: undefined })
  })

  it('falls back to the single-source picker for a project the snapshot does not know', () => {
    useUnifiedStore.setState({ projects: [] })
    render(<DestinationPicker draftThread={draft()} />)
    expect(screen.getByTitle('Location, worktree or pull request')).toBeTruthy()
  })
})
