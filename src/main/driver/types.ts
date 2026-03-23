import { OutputEvent, SshConfig, WslConfig } from '../../shared/types'

export interface MessageOptions {
  planMode?: boolean
  yoloMode?: boolean
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
  /** Returns the OS PID of the running process, or null if not running */
  getPid(): number | null
  /** Send a control_response to the running process (for interactive permission approval).
   *  Default no-op for drivers that don't support this protocol. */
  sendControlResponse(requestId: string, behavior: 'allow' | 'deny', message?: string): void
  /** Structured answer path for drivers that surface AskUserQuestion via a permission callback. */
  answerQuestion?(requestId: string, answers: Record<string, unknown>, message?: string): void
}

export interface DriverOptions {
  workingDir: string
  threadId: string
  model?: string
  yoloMode?: boolean
  initialSessionId?: string | null
  onSessionId?: (sessionId: string) => void
  ssh?: SshConfig | null
  wsl?: WslConfig | null
}
