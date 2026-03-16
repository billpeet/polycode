import { DriverOptions, MessageOptions } from './types'
import { OutputEvent } from '../../shared/types'
import { SpawnCommand } from './runner/types'
import { BaseDriver } from './base'

export class ClaudeDriver extends BaseDriver {
  private sessionId: string | null = null
  // Track tool IDs for special tools that we handle differently (e.g., AskUserQuestion, ExitPlanMode)
  private specialToolIds = new Set<string>()

  constructor(options: DriverOptions) {
    super(options)
    if (options.initialSessionId) {
      this.sessionId = options.initialSessionId
    }
  }

  get driverName(): string { return 'ClaudeDriver' }

  protected beforeSendMessage(): void {
    this.specialToolIds.clear()
  }

  protected buildCommand(content: string, runnerType: 'local' | 'wsl' | 'ssh', options?: MessageOptions): SpawnCommand {
    const planMode = options?.planMode ?? false
    const yoloMode = options?.yoloMode ?? this.options.yoloMode ?? false

    const args = [
      '--output-format', 'stream-json',
      '--verbose',
      '--print',
    ]

    // Plan mode uses --permission-mode plan (no bypass, no interactive approval).
    // Yolo mode bypasses all permission checks.
    // Default mode: use stream-json input so Claude Code can emit control_request
    // events on stdout and we can send control_response approvals on stdin.
    if (planMode) {
      args.push('--permission-mode', 'plan')
    } else if (yoloMode) {
      args.push('--dangerously-skip-permissions')
    } else {
      args.push('--input-format', 'stream-json')
    }
    if (this.options.model) {
      args.push('--model', this.options.model)
    }
    if (this.sessionId) {
      args.push('--resume', this.sessionId)
    }

    // Whether to use stdin for the prompt:
    // - WSL / Windows local: always (argv escaping is unreliable)
    // - stream-json input mode: always (prompt must be a JSON user message on stdin)
    // - POSIX local in yolo/plan mode: pass as argv arg
    const isWindows = process.platform === 'win32'
    const streamJsonInput = !planMode && !yoloMode
    const useStdin = runnerType === 'wsl' || (runnerType === 'local' && isWindows) || streamJsonInput

    if (useStdin) {
      // In stream-json input mode, the prompt must be a JSON user message.
      // In plain stdin mode (yolo/plan on Windows/WSL), pass raw text.
      const stdinContent = streamJsonInput
        ? JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
        : content
      return {
        binary: 'claude',
        args,
        workDir: this.options.workingDir,
        stdinContent,
        // Keep stdin open in stream-json mode so we can write control_response later
        keepStdinOpen: streamJsonInput,
      }
    } else {
      return {
        binary: 'claude',
        args: [...args, content],
        workDir: this.options.workingDir,
      }
    }
  }

