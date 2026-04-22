import * as Sentry from '@sentry/electron/main'
import { DriverOptions, MessageOptions, CLIDriver } from './types'
import { OutputEvent } from '../../shared/types'
import { createRunner, SpawnCommand } from './runner'

type JsonRpcLikeResponse = {
  id?: string
  type: 'response'
  command: string
  success: boolean
  error?: string
  data?: unknown
}

type PendingRequest = {
  resolve: (value: JsonRpcLikeResponse) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export function buildPiArgs(
  sessionId: string | null,
  model: string | undefined,
): string[] {
  const args: string[] = ['--mode', 'rpc']
  if (sessionId) args.push('--session', sessionId)
  if (model) args.push('--model', model)
  return args
}

function summarizeToolResult(result: unknown): string {
  if (typeof result === 'string') return result
  if (!result || typeof result !== 'object') return result == null ? '' : String(result)

  const content = (result as { content?: unknown }).content
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const maybeText = (item as { text?: unknown }).text
        return typeof maybeText === 'string' ? maybeText : null
      })
      .filter((item): item is string => Boolean(item))
      .join('\n')
    if (text) return text
  }

  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

function normalizeRunError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
}

export class PiDriver implements CLIDriver {
  private process: ReturnType<ReturnType<typeof createRunner>['spawn']> | null = null
  private buffer = ''
  private sessionId: string | null = null
  private pending = new Map<string, PendingRequest>()
  private nextRequestId = 1
  private currentTurn: { onEvent: (event: OutputEvent) => void; onDone: (error?: Error) => void } | null = null
  private readyPromise: Promise<void> | null = null
  private stopRequested = false
  private abortRequested = false

  constructor(private readonly options: DriverOptions) {
    if (options.initialSessionId) {
      this.sessionId = options.initialSessionId
    }
  }

  get driverName(): string { return 'PiDriver' }

  sendMessage(
    content: string,
    onEvent: (event: OutputEvent) => void,
    onDone: (error?: Error) => void,
    _options?: MessageOptions
  ): void {
    if (this.currentTurn) {
      console.warn('[PiDriver] sendMessage called while a turn is already running')
      return
    }

    this.currentTurn = { onEvent, onDone }
    this.stopRequested = false
    this.abortRequested = false

    this.startPrompt(content).catch((error) => {
      this.finishTurn(normalizeRunError(error))
    })
  }

  injectMessage(content: string, _options?: MessageOptions): void {
    if (!this.currentTurn) {
      console.warn('[PiDriver] injectMessage called without an active turn')
      return
    }

    void this.sendRequest('steer', { type: 'steer', message: content }).catch((error) => {
      this.finishTurn(normalizeRunError(error))
    })
  }

  stop(): void {
    this.stopRequested = true
    this.abortRequested = true

    if (this.process?.stdin?.writable) {
      void this.sendRequest('abort', { type: 'abort' }, 10_000).catch(() => {
        this.cleanupProcess()
      })
      return
    }

    this.cleanupProcess()
  }

  forceStop(): void {
    this.stopRequested = true
    this.abortRequested = true
    this.cleanupProcess()
  }

  isRunning(): boolean {
    return this.currentTurn !== null
  }

  getPid(): number | null {
    return this.process?.pid ?? null
  }

  sendControlResponse(_requestId: string, _behavior: 'allow' | 'deny', _message?: string): void {}

  private buildCommand(): SpawnCommand {
    return {
      binary: 'pi',
      args: buildPiArgs(this.sessionId, this.options.model),
      workDir: this.options.workingDir,
      keepStdinOpen: true,
    }
  }

  private async startPrompt(content: string): Promise<void> {
    await this.ensureReady()
    await this.sendRequest('prompt', { type: 'prompt', message: content })
  }

