import { OutputEvent, SshConfig, WslConfig } from '../../shared/types'

export interface MessageOptions {
  planMode?: boolean
}

export interface CLIDriver {
  /** Send a user message; spawns a new process per call */
  sendMessage(
    content: string,
    onEvent: (event: OutputEvent) => void,
    onDone: (error?: Error) => void,
    options?: MessageOptions
  ): void
  /** Stop the CLI process */
  stop(): void
  /** Returns true if the process is currently running */
  isRunning(): boolean
}

export interface DriverOptions {
  workingDir: string
  threadId: string
  model?: string
  initialSessionId?: string | null
  onSessionId?: (sessionId: string) => void
  ssh?: SshConfig | null
  wsl?: WslConfig | null
}