  protected parseEvent(data: Record<string, unknown>): OutputEvent[] {
    const type = data.type as string | undefined
    const events: OutputEvent[] = []

    switch (type) {
      case 'system': {
        // Capture session_id from init event
        const subtype = data.subtype as string | undefined
        if (subtype === 'init') {
          const sid = data.session_id as string | undefined
          if (sid) {
            this.sessionId = sid
            this.options.onSessionId?.(sid)
          }
        }
        break
      }

      case 'assistant': {
        const message = data.message as Record<string, unknown> | undefined
        const contentBlocks = (message?.content ?? []) as Array<Record<string, unknown>>
        for (const block of contentBlocks) {
          const blockType = block.type as string | undefined
          if (blockType === 'thinking') {
            const thinking = (block.thinking ?? '') as string
            if (thinking) events.push({ type: 'thinking', content: thinking, metadata: { type: 'thinking' } })
          } else if (blockType === 'text') {
            const text = (block.text ?? '') as string
            if (text) events.push({ type: 'text', content: text })
          } else if (blockType === 'tool_use') {
            const toolName = (block.name as string) ?? 'unknown'
            const toolId = (block.id as string) ?? ''

            // Detect ExitPlanMode tool call — emit special plan_ready event
            if (toolName === 'ExitPlanMode') {
              if (toolId) this.specialToolIds.add(toolId)
              const input = block.input as Record<string, unknown> | undefined
              events.push({
                type: 'plan_ready',
                content: (input?.plan as string) ?? '',
                metadata: { ...block, type: 'plan_ready' } as Record<string, unknown>
              })
            } else if (toolName === 'AskUserQuestion') {
              // Detect AskUserQuestion tool call — emit question event
              // Track the tool ID so we can suppress its tool_result
              if (toolId) this.specialToolIds.add(toolId)
              const input = block.input as Record<string, unknown> | undefined
              events.push({
                type: 'question',
                content: JSON.stringify(input?.questions ?? []),
                metadata: { ...block, type: 'question', questions: input?.questions } as Record<string, unknown>
              })
            } else {
              events.push({
                type: 'tool_call',
                content: toolName,
                // Normalize type to 'tool_call' so DB round-trips preserve MessageBubble detection
                metadata: { ...block, type: 'tool_call' } as Record<string, unknown>
              })
            }
          }
        }
        break
      }

      case 'user': {
        const message = data.message as Record<string, unknown> | undefined
        const contentBlocks = (message?.content ?? []) as Array<Record<string, unknown>>
        for (const block of contentBlocks) {
          const blockType = block.type as string | undefined
          if (blockType === 'tool_result') {
            // Skip tool results for special tools (AskUserQuestion, ExitPlanMode)
            // These are handled via UI interactions, not shown as tool results
            const toolUseId = (block.tool_use_id as string) ?? ''
            if (toolUseId && this.specialToolIds.has(toolUseId)) {
              continue
            }

            // block.content is typically [{type:"text", text:"..."}] — extract plain text
            const raw = block.content
            let content: string
            if (Array.isArray(raw)) {
              content = raw
                .map((item: unknown) => {
                  const i = item as Record<string, unknown>
                  return i.type === 'text' ? String(i.text ?? '') : ''
                })
                .join('')
            } else if (typeof raw === 'string') {
              content = raw
            } else {
              content = JSON.stringify(raw ?? '')
            }
            events.push({
              type: 'tool_result',
              content,
              metadata: block as Record<string, unknown>
            })
          }
        }
        break
      }

      case 'result': {
        const subtype = data.subtype as string | undefined
        // Always try to capture session_id from result
        const sid = data.session_id as string | undefined
        if (sid) {
          this.sessionId = sid
          this.options.onSessionId?.(sid)
        }
        // In --input-format stream-json mode stdin is kept open so we can
        // (in principle) send follow-up messages.  Close it now so the process
        // knows the conversation is over and exits naturally.
        this.process?.stdin?.end()

        if (subtype === 'error') {
          events.push({
            type: 'error',
            content: (data.error as string) ?? 'Unknown error'
          })
        } else if (subtype === 'success') {
          // Extract token usage from the result event
          const usage = data.usage as { input_tokens?: number; output_tokens?: number } | undefined
          if (usage && (usage.input_tokens || usage.output_tokens)) {
            events.push({
              type: 'usage',
              content: '',
              metadata: {
                input_tokens: usage.input_tokens ?? 0,
                output_tokens: usage.output_tokens ?? 0,
              }
            })
          }
        }
        break
      }

      case 'rate_limit_event': {
        const info = data.rate_limit_info as Record<string, unknown> | undefined
        if (info) {
          events.push({
            type: 'rate_limit',
            content: '',
            metadata: {
              status: info.status ?? 'unknown',
              resetsAt: info.resetsAt,
              rateLimitType: info.rateLimitType,
              utilization: info.utilization,
              surpassedThreshold: info.surpassedThreshold,
              isUsingOverage: info.isUsingOverage,
              overageStatus: info.overageStatus,
              overageDisabledReason: info.overageDisabledReason,
            }
          })
        }
        break
      }

      // ── control_request (DISABLED — CLI bug, tracked in open issues) ──────────
      //
      // Claude Code CLI is designed to emit a `control_request` event when a tool
      // requires user approval, then pause and wait for a `control_response` on
      // stdin.  This would allow true mid-stream permission interception.
      //
      // Confirmed protocol shape (from Agent SDK source + anthropics/claude-code#34046):
      //
      //   RECEIVE from CLI stdout:
      //   {
      //     "type": "control_request",
      //     "request_id": "<uuid>",
      //     "request": {
      //       "subtype": "can_use_tool",
      //       "tool_name": "Write",
      //       "tool_use_id": "toolu_...",
      //       "input": { "file_path": "...", ... }
      //     }
      //   }
      //
      //   SEND to CLI stdin (via sendControlResponse / writeToStdin):
      //   {
      //     "type": "control_response",
      //     "response": {
      //       "subtype": "success",
      //       "request_id": "<same uuid>",
      //       "response": { "behavior": "allow" }          // or "deny"
      //     }
      //   }
      //
      // As of CLI v2.1.74+ the event is NOT emitted even with --permission-prompt-tool stdio.
      // The infrastructure is already in place (keepStdinOpen, writeToStdin, sendControlResponse).
      // To re-enable when the bug is fixed, uncomment the block below and add
      // 'permission_request' back to OutputEventType in shared/types.ts.
      //
      // case 'control_request': {
      //   const request = data.request as Record<string, unknown> | undefined
      //   const requestId = data.request_id as string | undefined
      //   if (request?.subtype === 'can_use_tool' && requestId) {
      //     const toolName = (request.tool_name as string) || 'Unknown tool'
      //     const toolInput = (request.input as Record<string, unknown>) || {}
      //     const toolUseId = (request.tool_use_id as string) || ''
      //     events.push({
      //       type: 'permission_request',
      //       content: toolName,
      //       metadata: { type: 'permission_request', requestId, toolName, toolInput, toolUseId }
      //     })
      //   }
      //   break
      // }

      default:
        break
    }

    return events
  }

  // When the control_request bug is fixed, re-enable this override:
  // override sendControlResponse(requestId: string, behavior: 'allow' | 'deny', message?: string): void {
  //   const response = {
  //     type: 'control_response',
  //     response: {
  //       subtype: 'success',
  //       request_id: requestId,
  //       response: behavior === 'allow'
  //         ? { behavior: 'allow' }
  //         : { behavior: 'deny', message: message ?? 'User denied permission' },
  //     },
  //   }
  //   this.writeToStdin(JSON.stringify(response))
  // }

}
