import { ChildProcess } from 'child_process'

export interface SpawnCommand {
  /** The binary name to execute (e.g. 'claude', 'codex', 'opencode', '$CODEX_BIN') */
  binary: string
  /** Positional/flag arguments. Does NOT include the prompt when stdinContent is set. */
  args: string[]
  workDir: string
  /** Shell preamble prepended in WSL/SSH (node manager loading, binary resolution, etc.) */
  preamble?: string
  /** If set, written to stdin. The prompt is passed this way when
   *  argv-based escaping is unreliable (Claude on Windows/WSL, OpenCode always). */
  stdinContent?: string
  /** If true, stdin is NOT closed after writing stdinContent — kept open for
   *  interactive protocol messages (e.g. Claude Code permission control_response). */
  keepStdinOpen?: boolean
}

export interface RunCommand extends SpawnCommand {
  /** Kill the process and return a timed-out result after this duration. */
  timeoutMs?: number
  /** Stop collecting and kill the process if stdout + stderr exceed this size. */
  maxOutputBytes?: number
}

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

export interface Runner {
  readonly type: 'local' | 'wsl' | 'ssh'
  spawn(cmd: SpawnCommand): ChildProcess
  run(cmd: RunCommand): Promise<RunResult>
}
