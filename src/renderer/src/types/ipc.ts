import { Project, Thread, Message, OutputEvent, ThreadStatus, GitStatus, GitFileChange, ANTHROPIC_MODELS, AnthropicModelId, SendOptions, Question, FileEntry, SearchableFile, ClaudeProject, ClaudeSession, PendingAttachment, SUPPORTED_ATTACHMENT_TYPES, MAX_ATTACHMENT_SIZE, MAX_ATTACHMENTS_PER_MESSAGE, Session, SshConfig, WslConfig, isRemoteProject, isWslProject, TokenUsage, MODEL_CONTEXT_LIMITS, DEFAULT_CONTEXT_LIMIT, OPENAI_MODELS, OpenAIModelId, Provider, PROVIDERS, getModelsForProvider, getDefaultModelForProvider } from '../../../shared/types'

export type { Project, Thread, Message, OutputEvent, ThreadStatus, GitStatus, GitFileChange, AnthropicModelId, OpenAIModelId, Provider, SendOptions, Question, FileEntry, SearchableFile, ClaudeProject, ClaudeSession, PendingAttachment, Session, SshConfig, WslConfig, TokenUsage }
export { ANTHROPIC_MODELS, OPENAI_MODELS, PROVIDERS, getModelsForProvider, getDefaultModelForProvider, SUPPORTED_ATTACHMENT_TYPES, MAX_ATTACHMENT_SIZE, MAX_ATTACHMENTS_PER_MESSAGE, isRemoteProject, isWslProject, MODEL_CONTEXT_LIMITS, DEFAULT_CONTEXT_LIMIT }

/** Shape of window.api exposed by preload */
export interface WindowApi {
  invoke(channel: 'projects:list'): Promise<Project[]>
  invoke(channel: 'projects:create', name: string, path: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<Project>
  invoke(channel: 'projects:update', id: string, name: string, path: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<void>
  invoke(channel: 'projects:delete', id: string): Promise<void>
  invoke(channel: 'ssh:test', ssh: SshConfig, remotePath: string): Promise<{ ok: boolean; error?: string }>
  invoke(channel: 'wsl:test', wsl: WslConfig, wslPath: string): Promise<{ ok: boolean; error?: string }>
  invoke(channel: 'wsl:list-distros'): Promise<string[]>
  invoke(channel: 'threads:list', projectId: string): Promise<Thread[]>
  invoke(channel: 'threads:create', projectId: string, name: string): Promise<Thread>
  invoke(channel: 'threads:delete', id: string): Promise<void>
  invoke(channel: 'threads:start', threadId: string, workingDir: string): Promise<void>
  invoke(channel: 'threads:stop', threadId: string): Promise<void>
  invoke(channel: 'threads:send', threadId: string, content: string, workingDir: string, options?: SendOptions): Promise<void>
  invoke(channel: 'threads:approvePlan', threadId: string): Promise<void>
  invoke(channel: 'threads:rejectPlan', threadId: string): Promise<void>
  invoke(channel: 'threads:getQuestions', threadId: string): Promise<Question[]>
  invoke(channel: 'threads:answerQuestion', threadId: string, answers: Record<string, string>): Promise<void>
  invoke(channel: 'threads:updateName', id: string, name: string): Promise<void>
  invoke(channel: 'threads:archivedCount', projectId: string): Promise<number>
  invoke(channel: 'threads:listArchived', projectId: string): Promise<Thread[]>
  invoke(channel: 'threads:archive', id: string): Promise<'archived' | 'deleted'>
  invoke(channel: 'threads:unarchive', id: string): Promise<void>
  invoke(channel: 'threads:updateModel', id: string, model: string): Promise<void>
  invoke(channel: 'threads:updateProviderAndModel', id: string, provider: string, model: string): Promise<void>
  invoke(channel: 'messages:list', threadId: string): Promise<Message[]>
  invoke(channel: 'messages:listBySession', sessionId: string): Promise<Message[]>
  invoke(channel: 'sessions:list', threadId: string): Promise<Session[]>
  invoke(channel: 'sessions:getActive', threadId: string): Promise<Session | null>
  invoke(channel: 'sessions:switch', threadId: string, sessionId: string, workingDir: string): Promise<void>
  invoke(channel: 'threads:executePlanInNewContext', threadId: string, workingDir: string): Promise<void>
  invoke(channel: 'threads:getModifiedFiles', threadId: string, workingDir: string): Promise<string[]>
  invoke(channel: 'dialog:open-directory'): Promise<string | null>
  invoke(channel: 'git:status', repoPath: string): Promise<GitStatus | null>
  invoke(channel: 'git:commit', repoPath: string, message: string): Promise<void>
  invoke(channel: 'git:stage', repoPath: string, filePath: string): Promise<void>
  invoke(channel: 'git:unstage', repoPath: string, filePath: string): Promise<void>
  invoke(channel: 'git:stageAll', repoPath: string): Promise<void>
  invoke(channel: 'git:unstageAll', repoPath: string): Promise<void>
  invoke(channel: 'git:stageFiles', repoPath: string, filePaths: string[]): Promise<void>
  invoke(channel: 'git:generateCommitMessage', repoPath: string): Promise<string>
  invoke(channel: 'git:generateCommitMessageWithContext', repoPath: string, filePaths: string[], context: string): Promise<string>
  invoke(channel: 'git:push', repoPath: string): Promise<void>
  invoke(channel: 'git:pull', repoPath: string): Promise<void>
  invoke(channel: 'git:diff', repoPath: string, filePath: string, staged: boolean): Promise<string>
  invoke(channel: 'files:list', dirPath: string): Promise<FileEntry[]>
  invoke(channel: 'files:read', filePath: string): Promise<{ content: string; truncated: boolean } | null>
  invoke(channel: 'files:searchList', rootPath: string): Promise<SearchableFile[]>
  invoke(channel: 'claude-history:listProjects'): Promise<ClaudeProject[]>
  invoke(channel: 'claude-history:listSessions', encodedPath: string): Promise<ClaudeSession[]>
  invoke(channel: 'claude-history:importedIds', projectId: string): Promise<string[]>
  invoke(channel: 'claude-history:import', projectId: string, sessionFilePath: string, sessionId: string, name: string): Promise<Thread>
  invoke(channel: 'attachments:save', dataUrl: string, filename: string, threadId: string): Promise<{ tempPath: string; id: string }>
  invoke(channel: 'attachments:saveFromPath', sourcePath: string, threadId: string): Promise<{ tempPath: string; id: string }>
  invoke(channel: 'attachments:cleanup', threadId: string): Promise<void>
  invoke(channel: 'attachments:getFileInfo', filePath: string): Promise<{ size: number; mimeType: string } | null>
  invoke(channel: 'dialog:open-files'): Promise<string[]>
  // Fallback for dynamic channels
  invoke(channel: string, ...args: unknown[]): Promise<unknown>

  on(channel: string, callback: (...args: unknown[]) => void): () => void
  send(channel: string, ...args: unknown[]): void
}

declare global {
  interface Window {
    api: WindowApi
  }
}
