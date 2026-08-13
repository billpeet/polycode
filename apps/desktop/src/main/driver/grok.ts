import type { ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import readline from 'readline'
import { killWindowsProcessTree } from '../process-control'
import { CLIDriver, DriverOptions, MessageOptions } from './types'
import { OutputEvent } from '../../shared/types'
import { createRunner } from './runner'
import {
  GROK_ACP_ARGS,
  GROK_BINARY,
  GROK_CLIENT_CAPABILITIES,
  GROK_CLIENT_INFO,
  GROK_DEFAULT_MODEL_ID,
  GROK_REMOTE_PREAMBLE,
  GROK_SPAWN_EXTRA_ENV,
  GrokRawQuestion,
  asRecord,
  grokAuthMethodOrder,
  parseGrokQuestionParams,
  parseGrokSessionModels,
  selectGrokPermissionOptionId,
} from './grok-acp'

type JsonRpcMessage = {
  jsonrpc?: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { message?: string; code?: number; data?: unknown }
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

type CurrentTurn = {
  onEvent: (event: OutputEvent) => void
  onDone: (error?: Error) => void
}

type PendingQuestion = {
  rpcId: number | string
  questions: GrokRawQuestion[]
}

type PendingPermission = {
  rpcId: number | string
  options: unknown
}

function extractToolInput(update: Record<string, unknown>): Record<string, unknown> {
  const rawInput = asRecord(update.rawInput)
  if (rawInput) return rawInput
  const command = typeof update.command === 'string' ? update.command : undefined
  return command ? { command } : {}
}

function toolNameFromKind(kind: unknown, title: unknown): string {
  if (typeof title === 'string' && title.trim()) return title.trim()
  if (kind === 'execute') return 'Bash'
  if (kind === 'edit') return 'Edit'
  if (kind === 'delete') return 'Delete'
  if (kind === 'search') return 'Search'
  if (kind === 'fetch') return 'Fetch'
  if (kind === 'read') return 'Read'
  return typeof kind === 'string' && kind.trim() ? kind.trim() : 'Tool'
}

function summarizeToolResult(update: Record<string, unknown>): string {
  if (typeof update.rawOutput === 'string') return update.rawOutput
  if (typeof update.output === 'string') return update.output
  if (Array.isArray(update.content)) {
    return update.content.flatMap((item) => {
      const rec = asRecord(item)
      const content = asRecord(rec?.content)
      return content?.type === 'text' && typeof content.text === 'string' ? [content.text] : []
    }).join('\n')
  }
  return ''
}

/**
 * Driver for xAI's Grok Build CLI over ACP JSON-RPC (`grok agent stdio`),
 * mirroring t3code's Grok adapter. Like CursorDriver this keeps a persistent
 * child process per session; tools run inside the CLI and we surface tool,
 * permission and question events.
 *
 * xAI-specific quirks handled here (both observed in t3code):
 *  - `_x.ai/ask_user_question` (also spelled `x.ai/ask_user_question`) is a
 *    blocking request for structured multiple-choice questions; answered with
 *    `{ outcome: 'accepted', answers: Record<questionText, string[]> }`.
 *  - Grok does not always resolve the `session/prompt` RPC. Every prompt
 *    carries `_meta.promptId`, and a `_x.ai/session/prompt_complete`
 *    notification acts as a fallback completion signal that we race against
 *    the RPC response.
 */
export class GrokDriver implements CLIDriver {
  private child: ChildProcessWithoutNullStreams | null = null
  private output: readline.Interface | null = null
  private pending = new Map<number | string, PendingRequest>()
  private nextRequestId = 1
  private sessionId: string | null = null
  private readyPromise: Promise<void> | null = null
  private currentTurn: CurrentTurn | null = null
  private currentModelId: string | null = null
  private activePromptRequestId: number | string | null = null
  private activePromptId: string | null = null
  private pendingQuestions = new Map<string, PendingQuestion>()
  private pendingPermissions = new Map<string, PendingPermission>()
  private stopped = false
  private announcedTools = new Set<string>()
  private completedTools = new Set<string>()
  private autoApprovePermissions = false

  constructor(private readonly options: DriverOptions) {
    this.sessionId = options.initialSessionId ?? null
  }

  sendMessage(content: string, onEvent: (event: OutputEvent) => void, onDone: (error?: Error) => void, options?: MessageOptions): void {
    if (this.currentTurn) {
      console.warn('[GrokDriver] sendMessage called while a turn is already running')
      return
    }
    this.currentTurn = { onEvent, onDone }
    this.stopped = false
    this.autoApprovePermissions = options?.yoloMode ?? this.options.yoloMode ?? false
    this.announcedTools.clear()
    this.completedTools.clear()
    this.startPrompt(content).catch((error) => this.finishTurn(error instanceof Error ? error : new Error(String(error))))
  }

  stop(): void {
    this.stopped = true
    if (this.sessionId) {
      void this.sendRequest('session/cancel', { sessionId: this.sessionId }, 5_000).catch(() => this.cleanup())
      return
    }
    this.cleanup()
  }

  forceStop(): void {
    this.stopped = true
    this.cleanup()
    this.finishTurn()
  }

  isRunning(): boolean {
    return this.currentTurn !== null
  }

  getPid(): number | null {
    return this.child?.pid ?? null
  }

  sendControlResponse(requestId: string, behavior: 'allow' | 'deny', _message?: string): void {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return
    this.pendingPermissions.delete(requestId)
    const optionId = selectGrokPermissionOptionId(pending.options, behavior)
    this.writeMessage({
      jsonrpc: '2.0',
      id: pending.rpcId,
      result: { outcome: { outcome: 'selected', optionId } },
    })
  }

  answerQuestion(requestId: string, answers: Record<string, unknown>, _message?: string): void {
    const pending = this.pendingQuestions.get(requestId)
    if (!pending) return
    this.pendingQuestions.delete(requestId)
    // xAI's extension expects answers keyed by question text, each a string[]
    // of the selected option labels (t3code's user-input.resolved mapping).
    const responseAnswers: Record<string, string[]> = {}
    for (const question of pending.questions) {
      const rawAnswer = answers[question.id] ?? answers[question.text]
      const answerValues = Array.isArray(rawAnswer) ? rawAnswer.map(String) : typeof rawAnswer === 'string' ? [rawAnswer] : []
      const selected = question.options.length > 0
        ? question.options
            .filter((option) => answerValues.includes(option.id) || answerValues.includes(option.label))
            .map((option) => option.label)
        : answerValues
      responseAnswers[question.text] = selected.length > 0 ? selected : answerValues
    }
    this.writeMessage({
      jsonrpc: '2.0',
      id: pending.rpcId,
      result: { outcome: 'accepted', answers: responseAnswers },
    })
  }

  private async startPrompt(content: string): Promise<void> {
    await this.ensureReady()
    if (!this.sessionId) throw new Error('Grok ACP session was not initialized')
    const requestId = this.nextRequestId++
    const promptId = randomUUID()
    this.activePromptRequestId = requestId
    this.activePromptId = promptId
    try {
      await this.sendRequestWithId(requestId, 'session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: content }],
        // Grok's prompt-completion fallback correlates on this id — see
        // handleNotification('_x.ai/session/prompt_complete').
        _meta: { promptId, requestId },
      }, 24 * 60 * 60 * 1000)
      this.finishTurn()
    } catch (error) {
      this.finishTurn(error instanceof Error ? error : new Error(String(error)))
    } finally {
      if (this.activePromptRequestId === requestId) {
        this.activePromptRequestId = null
        this.activePromptId = null
      }
    }
  }

  private async ensureReady(): Promise<void> {
    if (this.readyPromise) return this.readyPromise
    this.readyPromise = (async () => {
      const runner = createRunner(this.options)
      const cmd = {
        binary: GROK_BINARY,
        args: GROK_ACP_ARGS,
        workDir: this.options.workingDir,
        preamble: GROK_REMOTE_PREAMBLE,
        keepStdinOpen: true,
        extraEnv: GROK_SPAWN_EXTRA_ENV,
      }
      this.child = runner.spawn(cmd) as ChildProcessWithoutNullStreams
      this.output = readline.createInterface({ input: this.child.stdout })
      this.output.on('line', (line) => this.handleLine(line))
      this.child.stderr.on('data', (chunk: Buffer) => {
        const message = chunk.toString('utf8').trim()
        if (message) console.warn('[GrokDriver][stderr]', message)
      })
      this.child.on('error', (error) => this.finishTurn(error))
      this.child.on('exit', (code) => {
        if (!this.stopped && this.currentTurn) this.finishTurn(new Error(`Grok ACP exited${code == null ? '' : ` with code ${code}`}`))
      })

      await this.sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: GROK_CLIENT_CAPABILITIES,
        clientInfo: GROK_CLIENT_INFO,
      })
      await this.authenticate()
      const setup = await this.sendRequest(this.sessionId ? 'session/load' : 'session/new', {
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        cwd: this.options.workingDir,
        mcpServers: [],
      })
      const setupRecord = asRecord(setup) ?? {}
      const createdSessionId = typeof setupRecord.sessionId === 'string' ? setupRecord.sessionId : this.sessionId
      if (!createdSessionId) throw new Error('Grok ACP did not return a session id')
      this.sessionId = createdSessionId
      this.options.onSessionId?.(createdSessionId)
      this.currentModelId = parseGrokSessionModels(setupRecord).currentModelId
      await this.applyModelConfiguration()
    })()

    try {
      await this.readyPromise
    } catch (error) {
      this.readyPromise = null
      this.cleanup()
      throw error
    }
  }

  /**
   * Try each auth method in order. Locally XAI_API_KEY promotes `xai.api_key`;
   * otherwise the `grok login` token cache leads. The CLI owns the actual
   * credentials either way.
   */
  private async authenticate(): Promise<void> {
    const remote = !!(this.options.ssh || this.options.wsl)
    const methods = grokAuthMethodOrder(process.env, remote)
    let lastError: Error | null = null
    for (const methodId of methods) {
      try {
        await this.sendRequest('authenticate', { methodId })
        return
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
      }
    }
    throw new Error(`Grok ACP authentication failed (run \`grok login\` or set XAI_API_KEY): ${lastError?.message ?? 'unknown error'}`)
  }

  private async applyModelConfiguration(): Promise<void> {
    const requested = this.options.model?.trim()
    if (!requested || requested === 'default') return
    // No reported current model + the default slug requested → assume we are
    // already on it rather than poking the unstable set_model surface.
    if (!this.currentModelId && requested === GROK_DEFAULT_MODEL_ID) return
    // Skip the no-op switch (t3code's applyGrokAcpModelSelection guard) and
    // treat failures as advisory — `session/set_model` is an unstable ACP
    // surface, and a session on the default model is better than no session.
    if (this.currentModelId && this.currentModelId === requested) return
    try {
      await this.sendRequest('session/set_model', { sessionId: this.sessionId, modelId: requested })
      this.currentModelId = requested
    } catch (error) {
      console.warn('[GrokDriver] session/set_model failed; continuing with the session default model:', error instanceof Error ? error.message : error)
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      return
    }

    if (message.id !== undefined && !message.method) {
      this.handleResponse(message)
      return
    }

    if (!message.method) return
    const params = asRecord(message.params) ?? {}
    if (message.id !== undefined) {
      this.handleServerRequest(message.id, message.method, params)
    } else {
      this.handleNotification(message.method, params)
    }
  }

  private handleResponse(message: JsonRpcMessage): void {
    const pending = this.pending.get(message.id!)
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pending.delete(message.id!)
    if (message.error) {
      pending.reject(new Error(message.error.message ?? `Grok ACP request failed (${message.error.code ?? 'unknown'})`))
    } else {
      pending.resolve(message.result)
    }
  }

  private handleServerRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    if (method === 'session/request_permission') {
      const requestId = String(id)
      const toolCall = asRecord(params.toolCall) ?? {}
      if (this.autoApprovePermissions) {
        this.writeMessage({
          jsonrpc: '2.0',
          id,
          result: { outcome: { outcome: 'selected', optionId: selectGrokPermissionOptionId(params.options, 'allow', true) } },
        })
        return
      }
      const toolInput = extractToolInput(toolCall)
      this.pendingPermissions.set(requestId, { rpcId: id, options: params.options })
      this.emit({
        type: 'permission_request',
        content: toolNameFromKind(toolCall.kind, toolCall.title),
        metadata: {
          requestId,
          toolName: toolNameFromKind(toolCall.kind, toolCall.title),
          toolInput,
          toolUseId: typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : requestId,
        },
      })
      return
    }

    if (method === '_x.ai/ask_user_question' || method === 'x.ai/ask_user_question') {
      const requestId = String(id)
      const { questions, raw } = parseGrokQuestionParams(params)
      if (questions.length === 0) {
        this.writeMessage({ jsonrpc: '2.0', id, result: { outcome: 'cancelled' } })
        return
      }
      this.pendingQuestions.set(requestId, { rpcId: id, questions: raw })
      this.emit({ type: 'question', content: '', metadata: { requestId, questions } })
      return
    }

    this.writeMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported Grok ACP request: ${method}` } })
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'session/update') {
      this.handleSessionUpdate(params)
      return
    }
    // Fallback completion signal: Grok does not always resolve the
    // `session/prompt` RPC. When the notification matches the in-flight prompt
    // (by promptId/requestId, or unconditionally when it carries neither),
    // settle the pending request as if the RPC had responded.
    if (method === '_x.ai/session/prompt_complete' || method === 'x.ai/session/prompt_complete') {
      if (this.activePromptRequestId == null) return
      const meta = asRecord(params._meta) ?? params
      const promptId = typeof meta.promptId === 'string' ? meta.promptId : undefined
      const requestId = meta.requestId
      const matches =
        (promptId === undefined && requestId === undefined) ||
        (promptId !== undefined && promptId === this.activePromptId) ||
        (requestId !== undefined && requestId === this.activePromptRequestId)
      if (!matches) return
      const pending = this.pending.get(this.activePromptRequestId)
      if (!pending) return
      clearTimeout(pending.timeout)
      this.pending.delete(this.activePromptRequestId)
      pending.resolve({ stopReason: typeof params.stopReason === 'string' ? params.stopReason : null })
    }
  }

  private handleSessionUpdate(params: Record<string, unknown>): void {
    const update = asRecord(params.update)
    if (!update) return
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const content = asRecord(update.content)
        if (content?.type === 'text' && typeof content.text === 'string') this.emit({ type: 'text', content: content.text })
        break
      }
      case 'agent_thought_chunk': {
        const content = asRecord(update.content)
        // metadata.type is the discriminator that survives persistence: the
        // Session stores thinking as a plain assistant message, and the
        // renderer (MessageBubble/foldMessages) re-derives "thinking trace"
        // from metadata.type — the OutputEvent type alone is not enough.
        if (content?.type === 'text' && typeof content.text === 'string') {
          this.emit({ type: 'thinking', content: content.text, metadata: { type: 'thinking' } })
        }
        break
      }
      case 'plan': {
        const entries = Array.isArray(update.entries) ? update.entries : []
        const plan = entries.flatMap((entry, index) => {
          const rec = asRecord(entry)
          const text = typeof rec?.content === 'string' && rec.content.trim() ? rec.content.trim() : `Step ${index + 1}`
          return [`- [${rec?.status === 'completed' ? 'x' : ' '}] ${text}`]
        }).join('\n')
        if (plan) this.emit({ type: 'thinking', content: plan, metadata: { type: 'thinking', source: 'grok_plan_update' } })
        break
      }
      case 'current_model_update': {
        if (typeof update.currentModelId === 'string') this.currentModelId = update.currentModelId
        break
      }
      case 'tool_call':
      case 'tool_call_update': {
        this.handleToolUpdate(update)
        break
      }
    }
  }

  private handleToolUpdate(update: Record<string, unknown>): void {
    const toolUseId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined
    if (!toolUseId) return
    const name = toolNameFromKind(update.kind, update.title)
    const input = extractToolInput(update)
    if (!this.announcedTools.has(toolUseId)) {
      this.announcedTools.add(toolUseId)
      this.emit({ type: 'tool_call', content: name, metadata: { ...update, type: 'tool_call', id: toolUseId, name, input } })
    }
    if ((update.status === 'completed' || update.status === 'failed') && !this.completedTools.has(toolUseId)) {
      this.completedTools.add(toolUseId)
      this.emit({
        type: 'tool_result',
        content: summarizeToolResult(update),
        metadata: { ...update, type: 'tool_result', tool_use_id: toolUseId, ...(update.status === 'failed' ? { is_error: true } : {}) },
      })
    }
  }

  private sendRequest(method: string, params: unknown = {}, timeoutMs = 20_000): Promise<unknown> {
    return this.sendRequestWithId(this.nextRequestId++, method, params, timeoutMs)
  }

  private sendRequestWithId(id: number | string, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for Grok ACP ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      this.writeMessage({ jsonrpc: '2.0', id, method, params })
    })
  }

  private writeMessage(message: JsonRpcMessage): void {
    if (!this.child?.stdin.writable) throw new Error('Cannot write to Grok ACP stdin')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private emit(event: OutputEvent): void {
    this.currentTurn?.onEvent(event)
  }

  private finishTurn(error?: Error): void {
    if (!this.currentTurn) return
    const turn = this.currentTurn
    this.currentTurn = null
    this.activePromptRequestId = null
    this.activePromptId = null
    if (error || this.stopped) this.cleanup()
    turn.onDone(this.stopped ? undefined : error)
    this.stopped = false
  }

  private cleanup(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Grok ACP stopped'))
    }
    this.pending.clear()
    this.pendingQuestions.clear()
    this.pendingPermissions.clear()
    this.output?.close()
    this.output = null
    if (this.child && !this.child.killed) {
      try { this.child.kill() } catch { /* ignore */ }
      if (process.platform === 'win32' && this.child.pid != null) {
        killWindowsProcessTree(this.child.pid, { force: true })
      }
    }
    this.child = null
    this.readyPromise = null
  }
}
