import { readFileSync } from 'fs'
import { basename, join } from 'path'
import { BrowserWindow } from 'electron'
import {
  getActiveSession,
  getLocationForThread,
  listMessages,
  listMessagesBySession,
  listSessions,
  threadExists,
} from '../db/queries'
import { sessionManager } from '../session/manager'
import { ptyManager } from '../terminal/manager'
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
import { checkCliHealth, invalidateCliHealthCache, updateCli } from '../health/checker'
import { listDetectedSkills } from '../skills'
import { Provider, SshConfig, WslConfig } from '../../shared/types'
import { startRepoGitWatch, stopRepoGitWatch } from '../file-watch'
import { cleanupThreadAttachments, getAttachmentDir, getFileInfo, saveAttachment } from '../attachments'
import { listWslDistros, testSshConnection, testWslConnection } from '../host-connection-tests'
import { publishRepositoryBranch } from '../publish-branch-adapter'
import { REMOTE_CHANNELS, isRemoteChannel } from '@polycode/shared'
import { invokeChannelHandler, isMigratedChannel } from '../ipc/channel-handlers'
import { killByPid, killByPort } from '../process-control'
import {
  assertMainBranchCommitAllowed,
  getConfigForPath,
  getEffectiveWorkingDir,
  getSshConfigForThread,
  getWslConfigForThread,
  invalidateRepoGitCache,
} from '../ipc/thread-context'

export const CONTROL_RPC_CHANNELS: ReadonlySet<string> = new Set(REMOTE_CHANNELS)

export async function handleControlRpc(window: BrowserWindow, channel: string, args: unknown[]): Promise<unknown> {
  // Channels folded into the typed handler map. The `isRemoteChannel` guard derives
  // reachability from the registry rather than from which switch happens to have a
  // case, so a local-only channel stays unreachable from this transport even once it
  // is folded.
  if (isMigratedChannel(channel) && isRemoteChannel(channel)) {
    return invokeChannelHandler(channel, { window, origin: 'remote' }, args)
  }

  switch (channel) {

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
    default:
      throw new Error(`Unsupported remote control channel: ${channel}`)
  }
}
