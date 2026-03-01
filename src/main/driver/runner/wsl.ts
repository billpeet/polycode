import { spawn, ChildProcess } from 'child_process'
import { WslConfig } from '../../../shared/types'
import { Runner, SpawnCommand } from './types'
import { shellEscape, cdTarget } from './utils'

export class WslRunner implements Runner {
  readonly type = 'wsl' as const

  constructor(private readonly wsl: WslConfig) {}

  spawn(cmd: SpawnCommand): ChildProcess {
    const { binary, args, workDir, preamble, stdinContent } = cmd

    // Use bash -ilc (interactive + login) so that .bashrc is sourced in full.
    // Without -i, bash skips .bashrc due to the `case $- in *i*)` guard, and
    // Electron's Windows PATH (including /mnt/c/ tools) bleeds into WSL, causing
    // Windows binaries to shadow Linux ones (e.g. Windows bun instead of Linux bun).
    const parts: string[] = []
    if (preamble) parts.push(preamble)
    parts.push(`cd ${cdTarget(workDir)} && ${binary} ${args.map(shellEscape).join(' ')}`)
    const innerCmd = parts.join('; ')

    const wslArgs = ['-d', this.wsl.distro, '--', 'bash', '-ilc', innerCmd]
    console.log('[WslRunner] Spawning:', 'wsl', wslArgs.join(' '))

    const proc = spawn('wsl', wslArgs, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    if (stdinContent !== undefined) {
      proc.stdin?.write(stdinContent)
    }
    proc.stdin?.end()

    return proc
  }
}
