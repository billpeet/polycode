import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import * as Sentry from '@sentry/electron/main'
import type { UpdateState } from '../shared/types'
import { sendToRenderer } from './app-events'

const FIRST_CHECK_DELAY = 10_000 // 10 seconds after launch
const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000 // every 30 minutes
const MAX_TRANSIENT_RETRIES = 3
const RETRY_BASE_DELAY = 2_000

let getWindow: () => BrowserWindow | null = () => null
let transientRetryCount = 0
let retryTimer: ReturnType<typeof setTimeout> | undefined

let updateState: UpdateState = {
  available: false,
  ready: false,
  checking: false,
  downloading: false,
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTransientUpdateError(error: unknown): boolean {
  const message = getErrorMessage(error)
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : ''

  return [
    'ERR_NAME_NOT_RESOLVED',
    'ERR_INTERNET_DISCONNECTED',
    'ERR_NETWORK_CHANGED',
    'ERR_NETWORK_IO_SUSPENDED',
    'ERR_CONNECTION_TIMED_OUT',
    'ERR_CONNECTION_RESET',
    'ERR_CONNECTION_REFUSED',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
  ].some((token) => code === token || message.includes(token))
    || /\b(?:HTTP(?:Error)?[: ]*)?(?:500|502|503|504)\b/i.test(message)
    || /\b404\b.*\blatest(?:-[^\s/]+)?\.yml\b|\blatest(?:-[^\s/]+)?\.yml\b.*\b404\b/i.test(message)
}

function resetTransientRetries(): void {
  transientRetryCount = 0
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = undefined
}

function handleUpdateError(error: unknown): void {
  const message = getErrorMessage(error)
  if (!isTransientUpdateError(error)) {
    Sentry.captureException(error, { tags: { source: 'auto-updater' } })
    console.error('[updater] error:', message)
    setState({ checking: false, downloading: false, error: message })
    return
  }

  // electron-updater can reject checkForUpdates and emit `error` for the same
  // request. One pending timer makes that pair a single retry attempt.
  if (retryTimer) return

  if (transientRetryCount >= MAX_TRANSIENT_RETRIES) {
    console.error(`[updater] transient failure after ${transientRetryCount} retries:`, message)
    Sentry.captureException(error, {
      tags: { source: 'auto-updater', retriesExhausted: 'true' },
      extra: { retryCount: transientRetryCount },
    })
    setState({ checking: false, downloading: false, error: message })
    return
  }

  const retryNumber = transientRetryCount + 1
  const exponentialDelay = RETRY_BASE_DELAY * (2 ** transientRetryCount)
  const jitteredDelay = Math.round(exponentialDelay * (0.75 + Math.random() * 0.5))
  transientRetryCount = retryNumber
  console.warn(
    `[updater] transient failure; retry ${retryNumber}/${MAX_TRANSIENT_RETRIES} in ${jitteredDelay}ms:`,
    message,
  )
  setState({ checking: false, downloading: false, error: undefined })
  retryTimer = setTimeout(() => {
    retryTimer = undefined
    checkForUpdates()
  }, jitteredDelay)
}

function broadcast(): void {
  const window = getWindow()
  if (window) sendToRenderer(window, 'update:state', { ...updateState })
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
  autoUpdater.checkForUpdates().catch(handleUpdateError)
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
    resetTransientRetries()
    setState({ checking: false, available: false, downloading: false })
  })

  autoUpdater.on('update-available', (info) => {
    resetTransientRetries()
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
    resetTransientRetries()
    setState({
      available: true,
      downloading: false,
      progress: 100,
      ready: true,
      version: info.version,
    })
  })

  autoUpdater.on('error', (err) => {
    handleUpdateError(err)
  })

  // First check shortly after launch, then periodically
  setTimeout(() => {
    checkForUpdates()
    setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL)
  }, FIRST_CHECK_DELAY)
}
