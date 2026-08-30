import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUiStore } from '../ui'

const LAYOUT_MODE_SETTING_KEY = 'layout:mode'

describe('layout mode', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { api: { invoke } })
    useUiStore.setState({ layoutMode: 'split', chatTabActiveByThread: {}, activeAuxTabByThread: {} })
  })

  it('defaults to the split two-pane view', () => {
    expect(useUiStore.getState().layoutMode).toBe('split')
  })

  it('persists the mode when it changes', () => {
    useUiStore.getState().setLayoutMode('full')

    expect(useUiStore.getState().layoutMode).toBe('full')
    expect(invoke).toHaveBeenCalledWith('settings:set', LAYOUT_MODE_SETTING_KEY, 'full')
  })

  it('toggles between the two modes', () => {
    useUiStore.getState().toggleLayoutMode()
    expect(useUiStore.getState().layoutMode).toBe('full')

    useUiStore.getState().toggleLayoutMode()
    expect(useUiStore.getState().layoutMode).toBe('split')
  })

  it('restores a persisted mode', async () => {
    invoke.mockResolvedValueOnce('full')

    await useUiStore.getState().loadLayoutMode()

    expect(useUiStore.getState().layoutMode).toBe('full')
  })

  it('ignores an unrecognised persisted value rather than rendering an unknown layout', async () => {
    invoke.mockResolvedValueOnce('sideways')

    await useUiStore.getState().loadLayoutMode()

    expect(useUiStore.getState().layoutMode).toBe('split')
  })

  it('survives a settings read failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    invoke.mockRejectedValueOnce(new Error('db closed'))

    await expect(useUiStore.getState().loadLayoutMode()).resolves.toBeUndefined()
    expect(useUiStore.getState().layoutMode).toBe('split')

    consoleError.mockRestore()
  })

  it('treats chat as the active tab until another tab is chosen', () => {
    expect(useUiStore.getState().isChatTabActive('thread-1')).toBe(true)

    useUiStore.getState().setChatTabActive('thread-1', false)

    expect(useUiStore.getState().isChatTabActive('thread-1')).toBe(false)
    // Chat activity is per thread — another thread is unaffected.
    expect(useUiStore.getState().isChatTabActive('thread-2')).toBe(true)
  })

  it('does not persist chat tab selection, which is view state', () => {
    useUiStore.getState().setChatTabActive('thread-1', false)

    expect(invoke).not.toHaveBeenCalled()
  })
})
