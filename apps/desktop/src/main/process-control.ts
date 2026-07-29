/**
 * OS-level process control: run a child process, find what holds a port, kill it.
 *
 * Deliberately free of database and Electron dependencies so it can be unit-tested
 * directly. Both transport adapters (`ipc/handlers.ts` and `control/control-rpc.ts`)
 * previously carried byte-identical private copies of every function here.
 *
 * Windows is the primary platform: `getPowerShellExe` and the embedded port-scan
 * script are load-bearing, not incidental.
 */
import { exec, execFile } from 'child_process'
import { wslExec } from './wsl'
import { getPowerShellExe } from './driver/runner'
import type { WslConfig } from '../shared/types'

// Re-exported because both dispatch files import it from here.
export { getPowerShellExe }

const MAX_EXEC_OUTPUT = 1024 * 1024

export function runExecFile(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', windowsHide: true, maxBuffer: MAX_EXEC_OUTPUT, timeout: opts.timeoutMs },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout)
      },
    )
  })
}

export function killByPid(pid: number, wsl?: WslConfig | null): Promise<void> {
  if (pid === process.pid) return Promise.reject(new Error('Refusing to kill own process'))
  if (!Number.isInteger(pid) || pid <= 0) return Promise.reject(new Error('Invalid PID'))
  if (wsl) {
    return wslExec(wsl, '/', `kill -9 ${pid}`)
      .then(() => undefined)
      .catch((error: unknown) => {
        throw new Error(`kill failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  }
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      exec(`taskkill /F /T /PID ${pid}`, (error) => {
        if (error) reject(new Error(`taskkill failed: ${error.message}`))
        else resolve()
      })
      return
    }
    try {
      process.kill(pid, 'SIGKILL')
      resolve()
    } catch (error) {
      reject(new Error(`kill failed: ${error instanceof Error ? error.message : String(error)}`))
    }
  })
}

export function findPidsByPort(port: number, wsl?: WslConfig | null): Promise<number[]> {
  return new Promise((resolve, reject) => {
    if (wsl) {
      const cmd = `if command -v lsof >/dev/null 2>&1; then lsof -ti:${port}; else ss -ltnp 'sport = :${port}' | sed -n 's/.*pid=\\([0-9]\\+\\).*/\\1/p'; fi`
      wslExec(wsl, '/', cmd)
        .then((stdout) => {
          const pids = stdout.trim().split('\n').map((line) => Number.parseInt(line, 10)).filter((pid) => pid > 0)
          resolve(Array.from(new Set(pids)))
        })
        .catch(() => resolve([]))
      return
    }

    if (process.platform === 'win32') {
      const script = `
$port = ${port}
$tcp = @(Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)
$udp = @(Get-NetUDPEndpoint -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)
@($tcp + $udp) | Where-Object { $_ -gt 0 } | Sort-Object -Unique
`.trim()
      runExecFile(getPowerShellExe(), ['-NoProfile', '-NonInteractive', '-Command', script])
        .then((stdout) => {
          const pids = stdout
            .split(/\r?\n/)
            .map((line) => Number.parseInt(line.trim(), 10))
            .filter((pid) => pid > 0)
          resolve(Array.from(new Set(pids)))
        })
        .catch((error: unknown) => {
          reject(new Error(`port lookup failed: ${error instanceof Error ? error.message : String(error)}`))
        })
      return
    }

    // lsof exits non-zero when nothing is listening — that is "no pids", not a failure.
    exec(`lsof -ti:${port}`, (error, stdout) => {
      if (error) return resolve([])
      const pids = stdout.trim().split('\n').map((line) => Number.parseInt(line, 10)).filter((pid) => pid > 0)
      resolve(pids)
    })
  })
}

export async function killByPort(port: number, wsl?: WslConfig | null): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port must be between 1 and 65535')
  }
  const pids = await findPidsByPort(port, wsl)
  if (pids.length === 0) throw new Error(`No process found on port ${port}`)
  const errors: string[] = []
  for (const pid of pids) {
    try {
      await killByPid(pid, wsl)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  // Partial success is success: some pids may have exited between lookup and kill.
  if (errors.length > 0 && errors.length === pids.length) {
    throw new Error(errors.join('; '))
  }
}
