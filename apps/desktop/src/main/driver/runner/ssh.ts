import { spawn, ChildProcess } from 'child_process'
import { SshConfig } from '../../../shared/types'
import { Runner, RunCommand, RunResult, RunScriptCommand, ScriptCommand, SpawnCommand } from './types'
import { shellEscape, cdTarget, buildSshBaseArgs, LOAD_NODE_MANAGERS } from './utils'
import { collectProcess } from './collect'

export class SshRunner implements Runner {
  readonly type = 'ssh' as const

  constructor(private readonly ssh: SshConfig) {}

  run(cmd: RunCommand): Promise<RunResult> {
    return collectProcess(this.spawn(cmd), cmd)
  }

  runScript(cmd: RunScriptCommand): Promise<RunResult> {
    // BatchMode=yes only on the collecting path. runScript closes stdin and waits
    // for exit, so an interactive password or passphrase prompt cannot be answered
    // and would hang until the timeout; failing immediately is strictly better.
    // spawnScript streams to a live UI and is left as-is, matching what the shell
    // mode and command runner did before they moved behind this seam.
    return collectProcess(this.spawnScriptWith(cmd, true), cmd)
  }

  spawnScript(cmd: ScriptCommand): ChildProcess {
    return this.spawnScriptWith(cmd, false)
  }

  private spawnScriptWith(cmd: ScriptCommand, batchMode: boolean): ChildProcess {
    const { script, workDir, preamble, env } = cmd

    // Same LOAD_NODE_MANAGERS reasoning as spawn().
    const parts: string[] = [LOAD_NODE_MANAGERS]
    if (preamble) parts.push(preamble)
    parts.push(workDir === undefined ? script : `cd ${cdTarget(workDir)} && ${script}`)
    const innerCmd = parts.join('; ')

    const remoteCmd = `bash -lc ${shellEscape(innerCmd)}`
    const sshArgs = buildSshBaseArgs(this.ssh)
    if (batchMode) sshArgs.push('-o', 'BatchMode=yes')
    sshArgs.push(`${this.ssh.user}@${this.ssh.host}`, remoteCmd)

    console.log('[SshRunner] Spawning script on', `${this.ssh.user}@${this.ssh.host}`)
    return spawn('ssh', sshArgs, {
      shell: false,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

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
