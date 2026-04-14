import type {
  Codex as CodexSdk,
  CodexOptions as CodexSdkOptions,
  ThreadEvent,
  ThreadItem,
  ThreadOptions as CodexThreadOptions,
} from '@openai/codex-sdk'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { DriverOptions, MessageOptions, CLIDriver } from './types'
import { OutputEvent } from '../../shared/types'
import { SpawnCommand } from './runner/types'
import { BaseDriver } from './base'
import { augmentWindowsPath } from './runner'
import { homedir } from 'os'
import path from 'path'
import readline from 'readline'

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

function normalizeAppServerItem(raw: Record<string, unknown>): ThreadItem | null {
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
        text: String(raw.text ?? ''),
      }
    case 'commandExecution':
      return {
        id,
        type: 'command_execution',
        command: String(raw.command ?? ''),
        aggregated_output: String(raw.aggregatedOutput ?? ''),
        status: ((raw.status as string | undefined) ?? 'in_progress') as 'in_progress' | 'completed' | 'failed',
        ...(typeof raw.exitCode === 'number' ? { exit_code: raw.exitCode } : {}),
      }
    case 'fileChange':
      return {
        id,
        type: 'file_change',
        changes: Array.isArray(raw.changes) ? raw.changes as Array<{ path: string; kind: 'add' | 'delete' | 'update' }> : [],
        status: ((raw.status as string | undefined) ?? 'completed') as 'completed' | 'failed',
      }
    case 'mcpToolCall':
      return {
        id,
        type: 'mcp_tool_call',
        server: String(raw.server ?? ''),
        tool: String(raw.tool ?? ''),
        arguments: raw.arguments,
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
    case 'error':
      return {
        id,
        type: 'error',
        message: String(raw.message ?? 'Unknown Codex error'),
      }
    default:
      return {
        id,
        type: 'error',
        message: `Unsupported Codex item type: ${itemType}`,
      }
  }
}

function parseCodexAppServerNotification(
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
    case 'turn/completed': {
      const turn = params?.turn as Record<string, unknown> | undefined
      const usage = (turn?.usage as Record<string, unknown> | undefined) ?? (params?.usage as Record<string, unknown> | undefined)
      const inputTokens = Number(usage?.inputTokens ?? usage?.input_tokens ?? 0)
      const outputTokens = Number(usage?.outputTokens ?? usage?.output_tokens ?? 0)
      if (inputTokens || outputTokens) {
        events.push({
          type: 'usage',
          content: '',
          metadata: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          },
        })
      }
      if ((turn?.status as string | undefined) === 'failed') {
        const error = turn?.error as Record<string, unknown> | undefined
        events.push({ type: 'error', content: String(error?.message ?? 'Unknown Codex error') })
      }
      break
    }
    case 'error': {
      const error = params?.error as Record<string, unknown> | undefined
      events.push({ type: 'error', content: String(error?.message ?? 'Unknown Codex error') })
      break
    }
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

function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([, value]): value is string => typeof value === 'string')
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
  id: number
  method: string
  params?: unknown
}

type JsonRpcResponse = {
  id: number
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

    this.startTurn(content, options).catch((error) => {
      this.finishTurn(normalizeRunError(error))
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

  isRunning(): boolean {
    return this.currentTurn !== null
  }

  getPid(): number | null {
    return this.child?.pid ?? null
  }

  sendControlResponse(_requestId: string, _behavior: 'allow' | 'deny', _message?: string): void {}

  private async startTurn(content: string, options?: MessageOptions): Promise<void> {
    await this.ensureReady()
    if (!this.codexThreadId) {
      throw new Error('Codex session is missing a thread id')
    }

    this.outstandingTurnCount += 1
    try {
      const response = await this.sendRequest('turn/start', {
        threadId: this.codexThreadId,
        input: [{ type: 'text', text: content, text_elements: [] }],
        ...(this.options.model ? { model: this.options.model } : {}),
        sandbox: (options?.yoloMode ?? this.options.yoloMode ?? false) ? 'danger-full-access' : 'workspace-write',
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
          this.emit({ type: 'error', content: message })
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
      const result = await this.sendRequest(threadMethod, {
        model: this.options.model,
        cwd: this.options.workingDir,
        approvalPolicy: 'never',
        sandbox: this.options.yoloMode ? 'danger-full-access' : 'workspace-write',
        ...(this.codexThreadId ? { threadId: this.codexThreadId } : {}),
      })
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

    if ('id' in parsed && typeof parsed.id === 'number' && !('method' in parsed)) {
      this.handleResponse(parsed)
      return
    }

    if ('method' in parsed && typeof parsed.method === 'string' && !('id' in parsed)) {
      const params = parsed.params && typeof parsed.params === 'object'
        ? parsed.params as Record<string, unknown>
        : undefined
      const outputEvents = parseCodexAppServerNotification(parsed.method, params, this.state, (sessionId) => {
        this.codexThreadId = sessionId
        this.options.onSessionId?.(sessionId)
      })
      for (const event of outputEvents) this.emit(event)

      if (parsed.method === 'turn/started') {
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
      } else if (parsed.method === 'error') {
        const error = params?.error as Record<string, unknown> | undefined
        this.outstandingTurnCount = 0
        this.finishTurn(new Error(String(error?.message ?? 'Codex app-server error')))
      }
      return
    }

    if ('method' in parsed && typeof parsed.method === 'string' && 'id' in parsed && typeof parsed.id === 'number') {
      // We run Codex in never-approval mode, so reject unexpected server requests.
      this.writeMessage({
        id: parsed.id,
        error: {
          code: -32601,
          message: `Unsupported server request: ${parsed.method}`,
        },
      })
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
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

  private cleanupProcess(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Codex app-server stopped'))
    }
    this.pending.clear()
    this.output?.close()
    this.output = null
    if (this.child && !this.child.killed) {
      try {
        this.child.kill()
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
      this.fallbackDriver.injectMessage?.(content, options)
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

  isRunning(): boolean {
    return this.fallbackDriver ? this.fallbackDriver.isRunning() : (this.localDriver?.isRunning() ?? false)
  }

  getPid(): number | null {
    return this.fallbackDriver ? this.fallbackDriver.getPid() : (this.localDriver?.getPid() ?? null)
  }

  sendControlResponse(requestId: string, behavior: 'allow' | 'deny', message?: string): void {
    this.fallbackDriver?.sendControlResponse(requestId, behavior, message)
  }

  answerQuestion(requestId: string, answers: Record<string, unknown>, message?: string): void {
    this.fallbackDriver?.answerQuestion?.(requestId, answers, message)
  }
}
