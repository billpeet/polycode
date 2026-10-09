import { app, BrowserWindow, powerMonitor } from 'electron'
import { autoUpdater } from 'electron-updater'
import * as Sentry from '@sentry/electron/main'
import type { UpdateState } from '../shared/types'
import { sendToRenderer } from './app-events'
import { count, recordDuration, recordLog, type TelemetryAttributes } from './observability'

const FIRST_CHECK_DELAY = 10_000 // 10 seconds after launch
const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000 // every 30 minutes
const MAX_TRANSIENT_RETRIES = 3
const RETRY_BASE_DELAY = 2_000
// Once fast retries are spent, recovery retries double from here up to the normal
// check cadence, so a long outage costs one attempt per interval rather than one a minute.
const RECOVERY_DELAY = 60_000
const MAX_RECOVERY_DELAY = UPDATE_CHECK_INTERVAL
const PERSISTENT_FAILURE_WINDOW = 30 * 60 * 1000

const TRANSIENT_ERROR_CODES = [
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
]

let getWindow: () => BrowserWindow | null = () => null
let transientRetryCount = 0
let retryTimer: ReturnType<typeof setTimeout> | undefined
let suspended = false
let resumeTimer: ReturnType<typeof setTimeout> | undefined
let firstTransientFailure: number | undefined
let persistentFailureReported = false
let outageAttributes: TelemetryAttributes = {}

let updateState: UpdateState = {
  available: false,
  ready: false,
  checking: false,
  downloading: false,
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Names the recoverable condition behind an updater failure, or returns undefined
 * when the failure is not one worth retrying. The name is low-cardinality so it
 * can be a metric attribute.
 */
function transientUpdateErrorCode(error: unknown): string | undefined {
  const message = getErrorMessage(error)
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : ''

  // electron-updater wraps network failures in its own codes (for example
  // ERR_UPDATER_LATEST_VERSION_NOT_FOUND) but keeps the cause in the message.
  const networkCode = TRANSIENT_ERROR_CODES.find((token) => code === token || message.includes(token))
  if (networkCode) return networkCode
  const serverStatus = /\b(?:HTTP(?:Error)?[: ]*)?(500|502|503|504)\b/i.exec(message)?.[1]
  if (serverStatus) return `HTTP_${serverStatus}`
  if (/\b404\b.*\blatest(?:-[^\s/]+)?\.yml\b|\blatest(?:-[^\s/]+)?\.yml\b.*\b404\b/i.test(message)) {
    return 'CHANNEL_FILE_404'
  }
  return undefined
}

/**
 * The host named in an updater error, when there is one. Only the hostname is
 * kept: download URLs can carry signed query strings. A DNS failure on the
 * release feed arrives as a bare `net::ERR_NAME_NOT_RESOLVED` with no URL.
 */
function updateHostFromError(error: unknown): string | undefined {
  const url = /https?:\/\/[^\s)'"]+/.exec(getErrorMessage(error))?.[0]
  if (!url) return undefined
  try {
    return new URL(url).hostname || undefined
  } catch {
    return undefined
  }
}

function cancelPendingRetry(): void {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = undefined
}

/** Only successful metadata (no update) or artifact download ends an outage. */
function recoverTransientOutage(): void {
  if (firstTransientFailure !== undefined) {
    const failureDurationMs = Date.now() - firstTransientFailure
    count('polycode.updater.recovered', outageAttributes)
    recordDuration('polycode.updater.outage_duration', failureDurationMs, outageAttributes)
    recordLog('INFO', 'Auto-updater connectivity recovered', {
      ...outageAttributes, retryCount: transientRetryCount, failureDurationMs,
    })
  }
  transientRetryCount = 0
  firstTransientFailure = undefined
  persistentFailureReported = false
  outageAttributes = {}
  cancelPendingRetry()
}

function handleUpdateError(error: unknown): void {
  const transientCode = transientUpdateErrorCode(error)
  if (!transientCode) {
    cancelPendingRetry()
    const message = getErrorMessage(error)
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
  const updateHost = updateHostFromError(error)
  outageAttributes = {
    updateErrorCode: transientCode,
    ...(updateHost ? { updateHost } : {}),
  }
  count('polycode.updater.transient_failure', outageAttributes)

  if (!persistentFailureReported && Date.now() - firstTransientFailure >= PERSISTENT_FAILURE_WINDOW) {
    persistentFailureReported = true
    // Fleet availability belongs in operational telemetry, not Sentry issues.
    // Never send the original error: it may contain signed download URLs.
    count('polycode.updater.persistent_outage', outageAttributes)
    recordLog('WARN', 'Auto-updater connectivity outage persists', {
      ...outageAttributes,
      retryCount: transientRetryCount,
      failureDurationMs: Date.now() - firstTransientFailure,
    })
  }

  const retryNumber = transientRetryCount + 1
  const exhausted = transientRetryCount >= MAX_TRANSIENT_RETRIES
  const exponentialDelay = exhausted
    ? Math.min(RECOVERY_DELAY * (2 ** (transientRetryCount - MAX_TRANSIENT_RETRIES)), MAX_RECOVERY_DELAY)
    : RETRY_BASE_DELAY * (2 ** transientRetryCount)
  const jitteredDelay = Math.round(exponentialDelay * (0.75 + Math.random() * 0.5))
  transientRetryCount = retryNumber
  console.warn(
    `[updater] transient failure; ${exhausted ? 'recovery' : 'fast'} retry ${retryNumber} in ${jitteredDelay}ms:`,
    outageAttributes,
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
    cancelPendingRetry()
    if (resumeTimer) clearTimeout(resumeTimer)
    resumeTimer = undefined
  })
  powerMonitor.on('resume', () => {
    suspended = false
    cancelPendingRetry()
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
    recoverTransientOutage()
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
    recoverTransientOutage()
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
