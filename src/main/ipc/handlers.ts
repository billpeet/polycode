import { ipcMain, dialog, BrowserWindow } from 'electron'
import {
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  listThreads,
  createThread,
  deleteThread,
  updateThreadName
} from '../db/queries'
import { listMessages } from '../db/queries'
import { sessionManager } from '../session/manager'

export function registerIpcHandlers(window: BrowserWindow): void {
  // ── Projects ──────────────────────────────────────────────────────────────

  ipcMain.handle('projects:list', () => {
    return listProjects()
  })

  ipcMain.handle('projects:create', (_event, name: string, path: string) => {
    return createProject(name, path)
  })

  ipcMain.handle('projects:update', (_event, id: string, name: string, path: string) => {
    return updateProject(id, name, path)
  })

  ipcMain.handle('projects:delete', (_event, id: string) => {
    sessionManager.stopAll()
    return deleteProject(id)
  })

  // ── Threads ───────────────────────────────────────────────────────────────

  ipcMain.handle('threads:list', (_event, projectId: string) => {
    return listThreads(projectId)
  })

  ipcMain.handle('threads:create', (_event, projectId: string, name: string) => {
    return createThread(projectId, name)
  })

  ipcMain.handle('threads:delete', (_event, id: string) => {
    sessionManager.remove(id)
    return deleteThread(id)
  })

  ipcMain.handle('threads:updateName', (_event, id: string, name: string) => {
    return updateThreadName(id, name)
  })

  ipcMain.handle('threads:start', (_event, threadId: string, workingDir: string) => {
    const session = sessionManager.getOrCreate(threadId, workingDir, window)
    if (!session.isRunning()) {
      session.start()
    }
  })

  ipcMain.handle('threads:stop', (_event, threadId: string) => {
    const session = sessionManager.get(threadId)
    if (session?.isRunning()) {
      session.stop()
    }
  })

  ipcMain.handle('threads:send', (_event, threadId: string, content: string, workingDir: string) => {
    const session = sessionManager.getOrCreate(threadId, workingDir, window)
    session.sendMessage(content)
  })

  // ── Messages ──────────────────────────────────────────────────────────────

  ipcMain.handle('messages:list', (_event, threadId: string) => {
    return listMessages(threadId)
  })

  // ── Dialog ────────────────────────────────────────────────────────────────

  ipcMain.handle('dialog:open-directory', async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
}
