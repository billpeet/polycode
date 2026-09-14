// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useYouTrackStore } from '../youtrack'
import { YouTrackSettingsPanel } from '../../components/YouTrackSettingsDialog'
import type { YouTrackServer } from '../../types/ipc'

const invoke = vi.fn()
const cached: YouTrackServer[] = [{
  id: 'server-1', name: 'Team tracker', url: 'https://tracker.example.com', token: '',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
}]

beforeEach(() => {
  invoke.mockReset()
  Object.assign(window, { api: { invoke } })
  useYouTrackStore.setState(useYouTrackStore.getInitialState())
})
afterEach(cleanup)

describe('YouTrack loading failures', () => {
  it.each([
    'RemoteUnavailableError: Remote host is unavailable',
    "Error invoking remote method 'youtrack:servers:list': RemoteRequestTimeoutError: Request timed out",
    'REMOTE_UNAVAILABLE',
    'REMOTE_REQUEST_TIMEOUT',
  ])('retains last-good servers and exposes degraded state for %s', async (message) => {
    useYouTrackStore.setState({ servers: cached })
    invoke.mockRejectedValue(new Error(message))
    await expect(useYouTrackStore.getState().fetch()).resolves.toBeUndefined()
    expect(useYouTrackStore.getState()).toMatchObject({ servers: cached, loading: false, unavailable: true, error: null })
  })

  it.each([
    'SQLITE_CORRUPT: database disk image is malformed',
    "Error invoking remote method 'youtrack:servers:list': TypeError: fetch failed",
  ])('surfaces unclassified failures in settings and recovers on retry: %s', async (message) => {
    useYouTrackStore.setState({ servers: cached })
    invoke.mockRejectedValueOnce(new Error(message))
    await expect(useYouTrackStore.getState().fetch()).resolves.toBeUndefined()
    expect(useYouTrackStore.getState()).toMatchObject({ servers: cached, loading: false, unavailable: false, error: expect.stringContaining(message) })
    render(<YouTrackSettingsPanel />)
    expect(screen.getByRole('alert').textContent).toContain(message)
    expect(screen.getByText('Team tracker')).toBeTruthy()
    invoke.mockResolvedValueOnce([])
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(useYouTrackStore.getState()).toMatchObject({ servers: [], loading: false, unavailable: false, error: null })
  })

  it('shows remote unavailability without an unexpected-error alert', async () => {
    invoke.mockRejectedValue(new Error('RemoteUnavailableError: offline'))
    await useYouTrackStore.getState().fetch()
    render(<YouTrackSettingsPanel />)
    expect(screen.getByRole('status').textContent).toContain('remote connection is unavailable or timed out')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(useYouTrackStore.getState().servers).toEqual([])
  })

  it('shows loading and clears degraded state after a successful read', async () => {
    useYouTrackStore.setState({ unavailable: true })
    let finish!: (servers: YouTrackServer[]) => void
    invoke.mockImplementation(() => new Promise<YouTrackServer[]>((resolve) => { finish = resolve }))
    const loading = useYouTrackStore.getState().fetch()
    render(<YouTrackSettingsPanel />)
    expect(screen.getByRole('status').textContent).toContain('Loading YouTrack servers')
    await act(async () => { finish(cached); await loading })
    expect(screen.queryByRole('status')).toBeNull()
    expect(useYouTrackStore.getState()).toMatchObject({ servers: cached, loading: false, unavailable: false, error: null })
  })
})
