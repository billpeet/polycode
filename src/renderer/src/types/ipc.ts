import { Project, Thread, Message, OutputEvent, ThreadStatus, GitStatus, GitFileChange, ANTHROPIC_MODELS, AnthropicModelId } from '../../../shared/types'

export type { Project, Thread, Message, OutputEvent, ThreadStatus, GitStatus, GitFileChange, AnthropicModelId }
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
  invoke(channel: 'threads:send', threadId: string, content: string, workingDir: string): Promise<void>
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
