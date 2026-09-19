import { readFile, stat } from 'fs/promises'
import path from 'path'
import type { CLIDriver, DriverOptions, MessageOptions } from './types'
import type { OutputEvent, Question } from '../../shared/types'
import { KimiConnection, kimiConfig, kimiQuestions, record, records, selectOptions, type RecordValue, type RpcId } from './kimi-acp'

type Turn = { onEvent: (event: OutputEvent) => void; onDone: (error?: Error) => void }
type Interaction = { id: RpcId; questions: Question[]; options?: RecordValue[] }
function textContent(value: unknown): string {
  return records(value).flatMap((item) => {
    const content = item.type === 'content' ? record(item.content) : item
    return content.type === 'text' && typeof content.text === 'string' ? [content.text] : []
  }).join('\n')
}

export class KimiDriver implements CLIDriver {
  private connection: KimiConnection | null = null
  private ready: Promise<void> | null = null
  private sessionId: string | null
  private config: RecordValue[] = []
  private loading = false
  private turn: Turn | null = null
  private eventSink: ((event: OutputEvent) => void) | null = null
  private generation = 0
  private cancelTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private permissions = new Map<string, { id: RpcId; options: RecordValue[] }>()
  private questions: Interaction[] = []
  private tools = new Map<string, RecordValue>()
  private announced = new Set<string>()
  private completed = new Set<string>()

  constructor(private readonly options: DriverOptions) { this.sessionId = options.initialSessionId ?? null }
  isRunning(): boolean { return this.turn !== null }
  getPid(): number | null { return this.connection?.pid ?? null }
  // ACP does not expose a reliable detached-task inventory. Keep worktrees while the peer lives.
  hasLiveBackgroundWork(): boolean { return this.connection !== null }

  sendMessage(content: string, onEvent: Turn['onEvent'], onDone: Turn['onDone'], options?: MessageOptions): void {
    if (this.turn) { onDone(new Error('Kimi Code is busy; wait for the current turn or stop it first.')); return }
    const turn = { onEvent, onDone }
    this.turn = turn
    this.eventSink = onEvent
    this.tools.clear(); this.announced.clear(); this.completed.clear()
    this.stopped = false
    const generation = this.generation
    this.run(content, options, generation).then(
      () => { if (this.turn === turn) this.finish() },
      (error: unknown) => { if (this.turn === turn) this.finish(error instanceof Error ? error : new Error(String(error))) },
    )
  }

  stop(): void {
    this.stopped = true
    if (!this.turn || !this.sessionId || !this.connection || this.loading) { this.forceStop(); return }
    try { this.connection.notify('session/cancel', { sessionId: this.sessionId }) }
    catch { this.forceStop(); return }
    if (!this.cancelTimer) this.cancelTimer = setTimeout(() => this.forceStop(), 3000)
  }

  forceStop(): void {
    this.stopped = true
    this.dispose()
    this.finish()
  }

  sendControlResponse(requestId: string, behavior: 'allow' | 'deny'): void {
    const pending = this.permissions.get(requestId)
    if (!pending || !this.connection) return
    const option = pending.options.find((item) => item.kind === (behavior === 'allow' ? 'allow_once' : 'reject_once'))
    this.connection.respond(pending.id, option
      ? { outcome: { outcome: 'selected', optionId: option.optionId } }
      : { outcome: { outcome: 'cancelled' } })
    this.permissions.delete(requestId)
  }

  /** Keeps form keys and arrays intact; the other drivers retain their existing answer format. */
  answerStructuredQuestion(requestId: string, answers: Record<string, unknown>): void {
    const pending = this.questions[0]
    if (!pending || String(pending.id) !== requestId || !this.connection) return
    const content: Record<string, unknown> = {}
    for (const question of pending.questions) {
      const answer = answers[question.id!]
      const values = Array.isArray(answer) ? answer : [answer]
      if (!values.length || values.some((value) => !question.options.some((option) => option.label === value))) {
        throw new Error('Select an offered answer for every Kimi Code question.')
      }
      content[question.id!] = question.multiSelect ? values : values[0]
    }
    if (pending.options) {
      const option = pending.options.find((item) => item.name === content.choice)
      if (!option) throw new Error('Select a Kimi Code approval option.')
      this.connection.respond(pending.id, { outcome: { outcome: 'selected', optionId: option.optionId } })
    } else this.connection.respond(pending.id, { action: 'accept', content })
    this.questions.shift()
    // Session clears the answered question after the driver returns.
    queueMicrotask(() => this.showQuestion())
  }

