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

    const args = [
      '--output-format', 'stream-json',
      '--verbose',
      '--print',
    ]

    // Plan mode uses --permission-mode plan (no bypass)
    // Normal mode bypasses permissions but still allows Claude to enter plan mode
    if (planMode) {
      args.push('--permission-mode', 'plan')
    } else {
      args.push('--dangerously-skip-permissions')
    }
    if (this.options.model) {
      args.push('--model', this.options.model)
    }
    if (this.sessionId) {
      args.push('--resume', this.sessionId)
    }

    // For WSL and Windows local, pass prompt via stdin to avoid escaping issues:
    // - WSL: wsl.exe receives a Windows command-line string; newlines and quotes
    //   in the prompt break the inner bash command.
    // - Windows local: cmd.exe via shell:true mangles double quotes and special chars.
    const isWindows = process.platform === 'win32'
    const useStdin = runnerType === 'wsl' || (runnerType === 'local' && isWindows)

    if (useStdin) {
      return {
        binary: 'claude',
        args,  // no prompt in args — content goes via stdin
        workDir: this.options.workingDir,
        stdinContent: content,
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

      default:
        break
    }

    return events
  }
}
