import { spawn, ChildProcess } from 'child_process'
import { CLIDriver, DriverOptions } from './types'
import { OutputEvent } from '../../shared/types'

export class ClaudeDriver implements CLIDriver {
  private process: ChildProcess | null = null
  private options: DriverOptions
  private buffer = ''

  constructor(options: DriverOptions) {
    this.options = options
  }

  start(onEvent: (event: OutputEvent) => void, onDone: (error?: Error) => void): void {
    if (this.process) {
      return
    }

    // Claude Code CLI: `claude --output-format stream-json --verbose`
    // Launched with --print so it runs non-interactively, reading from stdin
    this.process = spawn('claude', ['--output-format', 'stream-json', '--verbose', '--print', ''], {
      cwd: this.options.workingDir,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      this.processBuffer(onEvent)
    })

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) {
        onEvent({ type: 'error', content: text })
      }
    })

    this.process.on('close', (code) => {
      this.process = null
      if (code !== 0 && code !== null) {
        onDone(new Error(`Claude process exited with code ${code}`))
      } else {
        onDone()
      }
    })

    this.process.on('error', (err) => {
      this.process = null
      onDone(err)
    })
  }

  sendMessage(content: string): void {
    if (!this.process?.stdin) {
      return
    }
    // Send the message as JSON line to stdin
    const payload = JSON.stringify({ role: 'user', content }) + '\n'
    this.process.stdin.write(payload)
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
        const event = this.parseClaudeEvent(parsed)
        if (event) {
          onEvent(event)
        }
      } catch {
        // Not JSON — emit as raw text
        onEvent({ type: 'text', content: trimmed })
      }
    }
  }

  private parseClaudeEvent(data: Record<string, unknown>): OutputEvent | null {
    const type = data.type as string | undefined

    switch (type) {
      case 'assistant':
      case 'text': {
        const content = (data.content ?? data.text ?? '') as string
        return { type: 'text', content }
      }
      case 'tool_use': {
        return {
          type: 'tool_call',
          content: (data.name as string) ?? 'unknown',
          metadata: data as Record<string, unknown>
        }
      }
      case 'tool_result': {
        return {
          type: 'tool_result',
          content: JSON.stringify(data.content ?? ''),
          metadata: data as Record<string, unknown>
        }
      }
      case 'result': {
        // Final result message from claude --print
        const subtype = data.subtype as string | undefined
        if (subtype === 'success') {
          const result = data.result as string | undefined
          if (result) {
            return { type: 'text', content: result }
          }
        } else if (subtype === 'error') {
          return { type: 'error', content: (data.error as string) ?? 'Unknown error' }
        }
        return null
      }
      default:
        return null
    }
  }
}
