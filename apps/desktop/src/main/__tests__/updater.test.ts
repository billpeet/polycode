import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (...args: unknown[]) => void

const H = vi.hoisted(() => ({
  listeners: new Map<string, Listener>(),
  powerListeners: new Map<string, Listener>(),
  count: vi.fn(),
  checkForUpdates: vi.fn<() => Promise<unknown>>(),
  quitAndInstall: vi.fn(),
  captureException: vi.fn(),
  send: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: class {},
  powerMonitor: { on: (event: string, listener: Listener) => H.powerListeners.set(event, listener) },
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: H.checkForUpdates,
    quitAndInstall: H.quitAndInstall,
    on: (event: string, listener: Listener) => H.listeners.set(event, listener),
  },
}))

vi.mock('@sentry/electron/main', () => ({ captureException: H.captureException }))
vi.mock('../observability', () => ({ count: H.count }))

describe('auto-updater transient failures', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    H.listeners.clear()
    H.powerListeners.clear()
    H.count.mockReset()
    H.checkForUpdates.mockReset().mockResolvedValue(undefined)
    H.quitAndInstall.mockReset()
    H.captureException.mockReset()
    H.send.mockReset()
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function initialise() {
    const updater = await import('../updater')
    updater.initUpdater(() => ({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: H.send,
      },
    }) as unknown as import('electron').BrowserWindow)
    return updater
  }

  it.each([
    Object.assign(new Error('net::ERR_NETWORK_IO_SUSPENDED'), { code: 'ERR_NETWORK_IO_SUSPENDED' }),
    new Error('HttpError: 504 Gateway Timeout'),
    new Error('Cannot download latest.yml: status 404'),
    Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
  ])('retries recoverable failure without reporting it: %s', async (error) => {
    const updater = await initialise()
    H.listeners.get('update-available')?.({ version: '1.2.3' })
    H.listeners.get('download-progress')?.({ percent: 41 })

    H.listeners.get('error')?.(error)

    expect(H.captureException).not.toHaveBeenCalled()
    expect(updater.getUpdateState()).toMatchObject({
      available: true,
      version: '1.2.3',
      progress: 41,
      checking: false,
      downloading: false,
    })
    expect(updater.getUpdateState().error).toBeUndefined()
    expect(H.checkForUpdates).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_000)
    expect(H.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('keeps exhausted transient retries operational and retries later', async () => {
    await initialise()
    vi.clearAllTimers() // Exclude the independent first scheduled update check.
    const error = new Error('HttpError: 500 Internal Server Error')

    for (const delay of [2_000, 4_000, 8_000]) {
      H.listeners.get('error')?.(error)
      await vi.advanceTimersByTimeAsync(delay)
    }
    H.listeners.get('error')?.(error)

    expect(H.checkForUpdates).toHaveBeenCalledTimes(3)
    expect(H.captureException).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(H.checkForUpdates).toHaveBeenCalledTimes(4)
  })

  it('defers checks after resume while DNS recovers for longer than the fast retry budget', async () => {
    const updater = await initialise()
    H.checkForUpdates.mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED'))
    H.powerListeners.get('suspend')?.()
    H.powerListeners.get('resume')?.()
    updater.checkForUpdates()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(H.checkForUpdates).not.toHaveBeenCalled()
    H.checkForUpdates.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(H.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(H.captureException).not.toHaveBeenCalled()
  })

  it('reports a non-transient updater error immediately', async () => {
    await initialise()
    const error = new Error('sha512 checksum mismatch')

    H.listeners.get('error')?.(error)

    expect(H.captureException).toHaveBeenCalledWith(error, {
      tags: { source: 'auto-updater' },
    })
    expect(H.checkForUpdates).not.toHaveBeenCalled()
  })

  it('reports persistent outages once and resets after recovery', async () => {
    await initialise()
    vi.clearAllTimers()
    const error = new Error('HttpError: 504 Gateway Timeout')
    H.checkForUpdates.mockImplementation(async () => {
      H.listeners.get('error')?.(error)
      throw error // The event and rejection describe the same failed request.
    })
    H.listeners.get('error')?.(error)
    await vi.advanceTimersByTimeAsync(29 * 60_000)
    expect(H.captureException).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(H.captureException).toHaveBeenCalledTimes(1)
    expect(H.captureException).toHaveBeenCalledWith(error, expect.objectContaining({
      tags: expect.objectContaining({ persistent: 'true' }),
    }))
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(H.captureException).toHaveBeenCalledTimes(1)
    H.listeners.get('update-not-available')?.()
    H.checkForUpdates.mockClear()
    H.listeners.get('error')?.(error)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(H.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(H.captureException).toHaveBeenCalledTimes(1)
    expect(H.count).toHaveBeenCalledWith('polycode.updater.transient_failure')
  })

  it('does not restart the fast retry budget when metadata succeeds but downloads fail', async () => {
    await initialise()
    vi.clearAllTimers()
    for (const delay of [2_000, 4_000, 8_000]) {
      H.listeners.get('update-available')?.({ version: '1.2.3' })
      H.listeners.get('error')?.(new Error('write EPIPE'))
      await vi.advanceTimersByTimeAsync(delay)
    }
    H.listeners.get('update-available')?.({ version: '1.2.3' })
    H.listeners.get('error')?.(new Error('write EPIPE'))
    await vi.advanceTimersByTimeAsync(59_999)
    expect(H.checkForUpdates).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(H.checkForUpdates).toHaveBeenCalledTimes(4)
  })

  it('cancels pending retries during suspend and restarts the grace period on repeated resume', async () => {
    const updater = await initialise()
    H.listeners.get('error')?.(new Error('net::ERR_NAME_NOT_RESOLVED'))
    H.powerListeners.get('suspend')?.()
    updater.checkForUpdates()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(H.checkForUpdates).not.toHaveBeenCalled()
    H.powerListeners.get('resume')?.()
    await vi.advanceTimersByTimeAsync(30_000)
    H.powerListeners.get('resume')?.()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(H.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(H.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('does not apply an older downloaded update after a newer release is found', async () => {
    const updater = await initialise()

    H.listeners.get('update-available')?.({ version: '1.2.3' })
    H.listeners.get('update-downloaded')?.({ version: '1.2.3' })
    expect(updater.getUpdateState()).toMatchObject({ version: '1.2.3', ready: true })

    H.listeners.get('update-available')?.({ version: '1.2.4' })

    expect(updater.getUpdateState()).toMatchObject({
      version: '1.2.4',
      ready: false,
      downloading: true,
    })
    expect(updater.applyUpdate()).toBe(false)
    expect(H.quitAndInstall).not.toHaveBeenCalled()
  })

  it('installs a downloaded update silently', async () => {
    const updater = await initialise()
    H.listeners.get('update-downloaded')?.({ version: '1.2.4' })

    expect(updater.applyUpdate()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(H.quitAndInstall).toHaveBeenCalledWith(true, true)
  })
})
