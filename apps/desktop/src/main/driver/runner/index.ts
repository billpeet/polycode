import { DriverOptions } from '../types'
import { Runner } from './types'
import { LocalRunner } from './local'
import { WslRunner } from './wsl'
import { SshRunner } from './ssh'

export function createRunner(opts: Pick<DriverOptions, 'ssh' | 'wsl'>): Runner {
  if (opts.ssh) return new SshRunner(opts.ssh)
  if (opts.wsl) return new WslRunner(opts.wsl)
  return new LocalRunner()
}

export type { Runner, RunCommand, RunResult, RunScriptCommand, ScriptCommand, SpawnCommand } from './types'
export { expectSuccess } from './collect'
export { shellEscape, winQuote, cdTarget, buildSshBaseArgs, LOAD_NODE_MANAGERS, FIX_HOME, RESOLVE_CODEX_BIN, RESOLVE_CODEX_BIN_SOFT, augmentWindowsPath, resolveClaudeCodeExecutable, expandHomePath, getPowerShellExe, getCmdExe } from './utils'
