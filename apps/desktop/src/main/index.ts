import { app, BrowserWindow, shell, protocol, net, dialog, ipcMain, powerMonitor } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import * as Sentry from '@sentry/electron/main'
import { initUpdater } from './updater'
import { initDb, closeDb } from './db/index'
import { resetRunningThreads, hasRunningThreads } from './db/queries'
import { registerIpcHandlers } from './ipc/handlers'
import { cleanupAllAttachments, getAttachmentDir } from './attachments'
import { ptyManager } from './terminal/manager'
import { SENTRY_DSN } from '../shared/sentry.config'
import { startWebhookServer, stopWebhookServer } from './webhook/server'
import { readWebhookConfig } from './webhook/config'
import { startRemoteControlServer, stopRemoteControlServer } from './remote/server'
import { readRemoteServerConfig } from './remote/config'
import { stopRemoteControlClient } from './remote/client'
import { browserSessionManager } from './browser/manager'
import { startPlanWatcher, stopPlanWatcher } from './plans'
import { stopAllFileWatches } from './file-watch'
import { sessionManager } from './session/manager'
import { RunLifecycle } from './runs/lifecycle'
import { sqliteRunStore } from './runs/adapters/store'
import { createRunGit } from './runs/adapters/git'
import { createRunWorktrees } from './runs/adapters/worktrees'
import { createRunSessions } from './runs/adapters/sessions'
import { electronRunNotifier } from './runs/adapters/notifier'
import { emitAppEvent, sendToRenderer } from './app-events'
import { commandManager } from './commands/manager'
import { flushAppLogs, installAppLogger, writeFatalLog, writeRendererLog } from './app-logger'
import { installIpcProfiling, installMainThreadStallMonitor } from './perf'
import {
  initializeObservability,
  observabilityConfigFromEnv,
  recordDuration,
  shutdownObservability,
  type TelemetryAttributes,
} from './observability'

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production'

installAppLogger()
installMainThreadStallMonitor()

ipcMain.on('log:write', (_event, payload: unknown) => {
  if (!payload || typeof payload !== 'object') return

  const candidate = payload as Partial<{
    source: 'main' | 'renderer'
    level: 'log' | 'info' | 'warn' | 'error' | 'debug'
    timestamp: string
    messages: string[]
  }>

  if (candidate.source !== 'renderer') return
  if (!candidate.level || !candidate.timestamp || !Array.isArray(candidate.messages)) return

  writeRendererLog({
    source: 'renderer',
    level: candidate.level,
    timestamp: candidate.timestamp,
    messages: candidate.messages.map((message) => String(message)),
  })
})

ipcMain.on('telemetry:duration', (_event, payload: unknown) => {
  if (!payload || typeof payload !== 'object') return
  const candidate = payload as Partial<{
    name: string
    durationMs: number
    attributes: TelemetryAttributes
  }>
  if (!candidate.name?.startsWith('polycode.') || typeof candidate.durationMs !== 'number') return

  const attributes = Object.fromEntries(
    Object.entries(candidate.attributes ?? {})
      .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
      .slice(0, 12)
      .map(([key, value]) => [key.slice(0, 64), typeof value === 'string' ? value.slice(0, 128) : value])
  ) as TelemetryAttributes
  recordDuration(candidate.name.slice(0, 128), candidate.durationMs, { process: 'renderer', ...attributes })
})

let fatalDialogShown = false

function reportFatalProcessError(kind: string, error: unknown): void {
  writeFatalLog(kind, error)

  if (!isDev) {
    Sentry.captureException(error, {
      level: 'fatal',
      tags: { source: kind },
    })
  }

  if (fatalDialogShown || !app.isReady()) return
  fatalDialogShown = true

  const message = error instanceof Error ? error.message : String(error)
  dialog.showErrorBox(
    'PolyCode hit an unexpected error',
    `${message}\n\nDetails were written to the app logs.`
  )
}

// EPIPE errors from network streams (e.g. electron-updater downloading latest.yml)
// can escape electron-updater's own error handler and surface as uncaught exceptions.
// They are not fatal — absorb them and let Sentry record them at warning level.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') {
    console.warn('[main] EPIPE on network stream (ignored):', err.message)
    if (!isDev) Sentry.captureException(err, { level: 'warning', tags: { source: 'epipe' } })
    return
  }

  if (err.code === 'EPERM' && /\bwatch\b/i.test(err.message)) {
    console.warn('[main] EPERM from filesystem watcher (ignored):', err.message)
    if (!isDev) Sentry.captureException(err, { level: 'warning', tags: { source: 'fs-watch' } })
    return
  }

  reportFatalProcessError('uncaughtException', err)
})

process.on('unhandledRejection', (reason) => {
  reportFatalProcessError('unhandledRejection', reason)
})