  private async ensureReady(): Promise<void> {
    if (this.readyPromise) return this.readyPromise

    this.readyPromise = (async () => {
      const runner = createRunner(this.options)
      const cmd = this.buildCommand()
      this.process = runner.spawn(cmd)

      let stderrBuffer = ''

      this.process.stdout?.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString('utf8')
        this.processBuffer()
      })

      this.process.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        stderrBuffer += text
        console.error('[PiDriver] stderr:', text)
      })

      this.process.on('close', (code) => {
        this.processBuffer()
        this.process = null

        const error = code !== 0 && code !== null
          ? new Error(`PiDriver process exited with code ${code}${stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : ''}`)
          : undefined

        if (error) {
          Sentry.addBreadcrumb({
            category: 'driver.exit',
            message: `PiDriver exited with code ${code}`,
            level: 'error',
            data: { exitCode: code },
          })
        }

        this.failPending(error ?? new Error('PiDriver stopped'))

        if (this.currentTurn) {
          if (this.stopRequested || this.abortRequested) {
            this.finishTurn()
          } else {
            this.finishTurn(error ?? new Error('PiDriver exited unexpectedly'))
          }
        }

        this.readyPromise = null
        this.stopRequested = false
        this.abortRequested = false
      })

      this.process.on('error', (error) => {
        this.process = null
        this.readyPromise = null
        this.failPending(error)
        Sentry.captureException(error, { tags: { driver: this.driverName } })
        this.finishTurn(error)
      })

      const state = await this.sendRequest('get_state', { type: 'get_state' })
      const data = state.data as { sessionId?: unknown } | undefined
      const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : null
      if (sessionId && sessionId !== this.sessionId) {
        this.sessionId = sessionId
        this.options.onSessionId?.(sessionId)
      }
    })()

    try {
      await this.readyPromise
    } catch (error) {
      this.readyPromise = null
      this.cleanupProcess()
      throw error
    }
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''

    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (!line.trim()) continue

      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }

      if (parsed.type === 'response') {
        this.handleResponse(parsed as unknown as JsonRpcLikeResponse)
        continue
      }

      this.handleEvent(parsed)
    }
  }

  private handleResponse(response: JsonRpcLikeResponse): void {
    const id = response.id
    if (!id) return

    const pending = this.pending.get(id)
    if (!pending) return

    clearTimeout(pending.timeout)
    this.pending.delete(id)

    if (!response.success) {
      pending.reject(new Error(response.error ?? `${response.command} failed`))
      return
    }

    pending.resolve(response)
  }

  private handleEvent(data: Record<string, unknown>): void {
    if (!this.currentTurn) return

    for (const event of this.parseEvent(data)) {
      this.currentTurn.onEvent(event)
    }

    if (data.type === 'agent_end') {
      this.finishTurn()
    }
  }

  private parseEvent(data: Record<string, unknown>): OutputEvent[] {
    const type = data.type as string | undefined
    const events: OutputEvent[] = []

    switch (type) {
      case 'message_update': {
        const assistantMessageEvent = data.assistantMessageEvent as Record<string, unknown> | undefined
        const eventType = assistantMessageEvent?.type as string | undefined
        if (eventType === 'text_delta') {
          const delta = assistantMessageEvent?.delta as string | undefined
          if (delta) events.push({ type: 'text', content: delta })
        } else if (eventType === 'thinking_delta') {
          const delta = assistantMessageEvent?.delta as string | undefined
          if (delta) events.push({ type: 'thinking', content: delta, metadata: { type: 'thinking' } })
        } else if (eventType === 'error') {
          const error = assistantMessageEvent?.error as Record<string, unknown> | undefined
          const message = (error?.errorMessage as string | undefined) ?? (error?.message as string | undefined) ?? 'Pi execution failed'
          events.push({ type: 'error', content: message })
        }
        break
      }

      case 'tool_execution_start': {
        const toolCallId = data.toolCallId as string | undefined
        const toolName = (data.toolName as string | undefined) ?? 'tool'
        const args = (data.args as Record<string, unknown> | undefined) ?? {}
        events.push({
          type: 'tool_call',
          content: toolName,
          metadata: { type: 'tool_call', id: toolCallId, name: toolName, input: args },
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = data.toolCallId as string | undefined
        events.push({
          type: 'tool_result',
          content: summarizeToolResult(data.result),
          metadata: {
            type: 'tool_result',
            tool_use_id: toolCallId,
            is_error: data.isError === true,
          },
        })
        break
      }

      case 'turn_end': {
        const message = data.message as Record<string, unknown> | undefined
        const usage = message?.usage as Record<string, unknown> | undefined
        const inputTokens = Number(usage?.input ?? 0)
        const outputTokens = Number(usage?.output ?? 0)
        const contextWindow = inputTokens + outputTokens
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

        const stopReason = message?.stopReason as string | undefined
        const errorMessage = message?.errorMessage as string | undefined
        if ((stopReason === 'error' || stopReason === 'aborted') && errorMessage) {
          events.push({ type: 'error', content: errorMessage })
        }
        break
      }

      default:
        break
    }

    return events
  }

  private async sendRequest(
    command: string,
    payload: Record<string, unknown>,
    timeoutMs = 20_000
  ): Promise<JsonRpcLikeResponse> {
    const id = `pi-${this.nextRequestId++}`

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for Pi ${command}`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timeout })

      if (!this.process?.stdin?.writable) {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(new Error('Cannot write to Pi RPC stdin'))
        return
      }

      this.process.stdin.write(`${JSON.stringify({ id, ...payload })}\n`)
    })
  }

  private finishTurn(error?: Error): void {
    if (!this.currentTurn) return
    const turn = this.currentTurn
    this.currentTurn = null

    if (error || this.stopRequested) {
      this.cleanupProcess()
    }

    turn.onDone(this.stopRequested ? undefined : error)
    this.stopRequested = false
    this.abortRequested = false
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private cleanupProcess(): void {
    this.failPending(new Error('Pi RPC stopped'))
    this.buffer = ''

    if (this.process && !this.process.killed) {
      try {
        this.process.kill()
      } catch {
        // ignore
      }
    }

    this.process = null
    this.readyPromise = null
  }
}
