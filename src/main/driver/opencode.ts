import { spawn, ChildProcess } from 'child_process'
import { CLIDriver, DriverOptions, MessageOptions } from './types'
import { OutputEvent } from '../../shared/types'

/** Escape a string for use inside single quotes in a POSIX shell. */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

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

export class OpenCodeDriver implements CLIDriver {
  private process: ChildProcess | null = null
  private options: DriverOptions
  /** OpenCode session ID used for session resumption (stored as claude_session_id in DB). */
  private sessionId: string | null = null
  private buffer = ''

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
    _options?: MessageOptions  // plan mode is Claude-specific; ignored for OpenCode
  ): void {
    if (this.process) {
      console.warn('[OpenCodeDriver] sendMessage called while process is already running — ignoring')
      return
    }

    const args = buildOpenCodeArgs(this.sessionId, this.options.model)

    this.buffer = ''

    const ssh = this.options.ssh
    const wsl = this.options.wsl

    if (ssh) {
      // ── SSH remote spawn ──────────────────────────────────────────────────
      const workDir = this.options.workingDir
      const cdTarget = workDir.startsWith('~')
        ? '"$HOME"' + shellEscape(workDir.slice(1))
        : shellEscape(workDir)
      const innerCmd = `cd ${cdTarget} && opencode ${args.map(shellEscape).join(' ')}`
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

      console.log('[OpenCodeDriver] Spawning SSH: ssh', sshArgs.join(' '))

      this.process = spawn('ssh', sshArgs, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.process.stdin?.end(content)
    } else if (wsl) {
      // ── WSL spawn ──────────────────────────────────────────────────────────
      const workDir = this.options.workingDir
      const cdTarget = workDir.startsWith('~')
        ? '"$HOME"' + shellEscape(workDir.slice(1))
        : shellEscape(workDir)
      const innerCmd = `cd ${cdTarget} && opencode ${args.map(shellEscape).join(' ')}`
      const wslArgs = ['-d', wsl.distro, '--', 'bash', '-lc', innerCmd]

      console.log('[OpenCodeDriver] Spawning WSL: wsl', wslArgs.join(' '))

      this.process = spawn('wsl', wslArgs, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.process.stdin?.end(content)
    } else {
      // ── Local spawn ────────────────────────────────────────────────────────
      console.log('[OpenCodeDriver] Spawning: opencode', args.join(' '))

      this.process = spawn('opencode', args, {
        cwd: this.options.workingDir,
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.process.stdin?.end(content)
    }

    let stderrBuffer = ''

    this.process.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      console.log('[OpenCodeDriver] stdout chunk:', text.slice(0, 200))
      this.buffer += text
      this.processBuffer(onEvent)
    })

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      console.error('[OpenCodeDriver] stderr:', text)
      stderrBuffer += text
    })

    this.process.on('close', (code) => {
      this.processBuffer(onEvent)
      this.process = null
      if (code !== 0 && code !== null) {
        console.error('[OpenCodeDriver] Process exited with code', code)
        onDone(new Error(`OpenCode process exited with code ${code}${stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : ''}`))
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
      // Do NOT null this.process here — let the close event handler do it so
      // that isRunning() stays true until the OS confirms the process has exited.
      const proc = this.process
      setTimeout(() => {
        try {
          if (proc.exitCode === null && !proc.killed) {
            console.warn('[OpenCodeDriver] Process did not exit after SIGTERM, sending SIGKILL')
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
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>
        const events = this.parseOpenCodeEvent(parsed)
        for (const event of events) {
          onEvent(event)
        }
      } catch {
        // Non-JSON stdout line — silently skip
      }
    }
  }

  private parseOpenCodeEvent(data: Record<string, unknown>): OutputEvent[] {
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
