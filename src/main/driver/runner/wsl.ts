import { spawn, ChildProcess } from 'child_process'
import { WslConfig } from '../../../shared/types'
import { Runner, SpawnCommand } from './types'
import { shellEscape, cdTarget, FIX_HOME } from './utils'

export class WslRunner implements Runner {
  readonly type = 'wsl' as const

  constructor(private readonly wsl: WslConfig) {}

  spawn(cmd: SpawnCommand): ChildProcess {
    const { binary, args, workDir, preamble, stdinContent } = cmd

    // Always fix HOME first — Electron passes Windows HOME into WSL which
    // breaks nvm/volta/bun path lookups.
    const parts: string[] = [FIX_HOME]
    if (preamble) parts.push(preamble)
    parts.push(`cd ${cdTarget(workDir)} && ${binary} ${args.map(shellEscape).join(' ')}`)
    const innerCmd = parts.join('; ')

    const wslArgs = ['-d', this.wsl.distro, '--', 'bash', '-lc', innerCmd]
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
