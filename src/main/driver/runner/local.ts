import { spawn, ChildProcess } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Runner, SpawnCommand } from './types'
import { winQuote } from './utils'

export class LocalRunner implements Runner {
  readonly type = 'local' as const

  spawn(cmd: SpawnCommand): ChildProcess {
    const { binary, args, workDir, stdinContent } = cmd
    const isWindows = process.platform === 'win32'

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
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        proc.on('close', () => { try { unlinkSync(batchPath) } catch { /* ignore */ } })
        if (stdinContent !== undefined) {
          proc.stdin?.write(stdinContent)
        }
        proc.stdin?.end()
        return proc
      } else {
        // npm .cmd wrappers require shell:true on Windows. Build the command
        // string ourselves with explicit double-quoting for args that contain
        // spaces or special chars.
        const cmdStr = [binary, ...args.map(winQuote)].join(' ')
        console.log('[LocalRunner] Spawning (Windows/shell):', cmdStr)
        const proc = spawn(cmdStr, [], {
          cwd: workDir,
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        if (stdinContent !== undefined) {
          proc.stdin?.write(stdinContent)
        }
        proc.stdin?.end()
        return proc
      }
    } else {
      // POSIX
      if (stdinContent !== undefined) {
        console.log('[LocalRunner] Spawning (POSIX/stdin):', binary, args.join(' '))
        const proc = spawn(binary, args, {
          cwd: workDir,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        proc.stdin?.write(stdinContent)
        proc.stdin?.end()
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
