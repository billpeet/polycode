import { existsSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import { BrowserWindow } from 'electron'
import {
  archivedThreadCount,
  archiveThread,
  createLocation,
  createLocationPool,
  deleteLocation,
  deleteLocationPool,
  updateLocation,
  updateLocationPool,
  checkoutLocation,
  createSlashCommand,
  createThread,
  deleteSlashCommand,
  deleteThread,
  getActiveSession,
  getLastUsedProviderAndModel,
  getLocationForThread,
  getThreadModifiedFiles,
  getImportedSessionIds,
  importThread,
  listCommands,
  listArchivedThreads,
  listLocationPools,
  listLocations,
  listMessages,
  listMessagesBySession,
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
  updateThreadCodexPersonality,
  updateThreadCodexReasoningSummary,
  updateThreadCursorThinking,
  updateThreadCursorContext,
  updateThreadStatus,
  updateThreadUnread,
  updateThreadWsl,
  updateThreadYoloMode,
  createCommand,
  updateCommand,
  deleteCommand,
  listYouTrackServers,
  createYouTrackServer,
  updateYouTrackServer,
  deleteYouTrackServer,
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
import { createForge } from '../forge'
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
import { wslListAllFiles, wslListDirectory, wslReadFileContent } from '../wsl'
import { startFileWatch, startRepoGitWatch, stopFileWatch, stopRepoGitWatch } from '../file-watch'
import { cleanupThreadAttachments, getAttachmentDir, getFileInfo, saveAttachment } from '../attachments'
import { cloneLocation, createLocalWorktree, removeWorktreeLocation, suggestUniquePath } from '../project-admin'
import { listClaudeProjects, listClaudeSessions, parseSessionMessages } from '../claude-history'
import { listWslDistros, testSshConnection, testWslConnection } from '../host-connection-tests'
import { searchYouTrack, testYouTrackConnection } from '../youtrack'
import { publishRepositoryBranch } from '../publish-branch-adapter'
import { REMOTE_CHANNELS, isRemoteChannel } from '@polycode/shared'
import { invokeChannelHandler, isMigratedChannel } from '../ipc/channel-handlers'
import { killByPid, killByPort } from '../process-control'
import {
  assertMainBranchCommitAllowed,
  getConfigForPath,
  getEffectiveWorkingDir,
  getLocalPathError,
  getSshConfigForThread,
  getWorkingDirForThread,
  getWslConfigForThread,
  invalidateRepoGitCache,
} from '../ipc/thread-context'

export const CONTROL_RPC_CHANNELS: ReadonlySet<string> = new Set(REMOTE_CHANNELS)

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
  // Channels folded into the typed handler map. The `isRemoteChannel` guard derives
  // reachability from the registry rather than from which switch happens to have a
  // case, so a local-only channel stays unreachable from this transport even once it
  // is folded.
  if (isMigratedChannel(channel) && isRemoteChannel(channel)) {
    return invokeChannelHandler(channel, { window, origin: 'remote' }, args)
  }

  switch (channel) {

    case 'locations:create': {
      const [projectId, label, connectionType, locationPath, poolId, ssh, wsl] = args as [
        string, string, 'local' | 'ssh' | 'wsl', string, string | null | undefined, SshConfig | null | undefined, WslConfig | null | undefined,
      ]
      return createLocation(projectId, label, connectionType, locationPath, poolId ?? null, ssh ?? null, wsl ?? null)
    }
    case 'locations:update': {
      const [id, label, connectionType, locationPath, poolId, ssh, wsl] = args as [
        string, string, 'local' | 'ssh' | 'wsl', string, string | null | undefined, SshConfig | null | undefined, WslConfig | null | undefined,
      ]
      return updateLocation(id, label, connectionType, locationPath, poolId ?? null, ssh ?? null, wsl ?? null)
    }
    case 'locations:delete':
      return deleteLocation(args[0] as string)
    case 'locations:createWorktree': {
      const [parentLocationId, label] = args as [string, string | null | undefined]
      return createLocalWorktree(parentLocationId, label ?? null)
    }
    case 'locations:removeWorktree':
      return removeWorktreeLocation(args[0] as string)
    case 'locations:clone': {
      const [projectId, label, gitUrl, clonePath] = args as [string, string, string, string]
      return cloneLocation(projectId, label, gitUrl, clonePath)
    }
    case 'locations:suggestPath': {
      const [baseDir, repoName] = args as [string, string]
      return suggestUniquePath(baseDir, repoName)
    }

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
    case 'location-pools:create': {
      const [projectId, name] = args as [string, string]
      return createLocationPool(projectId, name)
    }
    case 'location-pools:update': {
      const [id, name] = args as [string, string]
      return updateLocationPool(id, name)
    }
    case 'location-pools:delete':
      return deleteLocationPool(args[0] as string)
    case 'ssh:test': {
      const [ssh, remotePath] = args as [SshConfig, string]
      return testSshConnection(ssh, remotePath)
    }
    case 'wsl:test': {
      const [wsl, wslPath] = args as [WslConfig, string]
      return testWslConnection(wsl, wslPath)
    }
    case 'wsl:list-distros':
      return listWslDistros()

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
    case 'threads:updateCodexPersonality': {
      const [id, personality] = args as [string, string]
      sessionManager.remove(id)
      return updateThreadCodexPersonality(id, personality)
    }
    case 'threads:updateCodexReasoningSummary': {
      const [id, summary] = args as [string, string]
      sessionManager.remove(id)
      return updateThreadCodexReasoningSummary(id, summary)
    }
    case 'threads:updateCursorThinking': {
      const [id, thinking] = args as [string, boolean | null]
      sessionManager.remove(id)
      return updateThreadCursorThinking(id, thinking)
    }
    case 'threads:updateCursorContext': {
      const [id, context] = args as [string, string | null]
      sessionManager.remove(id)
      return updateThreadCursorContext(id, context)
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
      const [threadId, cleanBackgroundTerminals] = args as [string, boolean | undefined]
      const session = sessionManager.get(threadId)
      if (session?.isRunning()) {
        session.stop(cleanBackgroundTerminals === true)
      } else {
        updateThreadStatus(threadId, 'idle')
        emitAppEvent(window, `thread:status:${threadId}`, 'idle')
        emitAppEvent(window, `thread:pid:${threadId}`, null)
      }
      return undefined
    }
    case 'threads:backgroundTerminals:list': {
      return await sessionManager.get(args[0] as string)?.listBackgroundTerminals() ?? []
    }
    case 'threads:backgroundTerminals:terminate': {
      const [threadId, processId] = args as [string, string]
      return await sessionManager.get(threadId)?.terminateBackgroundTerminal(processId) ?? false
    }
    case 'threads:backgroundTerminals:clean': {
      await sessionManager.get(args[0] as string)?.cleanBackgroundTerminals()
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
    case 'git:publishBranch': {
      const [input] = args as [import('../../shared/types').PublishBranchInput]
      const { ssh, wsl } = getConfigForPath(input.repoPath)
      try {
        return await publishRepositoryBranch(input, ssh, wsl)
      } finally {
        invalidateGitCache(input.repoPath, ssh, wsl)
      }
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
    case 'git:watchStart':
      return startRepoGitWatch(window, args[0] as string, invalidateRepoGitCache)
    case 'git:watchStop':
      stopRepoGitWatch(args[0] as string)
      return undefined
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

    case 'forge:pr:list': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return (await createForge(repoPath, ssh, wsl)).listPullRequests()
    }
    case 'forge:pr:current': {
      const [repoPath, branch] = args as [string, string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return (await createForge(repoPath, ssh, wsl)).getCurrentBranchPullRequest(branch)
    }
    case 'forge:pr:create': {
      const [repoPath, payload] = args as [string, { target: string; title: string; description?: string }]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return (await createForge(repoPath, ssh, wsl)).createPullRequest(payload)
    }
    case 'forge:pr:checkout': {
      const [repoPath, prId] = args as [string, number]
      const { ssh, wsl } = getConfigForPath(repoPath)
      const result = await (await createForge(repoPath, ssh, wsl)).checkoutPullRequest(prId)
      invalidateRepoGitCache(repoPath)
      return result
    }
    case 'forge:pr:webUrl': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return (await createForge(repoPath, ssh, wsl)).getPullRequestsWebUrl()
    }
    case 'forge:repo:webUrl': {
      const [repoPath] = args as [string]
      const { ssh, wsl } = getConfigForPath(repoPath)
      return (await createForge(repoPath, ssh, wsl)).getRepoWebUrl()
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

    case 'claude-history:listProjects':
      return listClaudeProjects()
    case 'claude-history:listSessions':
      return listClaudeSessions(args[0] as string)
    case 'claude-history:importedIds':
      return getImportedSessionIds(args[0] as string)
    case 'claude-history:import': {
      const [projectId, locationId, sessionFilePath, sessionId, name] = args as [string, string, string, string, string]
      const importedMessages = parseSessionMessages(sessionFilePath).map((message) => ({
        role: message.role,
        content: message.content,
        metadata: message.metadata,
        created_at: message.timestamp,
      }))
      return importThread(projectId, locationId, name, sessionId, importedMessages)
    }

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

    // The desktop settings and mention UIs need the stored token to edit a
    // server and issue authenticated searches, matching the existing local IPC.
    case 'youtrack:servers:list':
      return listYouTrackServers()
    case 'youtrack:servers:create': {
      const [name, url, token] = args as [string, string, string]
      return createYouTrackServer(name, url, token)
    }
    case 'youtrack:servers:update': {
      const [id, name, url, token] = args as [string, string, string, string]
      return updateYouTrackServer(id, name, url, token)
    }
    case 'youtrack:servers:delete':
      return deleteYouTrackServer(args[0] as string)
    case 'youtrack:test': {
      const [url, token] = args as [string, string]
      return testYouTrackConnection(url, token)
    }
    case 'youtrack:search': {
      const [url, token, query] = args as [string, string, string]
      return searchYouTrack(url, token, query)
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
