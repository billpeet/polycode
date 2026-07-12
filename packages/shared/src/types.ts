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
  pool_id: string | null
  checked_out: boolean
  parent_location_id: string | null
  is_worktree: boolean
  worktree_id: number | null
  label: string
  connection_type: ConnectionType
  path: string
  ssh?: SshConfig | null
  wsl?: WslConfig | null
  created_at: string
  updated_at: string
}

export interface LocationPool {
  id: string
  project_id: string
  name: string
  created_at: string
  updated_at: string
}

export interface Project {
  id: string
  name: string
  git_url: string | null
  allow_main_branch_commits: boolean
  archived_at: string | null
  created_at: string
  updated_at: string
}

/**
 * Describes how a brand-new project's first local location is provisioned.
 *  - `new`      → create a fresh directory at `path` and `git init` it
 *  - `existing` → adopt an existing local directory (its `origin` remote, if any, becomes the project git URL)
 *  - `clone`    → `git clone` `gitUrl` into a fresh directory under `parentDir`
 */
export type NewProjectSource =
  | { kind: 'new'; path: string }
  | { kind: 'existing'; path: string }
  | { kind: 'clone'; gitUrl: string; parentDir: string }

export interface NewProjectSpec {
  name: string
  allowMainBranchCommits: boolean
  /** Label for the created location. Defaults to "Local" when omitted. */
  label?: string | null
  source: NewProjectSource
}

export interface NewProjectResult {
  project: Project
  location: RepoLocation
}

export interface RemoteServerConfig {
  enabled: boolean
  host: string
  port: number
  token: string
}

export interface RemoteHost {
  id: string
  label: string
  baseUrl: string
  token: string
  createdAt: string
  updatedAt: string
}

export type RemoteHostInput = Pick<RemoteHost, 'label' | 'baseUrl' | 'token'>

export interface RemoteConnectionStatus {
  ok: boolean
  error?: string
}

/** LAN info used to render the mobile pairing QR code on the desktop. */
export interface RemotePairingInfo {
  addresses: string[]
  hostname: string
}

export const ANTHROPIC_MODELS = [
  { id: 'claude-fable-5[1m]', label: 'Fable 5', contextWindow: 1_000_000 },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', reasoning: true, reasoningLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', reasoning: true, reasoningLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', reasoning: true, reasoningLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'], contextWindows: [{ value: '200k', label: '200k' }, { value: '1m', label: '1M' }] },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', reasoning: true, reasoningLevels: ['off', 'low', 'medium', 'high', 'xhigh'], contextWindows: [{ value: '200k', label: '200k' }, { value: '1m', label: '1M' }] },
  { id: 'claude-opus-4-5', label: 'Opus 4.5', reasoning: true, reasoningLevels: ['off', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', reasoning: true, reasoningLevels: ['off', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', reasoning: true, reasoningLevels: ['off', 'low', 'medium', 'high'] },
] as const satisfies readonly ModelOption[]

export type AnthropicModelId = typeof ANTHROPIC_MODELS[number]['id']

