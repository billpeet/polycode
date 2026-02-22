import { spawn } from 'child_process'
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
  updateThreadProviderAndModel,
  updateThreadStatus,
  threadHasMessages,
  archiveThread,
  unarchiveThread,
  listMessages,
  listMessagesBySession,
  importThread,
  getLastUsedProviderAndModel,
  getImportedSessionIds,
  listSessions,
  getActiveSession,
  setActiveSession,
  getThreadModifiedFiles,
  getProjectForThread,
  getProjectByPath
} from '../db/queries'
import { SshConfig, WslConfig } from '../../shared/types'
import { sessionManager } from '../session/manager'
import { getGitStatus, commitChanges, stageFile, stageFiles, unstageFile, stageAll, unstageAll, generateCommitMessage, generateCommitMessageWithContext, gitPush, gitPull, getFileDiff } from '../git'
import { listDirectory, readFileContent, listAllFiles } from '../files'
import { sshListDirectory, sshReadFileContent, sshListAllFiles } from '../ssh'
import { wslExec, wslListDirectory, wslReadFileContent, wslListAllFiles } from '../wsl'
import { listClaudeProjects, listClaudeSessions, parseSessionMessages } from '../claude-history'
import {
  saveAttachment,
  copyAttachmentFromPath,
  cleanupThreadAttachments,
  getFileInfo,
} from '../attachments'

function getSshConfigForThread(threadId: string): SshConfig | null {
  const project = getProjectForThread(threadId)
  return project?.ssh ?? null
}

function getWslConfigForThread(threadId: string): WslConfig | null {
  const project = getProjectForThread(threadId)
  return project?.wsl ?? null
}

function getSshConfigForPath(path: string): SshConfig | null {
  const project = getProjectByPath(path)
  return project?.ssh ?? null
}

function getWslConfigForPath(path: string): WslConfig | null {
  const project = getProjectByPath(path)
  return project?.wsl ?? null
}

