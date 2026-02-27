import { ChildProcess } from 'child_process'

export interface SpawnCommand {
  /** The binary name to execute (e.g. 'claude', 'codex', 'opencode', '$CODEX_BIN') */
  binary: string
  /** Positional/flag arguments. Does NOT include the prompt when stdinContent is set. */
  args: string[]
  workDir: string
  /** Shell preamble prepended in WSL/SSH (node manager loading, binary resolution, etc.) */
  preamble?: string
  /** If set, written to stdin then stdin is closed. The prompt is passed this way when
   *  argv-based escaping is unreliable (Claude on Windows/WSL, OpenCode always). */
  stdinContent?: string
}

export interface Runner {
  readonly type: 'local' | 'wsl' | 'ssh'
  spawn(cmd: SpawnCommand): ChildProcess
}
