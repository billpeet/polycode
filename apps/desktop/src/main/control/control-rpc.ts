import { exec, execFile } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import { BrowserWindow } from 'electron'
import {
  archivedThreadCount,
  archiveThread,
  checkoutLocation,
  createSlashCommand,
  createThread,
  deleteSlashCommand,
  deleteThread,
  getActiveSession,
  getLastUsedProviderAndModel,
  getLocationByPath,
  getLocationForThread,
  getProjectById,
  getThreadModifiedFiles,
  getThreadWsl,
  listCommands,
  listArchivedProjects,
  listArchivedThreads,
  listLocationPools,
  listLocations,
  listMessages,
  listMessagesBySession,
  listProjects,
  listSessions,
  listSlashCommands,
  listThreads,
  returnLocationToPool,
  setThreadGitBranchIfUnset,
  threadExists,
  threadHasMessages,
  unarchiveThread,
  updateSlashCommand,
  updateThreadModel,
  updateThreadName,
  updateThreadProviderAndModel,
  updateThreadPermissionMode,
  updateThreadReasoningLevel,
  updateThreadStatus,
  updateThreadUnread,
  updateThreadWsl,
  updateThreadYoloMode,
  createCommand,
  updateCommand,
  deleteCommand,
} from '../db/queries'
import { sessionManager } from '../session/manager'
import { commandManager } from '../commands/manager'
import { ptyManager } from '../terminal/manager'
import { getThreadLogs } from '../thread-logger'
import {
  amendCommit,
  checkoutBranch,
  commitChanges,
  createBranch,
  createStash,
  deleteBranches,
  detectGitHostingProviderCached,
  discardAllChanges,
  discardFileChanges,
  dropStash,
  findMergedBranches,
  forceUnlockRepo,
  generateBranchName,
  generateCommitMessage,
  generateCommitMessageWithContext,
  generatePullRequestText,
  getCachedCompareToMainChanges,
  getCachedDefaultBranch,
  getCachedGitBranch,
  getCachedGitStatus,
  getCachedLastCommit,
  getCommitFileDiff,
  getCompareToBranchChanges,
  getCompareToBranchDiff,
  getCompareToMainFileDiff,
  getFileDiff,
  gitFetchRemoteCached,
  gitInit,
  gitPull,
  gitPullOrigin,
  gitPullWithAutoStash,
  gitPush,
  gitPushSetUpstream,
  invalidateGitCache,
  isGitRepoCached,
  listCachedBranches,
  listCommitFiles,
  listCommits,
  listStashes,
  mergeBranch,
  popStash,
  stageAll,
  stageFile,
  stageFiles,
  undoLastCommit,
  unstageAll,
  unstageFile,
  applyStash,
  getRemoteUrl,
} from '../git'
import {
  checkoutPullRequestBranch,
  createPullRequest,
  getCurrentBranchPullRequest,
  getPullRequestsWebUrl,
  getRepoWebUrl,
  listOpenPullRequests,
} from '../azure-devops'
import {
  checkoutGitHubPullRequestBranch,
  createGitHubPullRequest,
  getCurrentBranchGitHubPullRequest,
  getGitHubPullRequestsWebUrl,
  getGitHubRepoWebUrl,
  listOpenGitHubPullRequests,
} from '../github'
import { checkCliHealth, invalidateCliHealthCache, updateCli } from '../health/checker'
import { listClaudeAvailableModels } from '../claude-models'
import { listCodexAvailableModels } from '../codex-models'
import { listOpenCodeAvailableModels } from '../opencode-models'
import { listPiAvailableModels } from '../pi-models'
import { listCursorAvailableModels } from '../cursor-models'
import { listDetectedSkills } from '../skills'
import { emitAppEvent } from '../app-events'
import { Provider, QuestionAnswerValue, SendOptions, SshConfig, WslConfig } from '../../shared/types'
import { listAllFiles, listDirectory, readFileContent } from '../files'
import { sshListAllFiles, sshListDirectory, sshReadFileContent } from '../ssh'
import { wslExec, wslListAllFiles, wslListDirectory, wslReadFileContent } from '../wsl'
import { startFileWatch, stopFileWatch } from '../file-watch'
import { cleanupThreadAttachments, getAttachmentDir, getFileInfo, saveAttachment } from '../attachments'

