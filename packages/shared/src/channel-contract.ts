import type {
  BackgroundTerminal,
  Project,
  Thread,
  QueueThread,
  Message,
  GitStatus,
  GitFileChange,
  GitBranches,
  GitCompareResult,
  LastCommitInfo,
  StashEntry,
  PullResult,
  CommitLogEntry,
  PullRequest,
  PublishBranchInput,
  PublishBranchResult,
  SendOptions,
  Question,
  PermissionRequest,
  FileEntry,
  SearchableFile,
  ClaudeProject,
  ClaudeSession,
  Session,
  SshConfig,
  WslConfig,
  ConnectionType,
  RepoLocation,
  Provider,
  PermissionMode,
  ProjectCommand,
  CommandStatus,
  CommandLogLine,
  YouTrackServer,
  YouTrackIssue,
  SlashCommand,
  CliHealthResult,
  CliUpdateResult,
  ThreadLogEntry,
  LocationPool,
  ModelOption,
  ReasoningLevel,
  CodexPersonality,
  CodexReasoningSummary,
  QuestionAnswerValue,
  UpdateState,
  UpdateReleaseNotes,
  NewProjectSpec,
  NewProjectResult,
  RemoteServerConfig,
  RemoteHost,
  RemoteHostInput,
  RemoteConnectionStatus,
  RemotePairingInfo,
  BrowserPrepareSessionResult,
  Routine,
  RoutineDraft,
} from './types'
import type { Channel } from './channels'

export type ChannelContractEntry = readonly [args: readonly unknown[], result: unknown]

/**
 * Argument and result types for every request/response channel.
 *
 * Deliberately does NOT `extends Record<Channel, ChannelContractEntry>`: that
 * pre-types every key, so a channel omitted here would silently degrade to
 * `unknown[]` / `unknown` instead of failing the build. Exhaustiveness in both
 * directions is asserted below instead.
 */
