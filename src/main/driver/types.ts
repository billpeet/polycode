import { OutputEvent } from '../../shared/types'

export interface CLIDriver {
  /** Send a user message; spawns a new process per call */
  sendMessage(
    content: string,
    onEvent: (event: OutputEvent) => void,
    onDone: (error?: Error) => void
  ): void
  /** Stop the CLI process */
  stop(): void
  /** Returns true if the process is currently running */
  isRunning(): boolean
}

export interface DriverOptions {
  workingDir: string
  threadId: string
}