export const CONTROL_RPC_CHANNELS = new Set([
  'projects:list',
  'projects:listArchived',
  'locations:list',
  'locations:pathExists',
  'locations:checkout',
  'locations:returnToPool',
  'location-pools:list',
  'threads:list',
  'threads:create',
  'threads:delete',
  'threads:archivedCount',
  'threads:listArchived',
  'threads:archive',
  'threads:unarchive',
  'threads:updateName',
  'threads:updateModel',
  'threads:updateProviderAndModel',
  'threads:updateReasoningLevel',
  'threads:setUnread',
  'threads:setYolo',
  'threads:setPermissionMode',
  'threads:setWsl',
  'threads:start',
  'threads:stop',
  'threads:reset',
  'threads:getPid',
  'threads:send',
  'threads:approvePlan',
  'threads:rejectPlan',
  'threads:getQuestions',
  'threads:answerQuestion',
  'threads:getPendingPermissions',
  'threads:approvePermissions',
  'threads:denyPermissions',
  'threads:executePlanInNewContext',
  'threads:getModifiedFiles',
  'threads:getLogs',
  'sessions:list',
  'sessions:getActive',
  'sessions:switch',
  'messages:list',
  'messages:listBySession',
  'git:branch',
  'git:status',
  'git:commit',
  'git:lastCommit',
  'git:amendCommit',
  'git:undoLastCommit',
  'git:stage',
  'git:unstage',
  'git:stageAll',
  'git:unstageAll',
  'git:stageFiles',
  'git:discardFile',
  'git:discardFiles',
  'git:discardAll',
  'git:generateCommitMessage',
  'git:generateCommitMessageWithContext',
  'git:generatePullRequestText',
  'git:generateBranchName',
  'git:push',
  'git:pushSetUpstream',
  'git:pull',
  'git:pullOrigin',
  'git:stashList',
  'git:stashCreate',
  'git:stashApply',
  'git:stashPop',
  'git:stashDrop',
  'git:forceUnlock',
  'git:fetchRemote',
  'git:diff',
  'git:compareToMain',
  'git:compareDiffToMain',
  'git:compareToBranch',
  'git:compareDiffToBranch',
  'git:log',
  'git:commitFiles',
  'git:commitDiff',
  'git:branches',
  'git:checkout',
  'git:createBranch',
  'git:merge',
  'git:findMergedBranches',
  'git:deleteBranches',
  'git:init',
  'git:isRepo',
  'git:getRemoteUrl',
  'git:hostingProvider',
  'git:defaultBranch',
  'azdo:pr:list',
  'azdo:pr:current',
  'azdo:pr:create',
  'azdo:pr:checkout',
  'azdo:pr:webUrl',
  'azdo:repo:webUrl',
  'gh:pr:list',
  'gh:pr:current',
  'gh:pr:create',
  'gh:pr:checkout',
  'gh:pr:webUrl',
  'gh:repo:webUrl',
  'files:list',
  'files:read',
  'files:searchList',
  'files:watchStart',
  'files:watchStop',
  'commands:list',
  'commands:create',
  'commands:update',
  'commands:delete',
  'commands:start',
  'commands:stop',
  'commands:restart',
  'commands:getStatus',
  'commands:getLogs',
  'commands:getPid',
  'commands:getPorts',
  'terminal:spawn',
  'terminal:write',
  'terminal:resize',
  'terminal:kill',
  'terminal:getBuffer',
  'attachments:save',
  'attachments:cleanup',
  'attachments:readDataUrl',
  'plans:getForThread',
  'process:kill',
  'cli:health',
  'cli:update',
  'models:claudeAvailable',
  'models:codexAvailable',
  'models:opencodeAvailable',
  'models:piAvailable',
  'models:cursorAvailable',
  'slash-commands:list',
  'skills:list',
  'slash-commands:create',
  'slash-commands:update',
  'slash-commands:delete',
])

function getSshConfigForThread(threadId: string): SshConfig | null {
  const location = getLocationForThread(threadId)
  return location?.ssh ?? null
}

function getWslConfigForThread(threadId: string): WslConfig | null {
  const location = getLocationForThread(threadId)
  if (location && location.connection_type === 'local') {
    const threadWsl = getThreadWsl(threadId)
    if (threadWsl.use_wsl && threadWsl.wsl_distro) {
      return { distro: threadWsl.wsl_distro }
    }
  }
  return location?.wsl ?? null
}

function getWorkingDirForThread(threadId: string): string | null {
  const location = getLocationForThread(threadId)
  return location?.path ?? null
}

function windowsPathToWsl(winPath: string): string {
  return winPath
    .replace(/^([A-Za-z]):[/\\]/, (_, drive) => `/mnt/${drive.toLowerCase()}/`)
    .replace(/\\/g, '/')
}

function getEffectiveWorkingDir(threadId: string): string {
  const location = getLocationForThread(threadId)
  if (!location) return ''
  if (location.connection_type === 'wsl' && /^[A-Za-z]:[/\\]/.test(location.path)) {
    return windowsPathToWsl(location.path)
  }
  if (location.connection_type === 'local' && /^[A-Za-z]:[/\\]/.test(location.path)) {
    const threadWsl = getThreadWsl(threadId)
    if (threadWsl.use_wsl) {
      return windowsPathToWsl(location.path)
    }
  }
  return location.path
}

