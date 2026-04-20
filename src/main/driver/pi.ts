import { DriverOptions, MessageOptions } from './types'
import { OutputEvent } from '../../shared/types'
import { SpawnCommand } from './runner/types'
import { BaseDriver } from './base'

export function buildPiArgs(
  sessionId: string | null,
  model: string | undefined,
  content: string,
): string[] {
  const args: string[] = ['--mode', 'json']
  if (sessionId) args.push('--session', sessionId)
  if (model) args.push('--model', model)
  args.push(content)
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

export class PiDriver extends BaseDriver {
  private sessionId: string | null = null

  constructor(options: DriverOptions) {
    super(options)
    if (options.initialSessionId) {
      this.sessionId = options.initialSessionId
    }
  }

  get driverName(): string { return 'PiDriver' }

  protected buildCommand(
    content: string,
    _runnerType: 'local' | 'wsl' | 'ssh',
    _options?: MessageOptions
  ): SpawnCommand {
    return {
      binary: 'pi',
      args: buildPiArgs(this.sessionId, this.options.model, content),
      workDir: this.options.workingDir,
    }
  }

  protected parseEvent(data: Record<string, unknown>): OutputEvent[] {
    const type = data.type as string | undefined
    const events: OutputEvent[] = []

    if (type === 'session') {
      const id = data.id as string | undefined
      if (id && !this.sessionId) {
        this.sessionId = id
        this.options.onSessionId?.(id)
      }
      return events
    }

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
}
