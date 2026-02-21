export interface Project {
  id: string
  name: string
  path: string
  created_at: string
  updated_at: string
}

export interface Thread {
  id: string
  project_id: string
  name: string
  provider: string
  status: 'idle' | 'running' | 'error' | 'stopped'
  created_at: string
  updated_at: string
}

export interface Message {
  id: string
  thread_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  metadata: string | null
  created_at: string
}

export type OutputEventType = 'text' | 'tool_call' | 'tool_result' | 'error' | 'status'

export interface OutputEvent {
  type: OutputEventType
  content: string
  metadata?: Record<string, unknown>
}

export type ThreadStatus = 'idle' | 'running' | 'error' | 'stopped'
