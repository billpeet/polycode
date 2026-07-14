import type {
  Codex as CodexSdk,
  CodexOptions as CodexSdkOptions,
  ThreadEvent,
  ThreadItem,
  ThreadOptions as CodexThreadOptions,
} from '@openai/codex-sdk'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { DriverOptions, MessageOptions, CLIDriver } from './types'
import { BackgroundTerminal, OutputEvent, PermissionMode, ReasoningLevel } from '../../shared/types'
import { SpawnCommand } from './runner/types'
import { BaseDriver } from './base'
import { augmentWindowsPath } from './runner'
import { homedir } from 'os'
import path from 'path'
import readline from 'readline'
import { parseShellCommand } from '../../shared/shell-command'

type ToolCallPayload = { content: string; metadata: Record<string, unknown> }

type CodexAppServerUserInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'image'; url: string; detail?: 'auto' | 'low' | 'high' | 'original' }
  | { type: 'localImage'; path: string; detail?: 'auto' | 'low' | 'high' | 'original' }
  | { type: 'skill'; name: string; path: string }

type ContextCompactionItem = {
  id: string
  type: 'context_compaction'
}

type ImageViewItem = {
  id: string
  type: 'image_view'
  path?: string
  url?: string
  caption?: string
}

type PlanItem = {
  id: string
  type: 'plan'
  text: string
}

type SleepItem = {
  id: string
  type: 'sleep'
  duration_ms: number
}

type ImageGenerationItem = {
  id: string
  type: 'image_generation'
  prompt?: string
  status?: string
}

type ReviewModeItem = {
  id: string
  type: 'entered_review_mode' | 'exited_review_mode'
  review: string
}

type CollabAgentStatus =
  | 'pendingInit'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'errored'
  | 'shutdown'
  | 'notFound'

type CollabAgentState = {
  status: CollabAgentStatus
  message: string | null
}

type CollabAgentToolCallItem = {
  id: string
  type: 'collab_agent_tool_call'
  tool: 'spawnAgent' | 'sendInput' | 'resumeAgent' | 'wait' | 'closeAgent'
  status: 'inProgress' | 'completed' | 'failed'
  sender_thread_id: string
  receiver_thread_ids: string[]
  prompt: string | null
  model: string | null
  reasoning_effort: string | null
  agents_states: Record<string, CollabAgentState>
}

type SubAgentActivityItem = {
  id: string
  type: 'sub_agent_activity'
  kind: 'started' | 'interacted' | 'interrupted'
  agent_thread_id: string
  agent_path: string
}

type DynamicToolCallItem = {
  id: string
  type: 'dynamic_tool_call'
  namespace: string | null
  tool: string
  arguments: unknown
  status: string
  content_items: Array<Record<string, unknown>>
  success: boolean | null
}

type HookPromptItem = {
  id: string
  type: 'hook_prompt'
  fragments: Array<{ text: string; hookRunId?: string }>
}

type GenericCodexItem = {
  id: string
  type: 'generic'
  codex_item_type: string
  raw: Record<string, unknown>
}

type AppServerCommandExecutionItem = {
  id: string
  type: 'command_execution'
  command: string
  cwd: string
  process_id: string | null
  source: string
  status: 'in_progress' | 'completed' | 'failed'
  command_actions: Array<Record<string, unknown>>
  aggregated_output: string
  exit_code?: number
  duration_ms?: number
}

type CodexThreadItem =
  | ThreadItem
  | ContextCompactionItem
  | ImageViewItem
  | PlanItem
  | SleepItem
  | ImageGenerationItem
  | ReviewModeItem
  | CollabAgentToolCallItem
  | SubAgentActivityItem
  | DynamicToolCallItem
  | HookPromptItem
  | GenericCodexItem
  | AppServerCommandExecutionItem

