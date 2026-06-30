import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import * as Sentry from '@sentry/electron/main'
import type { UpdateState } from '../shared/types'

const FIRST_CHECK_DELAY = 10_000 // 10 seconds after launch
const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000 // every 30 minutes

let getWindow: () => BrowserWindow | null = () => null

let updateState: UpdateState = {
  available: false,
  ready: false,
  checking: false,
  downloading: false,
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isExpectedNetworkError(error: unknown): boolean {
  const message = getErrorMessage(error)
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : ''

  return [
    'ERR_NAME_NOT_RESOLVED',
    'ERR_INTERNET_DISCONNECTED',
    'ERR_NETWORK_CHANGED',
    'ERR_CONNECTION_TIMED_OUT',
    'ERR_CONNECTION_RESET',
    'ERR_CONNECTION_REFUSED',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
  ].some((token) => code === token || message.includes(token))
}

function broadcast(): void {
  try {
    getWindow()?.webContents.send('update:state', { ...updateState })
  } catch {
    // Window may not be ready yet
  }
}

function setState(partial: Partial<UpdateState>): void {
  updateState = { ...updateState, ...partial }
  broadcast()
}

export function getUpdateState(): UpdateState {
  return { ...updateState }
}

export function checkForUpdates(): void {
  if (!app.isPackaged) return
  autoUpdater.checkForUpdates().catch((err) => {
    const message = getErrorMessage(err)
    const log = isExpectedNetworkError(err) ? console.warn : console.error
    log('[updater] check failed:', message)
    setState({
      checking: false,
      error: message,
    })
  })
}

/** Quit and install the downloaded update. Returns false if no update is ready. */
export function applyUpdate(): boolean {
  if (!updateState.ready) return false
  // Defer so the IPC reply reaches the renderer before the app quits
  setImmediate(() => autoUpdater.quitAndInstall())
  return true
}

export function initUpdater(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
  if (!app.isPackaged) return // No updates in dev

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    setState({ checking: true, error: undefined })
  })

  autoUpdater.on('update-not-available', () => {
    setState({ checking: false, available: false, downloading: false })
  })

  autoUpdater.on('update-available', (info) => {
    setState({
      checking: false,
      available: true,
      downloading: true,
      progress: 0,
      version: info.version,
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    setState({ downloading: true, progress: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    setState({
      available: true,
      downloading: false,
      progress: 100,
      ready: true,
      version: info.version,
    })
  })

  autoUpdater.on('error', (err) => {
    if (isExpectedNetworkError(err)) {
      console.warn('[updater] network unavailable:', err.message)
    } else {
      Sentry.captureException(err, { tags: { source: 'auto-updater' } })
      console.error('[updater] error:', err.message)
    }

    setState({
      checking: false,
      downloading: false,
      error: err.message,
    })
  })

  // First check shortly after launch, then periodically
  setTimeout(() => {
    checkForUpdates()
    setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL)
  }, FIRST_CHECK_DELAY)
}
