import { ipcMain, dialog, BrowserWindow } from 'electron'
import {
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  listThreads,
  listArchivedThreads,
  archivedThreadCount,
  createThread,
  deleteThread,
  updateThreadName,
  updateThreadModel,
  updateThreadStatus,
  threadHasMessages,
  archiveThread,
  unarchiveThread,
  listMessages
} from '../db/queries'
import { sessionManager } from '../session/manager'
import { getGitStatus, commitChanges } from '../git'

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

  ipcMain.handle('threads:archivedCount', (_event, projectId: string) => {
    return archivedThreadCount(projectId)
  })

  ipcMain.handle('threads:listArchived', (_event, projectId: string) => {
    return listArchivedThreads(projectId)
  })

  ipcMain.handle('threads:archive', (_event, id: string) => {
    sessionManager.remove(id)
    if (threadHasMessages(id)) {
      archiveThread(id)
      return 'archived'
    } else {
      deleteThread(id)
      return 'deleted'
    }
  })

  ipcMain.handle('threads:unarchive', (_event, id: string) => {
    return unarchiveThread(id)
  })

  ipcMain.handle('threads:updateName', (_event, id: string, name: string) => {
    return updateThreadName(id, name)
  })

  ipcMain.handle('threads:updateModel', (_event, id: string, model: string) => {
    // Drop any live session so next message picks up the new model
    sessionManager.remove(id)
    return updateThreadModel(id, model)
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
    } else {
      // No live session (e.g. after restart) — force-reset stuck status in DB and notify renderer
      updateThreadStatus(threadId, 'idle')
      window.webContents.send(`thread:status:${threadId}`, 'idle')
    }
  })

  ipcMain.handle('threads:send', (_event, threadId: string, content: string, workingDir: string, options?: { planMode?: boolean }) => {
    const session = sessionManager.getOrCreate(threadId, workingDir, window)
    session.sendMessage(content, options)
  })

  ipcMain.handle('threads:approvePlan', (_event, threadId: string) => {
    const session = sessionManager.get(threadId)
    if (session) {
      session.approvePlan()
    }
  })

  ipcMain.handle('threads:rejectPlan', (_event, threadId: string) => {
    const session = sessionManager.get(threadId)
    if (session) {
      session.rejectPlan()
    }
  })

  ipcMain.handle('threads:getQuestions', (_event, threadId: string) => {
    const session = sessionManager.get(threadId)
    return session?.getPendingQuestions() ?? []
  })

  ipcMain.handle('threads:answerQuestion', (_event, threadId: string, answers: Record<string, string>) => {
    const session = sessionManager.get(threadId)
    if (session) {
      session.answerQuestion(answers)
    }
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

  // ── Git ───────────────────────────────────────────────────────────────────

  ipcMain.handle('git:status', (_event, repoPath: string) => {
    return getGitStatus(repoPath)
  })

  ipcMain.handle('git:commit', (_event, repoPath: string, message: string) => {
    return commitChanges(repoPath, message)
  })
}
