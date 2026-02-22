import { spawn, ChildProcess } from 'child_process'
import { BrowserWindow } from 'electron'
import { CommandStatus, CommandLogLine, ProjectCommand } from '../../shared/types'
import { getCommandById, listCommands, listLocations } from '../db/queries'

const LOG_RING_BUFFER_SIZE = 1000

interface RunningCommand {
  commandId: string
  process: ChildProcess
  status: CommandStatus
  logs: CommandLogLine[]
}

class CommandManager {
  private running = new Map<string, RunningCommand>()
  private window: BrowserWindow | null = null

  init(win: BrowserWindow): void {
    this.window = win
  }

  getStatus(commandId: string): CommandStatus {
    return this.running.get(commandId)?.status ?? 'idle'
  }

  getLogs(commandId: string): CommandLogLine[] {
    return this.running.get(commandId)?.logs ?? []
  }

  start(commandId: string): void {
    // Stop first (idempotent restart)
    this.stop(commandId)

    const cmdDef: ProjectCommand | null = getCommandById(commandId)
    if (!cmdDef) return

    // Resolve cwd: use explicit cwd, or fall back to first local location for the project
    let cwd: string | undefined
    if (cmdDef.cwd) {
      cwd = cmdDef.cwd
    } else {
      const locations = listLocations(cmdDef.project_id)
      const local = locations.find((l) => l.connection_type === 'local')
      cwd = local?.path ?? undefined
    }

    const entry: RunningCommand = {
      commandId,
      process: null as unknown as ChildProcess,
      status: 'running',
      logs: [],
    }
    this.running.set(commandId, entry)
    this.pushStatus(commandId, 'running')

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
      this.window?.webContents.send(`command:log:${commandId}`, line)
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
      const current = this.running.get(commandId)
      if (!current || current.process !== proc) return
      const status: CommandStatus = code === 0 || code === null ? 'stopped' : 'error'
      current.status = status
      this.pushStatus(commandId, status)
    })

    proc.on('error', (err) => {
      const current = this.running.get(commandId)
      if (!current || current.process !== proc) return
      pushLog(`Error: ${err.message}`, 'stderr')
      current.status = 'error'
      this.pushStatus(commandId, 'error')
    })
  }

  stop(commandId: string): void {
    const entry = this.running.get(commandId)
    if (!entry) return
    if (entry.status === 'running') {
      entry.process.kill('SIGTERM')
    }
  }

  restart(commandId: string): void {
    this.start(commandId)
  }

  stopAll(): void {
    for (const [id] of this.running) {
      this.stop(id)
    }
  }

  /** Get all command IDs that are currently tracked for a project. */
  getProjectCommandStatuses(projectId: string): Record<string, CommandStatus> {
    const commands = listCommands(projectId)
    const result: Record<string, CommandStatus> = {}
    for (const cmd of commands) {
      result[cmd.id] = this.getStatus(cmd.id)
    }
    return result
  }

  private pushStatus(commandId: string, status: CommandStatus): void {
    this.window?.webContents.send(`command:status:${commandId}`, status)
  }
}

export const commandManager = new CommandManager()
