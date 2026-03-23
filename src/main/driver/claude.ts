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
import { OutputEvent } from '../../shared/types'
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
  originalQuestions: unknown[]
  resolve: (result: PermissionResult) => void
  reject: (error: Error) => void
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
    this.currentMessageOptions = options ?? {}
    this.currentTurn = { onEvent, onDone }

    this.ensureQuery()
      .then(async () => {
        await this.applyTurnConfiguration()
        this.promptQueue?.push({
          type: 'user',
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
    const queryOptions = {
      model: this.options.model,
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
    } as Parameters<typeof sdk.query>[0]['options'] & { settingSources: string[] }
    this.promptQueue = new AsyncMessageQueue()
    this.query = sdk.query({
      prompt: this.promptQueue,
      options: queryOptions,
    })

    this.streamTask = this.consumeStream().catch((error) => {
      this.finishTurn(error instanceof Error ? error : new Error(String(error)))
    })
  }

  private async applyTurnConfiguration(): Promise<void> {
    if (!this.query) return
    const nextMode = this.resolvePermissionMode(this.currentMessageOptions)
    await this.query.setPermissionMode(nextMode)
    if (this.options.model) {
      await this.query.setModel(this.options.model)
    }
  }

  private resolvePermissionMode(options?: MessageOptions): PermissionMode {
    if (options?.planMode) return 'plan'
    if (options?.yoloMode ?? this.options.yoloMode ?? false) return 'bypassPermissions'
    return 'default'
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

    if (this.resolvePermissionMode(this.currentMessageOptions) === 'bypassPermissions') {
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
        this.finishTurn(error)
      }
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

  private collectUserMessage(message: SDKMessage, events: OutputEvent[]): void {
    if (message.type !== 'user') return
    for (const block of message.message.content) {
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
    if (message.usage && (message.usage.input_tokens || message.usage.output_tokens)) {
      events.push({
        type: 'usage',
        content: '',
        metadata: {
          input_tokens: message.usage.input_tokens ?? 0,
          output_tokens: message.usage.output_tokens ?? 0,
        },
      })
    }

    if (message.subtype !== 'success') {
      events.push({
        type: 'error',
        content: (message.errors && message.errors[0]) || 'Claude execution failed',
      })
    }
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

  private emit(event: OutputEvent): void {
    this.currentTurn?.onEvent(event)
  }

  private finishTurn(error?: Error): void {
    if (!this.currentTurn) return
    const turn = this.currentTurn
    this.currentTurn = null
    turn.onDone(error)
  }
}