type CodexStreamState = {
  streamedItemIds: Set<string>
  announcedItemIds: Set<string>
  completedItemIds: Set<string>
  lastAgentTextById: Map<string, string>
  proposedPlanTextById: Map<string, string>
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeCodexContextWindowUsage(usage: Record<string, unknown> | null | undefined): number {
  if (!usage) return 0
  const inputTokens = asFiniteNumber(usage.input_tokens ?? usage.inputTokens) ?? 0
  const cachedInputTokens = asFiniteNumber(usage.cached_input_tokens ?? usage.cachedInputTokens) ?? 0
  const outputTokens = asFiniteNumber(usage.output_tokens ?? usage.outputTokens) ?? 0
  const usedTokens = inputTokens + cachedInputTokens + outputTokens
  const maxTokens = asFiniteNumber(usage.model_context_window ?? usage.modelContextWindow)
  return maxTokens && maxTokens > 0 ? Math.min(usedTokens, maxTokens) : usedTokens
}

function pickString(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function pickNumber(record: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function thinking(content: string, metadata: Record<string, unknown>): OutputEvent {
  return {
    type: 'thinking',
    content,
    metadata: { type: 'thinking', ...metadata },
  }
}

/**
 * Given a raw command string from a Codex command_execution item, return a
 * display-friendly name and the inner command to show in the UI.
 *
 * Commands are typically wrapped by the provider's platform shell. We strip
 * that wrapper so the UI shows the shell name + the inner command, mirroring
 * how Claude Code's Bash tool is displayed.
 */
export function parseBashCommand(raw: string): { name: string; innerCmd: string } {
  return parseShellCommand(raw)
}

/** Build a tool_call event for a Codex item. */
function makeToolCallEvent(item: CodexThreadItem): ToolCallPayload {
  if (item.type === 'command_execution') {
    const { name, innerCmd } = parseBashCommand(item.command)
    const label = innerCmd.split('\n')[0].slice(0, 120) || name
    return {
      content: label,
      metadata: {
        ...item,
        type: 'tool_call',
        name,
        input: {
          command: innerCmd,
          ...('cwd' in item && item.cwd ? { cwd: item.cwd } : {}),
          ...('process_id' in item && item.process_id ? { processId: item.process_id } : {}),
          ...('source' in item && item.source ? { source: item.source } : {}),
          ...('command_actions' in item && item.command_actions.length > 0 ? { commandActions: item.command_actions } : {}),
        },
      },
    }
  }

  if (item.type === 'file_change') {
    const firstPath = item.changes[0]?.path ?? 'file_change'
    const label = firstPath.length > 120 ? '...' + firstPath.slice(-117) : firstPath
    return {
      content: label,
      metadata: { ...item, type: 'tool_call', name: 'FileChange', input: { changes: item.changes } },
    }
  }

  if (item.type === 'mcp_tool_call') {
    const metadata = item as unknown as Record<string, unknown>
    const appName = typeof metadata.app_name === 'string' ? metadata.app_name : ''
    const actionName = typeof metadata.action_name === 'string' ? metadata.action_name : item.tool
    return {
      content: actionName,
      metadata: {
        ...item,
        type: 'tool_call',
        name: appName ? `${appName}: ${actionName}` : item.tool,
        input: {
          server: item.server,
          arguments: item.arguments,
          ...(metadata.app_context ? { appContext: metadata.app_context } : {}),
          ...(metadata.plugin_id ? { pluginId: metadata.plugin_id } : {}),
        },
      },
    }
  }

  if (item.type === 'dynamic_tool_call') {
    const name = item.namespace ? `${item.namespace}.${item.tool}` : item.tool
    return {
      content: item.tool,
      metadata: { ...item, type: 'tool_call', name, input: item.arguments },
    }
  }

  if (item.type === 'generic') {
    return {
      content: item.codex_item_type,
      metadata: {
        ...item.raw,
        id: item.id,
        type: 'tool_call',
        name: item.codex_item_type,
        codex_item_type: item.codex_item_type,
        input: item.raw,
      },
    }
  }

  if (item.type === 'web_search') {
    return {
      content: item.query,
      metadata: { ...item, type: 'tool_call', name: 'WebSearch', input: { query: item.query } },
    }
  }

  if (item.type === 'todo_list') {
    return {
      content: 'todo_list',
      metadata: { ...item, type: 'tool_call', name: 'TodoList', input: { items: item.items } },
    }
  }

  if (item.type === 'plan') {
    return {
      content: 'plan',
      metadata: { ...item, type: 'tool_call', name: 'Plan', input: { text: item.text } },
    }
  }

  if (item.type === 'sleep') {
    return {
      content: `sleep ${item.duration_ms}ms`,
      metadata: { ...item, type: 'tool_call', name: 'Sleep', input: { duration_ms: item.duration_ms } },
    }
  }

  if (item.type === 'image_generation') {
    return {
      content: item.prompt ? truncateOneLine(item.prompt) : 'image generation',
      metadata: { ...item, type: 'tool_call', name: 'ImageGeneration', input: { prompt: item.prompt } },
    }
  }

  if (item.type === 'entered_review_mode' || item.type === 'exited_review_mode') {
    const name = item.type === 'entered_review_mode' ? 'EnteredReviewMode' : 'ExitedReviewMode'
    return {
      content: item.review || name,
      metadata: { ...item, type: 'tool_call', name, input: { review: item.review } },
    }
  }

  if (item.type === 'collab_agent_tool_call') {
    return {
      content: formatCollabAgentToolCallLabel(item),
      metadata: {
        ...item,
        type: 'tool_call',
        name: 'Agent',
        input: {
          tool: item.tool,
          prompt: item.prompt,
          model: item.model,
          reasoning_effort: item.reasoning_effort,
          sender_thread_id: item.sender_thread_id,
          receiver_thread_ids: item.receiver_thread_ids,
        },
      },
    }
  }

  if (item.type === 'context_compaction') {
    return {
      content: 'conversation history',
      metadata: {
        ...item,
        type: 'tool_call',
        name: 'ContextCompaction',
        input: { action: 'compact_history' },
      },
    }
  }

  if (item.type === 'image_view') {
    const target = item.path ?? item.url ?? item.caption ?? 'image'
    return {
      content: target.length > 120 ? '...' + target.slice(-117) : target,
      metadata: { ...item, type: 'tool_call', name: 'ImageView', input: { path: item.path, url: item.url, caption: item.caption } },
    }
  }

  return {
    content: item.type,
    metadata: { ...item, type: 'tool_call' },
  }
}

function extractTextDelta(previous: string, next: string): string {
  if (!next) return ''
  if (!previous) return next
  return next.startsWith(previous) ? next.slice(previous.length) : next
}

function summarizeMcpResult(item: Extract<ThreadItem, { type: 'mcp_tool_call' }>): string {
  if (item.error?.message) return item.error.message
  const blocks = item.result?.content ?? []
  const textParts = blocks
    .map((block) => {
      if (!block || typeof block !== 'object') return null
      const text = 'text' in block ? block.text : null
      return typeof text === 'string' ? text : null
    })
    .filter((text): text is string => Boolean(text))
  if (textParts.length > 0) return textParts.join('\n')
  if (item.result?.structured_content !== undefined) return JSON.stringify(item.result.structured_content, null, 2)
  return ''
}

function buildToolResult(item: CodexThreadItem): OutputEvent | null {
  switch (item.type) {
    case 'command_execution':
      return {
        type: 'tool_result',
        content: item.aggregated_output ?? '',
        metadata: {
          ...item,
          type: 'tool_result',
          tool_use_id: item.id,
          ...(item.status === 'failed' ? { is_error: true } : {}),
        },
      }
    case 'mcp_tool_call':
      return {
        type: 'tool_result',
        content: summarizeMcpResult(item),
        metadata: {
          ...item,
          type: 'tool_result',
          tool_use_id: item.id,
          ...(item.status === 'failed' ? { is_error: true } : {}),
        },
      }
    case 'dynamic_tool_call': {
      const content = item.content_items
        .map((contentItem) => contentItem.type === 'inputText' && typeof contentItem.text === 'string' ? contentItem.text : '')
        .filter(Boolean)
        .join('\n')
      return {
        type: 'tool_result',
        content,
        metadata: {
          ...item,
          type: 'tool_result',
          tool_use_id: item.id,
          ...(item.success === false ? { is_error: true } : {}),
        },
      }
    }
    case 'generic':
      return {
        type: 'tool_result',
        content: '',
        metadata: {
          ...item.raw,
          id: item.id,
          type: 'tool_result',
          tool_use_id: item.id,
          codex_item_type: item.codex_item_type,
        },
      }
    case 'file_change':
    case 'web_search':
    case 'todo_list':
    case 'plan':
    case 'sleep':
    case 'image_generation':
    case 'entered_review_mode':
    case 'exited_review_mode':
    case 'context_compaction':
    case 'image_view':
      return {
        type: 'tool_result',
        content: item.type === 'context_compaction'
          ? 'Conversation history compacted.'
          : item.type === 'plan'
            ? item.text
            : '',
        metadata: {
          ...item,
          type: 'tool_result',
          tool_use_id: item.id,
        },
      }
    case 'collab_agent_tool_call':
      return {
        type: 'tool_result',
        content: summarizeCollabAgentToolCallResult(item),
        metadata: {
          ...item,
          type: 'tool_result',
          tool_use_id: item.id,
          ...(item.status === 'failed' ? { is_error: true } : {}),
        },
      }
    case 'error':
      return {
        type: 'error',
        content: item.message,
      }
    default:
      return null
  }
}

function formatCollabAgentToolCallLabel(item: CollabAgentToolCallItem): string {
  switch (item.tool) {
    case 'spawnAgent':
      return item.prompt ? `Spawn agent: ${truncateOneLine(item.prompt)}` : 'Spawn agent'
    case 'sendInput':
      return item.prompt ? `Send input: ${truncateOneLine(item.prompt)}` : 'Send input to agent'
    case 'resumeAgent':
      return 'Resume agent'
    case 'wait':
      return item.receiver_thread_ids.length > 1
        ? `Wait for ${item.receiver_thread_ids.length} agents`
        : 'Wait for agent'
    case 'closeAgent':
      return 'Close agent'
  }
}

function summarizeCollabAgentToolCallResult(item: CollabAgentToolCallItem): string {
  const states = Object.entries(item.agents_states ?? {})
  if (states.length === 0) return ''
  return states
    .map(([threadId, state]) => {
      const message = state.message ? `: ${state.message}` : ''
      return `${threadId} ${state.status}${message}`
    })
    .join('\n')
}

function truncateOneLine(value: string, limit = 120): string {
  const compact = value.split(/\s+/).filter(Boolean).join(' ')
  return compact.length > limit ? `${compact.slice(0, limit - 3)}...` : compact
}

function buildSubAgentActivityEvent(item: SubAgentActivityItem): OutputEvent {
  const action = item.kind === 'started'
    ? 'started'
    : item.kind === 'interacted'
      ? 'interacted with'
      : 'interrupted'
  return {
    type: 'thinking',
    content: `**Subagent ${action}:** ${item.agent_path}`,
    metadata: {
      type: 'thinking',
      source: 'codex_subagent',
      task_event: item.kind,
      task_id: item.agent_thread_id,
      agent_scope: 'subagent',
      agent_task_id: item.agent_thread_id,
      agent_description: item.agent_path,
      agent_status: item.kind === 'interrupted' ? 'stopped' : 'running',
      codex_item_id: item.id,
      codex_agent_path: item.agent_path,
    },
  }
}

function normalizeCodexQuestion(raw: Record<string, unknown>, index: number) {
  const id = typeof raw.id === 'string' && raw.id ? raw.id : `question-${index + 1}`
  const header = typeof raw.header === 'string' && raw.header ? raw.header : 'Question'
  const question = typeof raw.question === 'string' && raw.question ? raw.question : header
  const rawOptions = Array.isArray(raw.options) ? raw.options as Record<string, unknown>[] : []
  const options = rawOptions.map((option) => ({
    label: String(option.label ?? option.value ?? option.id ?? ''),
    description: String(option.description ?? option.label ?? option.value ?? ''),
  })).filter((option) => option.label)
  return {
    id,
    header,
    question,
    options,
    multiple: Boolean(raw.isOther) || Boolean(raw.allowMultiple),
    secret: Boolean(raw.isSecret),
  }
}

export function createCodexStreamState(): CodexStreamState {
  return {
    streamedItemIds: new Set<string>(),
    announcedItemIds: new Set<string>(),
    completedItemIds: new Set<string>(),
    lastAgentTextById: new Map<string, string>(),
    proposedPlanTextById: new Map<string, string>(),
  }
}

export function parseCodexSdkEvent(
  event: ThreadEvent,
  state: CodexStreamState,
  onSessionId?: (sessionId: string) => void
): OutputEvent[] {
  const events: OutputEvent[] = []

  switch (event.type) {
    case 'thread.started':
      if (event.thread_id) onSessionId?.(event.thread_id)
      break

    case 'item.started': {
      const item = event.item
      if (item.type !== 'agent_message' && item.type !== 'reasoning' && item.type !== 'error') {
        if (state.announcedItemIds.has(item.id)) break
        const { content, metadata } = makeToolCallEvent(item)
        events.push({ type: 'tool_call', content, metadata })
        state.announcedItemIds.add(item.id)
      }
      break
    }

    case 'item.updated': {
      const item = event.item
      if (item.type === 'agent_message') {
        const previous = state.lastAgentTextById.get(item.id) ?? ''
        const delta = extractTextDelta(previous, item.text)
        if (delta) {
          state.streamedItemIds.add(item.id)
          state.lastAgentTextById.set(item.id, item.text)
          events.push({ type: 'text', content: delta })
        }
      }
      break
    }

    case 'item.completed': {
      const item = event.item
      if (item.type === 'agent_message') {
        const previous = state.lastAgentTextById.get(item.id) ?? ''
        const delta = extractTextDelta(previous, item.text)
        state.lastAgentTextById.set(item.id, item.text)
        if (delta) {
          events.push({ type: 'text', content: delta })
        }
        break
      }

      if (item.type === 'reasoning') break
      if (state.completedItemIds.has(item.id)) break
      state.completedItemIds.add(item.id)

      if (item.type === 'error') {
        events.push({ type: 'error', content: item.message })
        break
      }

      if (!state.announcedItemIds.has(item.id)) {
        const { content, metadata } = makeToolCallEvent(item)
        events.push({ type: 'tool_call', content, metadata })
        state.announcedItemIds.add(item.id)
      }

      const toolResult = buildToolResult(item)
      if (toolResult) events.push(toolResult)
      break
    }

    case 'turn.completed': {
      const inputTokens = event.usage?.input_tokens ?? 0
      const outputTokens = event.usage?.output_tokens ?? 0
      const contextWindow = normalizeCodexContextWindowUsage(event.usage as Record<string, unknown> | undefined)
      if (inputTokens || outputTokens || contextWindow) {
        events.push({
          type: 'usage',
          content: '',
          metadata: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            context_window: contextWindow,
          },
        })
      }
      break
    }

    case 'turn.failed':
      events.push({ type: 'error', content: event.error.message || 'Unknown Codex error' })
      break

    case 'error':
      events.push({ type: 'error', content: event.message || 'Unknown Codex error' })
      break

    case 'turn.started':
      break
  }

  return events
}

function normalizeAppServerItem(raw: Record<string, unknown>): CodexThreadItem | null {
  const itemType = raw.type as string | undefined
  const id = raw.id as string | undefined
  if (!itemType || !id) return null

  switch (itemType) {
    case 'userMessage':
      return null
    case 'agentMessage':
      return {
        id,
        type: 'agent_message',
        text: String(raw.text ?? ''),
      }
    case 'reasoning':
      return {
        id,
        type: 'reasoning',
        text: String(raw.text ?? (Array.isArray(raw.summary) ? raw.summary.join('\n') : '')),
      }
    case 'plan':
      return {
        id,
        type: 'plan',
        text: String(raw.text ?? ''),
      }
    case 'commandExecution':
      return {
        id,
        type: 'command_execution',
        command: String(raw.command ?? ''),
        cwd: String(raw.cwd ?? ''),
        process_id: typeof raw.processId === 'string' ? raw.processId : null,
        source: String(raw.source ?? 'agent'),
        command_actions: Array.isArray(raw.commandActions) ? raw.commandActions as Array<Record<string, unknown>> : [],
        aggregated_output: String(raw.aggregatedOutput ?? ''),
        status: ((raw.status as string | undefined) ?? 'in_progress') as 'in_progress' | 'completed' | 'failed',
        ...(typeof raw.exitCode === 'number' ? { exit_code: raw.exitCode } : {}),
        ...(typeof raw.durationMs === 'number' ? { duration_ms: raw.durationMs } : {}),
      }
    case 'fileChange':
      return {
        id,
        type: 'file_change',
        changes: Array.isArray(raw.changes) ? raw.changes as Array<{ path: string; kind: 'add' | 'delete' | 'update' }> : [],
        status: ((raw.status as string | undefined) ?? 'completed') as 'completed' | 'failed',
      }
    case 'mcpToolCall':
      {
        const appContext = raw.appContext && typeof raw.appContext === 'object'
          ? raw.appContext as Record<string, unknown>
          : null
      return {
        id,
        type: 'mcp_tool_call',
        server: String(raw.server ?? ''),
        tool: String(raw.tool ?? ''),
        arguments: raw.arguments,
        app_context: appContext,
        app_name: typeof appContext?.appName === 'string' ? appContext.appName : null,
        action_name: typeof appContext?.actionName === 'string' ? appContext.actionName : null,
        connector_id: typeof appContext?.connectorId === 'string' ? appContext.connectorId : null,
        resource_uri: typeof appContext?.resourceUri === 'string'
          ? appContext.resourceUri
          : typeof raw.mcpAppResourceUri === 'string' ? raw.mcpAppResourceUri : null,
        plugin_id: typeof raw.pluginId === 'string' ? raw.pluginId : null,
        duration_ms: typeof raw.durationMs === 'number' ? raw.durationMs : null,
        ...(raw.result && typeof raw.result === 'object'
          ? {
              result: {
                content: Array.isArray((raw.result as Record<string, unknown>).content)
                  ? ((raw.result as Record<string, unknown>).content as Array<Record<string, unknown>>)
                  : [],
                structured_content: (raw.result as Record<string, unknown>).structuredContent,
              },
            }
          : {}),
        ...(raw.error && typeof raw.error === 'object'
          ? {
              error: {
                message: String((raw.error as Record<string, unknown>).message ?? ''),
              },
            }
          : {}),
        status: ((raw.status as string | undefined) ?? 'in_progress') as 'in_progress' | 'completed' | 'failed',
      } as unknown as CodexThreadItem
      }
    case 'webSearch':
      return {
        id,
        type: 'web_search',
        query: String(raw.query ?? ''),
      }
    case 'todoList':
      return {
        id,
        type: 'todo_list',
        items: Array.isArray(raw.items)
          ? raw.items.map((item) => ({
              text: String((item as Record<string, unknown>).text ?? ''),
              completed: Boolean((item as Record<string, unknown>).completed),
            }))
          : [],
      }
    case 'contextCompaction':
      return {
        id,
        type: 'context_compaction',
      }
    case 'imageView': {
      const pathValue = raw.path ?? raw.filePath
      const urlValue = raw.url ?? raw.imageUrl
      const captionValue = raw.caption ?? raw.alt
      return {
        id,
        type: 'image_view',
        ...(typeof pathValue === 'string' ? { path: pathValue } : {}),
        ...(typeof urlValue === 'string' ? { url: urlValue } : {}),
        ...(typeof captionValue === 'string' ? { caption: captionValue } : {}),
      }
    }
    case 'sleep':
      return {
        id,
        type: 'sleep',
        duration_ms: Number(raw.durationMs ?? 0),
      }
    case 'imageGeneration':
      return {
        id,
        type: 'image_generation',
        ...(typeof raw.prompt === 'string' ? { prompt: raw.prompt } : {}),
        ...(typeof raw.status === 'string' ? { status: raw.status } : {}),
      }
    case 'enteredReviewMode':
      return {
        id,
        type: 'entered_review_mode',
        review: String(raw.review ?? ''),
      }
    case 'exitedReviewMode':
      return {
        id,
        type: 'exited_review_mode',
        review: String(raw.review ?? ''),
      }
    case 'collabAgentToolCall':
      return {
        id,
        type: 'collab_agent_tool_call',
        tool: (typeof raw.tool === 'string' ? raw.tool : 'spawnAgent') as CollabAgentToolCallItem['tool'],
        status: (typeof raw.status === 'string' ? raw.status : 'inProgress') as CollabAgentToolCallItem['status'],
        sender_thread_id: String(raw.senderThreadId ?? ''),
        receiver_thread_ids: Array.isArray(raw.receiverThreadIds)
          ? raw.receiverThreadIds.map(String)
          : [],
        prompt: typeof raw.prompt === 'string' ? raw.prompt : null,
        model: typeof raw.model === 'string' ? raw.model : null,
        reasoning_effort: typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort : null,
        agents_states: raw.agentsStates && typeof raw.agentsStates === 'object'
          ? raw.agentsStates as Record<string, CollabAgentState>
          : {},
      }
    case 'subAgentActivity':
      return {
        id,
        type: 'sub_agent_activity',
        kind: (typeof raw.kind === 'string' ? raw.kind : 'started') as SubAgentActivityItem['kind'],
        agent_thread_id: String(raw.agentThreadId ?? ''),
        agent_path: String(raw.agentPath ?? ''),
      }
    case 'dynamicToolCall':
      return {
        id,
        type: 'dynamic_tool_call',
        namespace: typeof raw.namespace === 'string' ? raw.namespace : null,
        tool: String(raw.tool ?? 'dynamicTool'),
        arguments: raw.arguments,
        status: String(raw.status ?? 'inProgress'),
        content_items: Array.isArray(raw.contentItems) ? raw.contentItems as Array<Record<string, unknown>> : [],
        success: typeof raw.success === 'boolean' ? raw.success : null,
      }
    case 'hookPrompt':
      return {
        id,
        type: 'hook_prompt',
        fragments: Array.isArray(raw.fragments)
          ? raw.fragments.map((fragment) => ({
              text: String((fragment as Record<string, unknown>).text ?? ''),
              ...(typeof (fragment as Record<string, unknown>).hookRunId === 'string'
                ? { hookRunId: (fragment as Record<string, unknown>).hookRunId as string }
                : {}),
            }))
          : [],
      }
    case 'error':
      return {
        id,
        type: 'error',
        message: String(raw.message ?? 'Unknown Codex error'),
      }
    default:
      return {
        id,
        type: 'generic',
        codex_item_type: itemType,
        raw,
      }
  }
}

export function parseCodexAppServerNotification(
  method: string,
  params: Record<string, unknown> | undefined,
  state: CodexStreamState,
  onSessionId?: (sessionId: string) => void
): OutputEvent[] {
  const events: OutputEvent[] = []

  switch (method) {
    case 'thread/started': {
      const thread = params?.thread as Record<string, unknown> | undefined
      const threadId = (thread?.id as string | undefined) ?? (params?.threadId as string | undefined)
      if (threadId) onSessionId?.(threadId)
      break
    }
    case 'item/agentMessage/delta': {
      const delta = params?.delta as string | undefined
      const itemId = (params?.itemId as string | undefined) ?? ((params?.item as Record<string, unknown> | undefined)?.id as string | undefined)
      if (delta) {
        if (itemId) {
          state.streamedItemIds.add(itemId)
          state.lastAgentTextById.set(itemId, `${state.lastAgentTextById.get(itemId) ?? ''}${delta}`)
        }
        events.push({ type: 'text', content: delta })
      }
      break
    }
    case 'item/plan/delta': {
      const delta = params?.delta as string | undefined
      if (delta) {
        const itemId = params?.itemId as string | undefined
        if (itemId) {
          state.proposedPlanTextById.set(itemId, `${state.proposedPlanTextById.get(itemId) ?? ''}${delta}`)
        }
        events.push(thinking(delta, {
          source: 'codex_plan',
          item_id: itemId,
          turn_id: params?.turnId,
        }))
      }
      break
    }
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta': {
      const delta = params?.delta as string | undefined
      if (delta) {
        events.push(thinking(delta, {
          source: method === 'item/reasoning/textDelta' ? 'codex_reasoning' : 'codex_reasoning_summary',
          item_id: params?.itemId,
          turn_id: params?.turnId,
          content_index: params?.contentIndex,
          summary_index: params?.summaryIndex,
        }))
      }
      break
    }
    // Structural boundary only. Displayable summary text arrives separately in
    // item/reasoning/summaryTextDelta notifications.
    case 'item/reasoning/summaryPartAdded':
      break
    case 'item/started':
    case 'item/completed': {
      const item = params?.item && typeof params.item === 'object'
        ? normalizeAppServerItem(params.item as Record<string, unknown>)
        : null
      if (!item) break

      if (item.type === 'agent_message') {
        if (method === 'item/completed') {
          const previous = state.lastAgentTextById.get(item.id) ?? ''
          const delta = extractTextDelta(previous, item.text)
          state.lastAgentTextById.set(item.id, item.text)
          if (delta) events.push({ type: 'text', content: delta })
        }
        break
      }

      if (item.type === 'reasoning') break
      if (method === 'item/completed' && state.completedItemIds.has(item.id)) break
      if (method === 'item/completed') state.completedItemIds.add(item.id)

      if (item.type === 'error') {
        events.push({ type: 'error', content: item.message })
        break
      }

      if (item.type === 'plan') {
        if (method === 'item/completed') {
          const text = item.text || state.proposedPlanTextById.get(item.id) || ''
          if (text.trim()) {
            events.push({
              type: 'plan_ready',
              content: text,
              metadata: { ...item, text, type: 'plan_ready', provider: 'codex' },
            })
          }
        }
        break
      }

      if (item.type === 'sub_agent_activity') {
        events.push(buildSubAgentActivityEvent(item))
        break
      }

      if (item.type === 'hook_prompt') {
        if (!state.announcedItemIds.has(item.id)) {
          const content = item.fragments.map((fragment) => fragment.text).filter(Boolean).join('\n')
          if (content) {
            events.push(thinking(content, {
              source: 'codex_hook_prompt',
              item_id: item.id,
              fragments: item.fragments,
            }))
          }
          state.announcedItemIds.add(item.id)
        }
        break
      }

      if (!state.announcedItemIds.has(item.id)) {
        const { content, metadata } = makeToolCallEvent(item)
        events.push({ type: 'tool_call', content, metadata })
        state.announcedItemIds.add(item.id)
      }

      if (method === 'item/completed') {
        const toolResult = buildToolResult(item)
        if (toolResult) events.push(toolResult)
      }
      break
    }
    case 'item/commandExecution/terminalInteraction': {
      const stdin = typeof params?.stdin === 'string' ? params.stdin : ''
      const itemId = typeof params?.itemId === 'string' ? params.itemId : ''
      if (itemId && stdin) {
        events.push({
          type: 'tool_result',
          content: `\n› ${stdin}`,
          metadata: {
            ...(params ?? {}),
            type: 'tool_result',
            tool_use_id: itemId,
            process_id: params?.processId,
            terminal_interaction: true,
          },
        })
      }
      break
    }
    case 'item/commandExecution/outputDelta':
    case 'item/fileChange/outputDelta': {
      const delta = params?.delta as string | undefined
      const itemId = (params?.itemId as string | undefined)
        ?? ((params?.item as Record<string, unknown> | undefined)?.id as string | undefined)
      if (delta) {
        events.push({
          type: 'tool_result',
          content: delta,
          metadata: {
            ...(params ?? {}),
            type: 'tool_result',
            ...(itemId ? { tool_use_id: itemId } : {}),
          },
        })
      }
      break
    }
    case 'item/fileChange/patchUpdated': {
      const changes = Array.isArray(params?.changes) ? params?.changes : []
      const itemId = params?.itemId as string | undefined
      events.push({
        type: 'tool_result',
        content: '',
        metadata: {
          ...(params ?? {}),
          type: 'tool_result',
          ...(itemId ? { tool_use_id: itemId } : {}),
          changes,
        },
      })
      break
    }
    case 'item/mcpToolCall/progress': {
      const message = params?.message as string | undefined
      if (message) {
        events.push(thinking(message, {
          source: 'codex_mcp_progress',
          item_id: params?.itemId,
          turn_id: params?.turnId,
        }))
      }
      break
    }
    case 'turn/completed': {
      const turn = params?.turn as Record<string, unknown> | undefined
      const usage = (turn?.usage as Record<string, unknown> | undefined) ?? (params?.usage as Record<string, unknown> | undefined)
      const inputTokens = Number(usage?.inputTokens ?? usage?.input_tokens ?? 0)
      const outputTokens = Number(usage?.outputTokens ?? usage?.output_tokens ?? 0)
      const contextWindow = normalizeCodexContextWindowUsage(usage)
      if (inputTokens || outputTokens || contextWindow) {
        events.push({
          type: 'usage',
          content: '',
          metadata: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            context_window: contextWindow,
          },
        })
      }
      break
    }
    case 'turn/diff/updated': {
      const turnId = String(params?.turnId ?? '')
      const diff = typeof params?.diff === 'string' ? params.diff : ''
      if (!turnId) break
      const itemId = `turn-diff:${turnId}`
      if (!state.announcedItemIds.has(itemId)) {
        events.push({
          type: 'tool_call',
          content: 'Changes made this turn',
          metadata: { id: itemId, type: 'tool_call', name: 'TurnDiff', input: {}, turn_id: turnId },
        })
        state.announcedItemIds.add(itemId)
      }
      events.push({
        type: 'tool_result',
        content: diff || 'No changes made this turn.',
        metadata: {
          type: 'tool_result',
          tool_use_id: itemId,
          turn_id: turnId,
          authoritative: true,
          unified_diff: true,
        },
      })
      break
    }
    case 'turn/plan/updated': {
      const explanation = typeof params?.explanation === 'string' ? params.explanation : ''
      const plan = Array.isArray(params?.plan)
        ? params.plan
            .map((step) => {
              const record = step as Record<string, unknown>
              const label = String(record.step ?? '')
              const status = String(record.status ?? '')
              return status ? `- [${status}] ${label}` : `- ${label}`
            })
            .join('\n')
        : ''
      const content = [explanation, plan].filter(Boolean).join('\n\n')
      if (content) {
        events.push(thinking(content, {
          source: 'codex_plan',
          turn_id: params?.turnId,
        }))
      }
      break
    }
    case 'thread/tokenUsage/updated': {
      const tokenUsage = params?.tokenUsage as Record<string, unknown> | undefined
      const last = tokenUsage?.last as Record<string, unknown> | undefined
      const total = tokenUsage?.total as Record<string, unknown> | undefined
      const usage = last ?? total
      const inputTokens = pickNumber(usage, 'inputTokens', 'input_tokens') ?? 0
      const outputTokens = pickNumber(usage, 'outputTokens', 'output_tokens') ?? 0
      const cachedInputTokens = pickNumber(usage, 'cachedInputTokens', 'cached_input_tokens') ?? 0
      const totalTokens = pickNumber(usage, 'totalTokens', 'total_tokens') ?? (inputTokens + outputTokens + cachedInputTokens)
      const maxTokens = pickNumber(tokenUsage, 'modelContextWindow', 'model_context_window')
      if (totalTokens || inputTokens || outputTokens) {
        events.push({
          type: 'usage',
          content: '',
          metadata: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            context_window: maxTokens && maxTokens > 0 ? Math.min(totalTokens, maxTokens) : totalTokens,
          },
        })
      }
      break
    }
    case 'thread/name/updated': {
      const name = params?.threadName as string | undefined
      if (name) {
        events.push({
          type: 'status',
          content: name,
          metadata: { type: 'thread_name_updated', name },
        })
      }
      break
    }
    case 'thread/compacted':
      events.push({
        type: 'tool_result',
        content: 'Conversation history compacted.',
        metadata: {
          type: 'tool_result',
          tool_use_id: String(params?.turnId ?? 'context-compaction'),
          source: 'codex_context_compaction',
        },
      })
      break
    case 'model/rerouted': {
      const fromModel = pickString(params, 'fromModel')
      const toModel = pickString(params, 'toModel')
      if (fromModel && toModel) {
        events.push(thinking(`Model rerouted from ${fromModel} to ${toModel}.`, {
          source: 'codex_model_rerouted',
          from_model: fromModel,
          to_model: toModel,
          reason: params?.reason,
          turn_id: params?.turnId,
        }))
      }
      break
    }
    case 'model/safetyBuffering/updated': {
      if (params?.showBufferingUi === true) {
        const fasterModel = pickString(params, 'fasterModel')
        const reasons = Array.isArray(params?.reasons) ? params.reasons.map(String).join(', ') : ''
        events.push(thinking(
          `Codex is buffering model output${fasterModel ? `; faster model available: ${fasterModel}` : ''}.`,
          {
            source: 'codex_safety_buffering',
            model: params?.model,
            faster_model: fasterModel,
            reasons,
            turn_id: params?.turnId,
          }
        ))
      }
      break
    }
    case 'warning':
    case 'guardianWarning': {
      const message = params?.message as string | undefined
      if (message) {
        events.push(thinking(message, {
          source: method === 'guardianWarning' ? 'codex_guardian_warning' : 'codex_warning',
          thread_id: params?.threadId,
        }))
      }
      break
    }
    case 'configWarning': {
      const summary = params?.summary as string | undefined
      const details = params?.details as string | null | undefined
      if (summary) {
        events.push(thinking(details ? `${summary}\n${details}` : summary, {
          source: 'codex_config_warning',
          path: params?.path,
          range: params?.range,
        }))
      }
      break
    }
    case 'deprecationNotice': {
      const message = pickString(params, 'message', 'summary')
      if (message) {
        events.push(thinking(message, { source: 'codex_deprecation_notice' }))
      }
      break
    }
    case 'error':
      break
  }

  return events
}

