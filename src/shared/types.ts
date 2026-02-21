export interface Project {
  id: string
  name: string
  path: string
  created_at: string
  updated_at: string
}

export const ANTHROPIC_MODELS = [
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-opus-4-5', label: 'Opus 4.5' },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
] as const

export type AnthropicModelId = typeof ANTHROPIC_MODELS[number]['id']

export interface Thread {
  id: string
  project_id: string
  name: string
  provider: string
  model: string
  status: 'idle' | 'running' | 'error' | 'stopped'
  archived: boolean
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

export type OutputEventType = 'text' | 'tool_call' | 'tool_result' | 'error' | 'status' | 'plan_ready' | 'question'

export interface OutputEvent {
  type: OutputEventType
  content: string
  metadata?: Record<string, unknown>
}

export type ThreadStatus = 'idle' | 'running' | 'error' | 'stopped' | 'plan_pending' | 'question_pending'

export interface GitFileChange {
  status: 'M' | 'A' | 'D' | 'R' | 'U' | '?'
  path: string
  oldPath?: string
  staged: boolean
}

export interface GitStatus {
  branch: string
  ahead: number
  behind: number
  additions: number
  deletions: number
  files: GitFileChange[]
}

/** Options passed when sending a message to a thread */
export interface SendOptions {
  planMode?: boolean
}

/** A question option from AskUserQuestion tool */
export interface QuestionOption {
  label: string
  description: string
}

/** A single question from AskUserQuestion tool */
export interface Question {
  question: string
  header: string
  multiSelect: boolean
  options: QuestionOption[]
}

/** The full AskUserQuestion payload */
export interface UserQuestion {
  questions: Question[]
}

// ── File system types ──────────────────────────────────────────────────────

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  children?: FileEntry[]
}

/** A file entry for fuzzy search */
export interface SearchableFile {
  path: string
  relativePath: string
  name: string
}

// ── Claude Code History types ──────────────────────────────────────────────────

/** A Claude Code session from ~/.claude/projects */
export interface ClaudeSession {
  sessionId: string
  slug: string | null
  filePath: string
  firstMessage: string
  messageCount: number
  lastActivity: string
}

/** A project folder in Claude Code history */
export interface ClaudeProject {
  encodedPath: string
  decodedPath: string
  sessions: ClaudeSession[]
}
