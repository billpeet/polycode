import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import readline from 'readline'
import { CLIDriver, DriverOptions, MessageOptions } from './types'
import { OutputEvent, Question, ReasoningLevel } from '../../shared/types'
import { createRunner, LOAD_NODE_MANAGERS } from './runner'

const CURSOR_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  _meta: { parameterizedModelPicker: true },
}

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

type ConfigOption = {
  id?: string
  category?: string
  type?: string
  currentValue?: unknown
  options?: unknown[]
}

type ModeState = {
  currentModeId: string
  availableModes: Array<{ id: string; name: string; description?: string }>
}

type PendingQuestion = {
  rpcId: number | string
  questions: Array<{ id: string; prompt: string; options: Array<{ id: string; label: string }>; allowMultiple?: boolean }>
}

type PendingPermission = {
  rpcId: number | string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function normalizeReasoning(level: ReasoningLevel | undefined): string | undefined {
  if (!level || level === 'off' || level === 'minimal') return undefined
  return level
}

function isEffortConfigOption(option: ConfigOption): boolean {
  const id = (option.id ?? '').toLowerCase()
  const name = ((asRecord(option)?.name as string | undefined) ?? '').toLowerCase()
  return option.type === 'select' && (
    id === 'effort' || id === 'reasoning' ||
    name === 'effort' || name === 'reasoning' ||
    name.includes('effort') || name.includes('reasoning')
  )
}

// Mirror t3code's findCursorEffortConfigOption priority so we target the real
// effort picker when Cursor exposes several select options.
function findEffortConfigOption(options: ConfigOption[]): ConfigOption | undefined {
  const candidates = options.filter(isEffortConfigOption)
  return (
    candidates.find((option) => option.category === 'model_option') ??
    candidates.find((option) => (option.id ?? '').toLowerCase() === 'effort') ??
    candidates.find((option) => option.category === 'thought_level') ??
    candidates[0]
  )
}

function configOptionName(option: ConfigOption): string {
  return ((asRecord(option)?.name as string | undefined) ?? '').toLowerCase()
}

function isFastConfigOption(option: ConfigOption): boolean {
  const id = (option.id ?? '').toLowerCase()
  const name = configOptionName(option)
  return id === 'fast' || name === 'fast' || name.includes('fast mode')
}

function isThinkingConfigOption(option: ConfigOption): boolean {
  const id = (option.id ?? '').toLowerCase()
  return id === 'thinking' || configOptionName(option).includes('thinking')
}

function isContextConfigOption(option: ConfigOption): boolean {
  const id = (option.id ?? '').toLowerCase()
  return id === 'context' || id === 'context_size' || configOptionName(option).includes('context')
}

// Prefer the model_config-scoped option (t3code's category), else any match.
function findModelConfigOption(options: ConfigOption[], predicate: (option: ConfigOption) => boolean): ConfigOption | undefined {
  return options.find((option) => option.category === 'model_config' && predicate(option)) ?? options.find(predicate)
}

// Resolve a boolean request to the concrete config value: boolean options take
// the boolean directly; select options ("true"/"false") take the matching value.
function resolveBooleanConfigValue(option: ConfigOption | undefined, requested: boolean): string | boolean | undefined {
  if (!option) return undefined
  if (option.type === 'boolean') return requested
  return flattenSelectOptions(option).find((entry) => entry.value.trim().toLowerCase() === String(requested))?.value
}

function flattenSelectOptions(option: ConfigOption | undefined): Array<{ value: string; name: string }> {
  if (!option || option.type !== 'select' || !Array.isArray(option.options)) return []
  const out: Array<{ value: string; name: string }> = []
  for (const entry of option.options) {
    const rec = asRecord(entry)
    if (!rec) continue
    if (typeof rec.value === 'string') {
      out.push({ value: rec.value, name: typeof rec.name === 'string' ? rec.name : rec.value })
    } else if (Array.isArray(rec.options)) {
      for (const nested of rec.options) {
        const n = asRecord(nested)
        if (typeof n?.value === 'string') out.push({ value: n.value, name: typeof n.name === 'string' ? n.name : n.value })
      }
    }
  }
  return out
}

function findConfigOption(options: ConfigOption[], matcher: (option: ConfigOption) => boolean): ConfigOption | undefined {
  return options.find((option) => typeof option.id === 'string' && matcher(option))
}

function findOptionValue(option: ConfigOption | undefined, requested: string | undefined): string | undefined {
  if (!option || !requested) return undefined
  const normalized = requested.toLowerCase().replace(/[\s_-]+/g, '-')
  return flattenSelectOptions(option).find((entry) => {
    const value = entry.value.toLowerCase().replace(/[\s_-]+/g, '-')
    const name = entry.name.toLowerCase().replace(/[\s_-]+/g, '-')
    return value === normalized || name === normalized
  })?.value
}

function extractModelConfigId(configOptions: ConfigOption[]): string {
  return findConfigOption(configOptions, (option) => option.category === 'model')?.id ?? 'model'
}

function parseModes(setup: Record<string, unknown>): ModeState | null {
  const modes = asRecord(setup.modes)
  const currentModeId = typeof modes?.currentModeId === 'string' ? modes.currentModeId : ''
  const availableModes = Array.isArray(modes?.availableModes)
    ? modes.availableModes.flatMap((mode) => {
        const rec = asRecord(mode)
        const id = typeof rec?.id === 'string' ? rec.id : ''
        const name = typeof rec?.name === 'string' ? rec.name : ''
        if (!id || !name) return []
        return [{ id, name, ...(typeof rec.description === 'string' ? { description: rec.description } : {}) }]
      })
    : []
  return currentModeId && availableModes.length > 0 ? { currentModeId, availableModes } : null
}

function findModeId(modeState: ModeState | null, aliases: string[]): string | undefined {
  if (!modeState) return undefined
  const lowerAliases = aliases.map((a) => a.toLowerCase())
  for (const alias of lowerAliases) {
    const exact = modeState.availableModes.find((m) => m.id.toLowerCase() === alias || m.name.toLowerCase() === alias)
    if (exact) return exact.id
  }
  for (const alias of lowerAliases) {
    const partial = modeState.availableModes.find((m) => `${m.id} ${m.name} ${m.description ?? ''}`.toLowerCase().includes(alias))
    if (partial) return partial.id
  }
  return undefined
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

function buildQuestions(params: Record<string, unknown>): Question[] {
  const questions = Array.isArray(params.questions) ? params.questions : []
  return questions.flatMap((raw, index) => {
    const q = asRecord(raw)
    if (!q) return []
    const prompt = typeof q.prompt === 'string' ? q.prompt : `Question ${index + 1}`
    const options = Array.isArray(q.options) ? q.options.flatMap((rawOption) => {
      const opt = asRecord(rawOption)
      const label = typeof opt?.label === 'string' ? opt.label : typeof opt?.id === 'string' ? opt.id : ''
      return label ? [{ label, description: label }] : []
    }) : []
    return [{
      id: typeof q.id === 'string' ? q.id : `q-${index}`,
      header: typeof params.title === 'string' ? params.title : 'Question',
      question: prompt,
      multiSelect: q.allowMultiple === true,
      options: options.length > 0 ? options : [{ label: 'OK', description: 'Continue' }],
    }]
  })
}

export class CursorDriver implements CLIDriver {
  private child: ChildProcessWithoutNullStreams | null = null
  private output: readline.Interface | null = null
  private pending = new Map<number | string, PendingRequest>()
  private nextRequestId = 1
  private sessionId: string | null = null
  private readyPromise: Promise<void> | null = null
  private currentTurn: CurrentTurn | null = null
  private configOptions: ConfigOption[] = []
  private modelConfigId = 'model'
  private modeState: ModeState | null = null
  private activePromptRequestId: number | string | null = null
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
      console.warn('[CursorDriver] sendMessage called while a turn is already running')
      return
    }
    this.currentTurn = { onEvent, onDone }
    this.stopped = false
    this.autoApprovePermissions = options?.yoloMode ?? this.options.yoloMode ?? false
    this.announcedTools.clear()
    this.completedTools.clear()
    this.startPrompt(content, options).catch((error) => this.finishTurn(error instanceof Error ? error : new Error(String(error))))
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
    this.writeMessage({
      jsonrpc: '2.0',
      id: pending.rpcId,
      result: { outcome: { outcome: 'selected', optionId: behavior === 'allow' ? 'allow-once' : 'reject-once' } },
    })
  }

  answerQuestion(requestId: string, answers: Record<string, unknown>, _message?: string): void {
    const pending = this.pendingQuestions.get(requestId)
    if (!pending) return
    this.pendingQuestions.delete(requestId)
    const responseAnswers = pending.questions.map((question) => {
      const rawAnswer = answers[question.id] ?? answers[question.prompt]
      const answerValues = Array.isArray(rawAnswer) ? rawAnswer.map(String) : typeof rawAnswer === 'string' ? [rawAnswer] : []
      const selectedOptionIds = question.options
        .filter((option) => answerValues.includes(option.id) || answerValues.includes(option.label))
        .map((option) => option.id)
      return { questionId: question.id, selectedOptionIds }
    })
    this.writeMessage({
      jsonrpc: '2.0',
      id: pending.rpcId,
      result: { outcome: { outcome: 'answered', answers: responseAnswers } },
    })
  }

  private async startPrompt(content: string, options?: MessageOptions): Promise<void> {
    await this.ensureReady()
    if (!this.sessionId) throw new Error('Cursor ACP session was not initialized')
    await this.applyTurnConfiguration(options)
    const requestId = this.nextRequestId++
    this.activePromptRequestId = requestId
    try {
      await this.sendRequestWithId(requestId, 'session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: content }],
      }, 24 * 60 * 60 * 1000)
      this.finishTurn()
    } catch (error) {
      this.finishTurn(error instanceof Error ? error : new Error(String(error)))
    } finally {
      if (this.activePromptRequestId === requestId) this.activePromptRequestId = null
    }
  }

  private async ensureReady(): Promise<void> {
    if (this.readyPromise) return this.readyPromise
    this.readyPromise = (async () => {
      const runner = createRunner(this.options)
      const cmd = {
        binary: 'cursor-agent',
        args: ['acp'],
        workDir: this.options.workingDir,
        preamble: LOAD_NODE_MANAGERS,
        keepStdinOpen: true,
      }
      this.child = runner.spawn(cmd) as ChildProcessWithoutNullStreams
      this.output = readline.createInterface({ input: this.child.stdout })
      this.output.on('line', (line) => this.handleLine(line))
      this.child.stderr.on('data', (chunk: Buffer) => {
        const message = chunk.toString('utf8').trim()
        if (message) console.warn('[CursorDriver][stderr]', message)
      })
      this.child.on('error', (error) => this.finishTurn(error))
      this.child.on('exit', (code) => {
        if (!this.stopped && this.currentTurn) this.finishTurn(new Error(`Cursor ACP exited${code == null ? '' : ` with code ${code}`}`))
      })

      await this.sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: CURSOR_CLIENT_CAPABILITIES,
        clientInfo: { name: 'polycode', version: '0.13.0' },
      })
      await this.sendRequest('authenticate', { methodId: 'cursor_login' })
      const setup = await this.sendRequest(this.sessionId ? 'session/load' : 'session/new', {
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        cwd: this.options.workingDir,
        mcpServers: [],
      })
      const setupRecord = asRecord(setup) ?? {}
      const createdSessionId = typeof setupRecord.sessionId === 'string' ? setupRecord.sessionId : this.sessionId
      if (!createdSessionId) throw new Error('Cursor ACP did not return a session id')
      this.sessionId = createdSessionId
      this.options.onSessionId?.(createdSessionId)
      this.configOptions = Array.isArray(setupRecord.configOptions) ? setupRecord.configOptions as ConfigOption[] : []
      this.modelConfigId = extractModelConfigId(this.configOptions)
      this.modeState = parseModes(setupRecord)
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

  private async applyModelConfiguration(): Promise<void> {
    if (this.options.model && this.options.model !== 'default') {
      await this.setConfigOption(this.modelConfigId, this.options.model)
    }
    // Apply the effort/reasoning selection for every model — including the
    // Default/Auto model, whose effort option is already present in the
    // session/new config options — so the picked level is never dropped.
    await this.applyReasoningConfiguration()
    await this.applyThinkingConfiguration()
    await this.applyContextConfiguration()
  }

  private async applyThinkingConfiguration(): Promise<void> {
    if (this.options.thinking == null) return
    const option = findModelConfigOption(this.configOptions, isThinkingConfigOption)
    if (!option?.id) return
    const value = resolveBooleanConfigValue(option, this.options.thinking)
    if (value !== undefined) await this.setConfigOption(option.id, value)
  }

  private async applyContextConfiguration(): Promise<void> {
    const requested = this.options.contextWindow?.trim()
    if (!requested) return
    const option = findModelConfigOption(this.configOptions, isContextConfigOption)
    const value = findOptionValue(option, requested)
    if (option?.id && value) await this.setConfigOption(option.id, value)
  }

  // Fast mode is a per-turn priority tier toggled from the composer, so it is
  // applied on every prompt rather than pinned at session setup.
  private async applyFastConfiguration(options?: MessageOptions): Promise<void> {
    const option = findModelConfigOption(this.configOptions, isFastConfigOption)
    if (!option?.id) return
    const value = resolveBooleanConfigValue(option, options?.fastMode === true)
    if (value !== undefined) await this.setConfigOption(option.id, value)
  }

  private async applyTurnConfiguration(options?: MessageOptions): Promise<void> {
    const modeId = options?.planMode
      ? findModeId(this.modeState, ['plan', 'architect'])
      : findModeId(this.modeState, options?.yoloMode || this.options.yoloMode ? ['agent', 'default', 'chat', 'implement'] : ['ask', 'agent', 'default', 'chat', 'implement'])
    if (modeId && modeId !== this.modeState?.currentModeId) {
      await this.setConfigOption('mode', modeId)
      if (this.modeState) this.modeState = { ...this.modeState, currentModeId: modeId }
    }
    await this.applyFastConfiguration(options)
  }

  private async applyReasoningConfiguration(): Promise<void> {
    const requested = normalizeReasoning(this.options.reasoningLevel)
    if (!requested) return
    const option = findEffortConfigOption(this.configOptions)
    const value = findOptionValue(option, requested)
    if (option?.id && value) await this.setConfigOption(option.id, value)
  }

  private async setConfigOption(configId: string, value: string | boolean): Promise<void> {
    if (!this.sessionId) return
    const result = await this.sendRequest('session/set_config_option', {
      sessionId: this.sessionId,
      configId,
      ...(typeof value === 'boolean' ? { type: 'boolean', value } : { value }),
    })
    const rec = asRecord(result)
    if (Array.isArray(rec?.configOptions)) this.configOptions = rec.configOptions as ConfigOption[]
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
      pending.reject(new Error(message.error.message ?? `Cursor ACP request failed (${message.error.code ?? 'unknown'})`))
    } else {
      pending.resolve(message.result)
    }
  }

  private handleServerRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    if (method === 'session/request_permission') {
      const requestId = String(id)
      const toolCall = asRecord(params.toolCall) ?? {}
      if (this.autoApprovePermissions) {
        this.writeMessage({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
        return
      }
      const toolInput = extractToolInput(toolCall)
      this.pendingPermissions.set(requestId, { rpcId: id })
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

    if (method === 'cursor/ask_question') {
      const requestId = String(id)
      const questions = Array.isArray(params.questions) ? params.questions.map((q) => asRecord(q)).filter(Boolean) as Array<{ id: string; prompt: string; options: Array<{ id: string; label: string }>; allowMultiple?: boolean }> : []
      this.pendingQuestions.set(requestId, { rpcId: id, questions })
      this.emit({ type: 'question', content: '', metadata: { requestId, questions: buildQuestions(params) } })
      return
    }

    if (method === 'cursor/create_plan') {
      const plan = typeof params.plan === 'string' && params.plan.trim() ? params.plan : '# Plan\n\n(Cursor did not supply plan text.)'
      // Cursor ACP plan approval is a blocking JSON-RPC request. PolyCode's
      // plan_ready flow expects the CLI turn to finish before approval, so we
      // display the plan as assistant text and accept it to unblock Cursor,
      // matching t3code's Cursor adapter behavior.
      this.emit({ type: 'text', content: plan, metadata: { type: 'cursor_plan', source: 'cursor' } })
      this.writeMessage({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'accepted' } } })
      return
    }

    // Acknowledge optional Cursor extension requests so the agent is not blocked.
    if (method === 'cursor/task') {
      this.writeMessage({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'completed' } } })
      return
    }
    if (method === 'cursor/generate_image') {
      this.writeMessage({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'rejected', reason: 'Image generation is not supported by PolyCode yet.' } } })
      return
    }

    this.writeMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported Cursor ACP request: ${method}` } })
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'session/update') {
      this.handleSessionUpdate(params)
      return
    }
    if (method === 'cursor/update_todos') {
      const todos = Array.isArray(params.todos) ? params.todos.map((todo) => {
        const rec = asRecord(todo) ?? {}
        return { text: String(rec.content ?? rec.title ?? ''), completed: rec.status === 'completed' }
      }).filter((todo) => todo.text) : []
      if (todos.length) {
        const id = typeof params.toolCallId === 'string' ? params.toolCallId : `cursor-todos-${Date.now()}`
        this.emit({ type: 'tool_call', content: 'todo_list', metadata: { type: 'tool_call', id, name: 'TodoList', input: { items: todos } } })
        this.emit({ type: 'tool_result', content: '', metadata: { type: 'tool_result', tool_use_id: id, items: todos } })
      }
    }
  }

  private handleSessionUpdate(params: Record<string, unknown>): void {
    const update = asRecord(params.update)
    if (!update) return
    switch (update.sessionUpdate) {
      case 'current_mode_update': {
        if (typeof update.currentModeId === 'string' && this.modeState) this.modeState = { ...this.modeState, currentModeId: update.currentModeId }
        break
      }
      case 'agent_message_chunk': {
        const content = asRecord(update.content)
        if (content?.type === 'text' && typeof content.text === 'string') this.emit({ type: 'text', content: content.text })
        break
      }
      case 'plan': {
        const entries = Array.isArray(update.entries) ? update.entries : []
        const plan = entries.flatMap((entry, index) => {
          const rec = asRecord(entry)
          const text = typeof rec?.content === 'string' && rec.content.trim() ? rec.content.trim() : `Step ${index + 1}`
          return [`- [${rec?.status === 'completed' ? 'x' : ' '}] ${text}`]
        }).join('\n')
        if (plan) this.emit({ type: 'thinking', content: plan, metadata: { type: 'cursor_plan_update' } })
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
        reject(new Error(`Timed out waiting for Cursor ACP ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      this.writeMessage({ jsonrpc: '2.0', id, method, params })
    })
  }

  private writeMessage(message: JsonRpcMessage): void {
    if (!this.child?.stdin.writable) throw new Error('Cannot write to Cursor ACP stdin')
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
    if (error || this.stopped) this.cleanup()
    turn.onDone(this.stopped ? undefined : error)
    this.stopped = false
  }

  private cleanup(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Cursor ACP stopped'))
    }
    this.pending.clear()
    this.pendingQuestions.clear()
    this.pendingPermissions.clear()
    this.output?.close()
    this.output = null
    if (this.child && !this.child.killed) {
      try { this.child.kill() } catch { /* ignore */ }
      if (process.platform === 'win32' && this.child.pid != null) {
        try { spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { shell: false }) } catch { /* ignore */ }
      }
    }
    this.child = null
    this.readyPromise = null
  }
}
