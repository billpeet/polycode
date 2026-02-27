import { DriverOptions, MessageOptions } from './types'
import { OutputEvent } from '../../shared/types'
import { SpawnCommand } from './runner/types'
import { LOAD_NODE_MANAGERS, RESOLVE_CODEX_BIN } from './runner/utils'
import { BaseDriver } from './base'

/**
 * Given a raw command string from a Codex command_execution item, return a
 * display-friendly name and the inner command to show in the UI.
 *
 * Commands are typically wrapped as:  /bin/bash -lc "actual command here"
 * We strip the wrapper so the UI shows "Bash" + the inner command, mirroring
 * how Claude Code's Bash tool is displayed.
 */
export function parseBashCommand(raw: string): { name: string; innerCmd: string } {
  const m = raw.match(/^(?:\/bin\/bash|bash)\s+-lc\s+([\s\S]+)$/)
  if (!m) return { name: 'Shell', innerCmd: raw }
  const arg = m[1].trim()
  // Strip balanced outer single or double quotes from the shell argument.
  const innerCmd =
    arg.length >= 2 &&
    ((arg[0] === '"' && arg[arg.length - 1] === '"') ||
      (arg[0] === "'" && arg[arg.length - 1] === "'"))
      ? arg.slice(1, -1)
      : arg
  return { name: 'Bash', innerCmd }
}

/** Build a tool_call event for a Codex command_execution item. */
function makeToolCallEvent(item: Record<string, unknown>): { content: string; metadata: Record<string, unknown> } {
  const rawCommand = item.command as string | undefined
  if (rawCommand) {
    const { name, innerCmd } = parseBashCommand(rawCommand)
    // content = first line of inner command (short label for DB / fallback rendering)
    const label = innerCmd.split('\n')[0].slice(0, 120) || name
    return {
      content: label,
      metadata: { ...item, type: 'tool_call', name, input: { command: innerCmd } },
    }
  }
  // Non-command items (file_edit, web_search, …) — use path/label/type as label
  const label =
    (item.path as string | undefined) ??
    (item.label as string | undefined) ??
    (item.type as string | undefined) ??
    'tool'
  return {
    content: label,
    metadata: { ...item, type: 'tool_call' },
  }
}

/**
 * Quote a single argument for cmd.exe (Windows shell).
 * When spawn uses shell:true on Windows, Node joins args with plain spaces,
 * so arguments with spaces must be explicitly double-quoted.
 *
 * Re-exported from runner/utils for backwards compatibility with existing consumers.
 */
export { winQuote } from './runner/utils'

/**
 * Build the argv array for a `codex exec` invocation.
 * All options must precede positional args so the clap-based parser
 * doesn't mistake them for part of the prompt.
 *
 *   new:    exec --json --full-auto [-c model=X] <prompt>
 *   resume: exec --json resume --full-auto [-c model=X] <session_id> <prompt>
 */
export function buildCodexArgs(
  codexThreadId: string | null,
  model: string | undefined,
  content: string
): string[] {
  const args: string[] = ['exec', '--json']
  if (codexThreadId) args.push('resume')
  args.push('--full-auto')
  if (model) args.push('-c', `model=${model}`)
  if (codexThreadId) args.push(codexThreadId)
  args.push(content)
  return args
}

export class CodexDriver extends BaseDriver {
  /** Codex thread_id used for session resumption (stored as claude_session_id in DB). */
  private codexThreadId: string | null = null
  /**
   * Item IDs that have received at least one streaming delta this turn.
   * Used to suppress the duplicate full text in item.completed for streamed items.
   */
  private streamedItemIds = new Set<string>()
  /**
   * Item IDs for which item.started already emitted a tool_call event.
   * Used to suppress the redundant tool_call that item.completed would otherwise emit,
   * and to de-duplicate replayed item.started events (Codex sometimes re-emits items
   * after turn.completed).
   */
  private announcedItemIds = new Set<string>()
  /**
   * Item IDs that have already been fully processed by item.completed.
   * Prevents double-emitting tool_result when Codex re-emits completed items.
   */
  private completedItemIds = new Set<string>()

  constructor(options: DriverOptions) {
    super(options)
    if (options.initialSessionId) {
      this.codexThreadId = options.initialSessionId
    }
  }

  get driverName(): string { return 'CodexDriver' }

  protected beforeSendMessage(): void {
    this.streamedItemIds.clear()
    this.announcedItemIds.clear()
    this.completedItemIds.clear()
  }

  protected buildCommand(
    content: string,
    runnerType: 'local' | 'wsl' | 'ssh',
    _options?: MessageOptions  // plan mode is Claude-specific; ignored for Codex
  ): SpawnCommand {
    const args = buildCodexArgs(this.codexThreadId, this.options.model, content)

    if (runnerType === 'wsl' || runnerType === 'ssh') {
      // For WSL/SSH: load node managers and resolve codex binary explicitly,
      // since non-interactive login shells may not have the right PATH.
      const preamble = [LOAD_NODE_MANAGERS, RESOLVE_CODEX_BIN].join('; ')
      return {
        binary: '"$CODEX_BIN"',  // set by RESOLVE_CODEX_BIN
        args,
        workDir: this.options.workingDir,
        preamble,
      }
    } else {
      // Local: runner handles Windows shell:true + winQuote internally
      return {
        binary: 'codex',
        args,
        workDir: this.options.workingDir,
      }
    }
  }

