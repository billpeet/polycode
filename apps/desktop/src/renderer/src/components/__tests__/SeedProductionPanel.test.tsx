// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SeedProductionPanel } from '../SeedProductionPanel'

const { invoke, fetchProjects, fetchThreads, fetchQueue } = vi.hoisted(() => ({
  invoke: vi.fn(), fetchProjects: vi.fn(), fetchThreads: vi.fn(), fetchQueue: vi.fn(),
}))
vi.mock('../../lib/client', () => ({ client: { invoke } }))
vi.mock('../../stores/projects', () => ({ useProjectStore: { getState: () => ({ fetch: fetchProjects }) } }))
vi.mock('../../stores/threads', () => ({ useThreadStore: { getState: () => ({ fetch: fetchThreads, fetchQueue }) } }))

const profile = { isDevelopment: true, dataPath: '/dev', productionDatabasePath: '/prod/polycode.db' }
const projects = [{ id: 'p1', name: 'PolyCode' }]
const thread = (id: string) => ({ id, name: `Thread ${id}`, projectId: 'p1', projectName: 'PolyCode', status: 'running', updatedAt: '2026-09-21T00:00:00Z' })

beforeEach(() => {
  vi.clearAllMocks()
  invoke.mockImplementation(async (channel: string, args?: { offset?: number }) => {
    if (channel === 'seed:browse') return { projects, threads: [thread(args?.offset ? 'second' : 'first')], hasMore: !args?.offset }
    if (channel === 'seed:import') return { projectsCreated: 1, threadsCreated: 1, messagesCreated: 3, projectIds: ['p1'] }
    return null
  })
})
afterEach(cleanup)

it('keeps thread selections across pages, imports only selected IDs, and refreshes local stores', async () => {
  render(<SeedProductionPanel profile={profile} />)
  fireEvent.click(await screen.findByRole('checkbox', { name: /Thread first/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  fireEvent.click(await screen.findByRole('checkbox', { name: /Thread second/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Import selected' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('seed:import', {
    sourcePath: '/prod/polycode.db', projectIds: [], threadIds: ['first', 'second'],
  }))
  await screen.findByText(/Imported 1 new projects/)
  expect(fetchProjects).toHaveBeenCalled()
  expect(fetchThreads).toHaveBeenCalledWith('p1')
  expect(fetchQueue).toHaveBeenCalled()
})

it('supports project-only imports without selecting any threads', async () => {
  render(<SeedProductionPanel profile={profile} />)
  await screen.findByRole('checkbox', { name: /Thread first/ })
  fireEvent.click(screen.getByRole('tab', { name: 'Projects only' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'PolyCode' }))
  fireEvent.click(screen.getByRole('button', { name: 'Import selected' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('seed:import', {
    sourcePath: '/prod/polycode.db', projectIds: ['p1'], threadIds: [],
  }))
})

it('shows source failures and allows choosing another database', async () => {
  invoke.mockRejectedValueOnce(new Error('Database not found'))
  render(<SeedProductionPanel profile={profile} />)
  expect((await screen.findByRole('alert')).textContent).toContain('Database not found')
  invoke.mockResolvedValueOnce('/other/production.db')
  fireEvent.click(screen.getByRole('button', { name: 'Choose DB…' }))
  await screen.findByRole('checkbox', { name: /Thread first/ })
  expect(invoke).toHaveBeenLastCalledWith('seed:browse', expect.objectContaining({ sourcePath: '/other/production.db' }))
})
