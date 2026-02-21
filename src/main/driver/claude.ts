import { spawn, ChildProcess } from 'child_process'
import { CLIDriver, DriverOptions } from './types'
import { OutputEvent } from '../../shared/types'

export class ClaudeDriver implements CLIDriver {
  private process: ChildProcess | null = null
  private options: DriverOptions
  private sessionId: string | null = null
  private buffer = ''

  constructor(options: DriverOptions) {
    this.options = options
  }

  sendMessage(
    content: string,
    onEvent: (event: OutputEvent) => void,
    onDone: (error?: Error) => void
  ): void {
    // Build args: first message vs resume
    const args = ['--output-format', 'stream-json', '--verbose', '--print']
    if (this.sessionId) {
      args.push('--resume', this.sessionId)
    }
    args.push(content)

    this.buffer = ''

    this.process = spawn('claude', args, {
      cwd: this.options.workingDir,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      this.processBuffer(onEvent)
    })

    this.process.stderr?.on('data', (_chunk: Buffer) => {
      // Verbose mode produces lots of diagnostic noise — silently drop
    })

    this.process.on('close', (code) => {
      // Flush any remaining buffer content
      this.processBuffer(onEvent)
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
          if (sid) this.sessionId = sid
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
            events.push({
              type: 'tool_call',
              content: (block.name as string) ?? 'unknown',
              metadata: block as Record<string, unknown>
            })
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
            events.push({
              type: 'tool_result',
              content: JSON.stringify(block.content ?? ''),
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
        if (sid) this.sessionId = sid

        if (subtype === 'error') {
          events.push({
            type: 'error',
            content: (data.error as string) ?? 'Unknown error'
          })
        }
        // subtype === 'success': do NOT re-emit result text (already in assistant blocks)
        break
      }

      default:
        break
    }

    return events
  }
}
