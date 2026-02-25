import { spawn, ChildProcess } from 'child_process'
import { CLIDriver, DriverOptions, MessageOptions } from './types'
import { OutputEvent } from '../../shared/types'

/** Escape a string for use inside single quotes in a POSIX shell. */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

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
 */
export function winQuote(s: string): string {
  if (!/[ \t"&|<>^]/.test(s)) return s
  return '"' + s.replace(/"/g, '\\"') + '"'
}

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

export class CodexDriver implements CLIDriver {
  private process: ChildProcess | null = null
  private options: DriverOptions
  /** Codex thread_id used for session resumption (stored as claude_session_id in DB). */
  private codexThreadId: string | null = null
  private buffer = ''
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
    this.options = options
    if (options.initialSessionId) {
      this.codexThreadId = options.initialSessionId
    }
  }

  sendMessage(
    content: string,
    onEvent: (event: OutputEvent) => void,
    onDone: (error?: Error) => void,
    _options?: MessageOptions  // plan mode is Claude-specific; ignored for Codex
  ): void {
    const args = buildCodexArgs(this.codexThreadId, this.options.model, content)

    this.buffer = ''
    this.streamedItemIds.clear()
    this.announcedItemIds.clear()
    this.completedItemIds.clear()

    const ssh = this.options.ssh
    const wsl = this.options.wsl
    if (ssh) {
      // ── SSH remote spawn ────────────────────────────────────────────────────
      const workDir = this.options.workingDir
      const cdTarget = workDir.startsWith('~')
        ? '"$HOME"' + shellEscape(workDir.slice(1))
        : shellEscape(workDir)
      // Like WSL, login/non-interactive shells may skip node manager init.
      // Load common managers explicitly so `codex` resolves on remote hosts.
      const loadNodeManagers = [
        '[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"',
        '[ -d "$HOME/.volta/bin" ] && export PATH="$HOME/.volta/bin:$PATH"',
        '[ -d "$HOME/.bun/bin" ] && export PATH="$HOME/.bun/bin:$PATH"',
        '[ -d "$HOME/.npm-global/bin" ] && export PATH="$HOME/.npm-global/bin:$PATH"',
        'command -v fnm &>/dev/null && eval "$(fnm env 2>/dev/null)"',
      ].join('; ')
      // Resolve codex explicitly for environments where PATH differs between
      // interactive and non-interactive/login shells.
      const resolveCodex = [
        'CODEX_BIN=""',
        'command -v codex >/dev/null 2>&1 && CODEX_BIN="$(command -v codex)"',
        'case "$CODEX_BIN" in /mnt/c/*) CODEX_BIN="";; esac',
        '[ -z "$CODEX_BIN" ] && [ -x "$HOME/.local/bin/codex" ] && CODEX_BIN="$HOME/.local/bin/codex"',
        '[ -z "$CODEX_BIN" ] && [ -x "$HOME/.npm/bin/codex" ] && CODEX_BIN="$HOME/.npm/bin/codex"',
        '[ -z "$CODEX_BIN" ] && [ -x "$HOME/.npm-global/bin/codex" ] && CODEX_BIN="$HOME/.npm-global/bin/codex"',
        '[ -z "$CODEX_BIN" ] && [ -x "$HOME/.volta/bin/codex" ] && CODEX_BIN="$HOME/.volta/bin/codex"',
        '[ -z "$CODEX_BIN" ] && [ -x "$HOME/.bun/bin/codex" ] && CODEX_BIN="$HOME/.bun/bin/codex"',
        '[ -z "$CODEX_BIN" ] && [ -d "$HOME/.nvm/versions/node" ] && CODEX_BIN="$(ls -1d "$HOME"/.nvm/versions/node/*/bin/codex 2>/dev/null | tail -n 1)"',
        '[ -n "$CODEX_BIN" ] || { echo "codex not found; PATH=$PATH" >&2; exit 127; }',
      ].join('; ')
      const innerCmd = `${loadNodeManagers}; ${resolveCodex}; cd ${cdTarget} && "$CODEX_BIN" ${args.map(shellEscape).join(' ')}`
      const remoteCmd = `bash -lc ${shellEscape(innerCmd)}`
      const sshArgs = [
        '-T',
        '-o', 'ConnectTimeout=10',
        '-o', 'StrictHostKeyChecking=accept-new',
      ]
      if (process.platform !== 'win32') {
        sshArgs.push(
          '-o', 'ControlMaster=auto',
          '-o', 'ControlPath=/tmp/polycode-ssh-%r@%h:%p',
          '-o', 'ControlPersist=300',
        )
      }
      if (ssh.port) sshArgs.push('-p', String(ssh.port))
      if (ssh.keyPath) sshArgs.push('-i', ssh.keyPath)
      sshArgs.push(`${ssh.user}@${ssh.host}`, remoteCmd)

      console.log('[CodexDriver] Spawning SSH: ssh', sshArgs.join(' '))

      this.process = spawn('ssh', sshArgs, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.process.stdin?.end()
    } else if (wsl) {
      // ── WSL spawn ────────────────────────────────────────────────────────────
      const workDir = this.options.workingDir
      const cdTarget = workDir.startsWith('~')
        ? '"$HOME"' + shellEscape(workDir.slice(1))
        : shellEscape(workDir)
      // Load node version managers directly, bypassing .bashrc's interactive guard.
      //
      // Problem: bash -lc is a login shell but NOT interactive, so .bashrc typically
      // bails out immediately via `case $- in *i*) ;; *) return;; esac` before
      // reaching nvm/volta/fnm setup. WSL's Windows PATH interop then causes
      // `codex` to resolve to the Windows-installed wrapper at
      // /mnt/c/Program Files/nodejs/codex, which fails because `node` is not found.
      //
      // Fix: source the version manager init scripts directly by well-known path,
      // which works regardless of .bashrc interactive guards.
      const loadNodeManagers = [
        '[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"',
        '[ -d "$HOME/.volta/bin" ] && export PATH="$HOME/.volta/bin:$PATH"',
        '[ -d "$HOME/.bun/bin" ] && export PATH="$HOME/.bun/bin:$PATH"',
        '[ -d "$HOME/.npm-global/bin" ] && export PATH="$HOME/.npm-global/bin:$PATH"',
        'command -v fnm &>/dev/null && eval "$(fnm env 2>/dev/null)"',
      ].join('; ')
      const innerCmd = `${loadNodeManagers}; cd ${cdTarget} && codex ${args.map(shellEscape).join(' ')}`

      const wslArgs = ['-d', wsl.distro, '--', 'bash', '-lc', innerCmd]

      console.log('[CodexDriver] Spawning WSL: wsl', wslArgs.join(' '))

      this.process = spawn('wsl', wslArgs, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.process.stdin?.end()
    } else {
      // ── Local spawn ──────────────────────────────────────────────────────────
      console.log('[CodexDriver] Spawning: codex', args.join(' '))

      if (process.platform === 'win32') {
        // npm .cmd wrappers require shell:true on Windows. Node's default array
        // join doesn't individually quote args, so build the command string
        // ourselves with explicit double-quoting for args that contain spaces.
        const cmdStr = ['codex', ...args.map(winQuote)].join(' ')
        this.process = spawn(cmdStr, [], {
          cwd: this.options.workingDir,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } else {
        this.process = spawn('codex', args, {
          cwd: this.options.workingDir,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      }
    }

    let stderrBuffer = ''

    this.process.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      console.log('[CodexDriver] stdout chunk:', text.slice(0, 200))
      this.buffer += text
      this.processBuffer(onEvent)
    })

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      console.error('[CodexDriver] stderr:', text)
      stderrBuffer += text
    })

    this.process.on('close', (code) => {
      this.processBuffer(onEvent)
      this.process = null
      if (code !== 0 && code !== null) {
        console.error('[CodexDriver] Process exited with code', code)
        onDone(new Error(`Codex process exited with code ${code}${stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : ''}`))
      } else {
        onDone()
      }
    })

    this.process.on('error', (err) => {
      this.process = null
      onDone(err)
    })
  }

  stop(): void {
    if (this.process) {
      this.process.kill('SIGTERM')
      this.process = null
    }
  }

  isRunning(): boolean {
    return this.process !== null
  }

  private processBuffer(onEvent: (event: OutputEvent) => void): void {
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>
        const events = this.parseCodexEvent(parsed)
        for (const event of events) {
          onEvent(event)
        }
      } catch {
        // Non-JSON stdout line — silently skip
      }
    }
  }

  private parseCodexEvent(data: Record<string, unknown>): OutputEvent[] {
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
