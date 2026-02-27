import { ChildProcess } from 'child_process'
import * as Sentry from '@sentry/electron/main'
import { CLIDriver, DriverOptions, MessageOptions } from './types'
import { OutputEvent } from '../../shared/types'
import { SpawnCommand } from './runner/types'
import { createRunner } from './runner'

export abstract class BaseDriver implements CLIDriver {
  protected process: ChildProcess | null = null
  protected buffer = ''

  constructor(protected readonly options: DriverOptions) {}

  /** Display name used in log messages and Sentry tags. */
  abstract get driverName(): string

  /**
   * Build the SpawnCommand for this driver.
   * runnerType lets drivers decide whether to use stdin vs argv for the prompt.
   */
  protected abstract buildCommand(
    content: string,
    runnerType: 'local' | 'wsl' | 'ssh',
    options?: MessageOptions
  ): SpawnCommand

  /** Parse one line of JSON output → OutputEvent[]. Called from processBuffer. */
  protected abstract parseEvent(data: Record<string, unknown>): OutputEvent[]

  /** Optional per-driver state reset before each sendMessage (e.g. clear tracking Sets). */
  protected beforeSendMessage(): void {}

  sendMessage(
    content: string,
    onEvent: (event: OutputEvent) => void,
    onDone: (error?: Error) => void,
    options?: MessageOptions
  ): void {
    if (this.process) {
      console.warn(`[${this.driverName}] sendMessage called while process is already running — ignoring`)
      return
    }

    this.beforeSendMessage()
    this.buffer = ''

    const runner = createRunner(this.options)
    const cmd = this.buildCommand(content, runner.type, options)
    this.process = runner.spawn(cmd)

    let stderrBuffer = ''

    this.process.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      console.log(`[${this.driverName}] stdout chunk:`, text.slice(0, 200))
      this.buffer += text
      this.processBuffer(onEvent)
    })

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      console.error(`[${this.driverName}] stderr:`, text)
      stderrBuffer += text
    })

    this.process.on('close', (code) => {
      // Flush any remaining buffer content
      this.processBuffer(onEvent)
      this.process = null
      if (code !== 0 && code !== null) {
        console.error(`[${this.driverName}] Process exited with code`, code)
        if (stderrBuffer.trim()) {
          console.error(`[${this.driverName}] stderr:`, stderrBuffer)
        }
        Sentry.addBreadcrumb({
          category: 'driver.exit',
          message: `${this.driverName} exited with code ${code}`,
          level: 'error',
          data: { exitCode: code },
        })
        onDone(new Error(`${this.driverName} process exited with code ${code}${stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : ''}`))
      } else {
        onDone()
      }
    })

    this.process.on('error', (err) => {
      this.process = null
      Sentry.captureException(err, { tags: { driver: this.driverName } })
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
            console.warn(`[${this.driverName}] Process did not exit after SIGTERM, sending SIGKILL`)
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
        const events = this.parseEvent(parsed)
        for (const event of events) {
          onEvent(event)
        }
      } catch {
        // Non-JSON stdout line — silently skip
      }
    }
  }
}
