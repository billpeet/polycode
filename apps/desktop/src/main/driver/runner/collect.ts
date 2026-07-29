import type { ChildProcess } from 'child_process'
import type { RunResult } from './types'

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/**
 * Read a RunResult as "stdout, or throw".
 *
 * The counterpart to RunResult for callers that want an exception rather than an
 * exit code. `what` names the thing that failed, for the message used when the
 * process wrote nothing to stderr.
 */
export function expectSuccess(result: RunResult, what: string): string {
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `${what} exited with code ${result.exitCode}`)
  }
  // Preserve leading whitespace — parsers like git porcelain are column-sensitive —
  // while dropping the trailing newline every shell adds.
  return result.stdout.trimEnd()
}

/** The collection limits shared by RunCommand and RunScriptCommand. */
interface CollectLimits {
  timeoutMs?: number
  maxOutputBytes?: number
}

export function collectProcess(proc: ChildProcess, command: CollectLimits): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let settled = false
    let timedOut = false
    const maxOutputBytes = command.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ stdout, stderr, exitCode, timedOut })
    }

    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (settled) return
      outputBytes += chunk.byteLength
      if (outputBytes > maxOutputBytes) {
        stderr += `${stderr ? '\n' : ''}Process output exceeded ${maxOutputBytes} bytes`
        try { proc.kill('SIGTERM') } catch { /* ignore */ }
        finish(null)
        return
      }
      if (target === 'stdout') stdout += chunk.toString('utf8')
      else stderr += chunk.toString('utf8')
    }

    proc.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk))
    proc.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk))
    proc.on('close', (code) => finish(code))
    proc.on('error', (error) => {
      stderr += `${stderr ? '\n' : ''}${error.message}`
      finish(null)
    })

    const timer = command.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
        timedOut = true
        try { proc.kill('SIGTERM') } catch { /* ignore */ }
        finish(null)
      }, command.timeoutMs)
  })
}