export function registerIpcHandlers(window: BrowserWindow): void {
  // ── Projects ──────────────────────────────────────────────────────────────

  ipcMain.handle('projects:list', () => {
    return listProjects()
  })

  ipcMain.handle('projects:create', (_event, name: string, path: string, ssh?: SshConfig | null, wsl?: WslConfig | null) => {
    return createProject(name, path, ssh, wsl)
  })

  ipcMain.handle('projects:update', (_event, id: string, name: string, path: string, ssh?: SshConfig | null, wsl?: WslConfig | null) => {
    return updateProject(id, name, path, ssh, wsl)
  })

  ipcMain.handle('projects:delete', (_event, id: string) => {
    sessionManager.stopAll()
    return deleteProject(id)
  })

  ipcMain.handle('ssh:test', (_event, ssh: SshConfig, remotePath: string): Promise<{ ok: boolean; error?: string }> => {
    return new Promise((resolve) => {
      const sshArgs = [
        '-T',
        '-o', 'ConnectTimeout=10',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'BatchMode=yes',
      ]
      if (ssh.port) sshArgs.push('-p', String(ssh.port))
      if (ssh.keyPath) sshArgs.push('-i', ssh.keyPath)
      // ~ doesn't expand inside single quotes, so use "$HOME" for tilde prefix
      const testPath = remotePath.startsWith('~')
        ? '"$HOME"' + "'" + remotePath.slice(1).replace(/'/g, "'\\''") + "'"
        : "'" + remotePath.replace(/'/g, "'\\''") + "'"
      sshArgs.push(`${ssh.user}@${ssh.host}`, `test -d ${testPath} && echo __POLYCODE_OK__`)

      const proc = spawn('ssh', sshArgs, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000,
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      proc.on('close', (code) => {
        if (code === 0 && stdout.includes('__POLYCODE_OK__')) {
          resolve({ ok: true })
        } else {
          const msg = stderr.trim() || `SSH exited with code ${code}`
          resolve({ ok: false, error: msg })
        }
      })

      proc.on('error', (err) => {
        resolve({ ok: false, error: err.message })
      })
    })
  })

  // ── WSL ─────────────────────────────────────────────────────────────────

  ipcMain.handle('wsl:test', (_event, wsl: WslConfig, wslPath: string): Promise<{ ok: boolean; error?: string }> => {
    return new Promise((resolve) => {
      const testPath = wslPath.startsWith('~')
        ? '"$HOME"' + "'" + wslPath.slice(1).replace(/'/g, "'\\''") + "'"
        : "'" + wslPath.replace(/'/g, "'\\''") + "'"
      const innerCmd = `test -d ${testPath} && echo __POLYCODE_OK__`

      const proc = spawn('wsl', ['-d', wsl.distro, '--', 'bash', '-lc', innerCmd], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000,
      })

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []

      proc.stdout?.on('data', (chunk: Buffer) => { stdoutChunks.push(chunk) })
      proc.stderr?.on('data', (chunk: Buffer) => { stderrChunks.push(chunk) })

      proc.on('close', (code) => {
        const stdout = decodeWslBuffer(Buffer.concat(stdoutChunks))
        const stderr = decodeWslBuffer(Buffer.concat(stderrChunks))
        if (code === 0 && stdout.includes('__POLYCODE_OK__')) {
          resolve({ ok: true })
        } else {
          const msg = stderr || (code === 1 ? 'Directory not found in WSL distro' : `WSL exited with code ${code}`)
          resolve({ ok: false, error: msg })
        }
      })

      proc.on('error', (err) => {
        resolve({ ok: false, error: err.message })
      })
    })
  })

  ipcMain.handle('wsl:list-distros', (): Promise<string[]> => {
    return new Promise((resolve) => {
      const proc = spawn('wsl', ['--list', '--quiet'], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
      })

      const stdoutChunks: Buffer[] = []

      proc.stdout?.on('data', (chunk: Buffer) => { stdoutChunks.push(chunk) })

      proc.on('close', (code) => {
        if (code === 0) {
          const stdout = decodeWslBuffer(Buffer.concat(stdoutChunks))
          const distros = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
          resolve(distros)
        } else {
          resolve([])
        }
      })

      proc.on('error', () => {
        resolve([])
      })
    })
  })

  // ── Threads ───────────────────────────────────────────────────────────────

  ipcMain.handle('threads:list', (_event, projectId: string) => {
    return listThreads(projectId)
  })

  ipcMain.handle('threads:create', (_event, projectId: string, name: string) => {
    const { provider, model } = getLastUsedProviderAndModel(projectId)
    return createThread(projectId, name, provider, model)
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

  ipcMain.handle('threads:updateProviderAndModel', (_event, id: string, provider: string, model: string) => {
    sessionManager.remove(id)
    return updateThreadProviderAndModel(id, provider, model)
  })

  ipcMain.handle('threads:start', (_event, threadId: string, workingDir: string) => {
    const sshConfig = getSshConfigForThread(threadId)
    const wslConfig = getWslConfigForThread(threadId)
    const session = sessionManager.getOrCreate(threadId, workingDir, window, sshConfig, wslConfig)
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
    const sshConfig = getSshConfigForThread(threadId)
    const wslConfig = getWslConfigForThread(threadId)
    const session = sessionManager.getOrCreate(threadId, workingDir, window, sshConfig, wslConfig)
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
    const sshConfig = getSshConfigForThread(threadId)
    const wslConfig = getWslConfigForThread(threadId)
    const session = sessionManager.getOrCreate(threadId, workingDir, window, sshConfig, wslConfig)
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
    const sshConfig = getSshConfigForThread(threadId)
    const wslConfig = getWslConfigForThread(threadId)
    const session = sessionManager.getOrCreate(threadId, workingDir, window, sshConfig, wslConfig)
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
    const ssh = getSshConfigForPath(repoPath)
    const wsl = getWslConfigForPath(repoPath)
    return getGitStatus(repoPath, ssh, wsl)
  })

  ipcMain.handle('git:commit', (_event, repoPath: string, message: string) => {
    const ssh = getSshConfigForPath(repoPath)
    const wsl = getWslConfigForPath(repoPath)
    return commitChanges(repoPath, message, ssh, wsl)
  })

  ipcMain.handle('git:stage', (_event, repoPath: string, filePath: string) => {
    const ssh = getSshConfigForPath(repoPath)
    const wsl = getWslConfigForPath(repoPath)
    return stageFile(repoPath, filePath, ssh, wsl)
  })

  ipcMain.handle('git:unstage', (_event, repoPath: string, filePath: string) => {
    const ssh = getSshConfigForPath(repoPath)
    const wsl = getWslConfigForPath(repoPath)
    return unstageFile(repoPath, filePath, ssh, wsl)
  })

  ipcMain.handle('git:stageAll', (_event, repoPath: string) => {
    const ssh = getSshConfigForPath(repoPath)
    const wsl = getWslConfigForPath(repoPath)
    return stageAll(repoPath, ssh, wsl)
  })

  ipcMain.handle('git:unstageAll', (_event, repoPath: string) => {
    const ssh = getSshConfigForPath(repoPath)
    const wsl = getWslConfigForPath(repoPath)
    return unstageAll(repoPath, ssh, wsl)
  })

  ipcMain.handle('git:stageFiles', (_event, repoPath: string, filePaths: string[]) => {
    const ssh = getSshConfigForPath(repoPath)
    const wsl = getWslConfigForPath(repoPath)
    return stageFiles(repoPath, filePaths, ssh, wsl)
  })

  ipcMain.handle('git:generateCommitMessage', (_event, repoPath: string) => {
    const ssh = getSshConfigForPath(repoPath)
    const wsl = getWslConfigForPath(repoPath)
    return generateCommitMessage(repoPath, ssh, wsl)
  })

  ipcMain.handle('git:generateCommitMessageWithContext', (_event, repoPath: string, filePaths: string[], context: string) => {
    const ssh = getSshConfigForPath(repoPath)
    const wsl = getWslConfigForPath(repoPath)
    return generateCommitMessageWithContext(repoPath, filePaths, context, ssh, wsl)
  })

  ipcMain.handle('git:push', (_event, repoPath: string) => {
    const ssh = getSshConfigForPath(repoPath)
    const wsl = getWslConfigForPath(repoPath)
    return gitPush(repoPath, ssh, wsl)
  })

  ipcMain.handle('git:pull', (_event, repoPath: string) => {
    const ssh = getSshConfigForPath(repoPath)
    const wsl = getWslConfigForPath(repoPath)
    return gitPull(repoPath, ssh, wsl)
  })

  ipcMain.handle('git:diff', (_event, repoPath: string, filePath: string, staged: boolean) => {
    const ssh = getSshConfigForPath(repoPath)
    const wsl = getWslConfigForPath(repoPath)
    return getFileDiff(repoPath, filePath, staged, ssh, wsl)
  })

  // ── Files ────────────────────────────────────────────────────────────────

  ipcMain.handle('files:list', (_event, dirPath: string) => {
    const ssh = getSshConfigForFilePath(dirPath)
    if (ssh) return sshListDirectory(ssh, dirPath)
    const wsl = getWslConfigForFilePath(dirPath)
    if (wsl) return wslListDirectory(wsl, dirPath)
    return listDirectory(dirPath)
  })

  ipcMain.handle('files:read', (_event, filePath: string) => {
    const ssh = getSshConfigForFilePath(filePath)
    if (ssh) return sshReadFileContent(ssh, filePath)
    const wsl = getWslConfigForFilePath(filePath)
    if (wsl) return wslReadFileContent(wsl, filePath)
    return readFileContent(filePath)
  })

  ipcMain.handle('files:searchList', (_event, rootPath: string) => {
    const ssh = getSshConfigForPath(rootPath)
    if (ssh) return sshListAllFiles(ssh, rootPath)
    const wsl = getWslConfigForPath(rootPath)
    if (wsl) return wslListAllFiles(wsl, rootPath)
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

/**
 * Look up SSH config for a file path by finding a project whose path is a prefix.
 * This handles file reads where the path may be a subdirectory of the project root.
 */
function getSshConfigForFilePath(filePath: string): SshConfig | null {
  // First try exact match (works when filePath === project path)
  const exact = getSshConfigForPath(filePath)
  if (exact) return exact

  // Search all projects for one whose path is a prefix of the file path
  const projects = listProjects()
  for (const project of projects) {
    if (!project.ssh?.host) continue
    const projectPath = project.path.endsWith('/') ? project.path : project.path + '/'
    if (filePath.startsWith(projectPath) || filePath.startsWith(project.path)) {
      return project.ssh
    }
  }
  return null
}

/**
 * Look up WSL config for a file path by finding a project whose path is a prefix.
 */
function getWslConfigForFilePath(filePath: string): WslConfig | null {
  const exact = getWslConfigForPath(filePath)
  if (exact) return exact

  const projects = listProjects()
  for (const project of projects) {
    if (!project.wsl?.distro) continue
    const projectPath = project.path.endsWith('/') ? project.path : project.path + '/'
    if (filePath.startsWith(projectPath) || filePath.startsWith(project.path)) {
      return project.wsl
    }
  }
  return null
}

/**
 * Decode a buffer from WSL, handling UTF-16LE encoding.
 * `wsl.exe` on Windows outputs UTF-16LE for its own messages (errors, --list, etc.).
 * Bash output from inside WSL is UTF-8, but WSL error messages before bash starts are UTF-16LE.
 */
function decodeWslBuffer(buf: Buffer): string {
  if (buf.length === 0) return ''
  // Detect UTF-16LE: check for NUL bytes interleaved with ASCII (every other byte is 0)
  if (buf.length >= 2 && buf[1] === 0) {
    return buf.toString('utf16le').replace(/^\uFEFF/, '').trim()
  }
  return buf.toString('utf8').trim()
}
