import type { SshConfig, WslConfig } from '../shared/types'
import { sshExec } from './ssh'
import { wslExec } from './wsl'

/**
 * Execute a shell script at a remote Project Location.
 *
 * SSH takes precedence when both configurations are present, matching Runner
 * selection. Callers must provide a remote configuration.
 */
export function runRemoteShell(
  workDir: string,
  script: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<string> {
  if (ssh) return sshExec(ssh, workDir, script)
  if (wsl) return wslExec(wsl, workDir, script)
  throw new Error('Remote shell execution requires an SSH or WSL location')
}
