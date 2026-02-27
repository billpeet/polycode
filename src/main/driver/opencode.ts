import { DriverOptions, MessageOptions } from './types'
import { OutputEvent } from '../../shared/types'
import { SpawnCommand } from './runner/types'
import { BaseDriver } from './base'

/**
 * Build the argv array for an `opencode run` invocation.
 * The prompt is passed via stdin to avoid shell escaping issues with newlines.
 *
 *   new:    run --format json [--model provider/model]
 *   resume: run --format json --session <sessionID> [--model provider/model]
 */
export function buildOpenCodeArgs(
  sessionId: string | null,
  model: string | undefined
): string[] {
  const args: string[] = ['run', '--format', 'json']
  if (sessionId) args.push('--session', sessionId)
  if (model) args.push('--model', model)
  return args
}

export class OpenCodeDriver extends BaseDriver {
  /** OpenCode session ID used for session resumption (stored as claude_session_id in DB). */
  private sessionId: string | null = null

  constructor(options: DriverOptions) {
    super(options)
    if (options.initialSessionId) {
      this.sessionId = options.initialSessionId
    }
  }

  get driverName(): string { return 'OpenCodeDriver' }

  protected buildCommand(
    content: string,
    _runnerType: 'local' | 'wsl' | 'ssh',
    _options?: MessageOptions  // plan mode is Claude-specific; ignored for OpenCode
  ): SpawnCommand {
    // OpenCode always reads the prompt from stdin — no positional prompt arg.
    // No preamble needed (opencode is typically installed as a standalone binary).
    return {
      binary: 'opencode',
      args: buildOpenCodeArgs(this.sessionId, this.options.model),
      workDir: this.options.workingDir,
      stdinContent: content,
    }
  }

  protected parseEvent(data: Record<string, unknown>): OutputEvent[] {
    // OpenCode --format json emits newline-delimited JSON with a `type` field.
    // Every event carries `sessionID` and `timestamp` at the top level.
    // See: https://opencode.ai/docs/cli/
    const type = data.type as string | undefined
    const events: OutputEvent[] = []

    // Capture sessionID on first occurrence — used for subsequent --session resumption.
    const sid = data.sessionID as string | undefined
    if (sid && !this.sessionId) {
      this.sessionId = sid
      this.options.onSessionId?.(sid)
    }

    switch (type) {
      case 'text': {
        // Text output from the assistant.
        // Shape: { type: "text", sessionID, timestamp, part: { type: "text", text: string, ... } }
        const part = data.part as Record<string, unknown> | undefined
        const text = part?.text as string | undefined
        if (text) {
          events.push({ type: 'text', content: text })
        }
        break
      }

      case 'tool_use': {
        // A tool invocation that has completed or errored.
        // Shape: { type: "tool_use", sessionID, timestamp, part: ToolPart }
        // ToolPart: { id, sessionID, messageID, type: "tool", callID, tool, state: ToolState }
        // ToolState is discriminated by status: "pending" | "running" | "completed" | "error"
        const part = data.part as Record<string, unknown> | undefined
        if (!part) break

        const toolName = (part.tool as string | undefined) ?? 'tool'
        const callId = (part.callID as string | undefined) ?? (part.id as string | undefined) ?? ''
        const state = part.state as Record<string, unknown> | undefined
        const status = state?.status as string | undefined
        const input = (state?.input as Record<string, unknown> | undefined) ?? {}

        // Emit tool_call so the UI shows the tool invocation with name and input args.
        events.push({
          type: 'tool_call',
          content: toolName,
          metadata: { type: 'tool_call', name: toolName, input, id: callId },
        })

        // Emit tool_result with the final output or error payload.
        if (status === 'completed') {
          const output = (state?.output as string | undefined) ?? ''
          events.push({
            type: 'tool_result',
            content: output,
            metadata: { type: 'tool_result', tool_use_id: callId },
          })
        } else if (status === 'error') {
          const errorMsg = (state?.error as string | undefined) ?? ''
          events.push({
            type: 'tool_result',
            content: errorMsg,
            metadata: { type: 'tool_result', tool_use_id: callId, is_error: true },
          })
        }
        // status === 'pending' | 'running': tool_use events are only emitted by opencode
        // once the tool has finished, so this branch is not expected in practice.
        break
      }

      case 'error': {
        // Session-level error.
        // Shape: { type: "error", sessionID, timestamp, error: { message: string, ... } }
        const error = data.error as Record<string, unknown> | string | undefined
        const message =
          typeof error === 'string'
            ? error
            : (error?.message as string | undefined) ?? 'Unknown OpenCode error'
        events.push({ type: 'error', content: String(message) })
        break
      }

      // step_start, step_finish, reasoning — internal orchestration events not surfaced to the user
      default:
        break
    }

    return events
  }
}
