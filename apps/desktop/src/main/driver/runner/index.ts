import { DriverOptions } from '../types'
import { Runner } from './types'
import { LocalRunner } from './local'
import { WslRunner } from './wsl'
import { SshRunner } from './ssh'
import { ObservedRunner } from './observed'

export function createRunner(opts: Pick<DriverOptions, 'ssh' | 'wsl'>): Runner {
  const runner = opts.ssh
    ? new SshRunner(opts.ssh)
    : opts.wsl
      ? new WslRunner(opts.wsl)
      : new LocalRunner()
  return new ObservedRunner(runner)
}

export type { Runner, RunCommand, RunResult, RunScriptCommand, ScriptCommand, SpawnCommand } from './types'
export { expectSuccess } from './collect'
export { shellEscape, winQuote, cdTarget, buildSshBaseArgs, LOAD_NODE_MANAGERS, FIX_HOME, RESOLVE_CODEX_BIN, RESOLVE_CODEX_BIN_SOFT, augmentWindowsPath, resolveClaudeCodeExecutable, expandHomePath, getPowerShellExe, getCmdExe } from './utils'
