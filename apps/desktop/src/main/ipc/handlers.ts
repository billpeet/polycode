import { spawn, exec, execFile } from 'child_process'
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { pathToFileURL } from 'url'
import { homedir } from 'os'
import { app, ipcMain, dialog, BrowserWindow, shell, clipboard } from 'electron'
import { applyUpdate, checkForUpdates, getUpdateState } from '../updater'
import {
  listProjects,
  listArchivedProjects,
  createProject,
  updateProject,
  deleteProject,
  archiveProject,
  unarchiveProject,
  listLocations,
  listLocationPools,
  createLocationPool,
  updateLocationPool,
  deleteLocationPool,
  createLocation,
  createWorktreeLocation,
  updateLocation,
  deleteLocation,
  getLocationById,
  checkoutLocation,
  returnLocationToPool,
  getLocationForThread,
  getLocationByPath,
  getProjectById,
  listThreads,
  listActiveThreadsForLocation,
  listArchivedThreads,
  archivedThreadCount,
  createThread,
  deleteThread,
  updateThreadName,
  updateThreadModel,
  updateThreadProviderAndModel,
  updateThreadReasoningLevel,
  updateThreadCursorThinking,
  updateThreadCursorContext,
  updateThreadPermissionMode,
  updateThreadYoloMode,
  updateThreadStatus,
  updateThreadUnread,
  threadExists,
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
  getSetting,
  setSetting,
} from '../db/queries'
import { SshConfig, WslConfig, ConnectionType, Provider, QuestionAnswerValue, NewProjectSpec } from '../../shared/types'
import { checkCliHealth, updateCli, invalidateCliHealthCache } from '../health/checker'
import { listClaudeAvailableModels } from '../claude-models'
import { listCodexAvailableModels } from '../codex-models'
import { listPiAvailableModels } from '../pi-models'
import { listOpenCodeAvailableModels } from '../opencode-models'
import { listCursorAvailableModels } from '../cursor-models'
import { sessionManager } from '../session/manager'
import { commandManager } from '../commands/manager'
import { ptyManager } from '../terminal/manager'
import { getCachedGitBranch, getCachedGitStatus, commitChanges, stageFile, stageFiles, unstageFile, stageAll, unstageAll, generateCommitMessage, generateCommitMessageWithContext, generateBranchName, generatePullRequestText, gitPush, gitPushSetUpstream, gitPull, gitPullOrigin, gitPullWithAutoStash, gitFetchRemoteCached, getFileDiff, getCachedCompareToMainChanges, getCompareToMainFileDiff, getCompareToBranchChanges, getCompareToBranchDiff, listCachedBranches, checkoutBranch, createBranch, mergeBranch, findMergedBranches, deleteBranches, gitInit, getRemoteUrl, isGitRepoCached, detectGitHostingProviderCached, getCachedDefaultBranch, discardFileChanges, discardAllChanges, getCachedLastCommit, amendCommit, undoLastCommit, listStashes, createStash, applyStash, popStash, dropStash, forceUnlockRepo, listCommits, listCommitFiles, getCommitFileDiff, invalidateGitCache } from '../git'
import { listOpenPullRequests, getCurrentBranchPullRequest, createPullRequest, checkoutPullRequestBranch, getPullRequestsWebUrl, getRepoWebUrl } from '../azure-devops'
import { listOpenGitHubPullRequests, getCurrentBranchGitHubPullRequest, createGitHubPullRequest, checkoutGitHubPullRequestBranch, getGitHubPullRequestsWebUrl, getGitHubRepoWebUrl } from '../github'
import { listDirectory, readFileContent, listAllFiles } from '../files'
import { startFileWatch, startRepoGitWatch, stopFileWatch, stopRepoGitWatch } from '../file-watch'
import { sshListDirectory, sshReadFileContent, sshListAllFiles } from '../ssh'
import { wslExec, wslListDirectory, wslReadFileContent, wslListAllFiles } from '../wsl'
import { listClaudeProjects, listClaudeSessions, parseSessionMessages } from '../claude-history'
import {
  saveAttachment,
  copyAttachmentFromPath,
  cleanupThreadAttachments,
  getFileInfo,
} from '../attachments'
import { getThreadLogs } from '../thread-logger'
import { restartWebhookServer, WebhookConfig } from '../webhook/server'
import { getLogsDirPath } from '../app-logger'
import { listDetectedSkills } from '../skills'
import { emitAppEvent } from '../app-events'
import { cloneLocation, createFullProject, createLocalWorktree, removeWorktreeLocation, suggestUniquePath } from '../project-admin'
import { registerRemoteControlIpcHandlers } from '../remote/client'
import { listWslDistros, testSshConnection, testWslConnection } from '../host-connection-tests'
import { searchYouTrack, testYouTrackConnection } from '../youtrack'

const MAX_EXEC_OUTPUT = 1024 * 1024

function runExecFile(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', windowsHide: true, maxBuffer: MAX_EXEC_OUTPUT },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout)
      },
    )
  })
}

function getPowerShellExe(): string {
  const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
  return `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

function mimeTypeForPath(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
  }
  return mimeMap[ext] || 'application/octet-stream'
}

function filePathToDataUrl(filePath: string): string {
  return `data:${mimeTypeForPath(filePath)};base64,${readFileSync(filePath).toString('base64')}`
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
      const whereExe = `${sysRoot}\\System32\\where.exe`
      await runExecFile(whereExe, [cmd])
      return true
    }
    await runExecFile('which', [cmd])
    return true
  } catch {
    return false
  }
}

function encodeUriPath(path: string): string {
  return path
    .split('/')
    .map((segment, index) => (index === 0 && segment === '' ? '' : encodeURIComponent(segment)))
    .join('/')
}

function getVsCodeFolderUri(dirPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): string {
  if (wsl) {
    const wslPath = /^[A-Za-z]:[/\\]/.test(dirPath) ? windowsPathToWsl(dirPath) : dirPath
    return `vscode-remote://wsl+${encodeURIComponent(wsl.distro)}${encodeUriPath(wslPath)}`
  }
  if (ssh) {
    const remotePath = dirPath.replace(/\\/g, '/')
    return `vscode-remote://ssh-remote+${encodeURIComponent(ssh.host)}${encodeUriPath(remotePath.startsWith('/') ? remotePath : `/${remotePath}`)}`
  }
  return pathToFileURL(dirPath).toString()
}

