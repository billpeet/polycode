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

export type { Runner, SpawnCommand } from './types'
export { shellEscape, winQuote, cdTarget, buildSshBaseArgs, LOAD_NODE_MANAGERS, FIX_HOME, RESOLVE_CODEX_BIN, RESOLVE_CODEX_BIN_SOFT } from './utils'
