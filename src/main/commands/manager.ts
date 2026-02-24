import { spawn, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { BrowserWindow } from 'electron'
import { CommandStatus, CommandLogLine, ProjectCommand } from '../../shared/types'
import { getCommandById, listCommands, getLocationById } from '../db/queries'

const LOG_RING_BUFFER_SIZE = 1000

/** Escape a string for use inside single quotes in a POSIX shell. */
function posixEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

interface RunningCommand {
  commandId: string
  locationId: string
  process: ChildProcess
  status: CommandStatus
  logs: CommandLogLine[]
}

/** Returns the map key for a (commandId, locationId) pair. */
function instKey(commandId: string, locationId: string): string {
  return `${commandId}:${locationId}`
}

class CommandManager {
  /** Keyed by instKey(commandId, locationId) */
  private running = new Map<string, RunningCommand>()
  private window: BrowserWindow | null = null

  init(win: BrowserWindow): void {
    this.window = win
  }

  getStatus(commandId: string, locationId: string): CommandStatus {
    return this.running.get(instKey(commandId, locationId))?.status ?? 'idle'
  }

  getLogs(commandId: string, locationId: string): CommandLogLine[] {
    return this.running.get(instKey(commandId, locationId))?.logs ?? []
  }

  getPid(commandId: string, locationId: string): number | null {
    return this.running.get(instKey(commandId, locationId))?.process?.pid ?? null
  }

  start(commandId: string, locationId: string): void {
    const key = instKey(commandId, locationId)

    // Stop existing instance for this (command, location) if any
    this.stop(commandId, locationId)

    const cmdDef: ProjectCommand | null = getCommandById(commandId)
    if (!cmdDef) return

    const location = getLocationById(locationId)
    const connectionType = location?.connection_type ?? 'local'

    // Resolve cwd: if cmdDef.cwd is relative, join it with the location path.
    // For local connections use path.join (Windows-aware); for WSL/SSH use POSIX join.
    // Guard local paths against missing directories — spawn() throws ENOENT (with the
    // executable name in the message!) when cwd doesn't exist on the filesystem.
    const locationPath = location?.path
    let cwd: string | undefined
    if (cmdDef.cwd) {
      const isAbsolute =
        connectionType === 'local'
          ? path.isAbsolute(cmdDef.cwd)
          : cmdDef.cwd.startsWith('/') || cmdDef.cwd.startsWith('~')
      cwd = isAbsolute || !locationPath
        ? cmdDef.cwd
        : connectionType === 'local'
          ? path.join(locationPath, cmdDef.cwd)
          : `${locationPath}/${cmdDef.cwd}`
    } else {
      cwd = locationPath ?? undefined
    }
    if (cwd !== undefined && connectionType === 'local' && !existsSync(cwd)) {
      cwd = undefined
    }

    const entry: RunningCommand = {
      commandId,
      locationId,
      process: null as unknown as ChildProcess,
      status: 'running',
      logs: [],
    }
    this.running.set(key, entry)
    this.pushStatus(commandId, locationId, 'running')

    let proc: ChildProcess

    if (connectionType === 'wsl' && location?.wsl) {
      // ── WSL spawn ──────────────────────────────────────────────────────────
      const workDir = cwd ?? '~'
      const cdTarget = workDir.startsWith('~')
        ? '"$HOME"' + posixEscape(workDir.slice(1))
        : posixEscape(workDir)
      const innerCmd = `cd ${cdTarget} && ${cmdDef.command}`
      proc = spawn('wsl', ['-d', location.wsl.distro, '--', 'bash', '-c', innerCmd], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } else if (connectionType === 'ssh' && location?.ssh) {
      // ── SSH spawn ──────────────────────────────────────────────────────────
      const ssh = location.ssh
      const workDir = cwd ?? '~'
      const cdTarget = workDir.startsWith('~')
        ? '"$HOME"' + posixEscape(workDir.slice(1))
        : posixEscape(workDir)
      const innerCmd = `cd ${cdTarget} && ${cmdDef.command}`
      const remoteCmd = `bash -lc ${posixEscape(innerCmd)}`
      const sshArgs = [
        '-T',
        '-o', 'ConnectTimeout=10',
        '-o', 'StrictHostKeyChecking=accept-new',
      ]
      // ControlMaster multiplexing is not supported on Windows OpenSSH
      if (process.platform !== 'win32') {
        sshArgs.push(
          '-o', 'ControlMaster=auto',
          '-o', 'ControlPath=/tmp/polycode-ssh-%r@%h:%p',
          '-o', 'ControlPersist=300',
        )
      }
      if (ssh.port) sshArgs.push('-p', String(ssh.port))
      if (ssh.keyPath) sshArgs.push('-i', ssh.keyPath)
      sshArgs.push(`${ssh.user}@${ssh.host}`, remoteCmd)
      proc = spawn('ssh', sshArgs, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } else if (cmdDef.shell === 'powershell') {
      // ── Local PowerShell spawn ─────────────────────────────────────────────
      // Use absolute path on Windows to avoid ENOENT when PowerShell isn't in PATH
      let psExe: string
      if (process.platform === 'win32') {
        const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
        psExe = `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
      } else {
        psExe = 'pwsh'
      }
      proc = spawn(psExe, ['-NonInteractive', '-Command', cmdDef.command], {
        shell: false,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } else {
      // ── Local default shell spawn ──────────────────────────────────────────
      // On Windows, use cmd.exe via ComSpec or absolute path to avoid ENOENT
      // when C:\Windows\System32 isn't in the Electron process PATH.
      if (process.platform === 'win32') {
        const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
        const cmdExe = process.env.ComSpec ?? `${sysRoot}\\System32\\cmd.exe`
        proc = spawn(cmdExe, ['/d', '/s', '/c', cmdDef.command], {
          shell: false,
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } else {
        proc = spawn('/bin/sh', ['-c', cmdDef.command], {
          shell: false,
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      }
    }

    entry.process = proc

    const pushLog = (text: string, stream: 'stdout' | 'stderr'): void => {
      const line: CommandLogLine = {
        commandId,
        text,
        stream,
        timestamp: new Date().toISOString(),
      }
      entry.logs.push(line)
      if (entry.logs.length > LOG_RING_BUFFER_SIZE) {
        entry.logs.shift()
      }
      this.window?.webContents.send(`command:log:${key}`, line)
    }

    const makeLineBuffer = (stream: 'stdout' | 'stderr') => {
      let buf = ''
      return (chunk: Buffer): void => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          pushLog(line, stream)
        }
      }
    }

    proc.stdout?.on('data', makeLineBuffer('stdout'))
    proc.stderr?.on('data', makeLineBuffer('stderr'))

    proc.on('close', (code) => {
      const current = this.running.get(key)
      if (!current || current.process !== proc) return
      // Don't override status if the user already stopped it intentionally
      if (current.status === 'stopped') return
      const status: CommandStatus = code === 0 || code === null ? 'stopped' : 'error'
      current.status = status
      this.pushStatus(commandId, locationId, status)
    })

    proc.on('error', (err) => {
      const current = this.running.get(key)
      if (!current || current.process !== proc) return
      pushLog(`Error: ${err.message}`, 'stderr')
      current.status = 'error'
      this.pushStatus(commandId, locationId, 'error')
    })
  }

  stop(commandId: string, locationId: string): void {
    const key = instKey(commandId, locationId)
    const entry = this.running.get(key)
    if (!entry) return
    if (entry.status === 'running') {
      entry.status = 'stopped'
      this.pushStatus(commandId, locationId, 'stopped')
      if (process.platform === 'win32' && entry.process.pid != null) {
        // On Windows, SIGTERM only kills the cmd.exe shell but not the child process tree.
        // Use taskkill to forcefully terminate the entire tree.
        spawn('taskkill', ['/pid', String(entry.process.pid), '/T', '/F'], { shell: false })
      } else {
        entry.process.kill('SIGTERM')
      }
    }
  }

  restart(commandId: string, locationId: string): void {
    this.start(commandId, locationId)
  }

  /** Stop all running instances for a given commandId (used when deleting a command). */
  stopAllInstances(commandId: string): void {
    for (const entry of this.running.values()) {
      if (entry.commandId === commandId) {
        this.stop(commandId, entry.locationId)
      }
    }
  }

  stopAll(): void {
    for (const entry of [...this.running.values()]) {
      this.stop(entry.commandId, entry.locationId)
    }
  }

  /** Get statuses for all commands of a project at a given location. */
  getProjectCommandStatuses(projectId: string, locationId: string): Record<string, CommandStatus> {
    const commands = listCommands(projectId)
    const result: Record<string, CommandStatus> = {}
    for (const cmd of commands) {
      result[cmd.id] = this.getStatus(cmd.id, locationId)
    }
    return result
  }

  private pushStatus(commandId: string, locationId: string, status: CommandStatus): void {
    const key = instKey(commandId, locationId)
    this.window?.webContents.send(`command:status:${key}`, status)
  }
}

export const commandManager = new CommandManager()