if (!isDev) {
  Sentry.init({
    dsn: SENTRY_DSN,
    release: `polycode@${process.env.npm_package_version ?? '0.0.0'}`,
    environment: 'production',
    tracesSampleRate: 0.1,
  })
}

let isQuitting = false
let runLifecycle: RunLifecycle | null = null

// Register custom protocol for serving attachment files
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'attachment',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
    },
  },
])

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0f0f0f',
    show: false,
    autoHideMenuBar: true,
    frame: false,
    icon: join(__dirname, '../../resources/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The internal browser panel embeds remote pages via <webview> guests,
      // one persisted session partition per project location.
      webviewTag: true,
    }
  })

  win.once('ready-to-show', () => {
    win.show()
    if (isDev) {
      win.webContents.openDevTools()
    }
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    win.show()
    dialog.showErrorBox(
      'Failed to load',
      `The app failed to load (${errorCode}: ${errorDescription}).\n\nThis is likely a packaging issue. Please report it.`
    )
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    win.show()
    dialog.showErrorBox(
      'Renderer crashed',
      `The renderer process crashed (reason: ${details.reason}).\n\nPlease restart the app.`
    )
  })

  win.on('close', async (event: Electron.Event) => {
    if (isQuitting) return

    const threadsRunning = hasRunningThreads()
    const commandsRunning = commandManager.hasRunning()

    if (threadsRunning || commandsRunning) {
      event.preventDefault()

      const parts: string[] = []
      if (threadsRunning) parts.push('threads')
      if (commandsRunning) parts.push('project commands')
      const what = parts.join(' and ')

      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Still running',
        message: `One or more ${what} are still running. Closing will terminate them.`,
        buttons: ['Close Anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      })
      if (response !== 0) return

      isQuitting = true
      win.close()
    }
  })

  // Open external links in default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Guest pages (the internal browser): popups cannot become unmanaged
  // windows, so they open as another tab of the same location's browser
  // panel. Everything else about guests — navigation, permissions — is
  // handled by their session in browser/manager.ts.
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return
    contents.setWindowOpenHandler(({ url }) => {
      const locationId = browserSessionManager.locationIdForSession(contents.session)
      if (locationId && /^https?:\/\//i.test(url)) {
        sendToRenderer(win, 'browser:popup-request', locationId, url)
      }
      return { action: 'deny' }
    })
  })

  // Intercept in-page navigation (plain <a href> clicks) and open externally
  win.webContents.on('will-navigate', (event, url) => {
    const appUrl = isDev
      ? (process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost:5173')
      : pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
    if (!url.startsWith(appUrl)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  if (isDev) {
    // electron-vite dev server
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost:5173')
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  const telemetryEnabled = initializeObservability(observabilityConfigFromEnv(app.getVersion()))
  console.info(`[telemetry] OTLP export ${telemetryEnabled ? 'enabled' : 'disabled'}`)
  installIpcProfiling()

  // Register protocol handler for attachment:// URLs
  // Maps attachment://threadId/filename to the actual temp file
  protocol.handle('attachment', (request) => {
    // URL format: attachment://threadId/filename
    const url = new URL(request.url)
    const filePath = join(getAttachmentDir(), url.hostname, url.pathname)
    return net.fetch(pathToFileURL(filePath).toString())
  })

  initDb()
  resetRunningThreads()

  const win = createWindow()

  // Composition root for the Run lifecycle: the module accepts its
  // dependencies as role interfaces; everything Electron- or storage-shaped
  // is bound here and only here.
  runLifecycle = new RunLifecycle({
    store: sqliteRunStore,
    git: createRunGit(),
    worktrees: createRunWorktrees(),
    sessions: createRunSessions(() => win),
    notifier: electronRunNotifier,
    clock: { now: () => new Date() },
    onChange: () => {
      if (!win.isDestroyed()) emitAppEvent(win, 'routines:changed')
    },
  })

  registerIpcHandlers(win, runLifecycle)
  startPlanWatcher(win)

  runLifecycle.start()
  powerMonitor.on('resume', () => void runLifecycle?.tick())
  startWebhookServer(readWebhookConfig(), win)
  startRemoteControlServer(readRemoteServerConfig(), win)

  initUpdater(() => win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

let shutdownStarted = false
let shutdownComplete = false

app.on('before-quit', (event) => {
  if (shutdownComplete) return

  event.preventDefault()
  if (shutdownStarted) return

  shutdownStarted = true
  isQuitting = true
  runLifecycle?.stop()
  sessionManager.stopAll()
  stopWebhookServer()
  stopRemoteControlClient()
  stopRemoteControlServer()
  browserSessionManager.stopAll()
  stopPlanWatcher()
  stopAllFileWatches()
  ptyManager.killAll()

  void Promise.allSettled([
    commandManager.stopAll(),
    shutdownObservability(),
  ]).finally(() => {
    cleanupAllAttachments()
    closeDb()
    flushAppLogs()
    shutdownComplete = true
    app.quit()
  })
})