  protected parseEvent(data: Record<string, unknown>): OutputEvent[] {
    // Codex --json emits newline-delimited JSON with a `type` field.
    // The schema is not formally published and has changed across versions;
    // see: https://github.com/openai/codex/issues/1673
    // We handle the types observed in practice and fall back gracefully.
    const type = data.type as string | undefined
    const events: OutputEvent[] = []

    switch (type) {
      case 'thread.started': {
        // Emitted once at start; thread_id is used for session resumption.
        const tid = data.thread_id as string | undefined
        if (tid) {
          this.codexThreadId = tid
          this.options.onSessionId?.(tid)
        }
        break
      }

      case 'item.completed': {
        // A completed item. The item payload is nested under `data.item`.
        //
        // Observed shapes:
        //   agent_message:     {"item":{"id":"item_0","type":"agent_message","text":"..."}}
        //   command_execution: {"item":{"id":"item_1","type":"command_execution","command":"...","aggregate_output":"..."}}
        //   reasoning:         {"item":{"id":"item_2","type":"reasoning","text":"..."}}   ← skip (internal)
        const item = data.item as Record<string, unknown> | undefined
        if (!item) break
        const itemId = item.id as string | undefined
        const itemType = item.type as string | undefined

        if (itemType === 'agent_message') {
          // Skip if we already emitted content incrementally via delta events.
          if (!itemId || !this.streamedItemIds.has(itemId)) {
            const text = item.text as string | undefined
            if (text) {
              events.push({ type: 'text', content: text })
            }
          }
        } else if (itemType === 'reasoning') {
          // Internal model chain-of-thought — not surfaced to the user.
        } else if (itemType) {
          // Guard against replayed item.completed events (Codex sometimes re-emits
          // items from the current turn after turn.completed).
          if (itemId && this.completedItemIds.has(itemId)) break
          if (itemId) this.completedItemIds.add(itemId)

          // Tool action completed (command_execution, file_edit, web_search, …).
          // item.started already emitted the tool_call for this item; only emit
          // tool_result here. If item.started was not fired, emit tool_call too.
          const alreadyAnnounced = itemId ? this.announcedItemIds.has(itemId) : false
          if (!alreadyAnnounced) {
            const { content, metadata } = makeToolCallEvent(item)
            events.push({ type: 'tool_call', content, metadata })
          }
          // aggregated_output is the field Codex uses for the full command output.
          const output =
            (item.aggregated_output as string | undefined) ??
            (item.aggregate_output as string | undefined) ??
            (item.output as string | undefined) ??
            (item.content as string | undefined)
          // Always emit tool_result so pairMessages() can mark the call as DONE,
          // even when the command produced no output (e.g. write-to-file via heredoc).
          events.push({
            type: 'tool_result',
            content: output ?? '',
            // type:'tool_result' and tool_use_id allow pairMessages() in the
            // renderer to pair this result with its matching tool_call bubble.
            metadata: { ...item, type: 'tool_result', tool_use_id: itemId } as Record<string, unknown>,
          })
        }
        break
      }

      case 'item.agentMessage.delta': {
        // Streaming text delta — emitted during long responses before item.completed.
        const delta = data.delta as string | undefined
        if (delta) {
          // Track the item ID so item.completed suppresses the duplicate full text.
          const itemId = data.item_id as string | undefined
          if (itemId) this.streamedItemIds.add(itemId)
          events.push({ type: 'text', content: delta })
        }
        break
      }

      case 'item.started': {
        // A tool action is beginning — emit tool_call immediately so the UI
        // shows activity before the result arrives.
        // Real shape: {"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"..."}}
        const item = data.item as Record<string, unknown> | undefined
        if (!item) break
        const itemId = item.id as string | undefined
        // Skip replayed item.started events (Codex re-emits items after turn.completed).
        if (itemId && this.announcedItemIds.has(itemId)) break
        const itemType = item.type as string | undefined
        if (itemType && itemType !== 'agent_message' && itemType !== 'reasoning') {
          const { content, metadata } = makeToolCallEvent(item)
          events.push({ type: 'tool_call', content, metadata })
          // Mark so item.completed doesn't emit a duplicate tool_call.
          if (itemId) this.announcedItemIds.add(itemId)
        }
        break
      }

      case 'item.commandExecution.outputDelta':
      case 'item.fileChange.outputDelta': {
        // Streaming output delta from a tool action.
        const delta = data.delta as string | undefined
        if (delta) {
          events.push({
            type: 'tool_result',
            content: delta,
            metadata: data as Record<string, unknown>,
          })
        }
        break
      }

      case 'turn.completed': {
        // End of a turn — extract token usage if present.
        const usage = data.usage as { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number } | undefined
        if (usage && (usage.input_tokens || usage.output_tokens)) {
          events.push({
            type: 'usage',
            content: '',
            metadata: {
              input_tokens: usage.input_tokens ?? 0,
              output_tokens: usage.output_tokens ?? 0,
            },
          })
        }
        break
      }

      case 'turn.failed':
      case 'error': {
        const message =
          (data.message as string | undefined) ??
          (data.error as string | undefined) ??
          'Unknown Codex error'
        events.push({ type: 'error', content: String(message) })
        break
      }

      // turn.started — no-op
      default:
        break
    }

    return events
  }
}
