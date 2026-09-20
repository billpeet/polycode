// Imported before other main-process modules: paths and ownership must be settled
// before any module opens files, installs logging, or initializes a database.
import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveProfile, setAppProfile } from './profile'
import { configureAttachmentDirectory } from './attachments'

const profile = resolveProfile({
  isDev: !app.isPackaged && process.env.NODE_ENV !== 'production',
  defaultUserData: app.getPath('userData'),
  override: process.env.POLYCODE_USER_DATA_DIR,
})
mkdirSync(profile.dataPath, { recursive: true })
profile.dataPath = realpathSync(profile.dataPath)
const productionDirectory = dirname(profile.productionDatabasePath)
if (profile.isDevelopment && existsSync(productionDirectory)) {
  // Resolve junctions/symlinks too, so a custom profile cannot alias production.
  const productionRealPath = realpathSync(productionDirectory)
  const normalize = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
  if (normalize(profile.dataPath) === normalize(productionRealPath)) {
    throw new Error('Development must use a separate data directory from production.')
  }
}
app.setPath('userData', profile.dataPath)
app.setPath('sessionData', profile.dataPath)
// Electron's singleton is scoped to userData. Different profiles can coexist.
if (!app.requestSingleInstanceLock()) app.exit(0)
setAppProfile(profile)
configureAttachmentDirectory(profile.dataPath)
app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
})
