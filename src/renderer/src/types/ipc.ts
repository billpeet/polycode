import { Project, Thread, Message, OutputEvent, ThreadStatus } from '../../../shared/types'

export type { Project, Thread, Message, OutputEvent, ThreadStatus }

/** Shape of window.api exposed by preload */
export interface WindowApi {
  invoke(channel: 'projects:list'): Promise<Project[]>
  invoke(channel: 'projects:create', name: string, path: string): Promise<Project>
  invoke(channel: 'projects:delete', id: string): Promise<void>
  invoke(channel: 'threads:list', projectId: string): Promise<Thread[]>
  invoke(channel: 'threads:create', projectId: string, name: string): Promise<Thread>
  invoke(channel: 'threads:delete', id: string): Promise<void>
  invoke(channel: 'threads:start', threadId: string, workingDir: string): Promise<void>
  invoke(channel: 'threads:stop', threadId: string): Promise<void>
  invoke(channel: 'threads:send', threadId: string, content: string): Promise<void>
  invoke(channel: 'threads:updateName', id: string, name: string): Promise<void>
  invoke(channel: 'messages:list', threadId: string): Promise<Message[]>
  invoke(channel: 'dialog:open-directory'): Promise<string | null>
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
