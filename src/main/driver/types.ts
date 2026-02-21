import { OutputEvent } from '../../shared/types'

export interface CLIDriver {
  /** Start the CLI process and begin streaming events */
  start(onEvent: (event: OutputEvent) => void, onDone: (error?: Error) => void): void
  /** Send a user message to the running CLI */
  sendMessage(content: string): void
  /** Stop the CLI process */
  stop(): void
  /** Returns true if the process is currently running */
  isRunning(): boolean
}

export interface DriverOptions {
  workingDir: string
  threadId: string
}
