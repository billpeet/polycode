import { existsSync } from 'fs'
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
  getThreadModifiedFiles,
  getThreadWsl,
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
  updateThreadReasoningLevel,
  updateThreadStatus,
  updateThreadUnread,
  updateThreadWsl,
  updateThreadYoloMode,
} from '../db/queries'
import { sessionManager } from '../session/manager'
import { getThreadLogs } from '../thread-logger'
import { getCachedGitBranch } from '../git'
import { checkCliHealth } from '../health/checker'
import { listClaudeAvailableModels } from '../claude-models'
import { listCodexAvailableModels } from '../codex-models'
import { listOpenCodeAvailableModels } from '../opencode-models'
import { listPiAvailableModels } from '../pi-models'
import { listCursorAvailableModels } from '../cursor-models'
import { listDetectedSkills } from '../skills'
import { emitAppEvent } from '../app-events'
import { Provider, QuestionAnswerValue, SendOptions, SshConfig, WslConfig } from '../../shared/types'

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
  'cli:health',
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

    case 'cli:health': {
      const [provider, connectionType, ssh, wsl] = args as [Provider, string, SshConfig | null | undefined, WslConfig | null | undefined]
      return checkCliHealth(provider, connectionType, ssh, wsl)
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
