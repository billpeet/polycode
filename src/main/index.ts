import { app, BrowserWindow, shell, protocol, net } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { initDb, closeDb } from './db/index'
import { resetRunningThreads } from './db/queries'
import { registerIpcHandlers } from './ipc/handlers'
import { cleanupAllAttachments, getAttachmentDir } from './attachments'

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production'

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
    titleBarStyle: 'default',
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

  // Open external links in default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
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
  cleanupAllAttachments()
  closeDb()
})