export const OPENAI_MODELS = [
  { id: 'gpt-5.5', label: 'GPT-5.5', reasoning: true, reasoningLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.4', label: 'GPT-5.4', reasoning: true, reasoningLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', reasoning: true, reasoningLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', reasoning: true, reasoningLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', reasoning: true, reasoningLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', reasoning: true, reasoningLevels: ['off', 'minimal', 'low', 'medium', 'high'] },
  { id: 'codex-mini-latest', label: 'Codex Mini', reasoning: true, reasoningLevels: ['off', 'minimal', 'low', 'medium', 'high'] },
] as const satisfies readonly ModelOption[]

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

export const PI_MODELS = [
  { id: 'openai-codex/gpt-5.5', label: 'GPT-5.5', reasoning: true, reasoningLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'openai-codex/gpt-5.4', label: 'GPT-5.4', reasoning: true, reasoningLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'openai-codex/gpt-5.4-mini', label: 'GPT-5.4 Mini', reasoning: true, reasoningLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'anthropic/claude-opus-4-7', label: 'Claude Opus 4.7', reasoning: true, reasoningLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', reasoning: true, reasoningLevels: ['off', 'minimal', 'low', 'medium', 'high'] },
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', reasoning: true, reasoningLevels: ['off', 'minimal', 'low', 'medium', 'high'] },
] as const satisfies readonly ModelOption[]

export type PiModelId = typeof PI_MODELS[number]['id']

export type ReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type CodexImageDetail = 'auto' | 'low' | 'high' | 'original'
export type CodexPersonality = 'none' | 'friendly' | 'pragmatic'
export type CodexReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none'
export type CodexJsonValue = null | boolean | number | string | CodexJsonValue[] | { [key: string]: CodexJsonValue }

export interface ModelOption {
  id: string
  label: string
  contextWindow?: number
  reasoning?: boolean
  reasoningLevels?: ReasoningLevel[]
  /** Cursor: model exposes a priority "fast" processing tier. */
  fast?: boolean
  /** Cursor: model exposes a separate thinking on/off toggle. */
  thinking?: boolean
  /** Cursor: selectable context-window sizes (e.g. 200k / 1m). */
  contextWindows?: { value: string; label: string }[]
}

export const CURSOR_MODELS = [
  { id: 'default', label: 'Default' },
  { id: 'auto', label: 'Auto' },
] as const satisfies readonly ModelOption[]

export type CursorModelId = typeof CURSOR_MODELS[number]['id']

export type Provider = 'claude-code' | 'codex' | 'opencode' | 'pi' | 'cursor'
export type PermissionMode = 'ask' | 'workspace' | 'yolo'

export const PROVIDERS = [
  { id: 'claude-code' as Provider, label: 'Claude Code' },
  { id: 'codex' as Provider, label: 'Codex' },
  { id: 'opencode' as Provider, label: 'OpenCode' },
  { id: 'pi' as Provider, label: 'Pi' },
  { id: 'cursor' as Provider, label: 'Cursor' },
] as const

export function getModelsForProvider(provider: Provider) {
  if (provider === 'codex') return OPENAI_MODELS
  if (provider === 'opencode') return OPENCODE_MODELS
  if (provider === 'pi') return PI_MODELS
  if (provider === 'cursor') return CURSOR_MODELS
  return ANTHROPIC_MODELS
}

export function getDefaultModelForProvider(provider: Provider): string {
  if (provider === 'codex') return OPENAI_MODELS[0].id
  if (provider === 'opencode') return OPENCODE_MODELS[0].id
  if (provider === 'pi') return PI_MODELS[0].id
  if (provider === 'cursor') return CURSOR_MODELS[0].id
  return ANTHROPIC_MODELS[0].id
}

export interface Thread {
  id: string
  project_id: string
  location_id: string | null
  name: string
  /** Renderer-only flag for a temporary thread placeholder during optimistic creation. */
  is_pending?: boolean
  provider: string
  model: string
  reasoning_level: ReasoningLevel
  codex_personality: CodexPersonality
  codex_reasoning_summary: CodexReasoningSummary
  /** Cursor: thinking toggle override; null = use provider default. */
  cursor_thinking: boolean | null
  /** Cursor: selected context-window value; null = use provider default. */
  cursor_context: string | null
  status: ThreadStatus
  archived: boolean
  input_tokens: number
  output_tokens: number
  context_window: number
  unread: boolean
  /** True if at least one message has been sent in this thread */
  has_messages: boolean
  permission_mode: PermissionMode
  /** Compatibility flag derived from permission_mode === 'yolo'. */
  yolo_mode: boolean
  use_wsl: boolean
  wsl_distro: string | null
  /** Branch that was active when this thread was created */
  git_branch: string | null
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
  'claude-fable-5[1m]': 1_000_000,
  // Opus 4.8 / 4.7 run at the 1M context window by default in Claude Code
  // (no `[1m]` suffix needed), matching t3code's selectedClaudeContextWindow.
  // The other 1M-capable models default to 200k and only reach 1M via the
  // opt-in `<model>[1m]` slug, so they stay at 200k here.
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 200_000,
  'claude-opus-4-6[1m]': 1_000_000,
  'claude-sonnet-4-6': 200_000,
  'claude-sonnet-4-6[1m]': 1_000_000,
  'claude-opus-4-5': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5': 200_000,
  'gpt-5.5': 200_000,
  'gpt-5.4': 200_000,
  'gpt-5.3-codex': 200_000,
  'gpt-5.3-codex-spark': 200_000,
  'gpt-5.2-codex': 200_000,
  'gpt-5.1-codex': 200_000,
  'codex-mini-latest': 200_000,
  'anthropic/claude-opus-4-5': 200_000,
  'anthropic/claude-sonnet-4-5': 200_000,
  'anthropic/claude-haiku-4-5': 200_000,
  'openai/gpt-4o': 128_000,
  'openai-codex/gpt-5.5': 200_000,
  'openai-codex/gpt-5.4': 200_000,
  'openai-codex/gpt-5.4-mini': 200_000,
  'anthropic/claude-opus-4-7': 200_000,
  'anthropic/claude-sonnet-4-6': 200_000,
  'google/gemini-2.5-pro': 1_000_000,
  'opencode/big-pickle': 128_000,
  'opencode/glm-5-free': 128_000,
  'opencode/minimax-m2.5-free': 40_960,
  'opencode/trinity-large-preview-free': 128_000,
  'opencode/kimi-k2.5-free': 131_072,
  'default': 200_000,
  'auto': 200_000,
}

export const DEFAULT_CONTEXT_LIMIT = 200_000

// Claude Code enables its 1M context window via a `<model>[1m]` model slug
// (e.g. `claude-opus-4-6[1m]`). When a claude-code thread opted into the 1M
// context window, append that suffix so the CLI runs at 1M and the context
// usage bar reads the 1M limit. Other providers apply context selection
// differently (Cursor uses an ACP config option), so this is a no-op for them.
export function resolveEffectiveModel(
  provider: string,
  model: string,
  contextSelection: string | null | undefined
): string {
  if (provider === 'claude-code' && contextSelection === '1m' && !model.includes('[1m]')) {
    const withSuffix = `${model}[1m]`
    // Only append when the base model actually supports a 1M window (has a
    // known `[1m]` limit), so a stale selection carried over to a 200k-only
    // model like Haiku never produces an invalid slug.
    if (withSuffix in MODEL_CONTEXT_LIMITS) return withSuffix
  }
  return model
}

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

export type OutputEventType = 'text' | 'tool_call' | 'tool_result' | 'error' | 'status' | 'plan_ready' | 'question' | 'permission_request' | 'usage' | 'rate_limit' | 'thinking'

export interface OutputEvent {
  type: OutputEventType
  content: string
  metadata?: Record<string, unknown>
  sessionId?: string
}

export type ThreadStatus = 'idle' | 'running' | 'stopping' | 'error' | 'stopped' | 'plan_pending' | 'question_pending' | 'permission_pending'

/** A tool action that Claude requested but needs permission to execute */
export interface PermissionRequest {
  requestId: string
  toolName: string
  toolInput: Record<string, unknown>
  toolUseId: string
  description: string
  source: 'native' | 'synthetic'
  provider: Provider
  createdAt: string
}

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
  hasUpstream: boolean
}

export interface GitBranches {
  current: string
  local: string[]
  remote: string[]
}

export interface GitCompareResult {
  baseRef: string
  files: GitFileChange[]
}

export interface LastCommitInfo {
  hash: string
  subject: string
  /** Full commit message (subject + body) */
  message: string
  /** false if HEAD is the root commit (undo not possible) */
  hasParent: boolean
}

export interface StashEntry {
  /** Full ref, e.g. "stash@{0}". Use this when invoking apply/pop/drop. */
  ref: string
  /** Numeric index extracted from the ref. Note: indices shift when entries are popped/dropped. */
  index: number
  /** Branch the stash was created on (may be empty for unusual reflog subjects). */
  branch: string
  /** Human-readable message (after the "On <branch>:" prefix). */
  message: string
  /** ISO timestamp of when the stash was created. */
  createdAt: string
  /** true if this stash was auto-generated (reflog subject starts with "WIP on"). */
  autoGenerated: boolean
}

/** Result of a pull that may have auto-stashed first. */
export interface PullResult {
  pulled: boolean
  /** true if we stashed dirty changes before pulling. */
  stashed: boolean
  /** true if pop-after-pull hit a conflict and the stash was left intact. */
  popConflict?: boolean
  /** The stash ref we created (present when stashed). */
  stashRef?: string
}

/** A single entry in a git log listing. */
export interface CommitLogEntry {
  /** Full commit SHA. */
  sha: string
  /** Abbreviated SHA (typically 7–8 chars, as git shows it). */
  shortSha: string
  /** First line of the commit message. */
  subject: string
  /** Commit author's display name. */
  authorName: string
  /** Commit author's email. */
  authorEmail: string
  /** ISO-8601 author date. */
  authorDate: string
  /** Full parent SHAs; length > 1 indicates a merge commit. */
  parents: string[]
}

export interface AzureDevOpsPullRequest {
  id: number
  title: string
  status: string
  sourceBranch: string
  targetBranch: string
  authorName: string
  url: string
  creationDate: string
}

export interface GitHubPullRequest {
  id: number
  title: string
  status: string
  sourceBranch: string
  targetBranch: string
  authorName: string
  url: string
  creationDate: string
}

/** Options passed when sending a message to a thread */
export interface SendOptions {
  planMode?: boolean
  /** Request the provider's fast / priority processing tier for this message. */
  fastMode?: boolean
  /** Stable ID shared by the optimistic UI message and supporting providers. */
  clientUserMessageId?: string
  /** Saved attachments that providers may send using native multimodal input. */
  attachments?: Array<{ path?: string; url?: string; detail?: CodexImageDetail }>
  /** Exact skills selected in the composer, including their resolved SKILL.md paths. */
  skills?: Array<{ name: string; path: string; invocation?: string }>
  /** Bounded context fragments kept separate from the user's text. */
  additionalContext?: Record<string, { value: string; kind: 'untrusted' | 'application' }>
  /** Optional JSON Schema for workflows that require a constrained final response. */
  outputSchema?: CodexJsonValue
}

export interface BackgroundTerminal {
  itemId: string
  processId: string
  command: string
  cwd: string
  osPid: number | null
  cpuPercent: number | null
  rssKb: number | null
}

/** A question option from AskUserQuestion tool */
export interface QuestionOption {
  label: string
  description: string
}

/** A single question from AskUserQuestion tool */
export interface Question {
  id?: string
  question: string
  header: string
  multiSelect: boolean
  options: QuestionOption[]
}

export type QuestionAnswerValue = string | string[]

/** The full AskUserQuestion payload */
export interface UserQuestion {
  questions: Question[]
}

// ── File system types ──────────────────────────────────────────────────────

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  isSymlink?: boolean
  children?: FileEntry[]
}

