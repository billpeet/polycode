import type { ChannelArgs, ChannelResult, LocalChannel } from '@polycode/shared'
import { BackgroundTerminal, Project, ProjectSortMode, Thread, Message, OutputEvent, ThreadStatus, GitStatus, GitFileChange, GitBranches, GitCompareResult, LastCommitInfo, StashEntry, PullResult, CommitLogEntry, PullRequest, ANTHROPIC_MODELS, AnthropicModelId, SendOptions, Question, PermissionRequest, FileEntry, SearchableFile, ClaudeProject, ClaudeSession, PendingAttachment, SUPPORTED_ATTACHMENT_TYPES, MAX_ATTACHMENT_SIZE, MAX_ATTACHMENTS_PER_MESSAGE, Session, SshConfig, WslConfig, ConnectionType, RepoLocation, TokenUsage, MODEL_CONTEXT_LIMITS, DEFAULT_CONTEXT_LIMIT, resolveEffectiveModel, OPENAI_MODELS, OpenAIModelId, CURSOR_MODELS, CursorModelId, GROK_MODELS, GrokModelId, Provider, PermissionMode, PROVIDERS, getModelsForProvider, getDefaultModelForProvider, RateLimitInfo, ProjectCommand, CommandStatus, CommandLogLine, YouTrackServer, YouTrackIssue, SlashCommand, CliHealthResult, CliUpdateResult, ThreadLogEntry, LocationPool, ModelOption, ReasoningLevel, CodexPersonality, CodexReasoningSummary, QuestionAnswerValue, UpdateState, UpdateReleaseNotes, NewProjectSpec, NewProjectResult, RemoteServerConfig, RemoteHost, RemoteHostInput, RemoteConnectionStatus, RemoteConnectionState, RemoteConnectionPhase, RemotePairingInfo, Routine, RoutineDraft, RoutineTriggerType, RunState, ThreadArchiveResult, WorktreeCleanupCandidate, WorkingTreeFacts } from '../../../shared/types'

export type { Routine, RoutineDraft, RoutineTriggerType, RunState }
export type { QueueThread } from '../../../shared/types'
export type { BrowserSessionConfig } from '../../../shared/types'
export type { BackgroundTerminal, Project, ProjectSortMode, Thread, Message, OutputEvent, ThreadStatus, GitStatus, GitFileChange, GitBranches, GitCompareResult, LastCommitInfo, StashEntry, PullResult, CommitLogEntry, PullRequest, AnthropicModelId, OpenAIModelId, CursorModelId, GrokModelId, Provider, PermissionMode, ReasoningLevel, CodexPersonality, CodexReasoningSummary, SendOptions, Question, PermissionRequest, FileEntry, SearchableFile, ClaudeProject, ClaudeSession, PendingAttachment, Session, SshConfig, WslConfig, ConnectionType, RepoLocation, TokenUsage, RateLimitInfo, ProjectCommand, CommandStatus, CommandLogLine, YouTrackServer, YouTrackIssue, SlashCommand, CliHealthResult, CliUpdateResult, ThreadLogEntry, LocationPool, ModelOption, QuestionAnswerValue, UpdateState, UpdateReleaseNotes, NewProjectSpec, NewProjectResult, RemoteServerConfig, RemoteHost, RemoteHostInput, RemoteConnectionStatus, RemoteConnectionState, RemoteConnectionPhase, RemotePairingInfo, ThreadArchiveResult, WorktreeCleanupCandidate, WorkingTreeFacts }
export { ANTHROPIC_MODELS, OPENAI_MODELS, CURSOR_MODELS, GROK_MODELS, PROVIDERS, getModelsForProvider, getDefaultModelForProvider, SUPPORTED_ATTACHMENT_TYPES, MAX_ATTACHMENT_SIZE, MAX_ATTACHMENTS_PER_MESSAGE, MODEL_CONTEXT_LIMITS, DEFAULT_CONTEXT_LIMIT, resolveEffectiveModel }

/** Shape of window.api exposed by preload */
export interface WindowApi {
  invoke<C extends LocalChannel>(channel: C, ...args: ChannelArgs<C>): Promise<ChannelResult<C>>

  on(channel: string, callback: (...args: unknown[]) => void): () => void
  send(channel: string, ...args: unknown[]): void
  onSlowInvoke(callback: (pendingSlowCalls: number) => void): () => void
}

declare global {
  interface Window {
    api: WindowApi
  }
}
