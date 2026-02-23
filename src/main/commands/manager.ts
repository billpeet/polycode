import { spawn, ChildProcess } from 'child_process'
import { BrowserWindow } from 'electron'
import { CommandStatus, CommandLogLine, ProjectCommand } from '../../shared/types'
import { getCommandById, listCommands, getLocationById } from '../db/queries'

const LOG_RING_BUFFER_SIZE = 1000

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

    // Resolve cwd: explicit cwd override > location path
    let cwd: string | undefined
    if (cmdDef.cwd) {
      cwd = cmdDef.cwd
    } else {
      const location = getLocationById(locationId)
      cwd = location?.path ?? undefined
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

    const proc = spawn(cmdDef.command, [], {
      shell: true,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
