import { spawn, ChildProcess } from 'child_process'
import { SshConfig } from '../../../shared/types'
import { Runner, SpawnCommand } from './types'
import { shellEscape, cdTarget, buildSshBaseArgs } from './utils'

export class SshRunner implements Runner {
  readonly type = 'ssh' as const

  constructor(private readonly ssh: SshConfig) {}

  spawn(cmd: SpawnCommand): ChildProcess {
    const { binary, args, workDir, preamble, stdinContent } = cmd

    const parts: string[] = []
    if (preamble) parts.push(preamble)
    parts.push(`cd ${cdTarget(workDir)} && ${binary} ${args.map(shellEscape).join(' ')}`)
    const innerCmd = parts.join('; ')

    // Wrap in login shell so .profile/.bashrc are sourced (makes the binary available in PATH)
    const remoteCmd = `bash -lc ${shellEscape(innerCmd)}`

    const sshArgs = [
      ...buildSshBaseArgs(this.ssh),
      `${this.ssh.user}@${this.ssh.host}`,
      remoteCmd,
    ]

    console.log('[SshRunner] Spawning:', 'ssh', sshArgs.join(' '))

    const proc = spawn('ssh', sshArgs, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    if (stdinContent !== undefined) {
      proc.stdin?.write(stdinContent)
    }
    // Close stdin — signals EOF to SSH so it doesn't hang waiting for
    // interactive input (passwords, key passphrases, etc.)
    proc.stdin?.end()

    return proc
  }
}
