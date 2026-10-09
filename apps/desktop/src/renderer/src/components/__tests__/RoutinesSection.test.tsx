// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import RoutinesSection from '../sidebar/RoutinesSection'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn() }))
vi.mock('../RoutineEditModal', () => ({ default: () => null }))
vi.mock('../../lib/locale', () => ({ formatDateTime: () => '' }))
beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.on.mockReset().mockReturnValue(() => {})
  Object.assign(window, { api: mocks })
})
afterEach(cleanup)

it.each(['REMOTE_UNAVAILABLE', 'REMOTE_REQUEST_TIMEOUT'])('keeps mounted routine data during %s without unhandled rejections', async (code) => {
  mocks.invoke.mockImplementation(async (channel: string) =>
    channel === 'routines:list' ? [{ id: 'routine', name: 'Cached routine', enabled: true }] : [])
  const unhandled = vi.fn()
  window.addEventListener('unhandledrejection', unhandled)
  try {
    render(<RoutinesSection projectId="p" onSelectThread={() => {}} />)
    fireEvent.click(await screen.findByText('Routines (1)'))
    expect(screen.getByText('Cached routine')).toBeTruthy()
    // A partial read must retain the entire previous snapshot.
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'routines:list') return [{ id: 'fresh', name: 'Partial refresh', enabled: true }]
      throw new Error(`[${code}] Work stalled`)
    })
    await act(async () => { mocks.on.mock.calls[0][1]() })
    expect(screen.getByText('Cached routine')).toBeTruthy()
    expect(screen.queryByText('Partial refresh')).toBeNull()
    expect(unhandled).not.toHaveBeenCalled()
  } finally { window.removeEventListener('unhandledrejection', unhandled) }
})

it('handles IPC compatibility errors and hides routine actions', async () => {
  mocks.invoke.mockRejectedValue(new Error("Error invoking remote method: [REMOTE_UNSUPPORTED_CHANNEL] Upgrade the Remote Host"))
  render(<RoutinesSection projectId="p" onSelectThread={() => {}} />)
  expect(await screen.findByText('Upgrade the Remote Host to use routines.')).toBeTruthy()
  expect(screen.queryByText('Add routine')).toBeNull()
})

it('handles a failed run read and recovers on retry', async () => {
  mocks.invoke.mockImplementation(async (channel: string) => {
    if (channel === 'routines:list') return [{ id: 'routine' }]
    throw new Error('Connection lost')
  })
  render(<RoutinesSection projectId="p" onSelectThread={() => {}} />)
  expect(await screen.findByText('Unable to load routines: Connection lost')).toBeTruthy()
  mocks.invoke.mockResolvedValue([])
  fireEvent.click(screen.getByText('Retry'))
  expect(await screen.findByText('Add routine')).toBeTruthy()
})

it('handles failures from event refreshes', async () => {
  mocks.invoke.mockResolvedValue([])
  render(<RoutinesSection projectId="p" onSelectThread={() => {}} />)
  await screen.findByText('Add routine')
  mocks.invoke.mockRejectedValue(new Error('Host offline'))
  await act(async () => { mocks.on.mock.calls[0][1]() })
  expect(await screen.findByText('Unable to load routines: Host offline')).toBeTruthy()
})
