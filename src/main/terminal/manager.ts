import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import { SshConfig, WslConfig, ConnectionType } from '../../shared/types'
import { buildSshBaseArgs } from '../driver/runner/utils'

interface PtyInstance {
  terminalId: string
  threadId: string
  process: pty.IPty
  cols: number
  rows: number
}

class PtyManager {
  private instances = new Map<string, PtyInstance>()
  private window: BrowserWindow | null = null

  init(win: BrowserWindow): void {
    this.window = win
  }

  spawn(
    terminalId: string,
    threadId: string,
    cwd: string,
    connectionType: ConnectionType,
    cols: number,
    rows: number,
    ssh?: SshConfig | null,
    wsl?: WslConfig | null,
  ): void {
    // Kill any existing instance with this ID
    this.kill(terminalId)

    let proc: pty.IPty

    if (ssh) {
      // SSH: spawn local ssh with -t for remote PTY allocation.
      // node-pty allocates a local PTY; -t asks the remote for one too.
      // buildSshBaseArgs includes -T (no remote PTY) — filter it out and add -t.
      const sshArgs = buildSshBaseArgs(ssh).filter((a) => a !== '-T')
      sshArgs.push('-t')
      sshArgs.push(`${ssh.user}@${ssh.host}`)
      // Remote command: cd into cwd then exec a login shell
      if (cwd) {
        sshArgs.push(`cd ${escapePosix(cwd)} && exec $SHELL -l`)
      }

      proc = pty.spawn('ssh', sshArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        env: filterEnv(),
      })
    } else if (wsl) {
      // WSL: spawn wsl.exe — covers both WSL locations and local locations
      // with the thread-level WSL toggle enabled
      const wslArgs = ['-d', wsl.distro]
      if (cwd) {
        wslArgs.push('--cd', cwd)
      }

      proc = pty.spawn('wsl.exe', wslArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        env: filterEnv(),
      })
    } else {
      // Local
      proc = spawnLocalShell(cwd, cols, rows)
    }

    const instance: PtyInstance = {
      terminalId,
      threadId,
      process: proc,
      cols,
      rows,
    }
    this.instances.set(terminalId, instance)

    proc.onData((data) => {
      this.window?.webContents.send(`terminal:data:${terminalId}`, data)
    })

    proc.onExit(({ exitCode, signal }) => {
      this.window?.webContents.send(`terminal:exit:${terminalId}`, { exitCode, signal })
      this.instances.delete(terminalId)
    })

    console.log(`[PtyManager] Spawned terminal ${terminalId} (${connectionType}, pid=${proc.pid})`)
  }

  write(terminalId: string, data: string): void {
    this.instances.get(terminalId)?.process.write(data)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const inst = this.instances.get(terminalId)
    if (!inst) return
    try {
      inst.process.resize(cols, rows)
      inst.cols = cols
      inst.rows = rows
    } catch {
      // Process may have already exited
    }
  }

  kill(terminalId: string): void {
    const inst = this.instances.get(terminalId)
    if (!inst) return
    try {
      inst.process.kill()
    } catch {
      // Already exited
    }
    this.instances.delete(terminalId)
    console.log(`[PtyManager] Killed terminal ${terminalId}`)
  }

  killAllForThread(threadId: string): void {
    for (const [id, inst] of this.instances) {
      if (inst.threadId === threadId) {
        this.kill(id)
      }
    }
  }

  killAll(): void {
    for (const id of [...this.instances.keys()]) {
      this.kill(id)
    }
  }
}

function spawnLocalShell(cwd: string, cols: number, rows: number): pty.IPty {
  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const shell = `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    return pty.spawn(shell, [], {
      name: 'xterm-color',
      cols,
      rows,
      cwd: cwd || undefined,
      env: filterEnv(),
    })
  }
  const shell = process.env.SHELL ?? '/bin/bash'
  return pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: cwd || undefined,
    env: filterEnv(),
  })
}

/** Escape a string for use inside a POSIX shell argument. */
function escapePosix(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/** Filter environment variables, removing Electron-specific ones. */
function filterEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (k === 'ELECTRON_RUN_AS_NODE') continue
    if (k === 'ELECTRON_RENDERER_PORT') continue
    env[k] = v
  }
  return env
}

export const ptyManager = new PtyManager()