function removeNativeInputReferences(content: string, references: string[]): string {
  let text = content
  for (const reference of references.filter(Boolean)) {
    text = text.split(reference).join('')
  }
  return text.replace(/^[ \t]+|[ \t]+$/gm, '').replace(/^\s*\n/, '').trim()
}

export function buildCodexAppServerInput(content: string, options?: MessageOptions): CodexAppServerUserInput[] {
  const attachmentReferences = (options?.attachments ?? [])
    .map((attachment) => attachment.path ? `@${attachment.path}` : '')
  const skillReferences = (options?.skills ?? [])
    .map((skill) => skill.invocation ?? '')
  const text = removeNativeInputReferences(content, [...attachmentReferences, ...skillReferences])
  const input: CodexAppServerUserInput[] = []
  if (text) input.push({ type: 'text', text, text_elements: [] })

  for (const attachment of options?.attachments ?? []) {
    if (attachment.url) {
      input.push({ type: 'image', url: attachment.url, ...(attachment.detail ? { detail: attachment.detail } : {}) })
    } else if (attachment.path) {
      input.push({ type: 'localImage', path: attachment.path, ...(attachment.detail ? { detail: attachment.detail } : {}) })
    }
  }
  for (const skill of options?.skills ?? []) {
    input.push({ type: 'skill', name: skill.name, path: skill.path })
  }
  return input
}

