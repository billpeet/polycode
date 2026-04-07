import type {
  Codex as CodexSdk,
  ThreadEvent,
  ThreadItem,
  ThreadOptions as CodexThreadOptions,
} from '@openai/codex-sdk'
import { DriverOptions, MessageOptions, CLIDriver } from './types'
import { OutputEvent } from '../../shared/types'
import { SpawnCommand } from './runner/types'
import { BaseDriver } from './base'

type ToolCallPayload = { content: string; metadata: Record<string, unknown> }

type CodexStreamState = {
  streamedItemIds: Set<string>
  announcedItemIds: Set<string>
  completedItemIds: Set<string>
  lastAgentTextById: Map<string, string>
}

/**
 * Given a raw command string from a Codex command_execution item, return a
 * display-friendly name and the inner command to show in the UI.
 *
 * Commands are typically wrapped as:  /bin/bash -lc "actual command here"
 * We strip the wrapper so the UI shows "Bash" + the inner command, mirroring
 * how Claude Code's Bash tool is displayed.
 */
export function parseBashCommand(raw: string): { name: string; innerCmd: string } {
  const m = raw.match(/^(?:\/bin\/bash|bash)\s+-lc\s+([\s\S]+)$/)
  if (!m) return { name: 'Shell', innerCmd: raw }
  const arg = m[1].trim()
  const innerCmd =
    arg.length >= 2 &&
    ((arg[0] === '"' && arg[arg.length - 1] === '"') ||
      (arg[0] === "'" && arg[arg.length - 1] === "'"))
      ? arg.slice(1, -1)
      : arg
  return { name: 'Bash', innerCmd }
}

/** Build a tool_call event for a Codex item. */
function makeToolCallEvent(item: ThreadItem): ToolCallPayload {
  if (item.type === 'command_execution') {
    const { name, innerCmd } = parseBashCommand(item.command)
    const label = innerCmd.split('\n')[0].slice(0, 120) || name
    return {
      content: label,
      metadata: { ...item, type: 'tool_call', name, input: { command: innerCmd } },
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
    return {
      content: item.tool,
      metadata: {
        ...item,
        type: 'tool_call',
        name: item.tool,
        input: { server: item.server, arguments: item.arguments },
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

function buildToolResult(item: ThreadItem): OutputEvent | null {
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
    case 'file_change':
    case 'web_search':
    case 'todo_list':
      return {
        type: 'tool_result',
        content: '',
        metadata: {
          ...item,
          type: 'tool_result',
          tool_use_id: item.id,
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

export function createCodexStreamState(): CodexStreamState {
  return {
    streamedItemIds: new Set<string>(),
    announcedItemIds: new Set<string>(),
    completedItemIds: new Set<string>(),
    lastAgentTextById: new Map<string, string>(),
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

    case 'turn.completed':
      if (event.usage && (event.usage.input_tokens || event.usage.output_tokens)) {
        events.push({
          type: 'usage',
          content: '',
          metadata: {
            input_tokens: event.usage.input_tokens ?? 0,
            output_tokens: event.usage.output_tokens ?? 0,
          },
        })
      }
      break

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

function buildSdkThreadOptions(options: DriverOptions, yoloMode: boolean): CodexThreadOptions {
  return {
    model: options.model,
    workingDirectory: options.workingDir,
    approvalPolicy: 'never',
    sandboxMode: yoloMode ? 'danger-full-access' : 'workspace-write',
  }
}

function normalizeRunError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
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
  yoloMode = false
): string[] {
  const args: string[] = ['exec', '--json']
  if (codexThreadId) args.push('resume')
  args.push(yoloMode ? '--dangerously-bypass-approvals-and-sandbox' : '--full-auto')
  if (model) args.push('-c', `model=${model}`)
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
        options?.yoloMode ?? this.options.yoloMode ?? false
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
        if (delta) {
          events.push({
            type: 'tool_result',
            content: delta,
            metadata: data as Record<string, unknown>,
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

export class CodexDriver implements CLIDriver {
  private readonly fallbackDriver: CodexCliDriver | null
  private readonly sdkPromise: Promise<CodexSdk> | null
  private codexThreadId: string | null = null
  private running = false
  private abortController: AbortController | null = null
  private stopRequested = false
  private streamState = createCodexStreamState()

  constructor(private readonly options: DriverOptions) {
    if (options.initialSessionId) {
      this.codexThreadId = options.initialSessionId
    }

    const useFallback = Boolean(options.ssh || options.wsl)
    this.fallbackDriver = useFallback ? new CodexCliDriver(options) : null
    this.sdkPromise = useFallback ? null : loadCodexSdk()
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

    if (!this.sdkPromise) {
      onDone(new Error('Codex SDK is not available'))
      return
    }

    if (this.running) {
      console.warn('[CodexDriver] sendMessage called while a turn is already running — ignoring')
      return
    }

    this.running = true
    this.stopRequested = false
    this.streamState = createCodexStreamState()
    this.abortController = new AbortController()

    const threadOptions = buildSdkThreadOptions(
      this.options,
      options?.yoloMode ?? this.options.yoloMode ?? false
    )

    void (async () => {
      try {
        const sdk = await this.sdkPromise
        const thread = this.codexThreadId
          ? sdk.resumeThread(this.codexThreadId, threadOptions)
          : sdk.startThread(threadOptions)
        const streamed = await thread.runStreamed(content, { signal: this.abortController?.signal })
        for await (const event of streamed.events) {
          if (event.type === 'thread.started' && event.thread_id && event.thread_id !== this.codexThreadId) {
            this.codexThreadId = event.thread_id
          }
          const outputEvents = parseCodexSdkEvent(event, this.streamState, (sessionId) => {
            this.codexThreadId = sessionId
            this.options.onSessionId?.(sessionId)
          })
          for (const outputEvent of outputEvents) onEvent(outputEvent)
        }
        onDone()
      } catch (error) {
        const normalized = normalizeRunError(error)
        const isAbort = normalized.name === 'AbortError' || /aborted|abort/i.test(normalized.message)
        onDone(this.stopRequested && isAbort ? undefined : normalized)
      } finally {
        this.abortController = null
        this.running = false
        this.stopRequested = false
      }
    })()
  }

  stop(): void {
    if (this.fallbackDriver) {
      this.fallbackDriver.stop()
      return
    }

    if (this.abortController) {
      this.stopRequested = true
      this.abortController.abort()
    }
  }

  isRunning(): boolean {
    return this.fallbackDriver ? this.fallbackDriver.isRunning() : this.running
  }

  getPid(): number | null {
    return this.fallbackDriver ? this.fallbackDriver.getPid() : null
  }

  sendControlResponse(requestId: string, behavior: 'allow' | 'deny', message?: string): void {
    this.fallbackDriver?.sendControlResponse(requestId, behavior, message)
  }

  answerQuestion(requestId: string, answers: Record<string, unknown>, message?: string): void {
    this.fallbackDriver?.answerQuestion?.(requestId, answers, message)
  }
}

async function loadCodexSdk(): Promise<CodexSdk> {
  const mod = await import('@openai/codex-sdk')
  return new mod.Codex()
}