  private async run(content: string, options: MessageOptions | undefined, generation: number): Promise<void> {
    await this.ensureReady()
    this.assertActive(generation)
    const connection = this.connection!
    const model = this.options.model
    if (model && model !== 'default') await this.configure('model', model)
    this.assertActive(generation)
    if (this.options.kimiThinking) await this.configure('thinking', this.options.kimiThinking)
    const permission = options?.permissionMode ?? (options?.yoloMode === undefined
      ? this.options.permissionMode ?? (this.options.yoloMode ? 'yolo' : 'ask')
      : options.yoloMode ? 'yolo' : 'ask')
    const mode = options?.planMode ? 'plan' : permission === 'auto' ? 'auto' : permission === 'yolo' ? 'yolo' : 'default'
    await this.configure('mode', mode)
    this.assertActive(generation)
    const prompt: RecordValue[] = [{ type: 'text', text: content }]
    if (options?.outputSchema) throw new Error('Kimi Code does not support constrained output schemas through this integration.')
    for (const [name, context] of Object.entries(options?.additionalContext ?? {})) {
      prompt.push({ type: 'text', text: `${name}:\n${context.value}` })
    }
    for (const attachment of options?.attachments ?? []) {
      if (!record(connection.capabilities.promptCapabilities).image) throw new Error('This Kimi Code version does not accept images.')
      if (attachment.url?.startsWith('data:')) {
        const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(attachment.url)
        if (!match || match[2].length > 28_000_000) throw new Error('Unsupported or oversized Kimi image attachment.')
        prompt.push({ type: 'image', mimeType: match[1], data: match[2] })
      } else if (attachment.path && !this.options.ssh && !this.options.wsl) {
        const mimeType = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' } as Record<string, string>)[path.extname(attachment.path).toLowerCase()]
        if (!mimeType) throw new Error('Kimi image attachments must be PNG, JPEG, GIF, or WebP.')
        if ((await stat(attachment.path)).size > 20_000_000) throw new Error('Kimi image attachments must be smaller than 20 MB.')
        const data = await readFile(attachment.path)
        if (data.length > 20_000_000) throw new Error('Kimi image attachments must be smaller than 20 MB.')
        prompt.push({ type: 'image', mimeType, data: data.toString('base64') })
      } else throw new Error('Kimi remote image attachments require embedded image data; local paths and image URLs are not supported.')
    }
    this.assertActive(generation)
    const result = record(await connection.request('session/prompt', { sessionId: this.sessionId, prompt }, 24 * 60 * 60 * 1000))
    if (result.stopReason === 'refusal') throw new Error('Kimi Code refused or blocked this turn.')
    if (result.stopReason === 'cancelled') this.stopped = true
  }

  private assertActive(generation: number): void {
    if (generation !== this.generation || this.stopped || !this.turn) throw new Error('Kimi Code turn stopped')
  }

  private ensureReady(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = (async () => {
      const connection = new KimiConnection(this.options,
        (method, params, id) => this.receive(method, params, id),
        (error) => { if (this.connection === connection) { this.dispose(); this.finish(error) } },
      )
      this.connection = connection
      await connection.start()
      const sessions = record(connection.capabilities.sessionCapabilities)
      const method = this.sessionId ? sessions.resume !== undefined ? 'session/resume' : 'session/load' : 'session/new'
      if (method === 'session/load' && !connection.capabilities.loadSession) throw new Error('This Kimi Code version cannot resume sessions.')
      this.loading = true
      try {
        const setup = record(await connection.request(method, {
          ...(this.sessionId ? { sessionId: this.sessionId } : {}), cwd: this.options.workingDir, mcpServers: [],
        }))
        if (typeof setup.sessionId === 'string') this.sessionId = setup.sessionId
        if (!this.sessionId) throw new Error('Kimi Code did not return a session ID.')
        this.options.onSessionId?.(this.sessionId)
        this.config = kimiConfig(setup)
      } finally { this.loading = false }
    })()
    return this.ready
  }

  private async configure(id: string, value: string): Promise<void> {
    const option = this.config.find((item) => item.id === id)
    if (!option || !selectOptions(option).some((item) => item.value === value)) throw new Error(`Kimi Code does not offer ${id} "${value}". Choose an available option.`)
    if (option.currentValue === value) return
    const result = await this.connection!.request('session/set_config_option', { sessionId: this.sessionId, configId: id, value })
    this.config = kimiConfig(result)
  }

