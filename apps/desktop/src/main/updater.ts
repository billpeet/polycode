import { app, BrowserWindow, powerMonitor } from 'electron'
import { autoUpdater } from 'electron-updater'
import * as Sentry from '@sentry/electron/main'
import type { UpdateState } from '../shared/types'
import { sendToRenderer } from './app-events'
import { count } from './observability'

const FIRST_CHECK_DELAY = 10_000 // 10 seconds after launch
const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000 // every 30 minutes
const MAX_TRANSIENT_RETRIES = 3
const RETRY_BASE_DELAY = 2_000
const RECOVERY_DELAY = 60_000
const PERSISTENT_FAILURE_WINDOW = 30 * 60 * 1000

let getWindow: () => BrowserWindow | null = () => null
let transientRetryCount = 0
let retryTimer: ReturnType<typeof setTimeout> | undefined
let suspended = false
let resumeTimer: ReturnType<typeof setTimeout> | undefined
let firstTransientFailure: number | undefined
let persistentFailureReported = false

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
  firstTransientFailure = undefined
  persistentFailureReported = false
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = undefined
}

function handleUpdateError(error: unknown): void {
  const message = getErrorMessage(error)
  if (!isTransientUpdateError(error)) {
    resetTransientRetries()
    Sentry.captureException(error, { tags: { source: 'auto-updater' } })
    console.error('[updater] error:', message)
    setState({ checking: false, downloading: false, error: message })
    return
  }

  // electron-updater can reject checkForUpdates and emit `error` for the same
  // request. One pending timer makes that pair a single retry attempt.
  if (retryTimer) return
  setState({ checking: false, downloading: false, error: undefined })
  if (suspended || resumeTimer) return
  firstTransientFailure ??= Date.now()
  count('polycode.updater.transient_failure')

  if (!persistentFailureReported && Date.now() - firstTransientFailure >= PERSISTENT_FAILURE_WINDOW) {
    persistentFailureReported = true
    Sentry.captureException(error, {
      tags: { source: 'auto-updater', retriesExhausted: 'true', persistent: 'true' },
      extra: { retryCount: transientRetryCount, failureDurationMs: Date.now() - firstTransientFailure },
    })
  }

  const retryNumber = transientRetryCount + 1
  const exhausted = transientRetryCount >= MAX_TRANSIENT_RETRIES
  const exponentialDelay = exhausted ? RECOVERY_DELAY : RETRY_BASE_DELAY * (2 ** transientRetryCount)
  const jitteredDelay = Math.round(exponentialDelay * (0.75 + Math.random() * 0.5))
  transientRetryCount = retryNumber
  console.warn(
    `[updater] transient failure; ${exhausted ? 'recovery' : 'fast'} retry ${retryNumber} in ${jitteredDelay}ms:`,
    message,
  )
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
  if (!app.isPackaged || suspended || resumeTimer || retryTimer) return
  autoUpdater.checkForUpdates().catch(handleUpdateError)
}

/** Quit and install the downloaded update. Returns false if no update is ready. */
export function applyUpdate(): boolean {
  if (!updateState.ready) return false
  // Defer so the IPC reply reaches the renderer before the app quits
  setImmediate(() => autoUpdater.quitAndInstall(true, true))
  return true
}

export function initUpdater(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
  if (!app.isPackaged) return // No updates in dev

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  powerMonitor.on('suspend', () => {
    suspended = true
    resetTransientRetries()
    if (resumeTimer) clearTimeout(resumeTimer)
    resumeTimer = undefined
  })
  powerMonitor.on('resume', () => {
    suspended = false
    resetTransientRetries()
    if (resumeTimer) clearTimeout(resumeTimer)
    // Give the OS a bounded grace period to restore DNS and network routes.
    // If connectivity is still unavailable, the slower recovery loop takes over.
    count('polycode.updater.resume_deferred')
    resumeTimer = setTimeout(() => {
      resumeTimer = undefined
      checkForUpdates()
    }, RECOVERY_DELAY)
  })

  autoUpdater.on('checking-for-update', () => {
    setState({ checking: true, error: undefined })
  })

  autoUpdater.on('update-not-available', () => {
    resetTransientRetries()
    setState({
      checking: false,
      available: false,
      downloading: false,
      ready: false,
      progress: undefined,
      version: undefined,
    })
  })

  autoUpdater.on('update-available', (info) => {
    // Metadata success does not mean the artifact download has recovered.
    setState({
      checking: false,
      available: true,
      downloading: true,
      ready: false,
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
