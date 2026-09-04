import { spawn, ChildProcess } from 'child_process'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Runner, RunCommand, RunResult, RunScriptCommand, ScriptCommand, SpawnCommand } from './types'
import { winQuote, augmentWindowsPath, getCmdExe, getPowerShellExe } from './utils'
import { collectProcess } from './collect'

/**
 * Binaries safe to spawn without cmd.exe on Windows. Bare names resolve via CreateProcess's
 * PATH search, which finds .exe but not .cmd/.bat shims — so this list is conservative:
 * `git` (always git.exe) and anything the caller already resolved to an explicit .exe path.
 * Everything else keeps the shell so npm-style .cmd wrappers continue to work.
 */
function isDirectWindowsExecutable(binary: string): boolean {
  const lower = binary.toLowerCase()
  return lower === 'git' || lower.endsWith('.exe')
}

export class LocalRunner implements Runner {
  readonly type = 'local' as const

  run(cmd: RunCommand): Promise<RunResult> {
    return collectProcess(this.spawn(cmd), cmd)
  }

  runScript(cmd: RunScriptCommand): Promise<RunResult> {
    return collectProcess(this.spawnScript(cmd), cmd)
  }

  spawnScript(cmd: ScriptCommand): ChildProcess {
    const { script, workDir, env, localShell } = cmd
    const isWindows = process.platform === 'win32'

    if (workDir !== undefined && !existsSync(workDir)) {
      throw new Error(`Working directory does not exist: "${workDir}"`)
    }

    // Match LocalRunner.spawn: on Windows the inherited PATH is routinely
    // incomplete, so augment it unless the caller supplied its own environment.
    const childEnv = env ?? (isWindows ? augmentWindowsPath() : undefined)

    const [shellExe, shellArgs] = localShell === 'powershell'
      ? [getPowerShellExe(), ['-NonInteractive', '-Command', script]]
      : isWindows
        // /d skips AutoRun, /s makes the quoting rules for the /c string predictable.
        ? [getCmdExe(), ['/d', '/s', '/c', script]]
        : ['/bin/sh', ['-c', script]]

    console.log('[LocalRunner] Spawning script:', shellExe)
    return spawn(shellExe, shellArgs, {
      shell: false,
      cwd: workDir,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  spawn(cmd: SpawnCommand): ChildProcess {
    const { binary, args, workDir, stdinContent, keepStdinOpen, extraEnv } = cmd
    const isWindows = process.platform === 'win32'
    const baseEnv = isWindows ? augmentWindowsPath() : undefined
    const env = extraEnv ? { ...(baseEnv ?? process.env), ...extraEnv } : baseEnv

    if (!workDir || !existsSync(workDir)) {
      throw new Error(`Working directory does not exist: "${workDir}"`)
    }

    if (isWindows) {
      const isUNC = workDir.startsWith('\\\\')

      if (isUNC) {
        // cmd.exe rejects UNC paths as cwd. pushd maps UNC to a drive letter,
        // but passing the UNC path through Node.js spawn args causes Node to
        // escape the inner quotes, which garbles the path. A temp batch file
        // avoids all quoting issues.
        const batchPath = join(tmpdir(), `polycode-${Date.now()}.bat`)
        const cmdLine = [binary, ...args.map(winQuote)].join(' ')
        const batchContent = `@echo off\r\npushd "${workDir}"\r\n${cmdLine}\r\npopd\r\n`
        writeFileSync(batchPath, batchContent)
        console.log('[LocalRunner] Spawning (UNC/batch):', batchPath)
        const proc = spawn('cmd', ['/c', batchPath], {
          shell: false,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        proc.on('close', () => { try { unlinkSync(batchPath) } catch { /* ignore */ } })
        if (stdinContent !== undefined) {
          proc.stdin?.write(stdinContent)
        }
        if (!keepStdinOpen) proc.stdin?.end()
        return proc
      } else if (isDirectWindowsExecutable(binary)) {
        // Real .exe binaries don't need cmd.exe: shell:true exists solely for npm-style
        // .cmd wrappers. Routing git through the shell doubled the process count on the
        // hottest spawn path in the app (cmd.exe + git.exe per invocation, ~100ms floor —
        // Grafana showed git:head p50 at 101ms for what is a ~10ms rev-parse) and forced
        // hand-rolled winQuote quoting. Direct spawn passes args verbatim.
        console.log('[LocalRunner] Spawning (Windows/direct):', binary, args.join(' '))
        const proc = spawn(binary, args, {
          cwd: workDir,
          env,
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        if (stdinContent !== undefined) {
          proc.stdin?.write(stdinContent)
        }
        if (!keepStdinOpen) proc.stdin?.end()
        return proc
      } else {
        // npm .cmd wrappers require shell:true on Windows. Build the command
        // string ourselves with explicit double-quoting for args that contain
        // spaces or special chars.
        const cmdStr = [binary, ...args.map(winQuote)].join(' ')
        console.log('[LocalRunner] Spawning (Windows/shell):', cmdStr)
        const proc = spawn(cmdStr, [], {
          cwd: workDir,
          env,
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        if (stdinContent !== undefined) {
          proc.stdin?.write(stdinContent)
        }
        if (!keepStdinOpen) proc.stdin?.end()
        return proc
      }
    } else {
      // POSIX
      if (stdinContent !== undefined || keepStdinOpen) {
        console.log('[LocalRunner] Spawning (POSIX/stdin):', binary, args.join(' '))
        const proc = spawn(binary, args, {
          cwd: workDir,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        if (stdinContent !== undefined) proc.stdin?.write(stdinContent)
        if (!keepStdinOpen) proc.stdin?.end()
        return proc
      } else {
        console.log('[LocalRunner] Spawning (POSIX):', binary, args.join(' '))
        return spawn(binary, args, {
          cwd: workDir,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      }
    }
  }
}