  private receive(method: string, params: RecordValue, id?: RpcId): void {
    if (params.sessionId && this.sessionId && params.sessionId !== this.sessionId) return
    if (id !== undefined) {
      if (!this.turn || this.loading) { this.connection?.reject(id, 'No active Kimi Code turn'); return }
      if (method === 'elicitation/create') {
        try { this.enqueueQuestion({ id, questions: kimiQuestions(params) }) }
        catch { this.connection?.respond(id, { action: 'decline' }) }
      } else if (method === 'session/request_permission') {
        const options = records(params.options)
        const tool = record(params.toolCall)
        if (options.some((option) => /^(plan_|q\d+_)/.test(String(option.optionId)))) {
          this.enqueueQuestion({ id, options, questions: [{ id: 'choice', header: String(tool.title ?? 'Review'),
            question: textContent(tool.content) || String(tool.title ?? 'Choose an action'), multiSelect: false, allowComments: false,
            options: options.map((option) => ({ label: String(option.name), description: '' })),
          }] })
        } else {
          this.permissions.set(String(id), { id, options })
          this.emit({ type: 'permission_request', content: String(tool.title ?? 'Kimi tool'), metadata: {
            requestId: String(id), toolName: String(tool.title ?? 'Kimi tool'), toolInput: record(tool.rawInput), toolUseId: tool.toolCallId,
          } })
        }
      } else this.connection?.reject(id, `Unsupported Kimi Code request: ${method}`)
      return
    }
    if (method !== 'session/update') return
    const update = record(params.update)
    if (update.sessionUpdate === 'config_option_update') { this.config = kimiConfig(update); return }
    if (this.loading) return
    if (update.sessionUpdate === 'usage_update') {
      if (typeof update.used === 'number' && typeof update.size === 'number') this.emit({ type: 'usage', content: '', metadata: {
        context_window: update.used, max_context_window: update.size,
      } })
      return
    }
    if (!this.turn) return
    const content = record(update.content)
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
        if (content.type === 'text' && typeof content.text === 'string') this.emit(update.sessionUpdate === 'agent_thought_chunk'
          ? { type: 'thinking', content: content.text, metadata: { type: 'thinking' } }
          : { type: 'text', content: content.text })
        break
      case 'plan':
        this.emit({ type: 'thinking', content: records(update.entries).map((entry) => `- [${entry.status === 'completed' ? 'x' : ' '}] ${entry.content}`).join('\n'), metadata: { type: 'thinking' } })
        break
      case 'tool_call':
      case 'tool_call_update':
        this.toolUpdate(update)
        break
    }
  }

  private toolUpdate(update: RecordValue): void {
    if (typeof update.toolCallId !== 'string') return
    const id = update.toolCallId
    const tool = { ...this.tools.get(id), ...update }
    this.tools.set(id, tool)
    const input = record(tool.rawInput)
    if (typeof input.path === 'string' && !input.file_path) input.file_path = input.path
    const name = ({ execute: 'Bash', read: 'Read', edit: 'Edit', search: 'Grep', fetch: 'WebFetch' } as Record<string, string>)[String(tool.kind)] ?? String(tool.title ?? 'Tool')
    if (!this.announced.has(id) && (tool.rawInput !== undefined || tool.status === 'completed' || tool.status === 'failed')) {
      this.announced.add(id)
      this.emit({ type: 'tool_call', content: name, metadata: { ...tool, type: 'tool_call', id, name, input } })
    }
    if (!this.completed.has(id) && (tool.status === 'completed' || tool.status === 'failed')) {
      this.completed.add(id)
      this.emit({ type: 'tool_result', content: textContent(tool.content) || (typeof tool.rawOutput === 'string' ? tool.rawOutput : ''), metadata: {
        ...tool, type: 'tool_result', tool_use_id: id, is_error: tool.status === 'failed',
      } })
    }
  }

  private enqueueQuestion(question: Interaction): void { this.questions.push(question); if (this.questions.length === 1) this.showQuestion() }
  private showQuestion(): void {
    const question = this.questions[0]
    if (question && this.turn) this.emit({ type: 'question', content: '', metadata: { requestId: String(question.id), questions: question.questions } })
  }
  private emit(event: OutputEvent): void { this.eventSink?.(event) }
  private finish(error?: Error): void {
    const turn = this.turn
    this.turn = null
    this.clearInteractions()
    if (error || this.stopped) this.dispose()
    if (turn) turn.onDone(this.stopped ? undefined : error)
  }
  private dispose(): void {
    this.generation++
    if (this.cancelTimer) clearTimeout(this.cancelTimer)
    this.cancelTimer = null
    this.clearInteractions()
    this.eventSink = null
    const connection = this.connection
    this.connection = null
    this.ready = null
    this.permissions.clear()
    this.questions = []
    this.tools.clear(); this.announced.clear(); this.completed.clear()
    connection?.close()
  }

  private clearInteractions(): void {
    for (const requestId of [...this.permissions.keys(), ...this.questions.map((question) => String(question.id))]) {
      this.emit({ type: 'status', content: '', metadata: { type: 'server_request_resolved', requestId } })
    }
    this.permissions.clear()
    this.questions = []
  }
}
