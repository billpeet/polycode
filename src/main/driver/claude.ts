import { spawn, ChildProcess } from 'child_process'
import { CLIDriver, DriverOptions, MessageOptions } from './types'
import { OutputEvent } from '../../shared/types'

/** Escape a string for use inside single quotes in a POSIX shell. */
function shellEscape(s: string): string {
  // Replace each ' with '\'' (end quote, escaped quote, start quote)
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

export class ClaudeDriver implements CLIDriver {
  private process: ChildProcess | null = null
  private options: DriverOptions
  private sessionId: string | null = null
  private buffer = ''
  // Track tool IDs for special tools that we handle differently (e.g., AskUserQuestion, ExitPlanMode)
  private specialToolIds = new Set<string>()

  constructor(options: DriverOptions) {
    this.options = options
    if (options.initialSessionId) {
      this.sessionId = options.initialSessionId
    }
  }

  sendMessage(
    content: string,
    onEvent: (event: OutputEvent) => void,
    onDone: (error?: Error) => void,
    options?: MessageOptions
  ): void {
    const planMode = options?.planMode ?? false

    // Build args: first message vs resume
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
    args.push(content)

    this.buffer = ''
    this.specialToolIds.clear()

    const ssh = this.options.ssh
    if (ssh) {
      // ── SSH remote spawn ──────────────────────────────────────────────────
      // ~ doesn't expand inside single quotes, so replace with $HOME unquoted
      const workDir = this.options.workingDir
      const cdTarget = workDir.startsWith('~')
        ? '"$HOME"' + shellEscape(workDir.slice(1))
        : shellEscape(workDir)
      // Wrap in login shell so .profile/.bashrc are sourced (makes `claude` available in PATH)
      const innerCmd = `cd ${cdTarget} && claude ${args.map(shellEscape).join(' ')}`
      const remoteCmd = `bash -lc ${shellEscape(innerCmd)}`
      const sshArgs = [
        '-T',
        '-o', 'ConnectTimeout=10',
        '-o', 'StrictHostKeyChecking=accept-new',
      ]
      // ControlMaster multiplexing is not supported on Windows OpenSSH
      if (process.platform !== 'win32') {
        sshArgs.push(
          '-o', 'ControlMaster=auto',
          '-o', 'ControlPath=/tmp/polycode-ssh-%r@%h:%p',
          '-o', 'ControlPersist=300',
        )
      }
      if (ssh.port) {
        sshArgs.push('-p', String(ssh.port))
      }
      if (ssh.keyPath) {
        sshArgs.push('-i', ssh.keyPath)
      }
      sshArgs.push(`${ssh.user}@${ssh.host}`, remoteCmd)

      console.log('[ClaudeDriver] Spawning SSH:', 'ssh', sshArgs.join(' '))

      this.process = spawn('ssh', sshArgs, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      // Close stdin immediately — signals EOF to SSH so it doesn't hang
      // waiting for interactive input (passwords, key passphrases, etc.)
      this.process.stdin?.end()
    } else if (this.options.wsl) {
      // ── WSL spawn ──────────────────────────────────────────────────────────
      const wsl = this.options.wsl
      const workDir = this.options.workingDir
      const cdTarget = workDir.startsWith('~')
        ? '"$HOME"' + shellEscape(workDir.slice(1))
        : shellEscape(workDir)
      const innerCmd = `cd ${cdTarget} && claude ${args.map(shellEscape).join(' ')}`

      const wslArgs = ['-d', wsl.distro, '--', 'bash', '-lc', innerCmd]

      console.log('[ClaudeDriver] Spawning WSL:', 'wsl', wslArgs.join(' '))

      this.process = spawn('wsl', wslArgs, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.process.stdin?.end()
    } else {
      // ── Local spawn ───────────────────────────────────────────────────────
      console.log('[ClaudeDriver] Spawning:', 'claude', args.join(' '))

      this.process = spawn('claude', args, {
        cwd: this.options.workingDir,
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    }

    let stderrBuffer = ''

    this.process.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      console.log('[ClaudeDriver] stdout chunk:', text.slice(0, 200))
      this.buffer += text
      this.processBuffer(onEvent)
    })

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      console.error('[ClaudeDriver] stderr:', text)
      stderrBuffer += text
    })

    this.process.on('close', (code) => {
      // Flush any remaining buffer content
      this.processBuffer(onEvent)
      this.process = null
      if (code !== 0 && code !== null) {
        console.error('[ClaudeDriver] Process exited with code', code)
        if (stderrBuffer.trim()) {
          console.error('[ClaudeDriver] stderr:', stderrBuffer)
        }
        onDone(new Error(`Claude process exited with code ${code}${stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : ''}`))
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
    // Keep the incomplete last line in the buffer
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>
        const events = this.parseClaudeEvent(parsed)
        for (const event of events) {
          onEvent(event)
        }
      } catch {
        // Non-JSON stdout line — silently skip (not raw text)
      }
    }
  }

  private parseClaudeEvent(data: Record<string, unknown>): OutputEvent[] {
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
          if (blockType === 'text') {
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

      default:
        break
    }

    return events
  }
}