function boundedAdditionalContext(
  context: MessageOptions['additionalContext']
): MessageOptions['additionalContext'] {
  if (!context) return undefined
  let remaining = 16_000
  const bounded: NonNullable<MessageOptions['additionalContext']> = {}
  for (const [key, entry] of Object.entries(context)) {
    if (remaining <= 0) break
    const value = entry.value.slice(0, remaining)
    bounded[key] = { ...entry, value }
    remaining -= value.length
  }
  return bounded
}

/** Codex service tier used for fast mode (priority processing). */
export const CODEX_FAST_SERVICE_TIER = 'fast'

function codexReasoningLevelToEffort(level: ReasoningLevel | undefined): string | undefined {
  if (!level) return undefined
  return level === 'off' ? 'none' : level
}

function resolvePermissionMode(options: { permissionMode?: PermissionMode; yoloMode?: boolean }): PermissionMode {
  if (options.permissionMode) return options.permissionMode
  return options.yoloMode ? 'yolo' : 'ask'
}

function codexApprovalPolicy(permissionMode: PermissionMode): 'never' | 'on-request' {
  return permissionMode === 'yolo' ? 'never' : 'on-request'
}

function codexSdkSandboxMode(permissionMode: PermissionMode): 'read-only' | 'workspace-write' | 'danger-full-access' {
  if (permissionMode === 'yolo') return 'danger-full-access'
  if (permissionMode === 'workspace') return 'workspace-write'
  return 'read-only'
}

