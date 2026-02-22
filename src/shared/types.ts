export interface SshConfig {
  host: string
  user: string
  port?: number
  keyPath?: string
}

export interface WslConfig {
  distro: string
}

export function isRemoteProject(project: Project): boolean {
  return !!project.ssh?.host
}

export function isWslProject(project: Project): boolean {
  return !!project.wsl?.distro
}

export interface Project {
  id: string
  name: string
  path: string
  ssh?: SshConfig | null
  wsl?: WslConfig | null
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

export const OPENAI_MODELS = [
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
  { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
  { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
  { id: 'codex-mini-latest', label: 'Codex Mini' },
] as const

export type OpenAIModelId = typeof OPENAI_MODELS[number]['id']

export type Provider = 'claude-code' | 'codex'

export const PROVIDERS = [
  { id: 'claude-code' as Provider, label: 'Claude Code' },
  { id: 'codex' as Provider, label: 'Codex' },
] as const

export function getModelsForProvider(provider: Provider) {
  return provider === 'codex' ? OPENAI_MODELS : ANTHROPIC_MODELS
}

export function getDefaultModelForProvider(provider: Provider): string {
  return provider === 'codex' ? OPENAI_MODELS[0].id : ANTHROPIC_MODELS[0].id
}

export interface Thread {
  id: string
  project_id: string
  name: string
  provider: string
  model: string
  status: 'idle' | 'running' | 'error' | 'stopped'
  archived: boolean
  input_tokens: number
  output_tokens: number
  context_window: number
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

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  context_window: number
}

export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-opus-4-5': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5': 200_000,
  'gpt-5.3-codex': 200_000,
  'gpt-5.3-codex-spark': 200_000,
  'gpt-5.2-codex': 200_000,
  'gpt-5.1-codex': 200_000,
  'codex-mini-latest': 200_000,
}

export const DEFAULT_CONTEXT_LIMIT = 200_000

export type OutputEventType = 'text' | 'tool_call' | 'tool_result' | 'error' | 'status' | 'plan_ready' | 'question' | 'usage'

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
