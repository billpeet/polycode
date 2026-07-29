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

/**
 * A shell script to execute at a Project Location.
 *
 * The counterpart to SpawnCommand. SpawnCommand is structured argv — the adapter
 * escapes every element, so the user's data can never become shell syntax.
 * ScriptCommand is the opposite by design: `script` IS shell syntax, written by
 * whoever composed it. Use SpawnCommand whenever the shape is "a binary and its
 * arguments"; ScriptCommand exists for the cases that are genuinely a script —
 * a user's command definition, a `!` shell-mode entry, a multi-statement probe.
 */
export interface ScriptCommand {
  /** Shell script text, passed to the transport's shell verbatim and NOT escaped. */
  script: string
  /**
   * Directory to run in. When omitted, local inherits this process's cwd and
   * wsl/ssh emit no `cd` at all, landing wherever the login shell starts.
   */
  workDir?: string
  /**
   * POSIX shell preamble, prepended before the `cd` and joined with `; `.
   * Applied by the wsl and ssh adapters only — same convention as SpawnCommand,
   * where the local adapter has no shell to prepend it to. Use `env` locally.
   */
  preamble?: string
  /**
   * Environment for the spawned process. On wsl/ssh this is the environment of
   * the local `wsl`/`ssh` client, not of the remote shell.
   */
  env?: NodeJS.ProcessEnv
  /**
   * Selects the local shell that interprets `script`. Ignored by the wsl and ssh
   * adapters, which are always bash — PowerShell has no meaning over there.
   */
  localShell?: 'default' | 'powershell'
}

export interface RunScriptCommand extends ScriptCommand {
  /** Kill the process and return a timed-out result after this duration. */
  timeoutMs?: number
  /** Stop collecting and kill the process if stdout + stderr exceed this size. */
  maxOutputBytes?: number
}

export interface Runner {
  readonly type: 'local' | 'wsl' | 'ssh'
  spawn(cmd: SpawnCommand): ChildProcess
  run(cmd: RunCommand): Promise<RunResult>
  /** Stream a shell script. stdio is always ['ignore', 'pipe', 'pipe']. */
  spawnScript(cmd: ScriptCommand): ChildProcess
  /** Run a shell script to completion and collect its output. */
  runScript(cmd: RunScriptCommand): Promise<RunResult>
}