export interface ChannelContract {
  'projects:list': [[], Project[]]
  'projects:listArchived': [[], Project[]]
  'projects:favicon': [[projectId: string], string | null]
  'projects:create': [[name: string, gitUrl?: string | null, allowMainBranchCommits?: boolean], Project]
  'projects:createFull': [[spec: NewProjectSpec], NewProjectResult]
  'projects:update': [[id: string, name: string, gitUrl?: string | null, allowMainBranchCommits?: boolean, faviconPath?: string | null], void]
  'projects:delete': [[id: string], void]
  'projects:archive': [[id: string], void]
  'projects:unarchive': [[id: string], void]
  'locations:list': [[projectId: string], RepoLocation[]]
  'locations:create': [[projectId: string, label: string, connectionType: ConnectionType, locationPath: string, poolId?: string | null, ssh?: SshConfig | null, wsl?: WslConfig | null], RepoLocation]
  'locations:update': [[id: string, label: string, connectionType: ConnectionType, locationPath: string, poolId?: string | null, ssh?: SshConfig | null, wsl?: WslConfig | null], void]
  'locations:delete': [[id: string], void]
  'locations:createWorktree': [[parentLocationId: string, label?: string | null], RepoLocation]
  'locations:removeWorktree': [[id: string], void]
  'locations:checkout': [[id: string], void]
  'locations:returnToPool': [[id: string], void]
  'location-pools:list': [[projectId: string], LocationPool[]]
  'location-pools:create': [[projectId: string, name: string], LocationPool]
  'location-pools:update': [[id: string, name: string], void]
  'location-pools:delete': [[id: string], void]
  'locations:pathExists': [[path: string], boolean]
  'locations:suggestPath': [[baseDir: string, repoName: string], string]
  'locations:clone': [[projectId: string, label: string, gitUrl: string, clonePath: string], RepoLocation]
  'ssh:test': [[ssh: SshConfig, remotePath: string], { ok: boolean; error?: string }]
  'wsl:test': [[wsl: WslConfig, wslPath: string], { ok: boolean; error?: string }]
  'wsl:list-distros': [[], string[]]
  'threads:list': [[projectId: string], Thread[]]
  'threads:listQueue': [[], QueueThread[]]
  'threads:listQueueArchived': [[search: string | null, limit: number, offset: number], QueueThread[]]
  'threads:listQueueSnoozed': [[search: string | null, limit: number, offset: number], QueueThread[]]
  'threads:create': [[projectId: string, name: string, locationId: string], Thread]
  'threads:delete': [[id: string], void]
  'threads:start': [[threadId: string], void]
  'threads:stop': [[threadId: string, cleanBackgroundTerminals?: boolean], void]
  'threads:backgroundTerminals:list': [[threadId: string], BackgroundTerminal[]]
  'threads:backgroundTerminals:terminate': [[threadId: string, processId: string], boolean]
  'threads:backgroundTerminals:clean': [[threadId: string], void]
  'threads:reset': [[threadId: string], void]
  'threads:getPid': [[threadId: string], number | null]
  'threads:send': [[threadId: string, content: string, options?: SendOptions], void]
  'threads:approvePlan': [[threadId: string], void]
  'threads:rejectPlan': [[threadId: string], void]
  'threads:getQuestions': [[threadId: string], Question[]]
  'threads:answerQuestion': [[threadId: string, answers: Record<string, QuestionAnswerValue>, questionComments: Record<string, string>, generalComment: string], void]
  'threads:getPendingPermissions': [[threadId: string], PermissionRequest[]]
  'threads:approvePermissions': [[threadId: string, requestId?: string], void]
  'threads:denyPermissions': [[threadId: string, requestId?: string], void]
  'threads:updateName': [[id: string, name: string], void]
  'threads:archivedCount': [[projectId: string], number]
  'threads:listArchived': [[projectId: string, limit?: number, offset?: number], Thread[]]
  'threads:archive': [[id: string], 'archived' | 'deleted']
  'threads:unarchive': [[id: string], void]
  'threads:snoozedCount': [[projectId: string], number]
  'threads:listSnoozed': [[projectId: string, limit?: number, offset?: number], Thread[]]
  /** `until` is an absolute ISO instant, resolved by the client in its own timezone. */
  'threads:snooze': [[id: string, until: string], void]
  'threads:unsnooze': [[id: string], void]
  'threads:updateModel': [[id: string, model: string], void]
  'threads:updateProviderAndModel': [[id: string, provider: string, model: string], void]
  'threads:updateReasoningLevel': [[id: string, reasoningLevel: ReasoningLevel], void]
  'threads:updateCodexPersonality': [[id: string, personality: CodexPersonality], void]
  'threads:updateCodexReasoningSummary': [[id: string, summary: CodexReasoningSummary], void]
  'threads:updateCursorThinking': [[id: string, thinking: boolean | null], void]
  'threads:updateCursorContext': [[id: string, context: string | null], void]
  'threads:setUnread': [[threadId: string, unread: boolean], void]
  'threads:setYolo': [[threadId: string, yoloMode: boolean], void]
  'threads:setPermissionMode': [[threadId: string, permissionMode: PermissionMode], void]
  'threads:setWsl': [[threadId: string, useWsl: boolean, wslDistro: string | null], void]
  'messages:list': [[threadId: string], Message[]]
  'messages:listBySession': [[sessionId: string], Message[]]
  'sessions:list': [[threadId: string], Session[]]
  'sessions:getActive': [[threadId: string], Session | null]
  'sessions:switch': [[threadId: string, sessionId: string], void]
  'threads:executePlanInNewContext': [[threadId: string], void]
  'threads:getModifiedFiles': [[threadId: string], string[]]
  'threads:getLogs': [[threadId: string], ThreadLogEntry[]]
  'dialog:open-directory': [[], string | null]
  'dialog:open-favicon': [[], string | null]
  'git:branch': [[repoPath: string], string | null]
  'git:status': [[repoPath: string], GitStatus | null]
  'git:head': [[repoPath: string], string | null]
  'git:commit': [[repoPath: string, message: string], void]
  'git:lastCommit': [[repoPath: string], LastCommitInfo | null]
  'git:amendCommit': [[repoPath: string, message?: string | null], void]
  'git:undoLastCommit': [[repoPath: string], void]
  'git:stage': [[repoPath: string, filePath: string], void]
  'git:unstage': [[repoPath: string, filePath: string], void]
  'git:stageAll': [[repoPath: string], void]
  'git:unstageAll': [[repoPath: string], void]
  'git:stageFiles': [[repoPath: string, filePaths: string[]], void]
  'git:discardFile': [[repoPath: string, filePath: string, oldPath?: string | null], void]
  'git:discardFiles': [[repoPath: string, files: Array<{ path: string; oldPath?: string | null }>], void]
  'git:discardAll': [[repoPath: string], void]
  'git:generateCommitMessage': [[repoPath: string], string]
  'git:generateCommitMessageWithContext': [[repoPath: string, filePaths: string[], context: string], string]
  'git:generatePullRequestText': [[repoPath: string, targetBranch: string], { title: string; description: string }]
  'git:generateBranchName': [[repoPath: string], string]
  'git:push': [[repoPath: string], void]
  'git:publishBranch': [[input: PublishBranchInput], PublishBranchResult]
  'git:pushSetUpstream': [[repoPath: string, branch: string], void]
  'git:pull': [[repoPath: string, autoStash?: boolean], PullResult | void]
  'git:pullOrigin': [[repoPath: string], void]
  'git:stashList': [[repoPath: string], StashEntry[]]
  'git:stashCreate': [[repoPath: string, opts: { message?: string; includeUntracked?: boolean }], void]
  'git:stashApply': [[repoPath: string, ref: string], void]
  'git:stashPop': [[repoPath: string, ref: string], void]
  'git:stashDrop': [[repoPath: string, ref: string], void]
  'git:forceUnlock': [[repoPath: string], { removed: string[] }]
  'git:fetchRemote': [[repoPath: string], void]
  'git:diff': [[repoPath: string, filePath: string, staged: boolean], string]
  'git:compareToMain': [[repoPath: string], GitCompareResult]
  'git:compareDiffToMain': [[repoPath: string, filePath: string], string]
  'git:compareToBranch': [[repoPath: string, targetBranch: string], GitCompareResult]
  'git:compareDiffToBranch': [[repoPath: string, targetBranch: string], string]
  'git:log': [[repoPath: string, opts?: { range?: string; limit?: number }], CommitLogEntry[]]
  'git:commitFiles': [[repoPath: string, sha: string], GitFileChange[]]
  'git:commitDiff': [[repoPath: string, sha: string, filePath: string], string]
  'git:branches': [[repoPath: string], GitBranches]
  'git:watchStart': [[repoPath: string], boolean]
  'git:watchStop': [[repoPath: string], void]
  'git:checkout': [[repoPath: string, branch: string], void]
  'git:createBranch': [[repoPath: string, name: string, base: string, pullFirst: boolean], void]
  'git:merge': [[repoPath: string, source: string], { conflicts: string[] }]
  'git:findMergedBranches': [[repoPath: string], string[]]
  'git:deleteBranches': [[repoPath: string, branches: string[]], { deleted: string[]; failed: Array<{ branch: string; error: string }> }]
  'git:init': [[repoPath: string], void]
  'git:isRepo': [[repoPath: string], boolean]
  'git:getRemoteUrl': [[repoPath: string], string | null]
  'git:hostingProvider': [[repoPath: string], 'azure' | 'github' | null]
  'git:defaultBranch': [[repoPath: string], string]
  'forge:pr:list': [[repoPath: string], PullRequest[]]
  'forge:pr:current': [[repoPath: string, branch: string], PullRequest | null]
  'forge:pr:create': [[repoPath: string, payload: { target: string; title: string; description?: string }], PullRequest]
  'forge:pr:enrich': [[repoPath: string, pullRequests: PullRequest[]], PullRequest[]]
  'forge:pr:checkout': [[repoPath: string, prId: number], { branch: string }]
  'forge:pr:webUrl': [[repoPath: string], string]
  'forge:repo:webUrl': [[repoPath: string], string]
  'files:list': [[dirPath: string], FileEntry[]]
  'files:read': [[filePath: string], { content: string; truncated: boolean; mimeType?: string; dataUrl?: string } | null]
  'files:searchList': [[rootPath: string], SearchableFile[]]
  'files:watchStart': [[filePath: string], boolean]
  'files:watchStop': [[filePath: string], void]
  'claude-history:listProjects': [[], ClaudeProject[]]
  'claude-history:listSessions': [[encodedPath: string], ClaudeSession[]]
  'claude-history:importedIds': [[projectId: string], string[]]
  'claude-history:import': [[projectId: string, locationId: string, sessionFilePath: string, sessionId: string, name: string], Thread]
  'browser:prepareSession': [[locationId: string], BrowserPrepareSessionResult]
  'browser:releaseSession': [[locationId: string], void]
  'attachments:save': [[dataUrl: string, filename: string, threadId: string], { tempPath: string; id: string }]
  'attachments:saveFromPath': [[sourcePath: string, threadId: string], { tempPath: string; id: string }]
  'attachments:cleanup': [[threadId: string], void]
  'attachments:getFileInfo': [[filePath: string], { size: number; mimeType: string } | null]
  'dialog:open-files': [[], string[]]
  'shell:copyPath': [[dirPath: string], void]
  'shell:openExternal': [[url: string], void]
  'shell:openInExplorer': [[dirPath: string], void]
  'shell:openInVsCode': [[dirPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null], void]
  'shell:revealInExplorer': [[filePath: string], void]
  'shell:openInTerminal': [[dirPath: string, wsl?: WslConfig | null], void]
  'process:kill': [[target: string, type: 'pid' | 'port', threadId?: string], { ok: boolean; error?: string }]
  'window:minimize': [[], void]
  'window:maximize': [[], void]
  'window:close': [[], void]
  'window:is-maximized': [[], boolean]
  'app:getVersion': [[], string]
  'app:open-logs-folder': [[], string]
  'update:check': [[], UpdateState]
  'update:apply': [[], { success: boolean }]
  'update:get-state': [[], UpdateState]
  'update:release-notes': [[], UpdateReleaseNotes | null]
  'commands:list': [[projectId: string], ProjectCommand[]]
  'commands:create': [[projectId: string, name: string, command: string, cwd?: string | null, shell?: string | null, runOnWorktreeCreate?: boolean], ProjectCommand]
  'commands:update': [[id: string, name: string, command: string, cwd?: string | null, shell?: string | null, runOnWorktreeCreate?: boolean], void]
  'commands:delete': [[id: string], void]
  'commands:start': [[commandId: string, locationId: string], void]
  'commands:stop': [[commandId: string, locationId: string], void]
  'commands:restart': [[commandId: string, locationId: string], void]
  'commands:getStatus': [[commandId: string, locationId: string], CommandStatus]
  'commands:getLogs': [[commandId: string, locationId: string], CommandLogLine[]]
  'commands:getPid': [[commandId: string, locationId: string], number | null]
  'commands:getPorts': [[commandId: string, locationId: string], number[]]
  'youtrack:servers:list': [[], YouTrackServer[]]
  'youtrack:servers:create': [[name: string, url: string, token: string], YouTrackServer]
  'youtrack:servers:update': [[id: string, name: string, url: string, token: string], void]
  'youtrack:servers:delete': [[id: string], void]
  'youtrack:search': [[url: string, token: string, query: string], YouTrackIssue[]]
  'youtrack:test': [[url: string, token: string], { ok: boolean; error?: string }]
  'routines:list': [[projectId: string], Routine[]]
  'routines:create': [[projectId: string, draft: RoutineDraft], Routine]
  'routines:update': [[id: string, patch: Partial<RoutineDraft>], Routine | null]
  'routines:delete': [[id: string], void]
  'routines:setEnabled': [[id: string, enabled: boolean], void]
  'routines:runNow': [[id: string], string]
  'routines:listRuns': [[routineId: string, limit?: number], Thread[]]
  'routines:dismissRun': [[threadId: string], void]
  'routines:runHasUnshippedWork': [[threadId: string], boolean]
  'slash-commands:list': [[projectId?: string | null], SlashCommand[]]
  'skills:list': [[provider: Provider, cwd?: string | null], SlashCommand[]]
  'slash-commands:create': [[projectId: string | null, name: string, description: string | null, prompt: string], SlashCommand]
  'slash-commands:update': [[id: string, name: string, description: string | null, prompt: string], void]
  'slash-commands:delete': [[id: string], void]
  'cli:health': [[provider: Provider, connectionType: string, ssh?: SshConfig | null, wsl?: WslConfig | null], CliHealthResult]
  'cli:update': [[provider: Provider, connectionType: string, ssh?: SshConfig | null, wsl?: WslConfig | null], CliUpdateResult]
  'models:claudeAvailable': [[threadId?: string | null], ModelOption[]]
  'models:codexAvailable': [[threadId?: string | null], ModelOption[]]
  'models:opencodeAvailable': [[threadId?: string | null], ModelOption[]]
  'models:piAvailable': [[threadId?: string | null, forceRefresh?: boolean], ModelOption[]]
  'models:cursorAvailable': [[threadId?: string | null], ModelOption[]]
  'models:grokAvailable': [[threadId?: string | null], ModelOption[]]
  'terminal:spawn': [[threadId: string, cols: number, rows: number], string]
  'terminal:kill': [[terminalId: string], void]
  'terminal:getBuffer': [[terminalId: string], string]
  'settings:get': [[key: string], string | null]
  'settings:set': [[key: string, value: string], void]
  'webhook:getConfig': [[], { enabled: boolean; port: number; token: string }]
  'webhook:setConfig': [[config: { enabled: boolean; port: number; token: string }], void]
  'remote:getServerConfig': [[], RemoteServerConfig]
  'remote:setServerConfig': [[config: RemoteServerConfig], RemoteServerConfig]
  'remote:regenerateServerToken': [[], RemoteServerConfig]
  'remote:getHosts': [[], RemoteHost[]]
  'remote:addHost': [[input: RemoteHostInput], RemoteHost]
  'remote:updateHost': [[id: string, input: RemoteHostInput], RemoteHost]
  'remote:removeHost': [[id: string], void]
  'remote:setActiveHost': [[id: string | null], RemoteHost | null]
  'remote:getActiveHost': [[], RemoteHost | null]
  'remote:testHost': [[input: RemoteHostInput], RemoteConnectionStatus]
  'remote:getPairingInfo': [[], RemotePairingInfo]
  'terminal:write': [[terminalId: string, data: string], void]
  'terminal:resize': [[terminalId: string, cols: number, rows: number], void]
  'attachments:readDataUrl': [[threadId: string, filename: string], string | null]
  'plans:getForThread': [
    [threadId: string],
    { name: string; path: string | null; content: string | null } | null,
  ]
}

type Assert<T extends true> = T

/** Fails the build if a channel in CHANNEL_REGISTRY has no contract entry. */
export type _AssertNoChannelMissingFromContract = Assert<
  [Exclude<Channel, keyof ChannelContract>] extends [never] ? true : false
>
/** Fails the build if the contract declares a channel not in CHANNEL_REGISTRY. */
export type _AssertNoContractEntryWithoutChannel = Assert<
  [Exclude<keyof ChannelContract, Channel>] extends [never] ? true : false
>
/** Fails the build if any entry is not an [args, result] pair. */
export type _AssertEntryShapes = Assert<
  ChannelContract extends Record<Channel, ChannelContractEntry> ? true : false
>

export type ChannelArgs<C extends keyof ChannelContract> = ChannelContract[C][0]
export type ChannelResult<C extends keyof ChannelContract> = ChannelContract[C][1]