function getPowerShellExe(): string {
  const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
  return `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

function runExecFile(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
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

function killByPid(pid: number, wsl?: WslConfig | null): Promise<void> {
  if (pid === process.pid) return Promise.reject(new Error('Refusing to kill own process'))
  if (!Number.isInteger(pid) || pid <= 0) return Promise.reject(new Error('Invalid PID'))
  if (wsl) {
    return wslExec(wsl, '/', `kill -9 ${pid}`)
      .then(() => undefined)
      .catch((error: unknown) => {
        throw new Error(`kill failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  }
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      exec(`taskkill /F /T /PID ${pid}`, (error) => {
        if (error) reject(new Error(`taskkill failed: ${error.message}`))
        else resolve()
      })
      return
    }
    try {
      process.kill(pid, 'SIGKILL')
      resolve()
    } catch (error) {
      reject(new Error(`kill failed: ${error instanceof Error ? error.message : String(error)}`))
    }
  })
}

function findPidsByPort(port: number, wsl?: WslConfig | null): Promise<number[]> {
  return new Promise((resolve, reject) => {
    if (wsl) {
      const cmd = `if command -v lsof >/dev/null 2>&1; then lsof -ti:${port}; else ss -ltnp 'sport = :${port}' | sed -n 's/.*pid=\\([0-9]\\+\\).*/\\1/p'; fi`
      wslExec(wsl, '/', cmd)
        .then((stdout) => {
          const pids = stdout.trim().split('\n').map((line) => Number.parseInt(line, 10)).filter((pid) => pid > 0)
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
            .map((line) => Number.parseInt(line.trim(), 10))
            .filter((pid) => pid > 0)
          resolve(Array.from(new Set(pids)))
        })
        .catch((error: unknown) => {
          reject(new Error(`port lookup failed: ${error instanceof Error ? error.message : String(error)}`))
        })
      return
    }

    exec(`lsof -ti:${port}`, (error, stdout) => {
      if (error) return resolve([])
      const pids = stdout.trim().split('\n').map((line) => Number.parseInt(line, 10)).filter((pid) => pid > 0)
      resolve(pids)
    })
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
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (errors.length > 0 && errors.length === pids.length) {
    throw new Error(errors.join('; '))
  }
}

function getLocalPathError(threadId: string): string | null {
  const location = getLocationForThread(threadId)
  if (!location) return null
  if (location.connection_type !== 'local') return null
  if (!existsSync(location.path)) {
    return `Directory not found: "${location.path}". Update the location path or restore the directory.`
  }
  return null
}

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

async function listAvailableModels(channel: string, threadId?: string | null): Promise<unknown> {
  const options = threadId && threadExists(threadId)
    ? {
        cwd: getEffectiveWorkingDir(threadId) || getWorkingDirForThread(threadId),
        ssh: getSshConfigForThread(threadId),
        wsl: getWslConfigForThread(threadId),
      }
    : undefined

  switch (channel) {
    case 'models:claudeAvailable':
      return listClaudeAvailableModels(options)
    case 'models:codexAvailable':
      return listCodexAvailableModels(options)
    case 'models:opencodeAvailable':
      return listOpenCodeAvailableModels(options)
    case 'models:piAvailable':
      return listPiAvailableModels(options)
    case 'models:cursorAvailable':
      return listCursorAvailableModels(options)
    default:
      throw new Error(`Unsupported model channel: ${channel}`)
  }
}

export async function handleControlRpc(window: BrowserWindow, channel: string, args: unknown[]): Promise<unknown> {
  switch (channel) {
    case 'projects:list':
      return listProjects()
    case 'projects:listArchived':
      return listArchivedProjects()

    case 'locations:list':
      return listLocations(args[0] as string)
    case 'locations:pathExists':
      return existsSync(args[0] as string)
    case 'locations:checkout':
      return checkoutLocation(args[0] as string)
    case 'locations:returnToPool':
      return returnLocationToPool(args[0] as string)
    case 'location-pools:list':
      return listLocationPools(args[0] as string)

    case 'threads:list':
      return listThreads(args[0] as string)
    case 'threads:create': {
      const [projectId, name, locationId] = args as [string, string, string]
      const { provider, model } = getLastUsedProviderAndModel(projectId)
      return createThread(projectId, name, locationId, provider, model)
    }
    case 'threads:delete': {
      const [id] = args as [string]
      sessionManager.remove(id)
      return deleteThread(id)
    }
    case 'threads:archivedCount':
      return archivedThreadCount(args[0] as string)
    case 'threads:listArchived': {
      const [projectId, limit, offset] = args as [string, number | undefined, number | undefined]
      return listArchivedThreads(projectId, limit, offset)
    }
    case 'threads:archive': {
      const [id] = args as [string]
      sessionManager.remove(id)
      if (threadHasMessages(id)) {
        archiveThread(id)
        return 'archived'
      }
      deleteThread(id)
      return 'deleted'
    }
    case 'threads:unarchive':
      return unarchiveThread(args[0] as string)
    case 'threads:updateName': {
      const [id, name] = args as [string, string]
      return updateThreadName(id, name)
    }
    case 'threads:updateModel': {
      const [id, model] = args as [string, string]
      sessionManager.remove(id)
      return updateThreadModel(id, model)
    }
    case 'threads:updateProviderAndModel': {
      const [id, provider, model] = args as [string, string, string]
      sessionManager.remove(id)
      return updateThreadProviderAndModel(id, provider, model)
    }
    case 'threads:updateReasoningLevel': {
      const [id, reasoningLevel] = args as [string, string]
      sessionManager.remove(id)
      return updateThreadReasoningLevel(id, reasoningLevel)
    }
    case 'threads:setUnread': {
      const [threadId, unread] = args as [string, boolean]
      return updateThreadUnread(threadId, unread)
    }
    case 'threads:setYolo': {
      const [threadId, yoloMode] = args as [string, boolean]
      sessionManager.remove(threadId)
      return updateThreadYoloMode(threadId, yoloMode)
    }
    case 'threads:setPermissionMode': {
      const [threadId, permissionMode] = args as [string, string]
      sessionManager.remove(threadId)
      return updateThreadPermissionMode(threadId, permissionMode)
    }
    case 'threads:setWsl': {
      const [threadId, useWsl, wslDistro] = args as [string, boolean, string | null]
      if (threadHasMessages(threadId)) return undefined
      sessionManager.remove(threadId)
      return updateThreadWsl(threadId, useWsl, wslDistro)
    }
    case 'threads:start': {
      const [threadId] = args as [string]
      if (!threadExists(threadId)) return undefined
      const pathError = getLocalPathError(threadId)
      if (pathError) throw new Error(pathError)
      const session = sessionManager.getOrCreate(
        threadId,
        getEffectiveWorkingDir(threadId),
        window,
        getSshConfigForThread(threadId),
        getWslConfigForThread(threadId),
      )
      if (!session.isRunning()) session.start()
      return undefined
    }
    case 'threads:stop': {
      const [threadId] = args as [string]
      const session = sessionManager.get(threadId)
      if (session?.isRunning()) {
        session.stop()
      } else {
        updateThreadStatus(threadId, 'idle')
        emitAppEvent(window, `thread:status:${threadId}`, 'idle')
        emitAppEvent(window, `thread:pid:${threadId}`, null)
      }
      return undefined
    }
    case 'threads:reset': {
      const [threadId] = args as [string]
      sessionManager.reset(threadId)
      updateThreadStatus(threadId, 'idle')
      emitAppEvent(window, `thread:status:${threadId}`, 'idle')
      emitAppEvent(window, `thread:pid:${threadId}`, null)
      return undefined
    }
    case 'threads:getPid':
      return sessionManager.get(args[0] as string)?.getPid() ?? null
    case 'threads:send': {
      const [threadId, content, options] = args as [string, string, SendOptions | undefined]
      if (!threadExists(threadId)) {
        sessionManager.remove(threadId)
        console.warn('[remote-control] threads:send for missing thread - ignoring', threadId)
        return undefined
      }
      const pathError = getLocalPathError(threadId)
      if (pathError) throw new Error(pathError)
      const session = sessionManager.getOrCreate(
        threadId,
        getEffectiveWorkingDir(threadId),
        window,
        getSshConfigForThread(threadId),
        getWslConfigForThread(threadId),
      )
      session.sendMessage(content, options)
      // Show the remote client's user message in the local renderer. Sent
      // directly to this window (not via emitAppEvent) so it is NOT echoed
      // back over the SSE stream — the originating device already rendered
      // it optimistically and would merge the echo into a duplicate.
      if (!window.webContents.isDestroyed()) {
        window.webContents.send(`thread:output:${threadId}`, {
          type: 'text',
          content,
          metadata: { role: 'user', source: 'remote_client' },
        })
      }
      const location = getLocationForThread(threadId)
      if (location) {
        getCachedGitBranch(location.path, location.ssh, location.wsl)
          .then((branch) => { if (branch) setThreadGitBranchIfUnset(threadId, branch) })
          .catch(() => undefined)
      }
      return undefined
    }
    case 'threads:approvePlan':
      sessionManager.get(args[0] as string)?.approvePlan()
      return undefined
    case 'threads:rejectPlan':
      sessionManager.get(args[0] as string)?.rejectPlan()
      return undefined
    case 'threads:getQuestions':
      return sessionManager.get(args[0] as string)?.getPendingQuestions() ?? []
    case 'threads:answerQuestion': {
      const [threadId, answers, questionComments, generalComment] = args as [
        string,
        Record<string, QuestionAnswerValue>,
        Record<string, string>,
        string,
      ]
      sessionManager.get(threadId)?.answerQuestion(answers, questionComments, generalComment)
      return undefined
    }
    case 'threads:getPendingPermissions':
      return sessionManager.get(args[0] as string)?.getPendingPermissions() ?? []
    case 'threads:approvePermissions': {
      const [threadId, requestId] = args as [string, string | undefined]
      sessionManager.get(threadId)?.approvePermissions(requestId)
      return undefined
    }
    case 'threads:denyPermissions': {
      const [threadId, requestId] = args as [string, string | undefined]
      sessionManager.get(threadId)?.denyPermissions(requestId)
      return undefined
    }
    case 'threads:executePlanInNewContext': {
      const [threadId] = args as [string]
      if (!threadExists(threadId)) return undefined
      const session = sessionManager.getOrCreate(
        threadId,
        getEffectiveWorkingDir(threadId),
        window,
        getSshConfigForThread(threadId),
        getWslConfigForThread(threadId),
      )
      session.executePlanInNewContext()
      return undefined
    }
    case 'threads:getModifiedFiles': {
      const [threadId] = args as [string]
      return getThreadModifiedFiles(threadId, getWorkingDirForThread(threadId) ?? '')
    }
    case 'threads:getLogs':
      return getThreadLogs(args[0] as string)

    case 'sessions:list':
      return listSessions(args[0] as string)
    case 'sessions:getActive':
      return getActiveSession(args[0] as string)
    case 'sessions:switch': {
      const [threadId, sessionId] = args as [string, string]
      if (!threadExists(threadId)) return undefined
      const session = sessionManager.getOrCreate(
        threadId,
        getEffectiveWorkingDir(threadId),
        window,
        getSshConfigForThread(threadId),
        getWslConfigForThread(threadId),
      )
      session.switchSession(sessionId)
      return undefined
    }

    case 'messages:list':
      return listMessages(args[0] as string)
    case 'messages:listBySession':
      return listMessagesBySession(args[0] as string)

    case 'git:branch': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return getCachedGitBranch(repoPath, ssh, wsl)
    }
    case 'git:status': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return getCachedGitStatus(repoPath, ssh, wsl)
    }
    case 'git:commit': {
      const [repoPath, message] = args as [string, string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      await assertMainBranchCommitAllowed(repoPath, ssh, wsl)
      await commitChanges(repoPath, message, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return undefined
    }
    case 'git:lastCommit': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return getCachedLastCommit(repoPath, ssh, wsl)
    }
    case 'git:amendCommit': {
      const [repoPath, message] = args as [string, string | null | undefined]
      const { ssh, wsl } = getConfigForPath(repoPath)
      await assertMainBranchCommitAllowed(repoPath, ssh, wsl)
      await amendCommit(repoPath, message ?? null, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return undefined
    }
    case 'git:undoLastCommit': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      await undoLastCommit(repoPath, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return undefined
    }
    case 'git:stage': {
      const [repoPath, filePath] = args as [string, string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      await stageFile(repoPath, filePath, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return undefined
    }
    case 'git:unstage': {
      const [repoPath, filePath] = args as [string, string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      await unstageFile(repoPath, filePath, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return undefined
    }
    case 'git:stageAll': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      await stageAll(repoPath, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return undefined
    }
    case 'git:unstageAll': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      await unstageAll(repoPath, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return undefined
    }
    case 'git:stageFiles': {
      const [repoPath, filePaths] = args as [string, string[]]
      const { ssh, wsl } = getConfigForPath(repoPath)
      await stageFiles(repoPath, filePaths, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return undefined
    }
    case 'git:discardFile': {
      const [repoPath, filePath, oldPath] = args as [string, string, string | null | undefined]
      const { ssh, wsl } = getConfigForPath(repoPath)
      await discardFileChanges(repoPath, filePath, oldPath ?? null, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return undefined
    }
    case 'git:discardFiles': {
      const [repoPath, files] = args as [string, Array<{ path: string; oldPath?: string | null }>]
      const { ssh, wsl } = getConfigForPath(repoPath)
      const errors: Array<{ path: string; error: string }> = []
      for (const file of files) {
        try {
          await discardFileChanges(repoPath, file.path, file.oldPath ?? null, ssh, wsl)
        } catch (error) {
          errors.push({ path: file.path, error: error instanceof Error ? error.message : String(error) })
        }
      }
      if (errors.length > 0) {
        throw new Error(`Failed to discard ${errors.length} file${errors.length !== 1 ? 's' : ''}: ${errors.map((error) => `${error.path} (${error.error})`).join('; ')}`)
      }
      invalidateRepoGitCache(repoPath)
      return undefined
    }
    case 'git:discardAll': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      await discardAllChanges(repoPath, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return undefined
    }
    case 'git:generateCommitMessage': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return generateCommitMessage(repoPath, ssh, wsl)
    }
    case 'git:generateCommitMessageWithContext': {
      const [repoPath, filePaths, context] = args as [string, string[], string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return generateCommitMessageWithContext(repoPath, filePaths, context, ssh, wsl)
    }
    case 'git:generateBranchName': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return generateBranchName(repoPath, ssh, wsl)
    }
    case 'git:generatePullRequestText': {
      const [repoPath, targetBranch] = args as [string, string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return generatePullRequestText(repoPath, targetBranch, ssh, wsl)
    }
    case 'git:push': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      const result = await gitPush(repoPath, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return result
    }
    case 'git:pushSetUpstream': {
      const [repoPath, branch] = args as [string, string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      const result = await gitPushSetUpstream(repoPath, branch, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return result
    }
    case 'git:pull': {
      const [repoPath, autoStash] = args as [string, boolean | undefined]
      const { ssh, wsl } = getConfigForPath(repoPath)
      const result = autoStash
        ? await gitPullWithAutoStash(repoPath, true, ssh, wsl)
        : await gitPull(repoPath, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return result
    }
    case 'git:pullOrigin': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      const result = await gitPullOrigin(repoPath, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return result
    }
    case 'git:stashList': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return listStashes(repoPath, ssh, wsl)
    }
    case 'git:stashCreate': {
      const [repoPath, opts] = args as [string, { message?: string; includeUntracked?: boolean }]
      const { ssh, wsl } = getConfigForPath(repoPath)
      await createStash(repoPath, opts ?? {}, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return undefined
    }
    case 'git:stashApply': {
      const [repoPath, ref] = args as [string, string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      await applyStash(repoPath, ref, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return undefined
    }
    case 'git:stashPop': {
      const [repoPath, ref] = args as [string, string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      await popStash(repoPath, ref, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return undefined
    }
    case 'git:stashDrop': {
      const [repoPath, ref] = args as [string, string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      await dropStash(repoPath, ref, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return undefined
    }
    case 'git:forceUnlock': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return forceUnlockRepo(repoPath, ssh, wsl)
    }
    case 'git:fetchRemote': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return gitFetchRemoteCached(repoPath, ssh, wsl)
    }
    case 'git:diff': {
      const [repoPath, filePath, staged] = args as [string, string, boolean]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return getFileDiff(repoPath, filePath, staged, ssh, wsl)
    }
    case 'git:compareToMain': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return getCachedCompareToMainChanges(repoPath, ssh, wsl)
    }
    case 'git:compareDiffToMain': {
      const [repoPath, filePath] = args as [string, string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return getCompareToMainFileDiff(repoPath, filePath, ssh, wsl)
    }
    case 'git:compareToBranch': {
      const [repoPath, targetBranch] = args as [string, string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return getCompareToBranchChanges(repoPath, targetBranch, ssh, wsl)
    }
    case 'git:compareDiffToBranch': {
      const [repoPath, targetBranch] = args as [string, string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return getCompareToBranchDiff(repoPath, targetBranch, ssh, wsl)
    }
    case 'git:log': {
      const [repoPath, opts] = args as [string, { range?: string; limit?: number } | undefined]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return listCommits(repoPath, opts ?? {}, ssh, wsl)
    }
    case 'git:commitFiles': {
      const [repoPath, sha] = args as [string, string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return listCommitFiles(repoPath, sha, ssh, wsl)
    }
    case 'git:commitDiff': {
      const [repoPath, sha, filePath] = args as [string, string, string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return getCommitFileDiff(repoPath, sha, filePath, ssh, wsl)
    }
    case 'git:branches': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return listCachedBranches(repoPath, ssh, wsl)
    }
    case 'git:checkout': {
      const [repoPath, branch] = args as [string, string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      await checkoutBranch(repoPath, branch, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return undefined
    }
    case 'git:createBranch': {
      const [repoPath, name, base, pullFirst] = args as [string, string, string, boolean]
      const { ssh, wsl } = getConfigForPath(repoPath)
      await createBranch(repoPath, name, base, pullFirst, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return undefined
    }
    case 'git:merge': {
      const [repoPath, source] = args as [string, string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      const result = await mergeBranch(repoPath, source, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return result
    }
    case 'git:findMergedBranches': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return findMergedBranches(repoPath, ssh, wsl)
    }
    case 'git:deleteBranches': {
      const [repoPath, branches] = args as [string, string[]]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return deleteBranches(repoPath, branches, ssh, wsl)
    }
    case 'git:init': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      await gitInit(repoPath, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return undefined
    }
    case 'git:isRepo': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return isGitRepoCached(repoPath, ssh, wsl)
    }
    case 'git:getRemoteUrl': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return getRemoteUrl(repoPath, ssh, wsl)
    }
    case 'git:hostingProvider': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return detectGitHostingProviderCached(repoPath, ssh, wsl)
    }
    case 'git:defaultBranch': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return getCachedDefaultBranch(repoPath, ssh, wsl)
    }

    case 'azdo:pr:list': {
      const [repoPath] = args as [string]
      try {
        const { ssh, wsl } = getConfigForPath(repoPath)
        return await listOpenPullRequests(repoPath, ssh, wsl)
      } catch (error) {
        if (error instanceof Error && /No Azure DevOps remote found/i.test(error.message)) return []
        throw error
      }
    }
    case 'azdo:pr:current': {
      const [repoPath, branch] = args as [string, string]
      try {
        const { ssh, wsl } = getConfigForPath(repoPath)
        return await getCurrentBranchPullRequest(repoPath, branch, ssh, wsl)
      } catch (error) {
        if (error instanceof Error && /No Azure DevOps remote found/i.test(error.message)) return null
        throw error
      }
    }
    case 'azdo:pr:create': {
      const [repoPath, payload] = args as [string, { target: string; title: string; description?: string }]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return createPullRequest(repoPath, payload, ssh, wsl)
    }
    case 'azdo:pr:checkout': {
      const [repoPath, prId] = args as [string, number]
      const { ssh, wsl } = getConfigForPath(repoPath)
      const result = await checkoutPullRequestBranch(repoPath, prId, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return result
    }
    case 'azdo:pr:webUrl': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return getPullRequestsWebUrl(repoPath, ssh, wsl)
    }
    case 'azdo:repo:webUrl': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return getRepoWebUrl(repoPath, ssh, wsl)
    }
    case 'gh:pr:list': {
      const [repoPath] = args as [string]
      try {
        const { ssh, wsl } = getConfigForPath(repoPath)
        return await listOpenGitHubPullRequests(repoPath, ssh, wsl)
      } catch (error) {
        if (error instanceof Error && /No GitHub remote found/i.test(error.message)) return []
        throw error
      }
    }
    case 'gh:pr:current': {
      const [repoPath, branch] = args as [string, string]
      try {
        const { ssh, wsl } = getConfigForPath(repoPath)
        return await getCurrentBranchGitHubPullRequest(repoPath, branch, ssh, wsl)
      } catch (error) {
        if (error instanceof Error && /No GitHub remote found/i.test(error.message)) return null
        throw error
      }
    }
    case 'gh:pr:create': {
      const [repoPath, payload] = args as [string, { target: string; title: string; description?: string }]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return createGitHubPullRequest(repoPath, payload, ssh, wsl)
    }
    case 'gh:pr:checkout': {
      const [repoPath, prId] = args as [string, number]
      const { ssh, wsl } = getConfigForPath(repoPath)
      const result = await checkoutGitHubPullRequestBranch(repoPath, prId, ssh, wsl)
      invalidateRepoGitCache(repoPath)
      return result
    }
    case 'gh:pr:webUrl': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return getGitHubPullRequestsWebUrl(repoPath, ssh, wsl)
    }
    case 'gh:repo:webUrl': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return getGitHubRepoWebUrl(repoPath, ssh, wsl)
    }

    case 'files:list': {
      const [dirPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(dirPath)
      if (ssh) return sshListDirectory(ssh, dirPath)
      if (wsl) return wslListDirectory(wsl, dirPath)
      return listDirectory(dirPath)
    }
    case 'files:read': {
      const [filePath] = args as [string]
      const { ssh, wsl } = getConfigForPath(filePath)
      if (ssh) return sshReadFileContent(ssh, filePath)
      if (wsl) return wslReadFileContent(wsl, filePath)
      return readFileContent(filePath)
    }
    case 'files:searchList': {
      const [rootPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(rootPath)
      if (ssh) return sshListAllFiles(ssh, rootPath)
      if (wsl) return wslListAllFiles(wsl, rootPath)
      return listAllFiles(rootPath)
    }
    case 'files:watchStart': {
      const [filePath] = args as [string]
      const { ssh, wsl } = getConfigForPath(filePath)
      if (ssh || wsl) return false
      return startFileWatch(window, filePath)
    }
    case 'files:watchStop':
      stopFileWatch(args[0] as string)
      return undefined

    case 'commands:list':
      return listCommands(args[0] as string)
    case 'commands:create': {
      const [projectId, name, command, cwd, shell, runOnWorktreeCreate] = args as [string, string, string, string | null | undefined, string | null | undefined, boolean | undefined]
      return createCommand(projectId, name, command, cwd, shell, runOnWorktreeCreate ?? false)
    }
    case 'commands:update': {
      const [id, name, command, cwd, shell, runOnWorktreeCreate] = args as [string, string, string, string | null | undefined, string | null | undefined, boolean | undefined]
      return updateCommand(id, name, command, cwd, shell, runOnWorktreeCreate ?? false)
    }
    case 'commands:delete':
      commandManager.stopAllInstances(args[0] as string)
      return deleteCommand(args[0] as string)
    case 'commands:start': {
      const [commandId, locationId] = args as [string, string]
      await commandManager.start(commandId, locationId)
      return undefined
    }
    case 'commands:stop': {
      const [commandId, locationId] = args as [string, string]
      await commandManager.stop(commandId, locationId)
      return undefined
    }
    case 'commands:restart': {
      const [commandId, locationId] = args as [string, string]
      await commandManager.restart(commandId, locationId)
      return undefined
    }
    case 'commands:getStatus': {
      const [commandId, locationId] = args as [string, string]
      return commandManager.getStatus(commandId, locationId)
    }
    case 'commands:getLogs': {
      const [commandId, locationId] = args as [string, string]
      return commandManager.getLogs(commandId, locationId)
    }
    case 'commands:getPid': {
      const [commandId, locationId] = args as [string, string]
      return commandManager.getPid(commandId, locationId)
    }
    case 'commands:getPorts': {
      const [commandId, locationId] = args as [string, string]
      return commandManager.getPorts(commandId, locationId)
    }

    case 'terminal:spawn': {
      const [threadId, cols, rows] = args as [string, number, number]
      const location = getLocationForThread(threadId)
      if (!location) throw new Error('No location associated with this thread')
      const terminalId = `term-${threadId}-${Date.now()}`
      ptyManager.spawn(
        terminalId,
        threadId,
        getEffectiveWorkingDir(threadId) || location.path,
        location.connection_type,
        cols,
        rows,
        getSshConfigForThread(threadId),
        getWslConfigForThread(threadId),
      )
      return terminalId
    }
    case 'terminal:write': {
      const [terminalId, data] = args as [string, string]
      ptyManager.write(terminalId, data)
      return undefined
    }
    case 'terminal:resize': {
      const [terminalId, cols, rows] = args as [string, number, number]
      ptyManager.resize(terminalId, cols, rows)
      return undefined
    }
    case 'terminal:kill':
      ptyManager.kill(args[0] as string)
      return undefined
    case 'terminal:getBuffer':
      return ptyManager.getBuffer(args[0] as string)

    case 'attachments:save': {
      const [dataUrl, filename, threadId] = args as [string, string, string]
      return saveAttachment(dataUrl, filename, threadId)
    }
    case 'attachments:cleanup':
      cleanupThreadAttachments(args[0] as string)
      return undefined
    case 'attachments:readDataUrl': {
      // Serve a saved attachment back to remote clients (they cannot use the
      // Electron-only attachment:// protocol). Filename is sanitized against
      // path traversal; responses capped at 15 MB to match the RPC body limit.
      const [threadId, filename] = args as [string, string]
      const safeName = basename(filename)
      const filePath = join(getAttachmentDir(), basename(threadId), safeName)
      try {
        const info = getFileInfo(filePath)
        if (!info || info.size > 15 * 1024 * 1024) return null
        const data = readFileSync(filePath)
        return `data:${info.mimeType};base64,${data.toString('base64')}`
      } catch {
        return null
      }
    }
    case 'plans:getForThread':
      return sessionManager.get(args[0] as string)?.getAssociatedPlan() ?? null

    case 'process:kill': {
      const [target, type, threadId] = args as [string, 'pid' | 'port', string | undefined]
      try {
        const num = Number.parseInt(target, 10)
        if (Number.isNaN(num)) return { ok: false, error: 'Invalid number' }
        const wsl = threadId ? getWslConfigForThread(threadId) : null
        if (type === 'pid') {
          await killByPid(num, wsl)
        } else {
          await killByPort(num, wsl)
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    case 'cli:health': {
      const [provider, connectionType, ssh, wsl] = args as [Provider, string, SshConfig | null | undefined, WslConfig | null | undefined]
      return checkCliHealth(provider, connectionType, ssh, wsl)
    }
    case 'cli:update': {
      const [provider, connectionType, ssh, wsl] = args as [Provider, string, SshConfig | null | undefined, WslConfig | null | undefined]
      const result = await updateCli(provider, connectionType, ssh, wsl)
      invalidateCliHealthCache(provider, connectionType, ssh, wsl)
      return result
    }

    case 'models:claudeAvailable':
    case 'models:codexAvailable':
    case 'models:opencodeAvailable':
    case 'models:piAvailable':
    case 'models:cursorAvailable':
      return listAvailableModels(channel, args[0] as string | null | undefined)

    case 'slash-commands:list':
      return listSlashCommands(args[0] as string | null | undefined).map((command) => ({ ...command, kind: 'command' as const }))
    case 'skills:list':
      return listDetectedSkills(args[0] as Provider, (args[1] as string | null | undefined) ?? null).map((skill, index) => ({
        id: skill.id,
        project_id: skill.scope === 'project' ? 'project' : null,
        name: skill.name,
        description: skill.description,
        prompt: skill.invocation,
        sort_order: index,
        created_at: '',
        updated_at: '',
        kind: 'skill' as const,
        scope: skill.scope,
        harness: skill.harness,
        path: skill.path,
        invocation: skill.invocation,
      }))
    case 'slash-commands:create': {
      const [projectId, name, description, prompt] = args as [string | null, string, string | null, string]
      return createSlashCommand(projectId, name, description, prompt)
    }
    case 'slash-commands:update': {
      const [id, name, description, prompt] = args as [string, string, string | null, string]
      return updateSlashCommand(id, name, description, prompt)
    }
    case 'slash-commands:delete':
      return deleteSlashCommand(args[0] as string)

    default:
      throw new Error(`Unsupported remote control channel: ${channel}`)
  }
}
