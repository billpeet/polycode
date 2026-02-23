import { app, BrowserWindow, shell, protocol, net, Tray, Menu, dialog } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { autoUpdater } from 'electron-updater'
import { initDb, closeDb } from './db/index'
import { resetRunningThreads, hasRunningThreads } from './db/queries'
import { registerIpcHandlers } from './ipc/handlers'
import { cleanupAllAttachments, getAttachmentDir } from './attachments'

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production'

let tray: Tray | null = null
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

  win.on('close', (event: Electron.Event) => {
    if (!isQuitting) {
      event.preventDefault()
      win.hide()
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

  if (!isDev) {
    autoUpdater.on('error', (err) => {
      console.error('Auto-updater error:', err.message)
    })
    autoUpdater.on('update-downloaded', () => {
      win.webContents.send('app:update-downloaded')
    })
    autoUpdater.checkForUpdatesAndNotify()
  }

  tray = new Tray(join(__dirname, '../../resources/icon.ico'))
  tray.setToolTip('Polycode')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Polycode',
      click: () => {
        win.show()
        win.focus()
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: async () => {
        if (hasRunningThreads()) {
          const { response } = await dialog.showMessageBox({
            type: 'warning',
            title: 'Threads still running',
            message: 'One or more threads are still running. Quitting now will interrupt them.',
            buttons: ['Quit Anyway', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
          })
          if (response !== 0) return
        }
        isQuitting = true
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)

  tray.on('double-click', () => {
    win.show()
    win.focus()
  })

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
  cleanupAllAttachments()
  closeDb()
})
