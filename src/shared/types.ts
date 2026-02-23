export interface SshConfig {
  host: string
  user: string
  port?: number
  keyPath?: string
}

export interface WslConfig {
  distro: string
}

export type ConnectionType = 'local' | 'ssh' | 'wsl'

export interface RepoLocation {
  id: string
  project_id: string
  label: string
  connection_type: ConnectionType
  path: string
  ssh?: SshConfig | null
  wsl?: WslConfig | null
  created_at: string
  updated_at: string
}

export interface Project {
  id: string
  name: string
  git_url: string | null
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

export const OPENCODE_MODELS = [
  // OpenCode Zen (free)
  { id: 'opencode/big-pickle', label: 'Big Pickle (Free)' },
  { id: 'opencode/glm-5-free', label: 'GLM-5 (Free)' },
  { id: 'opencode/minimax-m2.5-free', label: 'MiniMax M2.5 (Free)' },
  { id: 'opencode/trinity-large-preview-free', label: 'Trinity Large Preview (Free)' },
  { id: 'opencode/kimi-k2.5-free', label: 'Kimi K2.5 (Free)' },
  // Anthropic
  { id: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5' },
  { id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { id: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  // OpenAI
  { id: 'openai/gpt-4o', label: 'GPT-4o' },
  // Google
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
] as const

export type OpenCodeModelId = typeof OPENCODE_MODELS[number]['id']

export type Provider = 'claude-code' | 'codex' | 'opencode'

export const PROVIDERS = [
  { id: 'claude-code' as Provider, label: 'Claude Code' },
  { id: 'codex' as Provider, label: 'Codex' },
  { id: 'opencode' as Provider, label: 'OpenCode' },
] as const

export function getModelsForProvider(provider: Provider) {
  if (provider === 'codex') return OPENAI_MODELS
  if (provider === 'opencode') return OPENCODE_MODELS
  return ANTHROPIC_MODELS
}

export function getDefaultModelForProvider(provider: Provider): string {
  if (provider === 'codex') return OPENAI_MODELS[0].id
  if (provider === 'opencode') return OPENCODE_MODELS[0].id
  return ANTHROPIC_MODELS[0].id
}

export interface Thread {
  id: string
  project_id: string
  location_id: string | null
  name: string
  provider: string
  model: string
  status: 'idle' | 'running' | 'error' | 'stopped'
  archived: boolean
  input_tokens: number
  output_tokens: number
  context_window: number
  /** True if at least one message has been sent in this thread */
  has_messages: boolean
  use_wsl: boolean
  wsl_distro: string | null
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
  'anthropic/claude-opus-4-5': 200_000,
  'anthropic/claude-sonnet-4-5': 200_000,
  'anthropic/claude-haiku-4-5': 200_000,
  'openai/gpt-4o': 128_000,
  'google/gemini-2.5-pro': 1_000_000,
  'opencode/big-pickle': 128_000,
  'opencode/glm-5-free': 128_000,
  'opencode/minimax-m2.5-free': 40_960,
  'opencode/trinity-large-preview-free': 128_000,
  'opencode/kimi-k2.5-free': 131_072,
}

export const DEFAULT_CONTEXT_LIMIT = 200_000

export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'blocked' | 'unknown'
  resetsAt?: number
  rateLimitType?: string
  utilization?: number
  surpassedThreshold?: number
  isUsingOverage?: boolean
  overageStatus?: string
  overageDisabledReason?: string
}

export type OutputEventType = 'text' | 'tool_call' | 'tool_result' | 'error' | 'status' | 'plan_ready' | 'question' | 'usage' | 'rate_limit'

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

export interface GitBranches {
  current: string
  local: string[]
  remote: string[]
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
  isDirectory?: boolean
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

// ── YouTrack ──────────────────────────────────────────────────────────────────

export interface YouTrackServer {
  id: string
  name: string
  url: string
  token: string
  created_at: string
  updated_at: string
}

export interface YouTrackIssue {
  id: string
  idReadable: string
  summary: string
}

// ── Project Commands ──────────────────────────────────────────────────────────

export type CommandStatus = 'idle' | 'running' | 'stopped' | 'error'

export interface ProjectCommand {
  id: string
  project_id: string
  name: string
  command: string
  cwd: string | null
  /** Shell to use for local execution: null = platform default, 'powershell' = PowerShell */
  shell: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export interface CommandLogLine {
  commandId: string
  text: string
  stream: 'stdout' | 'stderr'
  timestamp: string
}
