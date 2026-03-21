import { spawn, ChildProcess } from 'child_process'
import { SshConfig } from '../../../shared/types'
import { Runner, SpawnCommand } from './types'
import { shellEscape, cdTarget, buildSshBaseArgs, LOAD_NODE_MANAGERS } from './utils'

export class SshRunner implements Runner {
  readonly type = 'ssh' as const

  constructor(private readonly ssh: SshConfig) {}

  spawn(cmd: SpawnCommand): ChildProcess {
    const { binary, args, workDir, preamble, stdinContent, keepStdinOpen } = cmd

    // .bashrc guards against non-interactive shells (`case $- in *i*)`)
    // so PATH additions users put there never load in `bash -lc`.
    // LOAD_NODE_MANAGERS explicitly adds common tool directories to PATH.
    const parts: string[] = [LOAD_NODE_MANAGERS]
    if (preamble) parts.push(preamble)
    parts.push(`cd ${cdTarget(workDir)} && ${binary} ${args.map(shellEscape).join(' ')}`)
    const innerCmd = parts.join('; ')

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
    if (!keepStdinOpen) proc.stdin?.end()

    return proc
  }
}
