import { spawn, execFile, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { BrowserWindow } from 'electron'
import { CommandStatus, CommandLogLine, ProjectCommand, ConnectionType } from '../../shared/types'
import { getCommandById, listCommands, getLocationById } from '../db/queries'
import { shellEscape, cdTarget, buildSshBaseArgs, LOAD_NODE_MANAGERS } from '../driver/runner'

const LOG_RING_BUFFER_SIZE = 1000
const PORT_POLL_INTERVAL_MS = 2000
const COMMAND_TIMEOUT_MS = 4000
const STOP_GRACE_TIMEOUT_MS = 4000
const STOP_FORCE_TIMEOUT_MS = 2000
const MAX_EXEC_OUTPUT = 1024 * 1024

interface RunningCommand {
  commandId: string
  locationId: string
  connectionType: ConnectionType
  process: ChildProcess
  status: CommandStatus
  ports: number[]
  portPollTimer: ReturnType<typeof setInterval> | null
  portPollInFlight: boolean
  logs: CommandLogLine[]
}

/** Returns the map key for a (commandId, locationId) pair. */
function instKey(commandId: string, locationId: string): string {
  return `${commandId}:${locationId}`
}

function runExecFile(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_EXEC_OUTPUT, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout)
      }
    )
  })
}

function getPowerShellExe(): string {
  const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
  return `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

function parsePortFromAddress(addr: string): number | null {
  const match = addr.match(/:(\d+)(?:->|$)/)
  if (!match) return null
  const port = Number.parseInt(match[1], 10)
  return Number.isFinite(port) ? port : null
}

function equalPorts(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

class CommandManager {
  /** Keyed by instKey(commandId, locationId) */
  private running = new Map<string, RunningCommand>()
  /** Serialize start/stop/restart operations per command instance key. */
  private lifecycle = new Map<string, Promise<void>>()
  private window: BrowserWindow | null = null

  private enqueueLifecycle(key: string, op: () => Promise<void>): Promise<void> {
    const previous = this.lifecycle.get(key) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(op)
    this.lifecycle.set(key, next)
    return next.finally(() => {
      if (this.lifecycle.get(key) === next) {
        this.lifecycle.delete(key)
      }
    })
  }

  private isProcessActive(proc: ChildProcess): boolean {
    return proc.exitCode == null && proc.signalCode == null
  }

  private waitForClose(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (!this.isProcessActive(proc)) return Promise.resolve(true)
    return new Promise((resolve) => {
      let done = false
      const finish = (exited: boolean): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        proc.off('close', onClose)
        resolve(exited)
      }
      const onClose = (): void => finish(true)
      const timer = setTimeout(() => finish(false), timeoutMs)
      proc.on('close', onClose)
      if (!this.isProcessActive(proc)) {
        finish(true)
      }
    })
  }

  private requestStopSignal(proc: ChildProcess): void {
    if (process.platform === 'win32' && proc.pid != null) {
      // First request a graceful tree shutdown. If this fails to complete in time,
      // stopImpl escalates with /F.
      spawn('taskkill', ['/pid', String(proc.pid), '/T'], { shell: false })
      return
    }
    try {
      proc.kill('SIGTERM')
    } catch {
      // Process may have already exited.
    }
  }

  private forceKill(proc: ChildProcess): void {
    if (process.platform === 'win32' && proc.pid != null) {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { shell: false })
      return
    }
    try {
      proc.kill('SIGKILL')
    } catch {
      // Process may have already exited.
    }
  }

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

  getPorts(commandId: string, locationId: string): number[] {
    return this.running.get(instKey(commandId, locationId))?.ports ?? []
  }

  start(commandId: string, locationId: string): Promise<void> {
    const key = instKey(commandId, locationId)
    return this.enqueueLifecycle(key, async () => {
      await this.startImpl(commandId, locationId)
    })
  }

  private async startImpl(commandId: string, locationId: string): Promise<void> {
    const key = instKey(commandId, locationId)

    // Never start a replacement process until any previous instance fully exits.
    await this.stopImpl(commandId, locationId)

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
      connectionType,
      process: null as unknown as ChildProcess,
      status: 'running',
      ports: [],
      portPollTimer: null,
      portPollInFlight: false,
      logs: [],
    }
    this.running.set(key, entry)
    this.pushStatus(commandId, locationId, 'running')

    let proc: ChildProcess

    if (connectionType === 'wsl' && location?.wsl) {
      // ── WSL spawn ──────────────────────────────────────────────────────────
      // bash -ilc (interactive + login) ensures .bashrc runs in full, giving
      // the user's real PATH instead of Windows tools bleeding in via /mnt/c/.
      const workDir = cwd ?? '~'
      const innerCmd = `cd ${cdTarget(workDir)} && ${cmdDef.command}`
      proc = spawn('wsl', ['-d', location.wsl.distro, '--', 'bash', '-ilc', innerCmd], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } else if (connectionType === 'ssh' && location?.ssh) {
      // ── SSH spawn ──────────────────────────────────────────────────────────
      const ssh = location.ssh
      const workDir = cwd ?? '~'
      const innerCmd = `${LOAD_NODE_MANAGERS}; cd ${cdTarget(workDir)} && ${cmdDef.command}`
      const remoteCmd = `bash -lc ${shellEscape(innerCmd)}`
      const sshArgs = buildSshBaseArgs(ssh)
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
    this.startPortPolling(key, entry)

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
      this.stopPortPolling(current)
      const status: CommandStatus =
        current.status === 'stopping'
          ? 'stopped'
          : (code === 0 || code === null ? 'stopped' : 'error')
      current.status = status
      this.pushStatus(commandId, locationId, status)
    })

    proc.on('error', (err) => {
      const current = this.running.get(key)
      if (!current || current.process !== proc) return
      this.stopPortPolling(current)
      pushLog(`Error: ${err.message}`, 'stderr')
      current.status = 'error'
      this.pushStatus(commandId, locationId, 'error')
    })
  }

  stop(commandId: string, locationId: string): Promise<void> {
    const key = instKey(commandId, locationId)
    return this.enqueueLifecycle(key, async () => {
      await this.stopImpl(commandId, locationId)
    })
  }

  private async stopImpl(commandId: string, locationId: string): Promise<void> {
    const key = instKey(commandId, locationId)
    const entry = this.running.get(key)
    if (!entry) return

    // If process is already not alive, just normalize terminal status and return.
    if (!this.isProcessActive(entry.process)) {
      if (entry.status !== 'stopped' && entry.status !== 'error') {
        entry.status = 'stopped'
        this.stopPortPolling(entry)
        this.pushStatus(commandId, locationId, 'stopped')
      }
      return
    }

    if (entry.status !== 'stopping') {
      entry.status = 'stopping'
      this.stopPortPolling(entry)
      this.pushStatus(commandId, locationId, 'stopping')
    }

    this.requestStopSignal(entry.process)
    const exitedGracefully = await this.waitForClose(entry.process, STOP_GRACE_TIMEOUT_MS)
    if (exitedGracefully) return

    this.forceKill(entry.process)
    await this.waitForClose(entry.process, STOP_FORCE_TIMEOUT_MS)
  }

  restart(commandId: string, locationId: string): Promise<void> {
    const key = instKey(commandId, locationId)
    return this.enqueueLifecycle(key, async () => {
      await this.stopImpl(commandId, locationId)
      await this.startImpl(commandId, locationId)
    })
  }

  /** Stop all running instances for a given commandId (used when deleting a command). */
  stopAllInstances(commandId: string): void {
    for (const entry of this.running.values()) {
      if (entry.commandId === commandId) {
        void this.stop(commandId, entry.locationId)
      }
    }
  }

  stopAll(): void {
    for (const entry of [...this.running.values()]) {
      void this.stop(entry.commandId, entry.locationId)
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

  private pushPorts(commandId: string, locationId: string, ports: number[]): void {
    const key = instKey(commandId, locationId)
    this.window?.webContents.send(`command:ports:${key}`, ports)
  }

  private startPortPolling(key: string, entry: RunningCommand): void {
    this.stopPortPolling(entry)
    void this.pollPortsOnce(key, entry)
    entry.portPollTimer = setInterval(() => {
      void this.pollPortsOnce(key, entry)
    }, PORT_POLL_INTERVAL_MS)
  }

  private stopPortPolling(entry: RunningCommand): void {
    if (entry.portPollTimer) {
      clearInterval(entry.portPollTimer)
      entry.portPollTimer = null
    }
    if (entry.ports.length > 0) {
      entry.ports = []
      this.pushPorts(entry.commandId, entry.locationId, [])
    }
  }

  private async pollPortsOnce(key: string, entry: RunningCommand): Promise<void> {
    if (entry.status !== 'running') return
    if (entry.portPollInFlight) return
    const current = this.running.get(key)
    if (current !== entry) return
    const pid = entry.process.pid
    if (pid == null) return
    entry.portPollInFlight = true
    try {
      const ports = await this.getListeningPortsForProcessTree(pid, entry.connectionType)
      const currentEntry = this.running.get(key)
      if (currentEntry !== entry) return
      if (!equalPorts(entry.ports, ports)) {
        entry.ports = ports
        this.pushPorts(entry.commandId, entry.locationId, ports)
      }
    } catch {
      // Ignore polling errors; this is best-effort status metadata.
    } finally {
      entry.portPollInFlight = false
    }
  }

  private async getListeningPortsForProcessTree(rootPid: number, connectionType: ConnectionType): Promise<number[]> {
    if (connectionType !== 'local') return []
    const pids = await this.getProcessTreePids(rootPid)
    if (pids.size === 0) return []
    if (process.platform === 'win32') {
      return this.getWindowsListeningPorts(pids)
    }
    return this.getPosixListeningPorts(pids)
  }

  private async getProcessTreePids(rootPid: number): Promise<Set<number>> {
    const result = new Set<number>([rootPid])
    if (process.platform === 'win32') {
      const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'
      const out = await runExecFile(getPowerShellExe(), ['-NoProfile', '-NonInteractive', '-Command', script])
      const byParent = new Map<number, number[]>()
      for (const line of out.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const [pidStr, ppidStr] = trimmed.split(/\s+/, 2)
        const pid = Number.parseInt(pidStr, 10)
        const ppid = Number.parseInt(ppidStr, 10)
        if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
        const children = byParent.get(ppid) ?? []
        children.push(pid)
        byParent.set(ppid, children)
      }
      const queue = [rootPid]
      while (queue.length > 0) {
        const parent = queue.shift()!
        const children = byParent.get(parent) ?? []
        for (const child of children) {
          if (result.has(child)) continue
          result.add(child)
          queue.push(child)
        }
      }
      return result
    }

    const out = await runExecFile('ps', ['-eo', 'pid=,ppid='])
    const byParent = new Map<number, number[]>()
    for (const line of out.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const [pidStr, ppidStr] = trimmed.split(/\s+/, 2)
      const pid = Number.parseInt(pidStr, 10)
      const ppid = Number.parseInt(ppidStr, 10)
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
      const children = byParent.get(ppid) ?? []
      children.push(pid)
      byParent.set(ppid, children)
    }
    const queue = [rootPid]
    while (queue.length > 0) {
      const parent = queue.shift()!
      const children = byParent.get(parent) ?? []
      for (const child of children) {
        if (result.has(child)) continue
        result.add(child)
        queue.push(child)
      }
    }
    return result
  }

  private async getWindowsListeningPorts(pids: Set<number>): Promise<number[]> {
    const list = [...pids].filter((pid) => Number.isFinite(pid))
    if (list.length === 0) return []
    const script = `$targets = @(${list.join(',')}); Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $targets -contains $_.OwningProcess } | Select-Object -ExpandProperty LocalPort -Unique | Sort-Object`
    const out = await runExecFile(getPowerShellExe(), ['-NoProfile', '-NonInteractive', '-Command', script])
    const ports = out
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((port) => Number.isFinite(port))
    return [...new Set(ports)].sort((a, b) => a - b)
  }

  private async getPosixListeningPorts(pids: Set<number>): Promise<number[]> {
    try {
      const out = await runExecFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-FpPn'])
      const ports = new Set<number>()
      let currentPid: number | null = null
      for (const line of out.split(/\r?\n/)) {
        if (!line) continue
        if (line.startsWith('p')) {
          const pid = Number.parseInt(line.slice(1).trim(), 10)
          currentPid = Number.isFinite(pid) ? pid : null
          continue
        }
        if (!line.startsWith('n') || currentPid == null) continue
        if (!pids.has(currentPid)) continue
        const port = parsePortFromAddress(line.slice(1).trim())
        if (port != null) ports.add(port)
      }
      return [...ports].sort((a, b) => a - b)
    } catch {
      const out = await runExecFile('ss', ['-ltnpH'])
      const ports = new Set<number>()
      for (const line of out.split(/\r?\n/)) {
        if (!line) continue
        const pidMatches = [...line.matchAll(/pid=(\d+)/g)]
        if (pidMatches.length === 0) continue
        const ownsSocket = pidMatches.some((m) => pids.has(Number.parseInt(m[1], 10)))
        if (!ownsSocket) continue
        const fields = line.trim().split(/\s+/)
        if (fields.length < 4) continue
        const port = parsePortFromAddress(fields[3])
        if (port != null) ports.add(port)
      }
      return [...ports].sort((a, b) => a - b)
    }
  }
}

export const commandManager = new CommandManager()