function codexAppServerSandboxPolicy(permissionMode: PermissionMode): { type: 'readOnly' | 'workspaceWrite' | 'dangerFullAccess' } {
  if (permissionMode === 'yolo') return { type: 'dangerFullAccess' }
  if (permissionMode === 'workspace') return { type: 'workspaceWrite' }
  return { type: 'readOnly' }
}

export function buildCodexAppServerThreadParams(options: {
  workingDir: string
  model?: string
  permissionMode?: PermissionMode
  yoloMode?: boolean
  threadId?: string
}): Record<string, unknown> {
  const permissionMode = resolvePermissionMode(options)
  return {
    ...(options.model ? { model: options.model } : {}),
    cwd: options.workingDir,
    approvalPolicy: codexApprovalPolicy(permissionMode),
    sandbox: codexSdkSandboxMode(permissionMode),
    ...(options.threadId ? { threadId: options.threadId, excludeTurns: true } : {}),
  }
}

function codexCollaborationMode(
  planMode: boolean | undefined,
  model: string | undefined
): Record<string, unknown> | undefined {
  if (!planMode) return undefined
  return {
    mode: 'plan',
    settings: {
      model: model ?? 'gpt-5-codex',
      reasoning_effort: null,
      developer_instructions: null,
    },
  }
}

function buildSdkThreadOptions(options: DriverOptions, permissionMode: PermissionMode): CodexThreadOptions {
  return {
    model: options.model,
    workingDirectory: options.workingDir,
    approvalPolicy: codexApprovalPolicy(permissionMode),
    sandboxMode: codexSdkSandboxMode(permissionMode),
  }
}

function normalizeRunError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
}

function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

export function buildCodexEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const nextEnv = process.platform === 'win32' ? augmentWindowsPath(env) : { ...env }
  const homeDir = nextEnv.HOME ?? nextEnv.USERPROFILE ?? homedir()

  if (!nextEnv.HOME && homeDir) nextEnv.HOME = homeDir
  if (process.platform === 'win32' && !nextEnv.USERPROFILE && homeDir) {
    nextEnv.USERPROFILE = homeDir
  }
  if (!nextEnv.CODEX_HOME && homeDir) {
    nextEnv.CODEX_HOME = path.join(homeDir, '.codex')
  }

  return sanitizeEnv(nextEnv)
}

export function buildCodexSdkOptions(env: NodeJS.ProcessEnv = process.env): CodexSdkOptions {
  return {
    env: buildCodexEnvironment(env),
  }
}

/**
 * Quote a single argument for cmd.exe (Windows shell).
 * When spawn uses shell:true on Windows, Node joins args with plain spaces,
 * so arguments with spaces must be explicitly double-quoted.
 *
 * Re-exported from runner/utils for backwards compatibility with existing consumers.
 */
export { winQuote } from './runner/utils'

/**
 * Build the argv array for a `codex exec` invocation.
 * Retained for the SSH/WSL fallback path and existing tests.
 */