async function openFolderInVsCode(dirPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<void> {
  const folderUri = getVsCodeFolderUri(dirPath, ssh, wsl)
  const candidates = process.platform === 'win32' ? ['code.cmd', 'code'] : ['code']

  for (const candidate of candidates) {
    if (!(await commandExists(candidate))) continue
    spawn(candidate, ['--folder-uri', folderUri], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref()
    return
  }

  await shell.openExternal(folderUri)
}

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
 * Convert a WSL-native path to a Windows UNC path so Explorer can open it.
 * e.g. /home/foo/bar in distro "Ubuntu"  →  \\wsl$\Ubuntu\home\foo\bar
 *
 * Handles /mnt/c-style paths specially: /mnt/c/Users/foo → C:\Users\foo
 * so we use the real Windows path rather than going through the WSL filesystem.
 */
function wslPathToUnc(wslPath: string, distro: string): string {
  // /mnt/<drive>/... is a mounted Windows drive — convert back to a native Windows path.
  const mntMatch = wslPath.match(/^\/mnt\/([A-Za-z])(\/.*)?$/)
  if (mntMatch) {
    const drive = mntMatch[1].toUpperCase()
    const rest = (mntMatch[2] ?? '').replace(/\//g, '\\')
    return `${drive}:${rest || '\\'}`
  }
  const rel = wslPath.replace(/\//g, '\\').replace(/^\\+/, '')
  return `\\\\wsl$\\${distro}\\${rel}`
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

/**
 * Returns an error message if the thread's local working directory doesn't exist,
 * or null if it's fine (or is SSH/WSL where we can't check locally).
 */
function getLocalPathError(threadId: string): string | null {
  const location = getLocationForThread(threadId)
  if (!location) return null
  if (location.connection_type !== 'local') return null
  if (!existsSync(location.path)) {
    return `Directory not found: "${location.path}". Update the location path or restore the directory.`
  }
  return null
}

/** Look up SSH/WSL config for a given path by searching repo_locations. */
function getConfigForPath(path: string): { ssh: SshConfig | null; wsl: WslConfig | null } {
  const location = getLocationByPath(path)
  return { ssh: location?.ssh ?? null, wsl: location?.wsl ?? null }
}

function invalidateRepoGitCache(repoPath: string): void {
  const { ssh, wsl } = getConfigForPath(repoPath)
  invalidateGitCache(repoPath, ssh, wsl)
}

async function assertMainBranchCommitAllowed(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<void> {
  const location = getLocationByPath(repoPath)
  if (!location) return
  const project = getProjectById(location.project_id)
  if (!project || project.allow_main_branch_commits) return

  const status = await getCachedGitStatus(repoPath, ssh, wsl)
  if (status?.branch === 'main' || status?.branch === 'master') {
    throw new Error(`Commits are disabled on ${status.branch} for this project`)
  }
}

export function registerIpcHandlers(window: BrowserWindow): void {
  commandManager.init(window)
  ptyManager.init(window)
  const remoteClient = registerRemoteControlIpcHandlers(window)
  const proxyable = <T extends unknown[]>(
    channel: string,
    handler: (...args: T) => unknown | Promise<unknown>,
  ): void => {
    ipcMain.handle(channel, async (_event, ...args: T) => {
      const proxied = await remoteClient.invokeIfActive(channel, args)
      if (proxied.handled) return proxied.value
      return handler(...args)
    })
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  proxyable('projects:list', () => {
    return listProjects()
  })

  proxyable('projects:create', (name: string, gitUrl?: string | null, allowMainBranchCommits?: boolean) => {
    return createProject(name, gitUrl, allowMainBranchCommits ?? true)
  })

  // Atomically provision a brand-new project *and* its first local location in one shot.
  // All filesystem/git work (mkdir + init, clone, remote detection) happens BEFORE any DB
  // rows are written, so a failure never leaves an orphaned project behind.
  proxyable('projects:createFull', (spec: NewProjectSpec) => {
    return createFullProject(spec)
  })

  proxyable('projects:update', (id: string, name: string, gitUrl?: string | null, allowMainBranchCommits?: boolean) => {
    return updateProject(id, name, gitUrl, allowMainBranchCommits ?? true)
  })

  proxyable('projects:delete', (id: string) => {
    sessionManager.stopAll()
    commandManager.stopAll()
    return deleteProject(id)
  })

  proxyable('projects:listArchived', () => {
    return listArchivedProjects()
  })

  proxyable('projects:archive', (id: string) => {
    return archiveProject(id)
  })

  proxyable('projects:unarchive', (id: string) => {
    return unarchiveProject(id)
  })

  // ── Repo Locations ────────────────────────────────────────────────────────

  proxyable('locations:list', (projectId: string) => {
    return listLocations(projectId)
  })

  proxyable('locations:create', (projectId: string, label: string, connectionType: ConnectionType, locationPath: string, poolId?: string | null, ssh?: SshConfig | null, wsl?: WslConfig | null) => {
    return createLocation(projectId, label, connectionType, locationPath, poolId, ssh, wsl)
  })

  proxyable('locations:update', (id: string, label: string, connectionType: ConnectionType, locationPath: string, poolId?: string | null, ssh?: SshConfig | null, wsl?: WslConfig | null) => {
    return updateLocation(id, label, connectionType, locationPath, poolId, ssh, wsl)
  })

  proxyable('locations:delete', (id: string) => {
    return deleteLocation(id)
  })

  proxyable('locations:createWorktree', (parentLocationId: string, label?: string | null) => {
    return createLocalWorktree(parentLocationId, label)
  })

  proxyable('locations:removeWorktree', (id: string) => {
    return removeWorktreeLocation(id)
  })

  proxyable('locations:checkout', (id: string) => {
    return checkoutLocation(id)
  })

  proxyable('locations:returnToPool', (id: string) => {
    return returnLocationToPool(id)
  })

  proxyable('location-pools:list', (projectId: string) => {
    return listLocationPools(projectId)
  })

  proxyable('location-pools:create', (projectId: string, name: string) => {
    return createLocationPool(projectId, name)
  })

  proxyable('location-pools:update', (id: string, name: string) => {
    return updateLocationPool(id, name)
  })

  proxyable('location-pools:delete', (id: string) => {
    return deleteLocationPool(id)
  })

  proxyable('locations:pathExists', (path: string): boolean => {
    return existsSync(path)
  })

  proxyable('locations:suggestPath', (baseDir: string, repoName: string): string => {
    return suggestUniquePath(baseDir, repoName)
  })

  proxyable('locations:clone', (projectId: string, label: string, gitUrl: string, clonePath: string) => {
    return cloneLocation(projectId, label, gitUrl, clonePath)
  })

  // ── SSH / WSL test ──────────────────────────────────────────────────────────

  proxyable('ssh:test', (ssh: SshConfig, remotePath: string) => {
    return testSshConnection(ssh, remotePath)
  })

  proxyable('wsl:test', (wsl: WslConfig, wslPath: string) => {
    return testWslConnection(wsl, wslPath)
  })

  proxyable('wsl:list-distros', () => {
    return listWslDistros()
  })

  // ── Threads ───────────────────────────────────────────────────────────────

  proxyable('threads:list', (projectId: string) => {
    return listThreads(projectId)
  })

  proxyable('threads:create', (projectId: string, name: string, locationId: string) => {
    const { provider, model } = getLastUsedProviderAndModel(projectId)
    return createThread(projectId, name, locationId, provider, model)
  })

  proxyable('threads:delete', (id: string) => {
    sessionManager.remove(id)
    return deleteThread(id)
  })

  proxyable('threads:archivedCount', (projectId: string) => {
    return archivedThreadCount(projectId)
  })

  proxyable('threads:listArchived', (projectId: string, limit?: number, offset?: number) => {
    return listArchivedThreads(projectId, limit, offset)
  })

  proxyable('threads:archive', (id: string) => {
    sessionManager.remove(id)
    if (threadHasMessages(id)) {
      archiveThread(id)
      return 'archived'
    } else {
      deleteThread(id)
      return 'deleted'
    }
  })

  proxyable('threads:unarchive', (id: string) => {
    return unarchiveThread(id)
  })

  proxyable('threads:updateName', (id: string, name: string) => {
    return updateThreadName(id, name)
  })

  proxyable('threads:updateModel', (id: string, model: string) => {
    // Drop any live session so next message picks up the new model
    sessionManager.remove(id)
    return updateThreadModel(id, model)
  })

  proxyable('threads:updateProviderAndModel', (id: string, provider: string, model: string) => {
    sessionManager.remove(id)
    return updateThreadProviderAndModel(id, provider, model)
  })

  proxyable('threads:updateReasoningLevel', (id: string, reasoningLevel: string) => {
    sessionManager.remove(id)
    return updateThreadReasoningLevel(id, reasoningLevel)
  })

  proxyable('threads:updateCursorThinking', (id: string, thinking: boolean | null) => {
    sessionManager.remove(id)
    return updateThreadCursorThinking(id, thinking)
  })

  proxyable('threads:updateCursorContext', (id: string, context: string | null) => {
    sessionManager.remove(id)
    return updateThreadCursorContext(id, context)
  })

  proxyable('threads:setUnread', (threadId: string, unread: boolean) => {
    return updateThreadUnread(threadId, unread)
  })

  proxyable('threads:setYolo', (threadId: string, yoloMode: boolean) => {
    sessionManager.remove(threadId)
    return updateThreadYoloMode(threadId, yoloMode)
  })

  proxyable('threads:setPermissionMode', (threadId: string, permissionMode: string) => {
    sessionManager.remove(threadId)
    return updateThreadPermissionMode(threadId, permissionMode)
  })

  proxyable('threads:setWsl', (threadId: string, useWsl: boolean, wslDistro: string | null) => {
    if (threadHasMessages(threadId)) return // locked after first message
    sessionManager.remove(threadId) // drop existing session so it gets recreated
    updateThreadWsl(threadId, useWsl, wslDistro)
  })

  proxyable('threads:start', (threadId: string) => {
    if (!threadExists(threadId)) return
    const pathError = getLocalPathError(threadId)
    if (pathError) throw new Error(pathError)
    const effectiveDir = getEffectiveWorkingDir(threadId)
    const sshConfig = getSshConfigForThread(threadId)
    const wslConfig = getWslConfigForThread(threadId)
    const session = sessionManager.getOrCreate(threadId, effectiveDir, window, sshConfig, wslConfig)
    if (!session.isRunning()) {
      session.start()
    }
  })

  proxyable('threads:stop', (threadId: string) => {
    const session = sessionManager.get(threadId)
    if (session?.isRunning()) {
      session.stop()
    } else {
      // No live session (e.g. after restart) — force-reset stuck status in DB and notify renderer
      updateThreadStatus(threadId, 'idle')
      emitAppEvent(window, `thread:status:${threadId}`, 'idle')
      emitAppEvent(window, `thread:pid:${threadId}`, null)
    }
  })

  proxyable('threads:reset', (threadId: string) => {
    sessionManager.reset(threadId)
    updateThreadStatus(threadId, 'idle')
    emitAppEvent(window, `thread:status:${threadId}`, 'idle')
    emitAppEvent(window, `thread:pid:${threadId}`, null)
  })

  proxyable('threads:getPid', (threadId: string) => {
    return sessionManager.get(threadId)?.getPid() ?? null
  })

  proxyable('threads:send', (threadId: string, content: string, options?: { planMode?: boolean; fastMode?: boolean }) => {
    if (!threadExists(threadId)) {
      sessionManager.remove(threadId)
      console.warn('[handlers] threads:send for missing thread — ignoring', threadId)
      return
    }
    const pathError = getLocalPathError(threadId)
    if (pathError) throw new Error(pathError)
    const effectiveDir = getEffectiveWorkingDir(threadId)
    const sshConfig = getSshConfigForThread(threadId)
    const wslConfig = getWslConfigForThread(threadId)
    const session = sessionManager.getOrCreate(threadId, effectiveDir, window, sshConfig, wslConfig)
    session.sendMessage(content, options)
    // Capture git branch on first message (fire-and-forget, doesn't block send)
    const location = getLocationForThread(threadId)
    if (location) {
      getCachedGitBranch(location.path, location.ssh, location.wsl).then((branch) => {
        if (branch) setThreadGitBranchIfUnset(threadId, branch)
      }).catch(() => {/* not a git repo */})
    }
  })

  proxyable('threads:approvePlan', (threadId: string) => {
    const session = sessionManager.get(threadId)
    if (session) {
      session.approvePlan()
    }
  })

  proxyable('threads:rejectPlan', (threadId: string) => {
    const session = sessionManager.get(threadId)
    if (session) {
      session.rejectPlan()
    }
  })

  proxyable('threads:getQuestions', (threadId: string) => {
    const session = sessionManager.get(threadId)
    return session?.getPendingQuestions() ?? []
  })

  proxyable('threads:answerQuestion', (threadId: string, answers: Record<string, QuestionAnswerValue>, questionComments: Record<string, string>, generalComment: string) => {
    const session = sessionManager.get(threadId)
    if (session) {
      session.answerQuestion(answers, questionComments, generalComment)
    }
  })

  proxyable('threads:getPendingPermissions', (threadId: string) => {
    const session = sessionManager.get(threadId)
    return session?.getPendingPermissions() ?? []
  })

  proxyable('threads:approvePermissions', (threadId: string, requestId?: string) => {
    const session = sessionManager.get(threadId)
    if (session) {
      session.approvePermissions(requestId)
    }
  })

  proxyable('threads:denyPermissions', (threadId: string, requestId?: string) => {
    const session = sessionManager.get(threadId)
    if (session) {
      session.denyPermissions(requestId)
    }
  })

  proxyable('threads:executePlanInNewContext', (threadId: string) => {
    if (!threadExists(threadId)) return
    const effectiveDir = getEffectiveWorkingDir(threadId)
    const sshConfig = getSshConfigForThread(threadId)
    const wslConfig = getWslConfigForThread(threadId)
    const session = sessionManager.getOrCreate(threadId, effectiveDir, window, sshConfig, wslConfig)
    session.executePlanInNewContext()
  })

  proxyable('threads:getModifiedFiles', (threadId: string) => {
    const workingDir = getWorkingDirForThread(threadId) ?? ''
    return getThreadModifiedFiles(threadId, workingDir)
  })

  proxyable('threads:getLogs', (threadId: string) => {
    return getThreadLogs(threadId)
  })

  // ── Sessions ────────────────────────────────────────────────────────────────

  proxyable('sessions:list', (threadId: string) => {
    return listSessions(threadId)
  })

  proxyable('sessions:getActive', (threadId: string) => {
    return getActiveSession(threadId)
  })

  proxyable('sessions:switch', (threadId: string, sessionId: string) => {
    if (!threadExists(threadId)) return
    const effectiveDir = getEffectiveWorkingDir(threadId)
    const sshConfig = getSshConfigForThread(threadId)
    const wslConfig = getWslConfigForThread(threadId)
    const session = sessionManager.getOrCreate(threadId, effectiveDir, window, sshConfig, wslConfig)
    session.switchSession(sessionId)
  })

  // ── Messages ──────────────────────────────────────────────────────────────

  proxyable('messages:list', (threadId: string) => {
    return listMessages(threadId)
  })

  proxyable('messages:listBySession', (sessionId: string) => {
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

  proxyable('git:branch', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getCachedGitBranch(repoPath, ssh, wsl)
  })

  proxyable('git:status', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getCachedGitStatus(repoPath, ssh, wsl)
  })

  proxyable('git:commit', async (repoPath: string, message: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await assertMainBranchCommitAllowed(repoPath, ssh, wsl)
    await commitChanges(repoPath, message, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:lastCommit', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getCachedLastCommit(repoPath, ssh, wsl)
  })

  proxyable('git:amendCommit', async (repoPath: string, message?: string | null) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await assertMainBranchCommitAllowed(repoPath, ssh, wsl)
    await amendCommit(repoPath, message ?? null, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:undoLastCommit', async (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await undoLastCommit(repoPath, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:stage', async (repoPath: string, filePath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await stageFile(repoPath, filePath, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:unstage', async (repoPath: string, filePath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await unstageFile(repoPath, filePath, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:stageAll', async (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await stageAll(repoPath, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:unstageAll', async (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await unstageAll(repoPath, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:stageFiles', async (repoPath: string, filePaths: string[]) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await stageFiles(repoPath, filePaths, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:discardFile', async (repoPath: string, filePath: string, oldPath?: string | null) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await discardFileChanges(repoPath, filePath, oldPath ?? null, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:discardFiles', async (repoPath: string, files: Array<{ path: string; oldPath?: string | null }>) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    // Discard one at a time so one failure doesn't abort the rest
    const errors: Array<{ path: string; error: string }> = []
    for (const file of files) {
      try {
        await discardFileChanges(repoPath, file.path, file.oldPath ?? null, ssh, wsl)
      } catch (err) {
        errors.push({ path: file.path, error: err instanceof Error ? err.message : String(err) })
      }
    }
    if (errors.length > 0) {
      throw new Error(`Failed to discard ${errors.length} file${errors.length !== 1 ? 's' : ''}: ${errors.map((e) => `${e.path} (${e.error})`).join('; ')}`)
    }
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:discardAll', async (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await discardAllChanges(repoPath, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:generateCommitMessage', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return generateCommitMessage(repoPath, ssh, wsl)
  })

  proxyable('git:generateCommitMessageWithContext', (repoPath: string, filePaths: string[], context: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return generateCommitMessageWithContext(repoPath, filePaths, context, ssh, wsl)
  })

  proxyable('git:generateBranchName', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return generateBranchName(repoPath, ssh, wsl)
  })

  proxyable('git:generatePullRequestText', (repoPath: string, targetBranch: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return generatePullRequestText(repoPath, targetBranch, ssh, wsl)
  })

  proxyable('git:push', async (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    const result = await gitPush(repoPath, ssh, wsl)
    invalidateRepoGitCache(repoPath)
    return result
  })

  proxyable('git:pushSetUpstream', async (repoPath: string, branch: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    const result = await gitPushSetUpstream(repoPath, branch, ssh, wsl)
    invalidateRepoGitCache(repoPath)
    return result
  })

  proxyable('git:pull', async (repoPath: string, autoStash?: boolean) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    const result = autoStash
      ? await gitPullWithAutoStash(repoPath, true, ssh, wsl)
      : await gitPull(repoPath, ssh, wsl)
    invalidateRepoGitCache(repoPath)
    return result
  })

  proxyable('git:pullOrigin', async (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    const result = await gitPullOrigin(repoPath, ssh, wsl)
    invalidateRepoGitCache(repoPath)
    return result
  })

  // ─── Stash ────────────────────────────────────────────────────────────────
  proxyable('git:stashList', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return listStashes(repoPath, ssh, wsl)
  })

  proxyable('git:stashCreate', async (repoPath: string, opts: { message?: string; includeUntracked?: boolean }) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await createStash(repoPath, opts ?? {}, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:stashApply', async (repoPath: string, ref: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await applyStash(repoPath, ref, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:stashPop', async (repoPath: string, ref: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await popStash(repoPath, ref, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:stashDrop', async (repoPath: string, ref: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await dropStash(repoPath, ref, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:forceUnlock', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return forceUnlockRepo(repoPath, ssh, wsl)
  })

  proxyable('git:fetchRemote', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return gitFetchRemoteCached(repoPath, ssh, wsl)
  })

  proxyable('git:diff', (repoPath: string, filePath: string, staged: boolean) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getFileDiff(repoPath, filePath, staged, ssh, wsl)
  })

  proxyable('git:compareToMain', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getCachedCompareToMainChanges(repoPath, ssh, wsl)
  })

  proxyable('git:compareDiffToMain', (repoPath: string, filePath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getCompareToMainFileDiff(repoPath, filePath, ssh, wsl)
  })

  proxyable('git:compareToBranch', (repoPath: string, targetBranch: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getCompareToBranchChanges(repoPath, targetBranch, ssh, wsl)
  })

  proxyable('git:compareDiffToBranch', (repoPath: string, targetBranch: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getCompareToBranchDiff(repoPath, targetBranch, ssh, wsl)
  })

  proxyable('git:log', (repoPath: string, opts?: { range?: string; limit?: number }) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return listCommits(repoPath, opts ?? {}, ssh, wsl)
  })

  proxyable('git:commitFiles', (repoPath: string, sha: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return listCommitFiles(repoPath, sha, ssh, wsl)
  })

  proxyable('git:commitDiff', (repoPath: string, sha: string, filePath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getCommitFileDiff(repoPath, sha, filePath, ssh, wsl)
  })

  proxyable('git:branches', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return listCachedBranches(repoPath, ssh, wsl)
  })

  proxyable('git:watchStart', (repoPath: string) => {
    return startRepoGitWatch(window, repoPath, invalidateRepoGitCache)
  })

  proxyable('git:watchStop', (repoPath: string) => {
    stopRepoGitWatch(repoPath)
  })

  proxyable('git:checkout', async (repoPath: string, branch: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await checkoutBranch(repoPath, branch, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:createBranch', async (repoPath: string, name: string, base: string, pullFirst: boolean) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await createBranch(repoPath, name, base, pullFirst, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:merge', async (repoPath: string, source: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    const result = await mergeBranch(repoPath, source, ssh, wsl)
    invalidateRepoGitCache(repoPath)
    return result
  })

  proxyable('git:findMergedBranches', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return findMergedBranches(repoPath, ssh, wsl)
  })

  proxyable('git:deleteBranches', (repoPath: string, branches: string[]) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return deleteBranches(repoPath, branches, ssh, wsl)
  })

  proxyable('git:init', async (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await gitInit(repoPath, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:isRepo', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return isGitRepoCached(repoPath, ssh, wsl)
  })

  proxyable('git:getRemoteUrl', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getRemoteUrl(repoPath, ssh, wsl)
  })

  proxyable('git:hostingProvider', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return detectGitHostingProviderCached(repoPath, ssh, wsl)
  })

  proxyable('git:defaultBranch', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getCachedDefaultBranch(repoPath, ssh, wsl)
  })

  // ── Azure DevOps Pull Requests ────────────────────────────────────────────

  proxyable('azdo:pr:list', async (repoPath: string) => {
    try {
      const { ssh, wsl } = getConfigForPath(repoPath)
      return await listOpenPullRequests(repoPath, ssh, wsl)
    } catch (err) {
      if (err instanceof Error && /No Azure DevOps remote found/i.test(err.message)) return []
      throw err
    }
  })

  proxyable('azdo:pr:current', async (repoPath: string, branch: string) => {
    try {
      const { ssh, wsl } = getConfigForPath(repoPath)
      return await getCurrentBranchPullRequest(repoPath, branch, ssh, wsl)
    } catch (err) {
      if (err instanceof Error && /No Azure DevOps remote found/i.test(err.message)) return null
      throw err
    }
  })

  proxyable('azdo:pr:create', (repoPath: string, payload: { target: string; title: string; description?: string }) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return createPullRequest(repoPath, payload, ssh, wsl)
  })

  proxyable('azdo:pr:checkout', async (repoPath: string, prId: number) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    const result = await checkoutPullRequestBranch(repoPath, prId, ssh, wsl)
    invalidateRepoGitCache(repoPath)
    return result
  })

  proxyable('azdo:pr:webUrl', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getPullRequestsWebUrl(repoPath, ssh, wsl)
  })

  proxyable('azdo:repo:webUrl', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getRepoWebUrl(repoPath, ssh, wsl)
  })

  // ── GitHub Pull Requests ──────────────────────────────────────────────────

  proxyable('gh:pr:list', async (repoPath: string) => {
    try {
      const { ssh, wsl } = getConfigForPath(repoPath)
      return await listOpenGitHubPullRequests(repoPath, ssh, wsl)
    } catch (err) {
      if (err instanceof Error && /No GitHub remote found/i.test(err.message)) return []
      throw err
    }
  })

  proxyable('gh:pr:current', async (repoPath: string, branch: string) => {
    try {
      const { ssh, wsl } = getConfigForPath(repoPath)
      return await getCurrentBranchGitHubPullRequest(repoPath, branch, ssh, wsl)
    } catch (err) {
      if (err instanceof Error && /No GitHub remote found/i.test(err.message)) return null
      throw err
    }
  })

  proxyable('gh:pr:create', (repoPath: string, payload: { target: string; title: string; description?: string }) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return createGitHubPullRequest(repoPath, payload, ssh, wsl)
  })

  proxyable('gh:pr:checkout', async (repoPath: string, prId: number) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    const result = await checkoutGitHubPullRequestBranch(repoPath, prId, ssh, wsl)
    invalidateRepoGitCache(repoPath)
    return result
  })

  proxyable('gh:pr:webUrl', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getGitHubPullRequestsWebUrl(repoPath, ssh, wsl)
  })

  proxyable('gh:repo:webUrl', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getGitHubRepoWebUrl(repoPath, ssh, wsl)
  })

  // ── Files ────────────────────────────────────────────────────────────────

  proxyable('files:list', (dirPath: string) => {
    const { ssh, wsl } = getConfigForPath(dirPath)
    if (ssh) return sshListDirectory(ssh, dirPath)
    if (wsl) return wslListDirectory(wsl, dirPath)
    return listDirectory(dirPath)
  })

  proxyable('files:read', (filePath: string) => {
    const { ssh, wsl } = getConfigForPath(filePath)
    if (ssh) return sshReadFileContent(ssh, filePath)
    if (wsl) return wslReadFileContent(wsl, filePath)
    return readFileContent(filePath)
  })

  proxyable('files:searchList', (rootPath: string) => {
    const { ssh, wsl } = getConfigForPath(rootPath)
    if (ssh) return sshListAllFiles(ssh, rootPath)
    if (wsl) return wslListAllFiles(wsl, rootPath)
    return listAllFiles(rootPath)
  })

  proxyable('files:watchStart', (filePath: string) => {
    const { ssh, wsl } = getConfigForPath(filePath)
    if (ssh || wsl) return false
    return startFileWatch(window, filePath)
  })

  proxyable('files:watchStop', (filePath: string) => {
    stopFileWatch(filePath)
  })

  // ── Claude History ─────────────────────────────────────────────────────────

  proxyable('claude-history:listProjects', () => {
    return listClaudeProjects()
  })

  proxyable('claude-history:listSessions', (encodedPath: string) => {
    return listClaudeSessions(encodedPath)
  })

  proxyable('claude-history:importedIds', (projectId: string) => {
    return getImportedSessionIds(projectId)
  })

  proxyable('claude-history:import', (projectId: string, locationId: string, sessionFilePath: string, sessionId: string, name: string) => {
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
    return remoteClient.invokeIfActive('attachments:save', [dataUrl, filename, threadId]).then((proxied) => {
      if (proxied.handled) return proxied.value
      return saveAttachment(dataUrl, filename, threadId)
    })
  })

  ipcMain.handle('attachments:saveFromPath', async (_event, sourcePath: string, threadId: string) => {
    const dataUrl = filePathToDataUrl(sourcePath)
    const proxied = await remoteClient.invokeIfActive('attachments:save', [
      dataUrl,
      basename(sourcePath),
      threadId,
    ])
    if (proxied.handled && proxied.value && typeof proxied.value === 'object') {
      return { ...proxied.value, dataUrl }
    }
    return { ...copyAttachmentFromPath(sourcePath, threadId), dataUrl }
  })

  ipcMain.handle('attachments:cleanup', (_event, threadId: string) => {
    return remoteClient.invokeIfActive('attachments:cleanup', [threadId]).then((proxied) => {
      if (proxied.handled) return proxied.value
      return cleanupThreadAttachments(threadId)
    })
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

  proxyable('commands:list', (projectId: string) => {
    return listCommands(projectId)
  })

  proxyable('commands:create', (projectId: string, name: string, command: string, cwd?: string | null, shell?: string | null, runOnWorktreeCreate?: boolean) => {
    return createCommand(projectId, name, command, cwd, shell, runOnWorktreeCreate ?? false)
  })

  proxyable('commands:update', (id: string, name: string, command: string, cwd?: string | null, shell?: string | null, runOnWorktreeCreate?: boolean) => {
    return updateCommand(id, name, command, cwd, shell, runOnWorktreeCreate ?? false)
  })

  proxyable('commands:delete', (id: string) => {
    commandManager.stopAllInstances(id)
    return deleteCommand(id)
  })

  proxyable('commands:start', async (commandId: string, locationId: string) => {
    await commandManager.start(commandId, locationId)
  })

  proxyable('commands:stop', async (commandId: string, locationId: string) => {
    await commandManager.stop(commandId, locationId)
  })

  proxyable('commands:restart', async (commandId: string, locationId: string) => {
    await commandManager.restart(commandId, locationId)
  })

  proxyable('commands:getStatus', (commandId: string, locationId: string) => {
    return commandManager.getStatus(commandId, locationId)
  })

  proxyable('commands:getLogs', (commandId: string, locationId: string) => {
    return commandManager.getLogs(commandId, locationId)
  })

  proxyable('commands:getPid', (commandId: string, locationId: string) => {
    return commandManager.getPid(commandId, locationId)
  })
  proxyable('commands:getPorts', (commandId: string, locationId: string) => {
    return commandManager.getPorts(commandId, locationId)
  })

  // ── YouTrack ───────────────────────────────────────────────────────────────

  proxyable('youtrack:servers:list', () => listYouTrackServers())

  proxyable('youtrack:servers:create', (name: string, url: string, token: string) => {
    return createYouTrackServer(name, url, token)
  })

  proxyable('youtrack:servers:update', (id: string, name: string, url: string, token: string) => {
    return updateYouTrackServer(id, name, url, token)
  })

  proxyable('youtrack:servers:delete', (id: string) => {
    return deleteYouTrackServer(id)
  })

  proxyable('youtrack:test', (url: string, token: string) => {
    return testYouTrackConnection(url, token)
  })

  proxyable('youtrack:search', (url: string, token: string, query: string) => {
    return searchYouTrack(url, token, query)
  })

  // ── Slash Commands ─────────────────────────────────────────────────────────

  proxyable('slash-commands:list', (projectId?: string | null) => {
    return listSlashCommands(projectId).map((c) => ({ ...c, kind: 'command' as const }))
  })

  proxyable('skills:list', (provider: Provider, cwd?: string | null) => {
    return listDetectedSkills(provider, cwd ?? null).map((s, index) => ({
      id: s.id,
      project_id: s.scope === 'project' ? 'project' : null,
      name: s.name,
      description: s.description,
      prompt: s.invocation,
      sort_order: index,
      created_at: '',
      updated_at: '',
      kind: 'skill' as const,
      scope: s.scope,
      harness: s.harness,
      path: s.path,
      invocation: s.invocation,
    }))
  })

  proxyable('slash-commands:create', (projectId: string | null, name: string, description: string | null, prompt: string) => {
    return createSlashCommand(projectId, name, description, prompt)
  })

  proxyable('slash-commands:update', (id: string, name: string, description: string | null, prompt: string) => {
    return updateSlashCommand(id, name, description, prompt)
  })

  proxyable('slash-commands:delete', (id: string) => {
    return deleteSlashCommand(id)
  })

  // ── Settings ───────────────────────────────────────────────────────────────

  ipcMain.handle('settings:get', (_event, key: string) => {
    return getSetting(key)
  })

  ipcMain.handle('settings:set', (_event, key: string, value: string) => {
    setSetting(key, value)
  })

  // ── Shell helpers ──────────────────────────────────────────────────────────

  ipcMain.handle('shell:copyPath', (_event, dirPath: string) => {
    clipboard.writeText(dirPath)
  })

  ipcMain.handle('shell:openInExplorer', (_event, dirPath: string) => {
    shell.openPath(dirPath)
  })

  ipcMain.handle('shell:openInVsCode', async (_event, dirPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null) => {
    await openFolderInVsCode(dirPath, ssh, wsl)
  })

  // Reveal a specific file in the native file manager (Explorer / Finder), highlighting it.
  // For WSL-native paths, translates to a \\wsl$\<distro>\… UNC path so Explorer can open it.
  // Throws for SSH-hosted paths (cannot reveal a remote file locally).
  ipcMain.handle('shell:revealInExplorer', (_event, filePath: string) => {
    const { ssh, wsl } = getConfigForPath(filePath)
    if (ssh) {
      throw new Error('Cannot reveal files hosted on a remote SSH location.')
    }
    let revealPath = filePath
    if (wsl && !/^[A-Za-z]:[/\\]/.test(filePath)) {
      revealPath = wslPathToUnc(filePath, wsl.distro)
    }
    shell.showItemInFolder(revealPath)
  })

  ipcMain.handle('shell:openInTerminal', (_event, dirPath: string, wsl?: WslConfig | null) => {
    if (wsl) {
      // Launch a WSL terminal in the given distro, cd-ing to the WSL path
      const wslPath = /^[A-Za-z]:[/\\]/.test(dirPath) ? windowsPathToWsl(dirPath) : dirPath
      spawn('wsl.exe', ['-d', wsl.distro, '--cd', wslPath], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'win32') {
      spawn('start', ['powershell.exe', '-NoExit', '-Command', `Set-Location '${dirPath.replace(/'/g, "''")}'`], { cwd: dirPath, detached: true, stdio: 'ignore', shell: true }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Terminal', dirPath], { detached: true, stdio: 'ignore' }).unref()
    } else {
      const terms = ['gnome-terminal', 'konsole', 'xterm']
      for (const term of terms) {
        try {
          spawn(term, [], { cwd: dirPath, detached: true, stdio: 'ignore' }).unref()
          break
        } catch { /* try next */ }
      }
    }
  })

  // ── Process Assassin ─────────────────────────────────────────────────────────

  function killByPid(pid: number, wsl?: WslConfig | null): Promise<void> {
    if (pid === process.pid) return Promise.reject(new Error('Refusing to kill own process'))
    if (!Number.isInteger(pid) || pid <= 0) return Promise.reject(new Error('Invalid PID'))
    if (wsl) {
      return wslExec(wsl, '/', `kill -9 ${pid}`)
        .then(() => undefined)
        .catch((e: unknown) => {
          throw new Error(`kill failed: ${e instanceof Error ? e.message : String(e)}`)
        })
    }
    return new Promise((resolve, reject) => {
      if (process.platform === 'win32') {
        exec(`taskkill /F /T /PID ${pid}`, (err) => {
          if (err) reject(new Error(`taskkill failed: ${err.message}`))
          else resolve()
        })
      } else {
        try {
          process.kill(pid, 'SIGKILL')
          resolve()
        } catch (e: unknown) {
          reject(new Error(`kill failed: ${e instanceof Error ? e.message : String(e)}`))
        }
      }
    })
  }

  function findPidsByPort(port: number, wsl?: WslConfig | null): Promise<number[]> {
    return new Promise((resolve, reject) => {
      if (wsl) {
        const cmd = `if command -v lsof >/dev/null 2>&1; then lsof -ti:${port}; else ss -ltnp 'sport = :${port}' | sed -n 's/.*pid=\\([0-9]\\+\\).*/\\1/p'; fi`
        wslExec(wsl, '/', cmd)
          .then((stdout) => {
            const pids = stdout.trim().split('\n').map((s) => parseInt(s, 10)).filter((n) => n > 0)
            resolve(Array.from(new Set(pids)))
          })
          .catch(() => resolve([]))
        return
      }
      if (process.platform === 'win32') {
        const script = `
$port = ${port}
$tcp = @(Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)
$udp = @(Get-NetUDPEndpoint -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)
@($tcp + $udp) | Where-Object { $_ -gt 0 } | Sort-Object -Unique
`.trim()
        runExecFile(getPowerShellExe(), ['-NoProfile', '-NonInteractive', '-Command', script])
          .then((stdout) => {
            const pids = stdout
              .split(/\r?\n/)
              .map((line) => parseInt(line.trim(), 10))
              .filter((pid) => pid > 0)
            resolve(Array.from(new Set(pids)))
          })
          .catch((err: unknown) => {
            reject(new Error(`port lookup failed: ${err instanceof Error ? err.message : String(err)}`))
          })
      } else {
        exec(`lsof -ti:${port}`, (err, stdout) => {
          if (err) return resolve([]) // lsof returns error when no match
          const pids = stdout.trim().split('\n').map((s) => parseInt(s, 10)).filter((n) => n > 0)
          resolve(pids)
        })
      }
    })
  }

  async function killByPort(port: number, wsl?: WslConfig | null): Promise<void> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Port must be between 1 and 65535')
    }
    const pids = await findPidsByPort(port, wsl)
    if (pids.length === 0) throw new Error(`No process found on port ${port}`)
    const errors: string[] = []
    for (const pid of pids) {
      try {
        await killByPid(pid, wsl)
      } catch (e: unknown) {
        errors.push(e instanceof Error ? e.message : String(e))
      }
    }
    if (errors.length > 0 && errors.length === pids.length) {
      throw new Error(errors.join('; '))
    }
  }

  proxyable('process:kill', async (target: string, type: 'pid' | 'port', threadId?: string) => {
    try {
      const num = parseInt(target, 10)
      if (isNaN(num)) return { ok: false, error: 'Invalid number' }
      const wsl = threadId ? getWslConfigForThread(threadId) : null
      if (type === 'pid') {
        await killByPid(num, wsl)
      } else {
        await killByPort(num, wsl)
      }
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── Window Controls ────────────────────────────────────────────────────────

  ipcMain.handle('window:minimize',     () => window.minimize())
  ipcMain.handle('window:maximize',     () => window.isMaximized() ? window.unmaximize() : window.maximize())
  ipcMain.handle('window:close',        () => window.close())
  ipcMain.handle('window:is-maximized', () => window.isMaximized())

  window.on('maximize',   () => window.webContents.send('window:maximized-changed', true))
  window.on('unmaximize', () => window.webContents.send('window:maximized-changed', false))

  // ── App info ──────────────────────────────────────────────────────────────

  ipcMain.handle('app:getVersion', () => {
    const version = app.getVersion()
    const packaged = app.isPackaged
    const isDev = !packaged && process.env.NODE_ENV !== 'production'
    if (isDev) return 'Local Dev'
    return `v${version}`
  })

  ipcMain.handle('app:open-logs-folder', () => {
    return shell.openPath(getLogsDirPath())
  })

  // ── Auto-updater ───────────────────────────────────────────────────────────

  ipcMain.handle('update:check', () => {
    checkForUpdates()
    return getUpdateState()
  })

  ipcMain.handle('update:apply', () => {
    return { success: applyUpdate() }
  })

  ipcMain.handle('update:get-state', () => {
    return getUpdateState()
  })

  // ── CLI health & updates ────────────────────────────────────────────────────

  proxyable('cli:health', (
    provider: Provider,
    connectionType: string,
    ssh?: SshConfig | null,
    wsl?: WslConfig | null,
  ) => {
    return checkCliHealth(provider, connectionType, ssh, wsl)
  })

  proxyable('cli:update', async (
    provider: Provider,
    connectionType: string,
    ssh?: SshConfig | null,
    wsl?: WslConfig | null,
  ) => {
    const result = await updateCli(provider, connectionType, ssh, wsl)
    invalidateCliHealthCache(provider, connectionType, ssh, wsl)
    return result
  })

  proxyable('models:claudeAvailable', (threadId?: string | null) => {
    if (!threadId || !threadExists(threadId)) {
      return listClaudeAvailableModels()
    }

    return listClaudeAvailableModels({
      cwd: getEffectiveWorkingDir(threadId) || getWorkingDirForThread(threadId),
      ssh: getSshConfigForThread(threadId),
      wsl: getWslConfigForThread(threadId),
    })
  })

  proxyable('models:codexAvailable', (threadId?: string | null) => {
    if (!threadId || !threadExists(threadId)) {
      return listCodexAvailableModels()
    }

    return listCodexAvailableModels({
      cwd: getEffectiveWorkingDir(threadId) || getWorkingDirForThread(threadId),
      ssh: getSshConfigForThread(threadId),
      wsl: getWslConfigForThread(threadId),
    })
  })

  proxyable('models:opencodeAvailable', (threadId?: string | null) => {
    if (!threadId || !threadExists(threadId)) {
      return listOpenCodeAvailableModels()
    }

    return listOpenCodeAvailableModels({
      cwd: getEffectiveWorkingDir(threadId) || getWorkingDirForThread(threadId),
      ssh: getSshConfigForThread(threadId),
      wsl: getWslConfigForThread(threadId),
    })
  })

  proxyable('models:piAvailable', (threadId?: string | null) => {
    if (!threadId || !threadExists(threadId)) {
      return listPiAvailableModels()
    }

    return listPiAvailableModels({
      cwd: getEffectiveWorkingDir(threadId) || getWorkingDirForThread(threadId),
      ssh: getSshConfigForThread(threadId),
      wsl: getWslConfigForThread(threadId),
    })
  })

  proxyable('models:cursorAvailable', (threadId?: string | null) => {
    if (!threadId || !threadExists(threadId)) {
      return listCursorAvailableModels()
    }

    return listCursorAvailableModels({
      cwd: getEffectiveWorkingDir(threadId) || getWorkingDirForThread(threadId),
      ssh: getSshConfigForThread(threadId),
      wsl: getWslConfigForThread(threadId),
    })
  })

  // ── Terminal (PTY) ──────────────────────────────────────────────────────────

  proxyable('terminal:spawn', (threadId: string, cols: number, rows: number) => {
    const location = getLocationForThread(threadId)
    if (!location) throw new Error('No location associated with this thread')

    const terminalId = `term-${threadId}-${Date.now()}`
    const connectionType = location.connection_type
    const cwd = getEffectiveWorkingDir(threadId) || location.path
    const ssh = getSshConfigForThread(threadId)
    const wsl = getWslConfigForThread(threadId)

    ptyManager.spawn(terminalId, threadId, cwd, connectionType, cols, rows, ssh, wsl)
    return terminalId
  })

  ipcMain.on('terminal:write', (_event, terminalId: string, data: string) => {
    void remoteClient.invokeIfActive('terminal:write', [terminalId, data]).then((proxied) => {
      if (!proxied.handled) ptyManager.write(terminalId, data)
    })
  })

  ipcMain.on('terminal:resize', (_event, terminalId: string, cols: number, rows: number) => {
    void remoteClient.invokeIfActive('terminal:resize', [terminalId, cols, rows]).then((proxied) => {
      if (!proxied.handled) ptyManager.resize(terminalId, cols, rows)
    })
  })

  proxyable('terminal:write', (terminalId: string, data: string) => {
    ptyManager.write(terminalId, data)
  })

  proxyable('terminal:resize', (terminalId: string, cols: number, rows: number) => {
    ptyManager.resize(terminalId, cols, rows)
  })

  proxyable('terminal:kill', (terminalId: string) => {
    ptyManager.kill(terminalId)
  })

  proxyable('terminal:getBuffer', (terminalId: string) => {
    return ptyManager.getBuffer(terminalId)
  })

  // ── Webhook ─────────────────────────────────────────────────────────────────

  ipcMain.handle('webhook:getConfig', () => {
    return {
      enabled: getSetting('webhook:enabled') === 'true',
      port: parseInt(getSetting('webhook:port') ?? '3284', 10),
      token: getSetting('webhook:token') ?? '',
    } satisfies WebhookConfig
  })

  ipcMain.handle('webhook:setConfig', (_event, config: WebhookConfig) => {
    setSetting('webhook:enabled', config.enabled ? 'true' : 'false')
    setSetting('webhook:port', String(config.port))
    setSetting('webhook:token', config.token)
    restartWebhookServer(config, window)
  })
}