/** A file entry for fuzzy search */
export interface SearchableFile {
  path: string
  relativePath: string
  name: string
  isDirectory?: boolean
  isSymlink?: boolean
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

export type CommandStatus = 'idle' | 'running' | 'stopping' | 'stopped' | 'error'

export interface ProjectCommand {
  id: string
  project_id: string
  name: string
  command: string
  cwd: string | null
  /** Shell to use for local execution: null = platform default, 'powershell' = PowerShell */
  shell: string | null
  run_on_worktree_create: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export interface CommandLogLine {
  id: number
  commandId: string
  text: string
  stream: 'stdout' | 'stderr'
  timestamp: string
}

// ── CLI Health ─────────────────────────────────────────────────────────────────

export interface CliHealthResult {
  installed: boolean
  currentVersion: string | null
  latestVersion: string | null
  /** null when either version is unavailable */
  upToDate: boolean | null
  /** Non-fatal capability advisory (e.g. Cursor parameterized model picker requires a newer CLI / lab channel). */
  advisory?: string | null
}

export interface CliUpdateResult {
  success: boolean
  output: string
}

// ── Slash Commands ─────────────────────────────────────────────────────────────

export interface SlashCommand {
  id: string
  project_id: string | null  // null = global
  name: string               // trigger name (without /)
  description: string | null
  prompt: string
  sort_order: number
  created_at: string
  updated_at: string
  kind?: 'command' | 'skill'
  scope?: 'global' | 'project' | 'admin' | 'system'
  harness?: Provider | 'gemini'
  path?: string
  invocation?: string
}

// ── Thread Log Entries ─────────────────────────────────────────────────────────

export interface ThreadLogEntry {
  ts: string
  type: string
  content?: string
  metadata?: unknown
}

// ── Auto-update ────────────────────────────────────────────────────────────────

export interface UpdateState {
  available: boolean
  ready: boolean
  checking: boolean
  downloading: boolean
  /** Download progress percentage (0-100) */
  progress?: number
  error?: string
  /** The version available for download / ready to install */
  version?: string
}
