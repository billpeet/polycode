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
  listMessages,
  listMessagesBySession,
  importThread,
  getLastUsedModel,
  getImportedSessionIds,
  listSessions,
  getActiveSession,
  setActiveSession,
  getThreadModifiedFiles
} from '../db/queries'
import { sessionManager } from '../session/manager'
import { getGitStatus, commitChanges, stageFile, stageFiles, unstageFile, stageAll, unstageAll, generateCommitMessage, gitPush, gitPull } from '../git'
import { listDirectory, readFileContent, listAllFiles } from '../files'
import { listClaudeProjects, listClaudeSessions, parseSessionMessages } from '../claude-history'
import {
  saveAttachment,
  copyAttachmentFromPath,
  cleanupThreadAttachments,
  getFileInfo,
} from '../attachments'

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
    const model = getLastUsedModel(projectId)
    return createThread(projectId, name, 'claude-code', model)
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

  ipcMain.handle('threads:executePlanInNewContext', (_event, threadId: string, workingDir: string) => {
    const session = sessionManager.getOrCreate(threadId, workingDir, window)
    session.executePlanInNewContext()
  })

  ipcMain.handle('threads:getModifiedFiles', (_event, threadId: string, workingDir: string) => {
    return getThreadModifiedFiles(threadId, workingDir)
  })

  // ── Sessions ────────────────────────────────────────────────────────────────

  ipcMain.handle('sessions:list', (_event, threadId: string) => {
    return listSessions(threadId)
  })

  ipcMain.handle('sessions:getActive', (_event, threadId: string) => {
    return getActiveSession(threadId)
  })

  ipcMain.handle('sessions:switch', (_event, threadId: string, sessionId: string, workingDir: string) => {
    const session = sessionManager.getOrCreate(threadId, workingDir, window)
    session.switchSession(sessionId)
  })

  // ── Messages ──────────────────────────────────────────────────────────────

  ipcMain.handle('messages:list', (_event, threadId: string) => {
    return listMessages(threadId)
  })

  ipcMain.handle('messages:listBySession', (_event, sessionId: string) => {
    return listMessagesBySession(sessionId)
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

  ipcMain.handle('git:stage', (_event, repoPath: string, filePath: string) => {
    return stageFile(repoPath, filePath)
  })

  ipcMain.handle('git:unstage', (_event, repoPath: string, filePath: string) => {
    return unstageFile(repoPath, filePath)
  })

  ipcMain.handle('git:stageAll', (_event, repoPath: string) => {
    return stageAll(repoPath)
  })

  ipcMain.handle('git:unstageAll', (_event, repoPath: string) => {
    return unstageAll(repoPath)
  })

  ipcMain.handle('git:stageFiles', (_event, repoPath: string, filePaths: string[]) => {
    return stageFiles(repoPath, filePaths)
  })

  ipcMain.handle('git:generateCommitMessage', (_event, repoPath: string) => {
    return generateCommitMessage(repoPath)
  })

  ipcMain.handle('git:push', (_event, repoPath: string) => {
    return gitPush(repoPath)
  })

  ipcMain.handle('git:pull', (_event, repoPath: string) => {
    return gitPull(repoPath)
  })

  // ── Files ────────────────────────────────────────────────────────────────

  ipcMain.handle('files:list', (_event, dirPath: string) => {
    return listDirectory(dirPath)
  })

  ipcMain.handle('files:read', (_event, filePath: string) => {
    return readFileContent(filePath)
  })

  ipcMain.handle('files:searchList', (_event, rootPath: string) => {
    return listAllFiles(rootPath)
  })

  // ── Claude History ─────────────────────────────────────────────────────────

  ipcMain.handle('claude-history:listProjects', () => {
    return listClaudeProjects()
  })

  ipcMain.handle('claude-history:listSessions', (_event, encodedPath: string) => {
    return listClaudeSessions(encodedPath)
  })

  ipcMain.handle('claude-history:importedIds', (_event, projectId: string) => {
    return getImportedSessionIds(projectId)
  })

  ipcMain.handle('claude-history:import', (_event, projectId: string, sessionFilePath: string, sessionId: string, name: string) => {
    const messages = parseSessionMessages(sessionFilePath)
    const importedMessages = messages.map(m => ({
      role: m.role,
      content: m.content,
      metadata: m.metadata,
      created_at: m.timestamp
    }))
    return importThread(projectId, name, sessionId, importedMessages)
  })

  // ── Attachments ─────────────────────────────────────────────────────────────

  ipcMain.handle('attachments:save', (_event, dataUrl: string, filename: string, threadId: string) => {
    return saveAttachment(dataUrl, filename, threadId)
  })

  ipcMain.handle('attachments:saveFromPath', (_event, sourcePath: string, threadId: string) => {
    return copyAttachmentFromPath(sourcePath, threadId)
  })

  ipcMain.handle('attachments:cleanup', (_event, threadId: string) => {
    return cleanupThreadAttachments(threadId)
  })

  ipcMain.handle('attachments:getFileInfo', (_event, filePath: string) => {
    return getFileInfo(filePath)
  })

  ipcMain.handle('dialog:open-files', async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    return result.canceled ? [] : result.filePaths
  })
}
