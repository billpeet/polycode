import { app, BrowserWindow, shell, protocol, net, dialog, ipcMain } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { autoUpdater } from 'electron-updater'
import * as Sentry from '@sentry/electron/main'
import { initDb, closeDb } from './db/index'
import { resetRunningThreads, hasRunningThreads } from './db/queries'
import { registerIpcHandlers } from './ipc/handlers'
import { cleanupAllAttachments, getAttachmentDir } from './attachments'
import { ptyManager } from './terminal/manager'
import { SENTRY_DSN } from '../shared/sentry.config'
import { startWebhookServer, stopWebhookServer } from './webhook/server'
import { startPlanWatcher, stopPlanWatcher } from './plans'
import { stopAllFileWatches } from './file-watch'
import { getSetting } from './db/queries'
import { sessionManager } from './session/manager'
import { commandManager } from './commands/manager'
import { installAppLogger, writeRendererLog } from './app-logger'
import { installIpcProfiling, installMainThreadStallMonitor } from './perf'

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

// EPIPE errors from network streams (e.g. electron-updater downloading latest.yml)
// can escape electron-updater's own error handler and surface as uncaught exceptions.
// They are not fatal — absorb them and let Sentry record them at warning level.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') {
    console.warn('[main] EPIPE on network stream (ignored):', err.message)
    if (!isDev) Sentry.captureException(err, { level: 'warning', tags: { source: 'epipe' } })
    return
  }
  throw err
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
      sandbox: false
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

      sessionManager.stopAll()
      commandManager.stopAll()
      isQuitting = true
      win.close()
    }
  })

  // Open external links in default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
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
  registerIpcHandlers(win)
  startPlanWatcher(win)

  startWebhookServer({
    enabled: getSetting('webhook:enabled') === 'true',
    port: parseInt(getSetting('webhook:port') ?? '3284', 10),
    token: getSetting('webhook:token') ?? '',
  }, win)

  if (!isDev) {
    autoUpdater.allowPrerelease = true
    autoUpdater.on('error', (err) => {
      Sentry.captureException(err)
      console.error('Auto-updater error:', err.message)
    })
    autoUpdater.on('update-downloaded', () => {
      win.webContents.send('app:update-downloaded')
    })
    autoUpdater.checkForUpdatesAndNotify()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    cleanupAllAttachments()
    closeDb()
    app.quit()
  }
})

app.on('before-quit', () => {
  isQuitting = true
  sessionManager.stopAll()
  commandManager.stopAll()
  stopWebhookServer()
  stopPlanWatcher()
  stopAllFileWatches()
  ptyManager.killAll()
  cleanupAllAttachments()
  closeDb()
})
