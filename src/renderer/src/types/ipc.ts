import { Project, Thread, Message, OutputEvent, ThreadStatus, GitStatus, GitFileChange, ANTHROPIC_MODELS, AnthropicModelId, SendOptions, Question, FileEntry, SearchableFile, ClaudeProject, ClaudeSession } from '../../../shared/types'

export type { Project, Thread, Message, OutputEvent, ThreadStatus, GitStatus, GitFileChange, AnthropicModelId, SendOptions, Question, FileEntry, SearchableFile, ClaudeProject, ClaudeSession }
export { ANTHROPIC_MODELS }

/** Shape of window.api exposed by preload */
export interface WindowApi {
  invoke(channel: 'projects:list'): Promise<Project[]>
  invoke(channel: 'projects:create', name: string, path: string): Promise<Project>
  invoke(channel: 'projects:update', id: string, name: string, path: string): Promise<void>
  invoke(channel: 'projects:delete', id: string): Promise<void>
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
  invoke(channel: 'messages:list', threadId: string): Promise<Message[]>
  invoke(channel: 'dialog:open-directory'): Promise<string | null>
  invoke(channel: 'git:status', repoPath: string): Promise<GitStatus | null>
  invoke(channel: 'git:commit', repoPath: string, message: string): Promise<void>
  invoke(channel: 'git:stage', repoPath: string, filePath: string): Promise<void>
  invoke(channel: 'git:unstage', repoPath: string, filePath: string): Promise<void>
  invoke(channel: 'git:stageAll', repoPath: string): Promise<void>
  invoke(channel: 'git:unstageAll', repoPath: string): Promise<void>
  invoke(channel: 'git:generateCommitMessage', repoPath: string): Promise<string>
  invoke(channel: 'files:list', dirPath: string): Promise<FileEntry[]>
  invoke(channel: 'files:read', filePath: string): Promise<{ content: string; truncated: boolean } | null>
  invoke(channel: 'files:searchList', rootPath: string): Promise<SearchableFile[]>
  invoke(channel: 'claude-history:listProjects'): Promise<ClaudeProject[]>
  invoke(channel: 'claude-history:listSessions', encodedPath: string): Promise<ClaudeSession[]>
  invoke(channel: 'claude-history:importedIds', projectId: string): Promise<string[]>
  invoke(channel: 'claude-history:import', projectId: string, sessionFilePath: string, sessionId: string, name: string): Promise<Thread>
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
