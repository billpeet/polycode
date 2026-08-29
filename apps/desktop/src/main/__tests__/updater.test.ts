import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (...args: unknown[]) => void

const H = vi.hoisted(() => ({
  listeners: new Map<string, Listener>(),
  checkForUpdates: vi.fn<() => Promise<unknown>>(),
  captureException: vi.fn(),
  send: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: class {},
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: H.checkForUpdates,
    quitAndInstall: vi.fn(),
    on: (event: string, listener: Listener) => H.listeners.set(event, listener),
  },
}))

vi.mock('@sentry/electron/main', () => ({ captureException: H.captureException }))

describe('auto-updater transient failures', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    H.listeners.clear()
    H.checkForUpdates.mockReset().mockResolvedValue(undefined)
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

  it('reports a recoverable failure only after bounded retries are exhausted', async () => {
    await initialise()
    vi.clearAllTimers() // Exclude the independent first scheduled update check.
    const error = new Error('HttpError: 500 Internal Server Error')

    for (const delay of [2_000, 4_000, 8_000]) {
      H.listeners.get('error')?.(error)
      await vi.advanceTimersByTimeAsync(delay)
    }
    H.listeners.get('error')?.(error)

    expect(H.checkForUpdates).toHaveBeenCalledTimes(3)
    expect(H.captureException).toHaveBeenCalledTimes(1)
    expect(H.captureException).toHaveBeenCalledWith(error, expect.objectContaining({
      tags: expect.objectContaining({ source: 'auto-updater', retriesExhausted: 'true' }),
    }))
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
})