export function buildCodexArgs(
  codexThreadId: string | null,
  model: string | undefined,
  content: string,
  yoloModeOrPermissionMode: boolean | PermissionMode = false,
  reasoningLevel?: ReasoningLevel,
  fastMode = false
): string[] {
  const permissionMode = typeof yoloModeOrPermissionMode === 'string'
    ? yoloModeOrPermissionMode
    : yoloModeOrPermissionMode
      ? 'yolo'
      : 'ask'
  const args: string[] = ['exec', '--json']
  if (codexThreadId) args.push('resume')
  if (permissionMode === 'yolo') {
    args.push('--dangerously-bypass-approvals-and-sandbox')
  } else {
    args.push('--sandbox', codexSdkSandboxMode(permissionMode), '--ask-for-approval', 'on-request')
  }
  if (model) args.push('-c', `model=${model}`)
  const effort = codexReasoningLevelToEffort(reasoningLevel)
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`)
  // Fast mode maps to Codex's priority service tier: faster responses that
  // consume usage limits more quickly. Default tier is left untouched when off.
  if (fastMode) args.push('-c', `service_tier=${CODEX_FAST_SERVICE_TIER}`)
  if (codexThreadId) args.push(codexThreadId)
  args.push(content)
  return args
}

class CodexCliDriver extends BaseDriver {
  private codexThreadId: string | null = null
  private streamedItemIds = new Set<string>()
  private announcedItemIds = new Set<string>()
  private completedItemIds = new Set<string>()

  constructor(options: DriverOptions) {
    super(options)
    if (options.initialSessionId) {
      this.codexThreadId = options.initialSessionId
    }
  }

  get driverName(): string { return 'CodexCliDriver' }

  protected beforeSendMessage(): void {
    this.streamedItemIds.clear()
    this.announcedItemIds.clear()
    this.completedItemIds.clear()
  }

  protected buildCommand(
    content: string,
    _runnerType: 'local' | 'wsl' | 'ssh',
    options?: MessageOptions
  ): SpawnCommand {
    return {
      binary: 'codex',
      args: buildCodexArgs(
        this.codexThreadId,
        this.options.model,
        content,
        resolvePermissionMode({
          permissionMode: options?.permissionMode ?? this.options.permissionMode,
          yoloMode: options?.yoloMode ?? this.options.yoloMode,
        }),
        this.options.reasoningLevel,
        options?.fastMode ?? false
      ),
      workDir: this.options.workingDir,
    }
  }

  protected parseEvent(data: Record<string, unknown>): OutputEvent[] {
    const type = data.type as string | undefined
    const events: OutputEvent[] = []

    switch (type) {
      case 'thread.started': {
        const tid = data.thread_id as string | undefined
        if (tid) {
          this.codexThreadId = tid
          this.options.onSessionId?.(tid)
        }
        break
      }

      case 'item.completed': {
        const item = data.item as Record<string, unknown> | undefined
        if (!item) break
        const itemId = item.id as string | undefined
        const itemType = item.type as string | undefined

        if (itemType === 'agent_message') {
          if (!itemId || !this.streamedItemIds.has(itemId)) {
            const text = item.text as string | undefined
            if (text) events.push({ type: 'text', content: text })
          }
        } else if (itemType === 'reasoning') {
          break
        } else if (itemType === 'plan') {
          const text = typeof item.text === 'string' ? item.text : ''
          if (text.trim()) {
            events.push({
              type: 'plan_ready',
              content: text,
              metadata: { ...item, type: 'plan_ready', provider: 'codex' },
            })
          }
        } else if (itemType) {
          if (itemId && this.completedItemIds.has(itemId)) break
          if (itemId) this.completedItemIds.add(itemId)

          const typedItem = item as unknown as ThreadItem
          const alreadyAnnounced = itemId ? this.announcedItemIds.has(itemId) : false
          if (!alreadyAnnounced) {
            const toolCall = makeToolCallEvent(typedItem)
            events.push({ type: 'tool_call', content: toolCall.content, metadata: toolCall.metadata })
          }

          const toolResult = buildToolResult(typedItem)
          if (toolResult) events.push(toolResult)
        }
        break
      }

      case 'item.agentMessage.delta': {
        const delta = data.delta as string | undefined
        if (delta) {
          const itemId = data.item_id as string | undefined
          if (itemId) this.streamedItemIds.add(itemId)
          events.push({ type: 'text', content: delta })
        }
        break
      }

      case 'item.started': {
        const item = data.item as Record<string, unknown> | undefined
        if (!item) break
        const itemId = item.id as string | undefined
        if (itemId && this.announcedItemIds.has(itemId)) break
        const itemType = item.type as string | undefined
        if (itemType && itemType !== 'agent_message' && itemType !== 'reasoning') {
          const toolCall = makeToolCallEvent(item as unknown as ThreadItem)
          events.push({ type: 'tool_call', content: toolCall.content, metadata: toolCall.metadata })
          if (itemId) this.announcedItemIds.add(itemId)
        }
        break
      }

      case 'item.commandExecution.outputDelta':
      case 'item.fileChange.outputDelta': {
        const delta = data.delta as string | undefined
        const itemId = (data.item_id as string | undefined)
          ?? (data.itemId as string | undefined)
          ?? ((data.item as Record<string, unknown> | undefined)?.id as string | undefined)
        if (delta) {
          events.push({
            type: 'tool_result',
            content: delta,
            metadata: {
              ...(data as Record<string, unknown>),
              type: 'tool_result',
              ...(itemId ? { tool_use_id: itemId } : {}),
            },
          })
        }
        break
      }

      case 'turn.completed': {
        const usage = data.usage as { input_tokens?: number; output_tokens?: number } | undefined
        if (usage && (usage.input_tokens || usage.output_tokens)) {
          events.push({
            type: 'usage',
            content: '',
            metadata: {
              input_tokens: usage.input_tokens ?? 0,
              output_tokens: usage.output_tokens ?? 0,
            },
          })
        }
        break
      }

      case 'turn.failed':
      case 'error': {
        const message =
          (data.message as string | undefined) ??
          (data.error as string | undefined) ??
          'Unknown Codex error'
        events.push({ type: 'error', content: String(message) })
        break
      }

      default:
        break
    }

    return events
  }
}

type JsonRpcRequest = {
  id: number | string
  method: string
  params?: unknown
}

type JsonRpcResponse = {
  id: number | string
  result?: unknown
  error?: { message?: string }
}

type JsonRpcNotification = {
  method: string
  params?: unknown
}

class CodexAppServerDriver implements CLIDriver {
  private child: ChildProcessWithoutNullStreams | null = null
  private output: readline.Interface | null = null
  private codexThreadId: string | null = null
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>()
  private pendingPermissionRequests = new Map<string, {
    rpcId: number | string
    kind: 'command' | 'file_change' | 'permissions'
    params: Record<string, unknown>
  }>()
  private pendingQuestionRequests = new Map<string, {
    rpcId: number | string
    kind: 'user_input' | 'mcp_elicitation'
    params: Record<string, unknown>
    questions: Array<{ id: string; question: string; options?: Array<{ label: string; description: string }> }>
  }>()
  private nextRequestId = 1
  private currentTurn: { onEvent: (event: OutputEvent) => void; onDone: (error?: Error) => void } | null = null
  private outstandingTurnCount = 0
  private activeTurnId: string | null = null
  private readyPromise: Promise<void> | null = null
  private state = createCodexStreamState()
  private stopRequested = false

  constructor(private readonly options: DriverOptions) {
    if (options.initialSessionId) {
      this.codexThreadId = options.initialSessionId
    }
  }

  sendMessage(
    content: string,
    onEvent: (event: OutputEvent) => void,
    onDone: (error?: Error) => void,
    options?: MessageOptions
  ): void {
    if (this.currentTurn) {
      console.warn('[CodexAppServerDriver] sendMessage called while a turn chain is already running')
      return
    }

    this.currentTurn = { onEvent, onDone }
    this.outstandingTurnCount = 0
    this.stopRequested = false

    this.startTurn(content, options).catch((error) => {
      this.finishTurn(normalizeRunError(error))
    })
  }

  injectMessage(content: string, options?: MessageOptions): void {
    if (!this.currentTurn) {
      console.warn('[CodexAppServerDriver] injectMessage called without an active turn chain')
      return
    }

    if (!this.activeTurnId || !this.codexThreadId) {
      console.warn('[CodexAppServerDriver] injectMessage called without an active Codex turn')
      return
    }

    this.steerTurn(content, options).catch((error) => {
      this.finishTurn(normalizeRunError(error))
    })
  }

  private async steerTurn(content: string, options?: MessageOptions): Promise<void> {
    if (!this.activeTurnId || !this.codexThreadId) {
      throw new Error('Codex session is missing an active turn')
    }
    await this.sendRequest('turn/steer', {
      threadId: this.codexThreadId,
      input: buildCodexAppServerInput(content, options),
      ...(options?.clientUserMessageId ? { clientUserMessageId: options.clientUserMessageId } : {}),
      ...(boundedAdditionalContext(options?.additionalContext)
        ? { additionalContext: boundedAdditionalContext(options?.additionalContext) }
        : {}),
      expectedTurnId: this.activeTurnId,
    })
  }

  stop(): void {
    this.stopRequested = true
    if (this.activeTurnId && this.codexThreadId) {
      void this.sendRequest('turn/interrupt', {
        threadId: this.codexThreadId,
        turnId: this.activeTurnId,
      }).catch(() => {
        this.cleanupProcess()
      })
      return
    }
    this.cleanupProcess()
  }

  forceStop(): void {
    this.stopRequested = true
    this.cleanupProcess(true)
    this.finishTurn()
  }

  isRunning(): boolean {
    return this.currentTurn !== null
  }

  getPid(): number | null {
    return this.child?.pid ?? null
  }

  async listBackgroundTerminals(): Promise<BackgroundTerminal[]> {
    await this.ensureReady()
    if (!this.codexThreadId) return []
    const terminals: BackgroundTerminal[] = []
    let cursor: string | undefined
    do {
      const response = await this.sendRequest('thread/backgroundTerminals/list', {
        threadId: this.codexThreadId,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      })
      const record = response && typeof response === 'object' ? response as Record<string, unknown> : {}
      const data = Array.isArray(record.data) ? record.data as Array<Record<string, unknown>> : []
      terminals.push(...data.map((terminal) => ({
        itemId: String(terminal.itemId ?? ''),
        processId: String(terminal.processId ?? ''),
        command: String(terminal.command ?? ''),
        cwd: String(terminal.cwd ?? ''),
        osPid: typeof terminal.osPid === 'number' ? terminal.osPid : null,
        cpuPercent: typeof terminal.cpuPercent === 'number' ? terminal.cpuPercent : null,
        rssKb: typeof terminal.rssKb === 'number' ? terminal.rssKb : null,
      })))
      cursor = typeof record.nextCursor === 'string' ? record.nextCursor : undefined
    } while (cursor)
    return terminals
  }

  async terminateBackgroundTerminal(processId: string): Promise<boolean> {
    await this.ensureReady()
    if (!this.codexThreadId) return false
    const response = await this.sendRequest('thread/backgroundTerminals/terminate', {
      threadId: this.codexThreadId,
      processId,
    })
    return Boolean(response && typeof response === 'object' && (response as Record<string, unknown>).terminated)
  }

  async cleanBackgroundTerminals(): Promise<void> {
    await this.ensureReady()
    if (!this.codexThreadId) return
    await this.sendRequest('thread/backgroundTerminals/clean', { threadId: this.codexThreadId })
  }

  sendControlResponse(requestId: string, behavior: 'allow' | 'deny', message?: string): void {
    const permission = this.pendingPermissionRequests.get(requestId)
    if (permission) {
      this.pendingPermissionRequests.delete(requestId)
      this.writeMessage({
        id: permission.rpcId,
        result: this.buildApprovalResponse(permission.kind, permission.params, behavior),
      })
      return
    }

    const question = this.pendingQuestionRequests.get(requestId)
    if (question) {
      this.pendingQuestionRequests.delete(requestId)
      this.writeMessage({
        id: question.rpcId,
        result: question.kind === 'mcp_elicitation'
          ? { action: behavior === 'allow' ? 'accept' : 'decline', content: null, _meta: message ? { message } : null }
          : { answers: {} },
      })
    }
  }

  answerQuestion(requestId: string, answers: Record<string, unknown>, message?: string): void {
    const pending = this.pendingQuestionRequests.get(requestId)
    if (!pending) return
    this.pendingQuestionRequests.delete(requestId)
    this.writeMessage({
      id: pending.rpcId,
      result: pending.kind === 'mcp_elicitation'
        ? this.buildMcpElicitationResponse(pending, answers, message)
        : this.buildUserInputResponse(pending, answers),
    })
  }

  private async startTurn(content: string, options?: MessageOptions): Promise<void> {
    await this.ensureReady()
    if (!this.codexThreadId) {
      throw new Error('Codex session is missing a thread id')
    }

    this.outstandingTurnCount += 1
    try {
      const permissionMode = resolvePermissionMode({
        permissionMode: options?.permissionMode ?? this.options.permissionMode,
        yoloMode: options?.yoloMode ?? this.options.yoloMode,
      })
      const collaborationMode = codexCollaborationMode(options?.planMode, this.options.model)
      const response = await this.sendRequest('turn/start', {
        threadId: this.codexThreadId,
        input: buildCodexAppServerInput(content, options),
        ...(options?.clientUserMessageId ? { clientUserMessageId: options.clientUserMessageId } : {}),
        ...(boundedAdditionalContext(options?.additionalContext)
          ? { additionalContext: boundedAdditionalContext(options?.additionalContext) }
          : {}),
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(codexReasoningLevelToEffort(this.options.reasoningLevel) ? { effort: codexReasoningLevelToEffort(this.options.reasoningLevel) } : {}),
        ...(options?.fastMode ? { serviceTier: CODEX_FAST_SERVICE_TIER } : {}),
        ...(collaborationMode ? { collaborationMode } : {}),
        ...(options?.outputSchema ? { outputSchema: options.outputSchema } : {}),
        ...(this.options.codexReasoningSummary ? { summary: this.options.codexReasoningSummary } : {}),
        ...(this.options.codexPersonality ? { personality: this.options.codexPersonality } : {}),
        approvalPolicy: codexApprovalPolicy(permissionMode),
        sandboxPolicy: codexAppServerSandboxPolicy(permissionMode),
      })
      const record = response && typeof response === 'object' ? response as Record<string, unknown> : {}
      const turn = record.turn && typeof record.turn === 'object' ? record.turn as Record<string, unknown> : undefined
      this.activeTurnId = (turn?.id as string | undefined) ?? this.activeTurnId
    } catch (error) {
      this.outstandingTurnCount = Math.max(0, this.outstandingTurnCount - 1)
      throw error
    }
  }

  private async ensureReady(): Promise<void> {
    if (this.readyPromise) {
      return this.readyPromise
    }

    this.readyPromise = (async () => {
      const env = buildCodexEnvironment()
      this.child = spawn('codex', ['app-server'], {
        cwd: this.options.workingDir,
        env,
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.output = readline.createInterface({ input: this.child.stdout })
      this.output.on('line', (line) => this.handleLine(line))
      this.child.stderr.on('data', (chunk: Buffer) => {
        const message = chunk.toString('utf8').trim()
        if (message) {
          // Codex app-server writes internal diagnostics to stderr. Surfacing
          // those as chat messages is noisy, and tool failures are already
          // represented by command_execution/tool_result events.
          console.warn('[CodexAppServerDriver][stderr]', message)
        }
      })
      this.child.on('error', (error) => this.finishTurn(error))
      this.child.on('exit', (_code, _signal) => {
        if (!this.stopRequested && this.currentTurn) {
          this.finishTurn(new Error('Codex app-server exited unexpectedly'))
        }
      })

      await this.sendRequest('initialize', {
        clientInfo: { name: 'polycode', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      })
      this.writeMessage({ method: 'initialized' })

      const threadMethod = this.codexThreadId ? 'thread/resume' : 'thread/start'
      const result = await this.sendRequest(threadMethod, buildCodexAppServerThreadParams({
        workingDir: this.options.workingDir,
        model: this.options.model,
        permissionMode: this.options.permissionMode,
        yoloMode: this.options.yoloMode,
        ...(this.codexThreadId ? { threadId: this.codexThreadId } : {}),
      }))
      const record = result && typeof result === 'object' ? result as Record<string, unknown> : {}
      const thread = record.thread && typeof record.thread === 'object' ? record.thread as Record<string, unknown> : undefined
      const threadId = (thread?.id as string | undefined) ?? (record.threadId as string | undefined)
      if (!threadId) {
        throw new Error(`${threadMethod} did not return a thread id`)
      }
      this.codexThreadId = threadId
      this.options.onSessionId?.(threadId)
    })()

    try {
      await this.readyPromise
    } catch (error) {
      this.readyPromise = null
      this.cleanupProcess()
      throw error
    }
  }

  private handleLine(line: string): void {
    let parsed: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification
    try {
      parsed = JSON.parse(line) as JsonRpcRequest | JsonRpcResponse | JsonRpcNotification
    } catch {
      return
    }

    if ('id' in parsed && (typeof parsed.id === 'number' || typeof parsed.id === 'string') && !('method' in parsed)) {
      this.handleResponse(parsed)
      return
    }

    if ('method' in parsed && typeof parsed.method === 'string' && !('id' in parsed)) {
      const params = parsed.params && typeof parsed.params === 'object'
        ? parsed.params as Record<string, unknown>
        : undefined
      const isRestoredUsage = parsed.method === 'thread/tokenUsage/updated'
        && (!this.activeTurnId || params?.turnId !== this.activeTurnId)
      const outputEvents = isRestoredUsage ? [] : parseCodexAppServerNotification(parsed.method, params, this.state, (sessionId) => {
        this.codexThreadId = sessionId
        this.options.onSessionId?.(sessionId)
      })
      for (const event of outputEvents) this.emit(event)

      if (parsed.method === 'serverRequest/resolved') {
        this.resolveServerRequest(params?.requestId)
      } else if (parsed.method === 'turn/started') {
        const turn = params?.turn as Record<string, unknown> | undefined
        this.activeTurnId = (turn?.id as string | undefined) ?? this.activeTurnId
      } else if (parsed.method === 'turn/completed') {
        const turn = params?.turn as Record<string, unknown> | undefined
        const status = turn?.status as string | undefined
        this.activeTurnId = null
        if (status === 'failed') {
          const error = turn?.error as Record<string, unknown> | undefined
          this.outstandingTurnCount = 0
          this.finishTurn(new Error(String(error?.message ?? 'Codex turn failed')))
        } else {
          this.outstandingTurnCount = Math.max(0, this.outstandingTurnCount - 1)
          if (this.outstandingTurnCount === 0) {
            this.finishTurn()
          }
        }
      } else if (parsed.method === 'error' && params?.willRetry !== true) {
        const error = params?.error as Record<string, unknown> | undefined
        this.outstandingTurnCount = 0
        this.finishTurn(new Error(String(error?.message ?? 'Codex app-server error')))
      }
      return
    }

    if ('method' in parsed && typeof parsed.method === 'string' && 'id' in parsed && (typeof parsed.id === 'number' || typeof parsed.id === 'string')) {
      const params = parsed.params && typeof parsed.params === 'object'
        ? parsed.params as Record<string, unknown>
        : {}
      this.handleServerRequest(parsed.id, parsed.method, params)
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    if (typeof response.id !== 'number') return
    const pending = this.pending.get(response.id)
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pending.delete(response.id)
    if (response.error?.message) {
      pending.reject(new Error(response.error.message))
      return
    }
    pending.resolve(response.result)
  }

  private handleServerRequest(rpcId: number | string, method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        this.emitPermissionRequest(rpcId, method, params, 'command', 'CommandExecution')
        return
      case 'item/fileChange/requestApproval':
        this.emitPermissionRequest(rpcId, method, params, 'file_change', 'FileChange')
        return
      case 'item/permissions/requestApproval':
        this.emitPermissionRequest(rpcId, method, params, 'permissions', 'RequestPermissions')
        return
      case 'item/tool/requestUserInput':
        this.emitUserInputRequest(rpcId, params)
        return
      case 'mcpServer/elicitation/request':
        this.emitMcpElicitationRequest(rpcId, params)
        return
      case 'item/tool/call': {
        const tool = typeof params.tool === 'string' ? params.tool : 'dynamic tool'
        this.writeMessage({
          id: rpcId,
          result: {
            contentItems: [{ type: 'inputText', text: `Dynamic tool ${tool} is not registered in PolyCode.` }],
            success: false,
          },
        })
        return
      }
      default:
        this.writeMessage({
          id: rpcId,
          error: {
            code: -32601,
            message: `Unsupported Codex app-server request: ${method}`,
          },
        })
    }
  }

  private resolveServerRequest(rpcId: unknown): void {
    const matchesRpcId = (candidate: number | string) => String(candidate) === String(rpcId)
    for (const [requestId, pending] of this.pendingPermissionRequests) {
      if (!matchesRpcId(pending.rpcId)) continue
      this.pendingPermissionRequests.delete(requestId)
      this.emit({
        type: 'status',
        content: '',
        metadata: { type: 'server_request_resolved', requestId },
      })
      return
    }
    for (const [requestId, pending] of this.pendingQuestionRequests) {
      if (!matchesRpcId(pending.rpcId)) continue
      this.pendingQuestionRequests.delete(requestId)
      this.emit({
        type: 'status',
        content: '',
        metadata: { type: 'server_request_resolved', requestId },
      })
      return
    }
  }

  private emitPermissionRequest(
    rpcId: number | string,
    method: string,
    params: Record<string, unknown>,
    kind: 'command' | 'file_change' | 'permissions',
    fallbackToolName: string
  ): void {
    const requestId = `codex:${method}:${String(rpcId)}`
    this.pendingPermissionRequests.set(requestId, { rpcId, kind, params })
    const command = typeof params.command === 'string' ? params.command : undefined
    const reason = typeof params.reason === 'string' ? params.reason : undefined
    const toolName = kind === 'command'
      ? 'Bash'
      : kind === 'file_change'
        ? 'FileChange'
        : 'RequestPermissions'
    this.emit({
      type: 'permission_request',
      content: toolName,
      metadata: {
        type: 'permission_request',
        requestId,
        toolName,
        toolInput: {
          provider: 'codex',
          requestType: kind,
          ...(command ? { command } : {}),
          ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}),
          ...(reason ? { reason } : {}),
          ...(params.permissions ? { permissions: params.permissions } : {}),
          ...(params.grantRoot ? { grantRoot: params.grantRoot } : {}),
          ...(Array.isArray(params.commandActions) ? { commandActions: params.commandActions } : {}),
        },
        toolUseId: typeof params.itemId === 'string' ? params.itemId : String(rpcId),
        codexRequestMethod: method,
        codexApprovalId: params.approvalId,
        fallbackToolName,
      },
    })
  }

  private emitUserInputRequest(rpcId: number | string, params: Record<string, unknown>): void {
    const requestId = `codex:item/tool/requestUserInput:${String(rpcId)}`
    const rawQuestions = Array.isArray(params.questions) ? params.questions as Record<string, unknown>[] : []
    const questions = rawQuestions.map((question, index) => normalizeCodexQuestion(question, index))
    this.pendingQuestionRequests.set(requestId, {
      rpcId,
      kind: 'user_input',
      params,
      questions,
    })
    this.emit({
      type: 'question',
      content: JSON.stringify(questions),
      metadata: {
        type: 'question',
        requestId,
        toolUseId: params.itemId,
        questions,
      },
    })
  }

  private emitMcpElicitationRequest(rpcId: number | string, params: Record<string, unknown>): void {
    const requestId = `codex:mcpServer/elicitation/request:${String(rpcId)}`
    const message = typeof params.message === 'string' ? params.message : 'MCP server requested input'
    const question = {
      id: 'response',
      header: typeof params.serverName === 'string' ? params.serverName : 'MCP',
      question: message,
      options: [
        { label: 'Approve', description: 'Send an empty accepted response.' },
        { label: 'Decline', description: 'Decline this MCP elicitation.' },
      ],
    }
    this.pendingQuestionRequests.set(requestId, {
      rpcId,
      kind: 'mcp_elicitation',
      params,
      questions: [question],
    })
    this.emit({
      type: 'question',
      content: JSON.stringify([question]),
      metadata: {
        type: 'question',
        requestId,
        questions: [question],
        mcpElicitation: params,
      },
    })
  }

  private buildApprovalResponse(
    kind: 'command' | 'file_change' | 'permissions',
    params: Record<string, unknown>,
    behavior: 'allow' | 'deny'
  ): Record<string, unknown> {
    if (kind === 'permissions') {
      return {
        permissions: behavior === 'allow' && params.permissions && typeof params.permissions === 'object'
          ? params.permissions
          : {},
        scope: 'session',
      }
    }
    return {
      decision: behavior === 'allow' ? 'accept' : 'decline',
    }
  }

  private buildUserInputResponse(
    pending: {
      questions: Array<{ id: string; question: string }>
    },
    answers: Record<string, unknown>
  ): Record<string, unknown> {
    const responseAnswers: Record<string, { answers: string[] }> = {}
    for (const question of pending.questions) {
      const raw = answers[question.id] ?? answers[question.question]
      const values = Array.isArray(raw)
        ? raw.map(String).filter(Boolean)
        : typeof raw === 'string' && raw
          ? [raw]
          : []
      responseAnswers[question.id] = { answers: values }
    }
    return { answers: responseAnswers }
  }

  private buildMcpElicitationResponse(
    pending: {
      questions: Array<{ id: string; question: string }>
    },
    answers: Record<string, unknown>,
    message?: string
  ): Record<string, unknown> {
    const first = pending.questions[0]
    const raw = first ? (answers[first.id] ?? answers[first.question]) : undefined
    const values = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : []
    const declined = values.some((value) => value.toLowerCase() === 'decline')
    return {
      action: declined ? 'decline' : 'accept',
      content: null,
      _meta: message ? { message } : null,
    }
  }

  private async sendRequest(method: string, params: unknown, timeoutMs = 20_000): Promise<unknown> {
    const id = this.nextRequestId++
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      this.writeMessage({ id, method, params })
    })
  }

  private writeMessage(message: unknown): void {
    if (!this.child?.stdin.writable) {
      throw new Error('Cannot write to codex app-server stdin')
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private emit(event: OutputEvent): void {
    this.currentTurn?.onEvent(event)
  }

  private finishTurn(error?: Error): void {
    if (!this.currentTurn) return
    const turn = this.currentTurn
    this.currentTurn = null
    this.outstandingTurnCount = 0
    if (error || this.stopRequested) {
      this.cleanupProcess()
    }
    turn.onDone(this.stopRequested ? undefined : error)
    this.stopRequested = false
  }

  private cleanupProcess(force = false): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Codex app-server stopped'))
    }
    this.pending.clear()
    this.pendingPermissionRequests.clear()
    this.pendingQuestionRequests.clear()
    this.output?.close()
    this.output = null
    if (this.child && !this.child.killed) {
      try {
        if (force && process.platform === 'win32' && this.child.pid != null) {
          spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], {
            shell: false,
            stdio: 'ignore',
            windowsHide: true,
          })
        } else {
          this.child.kill(force ? 'SIGKILL' : undefined)
        }
      } catch {
        // ignore
      }
    }
    this.child = null
    this.readyPromise = null
    this.activeTurnId = null
    this.state = createCodexStreamState()
  }
}

export class CodexDriver implements CLIDriver {
  private readonly fallbackDriver: CodexCliDriver | null
  private readonly localDriver: CodexAppServerDriver | null

  constructor(private readonly options: DriverOptions) {
    const useFallback = Boolean(options.ssh || options.wsl)
    this.fallbackDriver = useFallback ? new CodexCliDriver(options) : null
    this.localDriver = useFallback ? null : new CodexAppServerDriver(options)
  }

  sendMessage(
    content: string,
    onEvent: (event: OutputEvent) => void,
    onDone: (error?: Error) => void,
    options?: MessageOptions
  ): void {
    if (this.fallbackDriver) {
      this.fallbackDriver.sendMessage(content, onEvent, onDone, options)
      return
    }
    this.localDriver?.sendMessage(content, onEvent, onDone, options)
  }

  injectMessage(content: string, options?: MessageOptions): void {
    if (this.fallbackDriver) {
      const fallback: CLIDriver = this.fallbackDriver
      fallback.injectMessage?.(content, options)
      return
    }
    this.localDriver?.injectMessage?.(content, options)
  }

  stop(): void {
    if (this.fallbackDriver) {
      this.fallbackDriver.stop()
      return
    }
    this.localDriver?.stop()
  }

  forceStop(): void {
    if (this.fallbackDriver) {
      this.fallbackDriver.forceStop?.()
      return
    }
    this.localDriver?.forceStop()
  }

  isRunning(): boolean {
    return this.fallbackDriver ? this.fallbackDriver.isRunning() : (this.localDriver?.isRunning() ?? false)
  }

  getPid(): number | null {
    return this.fallbackDriver ? this.fallbackDriver.getPid() : (this.localDriver?.getPid() ?? null)
  }

  async listBackgroundTerminals(): Promise<BackgroundTerminal[]> {
    return this.localDriver?.listBackgroundTerminals() ?? []
  }

  async terminateBackgroundTerminal(processId: string): Promise<boolean> {
    return this.localDriver?.terminateBackgroundTerminal(processId) ?? false
  }

  async cleanBackgroundTerminals(): Promise<void> {
    await this.localDriver?.cleanBackgroundTerminals()
  }

  sendControlResponse(requestId: string, behavior: 'allow' | 'deny', message?: string): void {
    if (this.fallbackDriver) {
      this.fallbackDriver.sendControlResponse(requestId, behavior, message)
      return
    }
    this.localDriver?.sendControlResponse(requestId, behavior, message)
  }

  answerQuestion(requestId: string, answers: Record<string, unknown>, message?: string): void {
    if (this.fallbackDriver) {
      const fallback: CLIDriver = this.fallbackDriver
      fallback.answerQuestion?.(requestId, answers, message)
      return
    }
    this.localDriver?.answerQuestion?.(requestId, answers, message)
  }
}
