import { spawn } from 'child_process'
import { ipcMain, dialog, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import {
  listProjects,
  listArchivedProjects,
  createProject,
  updateProject,
  deleteProject,
  archiveProject,
  unarchiveProject,
  listLocations,
  createLocation,
  updateLocation,
  deleteLocation,
  getLocationForThread,
  getLocationByPath,
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
  getThreadWsl,
  updateThreadWsl,
  setThreadGitBranchIfUnset,
  listCommands,
  createCommand,
  updateCommand,
  deleteCommand,
  listYouTrackServers,
  createYouTrackServer,
  updateYouTrackServer,
  deleteYouTrackServer,
  listSlashCommands,
  createSlashCommand,
  updateSlashCommand,
  deleteSlashCommand,
} from '../db/queries'
import { SshConfig, WslConfig, ConnectionType, Provider } from '../../shared/types'
import { checkCliHealth, updateCli } from '../health/checker'
import { sessionManager } from '../session/manager'
import { commandManager } from '../commands/manager'
import { getGitBranch, getGitStatus, commitChanges, stageFile, stageFiles, unstageFile, stageAll, unstageAll, generateCommitMessage, generateCommitMessageWithContext, gitPush, gitPushSetUpstream, gitPull, gitPullOrigin, getFileDiff, listBranches, checkoutBranch, createBranch, mergeBranch, findMergedBranches, deleteBranches } from '../git'
import { listDirectory, readFileContent, listAllFiles } from '../files'
import { sshListDirectory, sshReadFileContent, sshListAllFiles } from '../ssh'
import { wslListDirectory, wslReadFileContent, wslListAllFiles } from '../wsl'
import { listClaudeProjects, listClaudeSessions, parseSessionMessages } from '../claude-history'
import {
  saveAttachment,
  copyAttachmentFromPath,
  cleanupThreadAttachments,
  getFileInfo,
} from '../attachments'

/** Get SSH config from the thread's linked repo location. */
function getSshConfigForThread(threadId: string): SshConfig | null {
  const location = getLocationForThread(threadId)
  return location?.ssh ?? null
}

/** Get WSL config from the thread's linked repo location, or thread-level WSL override for local locations. */
function getWslConfigForThread(threadId: string): WslConfig | null {
  const location = getLocationForThread(threadId)
  // If the location is local and the thread has use_wsl enabled, use thread-level WSL config
  if (location && location.connection_type === 'local') {
    const threadWsl = getThreadWsl(threadId)
    if (threadWsl.use_wsl && threadWsl.wsl_distro) {
      return { distro: threadWsl.wsl_distro }
    }
  }
  return location?.wsl ?? null
}

/** Get the working directory from the thread's linked repo location. */
function getWorkingDirForThread(threadId: string): string | null {
  const location = getLocationForThread(threadId)
  return location?.path ?? null
}

/**
 * Convert a Windows absolute path to its WSL /mnt/... equivalent.
 * e.g. C:\Users\foo\bar  →  /mnt/c/Users/foo/bar
 */
function windowsPathToWsl(winPath: string): string {
  return winPath
    .replace(/^([A-Za-z]):[/\\]/, (_, drive) => `/mnt/${drive.toLowerCase()}/`)
    .replace(/\\/g, '/')
}

/**
 * Return the effective working directory for a thread.
 * For WSL locations with a Windows-style path, convert to /mnt/... format.
 */
function getEffectiveWorkingDir(threadId: string): string {
  const location = getLocationForThread(threadId)
  if (!location) return ''
  if (location.connection_type === 'wsl' && /^[A-Za-z]:[/\\]/.test(location.path)) {
    return windowsPathToWsl(location.path)
  }
  // Thread-level WSL override for local locations: convert Windows path to /mnt/...
  if (location.connection_type === 'local' && /^[A-Za-z]:[/\\]/.test(location.path)) {
    const threadWsl = getThreadWsl(threadId)
    if (threadWsl.use_wsl) {
      return windowsPathToWsl(location.path)
    }
  }
  return location.path
}

/** Look up SSH/WSL config for a given path by searching repo_locations. */
function getConfigForPath(path: string): { ssh: SshConfig | null; wsl: WslConfig | null } {
  const location = getLocationByPath(path)
  return { ssh: location?.ssh ?? null, wsl: location?.wsl ?? null }
}

export function registerIpcHandlers(window: BrowserWindow): void {
  commandManager.init(window)

  // ── Projects ──────────────────────────────────────────────────────────────

  ipcMain.handle('projects:list', () => {
    return listProjects()
  })

  ipcMain.handle('projects:create', (_event, name: string, gitUrl?: string | null) => {
    return createProject(name, gitUrl)
  })

  ipcMain.handle('projects:update', (_event, id: string, name: string, gitUrl?: string | null) => {
    return updateProject(id, name, gitUrl)
  })

  ipcMain.handle('projects:delete', (_event, id: string) => {
    sessionManager.stopAll()
    commandManager.stopAll()
    return deleteProject(id)
  })

  ipcMain.handle('projects:listArchived', () => {
    return listArchivedProjects()
  })

  ipcMain.handle('projects:archive', (_event, id: string) => {
    return archiveProject(id)
  })

  ipcMain.handle('projects:unarchive', (_event, id: string) => {
    return unarchiveProject(id)
  })

  // ── Repo Locations ────────────────────────────────────────────────────────

  ipcMain.handle('locations:list', (_event, projectId: string) => {
    return listLocations(projectId)
  })

  ipcMain.handle('locations:create', (_event, projectId: string, label: string, connectionType: ConnectionType, locationPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null) => {
    return createLocation(projectId, label, connectionType, locationPath, ssh, wsl)
  })

  ipcMain.handle('locations:update', (_event, id: string, label: string, connectionType: ConnectionType, locationPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null) => {
    return updateLocation(id, label, connectionType, locationPath, ssh, wsl)
  })

  ipcMain.handle('locations:delete', (_event, id: string) => {
    return deleteLocation(id)
  })

  // ── SSH / WSL test ──────────────────────────────────────────────────────────

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

  ipcMain.handle('threads:create', (_event, projectId: string, name: string, locationId: string) => {
    const { provider, model } = getLastUsedProviderAndModel(projectId)
    return createThread(projectId, name, locationId, provider, model)
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

  ipcMain.handle('threads:setWsl', (_event, threadId: string, useWsl: boolean, wslDistro: string | null) => {
    if (threadHasMessages(threadId)) return // locked after first message
    sessionManager.remove(threadId) // drop existing session so it gets recreated
    updateThreadWsl(threadId, useWsl, wslDistro)
  })

  ipcMain.handle('threads:start', (_event, threadId: string) => {
    const effectiveDir = getEffectiveWorkingDir(threadId)
    const sshConfig = getSshConfigForThread(threadId)
    const wslConfig = getWslConfigForThread(threadId)
    const session = sessionManager.getOrCreate(threadId, effectiveDir, window, sshConfig, wslConfig)
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
      window.webContents.send(`thread:pid:${threadId}`, null)
    }
  })

  ipcMain.handle('threads:getPid', (_event, threadId: string) => {
    return sessionManager.get(threadId)?.getPid() ?? null
  })

  ipcMain.handle('threads:send', (_event, threadId: string, content: string, options?: { planMode?: boolean }) => {
    const effectiveDir = getEffectiveWorkingDir(threadId)
    const sshConfig = getSshConfigForThread(threadId)
    const wslConfig = getWslConfigForThread(threadId)
    const session = sessionManager.getOrCreate(threadId, effectiveDir, window, sshConfig, wslConfig)
    if (session.isRunning()) {
      console.warn('[handlers] threads:send while session is running — ignoring for thread', threadId)
      return
    }
    session.sendMessage(content, options)
    // Capture git branch on first message (fire-and-forget, doesn't block send)
    const location = getLocationForThread(threadId)
    if (location) {
      getGitBranch(location.path, location.ssh, location.wsl).then((branch) => {
        if (branch) setThreadGitBranchIfUnset(threadId, branch)
      }).catch(() => {/* not a git repo */})
    }
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

  ipcMain.handle('threads:answerQuestion', (_event, threadId: string, answers: Record<string, string>, questionComments: Record<string, string>, generalComment: string) => {
    const session = sessionManager.get(threadId)
    if (session) {
      session.answerQuestion(answers, questionComments, generalComment)
    }
  })

  ipcMain.handle('threads:executePlanInNewContext', (_event, threadId: string) => {
    const effectiveDir = getEffectiveWorkingDir(threadId)
    const sshConfig = getSshConfigForThread(threadId)
    const wslConfig = getWslConfigForThread(threadId)
    const session = sessionManager.getOrCreate(threadId, effectiveDir, window, sshConfig, wslConfig)
    session.executePlanInNewContext()
  })

  ipcMain.handle('threads:getModifiedFiles', (_event, threadId: string) => {
    const workingDir = getWorkingDirForThread(threadId) ?? ''
    return getThreadModifiedFiles(threadId, workingDir)
  })

  // ── Sessions ────────────────────────────────────────────────────────────────

  ipcMain.handle('sessions:list', (_event, threadId: string) => {
    return listSessions(threadId)
  })

  ipcMain.handle('sessions:getActive', (_event, threadId: string) => {
    return getActiveSession(threadId)
  })

  ipcMain.handle('sessions:switch', (_event, threadId: string, sessionId: string) => {
    const effectiveDir = getEffectiveWorkingDir(threadId)
    const sshConfig = getSshConfigForThread(threadId)
    const wslConfig = getWslConfigForThread(threadId)
    const session = sessionManager.getOrCreate(threadId, effectiveDir, window, sshConfig, wslConfig)
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

  ipcMain.handle('git:branch', (_event, repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getGitBranch(repoPath, ssh, wsl)
  })

  ipcMain.handle('git:status', (_event, repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getGitStatus(repoPath, ssh, wsl)
  })

  ipcMain.handle('git:commit', (_event, repoPath: string, message: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return commitChanges(repoPath, message, ssh, wsl)
  })

  ipcMain.handle('git:stage', (_event, repoPath: string, filePath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return stageFile(repoPath, filePath, ssh, wsl)
  })

  ipcMain.handle('git:unstage', (_event, repoPath: string, filePath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return unstageFile(repoPath, filePath, ssh, wsl)
  })

  ipcMain.handle('git:stageAll', (_event, repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return stageAll(repoPath, ssh, wsl)
  })

  ipcMain.handle('git:unstageAll', (_event, repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return unstageAll(repoPath, ssh, wsl)
  })

  ipcMain.handle('git:stageFiles', (_event, repoPath: string, filePaths: string[]) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return stageFiles(repoPath, filePaths, ssh, wsl)
  })

  ipcMain.handle('git:generateCommitMessage', (_event, repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return generateCommitMessage(repoPath, ssh, wsl)
  })

  ipcMain.handle('git:generateCommitMessageWithContext', (_event, repoPath: string, filePaths: string[], context: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return generateCommitMessageWithContext(repoPath, filePaths, context, ssh, wsl)
  })

  ipcMain.handle('git:push', (_event, repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return gitPush(repoPath, ssh, wsl)
  })

  ipcMain.handle('git:pushSetUpstream', (_event, repoPath: string, branch: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return gitPushSetUpstream(repoPath, branch, ssh, wsl)
  })

  ipcMain.handle('git:pull', (_event, repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return gitPull(repoPath, ssh, wsl)
  })

  ipcMain.handle('git:pullOrigin', (_event, repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return gitPullOrigin(repoPath, ssh, wsl)
  })

  ipcMain.handle('git:diff', (_event, repoPath: string, filePath: string, staged: boolean) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getFileDiff(repoPath, filePath, staged, ssh, wsl)
  })

  ipcMain.handle('git:branches', (_event, repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return listBranches(repoPath, ssh, wsl)
  })

  ipcMain.handle('git:checkout', (_event, repoPath: string, branch: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return checkoutBranch(repoPath, branch, ssh, wsl)
  })

  ipcMain.handle('git:createBranch', (_event, repoPath: string, name: string, base: string, pullFirst: boolean) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return createBranch(repoPath, name, base, pullFirst, ssh, wsl)
  })

  ipcMain.handle('git:merge', (_event, repoPath: string, source: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return mergeBranch(repoPath, source, ssh, wsl)
  })

  ipcMain.handle('git:findMergedBranches', (_event, repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return findMergedBranches(repoPath, ssh, wsl)
  })

  ipcMain.handle('git:deleteBranches', (_event, repoPath: string, branches: string[]) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return deleteBranches(repoPath, branches, ssh, wsl)
  })

  // ── Files ────────────────────────────────────────────────────────────────

  ipcMain.handle('files:list', (_event, dirPath: string) => {
    const { ssh, wsl } = getConfigForPath(dirPath)
    if (ssh) return sshListDirectory(ssh, dirPath)
    if (wsl) return wslListDirectory(wsl, dirPath)
    return listDirectory(dirPath)
  })

  ipcMain.handle('files:read', (_event, filePath: string) => {
    const { ssh, wsl } = getConfigForPath(filePath)
    if (ssh) return sshReadFileContent(ssh, filePath)
    if (wsl) return wslReadFileContent(wsl, filePath)
    return readFileContent(filePath)
  })

  ipcMain.handle('files:searchList', (_event, rootPath: string) => {
    const { ssh, wsl } = getConfigForPath(rootPath)
    if (ssh) return sshListAllFiles(ssh, rootPath)
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

  ipcMain.handle('claude-history:import', (_event, projectId: string, locationId: string, sessionFilePath: string, sessionId: string, name: string) => {
    const messages = parseSessionMessages(sessionFilePath)
    const importedMessages = messages.map(m => ({
      role: m.role,
      content: m.content,
      metadata: m.metadata,
      created_at: m.timestamp
    }))
    return importThread(projectId, locationId, name, sessionId, importedMessages)
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

  // ── Commands ──────────────────────────────────────────────────────────────

  ipcMain.handle('commands:list', (_event, projectId: string) => {
    return listCommands(projectId)
  })

  ipcMain.handle('commands:create', (_event, projectId: string, name: string, command: string, cwd?: string | null, shell?: string | null) => {
    return createCommand(projectId, name, command, cwd, shell)
  })

  ipcMain.handle('commands:update', (_event, id: string, name: string, command: string, cwd?: string | null, shell?: string | null) => {
    return updateCommand(id, name, command, cwd, shell)
  })

  ipcMain.handle('commands:delete', (_event, id: string) => {
    commandManager.stopAllInstances(id)
    return deleteCommand(id)
  })

  ipcMain.handle('commands:start', (_event, commandId: string, locationId: string) => {
    commandManager.start(commandId, locationId)
  })

  ipcMain.handle('commands:stop', (_event, commandId: string, locationId: string) => {
    commandManager.stop(commandId, locationId)
  })

  ipcMain.handle('commands:restart', (_event, commandId: string, locationId: string) => {
    commandManager.restart(commandId, locationId)
  })

  ipcMain.handle('commands:getStatus', (_event, commandId: string, locationId: string) => {
    return commandManager.getStatus(commandId, locationId)
  })

  ipcMain.handle('commands:getLogs', (_event, commandId: string, locationId: string) => {
    return commandManager.getLogs(commandId, locationId)
  })

  ipcMain.handle('commands:getPid', (_event, commandId: string, locationId: string) => {
    return commandManager.getPid(commandId, locationId)
  })

  // ── YouTrack ───────────────────────────────────────────────────────────────

  ipcMain.handle('youtrack:servers:list', () => listYouTrackServers())

  ipcMain.handle('youtrack:servers:create', (_event, name: string, url: string, token: string) => {
    return createYouTrackServer(name, url, token)
  })

  ipcMain.handle('youtrack:servers:update', (_event, id: string, name: string, url: string, token: string) => {
    return updateYouTrackServer(id, name, url, token)
  })

  ipcMain.handle('youtrack:servers:delete', (_event, id: string) => {
    return deleteYouTrackServer(id)
  })

  ipcMain.handle('youtrack:test', async (_event, url: string, token: string) => {
    try {
      const apiUrl = `${url.replace(/\/$/, '')}/api/users/me?fields=login,name`
      const resp = await fetch(apiUrl, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      })
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` }
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('youtrack:search', async (_event, url: string, token: string, query: string) => {
    try {
      const params = new URLSearchParams({ query, fields: 'id,idReadable,summary', $top: '20' })
      const apiUrl = `${url.replace(/\/$/, '')}/api/issues?${params}`
      const resp = await fetch(apiUrl, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      })
      if (!resp.ok) return []
      return resp.json()
    } catch {
      return []
    }
  })

  // ── Slash Commands ─────────────────────────────────────────────────────────

  ipcMain.handle('slash-commands:list', (_event, projectId?: string | null) => {
    return listSlashCommands(projectId)
  })

  ipcMain.handle('slash-commands:create', (_event, projectId: string | null, name: string, description: string | null, prompt: string) => {
    return createSlashCommand(projectId, name, description, prompt)
  })

  ipcMain.handle('slash-commands:update', (_event, id: string, name: string, description: string | null, prompt: string) => {
    return updateSlashCommand(id, name, description, prompt)
  })

  ipcMain.handle('slash-commands:delete', (_event, id: string) => {
    return deleteSlashCommand(id)
  })

  // ── Window Controls ────────────────────────────────────────────────────────

  ipcMain.handle('window:minimize',     () => window.minimize())
  ipcMain.handle('window:maximize',     () => window.isMaximized() ? window.unmaximize() : window.maximize())
  ipcMain.handle('window:close',        () => window.close())
  ipcMain.handle('window:is-maximized', () => window.isMaximized())

  window.on('maximize',   () => window.webContents.send('window:maximized-changed', true))
  window.on('unmaximize', () => window.webContents.send('window:maximized-changed', false))

  // ── Auto-updater ───────────────────────────────────────────────────────────

  ipcMain.handle('app:install-update', () => {
    autoUpdater.quitAndInstall()
  })

  // ── CLI health & updates ────────────────────────────────────────────────────

  ipcMain.handle('cli:health', (
    _event,
    provider: Provider,
    connectionType: string,
    ssh?: SshConfig | null,
    wsl?: WslConfig | null,
  ) => {
    return checkCliHealth(provider, connectionType, ssh, wsl)
  })

  ipcMain.handle('cli:update', (
    _event,
    provider: Provider,
    connectionType: string,
    ssh?: SshConfig | null,
    wsl?: WslConfig | null,
  ) => {
    return updateCli(provider, connectionType, ssh, wsl)
  })
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
