import type {
  CanUseTool,
  PermissionMode,
  PermissionResult,
  Query,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { CLIDriver, DriverOptions, MessageOptions } from './types'
import { OutputEvent, ReasoningLevel } from '../../shared/types'
import { augmentWindowsPath, expandHomePath, resolveClaudeCodeExecutable } from './runner'

type PendingTurn = {
  onEvent: (event: OutputEvent) => void
  onDone: (error?: Error) => void
}

type PendingPermissionDecision = {
  input: Record<string, unknown>
  resolve: (result: PermissionResult) => void
  reject: (error: Error) => void
}

type PendingQuestionDecision = {
  input: Record<string, unknown>
  originalQuestions: unknown[]
  resolve: (result: PermissionResult) => void
  reject: (error: Error) => void
}

type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type SDKSystemMessage = Extract<SDKMessage, { type: 'system' }>
type SDKRateLimitEvent = Extract<SDKMessage, { type: 'rate_limit_event' }>

function reasoningLevelToClaudeEffort(level?: ReasoningLevel): ClaudeEffort | undefined {
  if (!level || level === 'off') return undefined
  if (level === 'minimal') return 'low'
  return level
}

class AsyncMessageQueue implements AsyncIterable<SDKUserMessage> {
  private values: SDKUserMessage[] = []
  private resolvers: Array<(result: IteratorResult<SDKUserMessage>) => void> = []
  private closed = false

  push(value: SDKUserMessage): void {
    if (this.closed) throw new Error('Claude message queue is closed')
    const resolve = this.resolvers.shift()
    if (resolve) {
      resolve({ value, done: false })
    } else {
      this.values.push(value)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const resolve of this.resolvers.splice(0)) {
      resolve({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.values.shift()
        if (value) return Promise.resolve({ value, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.resolvers.push(resolve)
        })
      },
    }
  }
}

let sdkModulePromise: Promise<typeof import('@anthropic-ai/claude-agent-sdk')> | null = null

async function getSdk() {
  if (!sdkModulePromise) {
    sdkModulePromise = import('@anthropic-ai/claude-agent-sdk')
  }
  return sdkModulePromise
}

export class ClaudeDriver implements CLIDriver {
  private sessionId: string | null = null
  private query: Query | null = null
  private promptQueue: AsyncMessageQueue | null = null
  private streamTask: Promise<void> | null = null
  private currentTurn: PendingTurn | null = null
  private stopped = false
  private specialToolIds = new Set<string>()
  private pendingPermissionDecisions = new Map<string, PendingPermissionDecision>()
  private pendingQuestionDecisions = new Map<string, PendingQuestionDecision>()
  private currentMessageOptions: MessageOptions = {}
  private queuedTurnCount = 0
  private activeBackgroundTaskIds = new Set<string>()

  constructor(private readonly options: DriverOptions) {
    if (options.initialSessionId) {
      this.sessionId = options.initialSessionId
    }
  }

  sendMessage(
    content: string,
    onEvent: (event: OutputEvent) => void,
    onDone: (error?: Error) => void,
    options?: MessageOptions
  ): void {
    if (this.currentTurn) {
      console.warn('[ClaudeDriver] sendMessage called while a turn is already running')
      return
    }

    this.stopped = false
    this.specialToolIds.clear()
    this.queuedTurnCount = 0
    this.activeBackgroundTaskIds.clear()
    this.currentMessageOptions = options ?? {}
    this.currentTurn = { onEvent, onDone }

    this.ensureQuery()
      .then(async () => {
        await this.applyTurnConfiguration()
        this.promptQueue?.push({
          type: 'user',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content,
          },
        })
      })
      .catch((error) => this.finishTurn(error instanceof Error ? error : new Error(String(error))))
  }

  injectMessage(content: string, options?: MessageOptions): void {
    if (!this.currentTurn) {
      console.warn('[ClaudeDriver] injectMessage called without an active turn')
      return
    }

    this.queuedTurnCount += 1
    this.currentMessageOptions = options ?? {}

    this.ensureQuery()
      .then(async () => {
        await this.applyTurnConfiguration()
        this.promptQueue?.push({
          type: 'user',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content,
          },
        })
      })
      .catch((error) => this.finishTurn(error instanceof Error ? error : new Error(String(error))))
  }

  stop(): void {
    this.stopped = true
    this.queuedTurnCount = 0
    this.activeBackgroundTaskIds.clear()

    const pendingError = new Error('Claude turn interrupted')
    for (const pending of this.pendingPermissionDecisions.values()) {
      pending.reject(pendingError)
    }
    this.pendingPermissionDecisions.clear()

    for (const pending of this.pendingQuestionDecisions.values()) {
      pending.reject(pendingError)
    }
    this.pendingQuestionDecisions.clear()

    const query = this.query
    if (!query) {
      this.finishTurn()
      return
    }

    query.interrupt()
      .catch(() => {
        query.close()
      })
      .finally(() => this.finishTurn())
  }

  isRunning(): boolean {
    return this.currentTurn !== null
  }

  getPid(): number | null {
    return null
  }

  sendControlResponse(requestId: string, behavior: 'allow' | 'deny', message?: string): void {
    const permission = this.pendingPermissionDecisions.get(requestId)
    if (permission) {
      this.pendingPermissionDecisions.delete(requestId)
      if (behavior === 'allow') {
        permission.resolve({ behavior: 'allow', updatedInput: permission.input })
      } else {
        permission.resolve({ behavior: 'deny', message: message ?? 'User denied permission' })
      }
      return
    }

    const question = this.pendingQuestionDecisions.get(requestId)
    if (question) {
      this.pendingQuestionDecisions.delete(requestId)
      if (behavior === 'allow') {
        question.resolve({
          behavior: 'allow',
          updatedInput: {
            ...question.input,
            questions: question.originalQuestions,
            answers: {},
          },
        })
      } else {
        question.resolve({ behavior: 'deny', message: message ?? 'User denied input request' })
      }
    }
  }

  answerQuestion(
    requestId: string,
    answers: Record<string, unknown>,
    message?: string
  ): void {
    const pending = this.pendingQuestionDecisions.get(requestId)
    if (!pending) return
    this.pendingQuestionDecisions.delete(requestId)
    pending.resolve({
      behavior: 'allow',
      updatedInput: {
        ...pending.input,
        questions: pending.originalQuestions,
        answers,
        ...(message ? { message } : {}),
      },
    })
  }

  private async ensureQuery(): Promise<void> {
    if (this.query) return

    const sdk = await getSdk()
    const env = process.platform === 'win32' ? augmentWindowsPath(process.env) : process.env
    const workingDir = expandHomePath(this.options.workingDir)
    const effort = reasoningLevelToClaudeEffort(this.options.reasoningLevel)
    const queryOptions = {
      model: this.options.model,
      effort,
      cwd: workingDir,
      pathToClaudeCodeExecutable: resolveClaudeCodeExecutable(env),
      env,
      resume: this.sessionId ?? undefined,
      permissionMode: this.resolvePermissionMode(this.currentMessageOptions),
      allowDangerouslySkipPermissions: this.resolvePermissionMode(this.currentMessageOptions) === 'bypassPermissions',
      additionalDirectories: workingDir ? [workingDir] : undefined,
      canUseTool: this.handleCanUseTool,
      // The SDK accepts these setting sources even though older typings omit them.
      // Without them, user/project skills and plugins are not surfaced consistently.
      settingSources: ['user', 'project', 'local'],
    } as Parameters<typeof sdk.query>[0]['options'] & { settingSources: string[]; effort?: ClaudeEffort }
    this.promptQueue = new AsyncMessageQueue()
    this.query = sdk.query({
      prompt: this.promptQueue,
      options: queryOptions,
    })

    this.streamTask = this.consumeStream().catch((error) => {
      const turnError = error instanceof Error ? error : new Error(String(error))
      console.error('[ClaudeDriver] stream failed', {
        threadId: this.options.threadId,
        sessionId: this.sessionId,
        message: turnError.message,
        stack: turnError.stack,
      })
      this.finishTurn(turnError)
    })
  }

  private async applyTurnConfiguration(): Promise<void> {
    if (!this.query) return
    const nextMode = this.resolvePermissionMode(this.currentMessageOptions)
    await this.query.setPermissionMode(nextMode)
    if (this.options.model) {
      await this.query.setModel(this.options.model)
    }
    await this.applyFastMode(this.currentMessageOptions.fastMode ?? false)
  }

  /**
   * Toggle Claude Code's fast mode for the upcoming turn. Fast mode is exposed
   * through the CLI's `fastMode` user setting; the SDK applies runtime setting
   * changes via the `apply_flag_settings` control request (the same mechanism
   * the `/fast` slash command uses). The typed Query interface omits this
   * method, so we access it dynamically. Unsupported models/accounts ignore it.
   */
  private async applyFastMode(enabled: boolean): Promise<void> {
    const query = this.query as unknown as {
      applyFlagSettings?: (settings: Record<string, unknown>) => Promise<void>
    }
    if (typeof query.applyFlagSettings !== 'function') return
    try {
      await query.applyFlagSettings({ fastMode: enabled })
    } catch (error) {
      console.warn('[ClaudeDriver] failed to apply fast mode setting', error)
    }
  }

  private resolvePermissionMode(options?: MessageOptions): PermissionMode {
    if (options?.planMode) return 'plan'
    if (this.isYoloEnabled(options)) return 'bypassPermissions'
    return 'default'
  }

  private isYoloEnabled(options?: MessageOptions): boolean {
    return options?.yoloMode ?? this.options.yoloMode ?? false
  }

  private readonly handleCanUseTool: CanUseTool = async (toolName, input, callbackOptions) => {
    if (toolName === 'ExitPlanMode') {
      const plan = typeof input.plan === 'string' ? input.plan : ''
      const toolUseId = callbackOptions.toolUseID ?? ''
      if (toolUseId) this.specialToolIds.add(toolUseId)
      this.emit({
        type: 'plan_ready',
        content: plan,
        metadata: {
          type: 'plan_ready',
          id: toolUseId,
          name: toolName,
          input,
        },
      })
      return {
        behavior: 'deny',
        message: 'Plan captured. Wait for user approval before executing.',
      }
    }

    if (toolName === 'AskUserQuestion') {
      const requestId = `question:${callbackOptions.toolUseID}`
      const toolUseId = callbackOptions.toolUseID ?? ''
      if (toolUseId) this.specialToolIds.add(toolUseId)
      this.emit({
        type: 'question',
        content: JSON.stringify(Array.isArray(input.questions) ? input.questions : []),
        metadata: {
          type: 'question',
          requestId,
          toolUseId,
          questions: input.questions,
        },
      })

      return await new Promise<PermissionResult>((resolve, reject) => {
        this.pendingQuestionDecisions.set(requestId, {
          input,
          originalQuestions: Array.isArray(input.questions) ? input.questions : [],
          resolve,
          reject,
        })
        callbackOptions.signal.addEventListener('abort', () => {
          this.pendingQuestionDecisions.delete(requestId)
          reject(new Error('Question request aborted'))
        }, { once: true })
      })
    }

    if (this.isYoloEnabled(this.currentMessageOptions)) {
      return { behavior: 'allow', updatedInput: input }
    }

    const requestId = `permission:${callbackOptions.toolUseID}`
    this.emit({
      type: 'permission_request',
      content: toolName,
      metadata: {
        type: 'permission_request',
        requestId,
        toolName,
        toolInput: input,
        toolUseId: callbackOptions.toolUseID,
      },
    })

    return await new Promise<PermissionResult>((resolve, reject) => {
      this.pendingPermissionDecisions.set(requestId, { input, resolve, reject })
      callbackOptions.signal.addEventListener('abort', () => {
        this.pendingPermissionDecisions.delete(requestId)
        reject(new Error('Permission request aborted'))
      }, { once: true })
    })
  }

  private async consumeStream(): Promise<void> {
    const query = this.query
    if (!query) return

    try {
      for await (const message of query) {
        const sessionId = this.extractSessionId(message)
        if (sessionId && sessionId !== this.sessionId) {
          this.sessionId = sessionId
          this.options.onSessionId?.(sessionId)
        }

        for (const event of this.parseMessage(message)) {
          this.emit(event)
        }

        if (message.type === 'result') {
          const error = this.resultError(message)
          if (error) {
            this.finishTurn(error)
          } else {
            this.handleSuccessfulTurnBoundary()
          }
        } else if (this.isIdleStateMessage(message) && this.currentTurn) {
          // Claude Code's session_state_changed:idle is emitted after held-back
          // background/subagent output is flushed. Treat it as a completion
          // fallback for SDK/CLI paths that do not produce a result frame.
          this.handleSuccessfulTurnBoundary()
        }
      }
    } finally {
      if (this.query === query) {
        this.promptQueue?.close()
        this.promptQueue = null
        this.query = null
        this.streamTask = null
      }
    }

    if (this.currentTurn) {
      this.finishTurn(
        this.stopped
          ? undefined
          : new Error('Claude stream ended before a result was received')
      )
    }
  }

  private parseMessage(message: SDKMessage): OutputEvent[] {
    const events: OutputEvent[] = []

    switch (message.type) {
      case 'assistant':
        this.collectAssistantMessage(message, events)
        break

      case 'user':
        this.collectUserMessage(message, events)
        break

      case 'result':
        this.collectResultMessage(message, events)
        break

      case 'system':
        this.collectSystemMessage(message, events)
        break

      case 'rate_limit_event':
        this.collectRateLimitMessage(message, events)
        break
    }

    return events
  }

  private collectAssistantMessage(message: SDKAssistantMessage, events: OutputEvent[]): void {
    for (const block of message.message.content) {
      if (block.type === 'thinking') {
        if (block.thinking) {
          events.push({ type: 'thinking', content: block.thinking, metadata: { type: 'thinking' } })
        }
        continue
      }

      if (block.type === 'text') {
        if (block.text) {
          events.push({ type: 'text', content: block.text })
        }
        continue
      }

      if (block.type === 'tool_use') {
        const toolName = block.name ?? 'unknown'
        const toolId = block.id ?? ''
        // Special tools are handled via dedicated events (question, plan_ready, permission_request)
        // and should never appear as tool_call bubbles. Filter by both ID (set by handleCanUseTool)
        // and name (guards against race where stream message arrives before callback fires).
        const isSpecialByName = toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode'
        if (!this.specialToolIds.has(toolId) && !isSpecialByName) {
          events.push({
            type: 'tool_call',
            content: toolName,
            metadata: {
              type: 'tool_call',
              id: toolId,
              name: toolName,
              input: block.input as Record<string, unknown>,
            },
          })
        }
      }
    }
  }

  private collectUserMessage(message: SDKUserMessage, events: OutputEvent[]): void {
    const blocks = Array.isArray(message.message.content) ? message.message.content : []
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue
      if (this.specialToolIds.has(block.tool_use_id ?? '')) continue

      let content = ''
      if (typeof block.content === 'string') {
        content = block.content
      } else if (Array.isArray(block.content)) {
        content = block.content
          .map((item) => ('text' in item ? String(item.text ?? '') : ''))
          .join('')
      } else if (block.content != null) {
        content = JSON.stringify(block.content)
      }

      events.push({
        type: 'tool_result',
        content,
        metadata: {
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          is_error: block.is_error === true,
        },
      })
    }
  }

  private collectResultMessage(message: SDKResultMessage, events: OutputEvent[]): void {
    if (message.usage) {
      const inputTokens = message.usage.input_tokens ?? 0
      const outputTokens = message.usage.output_tokens ?? 0
      const cacheCreationInputTokens = message.usage.cache_creation_input_tokens ?? 0
      const cacheReadInputTokens = message.usage.cache_read_input_tokens ?? 0
      const usedContextWindow = inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens
      const maxContextWindow = Math.max(
        0,
        ...Object.values(message.modelUsage ?? {}).map((usage) => usage?.contextWindow ?? 0)
      )
      const contextWindow =
        maxContextWindow > 0 ? Math.min(usedContextWindow, maxContextWindow) : usedContextWindow

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
    }

    if (message.subtype !== 'success') {
      events.push({
        type: 'error',
        content: (message.errors && message.errors[0]) || 'Claude execution failed',
      })
    }
  }

  private collectSystemMessage(message: SDKSystemMessage, events: OutputEvent[]): void {
    switch (message.subtype) {
      case 'task_started':
        this.activeBackgroundTaskIds.add(message.task_id)
        if (message.skip_transcript) return
        events.push({
          type: 'thinking',
          content: this.formatTaskStarted(message),
          metadata: {
            type: 'thinking',
            source: 'claude_task',
            task_event: 'started',
            task_id: message.task_id,
            tool_use_id: message.tool_use_id,
            task_type: message.task_type,
            subagent_type: message.subagent_type,
          },
        })
        break

      case 'task_progress':
        events.push({
          type: 'thinking',
          content: this.formatTaskProgress(message),
          metadata: {
            type: 'thinking',
            source: 'claude_task',
            task_event: 'progress',
            task_id: message.task_id,
            tool_use_id: message.tool_use_id,
            subagent_type: message.subagent_type,
            usage: message.usage,
            last_tool_name: message.last_tool_name,
          },
        })
        break

      case 'task_notification':
        this.activeBackgroundTaskIds.delete(message.task_id)
        if (message.skip_transcript) return
        events.push({
          type: 'thinking',
          content: this.formatTaskNotification(message),
          metadata: {
            type: 'thinking',
            source: 'claude_task',
            task_event: 'notification',
            task_id: message.task_id,
            tool_use_id: message.tool_use_id,
            status: message.status,
            usage: message.usage,
          },
        })
        break

      case 'task_updated':
        if (
          message.patch.status === 'completed' ||
          message.patch.status === 'failed' ||
          message.patch.status === 'killed'
        ) {
          this.activeBackgroundTaskIds.delete(message.task_id)
        }
        break

      case 'status':
        if (message.status === 'compacting') {
          events.push({
            type: 'thinking',
            content: 'Compacting conversation context...',
            metadata: { type: 'thinking', source: 'claude_status', status: message.status },
          })
        }
        break

      case 'local_command_output':
        if (message.content) {
          events.push({ type: 'text', content: message.content })
        }
        break

      case 'api_retry':
        events.push({
          type: 'thinking',
          content: `Claude API retry ${message.attempt}/${message.max_retries}: ${message.error}`,
          metadata: {
            type: 'thinking',
            source: 'claude_api_retry',
            attempt: message.attempt,
            max_retries: message.max_retries,
            retry_delay_ms: message.retry_delay_ms,
            error_status: message.error_status,
            error: message.error,
          },
        })
        break
    }
  }

  private collectRateLimitMessage(message: SDKRateLimitEvent, events: OutputEvent[]): void {
    const info = message.rate_limit_info
    events.push({
      type: 'rate_limit',
      content: '',
      metadata: {
        status: info.status === 'rejected' ? 'blocked' : info.status,
        resetsAt: info.resetsAt,
        rateLimitType: info.rateLimitType,
        utilization: info.utilization,
        surpassedThreshold: info.surpassedThreshold,
        isUsingOverage: info.isUsingOverage ?? info.overageInUse,
        overageStatus: info.overageStatus === 'rejected' ? 'blocked' : info.overageStatus,
        overageDisabledReason: info.overageDisabledReason,
      },
    })
  }

  private extractSessionId(message: SDKMessage): string | null {
    if ('session_id' in message && typeof message.session_id === 'string') {
      return message.session_id
    }
    return null
  }

  private resultError(message: SDKResultMessage): Error | undefined {
    if (message.subtype === 'success') return undefined
    return new Error((message.errors && message.errors[0]) || 'Claude execution failed')
  }

  private isIdleStateMessage(message: SDKMessage): boolean {
    return message.type === 'system' &&
      message.subtype === 'session_state_changed' &&
      message.state === 'idle'
  }

  private handleSuccessfulTurnBoundary(): void {
    if (this.queuedTurnCount > 0) {
      this.queuedTurnCount -= 1
      return
    }

    if (this.activeBackgroundTaskIds.size > 0) {
      return
    }

    this.finishTurn()
  }

  private formatTaskStarted(message: Extract<SDKSystemMessage, { subtype: 'task_started' }>): string {
    const label = message.subagent_type ?? message.task_type ?? 'subagent'
    return `**Subagent started:** ${label}${message.description ? `\n${message.description}` : ''}`
  }

  private formatTaskProgress(message: Extract<SDKSystemMessage, { subtype: 'task_progress' }>): string {
    const lines = [
      `**Subagent update:** ${message.summary || message.description}`,
    ]
    const details: string[] = []
    if (message.last_tool_name) details.push(`tool: ${message.last_tool_name}`)
    if (message.usage?.tool_uses != null) details.push(`tool uses: ${message.usage.tool_uses}`)
    if (message.usage?.total_tokens != null) details.push(`tokens: ${message.usage.total_tokens}`)
    if (details.length > 0) lines.push(details.join(', '))
    return lines.join('\n')
  }

  private formatTaskNotification(message: Extract<SDKSystemMessage, { subtype: 'task_notification' }>): string {
    const status = message.status === 'completed' ? 'completed' : message.status
    return `**Subagent ${status}:** ${message.summary || message.task_id}`
  }

  private emit(event: OutputEvent): void {
    this.currentTurn?.onEvent(event)
  }

  private finishTurn(error?: Error): void {
    if (!this.currentTurn) return
    const turn = this.currentTurn
    this.currentTurn = null
    try {
      turn.onDone(error)
    } catch (callbackError) {
      console.error('[ClaudeDriver] onDone callback failed', {
        threadId: this.options.threadId,
        sessionId: this.sessionId,
        error: callbackError,
      })
    }
  }
}
