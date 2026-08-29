import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBrowserStore } from '../browser'
import { useToastStore } from '../toast'
import { useUiStore } from '../ui'

describe('browser store stale locations', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { api: { invoke } })
    useBrowserStore.setState({
      tabsByLocation: {},
      activeByLocation: {},
      visibleByLocation: {},
      sessionByLocation: {},
    })
    useToastStore.setState({ toasts: [] })
    useUiStore.setState({
      locationAuxTabByLocation: {},
      locationAuxTabRequestByLocation: {},
    })
  })

  it('removes persisted browser state when its location no longer exists', async () => {
    useBrowserStore.setState({
      tabsByLocation: {
        deleted: [{
          id: 'persisted-tab',
          url: 'http://localhost:5173',
          title: 'App',
          faviconUrl: null,
          loading: false,
          error: null,
          canGoBack: false,
          canGoForward: false,
        }],
      },
      activeByLocation: { deleted: 'persisted-tab' },
      visibleByLocation: { deleted: false },
    })
    useUiStore.setState({ locationAuxTabByLocation: { deleted: 'browser' } })
    invoke.mockImplementation(async (channel: string) =>
      channel === 'browser:prepareSession'
        ? { ok: false, code: 'LOCATION_NOT_FOUND' }
        : undefined,
    )

    await useBrowserStore.getState().open('deleted')

    const state = useBrowserStore.getState()
    expect(state.tabsByLocation.deleted).toBeUndefined()
    expect(state.activeByLocation.deleted).toBeUndefined()
    expect(state.visibleByLocation.deleted).toBeUndefined()
    expect(state.sessionByLocation.deleted).toBeUndefined()
    expect(useUiStore.getState().locationAuxTabByLocation.deleted).toBeUndefined()
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ type: 'info', message: 'That project location no longer exists.' }),
    ])
  })
})
