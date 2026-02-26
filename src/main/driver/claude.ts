import { spawn, ChildProcess } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as Sentry from '@sentry/electron/main'
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
    if (this.process) {
      console.warn('[ClaudeDriver] sendMessage called while process is already running — ignoring')
      return
    }

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
      const isWindows = process.platform === 'win32'

      if (isWindows) {
        // On Windows, shell: true routes through cmd.exe which mangles
        // double quotes and other special characters in the prompt.
        // Instead, omit the prompt from argv and pipe it via stdin so
        // claude reads the prompt from stdin (--print reads stdin when
        // no positional prompt is given).
        const stdinArgs = args.slice(0, -1)
        const workDir = this.options.workingDir
        const isUNC = workDir.startsWith('\\\\')

        if (isUNC) {
          // cmd.exe rejects UNC paths as cwd. pushd maps UNC to a drive letter,
          // but passing the UNC path through Node.js spawn args causes Node to
          // escape the inner quotes, which garbles the path. A temp batch file
          // avoids all quoting issues: the file path passed to cmd /c is
          // simple, and inside the file the pushd quoting is straightforward.
          const batchPath = join(tmpdir(), `polycode-${Date.now()}.bat`)
          const batchContent = `@echo off\r\npushd "${workDir}"\r\nclaude ${stdinArgs.join(' ')}\r\npopd\r\n`
          writeFileSync(batchPath, batchContent)
          console.log('[ClaudeDriver] Spawning (UNC/batch/stdin):', batchPath)
          this.process = spawn('cmd', ['/c', batchPath], {
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
          this.process.on('close', () => { try { unlinkSync(batchPath) } catch { /* ignore */ } })
        } else {
          console.log('[ClaudeDriver] Spawning (stdin):', 'claude', stdinArgs.join(' '))
          this.process = spawn('claude', stdinArgs, {
            cwd: workDir,
            shell: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
        }
        // Write the prompt to stdin and close — avoids all cmd.exe escaping issues
        this.process.stdin?.write(content)
        this.process.stdin?.end()
      } else {
        console.log('[ClaudeDriver] Spawning:', 'claude', args.join(' '))

        this.process = spawn('claude', args, {
          cwd: this.options.workingDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      }
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
        Sentry.addBreadcrumb({
          category: 'driver.exit',
          message: `ClaudeDriver exited with code ${code}`,
          level: 'error',
          data: { exitCode: code },
        })
        onDone(new Error(`Claude process exited with code ${code}${stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : ''}`))
      } else {
        onDone()
      }
    })

    this.process.on('error', (err) => {
      this.process = null
      Sentry.captureException(err, { tags: { driver: 'ClaudeDriver' } })
      onDone(err)
    })
  }

  stop(): void {
    if (this.process) {
      this.process.kill('SIGTERM')
      // Do NOT null this.process here — let the close event handler do it so
      // that isRunning() stays true until the OS confirms the process has exited.
      // Add a SIGKILL fallback in case SIGTERM is ignored.
      const proc = this.process
      setTimeout(() => {
        try {
          if (proc.exitCode === null && !proc.killed) {
            console.warn('[ClaudeDriver] Process did not exit after SIGTERM, sending SIGKILL')
            proc.kill('SIGKILL')
          }
        } catch { /* process already gone */ }
      }, 5000)
    }
  }

  isRunning(): boolean {
    return this.process !== null
  }

  getPid(): number | null {
    return this.process?.pid ?? null
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
