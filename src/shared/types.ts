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
  session_id: string | null
  role: 'user' | 'assistant' | 'system'
  content: string
  metadata: string | null
  created_at: string
}

export interface Session {
  id: string
  thread_id: string
  claude_session_id: string | null
  name: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export type OutputEventType = 'text' | 'tool_call' | 'tool_result' | 'error' | 'status' | 'plan_ready' | 'question'

export interface OutputEvent {
  type: OutputEventType
  content: string
  metadata?: Record<string, unknown>
  sessionId?: string
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

// ── Attachment types ──────────────────────────────────────────────────────

/** An attachment pending send (renderer state) */
export interface PendingAttachment {
  id: string
  name: string
  type: 'image' | 'pdf' | 'file'
  mimeType: string
  size: number
  dataUrl?: string // For image previews in renderer
  tempPath?: string // Set after IPC save
}

/** Supported attachment MIME types */
export const SUPPORTED_ATTACHMENT_TYPES: Record<string, { ext: string; type: 'image' | 'pdf' }> = {
  'image/jpeg': { ext: 'jpg', type: 'image' },
  'image/png': { ext: 'png', type: 'image' },
  'image/gif': { ext: 'gif', type: 'image' },
  'image/webp': { ext: 'webp', type: 'image' },
  'application/pdf': { ext: 'pdf', type: 'pdf' },
}

export const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024 // 5MB
export const MAX_ATTACHMENTS_PER_MESSAGE = 10
